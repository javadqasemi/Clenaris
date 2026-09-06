import 'server-only';

import ExcelJS from 'exceljs';

import { prisma, toNumber } from '@/lib/db';
import { round2 } from '@/lib/utils';
import { audit } from '@/lib/audit';
import type { AccountingExportInput } from '@/lib/validation/finance';

/**
 * Datenexporte für Buchhaltung und Auswertungen.
 *
 * Architekturentscheid: Exporte werden synchron erzeugt und als Stream
 * ausgeliefert, nicht in Storage abgelegt. Bei KMU-Datenmengen (wenige tausend
 * Zeilen) bleibt das unter einer Sekunde, und es entstehen keine verwaisten
 * Dateien mit Finanzdaten. Für die Nachvollziehbarkeit wird jeder Export im
 * Audit-Log und in `accounting_exports` festgehalten.
 *
 * Formate:
 *  • `csv`     — generisch, semikolongetrennt (Excel-CH-Standard)
 *  • `bexio`   — Spaltenschema des Schweizer Cloud-Buchhaltungsanbieters
 *  • `banana`  — Banana Buchhaltung (verbreitet bei Schweizer Treuhändern)
 *  • `abacus`  — vereinfachtes Buchungssatz-Format
 *  • `datev`   — für Kunden mit deutschem Mutterhaus
 */

const BRAND = { header: 'FF0B7285', headerText: 'FFFFFFFF', zebra: 'FFF8FAFC' };

function styleHeader(sheet: ExcelJS.Worksheet) {
  const row = sheet.getRow(1);
  row.font = { bold: true, color: { argb: BRAND.headerText }, size: 11 };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.header } };
  row.alignment = { vertical: 'middle' };
  row.height = 22;
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

function autoFilterAndZebra(sheet: ExcelJS.Worksheet) {
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: sheet.columnCount },
  };
  sheet.eachRow((row, index) => {
    if (index > 1 && index % 2 === 0) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.zebra } };
    }
  });
}

// ---------------------------------------------------------------------------
//  Excel-Exporte
// ---------------------------------------------------------------------------

export async function exportInvoicesXlsx(params: {
  organizationId: string;
  from: Date;
  to: Date;
  actorId: string;
}): Promise<{ buffer: Buffer; filename: string }> {
  const invoices = await prisma.invoice.findMany({
    where: {
      organizationId: params.organizationId,
      deletedAt: null,
      issueDate: { gte: params.from, lte: params.to },
    },
    orderBy: { issueDate: 'asc' },
    include: {
      customer: { select: { number: true } },
      payments: { where: { status: 'SUCCEEDED' } },
    },
  });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Clenaris';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Rechnungen', {
    pageSetup: { orientation: 'landscape', fitToPage: true },
  });

  sheet.columns = [
    { header: 'Nummer', key: 'number', width: 16 },
    { header: 'Datum', key: 'issueDate', width: 12 },
    { header: 'Fällig', key: 'dueDate', width: 12 },
    { header: 'Kundennr.', key: 'customerNumber', width: 14 },
    { header: 'Kunde', key: 'customer', width: 32 },
    { header: 'Status', key: 'status', width: 16 },
    { header: 'Netto', key: 'net', width: 14 },
    { header: 'MWST', key: 'vat', width: 12 },
    { header: 'Brutto', key: 'gross', width: 14 },
    { header: 'Bezahlt', key: 'paid', width: 14 },
    { header: 'Offen', key: 'balance', width: 14 },
    { header: 'Zahlungsdatum', key: 'paidAt', width: 16 },
    { header: 'Mahnstufe', key: 'reminderLevel', width: 12 },
  ];

  for (const invoice of invoices) {
    sheet.addRow({
      number: invoice.number,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      customerNumber: invoice.customer.number,
      customer: invoice.billToCompany ?? invoice.billToName,
      status: STATUS_LABELS[invoice.status] ?? invoice.status,
      net: toNumber(invoice.netTotal),
      vat: toNumber(invoice.vatAmount),
      gross: toNumber(invoice.grossTotal),
      paid: toNumber(invoice.paidAmount),
      balance: toNumber(invoice.balance),
      paidAt: invoice.paidAt,
      reminderLevel: invoice.reminderLevel,
    });
  }

  ['net', 'vat', 'gross', 'paid', 'balance'].forEach((key) => {
    sheet.getColumn(key).numFmt = '#,##0.00';
    sheet.getColumn(key).alignment = { horizontal: 'right' };
  });
  ['issueDate', 'dueDate', 'paidAt'].forEach((key) => {
    sheet.getColumn(key).numFmt = 'dd.mm.yyyy';
  });

  // Summenzeile.
  const totalRow = sheet.addRow({
    customer: 'Total',
    net: invoices.reduce((sum, i) => sum + toNumber(i.netTotal), 0),
    vat: invoices.reduce((sum, i) => sum + toNumber(i.vatAmount), 0),
    gross: invoices.reduce((sum, i) => sum + toNumber(i.grossTotal), 0),
    paid: invoices.reduce((sum, i) => sum + toNumber(i.paidAmount), 0),
    balance: invoices.reduce((sum, i) => sum + toNumber(i.balance), 0),
  });
  totalRow.font = { bold: true };
  totalRow.border = { top: { style: 'double' } };

  styleHeader(sheet);
  autoFilterAndZebra(sheet);

  await audit.exported({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Invoice',
    summary: `${invoices.length} Rechnungen als Excel exportiert`,
  });

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return {
    buffer,
    filename: `Rechnungen_${formatFileDate(params.from)}_${formatFileDate(params.to)}.xlsx`,
  };
}

export async function exportCustomersXlsx(params: {
  organizationId: string;
  actorId: string;
}): Promise<{ buffer: Buffer; filename: string }> {
  const customers = await prisma.customer.findMany({
    where: { organizationId: params.organizationId, deletedAt: null },
    orderBy: { number: 'asc' },
    include: { addresses: { where: { isDefault: true }, take: 1 } },
  });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Clenaris';
  const sheet = workbook.addWorksheet('Kunden');

  sheet.columns = [
    { header: 'Kundennr.', key: 'number', width: 14 },
    { header: 'Typ', key: 'type', width: 12 },
    { header: 'Firma', key: 'company', width: 30 },
    { header: 'Vorname', key: 'firstName', width: 18 },
    { header: 'Nachname', key: 'lastName', width: 18 },
    { header: 'E-Mail', key: 'email', width: 32 },
    { header: 'Telefon', key: 'phone', width: 18 },
    { header: 'Strasse', key: 'street', width: 28 },
    { header: 'PLZ', key: 'zip', width: 8 },
    { header: 'Ort', key: 'city', width: 20 },
    { header: 'Sprache', key: 'language', width: 10 },
    { header: 'Buchungen', key: 'bookings', width: 12 },
    { header: 'Umsatz total', key: 'ltv', width: 16 },
    { header: 'Letzte Buchung', key: 'lastBooking', width: 16 },
    { header: 'Kunde seit', key: 'createdAt', width: 14 },
  ];

  for (const customer of customers) {
    const address = customer.addresses[0];
    sheet.addRow({
      number: customer.number,
      type: customer.type === 'BUSINESS' ? 'Geschäft' : 'Privat',
      company: customer.companyName ?? '',
      firstName: customer.firstName,
      lastName: customer.lastName,
      email: customer.email,
      phone: customer.phone ?? customer.mobile ?? '',
      street: address ? `${address.street} ${address.streetNo ?? ''}`.trim() : '',
      zip: address?.postalCode ?? '',
      city: address?.city ?? '',
      language: customer.language,
      bookings: customer.totalBookings,
      ltv: toNumber(customer.lifetimeValue),
      lastBooking: customer.lastBookingAt,
      createdAt: customer.createdAt,
    });
  }

  sheet.getColumn('ltv').numFmt = '#,##0.00';
  sheet.getColumn('lastBooking').numFmt = 'dd.mm.yyyy';
  sheet.getColumn('createdAt').numFmt = 'dd.mm.yyyy';

  styleHeader(sheet);
  autoFilterAndZebra(sheet);

  await audit.exported({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Customer',
    summary: `${customers.length} Kundendatensätze exportiert`,
  });

  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    filename: `Kunden_${formatFileDate(new Date())}.xlsx`,
  };
}

export async function exportTimesheetsXlsx(params: {
  organizationId: string;
  from: Date;
  to: Date;
  actorId: string;
}): Promise<{ buffer: Buffer; filename: string }> {
  const entries = await prisma.timeEntry.findMany({
    where: {
      employee: { organizationId: params.organizationId },
      startedAt: { gte: params.from, lte: params.to },
      endedAt: { not: null },
    },
    orderBy: [{ employeeId: 'asc' }, { startedAt: 'asc' }],
    include: {
      employee: {
        select: {
          employeeNumber: true,
          user: { select: { firstName: true, lastName: true } },
        },
      },
      job: { select: { number: true, title: true } },
    },
  });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Clenaris';

  // Blatt 1: Einzelbuchungen
  const detail = workbook.addWorksheet('Zeiterfassung');
  detail.columns = [
    { header: 'Mitarbeiter-Nr.', key: 'employeeNumber', width: 16 },
    { header: 'Name', key: 'name', width: 26 },
    { header: 'Datum', key: 'date', width: 12 },
    { header: 'Von', key: 'from', width: 10 },
    { header: 'Bis', key: 'to', width: 10 },
    { header: 'Pause (Min.)', key: 'break', width: 14 },
    { header: 'Dauer (Std.)', key: 'hours', width: 14 },
    { header: 'Auftrag', key: 'job', width: 18 },
    { header: 'Bezeichnung', key: 'title', width: 34 },
    { header: 'Freigegeben', key: 'approved', width: 14 },
  ];

  for (const entry of entries) {
    detail.addRow({
      employeeNumber: entry.employee.employeeNumber,
      name: `${entry.employee.user.firstName} ${entry.employee.user.lastName}`,
      date: entry.startedAt,
      from: entry.startedAt,
      to: entry.endedAt,
      break: entry.breakMin,
      hours: round2(entry.minutes / 60),
      job: entry.job?.number ?? '',
      title: entry.job?.title ?? '',
      approved: entry.approved ? 'Ja' : 'Nein',
    });
  }

  detail.getColumn('date').numFmt = 'dd.mm.yyyy';
  detail.getColumn('from').numFmt = 'hh:mm';
  detail.getColumn('to').numFmt = 'hh:mm';
  detail.getColumn('hours').numFmt = '#,##0.00';
  styleHeader(detail);
  autoFilterAndZebra(detail);

  // Blatt 2: Monatssummen pro Person
  const summary = workbook.addWorksheet('Zusammenzug');
  summary.columns = [
    { header: 'Mitarbeiter-Nr.', key: 'employeeNumber', width: 16 },
    { header: 'Name', key: 'name', width: 26 },
    { header: 'Einsätze', key: 'jobs', width: 12 },
    { header: 'Stunden', key: 'hours', width: 14 },
  ];

  const grouped = new Map<string, { name: string; jobs: Set<string>; minutes: number }>();
  for (const entry of entries) {
    const key = entry.employee.employeeNumber;
    if (!grouped.has(key)) {
      grouped.set(key, {
        name: `${entry.employee.user.firstName} ${entry.employee.user.lastName}`,
        jobs: new Set(),
        minutes: 0,
      });
    }
    const row = grouped.get(key)!;
    row.minutes += entry.minutes;
    if (entry.jobId) row.jobs.add(entry.jobId);
  }

  for (const [employeeNumber, row] of grouped) {
    summary.addRow({
      employeeNumber,
      name: row.name,
      jobs: row.jobs.size,
      hours: round2(row.minutes / 60),
    });
  }
  summary.getColumn('hours').numFmt = '#,##0.00';
  styleHeader(summary);

  await audit.exported({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'TimeEntry',
    summary: `Zeiterfassung ${formatFileDate(params.from)}–${formatFileDate(params.to)} exportiert`,
  });

  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    filename: `Zeiterfassung_${formatFileDate(params.from)}_${formatFileDate(params.to)}.xlsx`,
  };
}

// ---------------------------------------------------------------------------
//  Buchhaltungsexport (CSV)
// ---------------------------------------------------------------------------

/** Schweizer KMU-Kontenrahmen (vereinfacht). */
const ACCOUNTS = {
  revenue: '3000', // Dienstleistungsertrag
  vatOwed: '2200', // Geschuldete MWST
  vatPaid: '1170', // Vorsteuer
  receivables: '1100', // Forderungen aus Lieferungen und Leistungen
  bank: '1020',
  cash: '1000',
  expenseByCategory: {
    MATERIAL: '4000',
    EQUIPMENT: '6500',
    VEHICLE: '6200',
    FUEL: '6210',
    INSURANCE: '6300',
    RENT: '6000',
    SALARY: '5000',
    SOCIAL_SECURITY: '5700',
    MARKETING: '6600',
    SOFTWARE: '6570',
    TRAINING: '5820',
    TAXES: '8900',
    OTHER: '6900',
  } as Record<string, string>,
};

export async function exportAccounting(params: {
  organizationId: string;
  input: AccountingExportInput;
  actorId: string;
}): Promise<{ content: string; filename: string; rowCount: number }> {
  const { from, to } = { from: params.input.periodFrom, to: params.input.periodTo };
  const rows: string[][] = [];

  const header =
    params.input.format === 'datev'
      ? ['Umsatz', 'Soll/Haben', 'Konto', 'Gegenkonto', 'Belegdatum', 'Belegfeld1', 'Buchungstext']
      : ['Datum', 'Beleg', 'Text', 'Soll', 'Haben', 'Betrag', 'MWST-Code', 'MWST-Betrag'];

  if (params.input.include.includes('invoices')) {
    const invoices = await prisma.invoice.findMany({
      where: {
        organizationId: params.organizationId,
        deletedAt: null,
        status: { notIn: ['DRAFT', 'CANCELLED'] },
        issueDate: { gte: from, lte: to },
      },
      orderBy: { issueDate: 'asc' },
      include: { customer: { select: { number: true } } },
    });

    for (const invoice of invoices) {
      const text = `Rechnung ${invoice.number} ${invoice.billToCompany ?? invoice.billToName}`.slice(0, 60);

      if (params.input.format === 'datev') {
        rows.push([
          formatAmount(toNumber(invoice.grossTotal)),
          'S',
          ACCOUNTS.receivables,
          ACCOUNTS.revenue,
          formatDateShort(invoice.issueDate),
          invoice.number,
          text,
        ]);
      } else {
        rows.push([
          formatDateCh(invoice.issueDate),
          invoice.number,
          text,
          ACCOUNTS.receivables,
          ACCOUNTS.revenue,
          formatAmount(toNumber(invoice.netTotal)),
          'UN81',
          formatAmount(toNumber(invoice.vatAmount)),
        ]);
        if (toNumber(invoice.vatAmount) > 0) {
          rows.push([
            formatDateCh(invoice.issueDate),
            invoice.number,
            `MWST ${text}`,
            ACCOUNTS.receivables,
            ACCOUNTS.vatOwed,
            formatAmount(toNumber(invoice.vatAmount)),
            '',
            '',
          ]);
        }
      }
    }
  }

  if (params.input.include.includes('payments')) {
    const payments = await prisma.payment.findMany({
      where: {
        status: 'SUCCEEDED',
        paidAt: { gte: from, lte: to },
        invoice: { organizationId: params.organizationId },
      },
      orderBy: { paidAt: 'asc' },
      include: { invoice: { select: { number: true } } },
    });

    for (const payment of payments) {
      const account = payment.method === 'CASH' ? ACCOUNTS.cash : ACCOUNTS.bank;
      const text = `Zahlung ${payment.invoice?.number ?? ''} (${payment.method})`.slice(0, 60);

      if (params.input.format === 'datev') {
        rows.push([
          formatAmount(toNumber(payment.amount)),
          'S',
          account,
          ACCOUNTS.receivables,
          formatDateShort(payment.paidAt ?? payment.createdAt),
          payment.invoice?.number ?? '',
          text,
        ]);
      } else {
        rows.push([
          formatDateCh(payment.paidAt ?? payment.createdAt),
          payment.invoice?.number ?? '',
          text,
          account,
          ACCOUNTS.receivables,
          formatAmount(toNumber(payment.amount)),
          '',
          '',
        ]);
      }
    }
  }

  if (params.input.include.includes('expenses')) {
    const expenses = await prisma.expense.findMany({
      where: {
        organizationId: params.organizationId,
        expenseDate: { gte: from, lte: to },
      },
      orderBy: { expenseDate: 'asc' },
      include: { supplier: { select: { name: true } } },
    });

    for (const expense of expenses) {
      const account = ACCOUNTS.expenseByCategory[expense.category] ?? ACCOUNTS.expenseByCategory.OTHER;
      const text = `${expense.description}${expense.supplier ? ` (${expense.supplier.name})` : ''}`.slice(0, 60);

      if (params.input.format === 'datev') {
        rows.push([
          formatAmount(toNumber(expense.grossAmount)),
          'S',
          account,
          ACCOUNTS.bank,
          formatDateShort(expense.expenseDate),
          expense.reference ?? '',
          text,
        ]);
      } else {
        rows.push([
          formatDateCh(expense.expenseDate),
          expense.reference ?? '',
          text,
          account,
          ACCOUNTS.bank,
          formatAmount(toNumber(expense.netAmount)),
          expense.vatDeductible ? 'VM81' : '',
          formatAmount(toNumber(expense.vatAmount)),
        ]);
      }
    }
  }

  if (params.input.include.includes('credit_notes')) {
    const notes = await prisma.creditNote.findMany({
      where: {
        organizationId: params.organizationId,
        issueDate: { gte: from, lte: to },
      },
      orderBy: { issueDate: 'asc' },
    });

    for (const note of notes) {
      rows.push([
        formatDateCh(note.issueDate),
        note.number,
        `Gutschrift ${note.number}`,
        ACCOUNTS.revenue,
        ACCOUNTS.receivables,
        formatAmount(toNumber(note.netTotal)),
        'UN81',
        formatAmount(toNumber(note.vatAmount)),
      ]);
    }
  }

  // Semikolon als Trennzeichen: Excel-CH erwartet das bei Dezimalpunkt-Zahlen.
  const separator = params.input.format === 'datev' ? ';' : ';';
  const content = [header, ...rows]
    .map((row) => row.map(escapeCsv).join(separator))
    .join('\r\n');

  await prisma.accountingExport.create({
    data: {
      organizationId: params.organizationId,
      format: params.input.format,
      periodFrom: from,
      periodTo: to,
      rowCount: rows.length,
      createdById: params.actorId,
    },
  });

  await audit.exported({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'AccountingExport',
    summary: `Buchhaltungsexport (${params.input.format}) mit ${rows.length} Buchungen`,
  });

  return {
    // BOM voranstellen, damit Excel UTF-8 korrekt erkennt.
    content: `﻿${content}`,
    filename: `Buchhaltung_${params.input.format}_${formatFileDate(from)}_${formatFileDate(to)}.csv`,
    rowCount: rows.length,
  };
}

// ---------------------------------------------------------------------------
//  Hilfsfunktionen
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Entwurf',
  ISSUED: 'Ausgestellt',
  SENT: 'Versendet',
  PARTIALLY_PAID: 'Teilbezahlt',
  PAID: 'Bezahlt',
  OVERDUE: 'Überfällig',
  CANCELLED: 'Storniert',
  WRITTEN_OFF: 'Abgeschrieben',
};

function escapeCsv(value: string): string {
  if (/[";\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function formatAmount(value: number): string {
  return value.toFixed(2);
}

function formatDateCh(date: Date): string {
  return new Intl.DateTimeFormat('de-CH', {
    timeZone: 'Europe/Zurich',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

/** DATEV erwartet TTMM. */
function formatDateShort(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}${month}`;
}

function formatFileDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
