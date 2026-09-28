/**
 * Öffentlich bekannte Zugangsdaten — und wo sie gelten dürfen.
 *
 * ---------------------------------------------------------------------------
 *  Warum es diese Liste gibt
 * ---------------------------------------------------------------------------
 *
 * Die Passwörter unten standen in `README.md`, `.env.example`, in den Seeds
 * und in der Prüfreihe — in einem **öffentlichen** Repository. Sie sind damit
 * verbrannt, und zwar endgültig: Aus der Git-Geschichte lassen sie sich nicht
 * mehr entfernen, und jede Kopie des Repositories trägt sie weiter. Sie aus
 * der Dokumentation zu streichen, machte kein einziges bereits gesetztes
 * Passwort ungültig; ein Konto, das eines davon trägt, bliebe offen.
 *
 * Der Notfallauftrag vom 2026-09-27 hielt fest, dass auf dem Produktionsserver
 * genau so ein Konto anmeldbar war. Die Ursache lag nicht in einer einzelnen
 * Zeile, sondern in drei Wegen, die einander nicht kannten:
 *
 *   1. `prisma/seed.ts` — der Seed *für ein echtes System* — legte die
 *      Betriebsleitung und fünf Mitarbeitende mit `Demo#2026Clenaris` an und
 *      setzte das Passwort bei jedem Lauf wieder darauf zurück.
 *   2. Seine Produktionsschranke prüfte nur die **Länge** von
 *      `SEED_ADMIN_PASSWORD`. Wer den Wert aus `.env.example` übernahm, kam
 *      mit 18 Zeichen durch.
 *   3. Die Anmeldung wusste von alldem nichts.
 *
 * Deshalb steht die Liste hier **einmal**, und alle Wege fragen sie: die
 * Anmeldung (`auth.service.ts`), jedes Setzen eines Passworts
 * (`hashPassword`), die Seeds, `scripts/create-admin.ts` und die
 * Produktionsvorprüfung (`scripts/production-preflight.ts`), die bestehende
 * Konten gegen die Liste prüft.
 *
 * ---------------------------------------------------------------------------
 *  Warum Klartext
 * ---------------------------------------------------------------------------
 *
 * Eine Liste von Hashwerten sähe vorsichtiger aus und wäre es nicht: Die
 * Werte sind öffentlich, ein Hash verbirgt nichts mehr. Die Vorprüfung muss
 * sie zudem gegen die Argon2-Hashes in der Datenbank prüfen — dafür braucht
 * sie den Klartext. Geschützt wird hier nichts durch Geheimhaltung, sondern
 * dadurch, dass diese Werte in der Produktion **nie** mehr ein Konto öffnen.
 * Ausgegeben oder protokolliert werden sie nirgends; Meldungen nennen nur die
 * Zahl der Treffer und das Konto.
 *
 * Kein `server-only` und kein Pfad-Alias: Die Seeds unter `prisma/` und die
 * Skripte unter `scripts/` laden dieses Modul ausserhalb von Next.
 */

/**
 * Jedes Passwort, das je im Repository stand, um ein Konto zu öffnen.
 *
 * Ergänzen, nie kürzen: Ein Wert, der einmal veröffentlicht war, wird nicht
 * wieder geheim, nur weil er aus dem Quelltext verschwindet.
 */
export const OEFFENTLICHE_PASSWOERTER: readonly string[] = [
  // Demokonten (Betriebsleitung, Mitarbeitende, Kundschaft) — seed.ts, seed-demo.ts, README
  'Demo#2026Clenaris',
  // Rückfallwert von SEED_ADMIN_PASSWORD — seed.ts, .env.example, README
  'Admin#2026Clenaris',
  // Rückfallwert von SEED_SUPERADMIN_PASSWORD — seed.ts, .env.example, README
  'System#2026Clenaris',
  // Vorschaudatenbank — seed-preview.ts, setup-preview-db.ts
  'Preview#2026Admin',
  'Preview#2026Team',
  'Preview#2026Kunde',
];

/**
 * Die E-Mail-Adressen der Demokonten. Auch sie sind öffentlich; ein Konto
 * unter einer davon ist in der Produktion ein Hinweis auf einen Demo-Seed,
 * nicht zwingend ein Fehler (die Verwaltungsadressen lassen sich über
 * `SEED_ADMIN_EMAIL` bewusst beibehalten). Die Vorprüfung meldet sie als
 * Warnung, das Passwort entscheidet.
 */
export const OEFFENTLICHE_DEMO_ADRESSEN: readonly string[] = [
  'admin@clenaris.ch',
  'system@clenaris.ch',
  'manager@clenaris.ch',
  'anna.keller@clenaris.ch',
  'luis.moreira@clenaris.ch',
  'elena.rossi@clenaris.ch',
  'tomas.novak@clenaris.ch',
  'fatima.haddad@clenaris.ch',
  'nicole.wyss@example.ch',
  'admin@preview.clenaris.local',
  'mitarbeiterin@preview.clenaris.local',
  'kundin@preview.clenaris.local',
];

/**
 * Normalform für den Vergleich: ohne Rand-Leerzeichen, ohne Gross/Klein.
 *
 * Bewusst strenger als der Argon2-Vergleich selbst. `demo#2026clenaris` ist
 * kein anderes Passwort als das veröffentlichte, sondern dasselbe mit einer
 * Umschalttaste weniger — genau die Abwandlung, die ein Angreifer als Erstes
 * durchprobiert.
 */
function normalform(passwort: string): string {
  return passwort.trim().toLowerCase();
}

const VERBRANNT = new Set(OEFFENTLICHE_PASSWOERTER.map(normalform));

/** Ist dieses Passwort eines der veröffentlichten? */
export function istOeffentlichesPasswort(passwort: string): boolean {
  return VERBRANNT.has(normalform(passwort));
}

/**
 * Datenbankname aus einer Postgres-Adresse — eigene Kopie der Logik aus
 * `prisma/seed-guard.ts`, weil `src/` nicht aus `prisma/` importiert (die
 * Abhängigkeit läuft nur in die andere Richtung).
 */
function datenbankname(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const pfad = new URL(url).pathname.replace(/^\//, '');
    return pfad.length > 0 ? pfad : null;
  } catch {
    const treffer = /\/([^/?#]+)(\?|$)/.exec(url.replace(/^[a-z+]+:\/\//i, ''));
    return treffer?.[1] ?? null;
  }
}

/** Namen, die eine Wegwerf-Datenbank ausweisen: Prüfung, Vorschau, Demo. */
const WEGWERF_DATENBANK = /(^|[_-])(test|preview|demo|scratch|sandbox)($|[_-])|_test$/i;

/** Weist der Name der Datenbank (aus der Adresse) sie als Wegwerf-Datenbank aus? */
export function istWegwerfDatenbank(url: string | undefined): boolean {
  const name = datenbankname(url);
  return name !== null && WEGWERF_DATENBANK.test(name);
}

/**
 * Dürfen die veröffentlichten Zugangsdaten in **dieser** Instanz gelten?
 *
 * Ja in der Entwicklung (`NODE_ENV` nicht `production`) — dort ist die
 * Demo-Anmeldung der Sinn der Sache, und die Maschine ist nicht erreichbar.
 *
 * In einem Produktionsbau nur, wenn **beides** stimmt:
 *
 *   • `CLENARIS_UMGEBUNG` ist `test` oder `preview` — gesetzt ausschliesslich
 *     von `scripts/test-server.ts` und `scripts/preview-server.ts`;
 *   • der Name der Datenbank weist sie als Wegwerf-Datenbank aus
 *     (`clenaris_test`, `clenaris_preview`).
 *
 * Zwei Bedingungen statt einer, weil jede allein durch einen einzigen
 * Tippfehler in einer `.env` erfüllt wäre. Eine Produktion, die aus Versehen
 * `CLENARIS_UMGEBUNG=test` trägt, läuft weiter gegen `clenaris` — und bleibt
 * damit geschützt. Die Produktionsvorprüfung weist beides zusätzlich ab.
 *
 * Fehlt eine Angabe, gilt „nein". Ein Schutz, der bei unklarer Lage öffnet,
 * schützt nur die, die ihn nicht brauchen.
 */
export function oeffentlicheZugangsdatenErlaubt(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.NODE_ENV !== 'production') return true;
  const umgebung = env.CLENARIS_UMGEBUNG?.trim();
  if (umgebung !== 'test' && umgebung !== 'preview') return false;
  return istWegwerfDatenbank(env.DATABASE_URL);
}

/**
 * Die eine Frage, die Anmeldung und Passwortwechsel stellen: Ist dieses
 * Passwort hier gesperrt?
 */
export function passwortHierGesperrt(
  passwort: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return istOeffentlichesPasswort(passwort) && !oeffentlicheZugangsdatenErlaubt(env);
}

/** Die Meldung für jedes Formular, das ein neues Passwort setzt. */
export const MELDUNG_OEFFENTLICHES_PASSWORT =
  'Dieses Passwort ist öffentlich bekannt und darf nicht verwendet werden. Bitte wählen Sie ein anderes.';
