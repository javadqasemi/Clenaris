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

/** Die aktive Organisation. Pro Request dedupliziert und 5 Minuten gecacht. */
export const getOrganization = reactCache(async () => {
  return cache.remember(cacheKeys.organization(DEFAULT_ORG_SLUG), 300, async () => {
    const org = await prisma.organization.findFirst({
      where: { slug: DEFAULT_ORG_SLUG },
      orderBy: { createdAt: 'asc' },
    });

    if (org) return org;

    // Fallback: erste Organisation überhaupt — verhindert einen harten Fehler,
    // wenn der Slug abweichend geseedet wurde.
    return prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
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
