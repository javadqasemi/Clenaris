import type { Metadata } from 'next';
import Link from 'next/link';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { prisma, toNumber } from '@/lib/db';
import { formatCurrency, formatDateTime } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { getSiteVisit, type Besichtigungsrechnung } from '@/server/services/site-visit.service';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/primitives';
import { DetailRow, DetailSection, PageHeader } from '@/components/app/page-parts';
import { ActionButton } from '@/components/app/action-button';
import { FormDialog } from '@/components/app/resource-form';
import { OBJEKTART, TURNUS, areaFields } from '@/features/admin/verkauf-fields';

export const metadata: Metadata = {
  title: 'Besichtigung',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Eine Besichtigung: aufgenommene Flächen, Berechnung, Offerte. Die
 * Berechnung ist eine Vorschau — beim Erstellen der Offerte rechnet der
 * Server neu, mit dem dann gültigen Katalog.
 */
export default async function SiteVisitDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('quote:read');
  const { id } = await params;
  const organizationId = await getOrganizationId();
  const v = await getSiteVisit(organizationId, id);
  const darf = can(session.role, 'quote:update') && !v.quoteId && v.status !== 'CANCELLED';
  const leistungen = darf
    ? await prisma.service.findMany({ where: { organizationId, active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
    : [];
  const rechnung = v.calculation as unknown as Besichtigungsrechnung | null;
  const turnus = Object.fromEntries(TURNUS.map((t) => [t.value, t.label]));
  const fuer = v.customer
    ? v.customer.companyName ?? `${v.customer.firstName ?? ''} ${v.customer.lastName ?? ''}`
    : v.lead
      ? `${v.lead.company ?? `${v.lead.firstName ?? ''} ${v.lead.lastName ?? ''}`} (Anfrage)`
      : '—';

  return (
    <div className="space-y-8">
      <PageHeader
        title={`Besichtigung ${v.number}`}
        description={`${fuer} · ${formatDateTime(v.scheduledAt)}`}
        actions={
          darf ? (
            <>
              <ActionButton endpoint={`/api/site-visits/${v.id}/calculate`} label="Berechnen" variant="outline" size="sm" successMessage="Berechnet." />
              {v.status === 'PLANNED' ? (
                <ActionButton endpoint={`/api/site-visits/${v.id}/complete`} label="Durchgeführt" size="sm" successMessage="Abgeschlossen." />
              ) : null}
              {v.status === 'DONE' ? (
                <ActionButton
                  endpoint={`/api/site-visits/${v.id}/quote`}
                  label="Offerte erstellen"
                  confirm="Die Preise werden jetzt neu berechnet und als Offertentwurf übernommen. Danach bleibt die Aufnahme, wie sie offeriert wurde."
                  size="sm"
                  successMessage="Offerte erstellt."
                />
              ) : null}
              <ActionButton
                endpoint={`/api/site-visits/${v.id}/cancel`}
                label="Absagen"
                withNote
                noteField="reason"
                noteLabel="Grund"
                variant="ghost"
                size="sm"
              />
            </>
          ) : null
        }
      />

      {v.quote ? (
        <Alert variant="info">
          Offerte{' '}
          <Link href={`/admin/offerten/${v.quote.id}`} className="font-medium underline">
            {v.quote.number}
          </Link>{' '}
          über {formatCurrency(toNumber(v.quote.grossTotal))} entstanden. Die Aufnahme ist damit abgeschlossen.
        </Alert>
      ) : null}

      <DetailSection title="Objekt" body="list">
        <DetailRow label="Stand">
          <Badge variant="outline">{v.status === 'PLANNED' ? 'Geplant' : v.status === 'DONE' ? 'Durchgeführt' : 'Abgesagt'}</Badge>
        </DetailRow>
        <DetailRow label="Objektart">{OBJEKTART.find((o) => o.value === v.propertyKind)?.label ?? v.propertyKind}</DetailRow>
        <DetailRow label="Objekt / Adresse">
          {v.property ? v.property.label : [v.street, [v.postalCode, v.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || '—'}
        </DetailRow>
        <DetailRow label="Begutachtung">{v.assessor ? `${v.assessor.firstName} ${v.assessor.lastName}` : '—'}</DetailRow>
        {v.accessNotes ? <DetailRow label="Zugang">{v.accessNotes}</DetailRow> : null}
        {v.findings ? <DetailRow label="Befund">{v.findings}</DetailRow> : null}
      </DetailSection>

      <DetailSection
        title="Aufgenommene Flächen"
        body="flush"
        action={
          darf ? (
            <FormDialog
              title="Fläche aufnehmen"
              triggerLabel="Fläche"
              triggerVariant="outline"
              triggerSize="sm"
              endpoint={`/api/site-visits/${v.id}/areas`}
              successMessage="Fläche aufgenommen."
              fields={areaFields(leistungen.map((l) => ({ value: l.id, label: l.name })))}
              values={{ frequency: 'WEEKLY' }}
            />
          ) : null
        }
      >
        {v.areas.length === 0 ? (
          <p className="px-6 py-6 text-sm text-muted-foreground">Noch keine Fläche aufgenommen.</p>
        ) : (
          <ul className="divide-y divide-border">
            {v.areas.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-6 py-3 text-sm">
                <span>
                  <span className="font-medium">{a.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {a.service.name} · {turnus[a.frequency] ?? a.frequency}
                    {a.squareMeters ? ` · ${a.squareMeters} m²` : ''}
                    {a.rooms ? ` · ${toNumber(a.rooms)} Räume` : ''}
                    {a.windows ? ` · ${a.windows} Fenster` : ''}
                  </span>
                </span>
                {darf ? (
                  <ActionButton endpoint={`/api/site-visits/${v.id}/areas/${a.id}`} method="DELETE" label="Entfernen" confirm="Fläche entfernen?" variant="ghost" size="sm" />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </DetailSection>

      <DetailSection
        title="Berechnung"
        description={rechnung ? `Stand ${formatDateTime(new Date(rechnung.berechnetAm))} — aus der Preisberechnung des Katalogs.` : 'Noch nicht berechnet.'}
        body="flush"
      >
        {rechnung ? (
          <ul className="divide-y divide-border">
            {rechnung.flaechen.map((f) => (
              <li key={f.areaId} className="flex items-center justify-between gap-3 px-6 py-2.5 text-sm">
                <span>
                  {f.serviceName} — {f.label}
                  {f.onRequest ? <Badge size="sm" variant="warning" className="ml-2">Preis auf Anfrage</Badge> : null}
                </span>
                <span className="tabular-nums">{formatCurrency(f.grossTotal)}</span>
              </li>
            ))}
            <li className="flex items-center justify-between gap-3 px-6 py-3 text-sm font-semibold">
              <span>Total inkl. MWST</span>
              <span className="tabular-nums">{formatCurrency(rechnung.grossTotal)}</span>
            </li>
          </ul>
        ) : null}
      </DetailSection>
    </div>
  );
}
