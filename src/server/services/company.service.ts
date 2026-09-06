import 'server-only';

import { revalidatePath } from 'next/cache';

import { prisma } from '@/lib/db';
import { cache } from '@/lib/redis';
import { audit, diff } from '@/lib/audit';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import type { UpdateCompanyInput } from '@/lib/validation/cms';

/**
 * Firmendaten und Öffnungszeiten.
 *
 * Architekturentscheide:
 *
 *  • **Das sind keine „Inhalte".** Firma, Adresse, MWST-Nummer und IBAN
 *    stehen im Impressum, in der Fusszeile, in den strukturierten Daten für
 *    Suchmaschinen *und* auf jeder Rechnung samt QR-Einzahlschein. Sie liegen
 *    deshalb in der `Organization`-Tabelle und nicht im Textbaustein-Register:
 *    ein Textbaustein darf leer sein, eine IBAN auf einer Rechnung nicht.
 *
 *  • **Die IBAN wird geprüft, nicht nur entgegengenommen.** Eine falsche IBAN
 *    fällt sonst erst auf, wenn eine Kundschaft die erste Rechnung nicht
 *    bezahlen kann — und dann steht sie bereits auf ausgestellten,
 *    unveränderlichen Belegen.
 *
 *  • **Öffnungszeiten sind sieben Zeilen, nicht ein Freitext.** Sie erscheinen
 *    als `openingHoursSpecification` in den strukturierten Daten; Google
 *    zeigt sie im Suchergebnis an. Ein Freitext wäre dort wertlos.
 */

/**
 * Prüfsumme einer IBAN nach ISO 13616 (Modulo 97-10).
 *
 * Bewusst selbst gerechnet statt über eine Abhängigkeit: es sind acht Zeilen,
 * und die Regel ändert sich nicht. Schweizer IBAN sind 21 Zeichen lang.
 */
export function isValidIban(raw: string): boolean {
  const iban = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;

  // Die ersten vier Zeichen ans Ende, Buchstaben zu Zahlen (A=10 … Z=35).
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));

  // Stückweise rechnen — die Zahl wird sonst zu gross für ein JS-Number.
  let remainder = 0;
  for (const digit of numeric) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export async function getCompany(organizationId: string) {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: { openingHours: { orderBy: { weekday: 'asc' } } },
  });
  if (!org) throw new NotFoundError('Organisation');
  return org;
}

export async function updateCompany({
  organizationId,
  actorId,
  ip,
  input,
}: {
  organizationId: string;
  actorId: string;
  ip?: string | null;
  input: UpdateCompanyInput;
}) {
  const before = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!before) throw new NotFoundError('Organisation');

  for (const [field, value] of [
    ['IBAN', input.iban],
    ['QR-IBAN', input.qrIban],
  ] as const) {
    if (value && value.trim() !== '' && !isValidIban(value)) {
      throw new BusinessRuleError(
        `Die ${field} ist ungültig — die Prüfziffer stimmt nicht. Eine falsche Nummer fällt sonst erst auf, wenn eine Rechnung nicht bezahlt werden kann.`,
      );
    }
  }

  const empty = (value: string | undefined) => (value && value.trim() !== '' ? value.trim() : null);

  const org = await prisma.organization.update({
    where: { id: organizationId },
    data: {
      name: input.name,
      legalName: empty(input.legalName),
      email: input.email,
      phone: empty(input.phone),
      whatsapp: empty(input.whatsapp),
      website: empty(input.website),
      street: input.street,
      streetNo: empty(input.streetNo),
      postalCode: input.postalCode,
      city: input.city,
      vatNumber: empty(input.vatNumber),
      iban: empty(input.iban),
      qrIban: empty(input.qrIban),
      bankName: empty(input.bankName),
      logoUrl: empty(input.logoUrl),
      logoDarkUrl: empty(input.logoDarkUrl),
      faviconUrl: empty(input.faviconUrl),
      mapsUrl: empty(input.mapsUrl),
      facebookUrl: empty(input.facebookUrl),
      instagramUrl: empty(input.instagramUrl),
      linkedinUrl: empty(input.linkedinUrl),
      tiktokUrl: empty(input.tiktokUrl),
      youtubeUrl: empty(input.youtubeUrl),
    },
  });

  await audit.updated({
    organizationId,
    userId: actorId,
    entity: 'Organization',
    entityId: organizationId,
    summary: 'Firmendaten geändert',
    changes: diff(
      before as unknown as Record<string, unknown>,
      org as unknown as Record<string, unknown>,
    ),
    ip,
  });

  await invalidateCompany(organizationId);
  return org;
}

export interface OpeningHourInput {
  weekday: number;
  opensAt?: string | null;
  closesAt?: string | null;
  closed: boolean;
}

/**
 * Öffnungszeiten als Ganzes setzen.
 *
 * Sieben Zeilen kommen zusammen, sieben gehen zurück. Einzelne Tage zu
 * pflegen wäre bei einem Formular mit sieben Zeilen sieben Anfragen — und
 * jede könnte für sich fehlschlagen.
 */
export async function updateOpeningHours({
  organizationId,
  actorId,
  ip,
  hours,
}: {
  organizationId: string;
  actorId: string;
  ip?: string | null;
  hours: OpeningHourInput[];
}) {
  for (const hour of hours) {
    if (hour.closed) continue;
    if (!hour.opensAt || !hour.closesAt) {
      throw new BusinessRuleError(
        `Für einen offenen Tag sind Öffnungs- und Schliesszeit beide erforderlich (Wochentag ${hour.weekday}).`,
      );
    }
    if (hour.closesAt <= hour.opensAt) {
      throw new BusinessRuleError(
        `Die Schliesszeit muss nach der Öffnungszeit liegen (Wochentag ${hour.weekday}).`,
      );
    }
  }

  await prisma.$transaction(
    hours.map((hour) =>
      prisma.openingHours.upsert({
        where: { organizationId_weekday: { organizationId, weekday: hour.weekday } },
        update: {
          opensAt: hour.closed ? null : (hour.opensAt ?? null),
          closesAt: hour.closed ? null : (hour.closesAt ?? null),
          closed: hour.closed,
        },
        create: {
          organizationId,
          weekday: hour.weekday,
          opensAt: hour.closed ? null : (hour.opensAt ?? null),
          closesAt: hour.closed ? null : (hour.closesAt ?? null),
          closed: hour.closed,
        },
      }),
    ),
  );

  await audit.updated({
    organizationId,
    userId: actorId,
    entity: 'OpeningHours',
    entityId: organizationId,
    summary: 'Öffnungszeiten geändert',
    changes: Object.fromEntries(
      hours.map((h) => [
        `weekday${h.weekday}`,
        h.closed ? 'geschlossen' : `${h.opensAt}–${h.closesAt}`,
      ]),
    ),
    ip,
  });

  await invalidateCompany(organizationId);
  return prisma.openingHours.findMany({ where: { organizationId }, orderBy: { weekday: 'asc' } });
}

/**
 * Zwei Zwischenspeicher, beide nötig.
 *
 * Firmendaten stecken in Kopf- und Fusszeile jeder öffentlichen Seite sowie in
 * den strukturierten Daten — deshalb der ganze Baum. Der Redis-Eintrag hält
 * zusätzlich die Abfrage zurück.
 */
async function invalidateCompany(organizationId: string): Promise<void> {
  await cache.del(`company:${organizationId}`);
  await cache.del(`org:${organizationId}`);
  revalidatePath('/', 'layout');
}
