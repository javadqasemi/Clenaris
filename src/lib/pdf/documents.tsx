import React from 'react';
import {
  Document,
  Image,
  Page,
  StyleSheet,
  Text,
  View,
} from '@react-pdf/renderer';

import { formatDate, formatDateLong, formatIban, formatTime } from '@/lib/utils';
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

function RecipientBlock({
  recipient,
  label = 'RECHNUNGSEMPFÄNGER',
}: {
  recipient: PdfRecipient;
  /** Überschrift des Blocks — eine Buchungsbestätigung hat keinen Rechnungsempfänger. */
  label?: string;
}) {
  return (
    <View style={styles.addressBlock}>
      <Text style={styles.recipientLabel}>{label}</Text>
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
                    {props.signature.name} · elektronisch unterzeichnet am {formatDate(props.signature.signedAt)}
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
//  Buchungsbestätigung
// ---------------------------------------------------------------------------

export interface BookingConfirmationPdfProps {
  company: PdfCompany;
  recipient: PdfRecipient;
  number: string;
  /** Prisma-Status — entscheidet über Titel und Hinweistext. */
  status: string;
  statusLabel: string;
  createdAt: Date;
  serviceName: string;
  frequencyLabel: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  durationMinutes: number;
  crewSize: number;
  address: string;
  propertyLabel: string;
  extras: { name: string; quantity: number; lineTotal: number }[];
  /** Die Herleitung aus `priceBreakdown` — jede Zeile so, wie die Kundschaft sie im Assistenten sah. */
  lines: { label: string; amount: number; kind: string }[];
  netTotal: number;
  vatRate: number;
  vatAmount: number;
  grossTotal: number;
  customerNote?: string | null;
  accessNote?: string | null;
  /** Öffentlicher Verwaltungslink — steht im Dokument, damit der Ausdruck allein genügt. */
  manageUrl: string;
}

/**
 * Buchungsbestätigung.
 *
 * Kein Rechnungsdokument: keine Positionsnummern, kein Zahlteil, keine
 * Nummernfolge nach Art. 957a OR. Es ist der Beleg, den die Kundschaft nach
 * dem Abschluss ausdruckt oder ablegt — Termin, Ort, Umfang, Preis und der
 * Weg zurück zur Verwaltung. Solange der Termin noch nicht bestätigt ist,
 * sagt das Dokument das ausdrücklich; sonst liest sich der Ausdruck wie eine
 * feste Zusage, die das Büro noch gar nicht gegeben hat.
 */
export function BookingConfirmationDocument(props: BookingConfirmationPdfProps) {
  const { company, recipient } = props;
  const confirmed = props.status === 'CONFIRMED';
  const cancelled = props.status === 'CANCELLED';
  const title = cancelled
    ? 'Stornierte Buchung'
    : confirmed
      ? 'Terminbestätigung'
      : 'Buchungsbestätigung';
  const timeRange = `${formatTime(props.scheduledStart)} – ${formatTime(props.scheduledEnd)} Uhr`;
  const hours = Math.floor(props.durationMinutes / 60);
  const minutes = props.durationMinutes % 60;
  const duration = minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;

  const details: { label: string; value: string }[] = [
    { label: 'Leistung', value: props.serviceName },
    { label: 'Turnus', value: props.frequencyLabel },
    { label: 'Datum', value: formatDateLong(props.scheduledStart) },
    {
      label: 'Zeitfenster',
      value: `${timeRange} · ca. ${duration}${props.crewSize > 1 ? ` · ${props.crewSize} Personen` : ''}`,
    },
    { label: 'Einsatzort', value: props.address },
    { label: 'Objekt', value: props.propertyLabel },
  ];
  if (props.extras.length > 0) {
    details.push({
      label: 'Zusatzleistungen',
      value: props.extras.map((extra) => `${extra.quantity}× ${extra.name}`).join(', '),
    });
  }
  if (props.customerNote) details.push({ label: 'Ihre Anmerkung', value: props.customerNote });
  if (props.accessNote) details.push({ label: 'Zugang', value: props.accessNote });

  return (
    <Document title={`${title} ${props.number}`} author={company.name} creator="Clenaris">
      <Page size="A4" style={styles.page}>
        <Header company={company} />

        <View style={styles.addressRow}>
          <RecipientBlock recipient={recipient} label="KUNDSCHAFT" />
          <MetaBlock
            rows={[
              { label: 'Buchungsnummer', value: props.number },
              { label: 'Eingegangen am', value: formatDate(props.createdAt) },
              { label: 'Status', value: props.statusLabel },
            ]}
          />
        </View>

        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>
          {props.serviceName} · {formatDateLong(props.scheduledStart)} · {timeRange}
        </Text>

        <Text style={styles.paragraph}>
          {cancelled
            ? 'Diese Buchung wurde storniert. Die Angaben unten dienen nur noch als Beleg.'
            : confirmed
              ? 'Ihr Termin ist fix reserviert. Unser Team ist zum vereinbarten Zeitpunkt vor Ort — bitte sorgen Sie dafür, dass wir ins Gebäude kommen.'
              : 'Vielen Dank für Ihre Buchung. Wir prüfen den Termin und bestätigen ihn in der Regel innerhalb von zwei Stunden per E-Mail. Bis dahin gilt er als reserviert, aber noch nicht als fix.'}
        </Text>

        <Text style={[styles.th, { marginTop: 10, marginBottom: 4 }]}>IHRE BUCHUNG</Text>
        {details.map((row) => (
          <View key={row.label} style={styles.tableRow} wrap={false}>
            <Text style={[styles.td, { width: '30%', color: COLORS.muted }]}>{row.label}</Text>
            <Text style={[styles.td, { width: '70%', color: COLORS.ink }]}>{row.value}</Text>
          </View>
        ))}

        <Text style={[styles.th, { marginTop: 18, marginBottom: 4 }]}>PREIS</Text>
        {props.lines.map((line, index) => (
          <View key={`${line.label}-${index}`} style={styles.tableRow} wrap={false}>
            <Text
              style={[
                styles.td,
                { width: '70%', color: line.kind === 'discount' ? COLORS.brand : COLORS.body },
              ]}
            >
              {line.label}
            </Text>
            <Text style={[styles.td, { width: '30%', textAlign: 'right' }]}>
              {line.amount < 0 ? `− CHF ${chf(Math.abs(line.amount))}` : `CHF ${chf(line.amount)}`}
            </Text>
          </View>
        ))}
        <View style={styles.totalsWrap}>
          <View style={styles.totals}>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Total netto</Text>
              <Text style={styles.totalValue}>CHF {chf(props.netTotal)}</Text>
            </View>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>MWST {props.vatRate.toFixed(1)} %</Text>
              <Text style={styles.totalValue}>CHF {chf(props.vatAmount)}</Text>
            </View>
            <View style={styles.grandRow}>
              <Text style={styles.grandLabel}>Gesamtbetrag</Text>
              <Text style={styles.grandValue}>CHF {chf(props.grossTotal)}</Text>
            </View>
          </View>
        </View>

        <View style={styles.note} wrap={false}>
          <Text style={{ fontFamily: 'Helvetica-Bold', color: COLORS.ink, marginBottom: 3 }}>
            Gut zu wissen
          </Text>
          <Text>
            Bezahlt wird erst nach dem Einsatz — per QR-Rechnung mit 30 Tagen Frist oder online.
            Bis 24 Stunden vor dem Termin verschieben oder stornieren Sie kostenlos.
          </Text>
          <Text style={{ marginTop: 4 }}>Buchung verwalten: {props.manageUrl}</Text>
        </View>

        <Footer company={company} label={`${title} ${props.number}`} />
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

// ---------------------------------------------------------------------------
//  Vertragsfassung
// ---------------------------------------------------------------------------

export interface ContractVersionPdfProps {
  company: PdfCompany;
  recipient: PdfRecipient;
  /** Leer, solange der Vertrag noch nicht in Kraft ist — die Nummer entsteht erst dann. */
  contractNumber: string | null;
  title: string;
  versionNumber: number;
  /** Warum es diese Fassung gibt. Steht im Dokument, nicht nur in der Akte. */
  reason: string;
  effectiveFrom: Date;
  endDate?: Date | null;
  objekt?: string | null;
  konditionen: { label: string; value: string }[];
  leistungen: { label: string; menge: string | null; rhythmus: string | null }[];
  terms?: string | null;
}

/**
 * Was bei einer Vertragsannahme unterzeichnet wird.
 *
 * **Eine Fassung, kein Vertrag.** Der Titel nennt ausdrücklich die
 * Versionsnummer, und die Konditionen stehen ausgeschrieben im Dokument.
 * Unterzeichnet wird damit ein bestimmter Stand, nicht ein Verweis auf einen
 * Datensatz, der sich danach ändern könnte — genau das, was die Versionierung
 * verhindern soll.
 *
 * **Keine Rechtsbehauptung.** Das Dokument sagt nicht, welche Beweiskraft die
 * Unterschrift hat; es nennt den Hergang. Eine Aussage über QES oder ZertES
 * steht hier so wenig wie anderswo im Produkt.
 */
export function ContractVersionDocument(props: ContractVersionPdfProps) {
  const { company, recipient } = props;
  const bezeichnung = props.contractNumber
    ? `Vertrag ${props.contractNumber}`
    : 'Vertrag (Nummer bei Inkraftsetzung)';

  return (
    <Document title={`${bezeichnung} — Fassung ${props.versionNumber}`} author={company.name} creator="Clenaris">
      <Page size="A4" style={styles.page}>
        <Header company={company} />

        <View style={styles.addressRow}>
          <RecipientBlock recipient={recipient} />
          <MetaBlock
            rows={[
              { label: 'Vertrag', value: props.contractNumber ?? '—' },
              { label: 'Fassung', value: String(props.versionNumber) },
              { label: 'Gültig ab', value: formatDate(props.effectiveFrom) },
              ...(props.endDate ? [{ label: 'Befristet bis', value: formatDate(props.endDate) }] : []),
            ]}
          />
        </View>

        <Text style={styles.title}>{bezeichnung}</Text>
        <Text style={styles.subtitle}>
          {props.title}
          {props.objekt ? ` · ${props.objekt}` : ''}
        </Text>

        <Text style={styles.paragraph}>
          Fassung {props.versionNumber} · {props.reason}
        </Text>

        <Text style={[styles.th, { marginTop: 14, marginBottom: 6 }]}>KONDITIONEN</Text>
        {props.konditionen.map((row, i) => (
          <View key={i} style={styles.tableRow} wrap={false}>
            <Text style={[styles.td, { width: '45%' }]}>{row.label}</Text>
            <Text style={[styles.td, { width: '55%' }]}>{row.value}</Text>
          </View>
        ))}

        <Text style={[styles.th, { marginTop: 18, marginBottom: 6 }]}>VEREINBARTE LEISTUNGEN</Text>
        {props.leistungen.map((leistung, i) => (
          <View key={i} style={styles.tableRow} wrap={false}>
            <View style={{ width: '60%' }}>
              <Text style={styles.itemName}>{leistung.label}</Text>
              {leistung.rhythmus ? <Text style={styles.itemDesc}>{leistung.rhythmus}</Text> : null}
            </View>
            <Text style={[styles.td, { width: '40%', textAlign: 'right' }]}>{leistung.menge ?? '—'}</Text>
          </View>
        ))}

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
            <Text style={styles.signatureLabel}>Auftraggeber/in</Text>
            <View style={[styles.signatureLine, { marginTop: 42 }]}>
              <Text style={styles.signatureLabel}>Ort, Datum, Unterschrift</Text>
            </View>
          </View>
        </View>

        <Footer company={company} label={`${bezeichnung} · Fassung ${props.versionNumber}`} />
      </Page>
    </Document>
  );
}

// ---------------------------------------------------------------------------
//  Signaturprotokoll
// ---------------------------------------------------------------------------

export interface EvidenceParticipant {
  name: string;
  email: string;
  method: 'DRAWN' | 'TYPED' | null;
  signedName: string | null;
  signedAt: Date | null;
  authenticationMethod: string | null;
  consentText: string | null;
  consentHash: string | null;
  consentVersion: string | null;
  consentLocale: string | null;
  consentAcceptedAt: Date | null;
  signatureArtifactHash: string | null;
  ipAddress: string | null;
  ipSource: string | null;
  userAgent: string | null;
  otp: { channel: string; sentTo: string; requestedAt: Date; verifiedAt: Date | null }[];
}

export interface EvidenceEvent {
  at: Date;
  type: string;
  participant: string | null;
  /** Kurze sachliche Ergänzung aus den Details, z. B. der Zugangsweg. */
  note?: string | null;
}

/** Woher die handelnde Person kam — ohne Anspruch auf mehr Identitätssicherheit. */
const ACTOR_SOURCE_TEXT: Record<string, string> = {
  PUBLIC_LINK: 'über den zugestellten Link',
  AUTHENTICATED_CUSTOMER: 'aus dem angemeldeten Kundenkonto (Sitzung, keine zusätzliche Identitätsprüfung)',
};

export function actorSourceText(source: string | null | undefined): string | null {
  return source ? (ACTOR_SOURCE_TEXT[source] ?? source) : null;
}

export interface EvidencePdfProps {
  company: PdfCompany;
  requestId: string;
  publicId: string;
  title: string;
  sourceType: string;
  sourceReference: string;
  artifactMode: 'EMBEDDED_VISUAL' | 'DETACHED_EVIDENCE';
  assuranceLevel: string;
  originalArtifactId: string;
  originalHash: string;
  signedArtifactId: string | null;
  signedHash: string | null;
  createdAt: Date;
  completedAt: Date | null;
  participants: EvidenceParticipant[];
  events: EvidenceEvent[];
  /** Zeitpunkt der Erzeugung dieses Protokolls — Serverzeit, kein Zeitstempeldienst. */
  generatedAt: Date;
}

const ASSURANCE_TEXT: Record<string, string> = {
  LINK_ONLY: 'Besitz des zugestellten Links',
  LINK_PLUS_EMAIL_CODE: 'Besitz des Links und Bestätigungscode an dieselbe E-Mail-Adresse (derselbe Kanal)',
  LINK_PLUS_SMS_CODE: 'Besitz des Links und Bestätigungscode an die hinterlegte Mobilnummer',
};

const EVENT_TEXT: Record<string, string> = {
  REQUEST_CREATED: 'Vorgang angelegt',
  LINK_ISSUED: 'Link ausgestellt',
  LINK_EXCHANGED: 'Link geöffnet, Sitzung begonnen',
  DOCUMENT_VIEWED: 'Dokument angesehen',
  OTP_REQUESTED: 'Bestätigungscode angefordert',
  OTP_VERIFIED: 'Bestätigungscode bestätigt',
  OTP_FAILED: 'Bestätigungscode falsch',
  CONSENT_ACCEPTED: 'Zustimmung erteilt',
  SIGNATURE_SUBMITTED: 'Unterschrift übermittelt',
  FINALIZATION_STARTED: 'Abschluss begonnen',
  INTEGRITY_FAILED: 'Prüfsumme des Originals stimmte nicht — Abschluss abgebrochen',
  SIGNED: 'Unterzeichnet',
  DECLINED: 'Abgelehnt',
  CANCELLED: 'Abgebrochen',
  EXPIRED: 'Abgelaufen',
  ARTIFACT_CREATED: 'Artefakt erzeugt',
  REQUEST_COMPLETED: 'Vorgang abgeschlossen',
  RESULT_LINK_ISSUED: 'Ergebnislink ausgestellt',
  RESULT_VIEWED: 'Ergebnis angesehen',
};

function zuerich(d: Date): string {
  return `${new Intl.DateTimeFormat('de-CH', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'Europe/Zurich',
  }).format(d)} (Europe/Zurich) · ${d.toISOString()} (UTC)`;
}

/**
 * Das Signaturprotokoll.
 *
 * **Was es enthält:** Prüfsumme A des Originals, Prüfsumme B des signierten
 * Artefakts (falls vorhanden), wer wann womit unterzeichnet hat, der exakte
 * Wortlaut der Zustimmung samt Prüfsumme, die technischen Angaben mit ihrer
 * Quelle, der Ablauf. **Was es nicht enthält:** seine eigene Prüfsumme C —
 * ein Dokument kann seinen eigenen Hash nicht tragen. C wird über die
 * gespeicherten Bytes dieses PDF gebildet und in der Datenbank gehalten.
 *
 * Es sagt „Code bestätigt", „Adresse laut Proxy", „Browser-Angabe" — nie
 * „Identität verifiziert", nie „qualifizierter Zeitstempel".
 */
const ev = {
  section: { marginBottom: 14 },
  sectionTitle: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: COLORS.ink, letterSpacing: 0.6, marginBottom: 4 },
  body: { fontSize: 9.5, color: COLORS.ink },
  meta: { fontSize: 8.5, color: COLORS.muted, lineHeight: 1.5 },
} as const;

export function EvidenceDocument(props: EvidencePdfProps) {
  const { company } = props;
  const mono = { fontFamily: 'Courier', fontSize: 7 } as const;
  return (
    <Document title={`Signaturprotokoll ${props.publicId}`} author={company.name}>
      <Page size="A4" style={styles.page}>
        <Header company={company} />
        <Text style={styles.title}>Signaturprotokoll</Text>
        <Text style={styles.subtitle}>Vorgang {props.publicId}</Text>

        <View style={ev.section}>
          <Text style={ev.sectionTitle}>Dokument</Text>
          <Text style={ev.body}>{props.title}</Text>
          <Text style={ev.meta}>
            Quelle: {props.sourceType} · {props.sourceReference}
          </Text>
          <Text style={ev.meta}>
            Modus: {props.artifactMode === 'EMBEDDED_VISUAL'
              ? 'Signiertes Artefakt mit sichtbarer Unterschrift'
              : 'Elektronisch bestätigtes Dokument mit separatem Signaturprotokoll — das Original bleibt bytegenau unverändert'}
          </Text>
          <Text style={ev.meta}>Prüfstufe: {ASSURANCE_TEXT[props.assuranceLevel] ?? props.assuranceLevel}</Text>
        </View>

        <View style={ev.section}>
          <Text style={ev.sectionTitle}>Prüfsummen (SHA-256)</Text>
          <Text style={ev.meta}>Original · {props.originalArtifactId}</Text>
          <Text style={mono}>{props.originalHash}</Text>
          {props.signedArtifactId ? (
            <>
              <Text style={[ev.meta, { marginTop: 4 }]}>Signiertes Artefakt · {props.signedArtifactId}</Text>
              <Text style={mono}>{props.signedHash}</Text>
            </>
          ) : (
            <Text style={[ev.meta, { marginTop: 4 }]}>Kein signiertes Artefakt (Modus ohne Einbettung).</Text>
          )}
          <Text style={[ev.meta, { marginTop: 4 }]}>
            Die Prüfsumme dieses Protokolls wird über seine gespeicherten Bytes gebildet und in Clenaris
            gehalten; sie steht nicht in diesem Dokument.
          </Text>
        </View>

        {props.participants.map((p, i) => (
          <View key={i} style={ev.section} wrap={false}>
            <Text style={ev.sectionTitle}>Unterzeichnende Person {props.participants.length > 1 ? i + 1 : ''}</Text>
            <Text style={ev.body}>{p.name}</Text>
            <Text style={ev.meta}>Link zugestellt an: {p.email}</Text>
            {p.signedAt ? (
              <>
                <Text style={ev.meta}>Unterzeichnet: {zuerich(p.signedAt)}</Text>
                <Text style={ev.meta}>
                  Methode: {p.method === 'DRAWN' ? 'gezeichnet' : 'getippt'} · eingegebener Name: {p.signedName}
                </Text>
                {p.signatureArtifactHash ? (
                  <Text style={ev.meta}>Prüfsumme des Unterschriftsbilds: {p.signatureArtifactHash}</Text>
                ) : null}
                <Text style={ev.meta}>
                  Geprüft: {ASSURANCE_TEXT[p.authenticationMethod ?? ''] ?? p.authenticationMethod}
                </Text>
              </>
            ) : (
              <Text style={ev.meta}>Nicht unterzeichnet.</Text>
            )}
            {p.otp.map((o, j) => (
              <Text key={j} style={ev.meta}>
                Code per {o.channel === 'SMS' ? 'SMS' : 'E-Mail'} an {o.sentTo}, angefordert {zuerich(o.requestedAt)}
                {o.verifiedAt ? `, bestätigt ${zuerich(o.verifiedAt)}` : ', nicht bestätigt'}
              </Text>
            ))}
            {p.consentText ? (
              <>
                <Text style={[ev.meta, { marginTop: 4 }]}>
                  Zustimmung ({p.consentVersion}, {p.consentLocale}) erteilt {p.consentAcceptedAt ? zuerich(p.consentAcceptedAt) : ''}:
                </Text>
                <Text style={[ev.body, { fontStyle: 'italic' }]}>„{p.consentText}“</Text>
                <Text style={mono}>{p.consentHash}</Text>
              </>
            ) : null}
            <Text style={[ev.meta, { marginTop: 4 }]}>
              Adresse: {p.ipAddress ?? 'nicht verfügbar'} (Quelle: {p.ipSource ?? 'UNAVAILABLE'}) — technisches Metadatum, kein Identitätsnachweis
            </Text>
            {p.userAgent ? <Text style={ev.meta}>Browser-Angabe (vom Gerät gemeldet): {p.userAgent}</Text> : null}
          </View>
        ))}

        <View style={ev.section}>
          <Text style={ev.sectionTitle}>Ablauf</Text>
          {props.events.map((e, i) => (
            <Text key={i} style={ev.meta}>
              {zuerich(e.at)} — {EVENT_TEXT[e.type] ?? e.type}
              {e.participant ? ` (${e.participant})` : ''}
              {e.note ? ` — ${e.note}` : ''}
            </Text>
          ))}
        </View>

        <View style={styles.note}>
          <Text>
            Erstellt am {zuerich(props.generatedAt)} aus den in Clenaris gespeicherten Daten. Zeiten sind
            Systemzeit des Servers, kein qualifizierter Zeitstempel. Dieses Protokoll dokumentiert einen
            elektronischen Unterzeichnungsablauf; es ist keine qualifizierte elektronische Signatur.
          </Text>
        </View>

        <Footer company={company} label={`Signaturprotokoll ${props.publicId}`} />
      </Page>
    </Document>
  );
}
