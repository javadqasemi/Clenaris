import 'server-only';

import { cache as reactCache } from 'react';
import { revalidatePath } from 'next/cache';
import { Prisma, type CtaSlot } from '@prisma/client';

import { prisma } from '@/lib/db';
import { cache } from '@/lib/redis';
import { audit, diff } from '@/lib/audit';
import { logger } from '@/lib/logger';
import { BusinessRuleError, ConflictError, NotFoundError } from '@/lib/errors';
import { matchesPage, withinSchedule } from '@/lib/cta/match';
import type { CreateCtaInput, CtaReorderInput, UpdateCtaInput } from '@/lib/validation/cta';

const log = logger('cta');

/**
 * Handlungsaufrufe: Pflege und Auslieferung.
 *
 * Architekturentscheide:
 *
 *  • **Die Website fragt nach Platz und Pfad, nicht nach einer Liste.**
 *    `ctasFor('HEADER', '/leistungen/umzugsreinigung')` liefert genau das, was
 *    dort erscheinen soll — gefiltert, sortiert, im Zeitfenster. Die
 *    Entscheidung, *ob* ein Aufruf sichtbar ist, gehört auf den Server; im
 *    Browser wäre sie erst nach dem Laden getroffen und würde flackern.
 *
 *  • **Die Zeitsteuerung wird beim Lesen ausgewertet, nicht von einem
 *    Hintergrundlauf.** Ein Cron, der nachts `active` umschaltet, wäre eine
 *    zweite Wahrheit: fällt er aus, bleibt eine abgelaufene Aktion stehen.
 *    Der Vergleich mit der Uhr kostet nichts und kann nicht ausfallen.
 *
 *  • **Gelöscht wird weich.** Ein Aufruf, der versehentlich entfernt wurde,
 *    ist sonst mitsamt Text, Farbe und Zeitplan verloren. `deletedAt` erlaubt
 *    das Wiederherstellen; endgültig entfernt wird auf ausdrücklichen Wunsch.
 *
 *  • **Jede Änderung räumt beide Zwischenspeicher.** Redis hält die Abfrage
 *    zurück, darüber liegt der Seitencache von Next.js. Ohne den zweiten
 *    Schritt speichert die Verwaltung, sieht auf der Website nichts und hält
 *    das Speichern für kaputt.
 */

const CACHE_TTL_SECONDS = 120;
const CACHE_KEY = (organizationId: string) => `cta:${organizationId}`;

export interface PublicCta {
  id: string;
  key: string;
  label: string;
  href: string;
  newTab: boolean;
  icon: string | null;
  slot: CtaSlot;
  style: string;
  bgColor: string | null;
  fgColor: string | null;
}

/**
 * Alle aktiven Aufrufe eines Mandanten — einmal je Rendering.
 *
 * Es sind wenige Dutzend Zeilen; sie alle zu laden und im Speicher zu filtern
 * ist billiger als eine Abfrage je Platz. `React.cache` dedupliziert innerhalb
 * eines Renderings, Redis über Requests hinweg.
 */
const loadActive = reactCache(async (organizationId: string) => {
  try {
    const rows = await cache.remember(CACHE_KEY(organizationId), CACHE_TTL_SECONDS, () =>
      prisma.callToAction.findMany({
        where: { organizationId, active: true, deletedAt: null },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          key: true,
          label: true,
          href: true,
          newTab: true,
          icon: true,
          slot: true,
          style: true,
          bgColor: true,
          fgColor: true,
          pages: true,
          publishFrom: true,
          publishUntil: true,
        },
      }),
    );
    return rows ?? [];
  } catch (error) {
    // Ein Ausfall darf die Website nicht mitreissen — sie zeigt dann keine
    // Aufrufe, aber alles andere.
    log.error('Handlungsaufrufe konnten nicht geladen werden', { error });
    return [];
  }
});

/** Was an einem Platz auf einer bestimmten Seite erscheinen soll. */
export async function ctasFor(
  organizationId: string,
  slot: CtaSlot,
  pathname: string,
): Promise<PublicCta[]> {
  const now = new Date();
  const rows = await loadActive(organizationId);

  return rows
    .filter(
      (row) =>
        row.slot === slot &&
        matchesPage(row.pages, pathname) &&
        withinSchedule(row.publishFrom, row.publishUntil, now),
    )
    .map(({ pages: _pages, publishFrom: _from, publishUntil: _until, ...rest }) => rest);
}

/**
 * Aufrufe mehrerer Plätze — **ohne** Pfadfilter.
 *
 * Für Kopf- und Fusszeile: sie liegen im Layout und kennen den aktuellen Pfad
 * nicht. Statt die Middleware auf die öffentliche Website auszuweiten (ein
 * Edge-Aufruf je Seitenaufruf, den wir bewusst vermeiden), liefert diese
 * Funktion alle Kandidaten mitsamt Seitenliste und Zeitfenster; die Auswahl
 * fällt im Browser über dieselbe Regel aus `lib/cta/match`.
 *
 * Die Zeitsteuerung wird hier trotzdem schon angewandt — ein abgelaufener
 * Aufruf muss gar nicht erst über die Leitung gehen.
 */
export async function listPublicCtas(
  organizationId: string,
  slots: CtaSlot[],
): Promise<(PublicCta & { pages: string[] })[]> {
  const now = new Date();
  const rows = await loadActive(organizationId);

  return rows
    .filter((row) => slots.includes(row.slot) && withinSchedule(row.publishFrom, row.publishUntil, now))
    .map(({ publishFrom: _from, publishUntil: _until, ...rest }) => rest);
}

/** Der erste passende Aufruf — für Plätze, die genau einen zeigen. */
export async function ctaFor(
  organizationId: string,
  slot: CtaSlot,
  pathname: string,
): Promise<PublicCta | null> {
  const list = await ctasFor(organizationId, slot, pathname);
  return list[0] ?? null;
}

async function invalidate(): Promise<void> {
  // Der ganze öffentliche Baum: Kopf- und Fusszeile tragen Aufrufe und
  // erscheinen auf jeder Seite.
  revalidatePath('/', 'layout');
}

async function invalidateAll(organizationId: string): Promise<void> {
  await cache.del(CACHE_KEY(organizationId));
  await invalidate();
}

// ---------------------------------------------------------------------------
//  Verwaltung
// ---------------------------------------------------------------------------

interface Actor {
  organizationId: string;
  actorId: string;
  ip?: string | null;
}

/** Alle Aufrufe inklusive inaktiver — für die Verwaltung. */
export async function listCtas(organizationId: string, includeDeleted = false) {
  return prisma.callToAction.findMany({
    where: { organizationId, ...(includeDeleted ? {} : { deletedAt: null }) },
    orderBy: [{ slot: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
  });
}

export async function getCta(organizationId: string, id: string) {
  const cta = await prisma.callToAction.findFirst({ where: { id, organizationId } });
  if (!cta) throw new NotFoundError('Handlungsaufruf');
  return cta;
}

function toDate(value: string | undefined): Date | null {
  if (!value) return null;
  // Ein Wert aus `<input type="datetime-local">` trägt keine Zonenangabe. Er
  // ist als Schweizer Ortszeit gemeint — genau das, was die Person eingetippt
  // hat. Ohne diese Behandlung wanderte jeder Termin um ein bis zwei Stunden.
  const local = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value);
  return new Date(local ? `${value}:00` : value);
}

export async function createCta({
  organizationId,
  actorId,
  ip,
  input,
}: Actor & { input: CreateCtaInput }) {
  try {
    const cta = await prisma.callToAction.create({
      data: {
        organizationId,
        key: input.key,
        label: input.label,
        note: input.note ?? null,
        href: input.href,
        newTab: input.newTab,
        icon: input.icon ?? null,
        slot: input.slot,
        style: input.style,
        bgColor: input.bgColor ?? null,
        fgColor: input.fgColor ?? null,
        pages: input.pages,
        active: input.active,
        position: input.position,
        publishFrom: toDate(input.publishFrom),
        publishUntil: toDate(input.publishUntil),
      },
    });

    await audit.created({
      organizationId,
      userId: actorId,
      entity: 'CallToAction',
      entityId: cta.id,
      summary: `Handlungsaufruf „${cta.label}" angelegt`,
      changes: { slot: cta.slot, href: cta.href, active: cta.active },
      ip,
    });

    await invalidateAll(organizationId);
    return cta;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictError('Dieser Kurzname ist bereits vergeben.');
    }
    throw error;
  }
}

export async function updateCta({
  organizationId,
  actorId,
  ip,
  ctaId,
  input,
}: Actor & { ctaId: string; input: UpdateCtaInput }) {
  const before = await getCta(organizationId, ctaId);

  /**
   * Eigene Farben verlangen beide Werte. Beim Teil-Update prüfen wir gegen den
   * gespeicherten Stand — sonst liesse sich eine Schaltfläche auf „eigene
   * Farben" umstellen, ohne welche zu hinterlegen, und erschiene unsichtbar.
   */
  const style = input.style ?? before.style;
  const bgColor = input.bgColor !== undefined ? input.bgColor : before.bgColor;
  const fgColor = input.fgColor !== undefined ? input.fgColor : before.fgColor;
  if (style === 'CUSTOM' && (!bgColor || !fgColor)) {
    throw new BusinessRuleError(
      'Bei eigenen Farben müssen Hintergrund und Schriftfarbe beide hinterlegt sein.',
    );
  }

  try {
    const cta = await prisma.callToAction.update({
      where: { id: ctaId },
      data: {
        ...(input.key !== undefined ? { key: input.key } : {}),
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.note !== undefined ? { note: input.note ?? null } : {}),
        ...(input.href !== undefined ? { href: input.href } : {}),
        ...(input.newTab !== undefined ? { newTab: input.newTab } : {}),
        ...(input.icon !== undefined ? { icon: input.icon ?? null } : {}),
        ...(input.slot !== undefined ? { slot: input.slot } : {}),
        ...(input.style !== undefined ? { style: input.style } : {}),
        ...(input.bgColor !== undefined ? { bgColor: input.bgColor ?? null } : {}),
        ...(input.fgColor !== undefined ? { fgColor: input.fgColor ?? null } : {}),
        ...(input.pages !== undefined ? { pages: input.pages } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
        ...(input.publishFrom !== undefined ? { publishFrom: toDate(input.publishFrom) } : {}),
        ...(input.publishUntil !== undefined ? { publishUntil: toDate(input.publishUntil) } : {}),
      },
    });

    await audit.updated({
      organizationId,
      userId: actorId,
      entity: 'CallToAction',
      entityId: ctaId,
      summary: `Handlungsaufruf „${cta.label}" geändert`,
      changes: diff(
        before as unknown as Record<string, unknown>,
        cta as unknown as Record<string, unknown>,
      ),
      ip,
    });

    await invalidateAll(organizationId);
    return cta;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictError('Dieser Kurzname ist bereits vergeben.');
    }
    throw error;
  }
}

/**
 * In den Papierkorb legen.
 *
 * Weich, weil ein Handlungsaufruf aus Text, Farbe, Symbol, Ziel, Seitenliste
 * und Zeitplan besteht — versehentlich gelöscht wäre das alles neu zu tippen.
 */
export async function deleteCta({ organizationId, actorId, ip, ctaId }: Actor & { ctaId: string }) {
  const cta = await getCta(organizationId, ctaId);
  if (cta.deletedAt) throw new BusinessRuleError('Dieser Eintrag liegt bereits im Papierkorb.');

  await prisma.callToAction.update({
    where: { id: ctaId },
    data: { deletedAt: new Date(), active: false },
  });

  await audit.deleted({
    organizationId,
    userId: actorId,
    entity: 'CallToAction',
    entityId: ctaId,
    summary: `Handlungsaufruf „${cta.label}" in den Papierkorb gelegt`,
    ip,
  });

  await invalidateAll(organizationId);
}

export async function restoreCta({ organizationId, actorId, ip, ctaId }: Actor & { ctaId: string }) {
  const cta = await getCta(organizationId, ctaId);
  if (!cta.deletedAt) throw new BusinessRuleError('Dieser Eintrag liegt nicht im Papierkorb.');

  const restored = await prisma.callToAction.update({
    where: { id: ctaId },
    // Bewusst inaktiv zurück: wer wiederherstellt, will erst nachsehen und
    // dann veröffentlichen — nicht, dass die Schaltfläche im selben Moment
    // wieder auf der Website steht.
    data: { deletedAt: null, active: false },
  });

  await audit.updated({
    organizationId,
    userId: actorId,
    entity: 'CallToAction',
    entityId: ctaId,
    summary: `Handlungsaufruf „${cta.label}" wiederhergestellt (inaktiv)`,
    ip,
  });

  await invalidateAll(organizationId);
  return restored;
}

/** Endgültig entfernen — nur aus dem Papierkorb heraus. */
export async function purgeCta({ organizationId, actorId, ip, ctaId }: Actor & { ctaId: string }) {
  const cta = await getCta(organizationId, ctaId);
  if (!cta.deletedAt) {
    throw new BusinessRuleError(
      'Endgültig löschen ist nur aus dem Papierkorb möglich. Legen Sie den Eintrag zuerst dorthin.',
    );
  }

  await prisma.callToAction.delete({ where: { id: ctaId } });

  await audit.deleted({
    organizationId,
    userId: actorId,
    entity: 'CallToAction',
    entityId: ctaId,
    summary: `Handlungsaufruf „${cta.label}" endgültig gelöscht`,
    ip,
  });

  await invalidateAll(organizationId);
}

/** Ein- und ausschalten — die häufigste Handlung, deshalb eigener Weg. */
export async function toggleCta({
  organizationId,
  actorId,
  ip,
  ctaId,
  active,
}: Actor & { ctaId: string; active: boolean }) {
  const before = await getCta(organizationId, ctaId);
  if (before.deletedAt) throw new BusinessRuleError('Ein Eintrag im Papierkorb kann nicht aktiv sein.');

  const cta = await prisma.callToAction.update({ where: { id: ctaId }, data: { active } });

  await audit.updated({
    organizationId,
    userId: actorId,
    entity: 'CallToAction',
    entityId: ctaId,
    summary: `Handlungsaufruf „${cta.label}" ${active ? 'veröffentlicht' : 'abgeschaltet'}`,
    ip,
  });

  await invalidateAll(organizationId);
  return cta;
}

/**
 * Reihenfolge innerhalb eines Platzes setzen.
 *
 * Wie im Katalog: gesendet wird die Reihenfolge, die Positionen vergibt der
 * Server aus dem Index. Alles in einer Transaktion.
 */
export async function reorderCtas({
  organizationId,
  actorId,
  ip,
  input,
}: Actor & { input: CtaReorderInput }) {
  const owned = await prisma.callToAction.findMany({
    where: { organizationId, slot: input.slot, id: { in: input.ids }, deletedAt: null },
    select: { id: true },
  });
  const allowed = new Set(owned.map((row) => row.id));
  const ordered = input.ids.filter((id) => allowed.has(id));

  if (ordered.length === 0) throw new NotFoundError('Handlungsaufrufe');

  await prisma.$transaction(
    ordered.map((id, index) =>
      prisma.callToAction.update({ where: { id }, data: { position: index } }),
    ),
  );

  await audit.updated({
    organizationId,
    userId: actorId,
    entity: 'CallToAction',
    summary: `Reihenfolge im Platz ${input.slot} geändert (${ordered.length} Einträge)`,
    ip,
  });

  await invalidateAll(organizationId);
  return { updated: ordered.length };
}
