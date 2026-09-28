/**
 * Die Verkaufsphasen einer Anfrage — Stufe und Status sind dasselbe
 * (2026-09-27).
 *
 * ---------------------------------------------------------------------------
 *  Was die „Opportunity" in Clenaris ist
 * ---------------------------------------------------------------------------
 *
 * Es gibt kein eigenes Modell für Verkaufschancen, und das ist die Absicht:
 * Eine Anfrage (`Lead`) ist die Verkaufschance. Sie durchläuft die Stufen der
 * Pipeline (`PipelineStage`, je Organisation, Schlüssel `new` … `lost`) und
 * endet gewonnen — dann wird sie in eine Kundschaft überführt
 * (`convertLeadToCustomer`) — oder verloren, mit Grund. Der geschätzte Wert
 * steht an der Anfrage (`estimatedValue`), die Summe offener Werte im
 * Dashboard.
 *
 * ---------------------------------------------------------------------------
 *  Warum eine Zuordnung an einer Stelle
 * ---------------------------------------------------------------------------
 *
 * Eine Anfrage trägt Stufe **und** Status. Dass beide übereinstimmen, sorgte
 * bis 2026-09-27 nur das Kanban im Browser: Es schickte zur Stufe den
 * passenden Status mit. Wer die Schnittstelle direkt aufrief, konnte eine
 * Anfrage in die Stufe „gewonnen" legen und ihren Status auf „neu" lassen —
 * Liste, Kanban und Kennzahlen zeigten dann Verschiedenes. Jetzt leitet der
 * Server das eine aus dem anderen ab, mit dieser Zuordnung; das Kanban nutzt
 * dieselbe.
 *
 * Ohne `server-only` und ohne Abhängigkeiten — Browser und Server.
 */

export type LeadStatus = 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'PROPOSAL' | 'WON' | 'LOST';

const STUFE_ZU_STATUS: Record<string, LeadStatus> = {
  new: 'NEW',
  contacted: 'CONTACTED',
  qualified: 'QUALIFIED',
  proposal: 'PROPOSAL',
  won: 'WON',
  lost: 'LOST',
};

/** Status zu einem Stufenschlüssel; unbekannte eigene Stufen gelten als offen („NEW"). */
export function statusZurStufe(schluessel: string): LeadStatus {
  return STUFE_ZU_STATUS[schluessel] ?? 'NEW';
}

/** Stufenschlüssel zu einem Status — für einen Statuswechsel ohne Stufenangabe. */
export function stufeZumStatus(status: string): string | null {
  return Object.entries(STUFE_ZU_STATUS).find(([, s]) => s === status)?.[0] ?? null;
}
