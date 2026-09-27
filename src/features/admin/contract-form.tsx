'use client';

import * as React from 'react';

import { ResourceForm, type FieldSpec } from '@/components/app/resource-form';

import { qualifikationenAus } from './contract-panels';

/**
 * Die Maske für einen neuen Vertrag.
 *
 * ---------------------------------------------------------------------------
 *  Warum ein Formular und nicht drei
 * ---------------------------------------------------------------------------
 *
 * Fachlich sind es drei Dinge — Vertragskopf, erste Fassung, erste Leistung —,
 * und der Endpunkt nimmt sie auch getrennt entgegen. Für die Eingabe wäre die
 * Trennung trotzdem falsch: Ein Vertrag ohne Konditionen kann nicht in Kraft
 * treten, und einer ohne Leistung erst recht nicht. Drei Masken hintereinander
 * hiessen drei Gelegenheiten, nach der ersten aufzuhören — und zurück bliebe
 * ein Entwurf, der nie etwas erzeugt.
 *
 * `transform` faltet die flachen Felder in die Struktur, die der Endpunkt
 * erwartet. Das ist der Ort dafür: Die Maske bleibt flach (so denkt, wer sie
 * ausfüllt), die Schnittstelle bleibt geschachtelt (so ist die Domäne
 * gebaut).
 *
 * ---------------------------------------------------------------------------
 *  Was hier bewusst **nicht** steht
 * ---------------------------------------------------------------------------
 *
 * Kein Zustand, keine Vertragsnummer, kein Enddatum der Fassung. Die entstehen
 * aus Handlungen, nicht aus Eingaben — und ein Feld dafür wäre eine Einladung,
 * sie zu behaupten.
 *
 * Der Einsatzplan fehlt ebenfalls: Er hängt an der Leistung, und die gibt es
 * erst nach dem Speichern. Ihn hier vorwegzunehmen hiesse, ihn ohne Bezug
 * entgegenzunehmen und später zuzuordnen — eine Zuordnung, die schiefgehen
 * kann.
 */
export function ContractForm({
  kunden,
  objekte,
  leistungen,
  personal,
  offerten,
}: {
  kunden: { value: string; label: string }[];
  objekte: { value: string; label: string; customerId: string }[];
  leistungen: { value: string; label: string }[];
  personal: { value: string; label: string }[];
  offerten: { value: string; label: string }[];
}) {
  const [kundeId, setKundeId] = React.useState('');

  /**
   * Nur die Objekte der gewählten Kundschaft.
   *
   * Eine Liste aller Objekte wäre in einem Betrieb mit dreihundert Akten
   * unbedienbar — und sie liesse zu, ein fremdes Objekt zu wählen. Das fiele
   * erst beim ersten Einsatz auf, und zwar dem Team vor der falschen Tür.
   */
  const sichtbareObjekte = React.useMemo(
    () => (kundeId ? objekte.filter((o) => o.customerId === kundeId) : []),
    [kundeId, objekte],
  );

  const heute = new Date().toISOString().slice(0, 10);

  const fields: FieldSpec[] = [
    { name: 'customerId', label: 'Kundschaft', type: 'select', options: kunden, required: true },
    {
      name: 'propertyId',
      label: 'Objekt',
      type: 'select',
      options: sichtbareObjekte.map(({ value, label }) => ({ value, label })),
      half: true,
      hint: kundeId ? undefined : 'Zuerst die Kundschaft wählen.',
    },
    {
      name: 'quoteId',
      label: 'Aus Offerte',
      type: 'select',
      options: offerten,
      half: true,
      hint: 'Nur angenommene Offerten. Ohne Offerte vereinbart? Feld leer lassen.',
    },
    { name: 'title', label: 'Bezeichnung', required: true, placeholder: 'Unterhaltsreinigung Bürogebäude Monbijou' },
    { name: 'description', label: 'Beschreibung', type: 'textarea' },
    { name: 'startDate', label: 'Beginn', type: 'date', required: true, half: true },
    {
      name: 'endDate',
      label: 'Ende',
      type: 'date',
      half: true,
      hint: 'Leer lassen für einen unbefristeten Vertrag.',
    },
    { name: 'responsibleEmployeeId', label: 'Verantwortung', type: 'select', options: personal, half: true },
    { name: 'costCenter', label: 'Kostenstelle', half: true },

    // --- Konditionen der ersten Fassung -------------------------------------
    {
      name: 'pricingModel',
      label: 'Preismodell',
      type: 'select',
      options: [
        { value: 'FIXED_PERIOD', label: 'Pauschale je Periode' },
        { value: 'FIXED_PER_VISIT', label: 'Pauschale je Einsatz' },
        { value: 'HOURLY', label: 'Nach Stunden' },
        { value: 'UNIT_BASED', label: 'Nach Menge' },
        { value: 'CUSTOM', label: 'Abweichende Vereinbarung' },
      ],
      required: true,
      half: true,
    },
    { name: 'baseAmount', label: 'Betrag', type: 'number', min: 0, step: 0.05, suffix: 'CHF', half: true },
    { name: 'hourlyRate', label: 'Stundensatz', type: 'number', min: 0, step: 0.05, suffix: 'CHF', half: true },
    { name: 'unitPrice', label: 'Einzelpreis', type: 'number', min: 0, step: 0.0001, half: true },
    { name: 'unitLabel', label: 'Einheit', placeholder: 'm², Fenster, Stockwerk', half: true },
    {
      name: 'billingCycle',
      label: 'Abrechnung',
      type: 'select',
      options: [
        { value: 'PER_VISIT', label: 'Je Einsatz' },
        { value: 'MONTHLY', label: 'Monatlich' },
        { value: 'QUARTERLY', label: 'Vierteljährlich' },
        { value: 'SEMIANNUAL', label: 'Halbjährlich' },
        { value: 'ANNUAL', label: 'Jährlich' },
      ],
      required: true,
      half: true,
    },
    { name: 'paymentTermDays', label: 'Zahlungsziel', type: 'number', min: 0, max: 180, suffix: 'Tage', half: true },
    { name: 'vatRate', label: 'MwSt-Satz', type: 'number', min: 0, max: 100, step: 0.1, suffix: '%', half: true },
    {
      name: 'noticePeriodDays',
      label: 'Kündigungsfrist',
      type: 'number',
      min: 0,
      max: 730,
      suffix: 'Tage',
      half: true,
    },
    {
      name: 'renewalType',
      label: 'Verlängerung',
      type: 'select',
      options: [
        { value: 'NONE', label: 'Keine' },
        { value: 'AUTOMATIC', label: 'Automatisch' },
        { value: 'MANUAL', label: 'Nur ausdrücklich' },
      ],
      half: true,
    },
    {
      name: 'renewalPeriodMonths',
      label: 'Verlängerung um',
      type: 'number',
      min: 1,
      max: 120,
      suffix: 'Monate',
      half: true,
    },
    {
      name: 'reason',
      label: 'Begründung der Fassung',
      required: true,
      placeholder: 'Erstfassung nach angenommener Offerte',
      hint: 'Steht später in der Versionsgeschichte — und wird gelesen, wenn jemand über den Preis stolpert.',
    },
    { name: 'terms', label: 'Vertragstext', type: 'textarea' },

    // --- Erste Leistung ------------------------------------------------------
    {
      name: 'serviceId',
      label: 'Leistung aus dem Katalog',
      type: 'select',
      options: leistungen,
      half: true,
      hint: 'Nicht als Freitext: Eine Vertragsposition, die nicht im Katalog steht, ist in jeder Auswertung wertlos.',
    },
    {
      name: 'serviceLabel',
      label: 'Bezeichnung auf dem Vertrag',
      required: true,
      half: true,
      placeholder: 'Unterhaltsreinigung Büro',
    },
    { name: 'estimatedMinutes', label: 'Dauer je Einsatz', type: 'number', min: 5, max: 1440, suffix: 'min', half: true },
    { name: 'requiredCrewSize', label: 'Personen', type: 'number', min: 1, max: 50, half: true },
    {
      name: 'requiredSkills',
      label: 'Verlangte Qualifikationen',
      type: 'textarea',
      rows: 2,
      hint: 'Durch Komma oder Zeilen getrennt, gleich benannt wie in der Personalakte.',
    },
    { name: 'specialInstructions', label: 'Besondere Anweisungen', type: 'textarea' },
  ];

  return (
    <ResourceForm
      fields={fields}
      values={{
        startDate: heute,
        pricingModel: 'FIXED_PERIOD',
        billingCycle: 'MONTHLY',
        paymentTermDays: 30,
        vatRate: 8.1,
        noticePeriodDays: 90,
        renewalType: 'NONE',
        estimatedMinutes: 120,
        requiredCrewSize: 1,
      }}
      endpoint="/api/contracts"
      submitLabel="Vertrag anlegen"
      successMessage="Der Vertragsentwurf steht. In Kraft tritt er erst, wenn jemand ihn aktiviert."
      redirectTo="/admin/vertraege/{id}"
      // Die Kundschaft für die Objektauswahl mitverfolgen — bei der Eingabe,
      // nicht erst beim Senden (siehe `onFieldChange` in `ResourceForm`).
      onFieldChange={(name, wert) => {
        if (name === 'customerId') setKundeId(String(wert));
      }}
      transform={(werte) => {

        const zahl = (name: string) =>
          werte[name] === undefined || werte[name] === null || werte[name] === ''
            ? undefined
            : Number(werte[name]);

        return {
          contract: {
            customerId: werte.customerId,
            propertyId: werte.propertyId || undefined,
            quoteId: werte.quoteId || undefined,
            title: werte.title,
            description: werte.description || undefined,
            startDate: werte.startDate,
            endDate: werte.endDate || undefined,
            responsibleEmployeeId: werte.responsibleEmployeeId || undefined,
            costCenter: werte.costCenter || undefined,
          },
          version: {
            effectiveFrom: werte.startDate,
            reason: werte.reason,
            pricingModel: werte.pricingModel,
            baseAmount: zahl('baseAmount') ?? 0,
            hourlyRate: zahl('hourlyRate'),
            unitPrice: zahl('unitPrice'),
            unitLabel: werte.unitLabel || undefined,
            billingCycle: werte.billingCycle,
            paymentTermDays: zahl('paymentTermDays') ?? 30,
            vatRate: zahl('vatRate') ?? 8.1,
            noticePeriodDays: zahl('noticePeriodDays') ?? 90,
            renewalType: werte.renewalType,
            renewalPeriodMonths: zahl('renewalPeriodMonths'),
            terms: werte.terms || undefined,
          },
          services: [
            {
              serviceId: werte.serviceId || undefined,
              label: werte.serviceLabel,
              estimatedMinutes: zahl('estimatedMinutes') ?? 120,
              requiredCrewSize: zahl('requiredCrewSize') ?? 1,
              specialInstructions: werte.specialInstructions || undefined,
              materialsBy: 'PROVIDER',
              // Bis 2026-09-27 fest leer — das Feld gab es im Schema, in der
              // Maske nicht. Jetzt aus der Eingabe, und die Zuteilung prüft es.
              requiredSkills: qualifikationenAus(werte.requiredSkills),
              position: 0,
            },
          ],
        };
      }}
    />
  );
}
