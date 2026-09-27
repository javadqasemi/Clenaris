'use client';

import { FormDialog, type FieldSpec, type FieldValues } from '@/components/app/resource-form';

/**
 * Quellensteuertarif einlesen (2026-09-27).
 *
 * Den Endpunkt `POST /api/payroll/withholding/rates` gab es, eine Maske nicht
 * — die Merkmalsprüfung meldete ihn als „schreibend, ohne Aufruf". Ohne
 * Maske liess sich kein Tarif erfassen, und jede quellensteuerpflichtige
 * Abrechnung endete in „Prüfung erforderlich".
 *
 * Eingefügt wird ein Ausschnitt der kantonalen Tarifdatei, eine Stufe je
 * Zeile: `Tarif; ab; bis; Satz` — so, wie er aus einer Tabellenkalkulation
 * kommt (Semikolon oder Tabulator, Tausender-Apostroph und Dezimalkomma sind
 * erlaubt). Geprüft wird auf dem Server; eine fehlerhafte Zeile lässt den
 * ganzen Stapel scheitern, damit kein halber Tarif entsteht.
 */

const FELDER: FieldSpec[] = [
  { name: 'canton', label: 'Kanton', required: true, half: true, placeholder: 'BE' },
  { name: 'year', label: 'Jahr', type: 'number', min: 2020, max: 2100, required: true, half: true },
  { name: 'source', label: 'Quelle', required: true, placeholder: 'z. B. Tarifdatei Steuerverwaltung Bern 2026, tar26be.txt' },
  { name: 'reference', label: 'Referenz', placeholder: 'Dokument, Stand, Seite' },
  {
    name: 'zeilen',
    label: 'Tarifstufen',
    type: 'textarea',
    rows: 8,
    required: true,
    placeholder: 'A0N;0;2500;0.00\nA0N;2500;2600;0.26\nA0N;2600;;0.52',
    hint: 'Eine Stufe je Zeile: Tarif; Einkommen ab; bis (leer = offen); Satz in %.',
  },
];

function zahl(text: string): number {
  return Number(text.replace(/['’\s]/g, '').replace(',', '.'));
}

/** Zeilen in die Form der Schnittstelle bringen; Unlesbares geht als `NaN` zum Server und wird dort benannt. */
function zeilenLesen(werte: FieldValues): FieldValues {
  const { zeilen, ...rest } = werte;
  const rows = String(zeilen ?? '')
    .split(/\r?\n/)
    .map((z) => z.trim())
    .filter(Boolean)
    .map((z) => {
      const [tariffCode = '', von = '', bis = '', satz = ''] = z.split(/[;\t]/).map((t) => t.trim());
      return {
        tariffCode: tariffCode.toUpperCase(),
        incomeFrom: zahl(von),
        incomeTo: bis === '' ? null : zahl(bis),
        ratePct: zahl(satz),
      };
    });
  return { ...rest, canton: String(rest.canton ?? '').toUpperCase(), rows };
}

export function QuellensteuerTarifEinlesen({ jahr }: { jahr: number }) {
  return (
    <FormDialog
      title="Quellensteuertarif einlesen"
      description="Ein Ausschnitt der kantonalen Tarifdatei. Eingelesen wird ungeprüft; bestätigt wird der Stapel danach mit Vermerk."
      triggerLabel="Tarif"
      triggerVariant="outline"
      triggerSize="sm"
      endpoint="/api/payroll/withholding/rates"
      successMessage="Tarif eingelesen — noch ungeprüft."
      fields={FELDER}
      values={{ canton: 'BE', year: jahr }}
      transform={zeilenLesen}
      size="lg"
    />
  );
}
