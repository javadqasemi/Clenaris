import type { Metadata } from 'next';
import Link from 'next/link';
import { Download } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { toNumber } from '@/lib/db';
import { formatCurrency, formatDateTime } from '@/lib/utils';
import { monatsname } from '@/lib/payroll/monate';
import { getOrganizationId } from '@/server/services/organization.service';
import { getPayslip } from '@/server/services/payroll.service';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { DetailRow, DetailSection, PageHeader } from '@/components/app/page-parts';

export const metadata: Metadata = {
  title: 'Lohnabrechnung',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const ABSCHNITTE = [
  { kind: 'EARNING', titel: 'Lohn' },
  { kind: 'DEDUCTION', titel: 'Abzüge' },
  { kind: 'PAYMENT', titel: 'Spesen, Zulagen und Korrekturen ohne Beiträge' },
  { kind: 'EMPLOYER', titel: 'Beiträge des Betriebs (zur Information)' },
] as const;

/**
 * Eine Abrechnung mit allen Zeilen und der Herleitung — die Ansicht, mit der
 * eine Abrechnung vor dem Veröffentlichen geprüft wird. Bis 2026-09-23 gab
 * es sie nur als JSON über die Schnittstelle.
 *
 * Die Satzversionen stehen als Momentaufnahme in der Herleitung: So zeigt die
 * Seite, womit **gerechnet wurde**, nicht, was heute gilt.
 */
export default async function PayslipDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('payslip:read_all');
  const { id } = await params;
  const p = await getPayslip({ organizationId: await getOrganizationId(), payslipId: id });
  const herleitung = (p.breakdown ?? {}) as {
    satzversionen?: Record<string, { gueltigAb: string; arbeitnehmerPct: number; arbeitgeberPct: number; quelle: string; pruefstand: string }>;
    quellensteuer?: { status?: string; tarif?: string; kanton?: string; quelle?: string; bemessung?: number };
    hochrechnungJahr?: number;
    bvgKoordinierterJahreslohn?: number;
  };

  return (
    <div className="space-y-8">
      <PageHeader
        title={`${p.employee.user.firstName} ${p.employee.user.lastName} — ${monatsname(p.month)} ${p.year}`}
        description={`Personalnummer ${p.employee.employeeNumber}`}
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={`/admin/lohn?jahr=${p.year}&monat=${p.month}`}>Zum Monat</Link>
            </Button>
            {p.published && p.pdfFileId ? (
              <Button asChild size="sm">
                <a href={`/api/payroll/payslips/${p.id}/pdf`} download>
                  <Download aria-hidden /> PDF
                </a>
              </Button>
            ) : null}
          </>
        }
      />

      {p.reviewRequired && !p.reviewResolvedAt ? <Alert variant="warning">{p.reviewReason}</Alert> : null}
      {p.unverifiedRates ? (
        <Alert variant="info">Gerechnet mit mindestens einem Beitragssatz oder Tarif, der nicht fachlich bestätigt ist.</Alert>
      ) : null}

      <DetailSection title="Stand" body="list">
        <DetailRow label="Status">
          {p.published ? <Badge variant="success">Veröffentlicht {p.publishedAt ? formatDateTime(p.publishedAt) : ''}</Badge> : <Badge variant="neutral">Entwurf</Badge>}
        </DetailRow>
        <DetailRow label="Bruttolohn">{formatCurrency(toNumber(p.grossPay))}</DetailRow>
        <DetailRow label="Auszahlung">{formatCurrency(toNumber(p.netPay))}</DetailRow>
        <DetailRow label="Beiträge des Betriebs">{formatCurrency(toNumber(p.employerContributions))}</DetailRow>
        {p.reviewResolvedAt ? <DetailRow label="Prüfung">{p.reviewNote}</DetailRow> : null}
      </DetailSection>

      {ABSCHNITTE.map((a) => {
        const zeilen = p.lines.filter((z) => z.kind === a.kind);
        if (zeilen.length === 0) return null;
        return (
          <DetailSection key={a.kind} title={a.titel} body="flush">
            <ul className="divide-y divide-border">
              {zeilen.map((z) => (
                <li key={z.id} className="flex items-center justify-between gap-3 px-6 py-2.5 text-sm">
                  <span>
                    {z.label}
                    {z.certificateField ? <span className="ml-2 text-xs text-muted-foreground">LA {z.certificateField}</span> : null}
                  </span>
                  <span className="tabular-nums">
                    {a.kind === 'DEDUCTION' ? '− ' : ''}
                    {formatCurrency(toNumber(z.amount))}
                  </span>
                </li>
              ))}
            </ul>
          </DetailSection>
        );
      })}

      {herleitung.satzversionen ? (
        <DetailSection title="Angewandte Satzversionen" description="Momentaufnahme beim Rechnen." body="flush">
          <ul className="divide-y divide-border">
            {Object.entries(herleitung.satzversionen).map(([code, v]) => (
              <li key={code} className="flex flex-wrap items-center justify-between gap-2 px-6 py-2.5 text-sm">
                <span>
                  {code} <span className="text-xs text-muted-foreground">ab {v.gueltigAb} · {v.quelle}</span>
                </span>
                <span className="flex items-center gap-2 tabular-nums">
                  {v.arbeitnehmerPct} % / {v.arbeitgeberPct} %
                  <Badge size="sm" variant={v.pruefstand === 'GEPRUEFT' ? 'success' : 'warning'}>
                    {v.pruefstand === 'GEPRUEFT' ? 'Geprüft' : 'Ungeprüft'}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
        </DetailSection>
      ) : null}

      <DetailSection title="Herleitung" body="list">
        <DetailRow label="Jahreslohn (Hochrechnung)">{herleitung.hochrechnungJahr !== undefined ? formatCurrency(herleitung.hochrechnungJahr) : '—'}</DetailRow>
        <DetailRow label="Koordinierter Lohn BVG">
          {herleitung.bvgKoordinierterJahreslohn !== undefined ? formatCurrency(herleitung.bvgKoordinierterJahreslohn) : '—'}
        </DetailRow>
        <DetailRow label="Quellensteuer">
          {herleitung.quellensteuer?.status === 'SATZ'
            ? `${herleitung.quellensteuer.kanton} ${herleitung.quellensteuer.tarif} · ${herleitung.quellensteuer.quelle}`
            : herleitung.quellensteuer?.status === 'KEIN_TARIF'
              ? `Kein Tarif eingelesen (${herleitung.quellensteuer.kanton} ${herleitung.quellensteuer.tarif})`
              : 'Keine'}
        </DetailRow>
      </DetailSection>
    </div>
  );
}
