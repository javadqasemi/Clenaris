import 'server-only';

import { cache as reactCache } from 'react';
import { revalidatePath } from 'next/cache';

import { prisma } from '@/lib/db';
import { cache, cacheKeys } from '@/lib/redis';
import { logger } from '@/lib/logger';
import {
  CONTENT_DEFINITIONS,
  defaultContent,
  definitionFor,
  isContentKey,
  seoDefinitionFor,
  type ContentDefinition,
} from '@/lib/cms/registry';

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

    const result: ContentMap = { ...defaults };

    for (const row of stored ?? []) {
      if (!isContentKey(row.key)) continue;
      const definition = definitionFor(row.key);
      if (!definition) continue;

      const value = coerce(definition, row.value);
      if (value !== null) result[row.key] = value;
    }

    return result;
  } catch (error) {
    // Ein Ausfall der Inhaltstabelle darf die Website nicht mitreissen —
    // sie zeigt dann die Auslieferungsfassung.
    log.error('Inhalte konnten nicht geladen werden, verwende Standardtexte', { error });
    return defaults;
  }
});

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

      return {
        title: row.title?.trim() || fallback.title,
        description: row.description?.trim() || fallback.description,
        keywords: row.keywords ?? [],
        ogImageUrl: row.ogImageUrl ?? null,
        noIndex: row.noIndex,
      };
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
}

/** Zählt, wie viele Bausteine tatsächlich gepflegt sind — für die Übersicht. */
export async function countCuratedContent(organizationId: string): Promise<{
  curated: number;
  total: number;
}> {
  const curated = await prisma.contentBlock.count({
    where: { organizationId, locale: 'DE', key: { in: CONTENT_DEFINITIONS.map((d) => d.key) } },
  });
  return { curated, total: CONTENT_DEFINITIONS.length };
}
