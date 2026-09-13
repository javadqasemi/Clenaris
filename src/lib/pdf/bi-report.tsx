import React from 'react';
import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';

import { formatDate } from '@/lib/utils';
import { formatKpiValue, HEALTH_STATUS_LABELS } from '@/lib/bi/labels';
import type { ReportContent } from '@/server/services/bi-report.service';

/**
 * Führungsbericht als PDF.
 *
 * Dieselbe Bibliothek wie Rechnung und Offerte, dieselbe Typografie. Der
 * Bericht ist bewusst nüchtern: Tabellen und kurze Sätze, keine Diagramme.
 * Ein Balkendiagramm in einem PDF, das jemand auf dem Telefon öffnet, ist
 * unlesbar; eine Tabelle mit Vorperiode und Ziel daneben nicht.
 */

const C = { ink: '#0F172A', body: '#334155', muted: '#64748B', line: '#E2E8F0', soft: '#F8FAFC', brand: '#0B7285', warn: '#B45309', bad: '#B91C1C', good: '#047857' };

const s = StyleSheet.create({
  page: { paddingTop: 44, paddingHorizontal: 48, paddingBottom: 56, fontSize: 9.5, fontFamily: 'Helvetica', color: C.body, lineHeight: 1.45 },
  brand: { fontSize: 16, fontFamily: 'Helvetica-Bold', color: C.brand, marginBottom: 2 },
  kicker: { fontSize: 8, color: C.muted, letterSpacing: 0.6, marginBottom: 14 },
  title: { fontSize: 19, fontFamily: 'Helvetica-Bold', color: C.ink, marginBottom: 4 },
  subtitle: { fontSize: 10, color: C.muted, marginBottom: 18 },
  h2: { fontSize: 11.5, fontFamily: 'Helvetica-Bold', color: C.ink, marginTop: 16, marginBottom: 8, paddingBottom: 4, borderBottomWidth: 1, borderBottomColor: C.ink },
  para: { marginBottom: 8 },
  scoreRow: { flexDirection: 'row', gap: 16, marginBottom: 6 },
  scoreBox: { width: 110, padding: 10, backgroundColor: C.soft, borderRadius: 6 },
  scoreNum: { fontSize: 26, fontFamily: 'Helvetica-Bold', color: C.ink },
  scoreLabel: { fontSize: 8, color: C.muted },
  row: { flexDirection: 'row', paddingVertical: 4.5, borderBottomWidth: 0.5, borderBottomColor: C.line },
  head: { flexDirection: 'row', paddingBottom: 4, marginBottom: 2, borderBottomWidth: 1, borderBottomColor: C.ink },
  th: { fontSize: 7.5, fontFamily: 'Helvetica-Bold', color: C.ink },
  td: { fontSize: 9 },
  c1: { width: '38%' },
  c2: { width: '17%', textAlign: 'right' },
  c3: { width: '17%', textAlign: 'right' },
  c4: { width: '14%', textAlign: 'right' },
  c5: { width: '14%', textAlign: 'right' },
  bullet: { flexDirection: 'row', marginBottom: 4 },
  dot: { width: 10 },
  footer: { position: 'absolute', bottom: 28, left: 48, right: 48, flexDirection: 'row', justifyContent: 'space-between', fontSize: 7.5, color: C.muted },
});

function pct(value: number | null): string {
  if (value === null) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)} %`;
}

export function BiReportDocument({ content }: { content: ReportContent }) {
  return (
    <Document title={content.title} author={content.company} language="de">
      <Page size="A4" style={s.page}>
        <Text style={s.brand}>{content.company}</Text>
        <Text style={s.kicker}>FÜHRUNGSBERICHT · VERTRAULICH</Text>
        <Text style={s.title}>{content.title}</Text>
        <Text style={s.subtitle}>
          {formatDate(content.periodStart)} – {formatDate(content.periodEnd)} · erstellt am {formatDate(content.generatedAt)}
        </Text>

        {content.health ? (
          <View>
            <Text style={s.h2}>Gesundheitswert</Text>
            <View style={s.scoreRow}>
              <View style={s.scoreBox}>
                <Text style={s.scoreNum}>{content.health.score}</Text>
                <Text style={s.scoreLabel}>{HEALTH_STATUS_LABELS[content.health.status] ?? content.health.status} · von 100</Text>
              </View>
              <View style={{ flex: 1 }}>
                {content.health.topRisk ? <Text style={s.para}>Grösster Hebel: {content.health.topRisk}</Text> : null}
                {content.health.components.map((c) => (
                  <Text key={c.key} style={{ fontSize: 8.5, color: C.muted }}>
                    {c.label}: {c.subScore === null ? '—' : `${c.subScore} Punkte`} (Gewicht {c.weight})
                  </Text>
                ))}
              </View>
            </View>
          </View>
        ) : null}

        {content.sections.map((section) => (
          <View key={section.title} wrap={false}>
            <Text style={s.h2}>{section.title}</Text>
            <View style={s.head}>
              <Text style={[s.th, s.c1]}>Kennzahl</Text>
              <Text style={[s.th, s.c2]}>Wert</Text>
              <Text style={[s.th, s.c3]}>Vorperiode</Text>
              <Text style={[s.th, s.c4]}>Δ</Text>
              <Text style={[s.th, s.c5]}>Ziel</Text>
            </View>
            {section.rows.map((row) => (
              <View key={row.key} style={s.row}>
                <Text style={[s.td, s.c1]}>{row.label}</Text>
                <Text style={[s.td, s.c2, { fontFamily: 'Helvetica-Bold', color: C.ink }]}>{formatKpiValue(row.value, row.unit)}</Text>
                <Text style={[s.td, s.c3]}>{formatKpiValue(row.previous, row.unit)}</Text>
                <Text style={[s.td, s.c4, { color: row.changePct === null ? C.muted : (row.changePct >= 0) === (row.direction === 'UP_IS_GOOD') ? C.good : C.bad }]}>
                  {pct(row.changePct)}
                </Text>
                <Text style={[s.td, s.c5]}>{formatKpiValue(row.target, row.unit)}</Text>
              </View>
            ))}
            {section.rows.length === 0 ? <Text style={{ color: C.muted }}>Für diesen Zeitraum liegen keine Werte vor.</Text> : null}
          </View>
        ))}

        {content.objectives.length > 0 ? (
          <View wrap={false}>
            <Text style={s.h2}>Ziele</Text>
            {content.objectives.map((o) => (
              <View key={o.title} style={s.bullet}>
                <Text style={s.dot}>•</Text>
                <Text style={{ flex: 1 }}>
                  {o.title} — {o.progressPct} % ({o.status}){o.owner ? `, ${o.owner}` : ''}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {content.risks.length > 0 ? (
          <View wrap={false}>
            <Text style={s.h2}>Grösste Risiken</Text>
            {content.risks.map((r) => (
              <View key={r.title} style={s.bullet}>
                <Text style={s.dot}>•</Text>
                <Text style={{ flex: 1 }}>
                  {r.title} — Schwere {r.severity} ({r.band}){r.owner ? `, ${r.owner}` : ''}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {content.insights.length > 0 ? (
          <View wrap={false}>
            <Text style={s.h2}>Auffälligkeiten</Text>
            {content.insights.map((i) => (
              <View key={i.title} style={s.bullet}>
                <Text style={[s.dot, { color: i.severity === 'critical' ? C.bad : i.severity === 'warning' ? C.warn : C.muted }]}>•</Text>
                <Text style={{ flex: 1 }}>
                  {i.title}. {i.detail}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        <View style={s.footer} fixed>
          <Text>{content.company} · Führungsbericht</Text>
          <Text render={({ pageNumber, totalPages }) => `Seite ${pageNumber} von ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
