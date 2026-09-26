import 'server-only';

import { cache as reactCache } from 'react';
import { prisma } from '@/lib/db';
import { cache, cacheKeys } from '@/lib/redis';

/**
 * Mandantenkontext.
 *
 * Architekturentscheid: Die Plattform läuft heute mit genau einer Organisation,
 * das Datenmodell ist aber mandantenfähig. Sämtliche Auflösung des aktiven
 * Mandanten passiert hier — wird später pro Domain oder Subdomain getrennt,
 * ändert sich nur diese Datei, nicht die 90 Aufrufstellen.
 */

export const DEFAULT_ORG_SLUG = process.env.ORGANIZATION_SLUG ?? 'clenaris';

/**
 * Die Organisation dieser Installation. Pro Request dedupliziert und 5 Minuten
 * gecacht.
 *
 * **Kein Rückfall mehr auf „die erste Organisation"** (2026-09-27). Bis dahin
 * griff die Funktion, wenn der Slug fehlte, zur ältesten Organisation der
 * Datenbank — gedacht gegen einen harten Fehler bei abweichendem Seed. In
 * einer Datenbank mit mehr als einer Organisation hiess das: Welche
 * Kundschaft die Installation bedient, entschied die Einfügereihenfolge. Ein
 * falsch gesetzter `ORGANIZATION_SLUG` ist ein Konfigurationsfehler und soll
 * laut scheitern, nicht still die falschen Daten zeigen.
 *
 * Für angemeldete Anfragen ist das zugleich die Organisation der Sitzung:
 * `getSession()` lässt nur Konten dieser Organisation durch, und
 * `createSession()` stellt für andere kein Token aus. Jede der rund 440
 * Aufrufstellen arbeitet damit im Mandanten der angemeldeten Person — ohne
 * dass eine davon einer Organisationskennung aus der Anfrage glaubt.
 */
export const getOrganization = reactCache(async () => {
  return cache.remember(cacheKeys.organization(DEFAULT_ORG_SLUG), 300, async () => {
    const org = await prisma.organization.findFirst({ where: { slug: DEFAULT_ORG_SLUG } });
    if (!org) {
      throw new Error(
        `Organisation „${DEFAULT_ORG_SLUG}" nicht gefunden — ORGANIZATION_SLUG prüfen oder den Konfigurations-Seed ausführen.`,
      );
    }
    return org;
  });
});

export async function getOrganizationId(): Promise<string> {
  const org = await getOrganization();
  return org.id;
}

/** Cache nach Änderungen an den Stammdaten leeren. */
export async function invalidateOrganizationCache(slug = DEFAULT_ORG_SLUG) {
  await cache.del(cacheKeys.organization(slug));
}

export interface PublicCompanyInfo {
  name: string;
  legalName: string | null;
  email: string;
  phone: string | null;
  website: string | null;
  address: { street: string; postalCode: string; city: string; canton: string; country: string };
  vatNumber: string | null;
  iban: string | null;
  openingHours: { weekday: number; opensAt: string | null; closesAt: string | null; closed: boolean }[];
  primaryColor: string;
  logoUrl: string | null;
}

/** Firmendaten für Footer, Impressum und strukturierte Daten (JSON-LD). */
export async function getPublicCompanyInfo(): Promise<PublicCompanyInfo> {
  const org = await getOrganization();
  const hours = await prisma.openingHours.findMany({
    where: { organizationId: org.id },
    orderBy: { weekday: 'asc' },
  });

  return {
    name: org.name,
    legalName: org.legalName,
    email: org.email,
    phone: org.phone,
    website: org.website,
    address: {
      street: [org.street, org.streetNo].filter(Boolean).join(' '),
      postalCode: org.postalCode,
      city: org.city,
      canton: org.canton,
      country: org.country,
    },
    vatNumber: org.vatNumber,
    iban: org.iban,
    openingHours: hours.map((h) => ({
      weekday: h.weekday,
      opensAt: h.opensAt,
      closesAt: h.closesAt,
      closed: h.closed,
    })),
    primaryColor: org.primaryColor,
    logoUrl: org.logoUrl,
  };
}

/** Einsatzgebiet (PLZ-Liste) — für Website und Buchungsformular. */
export async function getServiceAreas() {
  const orgId = await getOrganizationId();
  return cache.remember(cacheKeys.serviceAreas(orgId), 3600, async () =>
    prisma.serviceArea.findMany({
      where: { organizationId: orgId, active: true },
      orderBy: [{ city: 'asc' }, { postalCode: 'asc' }],
      select: {
        postalCode: true,
        city: true,
        canton: true,
        travelFee: true,
        travelMinutes: true,
      },
    }),
  );
}

export async function isWithinServiceArea(postalCode: string): Promise<boolean> {
  const orgId = await getOrganizationId();
  const area = await prisma.serviceArea.findFirst({
    where: { organizationId: orgId, postalCode: postalCode.trim(), active: true },
    select: { id: true },
  });
  return Boolean(area);
}
