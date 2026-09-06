import 'server-only';

import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';

import { prisma, toNumber } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { hasIntegration } from '@/lib/env';
import { uploadBuffer } from '@/lib/storage/supabase';
import {
  CreditNoteDocument,
  InvoiceDocument,
  JobReportDocument,
  QuoteDocument,
  type PdfCompany,
  type PdfLineItem,
  type PdfRecipient,
  type QrSlipData,
} from './documents';
import { isQrIban, renderQrCode, splitStreet } from './swiss-qr';
import { logger } from '@/lib/logger';

const log = logger('pdf');

/**
 * Erzeugt PDF-Dokumente aus Datenbankobjekten.
 *
 * Architekturentscheid: Die Renderfunktionen laden ihre Daten selbst. So gibt es
 * genau eine Stelle, die weiss, welche Relationen ein Dokument braucht — Route
 * Handler, Cron-Jobs und der E-Mail-Versand rufen dieselbe Funktion auf und
 * können nicht versehentlich mit unvollständigen Daten rendern.
 *
 * Erzeugte PDFs werden in Supabase Storage abgelegt und die URL am Datensatz
 * gespeichert. Ist Storage nicht konfiguriert, wird der Buffer direkt
 * zurückgegeben (Download funktioniert, nur ohne Persistenz).
 */

/**
 * Hinweis zum `as never` an den `renderToBuffer`-Aufrufen: die Funktion ist auf
 * `ReactElement<DocumentProps>` typisiert. Unsere Dokumentkomponenten
 * deklarieren eigene Props und geben intern ein `<Document>` zurück — zur
 * Laufzeit korrekt, für TypeScript aber nicht ableitbar.
 */

async function loadCompany(organizationId: string): Promise<PdfCompany> {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
  });

  return {
    name: org.legalName ?? org.name,
    street: [org.street, org.streetNo].filter(Boolean).join(' '),
    postalCode: org.postalCode,
    city: org.city,
    country: org.country,
    phone: org.phone ?? '',
    email: org.email,
    website: org.website,
    vatNumber: org.vatNumber,
    iban: org.qrIban ?? org.iban,
    bankName: org.bankName,
    logoUrl: org.logoUrl,
  };
}

function recipientFromInvoice(invoice: {
  billToName: string;
  billToCompany: string | null;
  billToStreet: string;
  billToZip: string;
  billToCity: string;
  billToCountry: string;
  billToVat: string | null;
}): PdfRecipient {
  return {
    name: invoice.billToName,
    company: invoice.billToCompany,
    street: invoice.billToStreet,
    postalCode: invoice.billToZip,
    city: invoice.billToCity,
    country: invoice.billToCountry,
    vatNumber: invoice.billToVat,
  };
}

/** Dominanter MWST-Satz eines Dokuments — für die Totalzeile. */
function dominantVatRate(items: { vatRate: number; net: number }[]): number {
  if (items.length === 0) return 8.1;
  const byRate = new Map<number, number>();
  for (const item of items) {
    byRate.set(item.vatRate, (byRate.get(item.vatRate) ?? 0) + item.net);
  }
  return [...byRate.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// ---------------------------------------------------------------------------
//  Rechnung
// ---------------------------------------------------------------------------

export async function renderInvoicePdf(invoiceId: string): Promise<{
  buffer: Buffer;
  filename: string;
  url: string | null;
}> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { items: { orderBy: { position: 'asc' } } },
  });
  if (!invoice) throw new NotFoundError('Rechnung');

  const company = await loadCompany(invoice.organizationId);

  const items: PdfLineItem[] = invoice.items.map((item) => ({
    name: item.name,
    description: item.description,
    quantity: toNumber(item.quantity),
    unit: item.unit,
    unitPrice: toNumber(item.unitPrice),
    discount: toNumber(item.discount),
    vatRate: toNumber(item.vatRate),
    lineTotal: toNumber(item.netAmount),
  }));

  const vatRate = dominantVatRate(
    invoice.items.map((i) => ({ vatRate: toNumber(i.vatRate), net: toNumber(i.netAmount) })),
  );

  // --- QR-Zahlteil vorbereiten -------------------------------------------
  let qrSlip: QrSlipData | null = null;
  const iban = company.iban;

  if (iban) {
    const creditorAddress = splitStreet(company.street);
    const debtorAddress = splitStreet(invoice.billToStreet);
    const balance = toNumber(invoice.balance) > 0 ? toNumber(invoice.balance) : toNumber(invoice.grossTotal);

    const qrDataUrl = await renderQrCode({
      iban,
      creditor: {
        name: company.name,
        street: creditorAddress.street,
        buildingNumber: creditorAddress.buildingNumber,
        postalCode: company.postalCode,
        city: company.city,
        country: company.country,
      },
      debtor: {
        name: invoice.billToCompany ?? invoice.billToName,
        street: debtorAddress.street,
        buildingNumber: debtorAddress.buildingNumber,
        postalCode: invoice.billToZip,
        city: invoice.billToCity,
        country: invoice.billToCountry,
      },
      amount: balance,
      currency: (invoice.currency as 'CHF' | 'EUR') ?? 'CHF',
      reference: isQrIban(iban) ? invoice.qrReference : null,
      message: isQrIban(iban) ? null : `Rechnung ${invoice.number}`,
    });

    qrSlip = {
      qrDataUrl,
      iban,
      creditorLines: [company.name, company.street, `${company.postalCode} ${company.city}`],
      debtorLines: [
        invoice.billToCompany ?? invoice.billToName,
        invoice.billToStreet,
        `${invoice.billToZip} ${invoice.billToCity}`,
      ],
      amount: balance,
      currency: invoice.currency,
      reference: isQrIban(iban) ? invoice.qrReference : null,
      additionalInfo: `Rechnung ${invoice.number}`,
    };
  }

  const buffer = await renderToBuffer(
    React.createElement(InvoiceDocument, {
      company,
      recipient: recipientFromInvoice(invoice),
      number: invoice.number,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      periodFrom: invoice.periodFrom,
      periodTo: invoice.periodTo,
      items,
      subtotal: toNumber(invoice.subtotal),
      discountAmount: toNumber(invoice.discountAmount),
      netTotal: toNumber(invoice.netTotal),
      vatAmount: toNumber(invoice.vatAmount),
      vatRate,
      grossTotal: toNumber(invoice.grossTotal),
      paidAmount: toNumber(invoice.paidAmount),
      introText: invoice.introText,
      outroText: invoice.outroText,
      notes: invoice.notes,
      qrSlip,
    }) as never,
  );

  const filename = `Rechnung-${invoice.number}.pdf`;
  const url = await persist(
    invoice.organizationId,
    `invoices/${invoice.id}/${filename}`,
    buffer,
  );

  if (url && url !== invoice.pdfUrl) {
    await prisma.invoice.update({ where: { id: invoice.id }, data: { pdfUrl: url } });
  }

  return { buffer, filename, url };
}

// ---------------------------------------------------------------------------
//  Offerte
// ---------------------------------------------------------------------------

export async function renderQuotePdf(quoteId: string): Promise<{
  buffer: Buffer;
  filename: string;
  url: string | null;
}> {
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    include: {
      items: { orderBy: { position: 'asc' } },
      customer: { include: { addresses: { where: { isBilling: true }, take: 1 } } },
      lead: true,
    },
  });
  if (!quote) throw new NotFoundError('Offerte');

  const company = await loadCompany(quote.organizationId);

  const billing = quote.customer?.addresses[0];
  const recipient: PdfRecipient = quote.customer
    ? {
        name: `${quote.customer.firstName} ${quote.customer.lastName}`,
        company: quote.customer.companyName,
        street: billing ? [billing.street, billing.streetNo].filter(Boolean).join(' ') : '—',
        postalCode: billing?.postalCode ?? '',
        city: billing?.city ?? '',
        country: billing?.country ?? 'CH',
        vatNumber: quote.customer.vatNumber,
      }
    : {
        name: `${quote.lead?.firstName ?? ''} ${quote.lead?.lastName ?? ''}`.trim() || 'Interessent',
        company: quote.lead?.company ?? null,
        street: quote.lead?.street ?? '—',
        postalCode: quote.lead?.postalCode ?? '',
        city: quote.lead?.city ?? '',
        country: 'CH',
      };

  const items: PdfLineItem[] = quote.items.map((item) => ({
    name: item.name,
    description: item.description,
    quantity: toNumber(item.quantity),
    unit: item.unit,
    unitPrice: toNumber(item.unitPrice),
    discount: toNumber(item.discount),
    vatRate: toNumber(item.vatRate),
    lineTotal: toNumber(item.lineTotal),
    optional: item.optional,
  }));

  const vatRate = dominantVatRate(
    quote.items
      .filter((i) => !i.optional)
      .map((i) => ({ vatRate: toNumber(i.vatRate), net: toNumber(i.lineTotal) })),
  );

  const buffer = await renderToBuffer(
    React.createElement(QuoteDocument, {
      company,
      recipient,
      number: quote.number,
      title: quote.title,
      issueDate: quote.createdAt,
      validUntil: quote.validUntil,
      items,
      subtotal: toNumber(quote.subtotal),
      discountAmount: toNumber(quote.discountAmount),
      netTotal: toNumber(quote.netTotal),
      vatAmount: toNumber(quote.vatAmount),
      vatRate,
      grossTotal: toNumber(quote.grossTotal),
      introText: quote.introText,
      outroText: quote.outroText,
      terms: quote.terms,
      signature:
        quote.signatureDataUrl && quote.signatureName && quote.signedAt
          ? {
              dataUrl: quote.signatureDataUrl,
              name: quote.signatureName,
              signedAt: quote.signedAt,
            }
          : null,
    }) as never,
  );

  const filename = `Offerte-${quote.number}.pdf`;
  const url = await persist(quote.organizationId, `quotes/${quote.id}/${filename}`, buffer);

  if (url && url !== quote.pdfUrl) {
    await prisma.quote.update({ where: { id: quote.id }, data: { pdfUrl: url } });
  }

  return { buffer, filename, url };
}

// ---------------------------------------------------------------------------
//  Einsatzbericht
// ---------------------------------------------------------------------------

export async function renderJobReportPdf(
  jobId: string,
  reportText?: string | null,
): Promise<{ buffer: Buffer; filename: string; url: string | null }> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: {
      customer: true,
      address: true,
      checklist: { orderBy: { position: 'asc' } },
      materials: true,
      timeEntries: true,
      assignments: {
        include: { employee: { include: { user: { select: { firstName: true, lastName: true } } } } },
      },
    },
  });
  if (!job) throw new NotFoundError('Auftrag');

  const company = await loadCompany(job.organizationId);

  const durationMinutes =
    job.timeEntries.reduce((sum, entry) => sum + entry.minutes, 0) ||
    (job.actualStart && job.actualEnd
      ? Math.round((job.actualEnd.getTime() - job.actualStart.getTime()) / 60_000)
      : job.estimatedMin);

  const buffer = await renderToBuffer(
    React.createElement(JobReportDocument, {
      company,
      recipient: {
        name: `${job.customer.firstName} ${job.customer.lastName}`,
        company: job.customer.companyName,
        street: job.address ? [job.address.street, job.address.streetNo].filter(Boolean).join(' ') : '—',
        postalCode: job.address?.postalCode ?? '',
        city: job.address?.city ?? '',
        country: job.address?.country ?? 'CH',
      },
      jobNumber: job.number,
      title: job.title,
      date: job.actualStart ?? job.scheduledStart,
      startedAt: job.actualStart,
      endedAt: job.actualEnd,
      durationMinutes,
      crew: job.assignments.map((a) => `${a.employee.user.firstName} ${a.employee.user.lastName}`),
      address: job.address
        ? `${job.address.street} ${job.address.streetNo ?? ''}, ${job.address.postalCode} ${job.address.city}`
        : '—',
      checklist: job.checklist.map((c) => ({
        label: c.label,
        room: c.room,
        done: c.done,
        note: c.note,
      })),
      materials: job.materials.map((m) => ({
        name: m.name,
        quantity: toNumber(m.quantity),
        unit: m.unit,
      })),
      reportText: reportText ?? job.completionNote,
      signature:
        job.signatureDataUrl && job.signatureName && job.signedAt
          ? { dataUrl: job.signatureDataUrl, name: job.signatureName, signedAt: job.signedAt }
          : null,
    }) as never,
  );

  const filename = `Einsatzbericht-${job.number}.pdf`;
  const url = await persist(job.organizationId, `jobs/${job.id}/${filename}`, buffer);

  return { buffer, filename, url };
}

// ---------------------------------------------------------------------------
//  Gutschrift
// ---------------------------------------------------------------------------

export async function renderCreditNotePdf(creditNoteId: string): Promise<{
  buffer: Buffer;
  filename: string;
  url: string | null;
}> {
  const note = await prisma.creditNote.findUnique({
    where: { id: creditNoteId },
    include: {
      customer: { include: { addresses: { where: { isBilling: true }, take: 1 } } },
      invoice: { select: { number: true } },
    },
  });
  if (!note) throw new NotFoundError('Gutschrift');

  const company = await loadCompany(note.organizationId);
  const billing = note.customer.addresses[0];

  const rawItems = (note.items as unknown as {
    name: string;
    quantity: number;
    unit: string;
    unitPrice: number;
    vatRate: number;
  }[]) ?? [];

  const items: PdfLineItem[] = rawItems.map((item) => ({
    name: item.name,
    description: null,
    quantity: item.quantity,
    unit: item.unit,
    unitPrice: item.unitPrice,
    vatRate: item.vatRate,
    lineTotal: item.quantity * item.unitPrice,
  }));

  const buffer = await renderToBuffer(
    React.createElement(CreditNoteDocument, {
      company,
      recipient: {
        name: `${note.customer.firstName} ${note.customer.lastName}`,
        company: note.customer.companyName,
        street: billing ? [billing.street, billing.streetNo].filter(Boolean).join(' ') : '—',
        postalCode: billing?.postalCode ?? '',
        city: billing?.city ?? '',
        country: billing?.country ?? 'CH',
        vatNumber: note.customer.vatNumber,
      },
      number: note.number,
      issueDate: note.issueDate,
      reason: note.reason,
      relatedInvoice: note.invoice?.number ?? null,
      items,
      netTotal: toNumber(note.netTotal),
      vatAmount: toNumber(note.vatAmount),
      vatRate: items[0]?.vatRate ?? 8.1,
      grossTotal: toNumber(note.grossTotal),
    }) as never,
  );

  const filename = `Gutschrift-${note.number}.pdf`;
  const url = await persist(note.organizationId, `credit-notes/${note.id}/${filename}`, buffer);

  if (url && url !== note.pdfUrl) {
    await prisma.creditNote.update({ where: { id: note.id }, data: { pdfUrl: url } });
  }

  return { buffer, filename, url };
}

// ---------------------------------------------------------------------------
//  Ablage
// ---------------------------------------------------------------------------

async function persist(
  organizationId: string,
  relativePath: string,
  buffer: Buffer,
): Promise<string | null> {
  if (!hasIntegration('supabase')) return null;
  try {
    const { publicUrl } = await uploadBuffer({
      path: `${organizationId}/${relativePath}`,
      content: buffer,
      contentType: 'application/pdf',
      upsert: true,
    });
    return publicUrl;
  } catch (error) {
    log.error('Ablage fehlgeschlagen', { error });
    return null;
  }
}
