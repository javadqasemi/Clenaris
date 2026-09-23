import 'server-only';

import type { Prisma } from '@prisma/client';

import { audit } from '@/lib/audit';
import { prisma, toNumber } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { rappen } from '@/lib/payroll/beitraege';
import { renderSalaryCertificatePdf } from '@/lib/pdf/render';

import { lohnPdfAblegen, lohnPdfLesen } from './payroll.service';

/**
 * Lohnausweis-Aufstellung (Wave 9, 2026-09-23).
 *
 * **Was das ist:** eine Verdichtung der veröffentlichten Abrechnungen eines
 * Jahres auf die Ziffern des Lohnausweises (Formular 11), als Vorlage für den
 * amtlichen Ausweis.
 *
 * **Was das nicht ist:** der amtliche Lohnausweis. Das Formular hat Felder,
 * die aus den Abrechnungen nicht hervorgehen (Kantinenverpflegung, Fahrten
 * Wohnort–Arbeitsort, Aussendienst-Anteile, Bemerkungen in Ziffer 15), und
 * die Zuordnung der Lohnarten zu den Ziffern ist fachlich zu bestätigen. Die
 * Aufstellung sagt das auf jeder Seite; eine Konformitätsaussage macht sie
 * nicht.
 *
 * **Versionen.** Ein Entwurf wird bei jedem Erstellen neu verdichtet. Ein
 * abgeschlossener Ausweis ist unveränderlich (Dienst und Trigger); eine
 * Korrektur ist eine neue Version mit höherer Nummer.
 */

const ZIFFERN: { ziffer: string; bezeichnung: string }[] = [
  { ziffer: '1', bezeichnung: 'Lohn (inkl. Überstunden, Zulagen, Ferien-/Feiertagsentschädigung, 13. Monatslohn)' },
  { ziffer: '7', bezeichnung: 'Andere Leistungen (Familienzulagen über den Betrieb)' },
  { ziffer: '8', bezeichnung: 'Bruttolohn total (1 + 7)' },
  { ziffer: '9', bezeichnung: 'Beiträge AHV/IV/EO/ALV/NBUV' },
  { ziffer: '10.1', bezeichnung: 'Berufliche Vorsorge — ordentliche Beiträge' },
  { ziffer: '11', bezeichnung: 'Nettolohn (8 − 9 − 10)' },
  { ziffer: '12', bezeichnung: 'Quellensteuerabzug' },
  { ziffer: '13.1.1', bezeichnung: 'Effektive Spesen' },
];

type Feld = { ziffer: string; bezeichnung: string; betrag: number };

function verdichte(zeilen: { certificateField: string | null; amount: Prisma.Decimal }[]): Feld[] {
  const summe = (ziffer: string) =>
    rappen(zeilen.filter((z) => z.certificateField === ziffer).reduce((s, z) => s + toNumber(z.amount), 0));
  const werte: Record<string, number> = {
    '1': summe('1'),
    '7': summe('7'),
    '9': summe('9'),
    '10.1': summe('10.1'),
    '12': summe('12'),
    '13.1.1': summe('13.1.1'),
  };
  werte['8'] = rappen(werte['1']! + werte['7']!);
  werte['11'] = rappen(werte['8']! - werte['9']! - werte['10.1']!);
  return ZIFFERN.map((z) => ({ ...z, betrag: werte[z.ziffer] ?? 0 }));
}

export async function listSalaryCertificates(params: {
  organizationId: string;
  employeeId?: string;
  year?: number;
  /** Nur abgeschlossene — für die eigene Person. */
  nurAbgeschlossen?: boolean;
}) {
  return prisma.salaryCertificate.findMany({
    where: {
      organizationId: params.organizationId,
      ...(params.employeeId ? { employeeId: params.employeeId } : {}),
      ...(params.year ? { year: params.year } : {}),
      ...(params.nurAbgeschlossen ? { status: 'FINAL' as const } : {}),
    },
    orderBy: [{ year: 'desc' }, { employeeId: 'asc' }, { version: 'desc' }],
    take: 500,
    include: { employee: { select: { id: true, employeeNumber: true, user: { select: { firstName: true, lastName: true } } } } },
  });
}

/**
 * Den Entwurf eines Jahres erstellen oder neu verdichten.
 */
export async function createSalaryCertificate(params: {
  organizationId: string;
  employeeId: string;
  year: number;
  actorId: string;
  ip?: string | null;
}) {
  const akte = await prisma.employee.findFirst({
    where: { id: params.employeeId, organizationId: params.organizationId },
    select: { id: true, employeeNumber: true, hiredAt: true, terminatedAt: true },
  });
  if (!akte) throw new NotFoundError('Personalakte');

  const abrechnungen = await prisma.payslip.findMany({
    where: { employeeId: akte.id, year: params.year, published: true },
    select: { id: true, lines: { select: { certificateField: true, amount: true } } },
    orderBy: { month: 'asc' },
  });
  if (abrechnungen.length === 0) {
    throw new BusinessRuleError(`Für ${params.year} gibt es keine veröffentlichte Abrechnung dieser Person.`);
  }

  const felder = verdichte(abrechnungen.flatMap((a) => a.lines));
  const jahresbeginn = new Date(Date.UTC(params.year, 0, 1));
  const jahresende = new Date(Date.UTC(params.year, 11, 31));
  const periodFrom = akte.hiredAt > jahresbeginn ? akte.hiredAt : jahresbeginn;
  const periodTo = akte.terminatedAt && akte.terminatedAt < jahresende ? akte.terminatedAt : jahresende;
  const daten = {
    periodFrom,
    periodTo,
    fields: { felder, hinweis: 'Aufstellung aus veröffentlichten Abrechnungen — nicht das amtliche Formular 11; fachlich zu prüfen.' } as unknown as Prisma.InputJsonValue,
    payslipIds: abrechnungen.map((a) => a.id),
  };

  const entwurf = await prisma.salaryCertificate.findFirst({
    where: { employeeId: akte.id, year: params.year, status: 'DRAFT' },
    select: { id: true },
  });
  let ergebnis;
  if (entwurf) {
    ergebnis = await prisma.salaryCertificate.update({ where: { id: entwurf.id }, data: daten });
  } else {
    const letzte = await prisma.salaryCertificate.findFirst({
      where: { employeeId: akte.id, year: params.year },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    ergebnis = await prisma.salaryCertificate.create({
      data: {
        organizationId: params.organizationId,
        employeeId: akte.id,
        year: params.year,
        version: (letzte?.version ?? 0) + 1,
        createdById: params.actorId,
        ...daten,
      },
    });
  }

  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'SalaryCertificate',
    entityId: ergebnis.id,
    summary: `Lohnausweis-Aufstellung ${params.year} für ${akte.employeeNumber} (Version ${ergebnis.version}) verdichtet`,
    ip: params.ip,
  });
  return ergebnis;
}

/** Abschliessen: PDF erzeugen, ablegen, unveränderlich machen. */
export async function finalizeSalaryCertificate(params: {
  organizationId: string;
  id: string;
  actorId: string;
  ip?: string | null;
}) {
  const ausweis = await prisma.salaryCertificate.findFirst({
    where: { id: params.id, organizationId: params.organizationId },
    include: { employee: { select: { employeeNumber: true, user: { select: { firstName: true, lastName: true } } } } },
  });
  if (!ausweis) throw new NotFoundError('Lohnausweis');
  if (ausweis.status === 'FINAL') throw new BusinessRuleError('Dieser Lohnausweis ist bereits abgeschlossen.');

  const jetzt = new Date();
  const inhalt = ausweis.fields as unknown as { felder: Feld[] };
  const bytes = await renderSalaryCertificatePdf(params.organizationId, {
    person: {
      name: `${ausweis.employee.user.firstName} ${ausweis.employee.user.lastName}`,
      employeeNumber: ausweis.employee.employeeNumber,
    },
    year: ausweis.year,
    version: ausweis.version,
    periodFrom: ausweis.periodFrom,
    periodTo: ausweis.periodTo,
    finalizedAt: jetzt,
    felder: inhalt.felder,
    quellensteuerAbgezogen: (inhalt.felder.find((f) => f.ziffer === '12')?.betrag ?? 0) > 0,
  });
  const { assetId, checksum } = await lohnPdfAblegen({
    organizationId: params.organizationId,
    path: `${params.organizationId}/payroll/certificates/${ausweis.id}.pdf`,
    filename: `Lohnausweis-Aufstellung-${ausweis.year}-${ausweis.employee.employeeNumber}-v${ausweis.version}.pdf`,
    bytes,
  });

  const treffer = await prisma.salaryCertificate.updateMany({
    where: { id: ausweis.id, status: 'DRAFT', updatedAt: ausweis.updatedAt },
    data: { status: 'FINAL', finalizedAt: jetzt, finalizedById: params.actorId, pdfFileId: assetId, pdfChecksum: checksum },
  });
  if (treffer.count === 0) throw new BusinessRuleError('Der Entwurf hat sich eben geändert — bitte neu laden.');

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'SalaryCertificate',
    entityId: ausweis.id,
    summary: `Lohnausweis-Aufstellung ${ausweis.year} (Version ${ausweis.version}) abgeschlossen`,
    ip: params.ip,
  });
  return { id: ausweis.id, status: 'FINAL' as const, pdfFileId: assetId };
}

export async function getSalaryCertificatePdf(params: {
  organizationId: string;
  id: string;
  employeeId?: string;
  actorId: string;
  ip?: string | null;
}): Promise<{ bytes: Buffer; filename: string }> {
  const ausweis = await prisma.salaryCertificate.findFirst({
    where: {
      id: params.id,
      organizationId: params.organizationId,
      status: 'FINAL',
      ...(params.employeeId ? { employeeId: params.employeeId } : {}),
    },
    include: { employee: { select: { employeeNumber: true } } },
  });
  if (!ausweis || !ausweis.pdfFileId) throw new NotFoundError('Lohnausweis');
  const bytes = await lohnPdfLesen(params.organizationId, ausweis.pdfFileId, ausweis.pdfChecksum);
  await audit.exported({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'SalaryCertificate',
    entityId: ausweis.id,
    summary: `Lohnausweis-Aufstellung ${ausweis.year} als PDF abgerufen`,
    ip: params.ip,
  });
  return {
    bytes,
    filename: `Lohnausweis-Aufstellung-${ausweis.year}-${ausweis.employee.employeeNumber}-v${ausweis.version}.pdf`,
  };
}
