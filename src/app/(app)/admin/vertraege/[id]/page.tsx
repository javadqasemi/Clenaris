import * as React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { can } from '@/lib/auth/rbac';
import { requirePermission } from '@/lib/auth/session';
import { alsTag, plusTage, tagSchluessel } from '@/lib/contracts/serie';
import { naechsteKontrolle } from '@/lib/quality/bewertung';
import { prisma, toNumber } from '@/lib/db';
import { formatCurrency, formatDate } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { StatusBadge } from '@/components/ui/badge';
import { ActionButton } from '@/components/app/action-button';
import { DetailRow, DetailSection, PageHeader, TableScroll } from '@/components/app/page-parts';
import {
  AenderungsantragDialog,
  AntragAnwendenDialog,
  AusnahmeDialog,
  EinsatzplanDialog,
  GesperrtHinweis,
  LeistungEntfernenButton,
  LeistungHinzufuegenDialog,
  NeueVersionDialog,
  VersionBearbeitenDialog,
  VertragsrechnungDialog,
  type Leistungszeile,
} from '@/features/admin/contract-panels';
import { BegehungDialog } from '@/features/admin/quality-panels';

export const metadata: Metadata = {
  title: 'Vertrag',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const ZYKLUS: Record<string, string> = {
  PER_VISIT: 'je Einsatz',
  MONTHLY: 'monatlich',
  QUARTERLY: 'vierteljährlich',
  SEMIANNUAL: 'halbjährlich',
  ANNUAL: 'jährlich',
};

const PREISMODELL: Record<string, string> = {
  FIXED_PERIOD: 'Pauschale je Periode',
  FIXED_PER_VISIT: 'Pauschale je Einsatz',
  HOURLY: 'nach Stunden',
  UNIT_BASED: 'nach Menge',
  CUSTOM: 'abweichende Vereinbarung',
};

const FREQUENZ: Record<string, string> = {
  WEEKLY: 'wöchentlich',
  BIWEEKLY: 'zweiwöchentlich',
  MONTHLY: 'monatlich',
  QUARTERLY: 'vierteljährlich',
  SEMIANNUAL: 'halbjährlich',
  ANNUAL: 'jährlich',
};

const WOCHENTAGE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

const FEIERTAG: Record<string, string> = {
  IGNORE: 'Termin bleibt stehen',
  SKIP: 'Termin entfällt',
  MOVE_BEFORE: 'auf den Werktag davor',
  MOVE_AFTER: 'auf den Werktag danach',
};

/** Minuten seit Mitternacht als „06:00". */
const uhrzeit = (minuten: number) =>
  `${String(Math.floor(minuten / 60)).padStart(2, '0')}:${String(minuten % 60).padStart(2, '0')}`;

export default async function ContractDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('contract:read');
  const { id } = await params;
  const organizationId = await getOrganizationId();

  const vertrag = await prisma.contract.findFirst({
    where: { id, organizationId, deletedAt: null },
    include: {
      customer: { select: { id: true, number: true, companyName: true, firstName: true, lastName: true } },
      property: { select: { id: true, label: true } },
      quote: { select: { id: true, number: true, acceptedAt: true } },
      responsibleEmployee: { select: { user: { select: { firstName: true, lastName: true } } } },
      versions: {
        orderBy: { versionNumber: 'desc' },
        include: {
          services: {
            orderBy: { position: 'asc' },
            include: {
              building: { select: { name: true } },
              schedules: { include: { exceptions: { orderBy: { originalDate: 'asc' }, take: 20 } } },
            },
          },
        },
      },
      amendments: { orderBy: { requestedAt: 'desc' } },
      priceAdjustments: { orderBy: { effectiveFrom: 'desc' } },
      /*
        Nur ausgelieferte Dateien. `scanStatus: CLEAN` ist nicht Kosmetik: Das
        Auslieferungstor prüft bei jedem Abruf, und eine Datei, die hier
        verlinkt wäre und beim Klick abgewiesen würde, sähe aus wie ein Fehler
        der Anwendung statt wie eine greifende Sperre.
      */
      files: {
        where: { scanStatus: 'CLEAN' },
        select: { id: true, filename: true, url: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
  if (!vertrag) notFound();

  const geltend = vertrag.versions.find((v) => v.status === 'ACTIVE') ?? null;
  const entwurf = vertrag.versions.find((v) => v.status === 'DRAFT') ?? null;
  /** Die Fassung, deren Leistungen gezeigt werden: die geltende, sonst der Entwurf. */
  const gezeigt = geltend ?? entwurf ?? vertrag.versions[0] ?? null;

  const [einsaetze, naechste, rechnungen, katalog, offeneAnnahme, begehungen] = await Promise.all([
    prisma.job.count({ where: { contractId: vertrag.id, deletedAt: null } }),
    prisma.job.findMany({
      where: { contractId: vertrag.id, deletedAt: null, scheduledStart: { gte: new Date() } },
      orderBy: { scheduledStart: 'asc' },
      take: 10,
      select: { id: true, number: true, title: true, scheduledStart: true, status: true, contractVersionId: true },
    }),
    prisma.invoice.findMany({
      where: { contractId: vertrag.id, deletedAt: null },
      orderBy: { contractPeriodStart: 'desc' },
      take: 12,
      select: {
        id: true,
        number: true,
        status: true,
        grossTotal: true,
        contractPeriodStart: true,
        periodFrom: true,
        periodTo: true,
        contractVersion: { select: { versionNumber: true } },
      },
    }),
    prisma.service.findMany({
      where: { organizationId, active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    /*
      Der laufende Annahmevorgang der gezeigten Fassung. Sichtbar zu machen,
      *dass* eine Unterzeichnung läuft, ist nicht Kosmetik: Solange sie läuft,
      weist jede Änderung an der Fassung 422 zurück — ohne diesen Hinweis sähe
      das nach einem Fehler der Anwendung aus.
    */
    prisma.signatureRequest.findFirst({
      where: {
        contractVersionId: { in: vertrag.versions.map((v) => v.id) },
        status: { in: ['DRAFT', 'PENDING', 'FINALIZING'] },
      },
      select: { id: true, publicId: true, status: true, expiresAt: true, contractVersionId: true, sentAt: true },
    }),
    prisma.qualityInspection.findMany({
      where: { contractId: id, deletedAt: null },
      orderBy: { inspectedAt: 'desc' },
      take: 6,
      select: {
        id: true,
        number: true,
        status: true,
        inspectedAt: true,
        scorePercent: true,
        targetScore: true,
        outcome: true,
      },
    }),
  ]);

  const kundschaft =
    vertrag.customer.companyName ?? `${vertrag.customer.firstName} ${vertrag.customer.lastName}`;

  const darfAktivieren = can(session.role, 'contract:activate');
  const darfBeenden = can(session.role, 'contract:terminate');
  const darfVersionieren = can(session.role, 'contract:version');
  const darfPlanen = can(session.role, 'contract:update');
  const darfFreigeben = can(session.role, 'contract:approve');
  const darfUnterzeichnen = can(session.role, 'contract:sign');
  const darfAbrechnen = can(session.role, 'contract:billing') && can(session.role, 'invoice:create');
  const darfBegehen = can(session.role, 'quality:inspect');

  const planenBis = tagSchluessel(plusTage(alsTag(new Date()), 60));

  /**
   * Die Vorbelegung für eine neue Fassung: die Konditionen der gezeigten.
   *
   * Eine leere Maske wäre hier falsch. Wer den Preis ändert, will genau das
   * ändern — und nicht Zahlungsziel, Kündigungsfrist und MWST von Hand neu
   * eintippen, wo ein Zahlendreher eine Vertragsänderung wäre, die niemand
   * beabsichtigt hat.
   */
  const konditionenVorlage = gezeigt
    ? {
        effectiveFrom: tagSchluessel(plusTage(alsTag(new Date()), 1)),
        reason: '',
        pricingModel: gezeigt.pricingModel,
        baseAmount: toNumber(gezeigt.baseAmount),
        hourlyRate: gezeigt.hourlyRate ? toNumber(gezeigt.hourlyRate) : null,
        unitPrice: gezeigt.unitPrice ? toNumber(gezeigt.unitPrice) : null,
        unitLabel: gezeigt.unitLabel,
        vatRate: toNumber(gezeigt.vatRate),
        billingCycle: gezeigt.billingCycle,
        paymentTermDays: gezeigt.paymentTermDays,
        noticePeriodDays: gezeigt.noticePeriodDays,
        minimumTermMonths: gezeigt.minimumTermMonths,
        renewalType: gezeigt.renewalType,
        renewalPeriodMonths: gezeigt.renewalPeriodMonths,
        indexReference: gezeigt.indexReference,
        nextReviewAt: gezeigt.nextReviewAt,
        targetQualityScore: gezeigt.targetQualityScore,
        inspectionIntervalDays: gezeigt.inspectionIntervalDays,
        responseHours: gezeigt.responseHours,
        slaNote: gezeigt.slaNote,
        terms: gezeigt.terms,
        internalNote: gezeigt.internalNote,
      }
    : undefined;

  /** Der Leistungsumfang des Entwurfs in der Form, die der PUT-Endpunkt erwartet. */
  const entwurfsLeistungen: Leistungszeile[] =
    entwurf?.services.map((leistung) => ({
      serviceId: leistung.serviceId,
      label: leistung.label,
      description: leistung.description,
      zone: leistung.zone,
      estimatedMinutes: leistung.estimatedMinutes,
      requiredCrewSize: leistung.requiredCrewSize,
      materialsBy: leistung.materialsBy,
      quantity: leistung.quantity ? toNumber(leistung.quantity) : null,
      specialInstructions: leistung.specialInstructions,
    })) ?? [];

  /**
   * Der Stand der Qualitätszusage — gerechnet, nicht gespeichert.
   *
   * Derselbe reine Kern wie im Dienst (`naechsteKontrolle`); die Akte fragt
   * keinen Endpunkt, weil sie ohnehin serverseitig rendert. Ohne vereinbartes
   * Intervall gibt es keine Fälligkeit, und dann steht hier auch nichts.
   */
  const qualitaetsstand = gezeigt
    ? (() => {
        const letzte = begehungen.find((b) => b.status === 'COMPLETED');
        return {
          letzte: letzte
            ? {
                inspectedAt: letzte.inspectedAt,
                prozent: letzte.scorePercent === null ? null : toNumber(letzte.scorePercent),
              }
            : null,
          ...naechsteKontrolle({
            intervallTage: gezeigt.inspectionIntervalDays,
            letzteKontrolleAm: letzte?.inspectedAt,
            vertragsbeginn: vertrag.startDate,
          }),
        };
      })()
    : null;

  const entwurfGesperrt = entwurf
    ? entwurf.acceptedAt
      ? ('ANGENOMMEN' as const)
      : offeneAnnahme?.contractVersionId === entwurf.id
        ? ('IN_UNTERZEICHNUNG' as const)
        : null
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${vertrag.number ?? 'Entwurf'} — ${vertrag.title}`}
        description={`${kundschaft}${vertrag.property ? ` · ${vertrag.property.label}` : ''}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {/*
              Nur die Handlungen, die aus dem aktuellen Zustand heraus möglich
              sind. Eine ausgegraute Schaltfläche wäre ehrlicher als eine, die
              422 antwortet — aber eine, die gar nicht da ist, ist die
              ehrlichste: Sie behauptet nichts.
            */}
            {darfAktivieren && ['DRAFT', 'IN_REVIEW', 'OFFERED'].includes(vertrag.status) ? (
              <ActionButton
                endpoint={`/api/contracts/${vertrag.id}/activate`}
                body={{}}
                label="In Kraft setzen"
                variant="default"
                confirmTitle="Vertrag in Kraft setzen"
                confirm="Der Vertrag erhält eine Nummer, die Fassung wird gültig, und der Planer erzeugt ab jetzt Einsätze."
                successMessage="Der Vertrag ist in Kraft."
              />
            ) : null}

            {darfAktivieren && vertrag.status === 'ACTIVE' ? (
              <ActionButton
                endpoint={`/api/contracts/${vertrag.id}/pause`}
                body={{ pausedFrom: tagSchluessel(alsTag(new Date())) }}
                label="Pausieren"
                withNote
                noteLabel="Grund der Pause"
                noteField="reason"
                confirmTitle="Vertrag aussetzen"
                confirm="Während der Pause erzeugt der Planer keine Einsätze. Der Vertrag besteht weiter."
                successMessage="Der Vertrag ist ausgesetzt."
              />
            ) : null}

            {darfAktivieren && vertrag.status === 'PAUSED' ? (
              <ActionButton
                endpoint={`/api/contracts/${vertrag.id}/resume`}
                label="Fortsetzen"
                variant="default"
                successMessage="Der Vertrag läuft wieder."
              />
            ) : null}

            {darfBeenden && ['ACTIVE', 'PAUSED'].includes(vertrag.status) ? (
              <ActionButton
                endpoint={`/api/contracts/${vertrag.id}/notice`}
                body={{ noticeGivenBy: 'CUSTOMER' }}
                label="Kündigung erfassen"
                withNote
                noteLabel="Grund"
                noteField="reason"
                confirmTitle="Kündigung erfassen"
                confirm="Festgehalten wird, dass gekündigt wurde. Das Wirkungsdatum wird aus Frist und Laufzeit gerechnet — ob die Kündigung wirksam ist, entscheidet dieses System nicht."
                successMessage="Die Kündigung ist erfasst."
              />
            ) : null}

            {darfBeenden && ['ACTIVE', 'PAUSED', 'NOTICE_GIVEN'].includes(vertrag.status) ? (
              <ActionButton
                endpoint={`/api/contracts/${vertrag.id}/end`}
                label="Beenden"
                variant="destructive"
                withNote
                noteLabel="Grund"
                noteField="reason"
                confirmTitle="Vertrag beenden"
                confirm="Alle Einsatzpläne werden stillgelegt. Bereits erzeugte Einsätze bleiben. Ein beendeter Vertrag lässt sich nicht wiederbeleben."
                successMessage="Der Vertrag ist beendet."
              />
            ) : null}

            {darfPlanen && ['ACTIVE', 'NOTICE_GIVEN'].includes(vertrag.status) ? (
              <ActionButton
                endpoint={`/api/contracts/${vertrag.id}/schedule`}
                body={{ bis: planenBis }}
                label="Jetzt planen"
                confirmTitle="Einsätze erzeugen"
                confirm="Erzeugt die Einsätze der nächsten 60 Tage. Bereits geplante Termine bleiben unberührt — der Lauf ist idempotent."
                successMessage="Die Serien sind geplant."
              />
            ) : null}

            {/*
              Zur Unterschrift geben: nur für einen Entwurf, der noch nicht
              angenommen ist, und nur mit `contract:sign` — dieselbe Linie wie
              beim Aktivieren. Der Link geht per E-Mail an die Kundschaft,
              nicht an die Person, die hier klickt.
            */}
            {darfUnterzeichnen && entwurf && !entwurf.acceptedAt && !offeneAnnahme ? (
              <ActionButton
                endpoint={`/api/contracts/${vertrag.id}/versions/${entwurf.id}/acceptance`}
                label="Zur Unterschrift senden"
                confirmTitle="Vertragsfassung zur Annahme senden"
                confirm="Die Kundschaft erhält einen befristeten Link auf ein unveränderliches Abbild dieser Fassung. Ab dem Versand lässt sich die Fassung nicht mehr ändern."
                successMessage="Die Fassung ist zur Annahme versandt."
              />
            ) : null}

            {darfUnterzeichnen && offeneAnnahme ? (
              <ActionButton
                endpoint={`/api/contracts/${vertrag.id}/versions/${offeneAnnahme.contractVersionId}/acceptance`}
                method="DELETE"
                label="Unterzeichnung zurückziehen"
                variant="destructive"
                confirmTitle="Annahmevorgang zurückziehen"
                confirm="Der Link wird entwertet. Abbild und Protokoll bleiben als Beleg erhalten. Danach lässt sich die Fassung wieder ändern."
                successMessage="Der Vorgang ist zurückgezogen."
              />
            ) : null}

            {darfAbrechnen && ['ACTIVE', 'PAUSED', 'NOTICE_GIVEN', 'ENDED'].includes(vertrag.status) ? (
              <VertragsrechnungDialog contractId={vertrag.id} />
            ) : null}
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* ---------------------------------------------------------- */}
          <DetailSection title="Übersicht">
            <DetailRow label="Status">
              <StatusBadge status={vertrag.status} />
            </DetailRow>
            <DetailRow label="Kundschaft">
              <Link href={`/admin/kunden/${vertrag.customer.id}`} className="text-primary underline-offset-4 hover:underline">
                {kundschaft}
              </Link>
              <span className="ml-2 text-muted-foreground">{vertrag.customer.number}</span>
            </DetailRow>
            <DetailRow label="Laufzeit">
              {formatDate(vertrag.startDate)}
              {vertrag.endDate ? ` bis ${formatDate(vertrag.endDate)}` : ' — unbefristet'}
            </DetailRow>
            <DetailRow label="Kündigungsfrist läuft ab">
              {vertrag.noticeDeadline ? formatDate(vertrag.noticeDeadline) : '—'}
            </DetailRow>
            {vertrag.status === 'PAUSED' ? (
              <DetailRow label="Pause">
                {formatDate(vertrag.pausedFrom!)}
                {vertrag.pausedUntil ? ` bis ${formatDate(vertrag.pausedUntil)}` : ' — offen'}
                {vertrag.pauseReason ? ` · ${vertrag.pauseReason}` : ''}
              </DetailRow>
            ) : null}
            {vertrag.noticeGivenAt ? (
              <DetailRow label="Kündigung">
                {vertrag.noticeGivenBy === 'CUSTOMER' ? 'durch die Kundschaft' : 'durch die Firma'} am{' '}
                {formatDate(vertrag.noticeGivenAt)}
                {vertrag.terminationEffectiveAt ? ` · wirksam ${formatDate(vertrag.terminationEffectiveAt)}` : ''}
              </DetailRow>
            ) : null}
            <DetailRow label="Aus Offerte">
              {vertrag.quote ? (
                <Link href={`/admin/offerten/${vertrag.quote.id}`} className="text-primary underline-offset-4 hover:underline">
                  {vertrag.quote.number}
                </Link>
              ) : (
                <span className="text-muted-foreground">ohne Offerte vereinbart</span>
              )}
            </DetailRow>
            <DetailRow label="Betreuung">
              {vertrag.responsibleEmployee
                ? `${vertrag.responsibleEmployee.user.firstName} ${vertrag.responsibleEmployee.user.lastName}`
                : '—'}
            </DetailRow>
            {vertrag.description ? (
              <DetailRow label="Beschreibung">{vertrag.description}</DetailRow>
            ) : null}
          </DetailSection>

          {/* ---------------------------------------------------------- */}
          <DetailSection
            title="Leistungen"
            description={
              gezeigt
                ? `Fassung ${gezeigt.versionNumber}${gezeigt.status === 'DRAFT' ? ' (Entwurf)' : ''}`
                : undefined
            }
            body="flush"
            action={
              darfVersionieren && entwurf && !entwurfGesperrt && gezeigt?.id === entwurf.id ? (
                <LeistungHinzufuegenDialog
                  contractId={vertrag.id}
                  versionId={entwurf.id}
                  bestehende={entwurfsLeistungen}
                  leistungen={katalog.map((l) => ({ value: l.id, label: l.name }))}
                />
              ) : entwurfGesperrt && gezeigt?.id === entwurf?.id ? (
                <GesperrtHinweis grund={entwurfGesperrt} />
              ) : null
            }
          >
            {!gezeigt || gezeigt.services.length === 0 ? (
              <p className="px-6 py-6 text-sm text-muted-foreground">
                Noch keine Leistungen. Ein Vertrag ohne Leistungen kann nicht in Kraft treten — er erzeugt weder
                Einsätze noch Abrechnung.
              </p>
            ) : (
              <TableScroll>
                <table className="data-table">
                  <caption className="sr-only">Leistungen der gezeigten Vertragsfassung.</caption>
                  <thead>
                    <tr>
                      <th scope="col">Leistung</th>
                      <th scope="col">Ort</th>
                      <th scope="col">Einsatzplan</th>
                      <th scope="col" className="text-right">
                        Dauer
                      </th>
                      <th scope="col" className="text-right">
                        Personen
                      </th>
                      {darfPlanen ? (
                        <th scope="col" className="text-right">
                          <span className="sr-only">Handlungen</span>
                        </th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {gezeigt.services.map((leistung) => (
                      <tr key={leistung.id}>
                        <td>
                          <span className="font-medium">{leistung.label}</span>
                          {leistung.specialInstructions ? (
                            <p className="text-meta text-muted-foreground">{leistung.specialInstructions}</p>
                          ) : null}
                        </td>
                        <td className="text-muted-foreground">
                          {[leistung.building?.name, leistung.zone].filter(Boolean).join(' · ') || '—'}
                        </td>
                        <td className="text-muted-foreground">
                          {leistung.schedules.length === 0
                            ? 'kein Plan'
                            : leistung.schedules.map((plan) => (
                                <span key={plan.id} className="block">
                                  {FREQUENZ[plan.frequency] ?? plan.frequency}
                                  {plan.interval > 1 ? ` (alle ${plan.interval})` : ''}
                                  {plan.weekdays.length > 0
                                    ? ` · ${plan.weekdays.map((t) => WOCHENTAGE[t]).join(', ')}`
                                    : ''}
                                  {` · ${uhrzeit(plan.startMinute)}–${uhrzeit(plan.endMinute)}`}
                                  {plan.active ? '' : ' · stillgelegt'}
                                  <span className="block text-2xs">
                                    Feiertag: {FEIERTAG[plan.holidayHandling] ?? plan.holidayHandling}
                                    {plan.exceptions.length > 0 ? ` · ${plan.exceptions.length} Ausnahmen` : ''}
                                  </span>
                                </span>
                              ))}
                        </td>
                        <td className="num text-muted-foreground">{leistung.estimatedMinutes} min</td>
                        <td className="num text-muted-foreground">{leistung.requiredCrewSize}</td>
                        {darfPlanen ? (
                          <td className="text-right">
                            <div className="flex flex-wrap justify-end gap-1">
                              {/*
                                Der Plan gehört zur Leistung, nicht zum
                                Vertrag: Verschiedene Leistungen derselben
                                Fassung haben verschiedene Rhythmen — das
                                Treppenhaus wöchentlich, die Fenster
                                vierteljährlich.
                              */}
                              {leistung.schedules.map((plan) => (
                                <React.Fragment key={plan.id}>
                                  <EinsatzplanDialog
                                    contractServiceId={leistung.id}
                                    auslöser={`Plan ${uhrzeit(plan.startMinute)}`}
                                    plan={{
                                      id: plan.id,
                                      frequency: plan.frequency,
                                      interval: plan.interval,
                                      weekdays: plan.weekdays,
                                      monthDay: plan.monthDay,
                                      startMinute: plan.startMinute,
                                      endMinute: plan.endMinute,
                                      effectiveFrom: tagSchluessel(plan.effectiveFrom),
                                      effectiveUntil: plan.effectiveUntil
                                        ? tagSchluessel(plan.effectiveUntil)
                                        : null,
                                      holidayHandling: plan.holidayHandling,
                                      active: plan.active,
                                    }}
                                  />
                                  <AusnahmeDialog planId={plan.id} />
                                </React.Fragment>
                              ))}
                              {/*
                                Anlegen nur am Entwurf: Die Frequenz ist Teil
                                der Vereinbarung, und ein neuer Plan an einer
                                geltenden Fassung wäre eine stille
                                Vertragsänderung. Der Dienst weist es ohnehin
                                ab — die Schaltfläche behauptet es gar nicht
                                erst.
                              */}
                              {gezeigt?.status === 'DRAFT' && !entwurfGesperrt ? (
                                <EinsatzplanDialog contractServiceId={leistung.id} auslöser="Plan anlegen" />
                              ) : null}
                              {darfVersionieren &&
                              entwurf &&
                              !entwurfGesperrt &&
                              gezeigt?.id === entwurf.id ? (
                                <LeistungEntfernenButton
                                  contractId={vertrag.id}
                                  versionId={entwurf.id}
                                  bestehende={entwurfsLeistungen}
                                  index={gezeigt.services.indexOf(leistung)}
                                />
                              ) : null}
                            </div>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </DetailSection>

          {/* ---------------------------------------------------------- */}
          <DetailSection
            title="Nächste Einsätze"
            description={`${einsaetze} Einsätze sind aus diesem Vertrag entstanden.`}
            body="flush"
          >
            {naechste.length === 0 ? (
              <p className="px-6 py-6 text-sm text-muted-foreground">
                Keine geplanten Einsätze. Der nächtliche Lauf plant sechzig Tage voraus; „Jetzt planen&ldquo; tut
                dasselbe sofort.
              </p>
            ) : (
              <TableScroll>
                <table className="data-table">
                  <caption className="sr-only">Die nächsten zehn Einsätze dieses Vertrags.</caption>
                  <thead>
                    <tr>
                      <th scope="col">Nummer</th>
                      <th scope="col">Termin</th>
                      <th scope="col">Bezeichnung</th>
                      <th scope="col">Fassung</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {naechste.map((einsatz) => {
                      const fassung = vertrag.versions.find((v) => v.id === einsatz.contractVersionId);
                      return (
                        <tr key={einsatz.id}>
                          <td>
                            <Link
                              href={`/admin/einsaetze/${einsatz.id}`}
                              className="font-medium tabular-nums text-primary underline-offset-4 hover:underline"
                            >
                              {einsatz.number}
                            </Link>
                          </td>
                          <td className="tabular-nums text-muted-foreground">{formatDate(einsatz.scheduledStart)}</td>
                          <td className="max-w-[18rem] truncate">{einsatz.title}</td>
                          {/*
                            Die Fassung je Einsatz ist keine Zierde: Sie
                            beantwortet später die Frage, unter welchen
                            Konditionen dieser Termin erbracht wurde.
                          */}
                          <td className="text-muted-foreground">
                            {fassung ? `Version ${fassung.versionNumber}` : '—'}
                          </td>
                          <td>
                            <StatusBadge status={einsatz.status} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </DetailSection>

          {/* ---------------------------------------------------------- */}
          <DetailSection
            title="Änderungen und Preisanpassungen"
            description="Der Antrag ist nicht die Änderung: Er wird geprüft, freigegeben und erzeugt dann eine neue Fassung."
            body="flush"
            action={
              darfVersionieren && ['ACTIVE', 'PAUSED', 'NOTICE_GIVEN'].includes(vertrag.status) ? (
                <AenderungsantragDialog contractId={vertrag.id} />
              ) : null
            }
          >
            {vertrag.amendments.length === 0 && vertrag.priceAdjustments.length === 0 ? (
              <p className="px-6 py-6 text-sm text-muted-foreground">Keine Anträge.</p>
            ) : (
              <TableScroll>
                <table className="data-table">
                  <caption className="sr-only">Änderungsanträge und Preisanpassungen.</caption>
                  <thead>
                    <tr>
                      <th scope="col">Art</th>
                      <th scope="col">Gegenstand</th>
                      <th scope="col">Wirksam ab</th>
                      <th scope="col">Status</th>
                      {darfFreigeben || darfVersionieren ? (
                        <th scope="col" className="text-right">
                          <span className="sr-only">Handlungen</span>
                        </th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {vertrag.amendments.map((antrag) => (
                      <tr key={antrag.id}>
                        <td className="text-muted-foreground">Änderung</td>
                        <td>
                          <span className="font-medium">{antrag.title}</span>
                          <p className="text-meta text-muted-foreground">{antrag.reason}</p>
                        </td>
                        <td className="tabular-nums text-muted-foreground">{formatDate(antrag.effectiveFrom)}</td>
                        <td>
                          <StatusBadge status={antrag.status} />
                        </td>
                        {darfFreigeben || darfVersionieren ? (
                          <td className="text-right">
                            <div className="flex flex-wrap justify-end gap-1">
                              {/*
                                Zwei Rechte, zwei Schritte: Freigeben verlangt
                                `contract:approve` (Geschäftsleitung), das
                                Wirksamwerden `contract:version` — es erzeugt
                                eine Fassung und ist Tagesgeschäft. Wer
                                beantragt, gibt nicht frei; diese Prüfung
                                steht im Dienst und greift auch dann, wenn
                                beide Schaltflächen sichtbar sind.
                              */}
                              {darfFreigeben && (antrag.status === 'DRAFT' || antrag.status === 'REVIEW') ? (
                                <>
                                  <ActionButton
                                    endpoint={`/api/contracts/${vertrag.id}/amendments/${antrag.id}/decision`}
                                    body={{ entscheidung: 'APPROVE' }}
                                    label="Freigeben"
                                    variant="default"
                                    successMessage="Der Antrag ist freigegeben."
                                  />
                                  <ActionButton
                                    endpoint={`/api/contracts/${vertrag.id}/amendments/${antrag.id}/decision`}
                                    body={{ entscheidung: 'REJECT' }}
                                    label="Ablehnen"
                                    withNote
                                    noteLabel="Grund"
                                    noteField="reason"
                                    successMessage="Der Antrag ist abgelehnt."
                                  />
                                </>
                              ) : null}
                              {darfVersionieren && antrag.status === 'APPROVED' && konditionenVorlage ? (
                                <AntragAnwendenDialog
                                  contractId={vertrag.id}
                                  amendmentId={antrag.id}
                                  vorlage={{
                                    ...konditionenVorlage,
                                    effectiveFrom: tagSchluessel(antrag.effectiveFrom),
                                    reason: antrag.title,
                                  }}
                                />
                              ) : null}
                            </div>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                    {vertrag.priceAdjustments.map((anpassung) => (
                      <tr key={anpassung.id}>
                        <td className="text-muted-foreground">Preis</td>
                        <td>
                          <span className="font-medium tabular-nums">
                            {formatCurrency(toNumber(anpassung.oldAmount))} →{' '}
                            {formatCurrency(toNumber(anpassung.newAmount))}
                          </span>
                          <p className="text-meta text-muted-foreground">{anpassung.reason}</p>
                        </td>
                        <td className="tabular-nums text-muted-foreground">{formatDate(anpassung.effectiveFrom)}</td>
                        <td>
                          <StatusBadge status={anpassung.status} />
                        </td>
                        {darfFreigeben || darfVersionieren ? (
                          <td className="text-right">
                            <div className="flex flex-wrap justify-end gap-1">
                              {darfFreigeben && anpassung.status === 'PLANNED' ? (
                                <>
                                  <ActionButton
                                    endpoint={`/api/contracts/${vertrag.id}/price-adjustments/${anpassung.id}/decision`}
                                    body={{ entscheidung: 'APPROVE' }}
                                    label="Freigeben"
                                    variant="default"
                                    successMessage="Die Preisanpassung ist freigegeben."
                                  />
                                  <ActionButton
                                    endpoint={`/api/contracts/${vertrag.id}/price-adjustments/${anpassung.id}/decision`}
                                    body={{ entscheidung: 'REJECT' }}
                                    label="Ablehnen"
                                    withNote
                                    noteLabel="Grund"
                                    noteField="reason"
                                    successMessage="Die Preisanpassung ist abgelehnt."
                                  />
                                </>
                              ) : null}
                              {darfVersionieren && anpassung.status === 'APPROVED' ? (
                                <ActionButton
                                  endpoint={`/api/contracts/${vertrag.id}/price-adjustments/${anpassung.id}/apply`}
                                  label="Wirksam machen"
                                  variant="default"
                                  confirmTitle="Preisanpassung wirksam machen"
                                  confirm="Es entsteht eine neue Vertragsfassung mit dem neuen Betrag. Ausgestellte Rechnungen bleiben unberührt."
                                  successMessage="Die neue Fassung gilt."
                                />
                              ) : null}
                            </div>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </DetailSection>

          {/* ---------------------------------------------------------- */}
          {gezeigt?.targetQualityScore || gezeigt?.inspectionIntervalDays || begehungen.length > 0 ? (
            <DetailSection
              title="Qualitätskontrolle"
              description="Die Begehungen, die gegen die Zusage dieser Fassung gemessen wurden."
              body="flush"
              action={
                darfBegehen ? (
                  <BegehungDialog
                    contractId={vertrag.id}
                    zielwert={gezeigt?.targetQualityScore ?? null}
                    auslöser="Begehung erfassen"
                  />
                ) : null
              }
            >
              {begehungen.length === 0 ? (
                <p className="px-6 py-6 text-sm text-muted-foreground">
                  Noch keine Begehung. Die Zusage steht in den Konditionen — gemessen wird sie erst hier.
                </p>
              ) : (
                <TableScroll>
                  <table className="data-table">
                    <caption className="sr-only">Qualitätsbegehungen dieses Vertrags.</caption>
                    <thead>
                      <tr>
                        <th scope="col">Nummer</th>
                        <th scope="col">Begangen</th>
                        <th scope="col" className="text-right">
                          Ergebnis
                        </th>
                        <th scope="col">Urteil</th>
                      </tr>
                    </thead>
                    <tbody>
                      {begehungen.map((begehung) => (
                        <tr key={begehung.id}>
                          <td>
                            <Link
                              href={`/admin/qualitaet/${begehung.id}`}
                              className="font-medium tabular-nums text-primary underline-offset-4 hover:underline"
                            >
                              {begehung.number ?? 'Entwurf'}
                            </Link>
                          </td>
                          <td className="tabular-nums text-muted-foreground">{formatDate(begehung.inspectedAt)}</td>
                          <td className="num">
                            {begehung.scorePercent === null
                              ? '—'
                              : `${toNumber(begehung.scorePercent)} %${
                                  begehung.targetScore !== null ? ` von ${begehung.targetScore} %` : ''
                                }`}
                          </td>
                          <td>
                            <StatusBadge
                              status={begehung.status === 'COMPLETED' ? begehung.outcome : begehung.status}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
              )}
            </DetailSection>
          ) : null}

          {/* ---------------------------------------------------------- */}
          <DetailSection
            title="Abrechnung"
            description="Eine Periode, eine Rechnung — die Zusicherung steht als Teilindex in der Datenbank, nicht als Prüfung im Ablauf."
            body="flush"
          >
            {rechnungen.length === 0 ? (
              <p className="px-6 py-6 text-sm text-muted-foreground">
                Noch keine Rechnung aus diesem Vertrag. Der Betrag entsteht aus der geltenden Fassung und den
                erbrachten Einsätzen.
              </p>
            ) : (
              <TableScroll>
                <table className="data-table">
                  <caption className="sr-only">Rechnungen aus diesem Vertrag, je Abrechnungsperiode.</caption>
                  <thead>
                    <tr>
                      <th scope="col">Nummer</th>
                      <th scope="col">Zeitraum</th>
                      <th scope="col">Fassung</th>
                      <th scope="col" className="text-right">
                        Betrag
                      </th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rechnungen.map((rechnung) => (
                      <tr key={rechnung.id}>
                        <td>
                          <Link
                            href={`/admin/rechnungen/${rechnung.id}`}
                            className="font-medium tabular-nums text-primary underline-offset-4 hover:underline"
                          >
                            {rechnung.number}
                          </Link>
                        </td>
                        <td className="tabular-nums text-muted-foreground">
                          {rechnung.periodFrom && rechnung.periodTo
                            ? `${formatDate(rechnung.periodFrom)} – ${formatDate(rechnung.periodTo)}`
                            : '—'}
                        </td>
                        {/*
                          Die Fassung je Rechnung ist die Antwort auf „wie kam
                          dieser Betrag zustande" — nach der ersten
                          Preisanpassung lässt sich das sonst nicht mehr
                          nachrechnen.
                        */}
                        <td className="text-muted-foreground">
                          {rechnung.contractVersion ? `Version ${rechnung.contractVersion.versionNumber}` : '—'}
                        </td>
                        <td className="num">{formatCurrency(toNumber(rechnung.grossTotal))}</td>
                        <td>
                          <StatusBadge status={rechnung.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </DetailSection>
        </div>

        {/* ------------------------------------------------------------ */}
        <div className="space-y-6">
          <DetailSection
            title="Konditionen"
            description={geltend ? `Geltende Fassung ${geltend.versionNumber}` : 'Noch keine geltende Fassung'}
          >
            {gezeigt ? (
              <>
                <DetailRow label="Preis">
                  <span className="font-medium tabular-nums">
                    {formatCurrency(toNumber(gezeigt.baseAmount))} {gezeigt.currency}
                  </span>
                  <span className="ml-2 text-muted-foreground">
                    {PREISMODELL[gezeigt.pricingModel] ?? gezeigt.pricingModel}
                  </span>
                </DetailRow>
                {gezeigt.pricingModel === 'HOURLY' && gezeigt.hourlyRate ? (
                  <DetailRow label="Stundensatz">
                    {formatCurrency(toNumber(gezeigt.hourlyRate))}
                  </DetailRow>
                ) : null}
                {gezeigt.pricingModel === 'UNIT_BASED' && gezeigt.unitPrice ? (
                  <DetailRow label="Einzelpreis">
                    {toNumber(gezeigt.unitPrice).toFixed(4)} je {gezeigt.unitLabel ?? 'Einheit'}
                  </DetailRow>
                ) : null}
                <DetailRow label="Abrechnung">
                  {ZYKLUS[gezeigt.billingCycle] ?? gezeigt.billingCycle} · Zahlungsziel{' '}
                  {gezeigt.paymentTermDays} Tage · MwSt {toNumber(gezeigt.vatRate)} %
                </DetailRow>
                <DetailRow label="Kündigungsfrist">{gezeigt.noticePeriodDays} Tage</DetailRow>
                <DetailRow label="Verlängerung">
                  {gezeigt.renewalType === 'AUTOMATIC'
                    ? `automatisch um ${gezeigt.renewalPeriodMonths ?? '—'} Monate`
                    : gezeigt.renewalType === 'MANUAL'
                      ? 'nur ausdrücklich'
                      : 'keine'}
                </DetailRow>
                {gezeigt.indexReference ? (
                  <DetailRow label="Indexierung">
                    {gezeigt.indexReference}
                    {gezeigt.nextReviewAt ? ` · nächste Prüfung ${formatDate(gezeigt.nextReviewAt)}` : ''}
                  </DetailRow>
                ) : null}
                {gezeigt.targetQualityScore || gezeigt.responseHours || gezeigt.inspectionIntervalDays ? (
                  <DetailRow label="Qualität und SLA">
                    {[
                      gezeigt.targetQualityScore ? `Zielwert ${gezeigt.targetQualityScore}` : null,
                      gezeigt.inspectionIntervalDays ? `Kontrolle alle ${gezeigt.inspectionIntervalDays} Tage` : null,
                      gezeigt.responseHours ? `Reaktion in ${gezeigt.responseHours} h` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    {/*
                      Bis Wave 11 stand hier nur die Zusage. Die Zeile darunter
                      ist der Unterschied zwischen einer Zusage und einer
                      gemessenen Zusage — und sie war der Befund, mit dem
                      Wave 11 begann.
                    */}
                    {qualitaetsstand ? (
                      <p className="mt-1 text-meta text-muted-foreground">
                        {qualitaetsstand.letzte
                          ? `Zuletzt ${qualitaetsstand.letzte.prozent ?? '—'} % am ${formatDate(qualitaetsstand.letzte.inspectedAt)}`
                          : 'Noch nicht kontrolliert'}
                        {qualitaetsstand.faelligAm
                          ? ` · nächste ${qualitaetsstand.ueberfaellig ? 'überfällig seit' : 'fällig'} ${formatDate(qualitaetsstand.faelligAm)}`
                          : ''}
                      </p>
                    ) : null}
                  </DetailRow>
                ) : null}
              </>
            ) : (
              <p className="py-4 text-sm text-muted-foreground">Keine Fassung vorhanden.</p>
            )}
          </DetailSection>

          <DetailSection
            title="Fassungen"
            description="Eine geltende Fassung ist unveränderlich. Änderungen entstehen als neue Version."
            body="flush"
            action={
              darfVersionieren && vertrag.status === 'ACTIVE' && !entwurf ? (
                <NeueVersionDialog contractId={vertrag.id} vorlage={konditionenVorlage} />
              ) : null
            }
          >
            <ul className="divide-y divide-border">
              {vertrag.versions.map((version) => (
                <li key={version.id} className="space-y-1 px-6 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        Version {version.versionNumber}
                        <span className="ml-2 font-normal text-muted-foreground tabular-nums">
                          ab {formatDate(version.effectiveFrom)}
                        </span>
                      </p>
                      <p className="text-meta text-muted-foreground">{version.reason}</p>
                    </div>
                    <StatusBadge status={version.status} />
                  </div>

                  {/*
                    Die Annahme steht an der Fassung, nicht am Vertrag: Was
                    die Kundschaft unterschrieben hat, sind diese
                    Konditionen. Eine Angabe am Vertragskopf wäre nach der
                    ersten Änderung eine Behauptung über etwas anderes.
                  */}
                  {version.acceptedAt ? (
                    <p className="text-2xs text-muted-foreground">
                      Elektronisch angenommen am {formatDate(version.acceptedAt)}
                    </p>
                  ) : offeneAnnahme?.contractVersionId === version.id ? (
                    <p className="text-2xs text-muted-foreground">
                      Liegt zur Unterzeichnung vor · Link gültig bis {formatDate(offeneAnnahme.expiresAt)}
                    </p>
                  ) : null}

                  {darfVersionieren && version.status === 'DRAFT' && !entwurfGesperrt && konditionenVorlage ? (
                    <div className="pt-1">
                      <VersionBearbeitenDialog
                        contractId={vertrag.id}
                        versionId={version.id}
                        werte={{
                          ...konditionenVorlage,
                          effectiveFrom: tagSchluessel(version.effectiveFrom),
                          reason: version.reason,
                        }}
                      />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </DetailSection>

          <DetailSection
            title="Dokumente"
            description="Unterschriebener Vertrag, Leistungsverzeichnis, Anhänge."
            body="flush"
          >
            {vertrag.files.length === 0 ? (
              <p className="px-6 py-6 text-sm text-muted-foreground">Keine Dokumente hinterlegt.</p>
            ) : (
              <ul className="divide-y divide-border">
                {vertrag.files.map((datei) => (
                  <li key={datei.id} className="px-6 py-3">
                    <a href={datei.url} className="text-sm text-primary underline-offset-4 hover:underline">
                      {datei.filename}
                    </a>
                    <p className="text-2xs text-muted-foreground tabular-nums">{formatDate(datei.createdAt)}</p>
                  </li>
                ))}
              </ul>
            )}
          </DetailSection>

          {darfVersionieren && entwurf ? (
            <DetailSection title="Offener Versionsentwurf">
              <DetailRow label={`Version ${entwurf.versionNumber}`}>
                {entwurf.reason}
                <p className="mt-1 text-meta text-muted-foreground">
                  Wirksam wird sie erst, wenn der Vertrag mit dem Stichtag in Kraft gesetzt wird.
                </p>
              </DetailRow>
            </DetailSection>
          ) : null}
        </div>
      </div>
    </div>
  );
}
