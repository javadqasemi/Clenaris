import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { toNumber } from '@/lib/db';
import { requireCustomerId, requirePermission } from '@/lib/auth/session';
import {
  ABRECHNUNGSZYKLUS,
  PREISMODELL,
  VERLAENGERUNG,
  preisText,
  rhythmusText,
} from '@/lib/contracts/bezeichnungen';
import { formatDate } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { getCustomerContract } from '@/server/services/contract.service';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { DetailRow, DetailSection, PageHeader } from '@/components/app/page-parts';

export const metadata: Metadata = {
  title: 'Vertrag',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Ein eigener Vertrag im Kundenkonto (L-18, 2026-09-28) — nur lesend.
 *
 * **Fremd, unbekannt und intern sehen gleich aus: 404.** Die Kennung, der
 * Kunde aus der Sitzung, die Organisation und die sichtbaren Zustände stehen
 * zusammen in der `where`-Klausel von `getCustomerContract`. Ein fremder
 * Vertrag wird nicht gefunden, statt gefunden und verweigert — sonst wäre die
 * Seite ein Orakel dafür, welche Kennungen es gibt.
 *
 * **Gezeigt wird, was im unterschriebenen Dokument steht**, nicht was die
 * Vertragsakte der Verwaltung kennt: keine interne Notiz, keine Kostenstelle,
 * keine Zuständigen, kein Kündigungs- oder Pausengrund. Diese Felder lädt die
 * Abfrage gar nicht erst.
 *
 * **Kein Link auf das unterzeichnete Dokument.** Die Signaturartefakte liefert
 * heute nur `GET /api/signatures/:id/artifacts/:artifact` aus, und der verlangt
 * `signature:read` — ein Recht der Verwaltung. Die Kundschaft erhält ihr
 * Exemplar über den Ergebnislink des Signaturvorgangs. Eine eigene Dateiroute
 * für das Kundenkonto wäre ein neuer Auslieferungsweg mit eigener
 * Eigentumsprüfung und gehört nicht in eine reine Leseseite; ein Link, der
 * beim Klick 403 liefert, wäre schlechter als keiner.
 */
export default async function AccountContractDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission('contract:read_own');
  const { customerId } = await requireCustomerId();
  const { id } = await params;

  const vertrag = await getCustomerContract({
    organizationId: await getOrganizationId(),
    customerId,
    contractId: id,
  });
  if (!vertrag) notFound();

  const fassung = vertrag.versions[0] ?? null;
  const adresse = vertrag.property?.address ?? null;

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/konto/vertraege">
          <ArrowLeft aria-hidden />
          Alle Verträge
        </Link>
      </Button>

      <PageHeader
        title={vertrag.title}
        description={vertrag.number ? `Vertrag ${vertrag.number}` : 'Vertragsangebot'}
        actions={<StatusBadge status={vertrag.status} />}
      />

      {vertrag.status === 'OFFERED' ? (
        <Alert variant="info">
          Dieses Vertragsangebot liegt Ihnen zur Unterschrift vor. Die Konditionen stehen im
          Dokument, das wir Ihnen zugestellt haben; sobald Sie es unterschrieben haben und der
          Vertrag in Kraft ist, erscheinen sie auch hier.
        </Alert>
      ) : null}

      {vertrag.status === 'NOTICE_GIVEN' && vertrag.terminationEffectiveAt ? (
        <Alert variant="warning">
          Dieser Vertrag ist gekündigt und endet per {formatDate(vertrag.terminationEffectiveAt)}.
        </Alert>
      ) : null}

      {vertrag.status === 'PAUSED' ? (
        <Alert variant="info">
          Dieser Vertrag ist ausgesetzt
          {vertrag.pausedFrom ? ` ab ${formatDate(vertrag.pausedFrom)}` : ''}
          {vertrag.pausedUntil ? ` bis ${formatDate(vertrag.pausedUntil)}` : ''}. In dieser Zeit
          finden keine Einsätze statt.
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          {fassung ? (
            <DetailSection
              title="Konditionen"
              description={`Fassung ${fassung.versionNumber}, gültig ab ${formatDate(fassung.effectiveFrom)}`}
            >
              <dl className="protocol-list">
                <DetailRow label="Preismodell">
                  {PREISMODELL[fassung.pricingModel] ?? fassung.pricingModel}
                </DetailRow>
                <DetailRow label="Preis">
                  <span className="tabular-nums">
                    {preisText({
                      pricingModel: fassung.pricingModel,
                      currency: fassung.currency,
                      baseAmount: toNumber(fassung.baseAmount),
                      hourlyRate: toNumber(fassung.hourlyRate),
                      unitPrice: toNumber(fassung.unitPrice),
                      unitLabel: fassung.unitLabel,
                      vatRate: toNumber(fassung.vatRate),
                    })}
                  </span>
                </DetailRow>
                <DetailRow label="Abrechnung">
                  {ABRECHNUNGSZYKLUS[fassung.billingCycle] ?? fassung.billingCycle}
                </DetailRow>
                <DetailRow label="Zahlungsziel">
                  <span className="tabular-nums">{fassung.paymentTermDays} Tage</span>
                </DetailRow>
                {fassung.minimumTermMonths ? (
                  <DetailRow label="Mindestlaufzeit">
                    <span className="tabular-nums">{fassung.minimumTermMonths} Monate</span>
                  </DetailRow>
                ) : null}
                <DetailRow label="Kündigungsfrist">
                  <span className="tabular-nums">{fassung.noticePeriodDays} Tage</span>
                </DetailRow>
                <DetailRow label="Verlängerung">
                  {VERLAENGERUNG[fassung.renewalType] ?? fassung.renewalType}
                  {fassung.renewalType === 'AUTOMATIC' && fassung.renewalPeriodMonths
                    ? ` um ${fassung.renewalPeriodMonths} Monate`
                    : ''}
                </DetailRow>
                {fassung.indexReference ? (
                  <DetailRow label="Indexierung">{fassung.indexReference}</DetailRow>
                ) : null}
                {fassung.responseHours ? (
                  <DetailRow label="Reaktionszeit bei Reklamation">
                    <span className="tabular-nums">{fassung.responseHours} Stunden</span>
                  </DetailRow>
                ) : null}
                {fassung.acceptedAt ? (
                  <DetailRow label="Elektronisch angenommen">{formatDate(fassung.acceptedAt)}</DetailRow>
                ) : null}
              </dl>
            </DetailSection>
          ) : null}

          {fassung ? (
            <DetailSection title="Leistungen" body="flush">
              {fassung.services.length === 0 ? (
                <p className="px-6 py-4 text-sm text-muted-foreground">
                  In dieser Fassung sind keine einzelnen Leistungen aufgeführt.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {fassung.services.map((leistung) => (
                    <li key={leistung.id} className="space-y-1 px-6 py-4 text-sm">
                      <p className="font-medium">
                        {leistung.zone ? `${leistung.label} (${leistung.zone})` : leistung.label}
                      </p>
                      {leistung.schedules.map((plan) => (
                        <p key={plan.id} className="text-meta tabular-nums text-muted-foreground">
                          {rhythmusText({
                            frequency: plan.frequency,
                            intervalWeeks: plan.interval,
                            weekdays: plan.weekdays,
                            dayOfMonth: plan.monthDay,
                            startMinute: plan.startMinute,
                            endMinute: plan.endMinute,
                          })}
                        </p>
                      ))}
                    </li>
                  ))}
                </ul>
              )}
            </DetailSection>
          ) : null}

          {fassung?.terms ? (
            <DetailSection title="Vertragsbedingungen">
              <p className="whitespace-pre-line text-sm leading-relaxed">{fassung.terms}</p>
            </DetailSection>
          ) : null}
        </div>

        <aside className="space-y-6">
          <DetailSection title="Laufzeit">
            <dl className="protocol-list">
              <DetailRow label="Beginn">{formatDate(vertrag.startDate)}</DetailRow>
              <DetailRow label="Ende">
                {vertrag.endDate ? formatDate(vertrag.endDate) : 'unbefristet'}
              </DetailRow>
              {vertrag.noticeGivenAt ? (
                <DetailRow label="Gekündigt am">{formatDate(vertrag.noticeGivenAt)}</DetailRow>
              ) : null}
            </dl>
          </DetailSection>

          {vertrag.property ? (
            <DetailSection title="Objekt">
              <dl className="protocol-list">
                <DetailRow label="Bezeichnung">{vertrag.property.label}</DetailRow>
                {adresse ? (
                  <DetailRow label="Adresse">
                    {[adresse.street, adresse.streetNo].filter(Boolean).join(' ')}
                    <br />
                    {adresse.postalCode} {adresse.city}
                  </DetailRow>
                ) : null}
              </dl>
            </DetailSection>
          ) : null}

          <p className="text-sm leading-relaxed text-muted-foreground">
            Möchten Sie etwas anpassen?{' '}
            <Link href="/konto/nachrichten" className="text-primary underline underline-offset-4">
              Schreiben Sie uns
            </Link>{' '}
            — eine Änderung des Vertrags halten wir in einer neuen Fassung fest.
          </p>
        </aside>
      </div>
    </div>
  );
}
