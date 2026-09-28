import 'server-only';

import { audit } from '@/lib/audit';

/**
 * Nachweis der KI-Nutzung (Wave 15, 2026-09-23).
 *
 * Bis hierher liess sich nicht sagen, wer wann welche KI-Funktion genutzt
 * hatte — die Endpunkte schrieben kein Protokoll. Für eine Übermittlung an
 * einen Auftragsverarbeiter ist das die Mindestanforderung: wer, wann,
 * welche Funktion.
 *
 * **Ohne Inhalt.** Weder Eingabe noch Ergebnis stehen im Protokoll — sie
 * können genau die Personendaten enthalten, die der Ausgangsfilter vom
 * Modell fernhält, und das Prüfprotokoll wird bewusst nicht bereinigt.
 */
export async function protokolliereKiNutzung(params: {
  organizationId: string;
  userId: string;
  funktion: string;
  ip?: string | null;
  /**
   * Metadaten der Nutzung (2026-09-28, Textassistent): Aktion, Feldart,
   * Längen, Modell, Dauer. **Nur Zahlen und Schlüssel aus dem Code** — der
   * Typ lässt keine verschachtelten Werte zu, und der Aufrufer reicht nie
   * Eingabe oder Ergebnis hinein. Wer hier einen Text übergibt, schreibt ihn
   * in die eine Tabelle, die bewusst nicht bereinigt wird.
   */
  details?: Record<string, string | number | boolean>;
}): Promise<void> {
  await audit.created({
    organizationId: params.organizationId,
    userId: params.userId,
    entity: 'KiNutzung',
    summary: `KI-Funktion „${params.funktion}" genutzt — Entwurf, keine Entscheidung`,
    changes: { ...params.details, funktion: params.funktion },
    ip: params.ip,
  });
}
