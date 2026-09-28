/**
 * Release-Ausführer — die Gegenseite von `/api/cron/release-auftraege`
 * (2026-09-27).
 *
 *   npx tsx scripts/release-ausfuehrer.ts liste     --umgebung production
 *   npx tsx scripts/release-ausfuehrer.ts version   --umgebung production
 *   npx tsx scripts/release-ausfuehrer.ts abholen   --umgebung production --artefakte release/ \
 *                                                   --ci-nachweis https://github.com/…/actions/runs/123 \
 *                                                   --ausfuehrer github-actions/production --schluessel <lauf-id>
 *   npx tsx scripts/release-ausfuehrer.ts melden    --auftrag <id> --schluessel <lauf-id> \
 *                                                   --ergebnis SUCCEEDED --laufende-version 1.2.0
 *
 * Umgebung: `CLENARIS_URL` (Herkunft der Instanz), `RELEASE_EXECUTOR_TOKEN`,
 * `RELEASE_EXECUTOR_SIGNING_KEY`. Diese Werte gehören in die Geheimnisse
 * der GitHub-Umgebung, nie in die Anwendung einer anderen Umgebung.
 *
 * ---------------------------------------------------------------------------
 *  Was dieses Werkzeug tut, und was nicht
 * ---------------------------------------------------------------------------
 *
 * Es holt fällige Aufträge, **misst** das Artefakt, übernimmt den Auftrag mit
 * der gemessenen Prüfsumme und schreibt für den nächsten Schritt der Pipeline
 * auf, welches Archiv zu aktivieren ist (`GITHUB_OUTPUT`). Aktivieren selbst
 * tut `deploy/v2/release-aktivieren.sh` auf dem Server — dieser Schritt steht
 * in der Workflow-Vorlage, nicht hier, damit dieses Skript ohne Serverzugang
 * läuft und sich gegen den Testserver prüfen lässt
 * (`tests/api/release-center.test.ts`).
 *
 * Übernommen wird erst **nach** der Messung: Ein Auftrag, dessen Artefakt
 * fehlt oder nicht stimmt, bleibt terminiert und sichtbar, statt als „in
 * Ausführung" hängenzubleiben. Der Ausführungsschlüssel ist die Kennung des
 * Pipeline-Laufs — ein erneuter Versuch desselben Laufs ist damit dieselbe
 * Übernahme (idempotent), ein anderer Lauf ein anderer Ausführer (409).
 */
import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { SIGNATUR_KOPF, ZEIT_KOPF, signieren } from '../src/lib/release/ausfuehrer-signatur';

function argument(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function pflicht(name: string): string {
  const wert = argument(name);
  if (!wert) throw new Error(`--${name} fehlt.`);
  return wert;
}
function umgebungswert(name: string): string {
  const wert = process.env[name]?.trim();
  if (!wert) throw new Error(`${name} ist nicht gesetzt.`);
  return wert;
}

interface Auftrag {
  auftragId: string;
  zielVersion: string;
  vonVersion: string;
  commit: string | null;
  artefaktSha256: string | null;
  hindernis: string | null;
  ruecksprung: { verfuegbar: boolean; aufVersion: string; schemaBleibt: boolean };
}

async function anfrage<T>(methode: 'GET' | 'POST', pfad: string, rumpf?: unknown): Promise<{ status: number; daten: T | null; text: string }> {
  const basis = umgebungswert('CLENARIS_URL').replace(/\/$/, '');
  const text = rumpf === undefined ? '' : JSON.stringify(rumpf);
  const zeit = Math.floor(Date.now() / 1000);
  const antwort = await fetch(`${basis}${pfad}`, {
    method: methode,
    headers: {
      authorization: `Bearer ${umgebungswert('RELEASE_EXECUTOR_TOKEN')}`,
      [ZEIT_KOPF]: String(zeit),
      [SIGNATUR_KOPF]: signieren(umgebungswert('RELEASE_EXECUTOR_SIGNING_KEY'), { methode, pfad, zeit, rumpf: text }),
      ...(rumpf === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: rumpf === undefined ? undefined : text,
  });
  const inhalt = await antwort.text();
  let daten: T | null = null;
  try {
    daten = (JSON.parse(inhalt) as { data?: T }).data ?? null;
  } catch {
    /* kein JSON — der Text steht in der Fehlermeldung */
  }
  return { status: antwort.status, daten, text: inhalt };
}

function sha256Datei(pfad: string): Promise<string> {
  return new Promise((ok, fehler) => {
    const h = createHash('sha256');
    createReadStream(pfad)
      .on('data', (d) => h.update(d))
      .on('end', () => ok(h.digest('hex')))
      .on('error', fehler);
  });
}

function ausgabe(name: string, wert: string): void {
  console.log(`${name}=${wert}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${wert}\n`);
}

async function liste(umgebung: string): Promise<Auftrag[]> {
  const r = await anfrage<{ auftraege: Auftrag[] }>('GET', `/api/cron/release-auftraege?umgebung=${encodeURIComponent(umgebung)}`);
  if (r.status !== 200 || !r.daten) throw new Error(`Aufträge nicht lesbar: HTTP ${r.status} ${r.text.slice(0, 300)}`);
  return r.daten.auftraege;
}

/**
 * Das Artefakt zu einem Commit finden und messen.
 *
 * Verlangt werden Archiv, `.sha256` und Manifest (`scripts/release-artefakt.ts`).
 * Geprüft wird dreifach: Die gemessene Summe muss der `.sha256`-Datei, dem
 * Release und dem Manifest-Commit entsprechen. Stimmt eines nicht, wird der
 * Auftrag nicht übernommen.
 */
async function artefaktMessen(verzeichnis: string, auftrag: Auftrag): Promise<{ archiv: string; summe: string }> {
  if (!auftrag.commit || !auftrag.artefaktSha256) throw new Error(`Auftrag ${auftrag.auftragId}: Commit oder Prüfsumme fehlt.`);
  const name = `clenaris-${auftrag.commit.slice(0, 12)}`;
  const archiv = join(verzeichnis, `${name}.tar.gz`);
  for (const datei of [archiv, `${archiv}.sha256`, join(verzeichnis, `${name}.json`)]) {
    if (!existsSync(datei)) throw new Error(`Artefakt unvollständig: ${datei} fehlt (vorhanden: ${readdirSync(verzeichnis).join(', ') || 'nichts'}).`);
  }
  const summe = await sha256Datei(archiv);
  const notiert = readFileSync(`${archiv}.sha256`, 'utf8').trim().split(/\s+/)[0];
  const manifest = JSON.parse(readFileSync(join(verzeichnis, `${name}.json`), 'utf8')) as { commit?: string; auslieferbar?: boolean; archivSha256?: string };
  if (summe !== notiert) throw new Error(`${name}: gemessene Summe ≠ .sha256-Datei.`);
  if (summe !== auftrag.artefaktSha256) throw new Error(`${name}: gemessene Summe ≠ Prüfsumme des Release ${auftrag.zielVersion}.`);
  if (manifest.commit !== auftrag.commit) throw new Error(`${name}: Manifest nennt Commit ${manifest.commit}, das Release ${auftrag.commit}.`);
  if (manifest.archivSha256 && manifest.archivSha256 !== summe) throw new Error(`${name}: Manifest nennt eine andere Summe.`);
  if (manifest.auslieferbar !== true) throw new Error(`${name}: Manifest sagt auslieferbar=false (Probe).`);
  return { archiv, summe };
}

async function main(): Promise<void> {
  const befehl = process.argv[2];

  if (befehl === 'liste') {
    const auftraege = await liste(pflicht('umgebung'));
    console.log(JSON.stringify(auftraege, null, 2));
    return;
  }

  /*
    Die Produktversion, die die Instanz jetzt meldet — über dieselbe
    signierte Schnittstelle, nicht über `/api/health`: Jener ist
    unangemeldet erreichbar und nennt bewusst nur den Commit, nicht die
    Versionsnummer.
  */
  if (befehl === 'version') {
    const umgebung = pflicht('umgebung');
    const r = await anfrage<{ laufend: string }>('GET', `/api/cron/release-auftraege?umgebung=${encodeURIComponent(umgebung)}`);
    if (r.status !== 200 || !r.daten) throw new Error(`Version nicht lesbar: HTTP ${r.status}`);
    ausgabe('version', r.daten.laufend);
    return;
  }

  if (befehl === 'abholen') {
    const umgebung = pflicht('umgebung');
    const auftraege = (await liste(umgebung)).filter((a) => {
      if (a.hindernis) console.log(`Übersprungen ${a.zielVersion} (${a.auftragId}): ${a.hindernis}`);
      return !a.hindernis;
    });
    // Einer je Lauf, der älteste zuerst: zwei Versionen in einem Lauf hiessen
    // zwei Umschaltungen ohne Gesundheitsprüfung dazwischen.
    const auftrag = auftraege[0];
    if (!auftrag) {
      ausgabe('auftrag', '');
      console.log('Nichts fällig.');
      return;
    }
    const { archiv, summe } = await artefaktMessen(pflicht('artefakte'), auftrag);
    const r = await anfrage<{ wiederholt: boolean }>('POST', '/api/cron/release-auftraege/uebernehmen', {
      auftragId: auftrag.auftragId,
      umgebung,
      ausfuehrer: pflicht('ausfuehrer'),
      ausfuehrungsSchluessel: pflicht('schluessel'),
      artefaktSha256: summe,
      ciNachweis: pflicht('ci-nachweis'),
    });
    if (r.status !== 200) throw new Error(`Übernahme abgewiesen: HTTP ${r.status} ${r.text.slice(0, 500)}`);
    ausgabe('auftrag', auftrag.auftragId);
    ausgabe('archiv', archiv);
    ausgabe('commit', auftrag.commit!);
    ausgabe('zielversion', auftrag.zielVersion);
    ausgabe('ruecksprung_auf', auftrag.ruecksprung.aufVersion);
    ausgabe('wiederholt', String(r.daten?.wiederholt ?? false));
    return;
  }

  if (befehl === 'melden') {
    const ergebnis = pflicht('ergebnis');
    const r = await anfrage('POST', '/api/cron/release-auftraege/ergebnis', {
      auftragId: pflicht('auftrag'),
      ausfuehrungsSchluessel: pflicht('schluessel'),
      ergebnis,
      ...(argument('laufende-version') ? { laufendeVersion: argument('laufende-version') } : {}),
      ...(argument('meldung') ? { meldung: argument('meldung')!.slice(0, 2000) } : {}),
    });
    if (r.status !== 200) throw new Error(`Meldung abgewiesen: HTTP ${r.status} ${r.text.slice(0, 500)}`);
    console.log(`Gemeldet: ${ergebnis}`);
    return;
  }

  throw new Error('Befehl: liste | version | abholen | melden');
}

main().catch((fehler) => {
  console.error(`❌  ${fehler instanceof Error ? fehler.message : String(fehler)}`);
  process.exit(1);
});
