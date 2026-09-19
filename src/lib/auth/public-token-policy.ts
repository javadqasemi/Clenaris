import type { PublicTokenPurpose } from '@prisma/client';

/**
 * Die Regeln für öffentliche Zugriffstokens — als reine Rechnung.
 *
 * **Warum getrennt vom Dienst.** `access-token.service.ts` trägt
 * `server-only` und spricht mit der Datenbank. Diese beiden Regeln sind aber
 * genau die, bei denen ein Fehler teuer ist — die eine entscheidet, ob ein
 * Ansichtslink handeln darf, die andere, ob ein alter cuid überhaupt noch
 * gilt. Sie sollen ohne halben Serverstart prüfbar sein; eine Prüfung, die
 * eine laufende Anwendung braucht, wird irgendwann nicht mehr ausgeführt.
 */

/**
 * Welcher Zweck welche Zwecke miteinschliesst.
 *
 * **Warum eine Hierarchie und nicht zwei Tokens pro E-Mail.** Wer eine
 * Offerte annehmen darf, muss sie vorher ansehen dürfen — das ist keine
 * zweite Berechtigung, sondern dieselbe, eine Stufe tiefer. Zwei Links in
 * einer E-Mail wären zwei Geheimnisse, zwei Ablaufdaten und zwei
 * Gelegenheiten, eines davon zu vergessen.
 *
 * **Warum die Implikation nur in diese Richtung geht.** `QUOTE_RESPOND`
 * schliesst `QUOTE_VIEW` ein, niemals umgekehrt. Ein Link, der zum Ansehen
 * weitergegeben wurde — an die Buchhaltung der Kundin etwa —, darf die
 * Offerte nicht annehmen können. Dasselbe bei der Rechnung: `INVOICE_PAY`
 * kann ansehen, `INVOICE_VIEW` kann nicht zahlen.
 */
const PURPOSE_IMPLIES: Partial<Record<PublicTokenPurpose, PublicTokenPurpose[]>> = {
  QUOTE_RESPOND: ['QUOTE_VIEW'],
  INVOICE_PAY: ['INVOICE_VIEW'],
};

/**
 * Alle Zwecke, die diese Anforderung erfüllen können.
 *
 * Aus „ich brauche `QUOTE_VIEW`" wird „`QUOTE_VIEW` oder `QUOTE_RESPOND`".
 * Aus „ich brauche `QUOTE_RESPOND`" wird nur `QUOTE_RESPOND`.
 */
export function purposesSatisfying(benoetigt: PublicTokenPurpose): PublicTokenPurpose[] {
  const passend = new Set<PublicTokenPurpose>([benoetigt]);
  for (const [staerker, eingeschlossen] of Object.entries(PURPOSE_IMPLIES)) {
    if (eingeschlossen?.includes(benoetigt)) passend.add(staerker as PublicTokenPurpose);
  }
  return [...passend];
}

/**
 * Darf ein alter `publicToken` aus der cuid-Zeit noch verwendet werden?
 *
 * **Die Vorgabe ist „nein" — das ist die wichtige Korrektur.** In Gate 1
 * stand hier `!== 'aus'`: Der Rückfall galt, solange ihn niemand
 * ausdrücklich abschaltete. Das ist die falsche Richtung. Eine Umgebung, in
 * der die Einstellung vergessen wurde — eine neue Instanz, ein neuer Server,
 * eine verlorene Umgebungsdatei —, hätte damit still den schwachen Weg offen
 * gehabt. Eine vergessene Einstellung muss zur sicheren Seite fallen, nicht
 * zur bequemen.
 *
 * Verlangt wird deshalb eine ausdrückliche Zustimmung. Akzeptiert werden
 * `true`, `an` und `1`; alles andere, auch das Fehlen der Einstellung,
 * heisst: kein Zugriff über alte cuid-Links.
 *
 * Unabhängig davon bekommen abschliessende Handlungen nie einen Rückfall —
 * das entscheidet der Aufrufer über `allowLegacy`, nicht diese Funktion.
 */
export function legacyTokensAllowed(): boolean {
  const wert = process.env.LEGACY_PUBLIC_TOKENS?.trim().toLowerCase();
  return wert === 'true' || wert === 'an' || wert === '1';
}
