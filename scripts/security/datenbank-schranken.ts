/**
 * Datenbankschranken — das Register `security/datenbank-schranken.json`
 * gegen die Migrationen und gegen eine laufende Datenbank halten
 * (Produktion V2, Entwurf D8, 2026-09-30).
 *
 * ---------------------------------------------------------------------------
 *  Wogegen das gebaut ist
 * ---------------------------------------------------------------------------
 *
 * Die wichtigsten Geschäftsregeln dieses Schemas stehen nicht im
 * Prisma-Schema, sondern in handgeschriebenem SQL der Migrationen: Trigger,
 * die ausgestellte Belege, Signaturereignisse, Lagerbewegungen und das
 * Prüfprotokoll unveränderlich machen; Teilindizes für „höchstens ein
 * offener …"; Prüf- und Ausschlussbedingungen für Vorzeichen, Zeiträume und
 * überlappungsfreie Perioden. Prisma kennt nichts davon. Ein späteres
 * `migrate dev` bietet an, sie zu entfernen; ein `db push`, ein
 * Wiederherstellen nur der Daten oder ein `ALTER TABLE … DISABLE TRIGGER`
 * während einer Wartung lässt sie still verschwinden oder abgeschaltet
 * zurück. Die Anwendung läuft danach weiter, jede Prüfreihe über HTTP
 * besteht — nur die Regel, auf die sich alles verlässt, gilt nicht mehr.
 *
 * Bis hierher prüfte `security-check.ts` zwei Listen (Teilindizes, Trigger)
 * nur darauf, dass ihr **Name irgendwo** im Migrationstext vorkommt — auch
 * in einem Kommentar — und mit `--datenbank`, dass ein gleichnamiges Objekt
 * existiert. Ein abgeschalteter Trigger, ein ungültiger Index nach einem
 * abgebrochenen `CREATE INDEX CONCURRENTLY`, eine mit `NOT VALID`
 * nachgetragene Bedingung, die den Bestand nie geprüft hat: alles
 * „vorhanden". Und die 22 Prüf- und 3 Ausschlussbedingungen standen in gar
 * keiner Liste.
 *
 * ---------------------------------------------------------------------------
 *  Zwei Prüfungen, ein Register
 * ---------------------------------------------------------------------------
 *
 * **`statischPruefen(sql)`** liest die Migrationen in Anwendungsreihenfolge
 * und bildet den Endstand: Was angelegt und später wieder entfernt wurde
 * (`DROP INDEX`, `DROP CONSTRAINT`, `DROP TRIGGER`), zählt nicht mehr; was
 * danach neu angelegt wurde, wieder. Kommentare werden vorher entfernt — ein
 * erwähnter Name ist keine angelegte Schranke. Dann:
 *
 *   • gelistet, aber im Endstand nicht vorhanden → **blockierend**: Jemand
 *     hat eine Migration bearbeitet, oder das Register nennt eine Schranke,
 *     die es nie gab.
 *   • im Endstand, aber nicht gelistet → **Warnung**: Eine neue Schranke
 *     wartet auf ihren Eintrag. Nicht blockierend, weil sie ja existiert —
 *     aber ohne Eintrag prüft sie die Live-Prüfung nicht, und sie fehlte
 *     danach unbemerkt.
 *   • Bindung eines Triggers (Tabelle, Auslöser, Funktion) oder Prüfsumme
 *     eines Funktionsrumpfs anders als im Register → **blockierend**: Die
 *     Live-Prüfung misst gegen das Register, also muss es den Endstand der
 *     Migrationen genau wiedergeben (Begründung weiter unten).
 *
 * **`livePruefen(db)`** fragt die Kataloge der Datenbank, nie nur Namen:
 *
 *   • Teilindizes über `pg_index`: vorhanden, eindeutig, mit Bedingung
 *     (`indpred`), gültig **und** bereit (`indisvalid`, `indisready`).
 *   • Trigger über `pg_trigger`: vorhanden, kein interner, und eingeschaltet
 *     (`tgenabled` `O` oder `A`). `D` ist abgeschaltet; `R` feuert nur im
 *     Replikationsmodus — also im Betrieb nie. Dazu die **Bindung**: Tabelle,
 *     Auslöser (`tgtype`: Zeitpunkt, Ereignisse, Ebene), Funktion samt Schema,
 *     und weder `WHEN`-Bedingung noch Spaltenliste.
 *   • Funktionen über `pg_proc`: jede, die eine Migration anlegt, mit der
 *     Prüfsumme ihres Rumpfs und ohne eigene Einstellungen (`proconfig`).
 *   • Bedingungen über `pg_constraint`: richtige Art (`c` bzw. `x`) und
 *     validiert (`convalidated`); bei Ausschlussbedingungen zusätzlich ein
 *     gültiger Index dahinter.
 *   • Erweiterungen über `pg_extension`: vorhanden. `btree_gist` trägt die
 *     Ausschlussbedingungen; fehlt sie in einer wiederhergestellten
 *     Datenbank, fehlen die Bedingungen mit.
 *
 * Nicht gelistete Trigger, Funktionen, Bedingungen und eindeutige
 * Teilindizes in der Datenbank sind eine **Warnung**: Die Vertrauensprüfung
 * (`datenbank-vertrauenspruefung.ts`) bewertet fremde Objekte schärfer; hier
 * geht es darum, dass die gelisteten Regeln gelten.
 *
 * ---------------------------------------------------------------------------
 *  Warum Bindung und Funktionsrumpf (2026-10-01)
 * ---------------------------------------------------------------------------
 *
 * Bis hierher suchte die Live-Prüfung Trigger nur nach Namen und sah dann
 * auf `tgisinternal` und `tgenabled`. Der billigste Weg, den Schutz des
 * Prüfprotokolls auszuhebeln, liess das Tor grün: ein
 * `CREATE OR REPLACE FUNCTION audit_logs_nur_anfuegen() … RETURN COALESCE(NEW, OLD)`
 * — Trigger da, eingeschaltet, wirkungslos. Ebenso ein Trigger, der unter
 * demselben Namen als `BEFORE INSERT` neu angelegt, auf eine andere Tabelle
 * gehängt, mit `WHEN (false)` versehen oder auf eine gleichnamige Funktion in
 * einem anderen Schema umgebogen wird. Und weil mehrere Schutzfunktionen
 * Hilfsfunktionen rufen (`bereinigung_freigegeben()`,
 * `vertragsfassung_ist_gesperrt()`), genügt es nicht, nur die direkt
 * gebundene Funktion zu prüfen: Ein `SELECT true` in der Hilfsfunktion
 * öffnete alle Rechnungen, ohne einen Trigger anzufassen. Deshalb trägt das
 * Register **jede** Funktion, die eine Migration anlegt, mit SHA-256 ihres
 * Rumpfs.
 *
 * Die Prüfsumme entsteht auf beiden Seiten aus demselben Text: statisch aus
 * dem Rumpf zwischen den Dollar-Anführungszeichen der letzten Definition in
 * den Migrationen, live aus `pg_proc.prosrc` — beides ohne Wagenrücklauf,
 * damit ein Checkout mit CRLF nicht als Änderung zählt. SHA-256 statt MD5,
 * weil `md5()` auf einem Server im FIPS-Modus verweigert wird und das Tor
 * dort sonst „nicht geprüft" meldete. Ändert eine neue Migration eine
 * Schutzfunktion, meldet die statische Prüfung die neue Prüfsumme als
 * blockierend; nachgeführt wird sie erst nach der Durchsicht — genau die
 * Stelle, an der jemand hinsehen soll.
 *
 * Was weiterhin nur nach Name, Art und Gültigkeit geprüft wird: die
 * **Definition** von Prüf- und Ausschlussbedingungen und die Bedingung eines
 * Teilindex. Ein `DROP CONSTRAINT x; ADD CONSTRAINT x CHECK (true)` bliebe
 * hier unbemerkt. `pg_get_constraintdef()` und `pg_get_expr()` geben einen
 * vom Server normalisierten Ausdruck zurück, dessen Schreibweise zwischen
 * Postgres-Fassungen wechseln kann; eine Prüfsumme darüber schlüge beim
 * nächsten Serverwechsel ohne jede Änderung an. Das bleibt eine offene
 * Pendenz, keine stillschweigende Annahme.
 *
 * ---------------------------------------------------------------------------
 *  Abhängigkeiten
 * ---------------------------------------------------------------------------
 *
 * Ohne Pfad-Aliasse und ohne `src/lib/prisma-client.ts`: Jenes lädt beim
 * Import `.env`, und die Kommandozeile `scripts/datenbank-schranken.ts` muss
 * die Datenbank prüfen, die ihr Aufrufer in `DATABASE_URL` nennt — nicht
 * still die Entwicklungsdatenbank aus `.env`, wenn die Variable fehlt. Die
 * Live-Prüfung nimmt deshalb nur ein Objekt mit `$queryRaw` entgegen; ein
 * `PrismaClient` passt ebenso wie eine Transaktion, in der eine Prüfung einen
 * Trigger abschaltet und danach zurückrollt.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Prisma } from '@prisma/client';

import { statusMitPflichtteil, type Pruefstatus } from './pflichtabgleich';

export const SCHRANKENARTEN = ['teilindizes', 'trigger', 'pruefbedingungen', 'ausschlussbedingungen', 'erweiterungen'] as const;
export type Schrankenart = (typeof SCHRANKENARTEN)[number];

/**
 * Wie ein Trigger gebunden ist — was ihn zu **dieser** Schranke macht, statt
 * bloss zu einem Objekt mit ihrem Namen.
 */
export interface Triggerbindung {
  /** Die Tabelle, auf der er sitzt. */
  tabelle: string;
  /** Zeitpunkt, Ereignisse und Ebene in fester Schreibweise, etwa „BEFORE UPDATE OR DELETE FOR EACH ROW". */
  ausloeser: string;
  /** Die Triggerfunktion; ihr Rumpf steht unter `funktionen`. */
  funktion: string;
}

/**
 * Das Register: je Art eine Liste von Namen (`teilindizes` und `trigger`
 * lesen auch andere Werkzeuge als blosse Namen), dazu je Trigger seine
 * Bindung und je Funktion die SHA-256-Prüfsumme ihres Rumpfs.
 */
export type Schrankenregister = Record<Schrankenart, string[]> & {
  triggerbindungen: Record<string, Triggerbindung>;
  funktionen: Record<string, string>;
};

/** Die Arten, unter denen ein Befund erscheint — die fünf Listen und die Funktionen. */
export type Befundart = Schrankenart | 'funktionen';

export const BEZEICHNUNG: Record<Befundart, string> = {
  teilindizes: 'Teilindex',
  trigger: 'Trigger',
  pruefbedingungen: 'Prüfbedingung (CHECK)',
  ausschlussbedingungen: 'Ausschlussbedingung (EXCLUDE)',
  erweiterungen: 'Erweiterung',
  funktionen: 'Funktion',
};

export interface Schrankenbefund {
  schwere: 'blockierend' | 'warnung';
  art: Befundart;
  name: string;
  titel: string;
}

/** Der Pfad des Registers, wie er in Meldungen steht (relativ zur Wurzel, mit `/`). */
export const REGISTER_DATEI = 'security/datenbank-schranken.json';

/** Die feste Schreibweise eines Auslösers — dieselbe, die `ausloeserText` bildet. */
const AUSLOESER_MUSTER = /^(BEFORE|AFTER|INSTEAD OF) (INSERT|UPDATE|DELETE|TRUNCATE)( OR (INSERT|UPDATE|DELETE|TRUNCATE))* FOR EACH (ROW|STATEMENT)$/;

function istObjekt(wert: unknown): wert is Record<string, unknown> {
  return typeof wert === 'object' && wert !== null && !Array.isArray(wert);
}

/** Eigene Eigenschaft, nicht geerbte — ein Trigger namens `constructor` soll nicht „gelistet" sein. */
function hat(objekt: object, schluessel: string): boolean {
  return Object.prototype.hasOwnProperty.call(objekt, schluessel);
}

/**
 * Das Register lesen und seine Form prüfen.
 *
 * Eine fehlende oder falsch geschriebene Liste ist ein Fehler, keine leere
 * Liste: `"trigger": null` oder ein Tippfehler im Schlüssel liesse sonst
 * jede Prüfung mit „nichts gelistet, nichts fehlt" bestehen. Dasselbe gilt
 * für die Bindungen: Ein gelisteter Trigger ohne Bindung würde von der
 * Bindungsprüfung schlicht übergangen — also ist er ein Formfehler, ebenso
 * eine Bindung ohne Trigger und eine gebundene Funktion ohne Prüfsumme.
 */
export function registerLesen(datei = join(process.cwd(), 'security', 'datenbank-schranken.json')): Schrankenregister {
  const roh = JSON.parse(readFileSync(datei, 'utf8')) as Record<string, unknown>;
  const register = { triggerbindungen: {}, funktionen: {} } as unknown as Schrankenregister;
  for (const art of SCHRANKENARTEN) {
    const liste = roh[art];
    if (!Array.isArray(liste) || liste.some((n) => typeof n !== 'string' || !/^[A-Za-z0-9_-]+$/.test(n))) {
      throw new Error(`${REGISTER_DATEI}: „${art}" muss eine Liste von Namen sein (Buchstaben, Ziffern, _ und -).`);
    }
    const doppelt = liste.filter((n, i) => liste.indexOf(n) !== i);
    if (doppelt.length > 0) throw new Error(`${REGISTER_DATEI}: „${art}" nennt doppelt: ${doppelt.join(', ')}.`);
    register[art] = [...(liste as string[])];
  }

  const funktionen = roh.funktionen;
  if (!istObjekt(funktionen)) throw new Error(`${REGISTER_DATEI}: „funktionen" muss ein Objekt Name → SHA-256 des Rumpfs sein.`);
  for (const [name, pruefsumme] of Object.entries(funktionen)) {
    if (!/^\w+$/.test(name) || typeof pruefsumme !== 'string' || !/^[0-9a-f]{64}$/.test(pruefsumme)) {
      throw new Error(`${REGISTER_DATEI}: Funktion „${name}" braucht eine SHA-256-Prüfsumme (64 Hexadezimalzeichen, klein).`);
    }
    register.funktionen[name] = pruefsumme;
  }

  const bindungen = roh.triggerbindungen;
  if (!istObjekt(bindungen)) throw new Error(`${REGISTER_DATEI}: „triggerbindungen" muss ein Objekt Triggername → Bindung sein.`);
  const gelistet = new Set(register.trigger);
  for (const name of register.trigger) {
    if (!hat(bindungen, name)) throw new Error(`${REGISTER_DATEI}: Trigger „${name}" steht ohne Bindung in „triggerbindungen".`);
  }
  for (const [name, bindung] of Object.entries(bindungen)) {
    if (!gelistet.has(name)) throw new Error(`${REGISTER_DATEI}: Bindung „${name}" gehört zu keinem Trigger aus der Liste „trigger".`);
    if (
      !istObjekt(bindung) ||
      typeof bindung.tabelle !== 'string' ||
      !/^\w+$/.test(bindung.tabelle) ||
      typeof bindung.funktion !== 'string' ||
      !/^\w+$/.test(bindung.funktion) ||
      typeof bindung.ausloeser !== 'string' ||
      !AUSLOESER_MUSTER.test(bindung.ausloeser)
    ) {
      throw new Error(`${REGISTER_DATEI}: Bindung „${name}" braucht tabelle, funktion und ausloeser (etwa „BEFORE UPDATE OR DELETE FOR EACH ROW").`);
    }
    if (!hat(register.funktionen, bindung.funktion)) {
      throw new Error(`${REGISTER_DATEI}: Trigger „${name}" ruft „${bindung.funktion}", die unter „funktionen" fehlt — ihr Rumpf bliebe ungeprüft.`);
    }
    register.triggerbindungen[name] = { tabelle: bindung.tabelle, ausloeser: bindung.ausloeser, funktion: bindung.funktion };
  }
  return register;
}

/** Alle `migration.sql` in Anwendungsreihenfolge (Verzeichnisname = Zeitstempel). */
export function migrationenLesen(verzeichnis = join(process.cwd(), 'prisma', 'migrations')): string {
  let alles = '';
  for (const name of readdirSync(verzeichnis).sort()) {
    const datei = join(verzeichnis, name, 'migration.sql');
    // Der Zeilenumbruch dazwischen trennt die letzte Anweisung einer Datei
    // von der ersten der nächsten, auch wenn eine Datei ohne ihn endet.
    if (existsSync(datei)) alles += `\n${readFileSync(datei, 'utf8')}\n`;
  }
  return alles;
}

/** Kommentare entfernen — ein im Kommentar erwähnter Name ist keine angelegte Schranke. */
function ohneKommentare(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

interface Ereignis {
  stelle: number;
  art: Schrankenart | 'bedingung';
  name: string;
  anlegen: boolean;
}

/*
  Die Muster, mit denen der Endstand gebildet wird. Jedes steht für genau eine
  Anweisungsform, die in den Migrationen dieses Repositorys vorkommt; eine
  Form, die hier fehlt (etwa `ALTER INDEX … RENAME`), meldet sich über die
  statische Prüfung selbst: Der alte Name stünde als gelistet, aber nicht
  vorhanden da — blockierend, also nicht zu übersehen.

  Die eine Lücke in die andere Richtung: `DROP TABLE` nimmt Trigger, Indizes
  und Bedingungen der Tabelle mit, ohne sie zu nennen, und der Endstand hier
  führte sie weiter. Keine gelistete Schranke hängt heute an einer Tabelle,
  die später entfällt; fiele eine weg, meldete sie die Live-Prüfung als
  fehlend. Eine Tabellenzuordnung je Schranke, nur um diesen Fall statisch
  zu sehen, wöge mehr als sie nützte.

  `[^;]*?` vor `WHERE` hält die Suche in derselben Anweisung: Ein eindeutiger
  Index ohne Bedingung, gefolgt von einer späteren Anweisung mit `WHERE`,
  darf nicht als Teilindex gelten.
*/
const MUSTER: { re: RegExp; art: Ereignis['art']; anlegen: boolean }[] = [
  { re: /\bCREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?[^;]*?\bWHERE\b/gi, art: 'teilindizes', anlegen: true },
  { re: /\bDROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?"?(\w+)"?/gi, art: 'teilindizes', anlegen: false },
  { re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+"?(\w+)"?/gi, art: 'trigger', anlegen: true },
  { re: /\bDROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/gi, art: 'trigger', anlegen: false },
  { re: /\bCONSTRAINT\s+"?(\w+)"?\s+CHECK\b/gi, art: 'pruefbedingungen', anlegen: true },
  { re: /\bCONSTRAINT\s+"?(\w+)"?\s+EXCLUDE\b/gi, art: 'ausschlussbedingungen', anlegen: true },
  { re: /\bDROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/gi, art: 'bedingung', anlegen: false },
  { re: /\bCREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([\w-]+)"?/gi, art: 'erweiterungen', anlegen: true },
  { re: /\bDROP\s+EXTENSION\s+(?:IF\s+EXISTS\s+)?"?([\w-]+)"?/gi, art: 'erweiterungen', anlegen: false },
];

/**
 * Der Endstand der handgeschriebenen Schranken nach allen Migrationen —
 * sortiert, damit ein Vergleich mit dem Register nicht an der Reihenfolge
 * hängt.
 */
export function schrankenAusMigrationen(sql: string): Record<Schrankenart, string[]> {
  const rein = ohneKommentare(sql);
  const ereignisse: Ereignis[] = [];
  for (const { re, art, anlegen } of MUSTER) {
    for (const m of rein.matchAll(re)) ereignisse.push({ stelle: m.index ?? 0, art, name: m[1]!, anlegen });
  }
  ereignisse.sort((a, b) => a.stelle - b.stelle);

  const stand: Record<Schrankenart, Set<string>> = {
    teilindizes: new Set(),
    trigger: new Set(),
    pruefbedingungen: new Set(),
    ausschlussbedingungen: new Set(),
    erweiterungen: new Set(),
  };
  for (const e of ereignisse) {
    if (e.art === 'bedingung') {
      // `DROP CONSTRAINT` nennt die Art nicht — es entfernt, was so heisst.
      stand.pruefbedingungen.delete(e.name);
      stand.ausschlussbedingungen.delete(e.name);
    } else if (e.anlegen) {
      stand[e.art].add(e.name);
    } else {
      stand[e.art].delete(e.name);
    }
  }
  return Object.fromEntries(SCHRANKENARTEN.map((art) => [art, [...stand[art]].sort()])) as Record<Schrankenart, string[]>;
}

// ---------------------------------------------------------------------------
//  Bindung der Trigger und Rümpfe der Funktionen
// ---------------------------------------------------------------------------

const EREIGNISREIHE = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const;

/** Ein Auslöser in fester Schreibweise — Reihenfolge der Ereignisse wie `EREIGNISREIHE`, nicht wie geschrieben. */
function ausloeserText(zeitpunkt: string, ereignisse: Iterable<string>, ebene: 'ROW' | 'STATEMENT'): string {
  const menge = new Set(ereignisse);
  return `${zeitpunkt} ${EREIGNISREIHE.filter((e) => menge.has(e)).join(' OR ')} FOR EACH ${ebene}`;
}

/**
 * `pg_trigger.tgtype` in derselben Schreibweise wie das Register. Die Bits
 * stehen in `src/include/catalog/pg_trigger.h` von Postgres: 1 je Zeile,
 * 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE, 32 TRUNCATE, 64 INSTEAD OF —
 * seit Postgres 9 unverändert.
 */
export function ausloeserAusTyp(typ: number): string {
  const zeitpunkt = typ & 64 ? 'INSTEAD OF' : typ & 2 ? 'BEFORE' : 'AFTER';
  const bits: [number, string][] = [
    [4, 'INSERT'],
    [16, 'UPDATE'],
    [8, 'DELETE'],
    [32, 'TRUNCATE'],
  ];
  return ausloeserText(
    zeitpunkt,
    bits.filter(([bit]) => typ & bit).map(([, ereignis]) => ereignis),
    typ & 1 ? 'ROW' : 'STATEMENT',
  );
}

/** Ein Trigger, wie ihn die letzte `CREATE TRIGGER`-Anweisung der Migrationen anlegt. */
export interface Triggerdefinition extends Triggerbindung {
  /** Mit `WHEN (…)` oder `UPDATE OF spalte` — feuert nur noch teilweise; das Register bildet das nicht ab. */
  eingeschraenkt: boolean;
}

/*
  Jeder Trigger dieses Repositorys steht in genau dieser Form da:
  `CREATE TRIGGER name BEFORE … ON "tabelle" FOR EACH ROW EXECUTE FUNCTION f();`
  `[^;]` hält jede Gruppe in derselben Anweisung. Eine Form, die das Muster
  nicht liest (etwa ein `CONSTRAINT TRIGGER`), fehlt in der Abbildung und
  meldet sich als „nicht lesbar" — blockierend, nicht still übergangen.
*/
const TRIGGER_DEFINITION =
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+"?(\w+)"?\s+(BEFORE|AFTER|INSTEAD\s+OF)\s+([^;]+?)\s+ON\s+(?:"?\w+"?\.)?"?(\w+)"?([^;]*?)\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:"?\w+"?\.)?"?(\w+)"?\s*\(/gi;
const TRIGGER_ENTFERNEN = /\bDROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/gi;

/** Die Definition jedes Triggers im Endstand der Migrationen, nach Namen. */
export function triggerAusMigrationen(sql: string): Map<string, Triggerdefinition> {
  const rein = ohneKommentare(sql);
  const schritte: { stelle: number; name: string; definition: Triggerdefinition | null }[] = [];
  for (const m of rein.matchAll(TRIGGER_DEFINITION)) {
    const [, name, zeitpunkt, ereignistext, tabelle, rest, funktion] = m as unknown as string[];
    const ereignisse = ereignistext!.split(/\s+OR\s+/i).map((e) => e.trim().split(/\s+/)[0]!.toUpperCase());
    schritte.push({
      stelle: m.index ?? 0,
      name: name!,
      definition: {
        tabelle: tabelle!,
        ausloeser: ausloeserText(zeitpunkt!.toUpperCase().replace(/\s+/g, ' '), ereignisse, /\bFOR\s+EACH\s+ROW\b/i.test(rest!) ? 'ROW' : 'STATEMENT'),
        funktion: funktion!,
        eingeschraenkt: /\bWHEN\b/i.test(rest!) || /\bUPDATE\s+OF\b/i.test(ereignistext!),
      },
    });
  }
  for (const m of rein.matchAll(TRIGGER_ENTFERNEN)) schritte.push({ stelle: m.index ?? 0, name: m[1]!, definition: null });
  schritte.sort((a, b) => a.stelle - b.stelle);

  const stand = new Map<string, Triggerdefinition>();
  for (const s of schritte) {
    if (s.definition) stand.set(s.name, s.definition);
    else stand.delete(s.name);
  }
  return stand;
}

/**
 * Kommentare entfernen, Anführungen **wörtlich** lassen. `ohneKommentare`
 * genügt für Namen, aber nicht für Funktionsrümpfe: Es entfernte auch die
 * `--`-Zeilen **innerhalb** eines Rumpfs, und die gehören zu `prosrc` — die
 * Prüfsumme stimmte dann nie mit der Datenbank überein. Hier wird deshalb
 * gelesen wie Postgres liest: Was in `'…'`, `"…"` oder `$marke$…$marke$`
 * steht, bleibt unangetastet, und nur ausserhalb davon zählt `--` oder `/*`
 * als Kommentar.
 */
function ohneKommentareRuempfeWoertlich(sql: string): string {
  const teile: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const zeichen = sql[i]!;
    if (zeichen === '-' && sql[i + 1] === '-') {
      const ende = sql.indexOf('\n', i);
      i = ende === -1 ? sql.length : ende;
      continue;
    }
    if (zeichen === '/' && sql[i + 1] === '*') {
      const ende = sql.indexOf('*/', i + 2);
      i = ende === -1 ? sql.length : ende + 2;
      teile.push(' ');
      continue;
    }
    const marke =
      zeichen === "'" || zeichen === '"' ? zeichen : zeichen === '$' ? (/^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 66))?.[0] ?? null) : null;
    if (marke) {
      // Ein verdoppeltes `''` in einer Zeichenkette endet hier und beginnt
      // gleich wieder — kopiert wird beides wörtlich, das Ergebnis ist dasselbe.
      const ende = sql.indexOf(marke, i + marke.length);
      const bis = ende === -1 ? sql.length : ende + marke.length;
      teile.push(sql.slice(i, bis));
      i = bis;
      continue;
    }
    teile.push(zeichen);
    i++;
  }
  return teile.join('');
}

const FUNKTION_DEFINITION =
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?\w+"?\.)?"?(\w+)"?\s*\([^)]*\)[^$;]*?\bAS\s+(\$(?:[A-Za-z_]\w*)?\$)([\s\S]*?)\2/gi;
const FUNKTION_ENTFERNEN = /\bDROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:"?\w+"?\.)?"?(\w+)"?/gi;

/**
 * SHA-256 eines Funktionsrumpfs, ohne Wagenrücklauf — derselbe Wert, den
 * `livePruefen` aus `pg_proc.prosrc` bildet
 * (`encode(sha256(convert_to(replace(prosrc, chr(13), ''), 'UTF8')), 'hex')`).
 */
export function rumpfPruefsumme(rumpf: string): string {
  return createHash('sha256').update(rumpf.replace(/\r/g, ''), 'utf8').digest('hex');
}

/** Jede Funktion im Endstand der Migrationen mit der Prüfsumme ihrer letzten Definition. */
export function funktionenAusMigrationen(sql: string): Map<string, string> {
  const rein = ohneKommentareRuempfeWoertlich(sql);
  const schritte: { stelle: number; name: string; pruefsumme: string | null }[] = [];
  for (const m of rein.matchAll(FUNKTION_DEFINITION)) schritte.push({ stelle: m.index ?? 0, name: m[1]!, pruefsumme: rumpfPruefsumme(m[3]!) });
  for (const m of rein.matchAll(FUNKTION_ENTFERNEN)) schritte.push({ stelle: m.index ?? 0, name: m[1]!, pruefsumme: null });
  schritte.sort((a, b) => a.stelle - b.stelle);

  const stand = new Map<string, string>();
  for (const s of schritte) {
    if (s.pruefsumme) stand.set(s.name, s.pruefsumme);
    else stand.delete(s.name);
  }
  return stand;
}

/** Was an einer Bindung abweicht, in Worten — leer, wenn nichts. */
function bindungsabweichungen(soll: Triggerbindung, ist: Triggerbindung): string[] {
  const abweichungen: string[] = [];
  if (ist.tabelle !== soll.tabelle) abweichungen.push(`Tabelle ${ist.tabelle} statt ${soll.tabelle}`);
  if (ist.ausloeser !== soll.ausloeser) abweichungen.push(`Auslöser „${ist.ausloeser}" statt „${soll.ausloeser}"`);
  if (ist.funktion !== soll.funktion) abweichungen.push(`Funktion ${ist.funktion} statt ${soll.funktion}`);
  return abweichungen;
}

/** Register gegen den Endstand der Migrationen — die Regeln im Kopf dieser Datei. */
export function statischPruefen(sql: string, register: Schrankenregister = registerLesen()): Schrankenbefund[] {
  const endstand = schrankenAusMigrationen(sql);
  const befunde: Schrankenbefund[] = [];
  for (const art of SCHRANKENARTEN) {
    const vorhanden = new Set(endstand[art]);
    const gelistet = new Set(register[art]);
    for (const name of register[art]) {
      if (!vorhanden.has(name)) {
        befunde.push({
          schwere: 'blockierend',
          art,
          name,
          titel: `${BEZEICHNUNG[art]} „${name}" steht im Register, entsteht aber in keiner Migration (oder wird später wieder entfernt).`,
        });
      }
    }
    for (const name of endstand[art]) {
      if (!gelistet.has(name)) {
        befunde.push({
          schwere: 'warnung',
          art,
          name,
          titel: `${BEZEICHNUNG[art]} „${name}" entsteht in den Migrationen, steht aber nicht in ${REGISTER_DATEI}.`,
        });
      }
    }
  }

  // --- Trigger: Bindung wie im Register -------------------------------------
  // Nur für Trigger, die es im Endstand gibt — ein fehlender ist oben schon
  // blockierend gemeldet, und ein zweiter Befund zum selben Fehlen verwirrte.
  const vorhandeneTrigger = new Set(endstand.trigger);
  const definitionen = triggerAusMigrationen(sql);
  for (const name of register.trigger) {
    if (!vorhandeneTrigger.has(name)) continue;
    const soll = hat(register.triggerbindungen, name) ? register.triggerbindungen[name] : undefined;
    const ist = definitionen.get(name);
    if (!soll) {
      befunde.push({ schwere: 'blockierend', art: 'trigger', name, titel: `Trigger „${name}" steht ohne Bindung (Tabelle, Auslöser, Funktion) in ${REGISTER_DATEI}.` });
      continue;
    }
    if (!ist) {
      befunde.push({
        schwere: 'blockierend',
        art: 'trigger',
        name,
        titel: `Trigger „${name}": Seine Anweisung in den Migrationen ist nicht lesbar (erwartet CREATE TRIGGER … ON … EXECUTE FUNCTION …()) — die Bindung bleibt sonst ungeprüft.`,
      });
      continue;
    }
    const abweichungen = bindungsabweichungen(soll, ist);
    if (ist.eingeschraenkt) abweichungen.push('WHEN-Bedingung oder Spaltenliste (UPDATE OF), die das Register nicht abbildet');
    if (abweichungen.length > 0) {
      befunde.push({ schwere: 'blockierend', art: 'trigger', name, titel: `Trigger „${name}" in den Migrationen weicht vom Register ab: ${abweichungen.join('; ')}.` });
    }
  }

  // --- Funktionen: Rumpf wie im Register ------------------------------------
  const funktionen = funktionenAusMigrationen(sql);
  for (const [name, soll] of Object.entries(register.funktionen)) {
    const ist = funktionen.get(name);
    if (ist === undefined) {
      befunde.push({
        schwere: 'blockierend',
        art: 'funktionen',
        name,
        titel: `Funktion „${name}" steht im Register, entsteht aber in keiner Migration (oder wird später wieder entfernt).`,
      });
    } else if (ist !== soll) {
      befunde.push({
        schwere: 'blockierend',
        art: 'funktionen',
        name,
        titel:
          `Funktion „${name}": Ihr Rumpf in den Migrationen (sha256 ${ist}) weicht vom Register ab (${soll}). ` +
          `Eine Migration ändert eine Funktion, auf der eine Schranke ruht — die Änderung durchsehen und erst dann die Prüfsumme in ${REGISTER_DATEI} nachführen.`,
      });
    }
  }
  for (const name of funktionen.keys()) {
    if (!hat(register.funktionen, name)) {
      befunde.push({ schwere: 'warnung', art: 'funktionen', name, titel: `Funktion „${name}" entsteht in den Migrationen, steht aber nicht in ${REGISTER_DATEI}.` });
    }
  }
  return befunde;
}

// ---------------------------------------------------------------------------
//  Live-Prüfung
// ---------------------------------------------------------------------------

/** Alles, was die Live-Prüfung braucht: ein Client oder eine Transaktion. */
export type Katalogleser = Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * Das Schema aus der Verbindungsadresse — dasselbe, das
 * `src/lib/prisma-client.ts` dem Adapter gibt. `current_schema()` wäre die
 * bequemere Wahl, hängt aber am `search_path` der Rolle und nicht daran, wohin
 * die Anwendung tatsächlich schreibt.
 */
export function schemaAusAdresse(adresse: string | undefined): string {
  if (!adresse) return 'public';
  try {
    return new URL(adresse).searchParams.get('schema') || 'public';
  } catch {
    return 'public';
  }
}

interface IndexZeile {
  name: string;
  eindeutig: boolean;
  teilweise: boolean;
  gueltig: boolean;
  bereit: boolean;
}

interface TriggerZeile {
  name: string;
  tabelle: string;
  intern: boolean;
  zustand: string;
  typ: number;
  eingeschraenkt: boolean;
  funktion: string;
  funktionSchema: string;
}

interface FunktionZeile {
  name: string;
  signatur: string;
  pruefsumme: string | null;
  konfiguriert: boolean;
}

interface BedingungZeile {
  name: string;
  tabelle: string;
  art: string;
  validiert: boolean;
  indexGueltig: boolean | null;
}

/** Die Zustände von `pg_trigger.tgenabled`, in denen ein Trigger im Betrieb feuert. */
const AKTIV = new Set(['O', 'A']);

export async function livePruefen(db: Katalogleser, register: Schrankenregister, schema = 'public'): Promise<Schrankenbefund[]> {
  const indizes = await db.$queryRaw<IndexZeile[]>`
    SELECT ic.relname AS name, ix.indisunique AS eindeutig, (ix.indpred IS NOT NULL) AS teilweise,
           ix.indisvalid AS gueltig, ix.indisready AS bereit
    FROM pg_index ix
    JOIN pg_class ic ON ic.oid = ix.indexrelid
    JOIN pg_namespace n ON n.oid = ic.relnamespace
    WHERE n.nspname = ${schema}`;
  // `tgattr` ist ein int2vector; erst als Feld lässt sich zählen, ob der
  // Trigger auf eine Spaltenliste (`UPDATE OF …`) beschränkt ist.
  const trigger = await db.$queryRaw<TriggerZeile[]>`
    SELECT t.tgname AS name, c.relname AS tabelle, t.tgisinternal AS intern, t.tgenabled::text AS zustand,
           t.tgtype::int AS typ, (t.tgqual IS NOT NULL OR cardinality(t.tgattr::int2[]) > 0) AS eingeschraenkt,
           p.proname AS funktion, fn.nspname AS "funktionSchema"
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    JOIN pg_namespace fn ON fn.oid = p.pronamespace
    WHERE n.nspname = ${schema}`;
  // Funktionen von Erweiterungen (btree_gist legt Dutzende an) gehören nicht
  // zum Schema dieser Anwendung und blieben sonst als „nicht gelistet" stehen.
  const funktionen = await db.$queryRaw<FunktionZeile[]>`
    SELECT p.proname AS name, p.oid::regprocedure::text AS signatur,
           encode(sha256(convert_to(replace(p.prosrc, chr(13), ''), 'UTF8')), 'hex') AS pruefsumme,
           (p.proconfig IS NOT NULL) AS konfiguriert
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = ${schema}
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')`;
  const bedingungen = await db.$queryRaw<BedingungZeile[]>`
    SELECT con.conname AS name, c.relname AS tabelle, con.contype::text AS art, con.convalidated AS validiert,
           ix.indisvalid AS "indexGueltig"
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_index ix ON ix.indexrelid = con.conindid
    WHERE n.nspname = ${schema} AND con.contype IN ('c', 'x')`;
  const erweiterungen = new Set(
    (await db.$queryRaw<{ name: string }[]>`SELECT extname AS name FROM pg_extension`).map((e) => e.name),
  );

  const befunde: Schrankenbefund[] = [];
  const blockierend = (art: Befundart, name: string, titel: string) => befunde.push({ schwere: 'blockierend', art, name, titel });
  const warnung = (art: Befundart, name: string, titel: string) => befunde.push({ schwere: 'warnung', art, name, titel });

  // --- Teilindizes ----------------------------------------------------------
  const indexNach = new Map(indizes.map((i) => [i.name, i]));
  for (const name of register.teilindizes) {
    const i = indexNach.get(name);
    if (!i) blockierend('teilindizes', name, `Teilindex fehlt in der Datenbank: ${name}`);
    else if (!i.eindeutig || !i.teilweise) {
      blockierend('teilindizes', name, `Teilindex ${name} ist kein eindeutiger Index mit Bedingung mehr (eindeutig=${i.eindeutig}, Bedingung=${i.teilweise}).`);
    } else if (!i.gueltig || !i.bereit) {
      blockierend(
        'teilindizes',
        name,
        `Teilindex ${name} ist ungültig (indisvalid=${i.gueltig}, indisready=${i.bereit}) — etwa nach einem abgebrochenen CREATE INDEX CONCURRENTLY; neu aufbauen (REINDEX INDEX).`,
      );
    }
  }
  const gelisteteIndizes = new Set(register.teilindizes);
  for (const i of indizes) {
    if (i.eindeutig && i.teilweise && !gelisteteIndizes.has(i.name)) warnung('teilindizes', i.name, `Eindeutiger Teilindex ${i.name} steht nicht im Register.`);
  }

  // --- Trigger --------------------------------------------------------------
  for (const name of register.trigger) {
    const treffer = trigger.filter((t) => t.name === name);
    if (treffer.length === 0) {
      blockierend('trigger', name, `Trigger fehlt in der Datenbank: ${name}`);
      continue;
    }
    for (const t of treffer) {
      if (t.intern) {
        blockierend('trigger', name, `Trigger ${name} auf ${t.tabelle} ist ein interner Trigger — nicht die handgeschriebene Schranke.`);
        continue;
      }
      if (!AKTIV.has(t.zustand)) {
        blockierend(
          'trigger',
          name,
          t.zustand === 'D'
            ? `Trigger ${name} auf ${t.tabelle} ist abgeschaltet (DISABLE TRIGGER) — die Regel gilt nicht.`
            : `Trigger ${name} auf ${t.tabelle} feuert nur im Replikationsmodus (tgenabled=${t.zustand}) — im Betrieb also nie.`,
        );
      }
      // Die Bindung unabhängig vom Zustand: Ein abgeschalteter **und**
      // umgehängter Trigger hat zwei Befunde, und beide gehören behoben.
      const soll = hat(register.triggerbindungen, name) ? register.triggerbindungen[name] : undefined;
      if (!soll) {
        blockierend('trigger', name, `Trigger ${name} steht ohne Bindung (Tabelle, Auslöser, Funktion) im Register — seine Wirkung bleibt ungeprüft.`);
        continue;
      }
      const abweichungen = bindungsabweichungen(soll, { tabelle: t.tabelle, ausloeser: ausloeserAusTyp(t.typ), funktion: t.funktion });
      if (t.funktionSchema !== schema) abweichungen.push(`Funktion aus dem Schema ${t.funktionSchema} statt ${schema}`);
      if (t.eingeschraenkt) abweichungen.push('WHEN-Bedingung oder Spaltenliste (UPDATE OF), die ihn nur noch teilweise feuern lässt');
      if (abweichungen.length > 0) {
        blockierend('trigger', name, `Trigger ${name} ist umgebaut: ${abweichungen.join('; ')} — die Regel gilt nicht mehr so, wie die Migration sie anlegt.`);
      }
    }
  }
  const gelisteteTrigger = new Set(register.trigger);
  for (const t of trigger) {
    if (!t.intern && !gelisteteTrigger.has(t.name)) warnung('trigger', t.name, `Trigger ${t.name} auf ${t.tabelle} steht nicht im Register.`);
  }

  // --- Funktionen -----------------------------------------------------------
  // Gleichnamige Überladungen werden einzeln geprüft: Eine zusätzliche
  // Fassung mit anderem Rumpf ist ebenso unerwartet wie eine geänderte.
  for (const [name, soll] of Object.entries(register.funktionen)) {
    const zeilen = funktionen.filter((f) => f.name === name);
    if (zeilen.length === 0) blockierend('funktionen', name, `Funktion fehlt in der Datenbank: ${name}`);
    for (const f of zeilen) {
      if (f.pruefsumme !== soll) {
        blockierend(
          'funktionen',
          name,
          `Funktion ${f.signatur} ist geändert — ihr Rumpf weicht vom Register ab (etwa CREATE OR REPLACE FUNCTION nach der Migration); die Schranke, die auf ihr ruht, gilt nicht mehr so, wie die Migration sie anlegt.`,
        );
      }
      if (f.konfiguriert) {
        blockierend(
          'funktionen',
          name,
          `Funktion ${f.signatur} trägt eigene Einstellungen (ALTER FUNCTION … SET) — ein Schalter wie clenaris.audit_schwaerzung gälte darin bei jedem Aufruf.`,
        );
      }
    }
  }
  for (const f of funktionen) {
    if (!hat(register.funktionen, f.name)) warnung('funktionen', f.name, `Funktion ${f.signatur} steht nicht im Register.`);
  }

  // --- Prüf- und Ausschlussbedingungen --------------------------------------
  const bedingungNach = new Map(bedingungen.map((b) => [b.name, b]));
  const pruefen = (art: 'pruefbedingungen' | 'ausschlussbedingungen', typ: 'c' | 'x') => {
    for (const name of register[art]) {
      const b = bedingungNach.get(name);
      if (!b) blockierend(art, name, `${BEZEICHNUNG[art]} fehlt in der Datenbank: ${name}`);
      else if (b.art !== typ) blockierend(art, name, `${name} auf ${b.tabelle} ist keine ${BEZEICHNUNG[art]} (contype=${b.art}).`);
      else if (!b.validiert) {
        blockierend(art, name, `${BEZEICHNUNG[art]} ${name} auf ${b.tabelle} ist nicht validiert (NOT VALID) — der Bestand ist nie gegen sie geprüft worden.`);
      } else if (typ === 'x' && b.indexGueltig !== true) {
        blockierend(art, name, `${BEZEICHNUNG[art]} ${name} auf ${b.tabelle} hat keinen gültigen Index dahinter.`);
      }
    }
  };
  pruefen('pruefbedingungen', 'c');
  pruefen('ausschlussbedingungen', 'x');
  const gelisteteBedingungen = new Set([...register.pruefbedingungen, ...register.ausschlussbedingungen]);
  for (const b of bedingungen) {
    if (!gelisteteBedingungen.has(b.name)) {
      const art = b.art === 'x' ? 'ausschlussbedingungen' : 'pruefbedingungen';
      warnung(art, b.name, `${BEZEICHNUNG[art]} ${b.name} auf ${b.tabelle} steht nicht im Register.`);
    }
  }

  // --- Erweiterungen --------------------------------------------------------
  for (const name of register.erweiterungen) {
    if (!erweiterungen.has(name)) blockierend('erweiterungen', name, `Erweiterung fehlt in der Datenbank: ${name}`);
  }

  return befunde;
}

// ---------------------------------------------------------------------------
//  Erweiterungen in der Vertrauensprüfung
// ---------------------------------------------------------------------------

/**
 * Was jede Datenbank dieser Anwendung mitbringen darf, ohne dass eine
 * Schranke daran hängt: `plpgsql` hat jeder Server, die übrigen sind
 * verbreitete Standarderweiterungen, die ein Betreiber anlegen darf.
 */
export const GRUNDERWEITERUNGEN = ['plpgsql', 'pgcrypto', 'uuid-ossp', 'citext', 'pg_trgm'] as const;

/**
 * Die Erweiterungen, die weder zur Grundliste noch zum Register gehören —
 * in `datenbank-vertrauenspruefung.ts` AUFFÄLLIG, weil eine Erweiterung wie
 * `dblink` oder `postgres_fdw` Daten aus der Datenbank hinausträgt.
 *
 * Bis 2026-09-30 stand dort eine fest verdrahtete Liste ohne `btree_gist`,
 * obwohl zwei Migrationen sie für die Ausschlussbedingungen anlegen: Jede
 * ordnungsgemäss migrierte Kopie galt als auffällig. Ein Befund, der bei
 * jeder Prüfung anschlägt, lehrt, Befunde zu übergehen; und eine zweite,
 * von Hand gepflegte Liste liefe dem Register wieder davon. Deshalb die
 * Grundliste hier, ergänzt um das, was das Register als Träger einer
 * Schranke nennt.
 */
export function fremdeErweiterungen(namen: readonly string[], register: Pick<Schrankenregister, 'erweiterungen'>): string[] {
  const erlaubt = new Set<string>([...GRUNDERWEITERUNGEN, ...register.erweiterungen]);
  return namen.filter((name) => !erlaubt.has(name));
}

// ---------------------------------------------------------------------------
//  Datenbankabgleich in `security:check --datenbank`
// ---------------------------------------------------------------------------

/** Eine Verbindungsadresse in einer Meldung unkenntlich machen — sie trägt das Passwort. */
export function ohneZugangsdaten(text: string): string {
  return text.replace(/(\w+:\/\/)[^@\s/]+@/g, '$1***@');
}

export interface Datenbankabgleich {
  /** Lief die Live-Prüfung bis zum Ende? Nur dann gelten ihre Befunde als Aussage. */
  gelaufen: boolean;
  befunde: Schrankenbefund[];
  /** Ein Satz für den Hinweis der Prüfung, ohne Zugangsdaten. */
  hinweis: string;
}

/** Wie lange die Live-Prüfung dauern darf, bevor der Abgleich „nicht geprüft" meldet. */
const ABGLEICH_FRIST_MS = 15_000;

/**
 * Der Datenbankabgleich, den `security:check --datenbank` verlangt — ohne
 * eigenen Prisma-Client, damit dieses Modul `.env` nie lädt (siehe Kopf):
 * `verbinden` erzeugt ihn erst, wenn eine Adresse da ist.
 *
 * Jeder Weg, auf dem die Live-Prüfung nicht zu Ende läuft — keine Adresse,
 * keine Verbindung, ein Katalog, der sich nicht lesen lässt, keine Antwort
 * innerhalb der Frist —, endet mit `gelaufen: false`. Bis 2026-09-30 wurde
 * ein Verbindungsfehler in `security-check.ts` zu FEHLER der ganzen Prüfung
 * „Migrationen" und verschluckte deren übrige Befunde; eine fehlende Adresse
 * ist aber dieselbe Lage wie eine gescheiterte Verbindung: verlangt und
 * nicht gelaufen, also NICHT GEPRÜFT (`abgleichStatus`).
 */
export async function datenbankAbgleichen(
  adresse: string | undefined,
  register: Schrankenregister,
  verbinden: (adresse: string) => Promise<Katalogleser & { $disconnect(): Promise<void> }>,
): Promise<Datenbankabgleich> {
  if (!adresse) {
    return { gelaufen: false, befunde: [], hinweis: 'Datenbankabgleich: NICHT GEPRÜFT (keine DATABASE_URL) — `--datenbank` verlangt ihn.' };
  }
  let db: (Katalogleser & { $disconnect(): Promise<void> }) | undefined;
  let frist: ReturnType<typeof setTimeout> | undefined;
  try {
    db = await verbinden(adresse);
    // `pg` wartet ohne eigene Frist beliebig lange auf eine Verbindung — ein
    // Host, der Pakete verschluckt, hielte den ganzen Lauf an.
    const zeit = new Promise<never>((_, ablehnen) => {
      frist = setTimeout(() => ablehnen(new Error(`keine Antwort innerhalb von ${ABGLEICH_FRIST_MS / 1000} s`)), ABGLEICH_FRIST_MS);
    });
    const befunde = await Promise.race([livePruefen(db, register, schemaAusAdresse(adresse)), zeit]);
    return { gelaufen: true, befunde, hinweis: 'Datenbankabgleich durchgeführt.' };
  } catch (fehler) {
    const grund = ohneZugangsdaten((fehler instanceof Error ? fehler.message : String(fehler)).trim().split('\n').pop() ?? '');
    return { gelaufen: false, befunde: [], hinweis: `Datenbankabgleich: NICHT GEPRÜFT (${grund.slice(0, 200)}).` };
  } finally {
    clearTimeout(frist);
    await db?.$disconnect().catch(() => undefined);
  }
}

/**
 * Status der Prüfung „Migrationen" in `security:check`, wenn ein
 * Datenbankabgleich verlangt sein kann (2026-09-30).
 *
 * `statusMitPflichtteil` (`pflichtabgleich.ts`) stuft jede Prüfung mit einem
 * nicht-hinweisenden Befund als BEFUND ein — auch dann, wenn der verlangte
 * Abgleich gar nicht lief. Mit einer einzigen Warnung (etwa einer neuen,
 * noch nicht eingetragenen Schranke) endete `--datenbank` ohne Adresse
 * deshalb mit Exitcode 0: BEFUND mit Warnung blockiert nicht,
 * NICHT GEPRÜFT schon. Wer den Abgleich verlangt, bekommt ihn oder ein
 * Scheitern.
 *
 * Die Reihenfolge:
 *   1. Blockierendes geht vor (BEFUND) — der Lauf scheitert ohnehin, und
 *      der Befund bleibt obenauf, statt hinter „nicht geprüft" zu
 *      verschwinden.
 *   2. Verlangt und nicht gelaufen: NICHT GEPRÜFT, auch mit Warnungen.
 *   3. Sonst die Regel aus `pflichtabgleich.ts`.
 *
 * Eine reine Funktion, damit die Prüfreihe die Regel ohne Datenbank und
 * ohne den ganzen Lauf (der `npm audit` über das Netz ruft) festhalten kann.
 */
export function abgleichStatus(
  befunde: { schwere: 'blockierend' | 'warnung' | 'hinweis' }[],
  abgleich: { verlangt: boolean; gelaufen: boolean },
): Pruefstatus {
  if (abgleich.verlangt && !abgleich.gelaufen && !befunde.some((b) => b.schwere === 'blockierend')) return 'NICHT_GEPRUEFT';
  return statusMitPflichtteil(befunde, abgleich);
}

/** Eine Zeile je Art für die Ausgabe: „13 Teilindizes · 20 Trigger · … · 19 Funktionen". */
export function registerZusammenfassung(register: Schrankenregister): string {
  const woerter: Record<Befundart, [string, string]> = {
    teilindizes: ['Teilindex', 'Teilindizes'],
    trigger: ['Trigger', 'Trigger'],
    pruefbedingungen: ['Prüfbedingung', 'Prüfbedingungen'],
    ausschlussbedingungen: ['Ausschlussbedingung', 'Ausschlussbedingungen'],
    erweiterungen: ['Erweiterung', 'Erweiterungen'],
    funktionen: ['Funktion', 'Funktionen'],
  };
  const anzahl = (art: Befundart) => (art === 'funktionen' ? Object.keys(register.funktionen).length : register[art].length);
  return [...SCHRANKENARTEN, 'funktionen' as const].map((art) => `${anzahl(art)} ${woerter[art][anzahl(art) === 1 ? 0 : 1]}`).join(' · ');
}
