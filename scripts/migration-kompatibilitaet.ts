/**
 * Migrations-Verträglichkeit — passt eine Migration zur **vorherigen**
 * Programmfassung?
 *
 *   npx tsx scripts/migration-kompatibilitaet.ts            Prüfung (Tor)
 *   npx tsx scripts/migration-kompatibilitaet.ts --bericht  jede Migration mit Einstufung und Fundstellen
 *
 * ---------------------------------------------------------------------------
 *  Wozu
 * ---------------------------------------------------------------------------
 *
 * Die Auslieferung vom 2026-09-27 auf den alten Server migrierte die
 * Datenbank, **bevor** der neue Bau fertig war. Rund zehn Minuten lief die
 * alte Anwendung gegen das neue Schema. Das ist gefahrlos, solange jede
 * Migration rückwärtsverträglich ist — und genau das wusste niemand, weil es
 * nirgends stand. Ein Rücksprung der Anwendung (`release-aktivieren.sh`)
 * hat dieselbe Voraussetzung: Er stellt das Programm zurück, nie das Schema.
 *
 * Also wird die Frage je Migration beantwortet und festgehalten:
 *
 *   RUECKWAERTSVERTRAEGLICH   die alte Fassung läuft unverändert weiter
 *   RUECKFUELLUNG             Daten werden umgeschrieben; verträglich, aber
 *                             die Laufzeit der Migration zählt
 *   PROGRAMMWECHSEL           die alte Fassung scheitert an einzelnen Wegen
 *                             (neue Pflichtspalte ohne Vorgabe, neue Schranke
 *                             auf bestehender Tabelle) — Migration und
 *                             Umschalten gehören unmittelbar zusammen
 *   BRECHEND                  die alte Fassung scheitert grundsätzlich
 *                             (Spalte/Tabelle weg, umbenannt, Typ gewechselt)
 *                             — nur über Erweitern → Umschalten → Rückbau
 *                             oder mit Wartungsfenster
 *
 * ---------------------------------------------------------------------------
 *  Heuristik und Durchsicht
 * ---------------------------------------------------------------------------
 *
 * Die Einstufung aus dem SQL ist eine **Heuristik**: Sie erkennt Muster
 * (`DROP`, `RENAME`, `ALTER … TYPE`, `SET NOT NULL`, neue Pflichtspalte ohne
 * `DEFAULT`, Eindeutigkeit oder Prüfregel auf einer bestehenden Tabelle,
 * `UPDATE`) und kennt den Zusammenhang nicht. Verbindlich ist deshalb die
 * **durchgesehene** Einstufung in `security/migrations-vertraeglichkeit.json`.
 *
 * Das Tor scheitert, wenn
 *
 *   1. eine Migration dort fehlt — eine neue Migration ohne Durchsicht kommt
 *      nicht durch, und zwar schon im CI, nicht erst am Server;
 *   2. die Heuristik strenger urteilt als die Durchsicht und die Durchsicht
 *      keine Begründung nennt — wer eine Warnung übergeht, schreibt hin, warum;
 *   3. der Eintrag auf eine Migration zeigt, die es nicht gibt.
 *
 * Eine Heuristik, die allein den Bau anhielte, würde binnen einer Woche mit
 * Ausnahmen stillgelegt; eine Durchsicht ohne Heuristik übersähe das nächste
 * `DROP COLUMN`. Beides zusammen ist das Tor.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Einstufung = 'RUECKWAERTSVERTRAEGLICH' | 'RUECKFUELLUNG' | 'PROGRAMMWECHSEL' | 'BRECHEND';

const RANG: Record<Einstufung, number> = {
  RUECKWAERTSVERTRAEGLICH: 0,
  RUECKFUELLUNG: 1,
  PROGRAMMWECHSEL: 2,
  BRECHEND: 3,
};

export interface Fundstelle {
  einstufung: Einstufung;
  muster: string;
  auszug: string;
}

export interface Befund {
  migration: string;
  einstufung: Einstufung;
  fundstellen: Fundstelle[];
}

/** Namen ohne Anführungszeichen und Schema-Präfix. */
function name(roh: string): string {
  return roh.replace(/"/g, '').replace(/^public\./, '');
}

/** Kommentare entfernen — ein auskommentiertes Beispiel ist keine Anweisung. */
function ohneKommentare(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

/**
 * Anweisungen einzeln. Funktionskörper (`$$ … $$`) bleiben ganz — sonst
 * zerlegte ein Semikolon im Trigger-Körper die Anweisung in Stücke, die wie
 * eigenständige `UPDATE`s aussähen.
 */
function anweisungen(sql: string): string[] {
  const teile: string[] = [];
  let rest = sql;
  let aktuell = '';
  while (rest.length > 0) {
    const dollar = rest.indexOf('$$');
    const semikolon = rest.indexOf(';');
    if (semikolon === -1 && dollar === -1) {
      aktuell += rest;
      break;
    }
    if (dollar !== -1 && (semikolon === -1 || dollar < semikolon)) {
      const ende = rest.indexOf('$$', dollar + 2);
      const bis = ende === -1 ? rest.length : ende + 2;
      aktuell += rest.slice(0, bis);
      rest = rest.slice(bis);
      continue;
    }
    aktuell += rest.slice(0, semikolon);
    teile.push(aktuell.trim());
    aktuell = '';
    rest = rest.slice(semikolon + 1);
  }
  if (aktuell.trim()) teile.push(aktuell.trim());
  return teile.filter((t) => t.length > 0);
}

function auszug(anweisung: string): string {
  return anweisung.replace(/\s+/g, ' ').slice(0, 160);
}

/**
 * Eine Migration einstufen.
 *
 * `vorhandeneTabellen` sind die Tabellen, die **frühere** Migrationen
 * angelegt haben. Was dieselbe Migration erst anlegt, kann die alte Fassung
 * nicht kennen und also nicht brechen — ein `NOT NULL` oder eine
 * Eindeutigkeit dort ist harmlos.
 */
export function migrationEinstufen(
  migration: string,
  sql: string,
  vorhandeneTabellen: ReadonlySet<string>,
  vorhandeneFunktionen: ReadonlySet<string> = new Set(),
): Befund {
  const fundstellen: Fundstelle[] = [];
  const rein = ohneKommentare(sql);
  const neu = new Set<string>();
  for (const t of rein.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w.]+"?)/gi)) neu.add(name(t[1]!));

  const bestehend = (tabelle: string) => vorhandeneTabellen.has(tabelle) && !neu.has(tabelle);
  const melde = (einstufung: Einstufung, muster: string, anweisung: string) =>
    fundstellen.push({ einstufung, muster, auszug: auszug(anweisung) });

  for (const a of anweisungen(rein)) {
    // Funktionskörper sind Programmtext der Datenbank. Eine **neue** Funktion
    // wirkt erst über ihren Trigger, und den meldet die Triggeranweisung. Eine
    // **ersetzte** dagegen ändert die Schreibregeln eines Triggers, der längst
    // an einer bestehenden Tabelle hängt — ohne dass eine Zeile Schema
    // anders aussieht. Ob sie lockert oder verschärft, sieht nur die
    // Durchsicht.
    const funktion = /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+("?[\w.]+"?)/i.exec(a);
    if (funktion) {
      if (vorhandeneFunktionen.has(name(funktion[1]!))) {
        melde('PROGRAMMWECHSEL', `Datenbankfunktion ersetzt: ${name(funktion[1]!)} (Schreibregeln prüfen)`, a);
      }
      continue;
    }

    // Ein neuer Aufzählungswert bricht die alte Fassung nicht, solange nur
    // die neue ihn schreibt. Nach einem Rücksprung liest die alte Fassung
    // ihn aber und kennt ihn nicht — deshalb sichtbar, ohne Verschärfung.
    if (/^ALTER\s+TYPE\s+\S+\s+ADD\s+VALUE/i.test(a)) {
      melde('RUECKWAERTSVERTRAEGLICH', 'Neuer Aufzählungswert (nach Rücksprung der alten Fassung unbekannt)', a);
    }

    if (/^DROP\s+TABLE/i.test(a)) melde('BRECHEND', 'DROP TABLE', a);
    if (/^DROP\s+TYPE/i.test(a)) melde('BRECHEND', 'DROP TYPE', a);
    if (/^ALTER\s+TYPE\s+\S+\s+RENAME/i.test(a)) melde('BRECHEND', 'Aufzählung umbenannt', a);
    if (/^ALTER\s+TABLE\s+\S+\s+RENAME\b/i.test(a)) melde('BRECHEND', 'RENAME', a);
    if (/^TRUNCATE/i.test(a)) melde('BRECHEND', 'TRUNCATE', a);

    const tabelle = /^ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?("?[\w.]+"?)/i.exec(a);
    if (tabelle) {
      const t = name(tabelle[1]!);
      const alt = bestehend(t);
      if (/\bDROP\s+COLUMN\b/i.test(a)) melde('BRECHEND', 'DROP COLUMN', a);
      if (/\bRENAME\s+(COLUMN\s+)?"?\w+"?\s+TO\b/i.test(a)) melde('BRECHEND', 'RENAME COLUMN', a);
      if (alt && /\bALTER\s+COLUMN\s+"?\w+"?\s+(SET\s+DATA\s+)?TYPE\b/i.test(a)) melde('BRECHEND', 'Spaltentyp geändert', a);
      if (alt && /\bALTER\s+COLUMN\s+"?\w+"?\s+SET\s+NOT\s+NULL\b/i.test(a)) melde('PROGRAMMWECHSEL', 'SET NOT NULL auf bestehender Spalte', a);
      if (alt && /\bALTER\s+COLUMN\s+"?\w+"?\s+DROP\s+DEFAULT\b/i.test(a)) melde('PROGRAMMWECHSEL', 'DROP DEFAULT', a);
      if (alt && /\bADD\s+CONSTRAINT\b[\s\S]*\bCHECK\b/i.test(a)) melde('PROGRAMMWECHSEL', 'Prüfregel auf bestehender Tabelle', a);
      if (alt && /\bADD\s+CONSTRAINT\b[\s\S]*\bUNIQUE\b/i.test(a)) melde('PROGRAMMWECHSEL', 'Eindeutigkeit auf bestehender Tabelle', a);
      if (alt && /\bDROP\s+CONSTRAINT\b/i.test(a)) melde('PROGRAMMWECHSEL', 'DROP CONSTRAINT (Fremdschlüssel/Regel neu gefasst)', a);
      if (alt) {
        // Neue Pflichtspalte ohne Vorgabe: Die alte Fassung kennt die Spalte
        // nicht und lässt sie bei jedem INSERT weg — Postgres weist ab.
        for (const s of a.matchAll(/\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?\s+([^,]+)/gi)) {
          const def = s[2]!;
          if (/\bNOT\s+NULL\b/i.test(def) && !/\bDEFAULT\b/i.test(def) && !/\bGENERATED\b/i.test(def)) {
            melde('PROGRAMMWECHSEL', `Neue Pflichtspalte ohne DEFAULT: ${s[1]}`, a);
          }
        }
      }
    }

    const eindeutig = /^CREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?\w+"?\s+ON\s+("?[\w.]+"?)/i.exec(a);
    if (eindeutig && bestehend(name(eindeutig[1]!))) melde('PROGRAMMWECHSEL', 'Eindeutigkeit auf bestehender Tabelle', a);

    const trigger = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+[\s\S]*?\bON\s+("?[\w.]+"?)/i.exec(a);
    if (trigger && bestehend(name(trigger[1]!))) melde('PROGRAMMWECHSEL', 'Trigger auf bestehender Tabelle (kann Schreibwege verbieten)', a);

    if (/^UPDATE\s/i.test(a) || /^INSERT\s+INTO[\s\S]*\bSELECT\b/i.test(a) || /^DELETE\s+FROM/i.test(a)) {
      melde('RUECKFUELLUNG', a.split(/\s+/)[0]!.toUpperCase(), a);
    }
  }

  const einstufung = fundstellen.reduce<Einstufung>(
    (strengste, f) => (RANG[f.einstufung] > RANG[strengste] ? f.einstufung : strengste),
    'RUECKWAERTSVERTRAEGLICH',
  );
  return { migration, einstufung, fundstellen };
}

// ---------------------------------------------------------------------------
//  Reihe und Durchsicht
// ---------------------------------------------------------------------------

export interface Durchsicht {
  einstufung: Einstufung;
  /** Pflicht, wenn die Heuristik strenger urteilt. */
  begruendung?: string;
}

export interface Register {
  stand: string;
  migrationen: Record<string, Durchsicht>;
}

const WURZEL = process.cwd();
const VERZEICHNIS = join(WURZEL, 'prisma', 'migrations');
const REGISTER = join(WURZEL, 'security', 'migrations-vertraeglichkeit.json');

/** Die ganze Reihe in Anwendungsreihenfolge einstufen. */
export function reiheEinstufen(verzeichnis = VERZEICHNIS): Befund[] {
  const vorhanden = new Set<string>();
  const funktionen = new Set<string>();
  const befunde: Befund[] = [];
  for (const migration of readdirSync(verzeichnis).sort()) {
    const datei = join(verzeichnis, migration, 'migration.sql');
    if (!existsSync(datei)) continue;
    const sql = readFileSync(datei, 'utf8');
    befunde.push(migrationEinstufen(migration, sql, vorhanden, funktionen));
    const rein = ohneKommentare(sql);
    for (const t of rein.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w.]+"?)/gi)) vorhanden.add(name(t[1]!));
    for (const f of rein.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+("?[\w.]+"?)/gi)) funktionen.add(name(f[1]!));
  }
  return befunde;
}

export interface Torergebnis {
  fehler: string[];
  hinweise: string[];
}

/** Heuristik gegen Durchsicht halten — die drei Regeln aus dem Kopf. */
export function torPruefen(befunde: Befund[], register: Register): Torergebnis {
  const fehler: string[] = [];
  const hinweise: string[] = [];
  const bekannt = new Set(befunde.map((b) => b.migration));

  for (const b of befunde) {
    const d = register.migrationen[b.migration];
    if (!d) {
      fehler.push(
        `${b.migration}: nicht durchgesehen (Heuristik: ${b.einstufung}). In security/migrations-vertraeglichkeit.json mit Einstufung aufnehmen.`,
      );
      continue;
    }
    if (!(d.einstufung in RANG)) {
      fehler.push(`${b.migration}: unbekannte Einstufung „${d.einstufung}".`);
      continue;
    }
    if (RANG[b.einstufung] > RANG[d.einstufung] && !d.begruendung?.trim()) {
      fehler.push(
        `${b.migration}: Heuristik sagt ${b.einstufung}, Durchsicht ${d.einstufung} — ohne Begründung. ` +
          `Fundstellen: ${b.fundstellen.map((f) => f.muster).join('; ')}`,
      );
    }
    if (d.einstufung === 'BRECHEND' || d.einstufung === 'PROGRAMMWECHSEL') {
      hinweise.push(`${b.migration}: ${d.einstufung} — nur mit unmittelbarem Umschalten bzw. Erweitern → Umschalten → Rückbau.`);
    }
  }
  for (const m of Object.keys(register.migrationen)) {
    if (!bekannt.has(m)) fehler.push(`${m}: Eintrag ohne Migration (entfernen oder Namen korrigieren).`);
  }
  return { fehler, hinweise };
}

export function registerLesen(datei = REGISTER): Register {
  return JSON.parse(readFileSync(datei, 'utf8')) as Register;
}

/**
 * Einstufung der **noch nicht angewandten** Migrationen — für die Aktivierung.
 * Die strengste davon entscheidet, ob Migration und Umschalten ohne
 * Wartungsfenster zusammen laufen dürfen.
 */
export function strengsteEinstufung(migrationen: string[], register: Register): Einstufung {
  return migrationen.reduce<Einstufung>((strengste, m) => {
    const d = register.migrationen[m];
    // Fehlt die Durchsicht, gilt das Schlimmste — nie das Beste.
    const e = d?.einstufung ?? 'BRECHEND';
    return RANG[e] > RANG[strengste] ? e : strengste;
  }, 'RUECKWAERTSVERTRAEGLICH');
}

function main(): void {
  const befunde = reiheEinstufen();
  if (process.argv.includes('--bericht')) {
    for (const b of befunde) {
      console.log(`${b.einstufung.padEnd(24)} ${b.migration}`);
      for (const f of b.fundstellen) console.log(`    ${f.einstufung.padEnd(22)} ${f.muster} — ${f.auszug}`);
    }
    return;
  }

  const ergebnis = torPruefen(befunde, registerLesen());
  const zaehlung = new Map<string, number>();
  const register = registerLesen();
  for (const b of befunde) {
    const e = register.migrationen[b.migration]?.einstufung ?? 'NICHT DURCHGESEHEN';
    zaehlung.set(e, (zaehlung.get(e) ?? 0) + 1);
  }
  console.log(`Migrationen: ${befunde.length}`);
  for (const [e, n] of zaehlung) console.log(`  ${e.padEnd(24)} ${n}`);
  if (process.argv.includes('--hinweise')) for (const h of ergebnis.hinweise) console.log(`  Hinweis: ${h}`);
  if (ergebnis.fehler.length > 0) {
    for (const f of ergebnis.fehler) console.error(`  FEHLER: ${f}`);
    console.error(`\n❌  Verträglichkeitstor: ${ergebnis.fehler.length} Fehler.`);
    process.exit(1);
  }
  console.log('\n✓  Verträglichkeitstor: jede Migration durchgesehen, keine unbegründete Abweichung.');
}

if (process.argv[1] && /migration-kompatibilitaet\.(ts|js)$/.test(process.argv[1])) main();
