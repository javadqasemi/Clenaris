import 'server-only';

import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import ExcelJS from 'exceljs';
import { AlignmentType, Document as DocxDocument, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import type { ReportCadence, ReportFormat, ReportKind } from '@prisma/client';

import { prisma, toNumber } from '@/lib/db';
import { audit } from '@/lib/audit';
import type { SessionUser } from '@/lib/auth/session';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { createSignedDownloadUrl, uploadBuffer } from '@/lib/storage';
import { sendEmail } from '@/lib/email/client';
import { escapeHtml, renderEmail } from '@/lib/email/layout';
import { formatDate } from '@/lib/utils';
import { changePct, healthStatus, riskBand } from '@/lib/bi/math';
import { formatKpiValue, HEALTH_STATUS_LABELS, OBJECTIVE_STATUS_LABELS, REPORT_KIND_LABELS, RISK_BAND_LABELS } from '@/lib/bi/labels';
import { dateOnly, periodOf, shiftPeriod, toDateOnly, zurichMidnight, type PeriodBounds } from '@/lib/bi/periods';
import type { CreateReportScheduleInput, GenerateReportInput, UpdateReportScheduleInput } from '@/lib/validation/bi-reports';
import { computeHealth, type HealthComponent } from './health.service';
import { getInsights, type Insight } from './insight.service';

const log = logger('bi-report');

/**
 * Führungsberichte.
 *
 * Die Datei bleibt liegen: ein Bericht, der bei jedem Öffnen neu gerechnet
 * wird, zeigt andere Zahlen als die Fassung, die verschickt wurde — und die
 * verschickte ist die, über die gesprochen wird. Drei Formate aus einem
 * Inhalt (`ReportContent`), damit PDF, Excel und Word nie voneinander
 * abweichen.
 */

export interface ReportRow {
  key: string;
  label: string;
  unit: string;
  direction: string;
  value: number | null;
  previous: number | null;
  changePct: number | null;
  target: number | null;
  yoyPct: number | null;
}

export interface ReportContent {
  kind: ReportKind;
  title: string;
  company: string;
  periodStart: Date;
  periodEnd: Date;
  generatedAt: Date;
  health: { score: number; status: string; topRisk: string | null; components: HealthComponent[] } | null;
  sections: { title: string; rows: ReportRow[] }[];
  objectives: { title: string; status: string; progressPct: number; owner: string | null }[];
  risks: { title: string; severity: number; band: string; owner: string | null }[];
  insights: Insight[];
}

/** Welche Kennzahlgruppen in welchen Bericht gehören. */
const KIND_GROUPS: Record<ReportKind, string[] | null> = {
  BUSINESS_PERFORMANCE: null,
  FINANCIAL: ['Finanzen'],
  MARKETING: ['Marketing', 'Vertrieb'],
  SALES: ['Vertrieb', 'Auftragslage'],
  EMPLOYEE: ['Personal'],
  CUSTOMER: ['Kundschaft'],
  QUARTERLY_REVIEW: null,
};

/** Die Periodenart, deren Snapshots einen Zeitraum am besten abdecken. */
function periodKindFor(from: Date, to: Date): 'MONTH' | 'QUARTER' | 'YEAR' {
  const days = (to.getTime() - from.getTime()) / 86_400_000;
  if (days > 300) return 'YEAR';
  if (days > 75) return 'QUARTER';
  return 'MONTH';
}

export async function buildReportContent(organizationId: string, kind: ReportKind, from: Date, to: Date): Promise<ReportContent> {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true, legalName: true } });
  const periodKind = periodKindFor(from, to);
  const groups = KIND_GROUPS[kind];

  const definitions = await prisma.kpiDefinition.findMany({
    where: { organizationId, active: true, ...(groups ? { group: { in: groups } } : {}) },
    orderBy: [{ group: 'asc' }, { sortOrder: 'asc' }],
    include: {
      snapshots: {
        where: { period: periodKind, periodStart: { gte: from, lte: to } },
        orderBy: { periodStart: 'desc' },
        take: 1,
      },
    },
  });

  // Vorperiode = derselbe Periodentyp unmittelbar davor.
  const sectionsMap = new Map<string, ReportRow[]>();
  for (const d of definitions) {
    const snap = d.snapshots[0];
    let previous: number | null = null;
    if (snap) {
      const prevBounds = shiftPeriod(periodOf(periodKind, zurichMidnight(snap.periodStart.getUTCFullYear(), snap.periodStart.getUTCMonth(), snap.periodStart.getUTCDate())), -1);
      const prevSnap = await prisma.kpiSnapshot.findUnique({
        where: { definitionId_period_periodStart: { definitionId: d.id, period: periodKind, periodStart: prevBounds.periodStart } },
      });
      previous = prevSnap ? toNumber(prevSnap.value) : null;
    }
    const value = snap ? toNumber(snap.value) : null;
    const row: ReportRow = {
      key: d.key,
      label: d.label,
      unit: d.unit,
      direction: d.direction,
      value,
      previous,
      changePct: value !== null ? changePct(value, previous) : null,
      target: snap?.targetValue !== null && snap?.targetValue !== undefined ? toNumber(snap.targetValue) : d.targetValue === null ? null : toNumber(d.targetValue),
      yoyPct: value !== null && snap?.previousYearValue !== null && snap?.previousYearValue !== undefined ? changePct(value, toNumber(snap.previousYearValue)) : null,
    };
    if (!sectionsMap.has(d.group)) sectionsMap.set(d.group, []);
    sectionsMap.get(d.group)!.push(row);
  }

  const wantsHealth = kind === 'BUSINESS_PERFORMANCE' || kind === 'QUARTERLY_REVIEW' || kind === 'FINANCIAL';
  const health = wantsHealth ? await computeHealth(organizationId) : null;

  const [objectives, risks, insights] = await Promise.all([
    kind === 'BUSINESS_PERFORMANCE' || kind === 'QUARTERLY_REVIEW'
      ? prisma.objective.findMany({
          where: { organizationId, deletedAt: null, status: { in: ['ACTIVE', 'AT_RISK', 'ACHIEVED', 'MISSED'] }, horizon: { in: ['OBJECTIVE', 'STRATEGY'] } },
          include: { owner: { select: { firstName: true, lastName: true } } },
          orderBy: [{ status: 'asc' }, { progressPct: 'asc' }],
          take: 12,
        })
      : Promise.resolve([]),
    kind === 'BUSINESS_PERFORMANCE' || kind === 'QUARTERLY_REVIEW'
      ? prisma.riskEntry.findMany({
          where: { organizationId, deletedAt: null, status: { not: 'CLOSED' } },
          include: { owner: { select: { firstName: true, lastName: true } } },
          orderBy: { severity: 'desc' },
          take: 5,
        })
      : Promise.resolve([]),
    wantsHealth ? getInsights(organizationId) : Promise.resolve([] as Insight[]),
  ]);

  const quarterLabel = periodKind === 'QUARTER' ? periodOf('QUARTER', zurichMidnight(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())).label : null;
  return {
    kind,
    title: kind === 'QUARTERLY_REVIEW' && quarterLabel ? `Quartalsrückblick ${quarterLabel}` : `${REPORT_KIND_LABELS[kind]} ${formatDate(from)} – ${formatDate(to)}`,
    company: org.legalName ?? org.name,
    periodStart: from,
    periodEnd: to,
    generatedAt: new Date(),
    health: health && health.score !== null ? { score: health.score, status: health.status!, topRisk: health.topRisk, components: health.components } : null,
    sections: [...sectionsMap.entries()].map(([title, rows]) => ({ title, rows })),
    objectives: objectives.map((o) => ({ title: o.title, status: OBJECTIVE_STATUS_LABELS[o.status] ?? o.status, progressPct: o.progressPct, owner: o.owner ? `${o.owner.firstName} ${o.owner.lastName}` : null })),
    risks: risks.map((r) => ({ title: r.title, severity: r.severity, band: RISK_BAND_LABELS[riskBand(r.severity)], owner: r.owner ? `${r.owner.firstName} ${r.owner.lastName}` : null })),
    insights,
  };
}

// ---------------------------------------------------------------------------
//  Formate
// ---------------------------------------------------------------------------

async function renderPdf(content: ReportContent): Promise<Buffer> {
  const { BiReportDocument } = await import('@/lib/pdf/bi-report');
  return renderToBuffer(React.createElement(BiReportDocument, { content }) as never);
}

async function renderXlsx(content: ReportContent): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = content.company;
  workbook.created = content.generatedAt;

  const sheet = workbook.addWorksheet('Kennzahlen');
  sheet.columns = [
    { header: 'Bereich', key: 'group', width: 18 },
    { header: 'Kennzahl', key: 'label', width: 32 },
    { header: 'Wert', key: 'value', width: 14 },
    { header: 'Vorperiode', key: 'previous', width: 14 },
    { header: 'Δ %', key: 'change', width: 10 },
    { header: 'Ziel', key: 'target', width: 14 },
    { header: 'Vorjahr Δ %', key: 'yoy', width: 12 },
    { header: 'Einheit', key: 'unit', width: 10 },
  ];
  for (const section of content.sections) {
    for (const row of section.rows) {
      sheet.addRow({ group: section.title, label: row.label, value: row.value, previous: row.previous, change: row.changePct, target: row.target, yoy: row.yoyPct, unit: row.unit });
    }
  }
  ['value', 'previous', 'target'].forEach((key) => {
    sheet.getColumn(key).numFmt = '#,##0.00';
  });
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  if (content.health) {
    const h = workbook.addWorksheet('Gesundheitswert');
    h.columns = [
      { header: 'Komponente', key: 'label', width: 22 },
      { header: 'Teilnote', key: 'sub', width: 10 },
      { header: 'Gewicht', key: 'weight', width: 10 },
      { header: 'Beitrag', key: 'contribution', width: 10 },
    ];
    h.addRow({ label: 'Gesamt', sub: content.health.score, weight: '', contribution: '' }).font = { bold: true };
    for (const c of content.health.components) h.addRow({ label: c.label, sub: c.subScore ?? '—', weight: c.weight, contribution: c.contribution });
    h.getRow(1).font = { bold: true };
  }

  if (content.objectives.length > 0) {
    const o = workbook.addWorksheet('Ziele');
    o.columns = [
      { header: 'Ziel', key: 'title', width: 44 },
      { header: 'Status', key: 'status', width: 14 },
      { header: 'Fortschritt %', key: 'progress', width: 14 },
      { header: 'Verantwortlich', key: 'owner', width: 24 },
    ];
    for (const row of content.objectives) o.addRow({ title: row.title, status: row.status, progress: row.progressPct, owner: row.owner ?? '' });
    o.getRow(1).font = { bold: true };
  }

  if (content.risks.length > 0) {
    const r = workbook.addWorksheet('Risiken');
    r.columns = [
      { header: 'Risiko', key: 'title', width: 44 },
      { header: 'Schwere', key: 'severity', width: 10 },
      { header: 'Stufe', key: 'band', width: 12 },
      { header: 'Verantwortlich', key: 'owner', width: 24 },
    ];
    for (const row of content.risks) r.addRow(row);
    r.getRow(1).font = { bold: true };
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function renderDocx(content: ReportContent): Promise<Buffer> {
  const cell = (text: string, bold = false, right = false) =>
    new TableCell({
      children: [new Paragraph({ alignment: right ? AlignmentType.RIGHT : AlignmentType.LEFT, children: [new TextRun({ text, bold, size: 18 })] })],
    });

  const children: (Paragraph | Table)[] = [
    new Paragraph({ text: content.company, heading: HeadingLevel.TITLE }),
    new Paragraph({ text: content.title, heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ children: [new TextRun({ text: `${formatDate(content.periodStart)} – ${formatDate(content.periodEnd)} · erstellt am ${formatDate(content.generatedAt)}`, color: '64748B' })] }),
  ];

  if (content.health) {
    children.push(new Paragraph({ text: 'Gesundheitswert', heading: HeadingLevel.HEADING_2 }));
    children.push(new Paragraph({ children: [new TextRun({ text: `${content.health.score} von 100 — ${HEALTH_STATUS_LABELS[content.health.status] ?? content.health.status}`, bold: true })] }));
    if (content.health.topRisk) children.push(new Paragraph({ text: `Grösster Hebel: ${content.health.topRisk}` }));
    for (const c of content.health.components) {
      children.push(new Paragraph({ text: `${c.label}: ${c.subScore === null ? '—' : `${c.subScore} Punkte`} (Gewicht ${c.weight})`, bullet: { level: 0 } }));
    }
  }

  for (const section of content.sections) {
    children.push(new Paragraph({ text: section.title, heading: HeadingLevel.HEADING_2 }));
    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ tableHeader: true, children: [cell('Kennzahl', true), cell('Wert', true, true), cell('Vorperiode', true, true), cell('Δ', true, true), cell('Ziel', true, true)] }),
          ...section.rows.map(
            (row) =>
              new TableRow({
                children: [
                  cell(row.label),
                  cell(formatKpiValue(row.value, row.unit), true, true),
                  cell(formatKpiValue(row.previous, row.unit), false, true),
                  cell(row.changePct === null ? '—' : `${row.changePct > 0 ? '+' : ''}${row.changePct.toFixed(1)} %`, false, true),
                  cell(formatKpiValue(row.target, row.unit), false, true),
                ],
              }),
          ),
        ],
      }),
    );
  }

  if (content.objectives.length > 0) {
    children.push(new Paragraph({ text: 'Ziele', heading: HeadingLevel.HEADING_2 }));
    for (const o of content.objectives) children.push(new Paragraph({ text: `${o.title} — ${o.progressPct} % (${o.status})${o.owner ? `, ${o.owner}` : ''}`, bullet: { level: 0 } }));
  }
  if (content.risks.length > 0) {
    children.push(new Paragraph({ text: 'Grösste Risiken', heading: HeadingLevel.HEADING_2 }));
    for (const r of content.risks) children.push(new Paragraph({ text: `${r.title} — Schwere ${r.severity} (${r.band})${r.owner ? `, ${r.owner}` : ''}`, bullet: { level: 0 } }));
  }
  if (content.insights.length > 0) {
    children.push(new Paragraph({ text: 'Auffälligkeiten', heading: HeadingLevel.HEADING_2 }));
    for (const i of content.insights) children.push(new Paragraph({ text: `${i.title}. ${i.detail}`, bullet: { level: 0 } }));
  }

  const doc = new DocxDocument({ creator: content.company, title: content.title, sections: [{ children }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

const MIME: Record<ReportFormat, string> = {
  PDF: 'application/pdf',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

async function renderReport(content: ReportContent, format: ReportFormat): Promise<Buffer> {
  switch (format) {
    case 'PDF':
      return renderPdf(content);
    case 'XLSX':
      return renderXlsx(content);
    case 'DOCX':
      return renderDocx(content);
  }
}

// ---------------------------------------------------------------------------
//  Läufe
// ---------------------------------------------------------------------------

/**
 * Bericht erzeugen und ablegen. Der Lauf wird zuerst als `PENDING`
 * geschrieben, damit ein Absturz mitten im Rendern sichtbar bleibt und nicht
 * wie „nie angefordert" aussieht.
 */
export async function generateReport(params: {
  organizationId: string;
  actorId: string | null;
  scheduleId?: string | null;
  kind: ReportKind;
  format: ReportFormat;
  periodStart: Date;
  periodEnd: Date;
}) {
  const run = await prisma.reportRun.create({
    data: {
      organizationId: params.organizationId,
      scheduleId: params.scheduleId ?? null,
      kind: params.kind,
      format: params.format,
      periodStart: params.periodStart,
      periodEnd: params.periodEnd,
      createdById: params.actorId,
    },
  });
  try {
    const content = await buildReportContent(params.organizationId, params.kind, params.periodStart, params.periodEnd);
    const buffer = await renderReport(content, params.format);
    const ext = params.format.toLowerCase();
    const filename = `${REPORT_KIND_LABELS[params.kind].replace(/\s+/g, '-')}_${params.periodStart.toISOString().slice(0, 10)}_${params.periodEnd.toISOString().slice(0, 10)}.${ext}`;
    const path = `${params.organizationId}/reports/${run.id}/${filename}`;
    const stored = await uploadBuffer({ organizationId: params.organizationId, path, content: buffer, contentType: MIME[params.format], upsert: true });
    const file = await prisma.fileAsset.create({
      data: {
        organizationId: params.organizationId,
        path: stored.path,
        url: stored.publicUrl,
        filename,
        mimeType: MIME[params.format],
        sizeBytes: buffer.byteLength,
        scope: 'REPORT',
        isPublic: false,
        uploadedById: params.actorId,
      },
    });
    const finished = await prisma.reportRun.update({
      where: { id: run.id },
      data: { fileAssetId: file.id, status: 'READY', finishedAt: new Date() },
      include: { file: { select: { id: true, filename: true, sizeBytes: true } } },
    });
    return { run: finished, buffer, filename, content };
  } catch (error) {
    log.error('Bericht fehlgeschlagen', { runId: run.id, error });
    await prisma.reportRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', error: error instanceof Error ? error.message.slice(0, 500) : String(error), finishedAt: new Date() },
    });
    throw error;
  }
}

export async function generateReportForUser(session: SessionUser, organizationId: string, input: GenerateReportInput) {
  const { run } = await generateReport({
    organizationId,
    actorId: session.id,
    kind: input.kind,
    format: input.format,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
  });
  await audit.exported({ organizationId, userId: session.id, entity: 'ReportRun', entityId: run.id, summary: `Bericht ${REPORT_KIND_LABELS[input.kind]} (${input.format}) erzeugt` });
  return run;
}

export async function listReportRuns(organizationId: string, filter: { kind?: string; limit: number }) {
  return prisma.reportRun.findMany({
    where: { organizationId, ...(filter.kind ? { kind: filter.kind as ReportKind } : {}) },
    include: { file: { select: { id: true, filename: true, sizeBytes: true } }, schedule: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
    take: filter.limit,
  });
}

export async function resolveReportDownload(session: SessionUser, organizationId: string, id: string, ip?: string | null) {
  const run = await prisma.reportRun.findFirst({ where: { id, organizationId }, include: { file: true } });
  if (!run) throw new NotFoundError('Bericht');
  if (run.status !== 'READY' || !run.file) throw new BusinessRuleError('Dieser Bericht ist nicht bereit — er ist fehlgeschlagen oder wird noch erzeugt.');
  const url = await createSignedDownloadUrl(run.file.path, 600);
  await audit.exported({ organizationId, userId: session.id, entity: 'ReportRun', entityId: id, summary: `Bericht „${run.file.filename}" heruntergeladen`, ip });
  return { url, filename: run.file.filename, mimeType: run.file.mimeType };
}

// ---------------------------------------------------------------------------
//  Zeitpläne
// ---------------------------------------------------------------------------

/** Der nächste Zeitpunkt, an dem ein Zeitplan läuft, strikt nach `after`. */
export function nextRunAfter(cadence: ReportCadence, runOnDay: number, after: Date): Date {
  const a = toDateOnly(after);
  const y = a.getUTCFullYear();
  const m = a.getUTCMonth();
  const d = a.getUTCDate();
  // Um 06:00 Uhr Zürcher Zeit — nach dem Nachtlauf, vor dem Arbeitsbeginn.
  const at = (yy: number, mm: number, dd: number) => new Date(zurichMidnight(yy, mm, dd).getTime() + 6 * 3_600_000);

  switch (cadence) {
    case 'WEEKLY': {
      const weekday = (new Date(Date.UTC(y, m, d)).getUTCDay() + 6) % 7; // 0 = Montag
      const target = runOnDay - 1;
      let delta = (target - weekday + 7) % 7;
      if (delta === 0) delta = 7;
      return at(y, m, d + delta);
    }
    case 'MONTHLY': {
      const thisMonth = dateOnly(y, m, Math.min(runOnDay, 28));
      return thisMonth > a ? at(y, m, runOnDay) : at(y, m + 1, runOnDay);
    }
    case 'QUARTERLY': {
      const q0 = Math.floor(m / 3) * 3;
      const thisQuarter = dateOnly(y, q0, runOnDay);
      return thisQuarter > a ? at(y, q0, runOnDay) : at(y, q0 + 3, runOnDay);
    }
    case 'YEARLY': {
      const thisYear = dateOnly(y, 0, runOnDay);
      return thisYear > a ? at(y, 0, runOnDay) : at(y + 1, 0, runOnDay);
    }
  }
}

/** Der Zeitraum, den ein fälliger Lauf abdeckt: die abgeschlossene Periode davor. */
function periodForRun(cadence: ReportCadence, at: Date): PeriodBounds {
  const kind = cadence === 'WEEKLY' ? 'WEEK' : cadence === 'MONTHLY' ? 'MONTH' : cadence === 'QUARTERLY' ? 'QUARTER' : 'YEAR';
  return shiftPeriod(periodOf(kind, at), -1);
}

export async function listReportSchedules(organizationId: string) {
  return prisma.reportSchedule.findMany({
    where: { organizationId },
    include: { _count: { select: { runs: true } }, runs: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true, createdAt: true } } },
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
  });
}

export async function createReportSchedule(session: SessionUser, organizationId: string, input: CreateReportScheduleInput) {
  const schedule = await prisma.reportSchedule.create({
    data: {
      organizationId,
      name: input.name,
      kind: input.kind,
      cadence: input.cadence,
      format: input.format,
      runOnDay: input.runOnDay,
      recipients: input.recipients,
      active: input.active,
      nextRunAt: input.active ? nextRunAfter(input.cadence, input.runOnDay, new Date()) : null,
    },
  });
  await audit.created({ organizationId, userId: session.id, entity: 'ReportSchedule', entityId: schedule.id, summary: `Berichtszeitplan „${schedule.name}" angelegt` });
  return schedule;
}

export async function updateReportSchedule(session: SessionUser, organizationId: string, id: string, input: UpdateReportScheduleInput) {
  const before = await prisma.reportSchedule.findFirst({ where: { id, organizationId } });
  if (!before) throw new NotFoundError('Berichtszeitplan');
  const cadence = input.cadence ?? before.cadence;
  const runOnDay = input.runOnDay ?? before.runOnDay;
  const active = input.active ?? before.active;
  const schedule = await prisma.reportSchedule.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.format !== undefined ? { format: input.format } : {}),
      ...(input.recipients !== undefined ? { recipients: input.recipients } : {}),
      cadence,
      runOnDay,
      active,
      nextRunAt: active ? nextRunAfter(cadence, runOnDay, new Date()) : null,
    },
  });
  await audit.updated({ organizationId, userId: session.id, entity: 'ReportSchedule', entityId: id, summary: `Berichtszeitplan „${schedule.name}" geändert`, changes: input });
  return schedule;
}

export async function deleteReportSchedule(session: SessionUser, organizationId: string, id: string) {
  const schedule = await prisma.reportSchedule.findFirst({ where: { id, organizationId } });
  if (!schedule) throw new NotFoundError('Berichtszeitplan');
  await prisma.reportSchedule.delete({ where: { id } });
  await audit.deleted({ organizationId, userId: session.id, entity: 'ReportSchedule', entityId: id, summary: `Berichtszeitplan „${schedule.name}" gelöscht` });
}

/** Nachtlauf: fällige Zeitpläne ausführen und verschicken. */
export async function runDueReportSchedules(organizationId: string, now = new Date()): Promise<{ ran: number; failed: number }> {
  const due = await prisma.reportSchedule.findMany({ where: { organizationId, active: true, nextRunAt: { lte: now } } });
  let ran = 0;
  let failed = 0;
  for (const schedule of due) {
    const period = periodForRun(schedule.cadence, now);
    try {
      const { buffer, filename, content } = await generateReport({
        organizationId,
        actorId: null,
        scheduleId: schedule.id,
        kind: schedule.kind,
        format: schedule.format,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
      });
      if (schedule.recipients.length > 0) {
        const body = `
          <p>Guten Tag</p>
          <p>Im Anhang finden Sie den Bericht <strong>${escapeHtml(content.title)}</strong> für den Zeitraum ${escapeHtml(period.label)}.</p>
          ${content.health ? `<p>Gesundheitswert: <strong>${content.health.score} von 100</strong> (${escapeHtml(HEALTH_STATUS_LABELS[content.health.status] ?? '')}).${content.health.topRisk ? ` Grösster Hebel: ${escapeHtml(content.health.topRisk)}` : ''}</p>` : ''}
          <p style="color:#64748B;font-size:13px;">Dieser Bericht wurde automatisch erzeugt. Die Zahlen entsprechen dem Stand vom ${escapeHtml(formatDate(content.generatedAt))}.</p>`;
        await sendEmail({
          to: schedule.recipients,
          subject: `${content.title} — ${content.company}`,
          html: renderEmail(content.title, body, { preheader: `Führungsbericht ${period.label}` }),
          attachments: [{ filename, content: buffer }],
          entity: 'ReportSchedule',
          entityId: schedule.id,
        });
      }
      ran += 1;
    } catch (error) {
      failed += 1;
      log.error('Zeitplan fehlgeschlagen', { scheduleId: schedule.id, error });
    } finally {
      await prisma.reportSchedule.update({
        where: { id: schedule.id },
        data: { lastRunAt: now, nextRunAt: nextRunAfter(schedule.cadence, schedule.runOnDay, now) },
      });
    }
  }
  return { ran, failed };
}

export function healthLabel(score: number): string {
  return HEALTH_STATUS_LABELS[healthStatus(score)];
}
