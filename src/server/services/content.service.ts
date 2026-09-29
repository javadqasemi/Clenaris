import 'server-only';

import { cache as reactCache } from 'react';
import { revalidatePath } from 'next/cache';
import { isPreview } from '@/lib/cms/preview';

import { prisma, Prisma } from '@/lib/db';
import { cache, cacheKeys } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { audit, diff } from '@/lib/audit';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import type { UpdateSeoInput } from '@/lib/validation/cms';
import {
  CONTENT_DEFINITIONS,
  defaultContent,
  definitionFor,
  isContentKey,
  seoDefinitionFor,
  type ContentDefinition,
} from '@/lib/cms/registry';
import { assetFieldLabel, isAssetField } from '@/lib/cms/assets';
import { gepflegteSeo } from '@/lib/seo/metadaten';

const log = logger('cms');

/**
 * Lesezugriff auf die redaktionellen Inhalte.
 *
 * Architekturentscheide:
 *
 *  • **Ein Zugriff pro Rendering, nicht einer pro Textbaustein.** Die ganze
 *    Inhaltstabelle ist wenige Kilobyte gross; sie einmal zu laden und im
 *    Speicher nachzuschlagen ist billiger als dreissig Einzelabfragen. Der
 *    Cache liegt zusätzlich in Redis, damit auch über Requests hinweg nicht
 *    erneut gelesen wird.
 *
 *  • **Der Standardtext gewinnt bei Zweifel.** Fehlt eine Zeile, ist sie leer
 *    oder hat sie den falschen Typ, gilt der Wert aus dem Register. Eine
 *    Website, die wegen eines gelöschten Datensatzes eine leere Überschrift
 *    zeigt, ist schlimmer als eine, die den Auslieferungstext zeigt.
 *
 *  • **Unbekannte Schlüssel werden verworfen.** Bleibt nach einer Umbenennung
 *    eine alte Zeile stehen, landet sie nicht im Ergebnis.
 */

const CACHE_TTL_SECONDS = 300;

export type ContentMap = Record<string, string | string[]>;

/** Prüft, ob der gespeicherte Wert zur Form des Bausteins passt. */
function coerce(definition: ContentDefinition, raw: unknown): string | string[] | null {
  if (definition.kind === 'list') {
    if (!Array.isArray(raw)) return null;
    const items = raw.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
    return items.length > 0 ? items : null;
  }

  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Alle Inhalte eines Mandanten, mit Standardwerten aufgefüllt.
 *
 * `React.cache` dedupliziert innerhalb eines Renderings, Redis über Requests
 * hinweg.
 */
export const getContent = reactCache(async (organizationId: string): Promise<ContentMap> => {
  const defaults = defaultContent();

  /**
   * Im Redaktionsrahmen gilt der Entwurfsstand.
   *
   * Die Frage ist hier bewusst *innerhalb* von `getContent` gestellt und
   * nicht an jeder der rund dreissig Aufrufstellen: Eine vergessene Stelle
   * zeigte in der Vorschau den veröffentlichten Text und sähe damit aus wie
   * ein nicht gespeicherter Entwurf.
   *
   * Dieselbe Prüfung wie für die Bearbeitungsmarken (`isPreview`): Cookie,
   * Berechtigung *und* Rahmen. Vorher genügte das Cookie — und ein Browser,
   * in dem die Maske einmal offen war, zeigte auf der echten Website
   * unveröffentlichte Texte, darunter womöglich Preise, die noch nicht
   * gelten.
   */
  if (await isPreview()) return getPreviewContent(organizationId);

  try {
    const stored = await cache.remember(
      cacheKeys.content(organizationId, 'DE'),
      CACHE_TTL_SECONDS,
      async () => {
        const rows = await prisma.contentBlock.findMany({
          where: { organizationId, locale: 'DE' },
          select: { key: true, value: true },
        });
        return rows;
      },
    );

    return applyRows(defaults, stored ?? []);
  } catch (error) {
    // Ein Ausfall der Inhaltstabelle darf die Website nicht mitreissen —
    // sie zeigt dann die Auslieferungsfassung.
    log.error('Inhalte konnten nicht geladen werden, verwende Standardtexte', { error });
    return defaults;
  }
});

/** Gespeicherte Zeilen über die Standardwerte legen. */
function applyRows(
  defaults: ContentMap,
  rows: { key: string; value: unknown }[],
): ContentMap {
  const result: ContentMap = { ...defaults };

  for (const row of rows) {
    if (!isContentKey(row.key)) continue;
    const definition = definitionFor(row.key);
    if (!definition) continue;

    const value = coerce(definition, row.value);
    if (value !== null) result[row.key] = value;
  }

  return result;
}

/**
 * Inhalte in der **Vorschaufassung**: Entwürfe überschreiben den
 * veröffentlichten Stand.
 *
 * Bewusst ohne jeden Cache — weder Redis noch `React.cache`. Eine Vorschau,
 * die fünf Minuten alt sein kann, ist keine Vorschau; sie führt dazu, dass
 * jemand seine gerade getippte Änderung nicht sieht und sie ein zweites Mal
 * tippt. Der Preis ist eine Abfrage pro Aufruf, und Vorschauaufrufe sind
 * selten und kommen von angemeldeten Personen.
 */
export async function getPreviewContent(organizationId: string): Promise<ContentMap> {
  const defaults = defaultContent();

  try {
    const rows = await prisma.contentBlock.findMany({
      where: { organizationId, locale: 'DE' },
      select: { key: true, value: true, draftValue: true },
    });

    return applyRows(
      defaults,
      rows.map((row) => ({
        key: row.key,
        // `draftValue: null` heisst „kein offener Entwurf" — dann gilt der
        // veröffentlichte Wert. Ein Entwurf, der bewusst geleert wurde, ist
        // eine leere Zeichenkette und keine Null.
        value: row.draftValue ?? row.value,
      })),
    );
  } catch (error) {
    log.error('Vorschauinhalte konnten nicht geladen werden', { error });
    return defaults;
  }
}

/**
 * Einzelner Textbaustein.
 *
 * Der Rückgabetyp ist bewusst `string`: Listenbausteine holt man über
 * `contentList`, damit an der Aufrufstelle klar ist, was erwartet wird.
 */
export function contentText(map: ContentMap, key: string): string {
  const value = map[key];
  if (typeof value === 'string') return value;
  const fallback = definitionFor(key)?.default;
  return typeof fallback === 'string' ? fallback : '';
}

export function contentList(map: ContentMap, key: string): string[] {
  const value = map[key];
  if (Array.isArray(value)) return value;
  const fallback = definitionFor(key)?.default;
  return Array.isArray(fallback) ? fallback : [];
}

/**
 * Leert den Cache — nach jeder redaktionellen Änderung aufzurufen.
 *
 * **Zwei Ebenen, beide nötig.** Der Redis-Cache hält die Datenbankabfrage
 * zurück; darüber liegt aber noch der Seitencache von Next.js. Die
 * öffentlichen Seiten sind statisch erzeugt und werden erst nach Ablauf ihrer
 * Revalidierung neu gebaut — bei der Startseite nach einer Stunde. Ohne den
 * zweiten Schritt speichert die Redaktion, sieht auf der Website nichts und
 * hält das Speichern für kaputt.
 *
 * `revalidatePath('/', 'layout')` trifft den gesamten öffentlichen Baum. Das
 * ist beabsichtigt: Kopf- und Fusszeile tragen redaktionelle Texte und
 * erscheinen auf *jeder* Seite, eine gezielte Liste wäre also ohnehin fast
 * vollständig — und würde bei jedem neuen Baustein stillschweigend unvoll-
 * ständig. Neu gebaut wird ohnehin erst beim nächsten Aufruf.
 */
export async function invalidateContent(organizationId: string): Promise<void> {
  await cache.del(cacheKeys.content(organizationId, 'DE'));
  revalidatePath('/', 'layout');
}

// ---------------------------------------------------------------------------
//  Suchmaschinen-Angaben
// ---------------------------------------------------------------------------

export interface PageSeo {
  title: string;
  description: string;
  keywords: string[];
  ogImageUrl: string | null;
  noIndex: boolean;
}

/**
 * Suchmaschinenangaben einer Seite, mit Rückfall auf das Register.
 *
 * Wird in `generateMetadata` verwendet. Schlägt die Abfrage fehl, gelten die
 * Registerwerte — eine Seite ohne Titel wäre in den Suchergebnissen unbrauchbar.
 */
export const getPageSeo = reactCache(
  async (organizationId: string, path: string): Promise<PageSeo> => {
    const definition = seoDefinitionFor(path);
    const fallback: PageSeo = {
      title: definition?.title ?? '',
      description: definition?.description ?? '',
      keywords: [],
      ogImageUrl: null,
      noIndex: false,
    };

    try {
      const row = await cache.remember(cacheKeys.seo(organizationId, path, 'DE'), CACHE_TTL_SECONDS, () =>
        prisma.seoMeta.findUnique({
          where: {
            organizationId_path_locale: { organizationId, path, locale: 'DE' },
          },
          select: {
            title: true,
            description: true,
            keywords: true,
            ogImageUrl: true,
            noIndex: true,
          },
        }),
      );

      if (!row) return fallback;

      // Dieselbe Mischregel wie die Übersicht „SEO-Status" in `/admin/seo`.
      return gepflegteSeo(definition, row);
    } catch (error) {
      log.error('Suchmaschinenangaben konnten nicht geladen werden', { path, error });
      return fallback;
    }
  },
);

export async function invalidateSeo(organizationId: string, path: string): Promise<void> {
  await cache.del(cacheKeys.seo(organizationId, path, 'DE'));
  // Der Seitentitel steckt im erzeugten HTML — der Seitencache muss mit.
  revalidatePath(path);
  // Die Sitemap lässt `noindex`-Seiten weg (2026-09-28) und ist selbst eine
  // Stunde zwischengespeichert — ohne diesen Aufruf stünde eine eben
  // ausgeblendete Seite bis zu einer Stunde weiter darin.
  revalidatePath('/sitemap.xml');
}

/**
 * Suchmaschinenangaben einer Seite pflegen (`PATCH /api/seo`).
 *
 * Vorher im Endpunkt geschrieben (bis 2026-09-27). Die Regeln unten sind
 * Inhaltsregeln, keine HTTP-Details, und sie gehören neben `getPageSeo` und
 * `invalidateSeo`, die dieselbe Zeile lesen und ihren Cache leeren — sonst
 * stünden Lese- und Schreibregel derselben Tabelle in zwei Schichten.
 *
 * Architekturentscheide:
 *
 *  • **Leeren heisst zurücksetzen**, wie bei den Textbausteinen: ein leeres
 *    Feld löscht die Zeile, und es gilt wieder der Registerwert. So kann die
 *    Redaktion einen misslungenen Titel jederzeit rückgängig machen.
 *
 *  • **`noIndex` wird gesondert protokolliert.** Es ist die einzige Schaltung
 *    hier, die eine Seite aus den Suchergebnissen wirft — versehentlich
 *    gesetzt kostet sie Umsatz, und man will nachvollziehen können, wer sie
 *    wann gesetzt hat.
 *
 *  • **Der Seitencache wird geleert.** Der Titel steckt im erzeugten HTML;
 *    ohne Neuaufbau bliebe der alte stehen.
 */
export async function updateSeoMeta(params: {
  organizationId: string;
  actorId: string;
  input: UpdateSeoInput;
}): Promise<{ path: string; reset: boolean }> {
  const { organizationId, actorId, input } = params;
  const definition = seoDefinitionFor(input.path);

  const before = await prisma.seoMeta.findUnique({
    where: { organizationId_path_locale: { organizationId, path: input.path, locale: 'DE' } },
    select: { title: true, description: true, keywords: true, ogImageUrl: true, noIndex: true },
  });

  const title = input.title?.trim() ?? '';
  const description = input.description?.trim() ?? '';
  const ogImageUrl = input.ogImageUrl?.trim() ?? '';

  // Nichts gepflegt und nicht ausgeblendet → die Zeile hat keinen Zweck.
  const isEmpty =
    title === '' &&
    description === '' &&
    ogImageUrl === '' &&
    input.keywords.length === 0 &&
    !input.noIndex;

  if (isEmpty) {
    if (before) {
      await prisma.seoMeta.delete({
        where: { organizationId_path_locale: { organizationId, path: input.path, locale: 'DE' } },
      });
    }
  } else {
    await prisma.seoMeta.upsert({
      where: { organizationId_path_locale: { organizationId, path: input.path, locale: 'DE' } },
      create: {
        organizationId,
        path: input.path,
        locale: 'DE',
        title: title || null,
        description: description || null,
        keywords: input.keywords,
        ogImageUrl: ogImageUrl || null,
        noIndex: input.noIndex,
        updatedById: actorId,
      },
      update: {
        title: title || null,
        description: description || null,
        keywords: input.keywords,
        ogImageUrl: ogImageUrl || null,
        noIndex: input.noIndex,
        updatedById: actorId,
      },
    });
  }

  await invalidateSeo(organizationId, input.path);

  const after = {
    title: title || null,
    description: description || null,
    keywords: input.keywords,
    ogImageUrl: ogImageUrl || null,
    noIndex: input.noIndex,
  };

  await audit.updated({
    organizationId,
    userId: actorId,
    entity: 'SeoMeta',
    entityId: input.path,
    summary:
      `Suchmaschinenangaben für „${definition?.label ?? input.path}" geändert` +
      (input.noIndex && !before?.noIndex ? ' — Seite aus dem Index genommen' : '') +
      (!input.noIndex && before?.noIndex ? ' — Seite wieder freigegeben' : ''),
    changes: diff(before as never, after as never),
  });

  return { path: input.path, reset: isEmpty };
}

/** Zählt, wie viele Bausteine tatsächlich gepflegt sind — für die Übersicht. */
export async function countCuratedContent(organizationId: string): Promise<{
  curated: number;
  total: number;
  drafts: number;
}> {
  const [curated, drafts] = await Promise.all([
    prisma.contentBlock.count({
      where: { organizationId, locale: 'DE', key: { in: CONTENT_DEFINITIONS.map((d) => d.key) } },
    }),
    prisma.contentBlock.count({
      where: { organizationId, locale: 'DE', NOT: { draftValue: { equals: Prisma.DbNull } } },
    }),
  ]);

  return { curated, total: CONTENT_DEFINITIONS.length, drafts };
}

// ---------------------------------------------------------------------------
//  Entwurf, Veröffentlichung, Historie
// ---------------------------------------------------------------------------

/**
 * Redaktionsablauf.
 *
 * **Warum überhaupt getrennte Stände.** Bisher war Speichern gleich
 * Veröffentlichen: Ein halb fertiger Satz stand nach dem Tastendruck auf der
 * Website. Wer eine Preisseite überarbeitet, braucht aber mehrere Anläufe —
 * und in der Zwischenzeit liest Kundschaft mit.
 *
 * **Die drei Zustände eines Bausteins:**
 *
 *  • *Unverändert* — keine Zeile in der Tabelle, es gilt der Auslieferungstext.
 *  • *Veröffentlicht* — `value` ist gesetzt, `draftValue` ist `null`.
 *  • *Entwurf offen* — `draftValue` weicht von `value` ab. Die Website zeigt
 *    weiterhin `value`, die Vorschau zeigt `draftValue`.
 *
 * **Die Historie entsteht beim Veröffentlichen**, nicht beim Speichern: Sie
 * soll die Frage „was stand vorher auf der Website" beantworten, nicht „was
 * hat jemand zwischendurch getippt".
 */
export interface ContentBlockState {
  key: string;
  published: unknown;
  draft: unknown;
  hasDraft: boolean;
  publishedAt: Date | null;
  updatedAt: Date;
}

/** Alle Bausteine mit beiden Ständen — Grundlage der Redaktionsmaske. */
export async function getContentStates(organizationId: string): Promise<ContentBlockState[]> {
  const rows = await prisma.contentBlock.findMany({
    where: { organizationId, locale: 'DE' },
    select: {
      key: true,
      value: true,
      draftValue: true,
      publishedAt: true,
      updatedAt: true,
    },
  });

  return rows
    .filter((row) => isContentKey(row.key))
    .map((row) => ({
      key: row.key,
      published: row.value,
      draft: row.draftValue ?? row.value,
      hasDraft: row.draftValue !== null,
      publishedAt: row.publishedAt,
      updatedAt: row.updatedAt,
    }));
}

/**
 * Entwurf speichern.
 *
 * Ein Feld zu leeren heisst „zurück zum Auslieferungstext" — der Baustein wird
 * dann entfernt, statt eine leere Zeichenkette zu speichern. Das ist der
 * einzige Weg zurück, ohne den ursprünglichen Wortlaut zu kennen, und deshalb
 * wichtiger als er aussieht.
 */
export async function saveContentDraft(params: {
  organizationId: string;
  values: Record<string, string | string[]>;
  actorId: string;
}): Promise<{ saved: number; removed: number }> {
  let saved = 0;
  let removed = 0;

  for (const [key, raw] of Object.entries(params.values)) {
    if (!isContentKey(key)) continue;
    const definition = definitionFor(key);
    if (!definition) continue;

    const value = coerce(definition, raw);

    if (value === null) {
      // Geleert: Eine bestehende Zeile verschwindet ganz. Gibt es noch einen
      // veröffentlichten Wert, wird stattdessen ein *leerer Entwurf* daraus —
      // sonst verschwände der Text sofort von der Website, ohne dass jemand
      // veröffentlicht hätte.
      const existing = await prisma.contentBlock.findUnique({
        where: { organizationId_key_locale: { organizationId: params.organizationId, key, locale: 'DE' } },
        select: { id: true, publishedAt: true },
      });
      if (!existing) continue;

      /*
        `updateMany`/`deleteMany` mit der Kennung statt `update`/`delete`
        (2026-09-27). Zwei gleichzeitige Speicherungen desselben geleerten
        Bausteins lasen beide die Zeile; die zweite Löschung fand sie nicht
        mehr und warf P2025 — die Redaktion bekam einen 500 für einen
        Vorgang, dessen Ergebnis („Baustein zurückgesetzt") längst stand.
        Ist die Zeile schon weg, ist das Ziel erreicht; gezählt wird nur,
        was dieser Aufruf tatsächlich geschrieben hat.
      */
      if (existing.publishedAt) {
        const geleert = await prisma.contentBlock.updateMany({
          where: { id: existing.id },
          data: { draftValue: definition.kind === 'list' ? [] : '', updatedById: params.actorId },
        });
        saved += geleert.count;
      } else {
        const entfernt = await prisma.contentBlock.deleteMany({ where: { id: existing.id } });
        removed += entfernt.count;
      }
      continue;
    }

    const upsert = () =>
      prisma.contentBlock.upsert({
        where: {
          organizationId_key_locale: { organizationId: params.organizationId, key, locale: 'DE' },
        },
        create: {
          organizationId: params.organizationId,
          key,
          locale: 'DE',
          // Ein neuer Baustein beginnt als reiner Entwurf: `value` trägt den
          // Auslieferungstext, damit die Website unverändert bleibt, bis jemand
          // veröffentlicht.
          value: (definition.default ?? '') as Prisma.InputJsonValue,
          draftValue: value as Prisma.InputJsonValue,
          updatedById: params.actorId,
        },
        update: {
          draftValue: value as Prisma.InputJsonValue,
          updatedById: params.actorId,
        },
      });

    /*
      Ein zweiter Versuch bei P2002 (2026-09-27). Prisma führt `upsert` nur
      unter bestimmten Bedingungen als einzelnes `INSERT … ON CONFLICT` aus;
      sonst liest es erst und legt dann an. Speichern zwei Fenster denselben,
      noch nie gespeicherten Baustein gleichzeitig — die Vorschau speichert
      beim Verlassen des Feldes, ein Doppelklick genügt —, finden beide
      „keine Zeile", und das zweite Anlegen scheitert am eindeutigen Index.
      Beim zweiten Versuch gibt es die Zeile, und aus dem Anlegen wird ein
      Ändern: Der spätere Entwurf gewinnt, wie bei jeder anderen Speicherung
      auch. Ein 500 für „gleichzeitig getippt" wäre ein Fehler ohne Ursache
      auf Seiten der Redaktion.
    */
    try {
      await upsert();
    } catch (fehler) {
      if (!(fehler instanceof Prisma.PrismaClientKnownRequestError && fehler.code === 'P2002')) throw fehler;
      await upsert();
    }
    saved++;
  }

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'ContentBlock',
    entityId: params.organizationId,
    summary: `Website-Entwurf gespeichert (${saved} Bausteine, ${removed} zurückgesetzt)`,
  });

  return { saved, removed };
}

/**
 * Entwürfe veröffentlichen.
 *
 * Ohne `keys` alle offenen; mit `keys` nur die genannten — das erlaubt, eine
 * überarbeitete Preisseite freizugeben, während die neue Über-uns-Seite noch
 * in Arbeit ist.
 */
export async function publishContent(params: {
  organizationId: string;
  keys?: string[];
  actorId: string;
}): Promise<number> {
  const kandidaten = await prisma.contentBlock.findMany({
    where: {
      organizationId: params.organizationId,
      locale: 'DE',
      NOT: { draftValue: { equals: Prisma.DbNull } },
      ...(params.keys?.length ? { key: { in: params.keys } } : {}),
    },
    select: { id: true },
  });

  if (kandidaten.length === 0) return 0;

  /*
    Sperren, dann neu lesen — und nur echte Änderungen veröffentlichen
    (2026-09-27).

    **Gleichzeitig.** Bis hierher lasen alle Aufrufe die offenen Entwürfe
    *vor* der Transaktion. Zwei gleichzeitige Freigaben — zwei Fenster, ein
    Doppelklick — sahen denselben Entwurf, und jede legte die abgelöste
    Fassung als eigene Revision ab und schrieb eine eigene Zeile
    „veröffentlicht". Die Historie zeigte zwei Wechsel, wo einer war, und
    das Protokoll zwei Personen, die „diesen Text" freigegeben haben. Jetzt
    sperrt die Transaktion die Zeilen (`FOR UPDATE`, in fester Reihenfolge,
    damit sich zwei Freigaben mit verschiedenen Schlüsselmengen nicht
    gegenseitig blockieren) und liest sie **danach** neu. Die zweite
    Freigabe wartet auf die erste und findet dann keinen offenen Entwurf
    mehr — sie veröffentlicht nichts, legt keine Revision an und schreibt
    keine Zeile. Eine Prüfung „gibt es noch einen Entwurf?" vor der
    Transaktion bestünden beide.

    **Ohne Änderung.** Die Vorschau speichert beim Verlassen eines Feldes,
    auch wenn niemand etwas geändert hat; der Entwurf trägt dann den
    veröffentlichten Wortlaut. Veröffentlicht wurde er trotzdem — mit einer
    Revision, die denselben Text noch einmal ablegte, und einer Zeile
    „veröffentlicht" für einen Text, der sich nicht geändert hat. Die
    Historie soll beantworten, was *vorher* auf der Website stand; eine
    Fassung, die gleich der geltenden ist, beantwortet nichts. Ein solcher
    Entwurf wird jetzt nur verworfen (er ist keiner), ohne Revision, ohne
    Protokollzeile, ohne neuen Veröffentlichungszeitpunkt.
  */
  const veroeffentlicht = await prisma.$transaction(async (tx) => {
    const ids = kandidaten.map((k) => k.id).sort();
    await tx.$queryRaw`SELECT id FROM content_blocks WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;

    const blocks = await tx.contentBlock.findMany({
      where: { id: { in: ids }, NOT: { draftValue: { equals: Prisma.DbNull } } },
      orderBy: { id: 'asc' },
    });

    const echt: typeof blocks = [];
    for (const block of blocks) {
      if (block.publishedAt && gleicherInhalt(block.draftValue, block.value)) {
        await tx.contentBlock.update({ where: { id: block.id }, data: { draftValue: Prisma.DbNull } });
        continue;
      }

      // Erst die abgelöste Fassung sichern, dann überschreiben — sonst wäre
      // sie weg, bevor die Historie sie kennt.
      if (block.publishedAt) {
        await tx.contentRevision.create({
          data: {
            organizationId: params.organizationId,
            blockId: block.id,
            key: block.key,
            locale: 'DE',
            value: block.value as Prisma.InputJsonValue,
            createdById: params.actorId,
          },
        });
      }

      await tx.contentBlock.update({
        where: { id: block.id },
        data: {
          value: block.draftValue as Prisma.InputJsonValue,
          draftValue: Prisma.DbNull,
          publishedAt: new Date(),
          updatedById: params.actorId,
        },
      });
      echt.push(block);
    }
    return echt;
  });

  if (veroeffentlicht.length === 0) return 0;

  await invalidateContent(params.organizationId);

  // Eine Zeile je Baustein, mit seiner Kennung und seinem Schlüssel
  // (2026-09-27). Vorher eine Sammelzeile mit der Organisation als
  // `entityId` und nur einer Zahl — welcher Text wann live ging, stand
  // nirgends. Die Fassung selbst liegt in der Historie (`ContentRevision`).
  for (const block of veroeffentlicht) {
    await audit.updated({
      organizationId: params.organizationId,
      userId: params.actorId,
      entity: 'ContentBlock',
      entityId: block.id,
      summary: `Website-Baustein „${block.key}" veröffentlicht`,
      changes: { key: block.key },
    });
  }

  return veroeffentlicht.length;
}

/**
 * Tragen Entwurf und veröffentlichter Wert denselben Inhalt?
 *
 * Die Werte sind Zeichenketten oder Listen von Zeichenketten (siehe
 * `coerce`); `JSON.stringify` vergleicht beide Formen genau, auch die
 * Reihenfolge einer Liste — und die ist Inhalt, denn sie ist die Reihenfolge
 * auf der Website.
 */
function gleicherInhalt(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Offene Entwürfe verwerfen — der veröffentlichte Stand bleibt. */
export async function discardContentDrafts(params: {
  organizationId: string;
  keys?: string[];
  actorId: string;
}): Promise<number> {
  const result = await prisma.contentBlock.updateMany({
    where: {
      organizationId: params.organizationId,
      locale: 'DE',
      NOT: { draftValue: { equals: Prisma.DbNull } },
      ...(params.keys?.length ? { key: { in: params.keys } } : {}),
    },
    data: { draftValue: Prisma.DbNull },
  });

  /**
   * Bausteine, die nie veröffentlicht waren, sind nach dem Verwerfen leer und
   * bedeutungslos — sie würden in der Übersicht als „gepflegt" mitzählen,
   * obwohl der Auslieferungstext gilt.
   */
  await prisma.contentBlock.deleteMany({
    where: { organizationId: params.organizationId, locale: 'DE', publishedAt: null },
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'ContentBlock',
    entityId: params.organizationId,
    summary: `${result.count} Website-Entwurf/Entwürfe verworfen`,
  });

  return result.count;
}

/**
 * Einen Baustein zurückziehen — der Auslieferungstext gilt wieder.
 *
 * Das ist das Gegenstück zum Veröffentlichen. Die abgelöste Fassung wandert
 * in die Historie, damit der Schritt umkehrbar bleibt.
 */
export async function unpublishContent(params: {
  organizationId: string;
  key: string;
  actorId: string;
}): Promise<void> {
  const block = await prisma.contentBlock.findUnique({
    where: {
      organizationId_key_locale: { organizationId: params.organizationId, key: params.key, locale: 'DE' },
    },
  });
  if (!block) throw new NotFoundError('Textbaustein');

  await prisma.$transaction(async (tx) => {
    if (block.publishedAt) {
      await tx.contentRevision.create({
        data: {
          organizationId: params.organizationId,
          blockId: block.id,
          key: block.key,
          locale: 'DE',
          value: block.value as Prisma.InputJsonValue,
          createdById: params.actorId,
        },
      });
    }
    // Die Zeile bleibt stehen, damit die Historie ihren Anker behält — sie
    // trägt aber wieder den Auslieferungswert.
    const definition = definitionFor(params.key);
    await tx.contentBlock.update({
      where: { id: block.id },
      data: {
        value: (definition?.default ?? '') as Prisma.InputJsonValue,
        draftValue: Prisma.DbNull,
        publishedAt: null,
        updatedById: params.actorId,
      },
    });
  });

  await invalidateContent(params.organizationId);

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'ContentBlock',
    entityId: block.id,
    summary: `Baustein ${params.key} zurückgezogen — Auslieferungstext gilt wieder`,
  });
}

/** Frühere Fassungen eines Bausteins, neueste zuerst. */
export async function listContentRevisions(params: {
  organizationId: string;
  key: string;
  limit?: number;
}) {
  return prisma.contentRevision.findMany({
    where: { organizationId: params.organizationId, key: params.key, locale: 'DE' },
    orderBy: { createdAt: 'desc' },
    take: params.limit ?? 25,
    select: { id: true, value: true, createdAt: true, createdById: true },
  });
}

/**
 * Eine frühere Fassung zurückholen.
 *
 * Sie landet als **Entwurf**, nicht direkt auf der Website. Wiederherstellen
 * ist eine Absicht, kein Ergebnis: Man will den alten Text sehen, prüfen und
 * dann entscheiden. Direkt zu veröffentlichen würde aus einem Rückgriff eine
 * unbeabsichtigte Veröffentlichung machen.
 */
export async function restoreContentRevision(params: {
  organizationId: string;
  revisionId: string;
  actorId: string;
}): Promise<{ key: string }> {
  const revision = await prisma.contentRevision.findFirst({
    where: { id: params.revisionId, organizationId: params.organizationId },
  });
  if (!revision) throw new NotFoundError('Fassung');

  await prisma.contentBlock.update({
    where: { id: revision.blockId },
    data: { draftValue: revision.value as Prisma.InputJsonValue, updatedById: params.actorId },
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'ContentBlock',
    entityId: revision.blockId,
    summary: `Frühere Fassung von ${revision.key} als Entwurf zurückgeholt`,
  });

  return { key: revision.key };
}

// ---------------------------------------------------------------------------
//  Bilder, die an einem Datensatz hängen
// ---------------------------------------------------------------------------

/**
 * Ein Bild an seinem Datensatz austauschen.
 *
 * **Warum das nicht durch den Entwurf/Freigabe-Ablauf läuft.** Textbausteine
 * kennen einen Entwurfsstand, weil man an einem Satz mehrfach ansetzt. Ein Bild
 * ist entweder das richtige oder nicht — und es hängt an einem Datensatz, den
 * auch die Galerieverwaltung bearbeitet. Zwei Stände desselben Feldes an zwei
 * Orten liefen unweigerlich auseinander. Der Austausch wirkt deshalb sofort,
 * wie er es in der Galerieverwaltung auch täte; das Prüfprotokoll hält fest,
 * wer ihn ausgelöst hat.
 */
export async function updateAssetField(params: {
  organizationId: string;
  entity: string;
  id: string;
  field: string;
  url: string | null;
  actorId: string;
}): Promise<{ url: string | null }> {
  if (!isAssetField(params.entity, params.field)) {
    throw new NotFoundError('Bildfeld');
  }

  /*
    Eine Adresse der eigenen Ablage nur, wenn sie eine **öffentliche** Datei
    dieser Organisation bezeichnet (2026-09-27, Standard C12). Vorher nahm
    das Bildfeld jeden Pfad `/api/files/blob/…` — auch den eines privaten
    Nachrichtenanhangs. Ausgeliefert hätte ihn die Ablage zwar nicht (sie
    prüft selbst), aber die Website hätte auf eine private Datei verwiesen und
    ihre Kennung jedem Besucher gezeigt. Bilder für die Website kommen über
    die Mediathek, und die legt sie öffentlich ab.
  */
  const ablage = params.url ? /^\/api\/files\/blob\/([^/?#]+)/.exec(params.url) : null;
  if (ablage) {
    const oeffentlich = await prisma.fileAsset.count({
      where: { storedFileId: ablage[1], organizationId: params.organizationId, isPublic: true },
    });
    if (oeffentlich === 0) {
      throw new BusinessRuleError('Dieses Bild ist nicht für die Website freigegeben. Bitte über die Mediathek hochladen.');
    }
  }

  /**
   * Die Mandantenkennung steht in der `where`-Bedingung, nicht in einer
   * nachgelagerten Prüfung: Gehört der Datensatz einem anderen Betrieb, findet
   * `updateMany` schlicht nichts und schreibt nichts.
   */
  const where = { id: params.id, organizationId: params.organizationId };
  const data = { [params.field]: params.url };

  const result =
    params.entity === 'galleryItem'
      ? await prisma.galleryItem.updateMany({ where, data })
      : params.entity === 'service'
        ? await prisma.service.updateMany({ where, data })
        : await prisma.blogPost.updateMany({ where, data });

  if (result.count === 0) throw new NotFoundError('Datensatz');

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: params.entity,
    entityId: params.id,
    summary: `${assetFieldLabel(params.entity, params.field)} ${
      params.url ? 'ausgetauscht' : 'entfernt'
    } (aus der Website-Vorschau)`,
  });

  /**
   * Die öffentlichen Seiten sind statisch. Ohne diesen Anstoss zeigte die
   * Website das alte Bild bis zum Ablauf der Revalidierung — und die Redaktion
   * hielte den Austausch für gescheitert.
   */
  for (const path of ['/', '/galerie', '/leistungen', '/blog']) {
    revalidatePath(path);
  }

  return { url: params.url };
}
