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
 *
 * **`livePruefen(db)`** fragt die Kataloge der Datenbank, nie nur Namen:
 *
 *   • Teilindizes über `pg_index`: vorhanden, eindeutig, mit Bedingung
 *     (`indpred`), gültig **und** bereit (`indisvalid`, `indisready`).
 *   • Trigger über `pg_trigger`: vorhanden, kein interner, und eingeschaltet
 *     (`tgenabled` `O` oder `A`). `D` ist abgeschaltet; `R` feuert nur im
 *     Replikationsmodus — also im Betrieb nie.
 *   • Bedingungen über `pg_constraint`: richtige Art (`c` bzw. `x`) und
 *     validiert (`convalidated`); bei Ausschlussbedingungen zusätzlich ein
 *     gültiger Index dahinter.
 *   • Erweiterungen über `pg_extension`: vorhanden. `btree_gist` trägt die
 *     Ausschlussbedingungen; fehlt sie in einer wiederhergestellten
 *     Datenbank, fehlen die Bedingungen mit.
 *
 * Nicht gelistete Trigger, Bedingungen und eindeutige Teilindizes in der
 * Datenbank sind eine **Warnung**: Die Vertrauensprüfung
 * (`datenbank-vertrauenspruefung.ts`) bewertet fremde Objekte schärfer; hier
 * geht es darum, dass die gelisteten Regeln gelten.
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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Prisma } from '@prisma/client';

export const SCHRANKENARTEN = ['teilindizes', 'trigger', 'pruefbedingungen', 'ausschlussbedingungen', 'erweiterungen'] as const;
export type Schrankenart = (typeof SCHRANKENARTEN)[number];
export type Schrankenregister = Record<Schrankenart, string[]>;

export const BEZEICHNUNG: Record<Schrankenart, string> = {
  teilindizes: 'Teilindex',
  trigger: 'Trigger',
  pruefbedingungen: 'Prüfbedingung (CHECK)',
  ausschlussbedingungen: 'Ausschlussbedingung (EXCLUDE)',
  erweiterungen: 'Erweiterung',
};

export interface Schrankenbefund {
  schwere: 'blockierend' | 'warnung';
  art: Schrankenart;
  name: string;
  titel: string;
}

/** Der Pfad des Registers, wie er in Meldungen steht (relativ zur Wurzel, mit `/`). */
export const REGISTER_DATEI = 'security/datenbank-schranken.json';

/**
 * Das Register lesen und seine Form prüfen.
 *
 * Eine fehlende oder falsch geschriebene Liste ist ein Fehler, keine leere
 * Liste: `"trigger": null` oder ein Tippfehler im Schlüssel liesse sonst
 * jede Prüfung mit „nichts gelistet, nichts fehlt" bestehen.
 */
export function registerLesen(datei = join(process.cwd(), 'security', 'datenbank-schranken.json')): Schrankenregister {
  const roh = JSON.parse(readFileSync(datei, 'utf8')) as Record<string, unknown>;
  const register = {} as Schrankenregister;
  for (const art of SCHRANKENARTEN) {
    const liste = roh[art];
    if (!Array.isArray(liste) || liste.some((n) => typeof n !== 'string' || !/^[A-Za-z0-9_-]+$/.test(n))) {
      throw new Error(`${REGISTER_DATEI}: „${art}" muss eine Liste von Namen sein (Buchstaben, Ziffern, _ und -).`);
    }
    const doppelt = liste.filter((n, i) => liste.indexOf(n) !== i);
    if (doppelt.length > 0) throw new Error(`${REGISTER_DATEI}: „${art}" nennt doppelt: ${doppelt.join(', ')}.`);
    register[art] = [...(liste as string[])];
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
export function schrankenAusMigrationen(sql: string): Schrankenregister {
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
  return Object.fromEntries(SCHRANKENARTEN.map((art) => [art, [...stand[art]].sort()])) as Schrankenregister;
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
  const trigger = await db.$queryRaw<TriggerZeile[]>`
    SELECT t.tgname AS name, c.relname AS tabelle, t.tgisinternal AS intern, t.tgenabled::text AS zustand
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema}`;
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
  const blockierend = (art: Schrankenart, name: string, titel: string) => befunde.push({ schwere: 'blockierend', art, name, titel });
  const warnung = (art: Schrankenart, name: string, titel: string) => befunde.push({ schwere: 'warnung', art, name, titel });

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
      if (t.intern) blockierend('trigger', name, `Trigger ${name} auf ${t.tabelle} ist ein interner Trigger — nicht die handgeschriebene Schranke.`);
      else if (!AKTIV.has(t.zustand)) {
        blockierend(
          'trigger',
          name,
          t.zustand === 'D'
            ? `Trigger ${name} auf ${t.tabelle} ist abgeschaltet (DISABLE TRIGGER) — die Regel gilt nicht.`
            : `Trigger ${name} auf ${t.tabelle} feuert nur im Replikationsmodus (tgenabled=${t.zustand}) — im Betrieb also nie.`,
        );
      }
    }
  }
  const gelisteteTrigger = new Set(register.trigger);
  for (const t of trigger) {
    if (!t.intern && !gelisteteTrigger.has(t.name)) warnung('trigger', t.name, `Trigger ${t.name} auf ${t.tabelle} steht nicht im Register.`);
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

/** Eine Zeile je Art für die Ausgabe: „13 Teilindizes · 20 Trigger · …". */
export function registerZusammenfassung(register: Schrankenregister): string {
  const woerter: Record<Schrankenart, [string, string]> = {
    teilindizes: ['Teilindex', 'Teilindizes'],
    trigger: ['Trigger', 'Trigger'],
    pruefbedingungen: ['Prüfbedingung', 'Prüfbedingungen'],
    ausschlussbedingungen: ['Ausschlussbedingung', 'Ausschlussbedingungen'],
    erweiterungen: ['Erweiterung', 'Erweiterungen'],
  };
  return SCHRANKENARTEN.map((art) => `${register[art].length} ${woerter[art][register[art].length === 1 ? 0 : 1]}`).join(' · ');
}
