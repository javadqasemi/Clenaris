import 'server-only';

import { cache as reactCache } from 'react';
import { revalidatePath } from 'next/cache';
import type { NavLocation } from '@prisma/client';

import { prisma } from '@/lib/db';
import { cache, cacheKeys } from '@/lib/redis';
import { audit, diff } from '@/lib/audit';
import { logger } from '@/lib/logger';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import type {
  CreateNavItemInput,
  NavReorderInput,
  UpdateLegalInput,
  UpdateNavItemInput,
} from '@/lib/validation/navigation';
import { LEGAL_LABELS, LEGAL_SLUGS } from '@/lib/validation/navigation';

const log = logger('navigation');

/**
 * Navigation und Rechtstexte.
 *
 * Architekturentscheide:
 *
 *  • **Die Menüstruktur fällt bei einem Ausfall auf leer zurück, nicht auf
 *    einen Fehler.** Eine Website ohne Menü ist unschön; eine Website, die
 *    wegen einer Menüabfrage gar nicht lädt, ist kaputt. Logo, Telefonnummer
 *    und Buchungsschaltfläche stehen ohnehin nicht in dieser Tabelle.
 *
 *  • **Rechtstexte tragen eine Fassung.** Ob eine Änderung eine neue Fassung
 *    ist, entscheidet die Redaktion und nicht ein Zähler: eine korrigierte
 *    Kommasetzung ist keine, eine geänderte Aufbewahrungsfrist schon. Nur ein
 *    Mensch kann das unterscheiden — deshalb das ausdrückliche Häkchen.
 *
 *  • **Ein Rechtstext lässt sich nicht löschen.** Die vier Adressen sind aus
 *    der Fusszeile, aus dem Cookie-Hinweis und aus E-Mails verlinkt; eine
 *    fehlende Datenschutzerklärung ist ausserdem ein Rechtsmangel. Es gibt
 *    nur Ändern.
 */

const CACHE_TTL_SECONDS = 300;

export interface PublicNavItem {
  id: string;
  label: string;
  href: string;
  description: string | null;
  icon: string | null;
  newTab: boolean;
  children: PublicNavItem[];
}

/** Die Menüstruktur eines Orts, verschachtelt und sortiert. */
export const getNavigation = reactCache(
  async (organizationId: string, location: NavLocation): Promise<PublicNavItem[]> => {
    try {
      const rows = await cache.remember(
        cacheKeys.navigation(organizationId, location),
        CACHE_TTL_SECONDS,
        () =>
          prisma.navigationItem.findMany({
            where: { organizationId, active: true, location },
            orderBy: { position: 'asc' },
            select: {
              id: true,
              label: true,
              href: true,
              description: true,
              icon: true,
              newTab: true,
              children: {
                where: { active: true },
                orderBy: { position: 'asc' },
                select: {
                  id: true,
                  label: true,
                  href: true,
                  description: true,
                  icon: true,
                  newTab: true,
                },
              },
            },
          }),
      );

      return (rows ?? []).map((row) => ({ ...row, children: (row.children ?? []).map((c) => ({ ...c, children: [] })) }));
    } catch (error) {
      // Lieber ohne Menü als gar keine Seite.
      log.error('Navigation konnte nicht geladen werden', { location, error });
      return [];
    }
  },
);

async function invalidateNav(organizationId: string): Promise<void> {
  await Promise.all(
    (['HEADER', 'HEADER_PANEL', 'FOOTER_SERVICES', 'FOOTER_COMPANY', 'FOOTER_LEGAL'] as NavLocation[]).map(
      (location) => cache.del(cacheKeys.navigation(organizationId, location)),
    ),
  );
  // Das Menü steht auf jeder Seite.
  revalidatePath('/', 'layout');
}

// ---------------------------------------------------------------------------
//  Verwaltung der Navigation
// ---------------------------------------------------------------------------

interface Actor {
  organizationId: string;
  actorId: string;
  ip?: string | null;
}

export async function listNavItems(organizationId: string) {
  return prisma.navigationItem.findMany({
    where: { organizationId },
    orderBy: [{ location: 'asc' }, { position: 'asc' }],
    include: { parent: { select: { id: true, label: true } } },
  });
}

export async function createNavItem({
  organizationId,
  actorId,
  ip,
  input,
}: Actor & { input: CreateNavItemInput }) {
  if (input.parentId) await assertParentValid(organizationId, input.parentId);

  const item = await prisma.navigationItem.create({
    data: {
      organizationId,
      location: input.location,
      label: input.label,
      href: input.href,
      description: input.description ?? null,
      icon: input.icon ?? null,
      newTab: input.newTab,
      parentId: input.parentId ?? null,
      position: input.position,
      active: input.active,
    },
  });

  await audit.created({
    organizationId,
    userId: actorId,
    entity: 'NavigationItem',
    entityId: item.id,
    summary: `Menüpunkt „${item.label}" angelegt (${item.location})`,
    ip,
  });

  await invalidateNav(organizationId);
  return item;
}

export async function updateNavItem({
  organizationId,
  actorId,
  ip,
  itemId,
  input,
}: Actor & { itemId: string; input: UpdateNavItemInput }) {
  const before = await prisma.navigationItem.findFirst({ where: { id: itemId, organizationId } });
  if (!before) throw new NotFoundError('Menüpunkt');

  if (input.parentId) {
    if (input.parentId === itemId) {
      throw new BusinessRuleError('Ein Menüpunkt kann nicht sein eigener übergeordneter sein.');
    }
    await assertParentValid(organizationId, input.parentId);
  }

  const item = await prisma.navigationItem.update({
    where: { id: itemId },
    data: {
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.href !== undefined ? { href: input.href } : {}),
      ...(input.description !== undefined ? { description: input.description ?? null } : {}),
      ...(input.icon !== undefined ? { icon: input.icon ?? null } : {}),
      ...(input.newTab !== undefined ? { newTab: input.newTab } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId ?? null } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    },
  });

  await audit.updated({
    organizationId,
    userId: actorId,
    entity: 'NavigationItem',
    entityId: itemId,
    summary: `Menüpunkt „${item.label}" geändert`,
    changes: diff(before as Record<string, unknown>, item as Record<string, unknown>),
    ip,
  });

  await invalidateNav(organizationId);
  return item;
}

export async function deleteNavItem({
  organizationId,
  actorId,
  ip,
  itemId,
}: Actor & { itemId: string }) {
  const item = await prisma.navigationItem.findFirst({
    where: { id: itemId, organizationId },
    include: { _count: { select: { children: true } } },
  });
  if (!item) throw new NotFoundError('Menüpunkt');

  /**
   * Unterpunkte gehen mit — die Datenbank kaskadiert. Das ist richtig (ein
   * Aufklapp-Punkt ohne Aufklapper wäre nirgends erreichbar), aber es soll
   * niemanden überraschen: die Zahl steht in der Bestätigung und im Protokoll.
   */
  await prisma.navigationItem.delete({ where: { id: itemId } });

  await audit.deleted({
    organizationId,
    userId: actorId,
    entity: 'NavigationItem',
    entityId: itemId,
    summary:
      item._count.children > 0
        ? `Menüpunkt „${item.label}" gelöscht, mit ${item._count.children} Unterpunkten`
        : `Menüpunkt „${item.label}" gelöscht`,
    ip,
  });

  await invalidateNav(organizationId);
  return { removedChildren: item._count.children };
}

export async function reorderNavItems({
  organizationId,
  actorId,
  ip,
  input,
}: Actor & { input: NavReorderInput }) {
  const owned = await prisma.navigationItem.findMany({
    where: {
      organizationId,
      location: input.location,
      parentId: input.parentId ?? null,
      id: { in: input.ids },
    },
    select: { id: true },
  });
  const allowed = new Set(owned.map((row) => row.id));
  const ordered = input.ids.filter((id) => allowed.has(id));
  if (ordered.length === 0) throw new NotFoundError('Menüpunkte');

  await prisma.$transaction(
    ordered.map((id, index) =>
      prisma.navigationItem.update({ where: { id }, data: { position: index } }),
    ),
  );

  await audit.updated({
    organizationId,
    userId: actorId,
    entity: 'NavigationItem',
    summary: `Reihenfolge in ${input.location} geändert (${ordered.length} Punkte)`,
    ip,
  });

  await invalidateNav(organizationId);
  return { updated: ordered.length };
}

async function assertParentValid(organizationId: string, parentId: string): Promise<void> {
  const parent = await prisma.navigationItem.findFirst({
    where: { id: parentId, organizationId },
    select: { location: true },
  });
  if (!parent) throw new NotFoundError('Übergeordneter Menüpunkt');
  if (parent.location !== 'HEADER') {
    throw new BusinessRuleError(
      'Nur ein Eintrag der Kopfzeile kann einen Aufklappbereich tragen.',
    );
  }
}

// ---------------------------------------------------------------------------
//  Rechtstexte
// ---------------------------------------------------------------------------

export async function listLegalDocuments(organizationId: string) {
  const rows = await prisma.legalDocument.findMany({
    where: { organizationId },
    orderBy: { slug: 'asc' },
  });

  /**
   * Fehlende Texte erscheinen als leere Platzhalter statt gar nicht.
   *
   * Sonst sähe die Redaktion eine kurze Liste und wüsste nicht, dass die
   * Datenschutzerklärung fehlt — und genau deren Fehlen ist ein Rechtsmangel.
   */
  return LEGAL_SLUGS.map((slug) => {
    const existing = rows.find((row) => row.slug === slug);
    return (
      existing ?? {
        id: null,
        organizationId,
        slug,
        title: LEGAL_LABELS[slug],
        body: '',
        version: 0,
        effectiveFrom: null,
        createdAt: null,
        updatedAt: null,
      }
    );
  });
}

export const getLegalDocument = reactCache(async (organizationId: string, slug: string) => {
  return prisma.legalDocument.findUnique({
    where: { organizationId_slug: { organizationId, slug } },
  });
});

export async function upsertLegalDocument({
  organizationId,
  actorId,
  ip,
  slug,
  input,
}: Actor & { slug: string; input: UpdateLegalInput }) {
  if (!(LEGAL_SLUGS as readonly string[]).includes(slug)) {
    throw new NotFoundError('Rechtstext');
  }

  const before = await prisma.legalDocument.findUnique({
    where: { organizationId_slug: { organizationId, slug } },
  });

  const effectiveFrom = new Date(`${input.effectiveFrom}T00:00:00.000Z`);
  const version = input.newVersion ? (before?.version ?? 0) + 1 : (before?.version ?? 1);

  const document = await prisma.legalDocument.upsert({
    where: { organizationId_slug: { organizationId, slug } },
    update: { title: input.title, body: input.body, effectiveFrom, version },
    create: {
      organizationId,
      slug,
      title: input.title,
      body: input.body,
      effectiveFrom,
      version: 1,
    },
  });

  await audit.updated({
    organizationId,
    userId: actorId,
    entity: 'LegalDocument',
    entityId: document.id,
    summary: input.newVersion
      ? `${LEGAL_LABELS[slug as (typeof LEGAL_SLUGS)[number]]}: neue Fassung ${document.version}, gültig ab ${input.effectiveFrom}`
      : `${LEGAL_LABELS[slug as (typeof LEGAL_SLUGS)[number]]} überarbeitet (Fassung ${document.version})`,
    changes: {
      ...(before ? { version: { from: before.version, to: document.version } } : {}),
      zeichen: { from: before?.body.length ?? 0, to: document.body.length },
    },
    ip,
  });

  await cache.del(cacheKeys.legal(organizationId, slug));
  revalidatePath(`/legal/${slug}`);
  return document;
}
