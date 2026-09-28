import React from 'react';
import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';

import { monatsname } from '../payroll/monate';

import type { PdfCompany } from './documents';

/**
 * Lohnabrechnung und Lohnausweis-Aufstellung als PDF (Wave 9, 2026-09-23).
 *
 * **Eigene Datei statt Anbau an `documents.tsx`.** Dort stehen die
 * Kundendokumente mit QR-Zahlteil; die Lohndokumente teilen nur Farben und
 * Schrift. Eine Datei, die beides enthält, wäre eine, in der eine Änderung an
 * der Rechnung die Lohnabrechnung mitverschiebt.
 *
 * **Nur aus eingefrorenen Daten.** Die Komponenten bekommen die Zeilen der
 * Abrechnung, wie sie in `payslip_lines` stehen — sie rechnen nichts. Das
 * PDF entsteht einmal, beim Veröffentlichen, und wird danach nur noch
 * ausgeliefert, nie neu erzeugt.
 *
 * **Keine AHV-Nummer, keine IBAN.** Die Abrechnung braucht sie nicht, um
 * nachvollziehbar zu sein, und ein PDF wandert — in Mails, auf Drucker, in
 * Ablagen. Was nicht darauf steht, kann dort nicht abhandenkommen.
 */

const COLORS = {
  ink: '#0F172A',
  body: '#334155',
  muted: '#64748B',
  line: '#E2E8F0',
  soft: '#F8FAFC',
  brand: '#0B7285',
  warn: '#9A3412',
};

const s = StyleSheet.create({
  page: { paddingTop: 40, paddingHorizontal: 48, paddingBottom: 60, fontSize: 9.5, fontFamily: 'Helvetica', color: COLORS.body, lineHeight: 1.5 },
  kopf: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 24 },
  firma: { fontSize: 15, fontFamily: 'Helvetica-Bold', color: COLORS.brand },
  firmaAdresse: { fontSize: 8.5, color: COLORS.muted, textAlign: 'right' },
  titel: { fontSize: 18, fontFamily: 'Helvetica-Bold', color: COLORS.ink, marginBottom: 4 },
  untertitel: { fontSize: 10, color: COLORS.muted, marginBottom: 16 },
  meta: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 18 },
  metaSpalte: { width: '48%' },
  metaLabel: { fontSize: 7.5, color: COLORS.muted, letterSpacing: 0.5 },
  metaWert: { fontSize: 10, color: COLORS.ink },
  abschnitt: { fontSize: 7.5, fontFamily: 'Helvetica-Bold', color: COLORS.ink, letterSpacing: 0.6, marginTop: 12, marginBottom: 4 },
  zeile: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: COLORS.line, paddingVertical: 4 },
  bez: { width: '52%' },
  menge: { width: '14%', textAlign: 'right' },
  satz: { width: '14%', textAlign: 'right' },
  betrag: { width: '20%', textAlign: 'right' },
  summe: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 6, marginTop: 4, borderTopWidth: 1, borderTopColor: COLORS.ink },
  summeLabel: { fontSize: 10, fontFamily: 'Helvetica-Bold', color: COLORS.ink },
  auszahlung: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 8, marginTop: 10, borderTopWidth: 1.5, borderTopColor: COLORS.ink },
  auszahlungText: { fontSize: 12, fontFamily: 'Helvetica-Bold', color: COLORS.ink },
  hinweis: { marginTop: 16, padding: 10, backgroundColor: COLORS.soft, borderRadius: 4, fontSize: 8, color: COLORS.body },
  warnung: { marginTop: 8, padding: 8, borderWidth: 0.75, borderColor: COLORS.warn, borderRadius: 4, fontSize: 8, color: COLORS.warn },
  fuss: { position: 'absolute', bottom: 24, left: 48, right: 48, borderTopWidth: 0.5, borderTopColor: COLORS.line, paddingTop: 8, flexDirection: 'row', justifyContent: 'space-between', fontSize: 7.5, color: COLORS.muted },
});

function chf(wert: number): string {
  return wert.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}


function Kopf({ company }: { company: PdfCompany }) {
  return (
    <View style={s.kopf}>
      <Text style={s.firma}>{company.name}</Text>
      <View style={s.firmaAdresse}>
        <Text>{company.name}</Text>
        <Text>{company.street}</Text>
        <Text>
          {company.postalCode} {company.city}
        </Text>
      </View>
    </View>
  );
}

function Fuss({ company, label }: { company: PdfCompany; label: string }) {
  return (
    <View style={s.fuss} fixed>
      <Text>{company.name} · vertraulich</Text>
      <Text render={({ pageNumber, totalPages }) => `${label} · Seite ${pageNumber}/${totalPages}`} />
    </View>
  );
}

// ---------------------------------------------------------------------------
//  Lohnabrechnung
// ---------------------------------------------------------------------------

export interface PayslipPdfLine {
  kind: 'EARNING' | 'PAYMENT' | 'DEDUCTION' | 'EMPLOYER';
  label: string;
  quantity: number | null;
  rate: number | null;
  amount: number;
}

export interface PayslipPdfProps {
  company: PdfCompany;
  person: { name: string; employeeNumber: string; street?: string | null; postalCode?: string | null; city?: string | null };
  year: number;
  month: number;
  publishedAt: Date;
  lines: PayslipPdfLine[];
  grossPay: number;
  netPay: number;
  hours: number;
  /** Die Beitragssätze waren beim Veröffentlichen nicht fachlich bestätigt. */
  unverifiedRates: boolean;
}

function Zeilen({ zeilen, mitVorzeichen }: { zeilen: PayslipPdfLine[]; mitVorzeichen?: boolean }) {
  return (
    <>
      {zeilen.map((z, i) => (
        <View key={`${z.label}-${i}`} style={s.zeile} wrap={false}>
          <Text style={s.bez}>{z.label}</Text>
          <Text style={s.menge}>{z.quantity !== null ? z.quantity.toLocaleString('de-CH', { maximumFractionDigits: 2 }) : ''}</Text>
          <Text style={s.satz}>{z.rate !== null ? `${z.rate.toLocaleString('de-CH', { maximumFractionDigits: 4 })}` : ''}</Text>
          <Text style={s.betrag}>{mitVorzeichen ? `− ${chf(z.amount)}` : chf(z.amount)}</Text>
        </View>
      ))}
    </>
  );
}

export function PayslipDocument(p: PayslipPdfProps) {
  const lohn = p.lines.filter((z) => z.kind === 'EARNING');
  const abzuege = p.lines.filter((z) => z.kind === 'DEDUCTION');
  const zahlungen = p.lines.filter((z) => z.kind === 'PAYMENT');
  const arbeitgeber = p.lines.filter((z) => z.kind === 'EMPLOYER');
  const titel = `Lohnabrechnung ${monatsname(p.month)} ${p.year}`;

  return (
    <Document title={titel} author={p.company.name} subject={titel} creator="Clenaris">
      <Page size="A4" style={s.page}>
        <Kopf company={p.company} />
        <Text style={s.titel}>{titel}</Text>
        <Text style={s.untertitel}>Veröffentlicht am {p.publishedAt.toLocaleDateString('de-CH', { timeZone: 'Europe/Zurich' })}</Text>

        <View style={s.meta}>
          <View style={s.metaSpalte}>
            <Text style={s.metaLabel}>MITARBEITENDE PERSON</Text>
            <Text style={s.metaWert}>{p.person.name}</Text>
            {p.person.street ? <Text style={s.metaWert}>{p.person.street}</Text> : null}
            {p.person.postalCode || p.person.city ? (
              <Text style={s.metaWert}>
                {p.person.postalCode ?? ''} {p.person.city ?? ''}
              </Text>
            ) : null}
          </View>
          <View style={s.metaSpalte}>
            <Text style={s.metaLabel}>PERSONALNUMMER</Text>
            <Text style={s.metaWert}>{p.person.employeeNumber}</Text>
            <Text style={s.metaLabel}>ERFASSTE STUNDEN</Text>
            <Text style={s.metaWert}>{p.hours.toLocaleString('de-CH', { maximumFractionDigits: 2 })}</Text>
          </View>
        </View>

        <Text style={s.abschnitt}>LOHN</Text>
        <Zeilen zeilen={lohn} />
        <View style={s.summe}>
          <Text style={s.summeLabel}>Bruttolohn</Text>
          <Text style={s.summeLabel}>CHF {chf(p.grossPay)}</Text>
        </View>

        {abzuege.length > 0 ? (
          <>
            <Text style={s.abschnitt}>ABZÜGE</Text>
            <Zeilen zeilen={abzuege} mitVorzeichen />
          </>
        ) : null}

        {zahlungen.length > 0 ? (
          <>
            <Text style={s.abschnitt}>SPESEN, ZULAGEN UND KORREKTUREN OHNE BEITRÄGE</Text>
            <Zeilen zeilen={zahlungen} />
          </>
        ) : null}

        <View style={s.auszahlung}>
          <Text style={s.auszahlungText}>Auszahlung</Text>
          <Text style={s.auszahlungText}>CHF {chf(p.netPay)}</Text>
        </View>

        {arbeitgeber.length > 0 ? (
          <>
            <Text style={s.abschnitt}>BEITRÄGE DES BETRIEBS (ZUR INFORMATION)</Text>
            <Zeilen zeilen={arbeitgeber} />
          </>
        ) : null}

        <Text style={s.hinweis}>
          Diese Abrechnung wurde aus freigegebenen Zeiten, dem Lohnstamm und den zum Monatsende gültigen Beitragssätzen
          erstellt. Sie ist mit der Veröffentlichung abgeschlossen; Korrekturen erscheinen auf einer späteren Abrechnung.
        </Text>
        {p.unverifiedRates ? (
          <Text style={s.warnung}>
            Hinweis: Mindestens ein angewandter Beitragssatz war zum Zeitpunkt der Veröffentlichung nicht fachlich
            bestätigt.
          </Text>
        ) : null}
        <Fuss company={p.company} label={titel} />
      </Page>
    </Document>
  );
}

// ---------------------------------------------------------------------------
//  Lohnausweis-Aufstellung
// ---------------------------------------------------------------------------

export interface SalaryCertificatePdfProps {
  company: PdfCompany;
  person: { name: string; employeeNumber: string };
  year: number;
  version: number;
  periodFrom: Date;
  periodTo: Date;
  finalizedAt: Date | null;
  felder: { ziffer: string; bezeichnung: string; betrag: number }[];
  quellensteuerAbgezogen: boolean;
}

export function SalaryCertificateDocument(p: SalaryCertificatePdfProps) {
  const titel = `Lohnausweis-Aufstellung ${p.year}`;
  return (
    <Document title={titel} author={p.company.name} subject={titel} creator="Clenaris">
      <Page size="A4" style={s.page}>
        <Kopf company={p.company} />
        <Text style={s.titel}>{titel}</Text>
        <Text style={s.untertitel}>
          Version {p.version} · {p.finalizedAt ? `abgeschlossen am ${p.finalizedAt.toLocaleDateString('de-CH', { timeZone: 'Europe/Zurich' })}` : 'Entwurf'}
        </Text>

        <Text style={s.warnung}>
          Dies ist eine Aufstellung aus den veröffentlichten Lohnabrechnungen, nicht das amtliche Formular 11
          (Lohnausweis). Die Zuordnung zu den Ziffern ist fachlich zu prüfen, bevor die Werte in den amtlichen
          Lohnausweis übernommen werden.
        </Text>

        <View style={[s.meta, { marginTop: 14 }]}>
          <View style={s.metaSpalte}>
            <Text style={s.metaLabel}>MITARBEITENDE PERSON</Text>
            <Text style={s.metaWert}>{p.person.name}</Text>
            <Text style={s.metaLabel}>PERSONALNUMMER</Text>
            <Text style={s.metaWert}>{p.person.employeeNumber}</Text>
          </View>
          <View style={s.metaSpalte}>
            <Text style={s.metaLabel}>ZEITRAUM</Text>
            <Text style={s.metaWert}>
              {p.periodFrom.toLocaleDateString('de-CH', { timeZone: 'UTC' })} – {p.periodTo.toLocaleDateString('de-CH', { timeZone: 'UTC' })}
            </Text>
            <Text style={s.metaLabel}>QUELLENSTEUER</Text>
            <Text style={s.metaWert}>{p.quellensteuerAbgezogen ? 'abgezogen' : 'keine'}</Text>
          </View>
        </View>

        <Text style={s.abschnitt}>ZIFFERN</Text>
        {p.felder.map((f) => (
          <View key={f.ziffer} style={s.zeile} wrap={false}>
            <Text style={{ width: '14%' }}>{f.ziffer}</Text>
            <Text style={{ width: '62%' }}>{f.bezeichnung}</Text>
            <Text style={{ width: '24%', textAlign: 'right' }}>CHF {chf(f.betrag)}</Text>
          </View>
        ))}
        <Fuss company={p.company} label={titel} />
      </Page>
    </Document>
  );
}
