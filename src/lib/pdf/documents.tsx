import React from 'react';
import {
  Document,
  Image,
  Page,
  StyleSheet,
  Text,
  View,
} from '@react-pdf/renderer';

import { formatDate, formatIban } from '@/lib/utils';
import { formatQrReference } from './swiss-qr';

/**
 * PDF-Dokumente (Rechnung, Offerte, Einsatzbericht, Gutschrift).
 *
 * Architekturentscheid: `@react-pdf/renderer` statt HTML→PDF via Headless
 * Chrome. Puppeteer/Playwright brauchen ~300 MB Binaries und laufen auf
 * Vercel-Lambdas nur mit Klimmzügen; react-pdf rendert deterministisch in
 * reinem JavaScript, startet in Millisekunden und erlaubt die pixelgenaue
 * Positionierung, die der QR-Rechnungs-Zahlteil zwingend vorschreibt
 * (Perforationslinie bei 105 mm ab Blattunterkante).
 */

const COLORS = {
  ink: '#0F172A',
  body: '#334155',
  muted: '#64748B',
  line: '#E2E8F0',
  soft: '#F8FAFC',
  brand: '#0B7285',
};

// 1 mm ≈ 2.8346 pt
const MM = 2.8346;

const styles = StyleSheet.create({
  page: {
    paddingTop: 40,
    paddingHorizontal: 48,
    paddingBottom: 60,
    fontSize: 9.5,
    fontFamily: 'Helvetica',
    color: COLORS.body,
    lineHeight: 1.5,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 28,
  },
  logo: { width: 120, height: 34, objectFit: 'contain' },
  brandName: { fontSize: 17, fontFamily: 'Helvetica-Bold', color: COLORS.brand, letterSpacing: -0.4 },
  companyBlock: { fontSize: 8.5, color: COLORS.muted, textAlign: 'right', lineHeight: 1.55 },

  addressRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 28 },
  addressBlock: { width: '55%' },
  metaBlock: { width: '38%' },
  recipientLabel: { fontSize: 7.5, color: COLORS.muted, marginBottom: 5, letterSpacing: 0.6 },
  recipientLine: { fontSize: 10, color: COLORS.ink, lineHeight: 1.5 },

  metaRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 },
  metaLabel: { fontSize: 8.5, color: COLORS.muted },
  metaValue: { fontSize: 8.5, color: COLORS.ink, fontFamily: 'Helvetica-Bold' },

  title: {
    fontSize: 19,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.ink,
    marginBottom: 6,
    letterSpacing: -0.5,
  },
  subtitle: { fontSize: 10, color: COLORS.muted, marginBottom: 20 },
  paragraph: { marginBottom: 12, fontSize: 9.5 },

  table: { marginTop: 8, marginBottom: 16 },
  tableHead: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: COLORS.ink,
    paddingBottom: 6,
    marginBottom: 4,
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: COLORS.line,
    paddingVertical: 7,
  },
  th: { fontSize: 7.5, fontFamily: 'Helvetica-Bold', color: COLORS.ink, letterSpacing: 0.5 },
  td: { fontSize: 9, color: COLORS.body },
  colPos: { width: '6%' },
  colDesc: { width: '44%' },
  colQty: { width: '13%', textAlign: 'right' },
  colPrice: { width: '17%', textAlign: 'right' },
  colTotal: { width: '20%', textAlign: 'right' },
  itemName: { fontSize: 9.5, color: COLORS.ink, fontFamily: 'Helvetica-Bold' },
  itemDesc: { fontSize: 8, color: COLORS.muted, marginTop: 2 },
  optionalTag: { fontSize: 7, color: COLORS.brand, marginTop: 2 },

  totalsWrap: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 4 },
  totals: { width: '52%' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3.5 },
  totalLabel: { fontSize: 9, color: COLORS.muted },
  totalValue: { fontSize: 9, color: COLORS.ink },
  grandRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 8,
    marginTop: 5,
    borderTopWidth: 1.5,
    borderTopColor: COLORS.ink,
  },
  grandLabel: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: COLORS.ink },
  grandValue: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: COLORS.ink },

  note: {
    marginTop: 18,
    padding: 12,
    backgroundColor: COLORS.soft,
    borderRadius: 6,
    fontSize: 8.5,
    color: COLORS.body,
  },
  signatureRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 36 },
  signatureBox: { width: '45%' },
  signatureImage: { height: 46, objectFit: 'contain', marginBottom: 4 },
  signatureLine: { borderTopWidth: 0.75, borderTopColor: COLORS.muted, paddingTop: 4 },
  signatureLabel: { fontSize: 7.5, color: COLORS.muted },

  footer: {
    position: 'absolute',
    bottom: 24,
    left: 48,
    right: 48,
    borderTopWidth: 0.5,
    borderTopColor: COLORS.line,
    paddingTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontSize: 7.5,
    color: COLORS.muted,
  },

  // --- QR-Rechnung Zahlteil (Masse gemäss Swiss Implementation Guidelines) ---
  qrSlipPage: { paddingTop: 0, paddingHorizontal: 0, paddingBottom: 0, fontFamily: 'Helvetica' },
  qrSlip: { height: 105 * MM, flexDirection: 'row', borderTopWidth: 0.5, borderTopColor: '#000' },
  receipt: {
    width: 62 * MM,
    paddingTop: 5 * MM,
    paddingLeft: 5 * MM,
    paddingRight: 5 * MM,
    borderRightWidth: 0.5,
    borderRightColor: '#000',
    borderRightStyle: 'dashed',
  },
  payment: { width: 148 * MM, paddingTop: 5 * MM, paddingLeft: 5 * MM, flexDirection: 'row' },
  paymentLeft: { width: 51 * MM },
  paymentRight: { width: 87 * MM, paddingLeft: 5 * MM },
  qrTitle: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: '#000', marginBottom: 4 },
  qrHeading: { fontSize: 6, fontFamily: 'Helvetica-Bold', color: '#000', marginTop: 6 },
  qrValue: { fontSize: 8, color: '#000', lineHeight: 1.3 },
  qrValueSmall: { fontSize: 6, color: '#000', lineHeight: 1.3 },
  qrImageWrap: { width: 46 * MM, height: 46 * MM, marginTop: 5 * MM, position: 'relative' },
  qrImage: { width: 46 * MM, height: 46 * MM },
  swissCross: {
    position: 'absolute',
    top: 20.5 * MM,
    left: 20.5 * MM,
    width: 7 * MM,
    height: 7 * MM,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  swissCrossInner: { width: 5 * MM, height: 5 * MM, backgroundColor: '#FFF' },
  swissCrossBarH: { position: 'absolute', width: 3 * MM, height: 0.9 * MM, backgroundColor: '#000' },
  swissCrossBarV: { position: 'absolute', width: 0.9 * MM, height: 3 * MM, backgroundColor: '#000' },
  amountRow: { flexDirection: 'row', marginTop: 4 * MM },
});

// ---------------------------------------------------------------------------
//  Gemeinsame Typen
// ---------------------------------------------------------------------------

export interface PdfCompany {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  country: string;
  phone: string;
  email: string;
  website?: string | null;
  vatNumber?: string | null;
  iban?: string | null;
  logoUrl?: string | null;
  bankName?: string | null;
}

export interface PdfRecipient {
  name: string;
  company?: string | null;
  street: string;
  postalCode: string;
  city: string;
  country: string;
  vatNumber?: string | null;
}

export interface PdfLineItem {
  name: string;
  description?: string | null;
  quantity: number;
  unit: string;
  unitPrice: number;
  discount?: number;
  vatRate: number;
  lineTotal: number;
  optional?: boolean;
}

function chf(value: number): string {
  return value.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------------------
//  Bausteine
// ---------------------------------------------------------------------------

function Header({ company }: { company: PdfCompany }) {
  return (
    <View style={styles.headerRow}>
      {company.logoUrl ? (
        // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image kennt kein alt
        <Image src={company.logoUrl} style={styles.logo} />
      ) : (
        <Text style={styles.brandName}>{company.name}</Text>
      )}
      <View style={styles.companyBlock}>
        <Text>{company.name}</Text>
        <Text>{company.street}</Text>
        <Text>
          {company.postalCode} {company.city}
        </Text>
        <Text>{company.phone}</Text>
        <Text>{company.email}</Text>
        {company.vatNumber ? <Text>{company.vatNumber}</Text> : null}
      </View>
    </View>
  );
}

function RecipientBlock({ recipient }: { recipient: PdfRecipient }) {
  return (
    <View style={styles.addressBlock}>
      <Text style={styles.recipientLabel}>RECHNUNGSEMPFÄNGER</Text>
      {recipient.company ? <Text style={styles.recipientLine}>{recipient.company}</Text> : null}
      <Text style={styles.recipientLine}>{recipient.name}</Text>
      <Text style={styles.recipientLine}>{recipient.street}</Text>
      <Text style={styles.recipientLine}>
        {recipient.postalCode} {recipient.city}
      </Text>
      {recipient.country !== 'CH' ? (
        <Text style={styles.recipientLine}>{recipient.country}</Text>
      ) : null}
    </View>
  );
}

function MetaBlock({ rows }: { rows: { label: string; value: string }[] }) {
  return (
    <View style={styles.metaBlock}>
      {rows.map((row) => (
        <View key={row.label} style={styles.metaRow}>
          <Text style={styles.metaLabel}>{row.label}</Text>
          <Text style={styles.metaValue}>{row.value}</Text>
        </View>
      ))}
    </View>
  );
}

function ItemsTable({ items }: { items: PdfLineItem[] }) {
  return (
    <View style={styles.table}>
      <View style={styles.tableHead}>
        <Text style={[styles.th, styles.colPos]}>POS</Text>
        <Text style={[styles.th, styles.colDesc]}>BEZEICHNUNG</Text>
        <Text style={[styles.th, styles.colQty]}>MENGE</Text>
        <Text style={[styles.th, styles.colPrice]}>PREIS</Text>
        <Text style={[styles.th, styles.colTotal]}>TOTAL CHF</Text>
      </View>

      {items.map((item, index) => (
        <View key={`${item.name}-${index}`} style={styles.tableRow} wrap={false}>
          <Text style={[styles.td, styles.colPos]}>{index + 1}</Text>
          <View style={styles.colDesc}>
            <Text style={styles.itemName}>{item.name}</Text>
            {item.description ? <Text style={styles.itemDesc}>{item.description}</Text> : null}
            {item.optional ? <Text style={styles.optionalTag}>Option — nicht im Total enthalten</Text> : null}
          </View>
          <Text style={[styles.td, styles.colQty]}>
            {item.quantity.toLocaleString('de-CH', { maximumFractionDigits: 2 })} {item.unit}
          </Text>
          <Text style={[styles.td, styles.colPrice]}>{chf(item.unitPrice)}</Text>
          <Text style={[styles.td, styles.colTotal]}>
            {item.optional ? `(${chf(item.lineTotal)})` : chf(item.lineTotal)}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Totals({
  subtotal,
  discountAmount,
  netTotal,
  vatAmount,
  vatRate,
  grandTotal,
  paidAmount,
}: {
  subtotal: number;
  discountAmount: number;
  netTotal: number;
  vatAmount: number;
  vatRate: number;
  grandTotal: number;
  paidAmount?: number;
}) {
  return (
    <View style={styles.totalsWrap}>
      <View style={styles.totals}>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Zwischentotal</Text>
          <Text style={styles.totalValue}>CHF {chf(subtotal)}</Text>
        </View>
        {discountAmount > 0 ? (
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Rabatt</Text>
            <Text style={styles.totalValue}>− CHF {chf(discountAmount)}</Text>
          </View>
        ) : null}
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Total netto</Text>
          <Text style={styles.totalValue}>CHF {chf(netTotal)}</Text>
        </View>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>MWST {vatRate.toFixed(1)} %</Text>
          <Text style={styles.totalValue}>CHF {chf(vatAmount)}</Text>
        </View>
        <View style={styles.grandRow}>
          <Text style={styles.grandLabel}>Gesamtbetrag</Text>
          <Text style={styles.grandValue}>CHF {chf(grandTotal)}</Text>
        </View>
        {paidAmount !== undefined && paidAmount > 0 ? (
          <>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Bereits bezahlt</Text>
              <Text style={styles.totalValue}>− CHF {chf(paidAmount)}</Text>
            </View>
            <View style={styles.totalRow}>
              <Text style={[styles.totalLabel, { fontFamily: 'Helvetica-Bold', color: COLORS.ink }]}>
                Offener Betrag
              </Text>
              <Text style={[styles.totalValue, { fontFamily: 'Helvetica-Bold' }]}>
                CHF {chf(grandTotal - paidAmount)}
              </Text>
            </View>
          </>
        ) : null}
      </View>
    </View>
  );
}

function Footer({ company, label }: { company: PdfCompany; label: string }) {
  return (
    <View style={styles.footer} fixed>
      <Text>
        {company.name} · {company.street} · {company.postalCode} {company.city}
      </Text>
      <Text render={({ pageNumber, totalPages }) => `${label} · Seite ${pageNumber}/${totalPages}`} />
    </View>
  );
}

// ---------------------------------------------------------------------------
//  QR-Zahlteil
// ---------------------------------------------------------------------------

export interface QrSlipData {
  qrDataUrl: string;
  iban: string;
  creditorLines: string[];
  debtorLines: string[];
  amount: number;
  currency: string;
  reference?: string | null;
  additionalInfo?: string | null;
}

function SwissCross() {
  return (
    <View style={styles.swissCross}>
      <View style={styles.swissCrossInner} />
      <View style={styles.swissCrossBarH} />
      <View style={styles.swissCrossBarV} />
    </View>
  );
}

function QrSlip({ data }: { data: QrSlipData }) {
  return (
    <View style={styles.qrSlip}>
      {/* Empfangsschein */}
      <View style={styles.receipt}>
        <Text style={styles.qrTitle}>Empfangsschein</Text>

        <Text style={styles.qrHeading}>Konto / Zahlbar an</Text>
        <Text style={styles.qrValueSmall}>{formatIban(data.iban)}</Text>
        {data.creditorLines.map((line, i) => (
          <Text key={i} style={styles.qrValueSmall}>
            {line}
          </Text>
        ))}

        {data.reference ? (
          <>
            <Text style={styles.qrHeading}>Referenz</Text>
            <Text style={styles.qrValueSmall}>{formatQrReference(data.reference)}</Text>
          </>
        ) : null}

        <Text style={styles.qrHeading}>Zahlbar durch</Text>
        {data.debtorLines.map((line, i) => (
          <Text key={i} style={styles.qrValueSmall}>
            {line}
          </Text>
        ))}

        <View style={styles.amountRow}>
          <View style={{ width: 20 * MM }}>
            <Text style={styles.qrHeading}>Währung</Text>
            <Text style={styles.qrValueSmall}>{data.currency}</Text>
          </View>
          <View>
            <Text style={styles.qrHeading}>Betrag</Text>
            <Text style={styles.qrValueSmall}>{chf(data.amount)}</Text>
          </View>
        </View>

        <Text style={[styles.qrHeading, { marginTop: 10 * MM, textAlign: 'right' }]}>
          Annahmestelle
        </Text>
      </View>

      {/* Zahlteil */}
      <View style={styles.payment}>
        <View style={styles.paymentLeft}>
          <Text style={styles.qrTitle}>Zahlteil</Text>

          <View style={styles.qrImageWrap}>
            {/* eslint-disable-next-line jsx-a11y/alt-text */}
            <Image src={data.qrDataUrl} style={styles.qrImage} />
            <SwissCross />
          </View>

          <View style={styles.amountRow}>
            <View style={{ width: 20 * MM }}>
              <Text style={styles.qrHeading}>Währung</Text>
              <Text style={styles.qrValue}>{data.currency}</Text>
            </View>
            <View>
              <Text style={styles.qrHeading}>Betrag</Text>
              <Text style={styles.qrValue}>{chf(data.amount)}</Text>
            </View>
          </View>
        </View>

        <View style={styles.paymentRight}>
          <Text style={styles.qrHeading}>Konto / Zahlbar an</Text>
          <Text style={styles.qrValue}>{formatIban(data.iban)}</Text>
          {data.creditorLines.map((line, i) => (
            <Text key={i} style={styles.qrValue}>
              {line}
            </Text>
          ))}

          {data.reference ? (
            <>
              <Text style={styles.qrHeading}>Referenz</Text>
              <Text style={styles.qrValue}>{formatQrReference(data.reference)}</Text>
            </>
          ) : null}

          {data.additionalInfo ? (
            <>
              <Text style={styles.qrHeading}>Zusätzliche Informationen</Text>
              <Text style={styles.qrValue}>{data.additionalInfo}</Text>
            </>
          ) : null}

          <Text style={styles.qrHeading}>Zahlbar durch</Text>
          {data.debtorLines.map((line, i) => (
            <Text key={i} style={styles.qrValue}>
              {line}
            </Text>
          ))}
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
//  Rechnung
// ---------------------------------------------------------------------------

export interface InvoicePdfProps {
  company: PdfCompany;
  recipient: PdfRecipient;
  number: string;
  issueDate: Date;
  dueDate: Date;
  periodFrom?: Date | null;
  periodTo?: Date | null;
  items: PdfLineItem[];
  subtotal: number;
  discountAmount: number;
  netTotal: number;
  vatAmount: number;
  vatRate: number;
  grossTotal: number;
  paidAmount: number;
  introText?: string | null;
  outroText?: string | null;
  notes?: string | null;
  qrSlip?: QrSlipData | null;
}

export function InvoiceDocument(props: InvoicePdfProps) {
  const { company, recipient } = props;

  return (
    <Document
      title={`Rechnung ${props.number}`}
      author={company.name}
      subject={`Rechnung ${props.number}`}
      creator="Clenaris"
    >
      <Page size="A4" style={styles.page}>
        <Header company={company} />

        <View style={styles.addressRow}>
          <RecipientBlock recipient={recipient} />
          <MetaBlock
            rows={[
              { label: 'Rechnungsnummer', value: props.number },
              { label: 'Rechnungsdatum', value: formatDate(props.issueDate) },
              { label: 'Zahlbar bis', value: formatDate(props.dueDate) },
              ...(props.periodFrom && props.periodTo
                ? [
                    {
                      label: 'Leistungszeitraum',
                      value: `${formatDate(props.periodFrom)} – ${formatDate(props.periodTo)}`,
                    },
                  ]
                : []),
              ...(recipient.vatNumber ? [{ label: 'MWST-Nr. Kunde', value: recipient.vatNumber }] : []),
            ]}
          />
        </View>

        <Text style={styles.title}>Rechnung {props.number}</Text>
        {props.introText ? <Text style={styles.paragraph}>{props.introText}</Text> : null}

        <ItemsTable items={props.items} />

        <Totals
          subtotal={props.subtotal}
          discountAmount={props.discountAmount}
          netTotal={props.netTotal}
          vatAmount={props.vatAmount}
          vatRate={props.vatRate}
          grandTotal={props.grossTotal}
          paidAmount={props.paidAmount}
        />

        {props.outroText ? <Text style={[styles.paragraph, { marginTop: 18 }]}>{props.outroText}</Text> : null}

        <View style={styles.note}>
          <Text>
            Zahlbar innert {Math.max(0, Math.round((props.dueDate.getTime() - props.issueDate.getTime()) / 86_400_000))}{' '}
            Tagen netto ohne Abzug.
            {company.iban ? ` Bankverbindung: ${formatIban(company.iban)}${company.bankName ? `, ${company.bankName}` : ''}.` : ''}
            {' '}Bitte geben Sie bei der Zahlung die Rechnungsnummer {props.number} an.
          </Text>
          {props.notes ? <Text style={{ marginTop: 6 }}>{props.notes}</Text> : null}
        </View>

        <Footer company={company} label={`Rechnung ${props.number}`} />
      </Page>

      {props.qrSlip ? (
        <Page size="A4" style={styles.qrSlipPage}>
          <View style={{ flex: 1 }} />
          <QrSlip data={props.qrSlip} />
        </Page>
      ) : null}
    </Document>
  );
}

// ---------------------------------------------------------------------------
//  Offerte
// ---------------------------------------------------------------------------

export interface QuotePdfProps {
  company: PdfCompany;
  recipient: PdfRecipient;
  number: string;
  title: string;
  issueDate: Date;
  validUntil: Date;
  items: PdfLineItem[];
  subtotal: number;
  discountAmount: number;
  netTotal: number;
  vatAmount: number;
  vatRate: number;
  grossTotal: number;
  introText?: string | null;
  outroText?: string | null;
  terms?: string | null;
  signature?: { dataUrl: string; name: string; signedAt: Date } | null;
}

export function QuoteDocument(props: QuotePdfProps) {
  const { company, recipient } = props;

  return (
    <Document title={`Offerte ${props.number}`} author={company.name} creator="Clenaris">
      <Page size="A4" style={styles.page}>
        <Header company={company} />

        <View style={styles.addressRow}>
          <RecipientBlock recipient={recipient} />
          <MetaBlock
            rows={[
              { label: 'Offertnummer', value: props.number },
              { label: 'Datum', value: formatDate(props.issueDate) },
              { label: 'Gültig bis', value: formatDate(props.validUntil) },
            ]}
          />
        </View>

        <Text style={styles.title}>Offerte {props.number}</Text>
        <Text style={styles.subtitle}>{props.title}</Text>

        {props.introText ? <Text style={styles.paragraph}>{props.introText}</Text> : null}

        <ItemsTable items={props.items} />

        <Totals
          subtotal={props.subtotal}
          discountAmount={props.discountAmount}
          netTotal={props.netTotal}
          vatAmount={props.vatAmount}
          vatRate={props.vatRate}
          grandTotal={props.grossTotal}
        />

        {props.outroText ? <Text style={[styles.paragraph, { marginTop: 18 }]}>{props.outroText}</Text> : null}

        {props.terms ? (
          <View style={styles.note}>
            <Text>{props.terms}</Text>
          </View>
        ) : null}

        <View style={styles.signatureRow}>
          <View style={styles.signatureBox}>
            <Text style={styles.signatureLabel}>{company.name}</Text>
            <View style={[styles.signatureLine, { marginTop: 42 }]}>
              <Text style={styles.signatureLabel}>Ort, Datum, Unterschrift</Text>
            </View>
          </View>

          <View style={styles.signatureBox}>
            {props.signature ? (
              <>
                {/* eslint-disable-next-line jsx-a11y/alt-text */}
                <Image src={props.signature.dataUrl} style={styles.signatureImage} />
                <View style={styles.signatureLine}>
                  <Text style={styles.signatureLabel}>
                    {props.signature.name} · digital signiert am {formatDate(props.signature.signedAt)}
                  </Text>
                </View>
              </>
            ) : (
              <>
                <Text style={styles.signatureLabel}>Auftraggeber/in</Text>
                <View style={[styles.signatureLine, { marginTop: 42 }]}>
                  <Text style={styles.signatureLabel}>Ort, Datum, Unterschrift</Text>
                </View>
              </>
            )}
          </View>
        </View>

        <Footer company={company} label={`Offerte ${props.number}`} />
      </Page>
    </Document>
  );
}

// ---------------------------------------------------------------------------
//  Einsatzbericht
// ---------------------------------------------------------------------------

export interface JobReportPdfProps {
  company: PdfCompany;
  recipient: PdfRecipient;
  jobNumber: string;
  title: string;
  date: Date;
  startedAt?: Date | null;
  endedAt?: Date | null;
  durationMinutes: number;
  crew: string[];
  address: string;
  checklist: { label: string; room?: string | null; done: boolean; note?: string | null }[];
  materials: { name: string; quantity: number; unit: string }[];
  reportText?: string | null;
  signature?: { dataUrl: string; name: string; signedAt: Date } | null;
}

export function JobReportDocument(props: JobReportPdfProps) {
  const { company, recipient } = props;
  const doneCount = props.checklist.filter((c) => c.done).length;

  return (
    <Document title={`Einsatzbericht ${props.jobNumber}`} author={company.name} creator="Clenaris">
      <Page size="A4" style={styles.page}>
        <Header company={company} />

        <View style={styles.addressRow}>
          <RecipientBlock recipient={recipient} />
          <MetaBlock
            rows={[
              { label: 'Auftragsnummer', value: props.jobNumber },
              { label: 'Datum', value: formatDate(props.date) },
              {
                label: 'Dauer',
                value: `${Math.floor(props.durationMinutes / 60)} h ${props.durationMinutes % 60} min`,
              },
              { label: 'Team', value: props.crew.join(', ') || '—' },
            ]}
          />
        </View>

        <Text style={styles.title}>Einsatzbericht</Text>
        <Text style={styles.subtitle}>
          {props.title} · {props.address}
        </Text>

        {props.reportText ? <Text style={styles.paragraph}>{props.reportText}</Text> : null}

        <Text style={[styles.th, { marginTop: 14, marginBottom: 6 }]}>
          AUSGEFÜHRTE ARBEITEN ({doneCount}/{props.checklist.length})
        </Text>
        {props.checklist.map((item, i) => (
          <View key={i} style={styles.tableRow} wrap={false}>
            <Text style={[styles.td, { width: '6%' }]}>{item.done ? '✓' : '—'}</Text>
            <View style={{ width: '94%' }}>
              <Text style={styles.itemName}>
                {item.room ? `${item.room}: ` : ''}
                {item.label}
              </Text>
              {item.note ? <Text style={styles.itemDesc}>{item.note}</Text> : null}
            </View>
          </View>
        ))}

        {props.materials.length > 0 ? (
          <>
            <Text style={[styles.th, { marginTop: 18, marginBottom: 6 }]}>VERWENDETES MATERIAL</Text>
            {props.materials.map((m, i) => (
              <View key={i} style={styles.tableRow} wrap={false}>
                <Text style={[styles.td, { width: '70%' }]}>{m.name}</Text>
                <Text style={[styles.td, { width: '30%', textAlign: 'right' }]}>
                  {m.quantity} {m.unit}
                </Text>
              </View>
            ))}
          </>
        ) : null}

        <View style={styles.signatureRow}>
          <View style={styles.signatureBox}>
            <Text style={styles.signatureLabel}>Ausführendes Team</Text>
            <View style={[styles.signatureLine, { marginTop: 42 }]}>
              <Text style={styles.signatureLabel}>{props.crew.join(', ')}</Text>
            </View>
          </View>
          <View style={styles.signatureBox}>
            {props.signature ? (
              <>
                {/* eslint-disable-next-line jsx-a11y/alt-text */}
                <Image src={props.signature.dataUrl} style={styles.signatureImage} />
                <View style={styles.signatureLine}>
                  <Text style={styles.signatureLabel}>
                    {props.signature.name} · {formatDate(props.signature.signedAt)}
                  </Text>
                </View>
              </>
            ) : (
              <>
                <Text style={styles.signatureLabel}>Abnahme durch Kundschaft</Text>
                <View style={[styles.signatureLine, { marginTop: 42 }]}>
                  <Text style={styles.signatureLabel}>Ort, Datum, Unterschrift</Text>
                </View>
              </>
            )}
          </View>
        </View>

        <Footer company={company} label={`Einsatzbericht ${props.jobNumber}`} />
      </Page>
    </Document>
  );
}

// ---------------------------------------------------------------------------
//  Gutschrift
// ---------------------------------------------------------------------------

export interface CreditNotePdfProps {
  company: PdfCompany;
  recipient: PdfRecipient;
  number: string;
  issueDate: Date;
  reason: string;
  relatedInvoice?: string | null;
  items: PdfLineItem[];
  netTotal: number;
  vatAmount: number;
  vatRate: number;
  grossTotal: number;
}

export function CreditNoteDocument(props: CreditNotePdfProps) {
  const { company, recipient } = props;

  return (
    <Document title={`Gutschrift ${props.number}`} author={company.name} creator="Clenaris">
      <Page size="A4" style={styles.page}>
        <Header company={company} />

        <View style={styles.addressRow}>
          <RecipientBlock recipient={recipient} />
          <MetaBlock
            rows={[
              { label: 'Gutschriftsnummer', value: props.number },
              { label: 'Datum', value: formatDate(props.issueDate) },
              ...(props.relatedInvoice
                ? [{ label: 'Bezug Rechnung', value: props.relatedInvoice }]
                : []),
            ]}
          />
        </View>

        <Text style={styles.title}>Gutschrift {props.number}</Text>
        <Text style={styles.paragraph}>Grund: {props.reason}</Text>

        <ItemsTable items={props.items} />

        <Totals
          subtotal={props.netTotal}
          discountAmount={0}
          netTotal={props.netTotal}
          vatAmount={props.vatAmount}
          vatRate={props.vatRate}
          grandTotal={props.grossTotal}
        />

        <View style={styles.note}>
          <Text>
            Der Gutschriftsbetrag wird mit der nächsten Rechnung verrechnet oder auf Wunsch
            zurückerstattet. Bitte melden Sie sich bei Fragen unter {company.email}.
          </Text>
        </View>

        <Footer company={company} label={`Gutschrift ${props.number}`} />
      </Page>
    </Document>
  );
}
