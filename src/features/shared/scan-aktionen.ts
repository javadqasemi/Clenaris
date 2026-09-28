import type { FieldSpec, FieldValues } from '@/components/app/resource-form';
import { defektFields, maintenanceFields, materialFields } from '@/features/admin/betrieb-fields';

/**
 * Schnellaktionen nach einem Scan (Scanplattform, 2026-09-26): welcher
 * bestehende Endpunkt mit welcher Maske.
 *
 * Ohne `'use client'` — die Datei beschreibt nur, sie tut nichts, und der
 * Server-Teil braucht dieselben Schlüssel.
 *
 * **Die Endpunkte sind die bestehenden.** Jede Aktion hier ist genau das,
 * was die Material-, Geräte-, Rechnungs- oder Zeiterfassungsseite ohnehin
 * sendet; der Scanner spart nur den Weg dorthin. Deshalb gelten dieselben
 * Rechte, dieselben Schemas, dieselben Sperren (Zeilensperre beim Lager,
 * Zuteilungsprüfung beim Einstempeln) und derselbe Protokolleintrag.
 * Die ID im Pfad kommt aus der Antwort des Servers auf den Scan — nie aus
 * dem gescannten Text.
 *
 * **Nichts läuft von allein.** Eine Aktion öffnet eine Maske; gesendet wird
 * erst mit dem Knopf darin. Auch „Wieder verfügbar" ohne Felder verlangt
 * diesen einen Klick — ein Scan, der von sich aus einen Status setzt, wäre
 * mit einem vertauschten Etikett eine Änderung am falschen Gerät.
 */

export type ScanAktionSchluessel =
  | 'material.eingang'
  | 'material.entnahme'
  | 'material.korrektur'
  | 'geraet.wartung'
  | 'geraet.defekt'
  | 'geraet.verfuegbar'
  | 'einsatz.einstempeln'
  | 'rechnung.zahlung';

export interface AktionsMaske {
  titel: string;
  endpoint: string;
  fields: FieldSpec[];
  values?: FieldValues;
  extra?: FieldValues;
  submitLabel: string;
  successMessage: string;
}

const ZAHLUNGSARTEN = [
  { value: 'BANK_TRANSFER', label: 'Überweisung' },
  { value: 'CASH', label: 'Bar' },
  { value: 'TWINT', label: 'TWINT' },
  { value: 'CARD', label: 'Karte' },
  { value: 'OTHER', label: 'Andere' },
];

/** Heutiges Datum in Zürich als JJJJ-MM-TT — erst beim Öffnen der Maske berechnet, nie beim Rendern. */
function heute(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Zurich' }).format(new Date());
}

export function aktionsMaske(schluessel: ScanAktionSchluessel, id: string): AktionsMaske {
  const pfad = encodeURIComponent(id);
  switch (schluessel) {
    case 'material.eingang':
      return {
        titel: 'Wareneingang',
        endpoint: `/api/materials/${pfad}/movements`,
        extra: { kind: 'RECEIPT' },
        fields: [
          { name: 'quantity', label: 'Menge', type: 'number', step: 0.5, min: 0.5, required: true, half: true },
          { name: 'reference', label: 'Lieferschein', half: true },
        ],
        submitLabel: 'Eingang buchen',
        successMessage: 'Eingang gebucht.',
      };
    case 'material.entnahme':
      return {
        titel: 'Entnahme',
        endpoint: `/api/materials/${pfad}/movements`,
        extra: { kind: 'ISSUE' },
        fields: [
          { name: 'quantity', label: 'Menge', type: 'number', step: 0.5, min: 0.5, required: true, half: true },
          { name: 'note', label: 'Wofür', type: 'textarea', rows: 2, required: true, hint: 'Entnahmen für einen Einsatz bitte im Einsatz buchen — dann zählen sie zur Nachkalkulation.' },
        ],
        submitLabel: 'Entnahme buchen',
        successMessage: 'Entnahme gebucht.',
      };
    case 'material.korrektur':
      return {
        titel: 'Inventurkorrektur',
        endpoint: `/api/materials/${pfad}/movements`,
        extra: { kind: 'ADJUSTMENT' },
        fields: [
          { name: 'quantity', label: 'Differenz (±)', type: 'number', step: 0.5, required: true, half: true, hint: 'Mehr gezählt: positiv. Weniger: negativ.' },
          { name: 'note', label: 'Begründung', type: 'textarea', rows: 2, required: true },
        ],
        submitLabel: 'Korrektur buchen',
        successMessage: 'Korrektur gebucht.',
      };
    case 'geraet.wartung':
      return {
        titel: 'Wartung erfassen',
        endpoint: `/api/equipment/${pfad}/maintenance`,
        fields: maintenanceFields(),
        values: { performedOn: heute() },
        submitLabel: 'Wartung speichern',
        successMessage: 'Wartung erfasst.',
      };
    case 'geraet.defekt':
      return {
        titel: 'Defekt melden',
        endpoint: `/api/equipment/${pfad}/status`,
        extra: { status: 'MAINTENANCE' },
        fields: defektFields(),
        submitLabel: 'In Wartung geben',
        successMessage: 'Gerät in Wartung gegeben.',
      };
    case 'geraet.verfuegbar':
      return {
        titel: 'Wieder verfügbar',
        endpoint: `/api/equipment/${pfad}/status`,
        extra: { status: 'AVAILABLE' },
        fields: [],
        submitLabel: 'Als verfügbar melden',
        successMessage: 'Gerät wieder verfügbar.',
      };
    case 'einsatz.einstempeln':
      return {
        titel: 'Einstempeln',
        endpoint: '/api/time/clock-in',
        extra: { jobId: id },
        fields: [{ name: 'note', label: 'Notiz', type: 'textarea', rows: 2 }],
        submitLabel: 'Einstempeln',
        successMessage: 'Eingestempelt.',
      };
    case 'rechnung.zahlung':
      return {
        titel: 'Zahlung erfassen',
        endpoint: `/api/invoices/${pfad}/payments`,
        fields: [
          { name: 'amount', label: 'Betrag', type: 'number', step: 0.05, min: 0.05, suffix: 'CHF', required: true, half: true },
          { name: 'method', label: 'Zahlungsart', type: 'select', options: ZAHLUNGSARTEN, required: true, half: true },
          { name: 'reference', label: 'Beleg' },
        ],
        values: { method: 'BANK_TRANSFER' },
        submitLabel: 'Zahlung verbuchen',
        successMessage: 'Zahlung erfasst.',
      };
  }
}

/** Maske „Neuen Artikel erfassen" — vorbelegt ist nur der Strichcode, nichts sonst. */
export function neuerArtikelMaske(barcode: string): AktionsMaske {
  return {
    titel: 'Neuen Artikel erfassen',
    endpoint: '/api/materials',
    fields: materialFields(),
    values: { barcode, unit: 'Stk.', unitCost: 0, minStock: 0 },
    submitLabel: 'Artikel anlegen',
    successMessage: 'Artikel angelegt.',
  };
}
