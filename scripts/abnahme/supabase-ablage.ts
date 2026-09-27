/**
 * Abnahme gegen einen echten Supabase-Bucket — ausführbar (F-09 c, 2026-09-27).
 *
 *   NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… [SUPABASE_STORAGE_BUCKET=…] \
 *     npx tsx scripts/abnahme/supabase-ablage.ts
 *
 * oder mit der Umgebungsdatei des Zielsystems:
 *
 *   npx tsx --env-file=.env scripts/abnahme/supabase-ablage.ts
 *
 * `tests/api/ablage-vertrag.test.ts` prüft den Treiber gegen einen **Nachbau**
 * der Storage-API. Das belegt, dass die Anwendung die Schnittstelle so
 * benutzt, wie sie beschrieben ist — nicht, dass der echte Bucket privat
 * eingestellt ist, dass der Dienstschlüssel dort trägt und dass Supabase ein
 * fehlendes Objekt so meldet, wie der Nachbau es tut. Dieses Skript holt das
 * nach (EXTERNER NACHWEIS E-8), und zwar über **genau** die Funktionen, die
 * die Anwendung benutzt (`supabase.ts`, `leseAblageGeprueft`), damit ein
 * grünes Ergebnis etwas über die Anwendung sagt und nicht über ein
 * Nebenwerkzeug:
 *
 *   1  Hochladen einer Prüfdatei (upsert: false) → Pfad, Grösse, SHA-256
 *   2  Authentifiziert zurücklesen → dieselben Bytes
 *   3  Leseweg der Auslieferung mit richtiger Prüfsumme → ok
 *   4  Leseweg mit falscher Prüfsumme → abweichung, keine Bytes (fail closed)
 *   5  Fehlendes Objekt → „fehlt", nicht „Fehler"
 *   6  Öffentliche Adresse ohne Anmeldung → liefert die Datei NICHT
 *   7  Objektweg ohne Schlüssel → liefert die Datei NICHT
 *   8  Zweiter Upload ohne upsert auf denselben Pfad → abgewiesen
 *   9  Aufräumen → Objekt weg
 *
 * Schritt 6 ist der eigentliche Grund für dieses Skript: Ein öffentlicher
 * Bucket machte jede Lohnabrechnung ohne Anmeldung abrufbar, und das lässt
 * sich nur am echten Dienst feststellen.
 *
 * **Geheimnisse.** Ausgegeben werden der Rechnername der Supabase-Adresse und
 * der Bucketname, nie der Dienstschlüssel. Jede Meldung, die das Skript
 * weitergibt, wird vorher um den Schlüssel bereinigt — auch wenn keine
 * bekannte Antwort ihn enthält: Eine Abnahmeausgabe landet in Tickets und
 * Chatverläufen.
 *
 * **Datenbank.** Keine. Der Leseweg für `driver = SUPABASE` berührt keine
 * Tabelle; fehlen `DATABASE_URL` oder `JWT_SECRET`, setzt das Skript
 * Platzhalter, damit `serverEnv()` den Bucketnamen liefern kann. Verbunden
 * wird damit nie. Die Prüfdatei liegt unter `abnahme/…` und wird in Schritt 9
 * entfernt.
 *
 * Exit 0 nur, wenn jeder Schritt bestanden hat; 1 bei einem gescheiterten
 * Schritt; 2 ohne Supabase-Umgebung. Ohne Gegenstelle bricht das Skript ab,
 * statt „bestanden" zu melden: Eine Abnahme ohne Bucket ist keine.
 */
import { createHash, randomBytes } from 'node:crypto';
import Module from 'node:module';
import { join } from 'node:path';

// `server-only` gibt es nur in Next — dieselbe Umleitung wie `scripts/abnahme/clamd.ts`, vor dem ersten Import.
const mitAufloeser = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
const urspruenglich = mitAufloeser._resolveFilename;
mitAufloeser._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'server-only') return join(__dirname, '..', 'server-only-stub.cjs');
  return urspruenglich.call(this, request, ...rest);
};

type Ergebnis = { schritt: string; ok: boolean; hinweis: string };

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function main(): Promise<void> {
  const adresse = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const schluessel = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!adresse || !schluessel) {
    const fehlt = [adresse ? null : 'NEXT_PUBLIC_SUPABASE_URL', schluessel ? null : 'SUPABASE_SERVICE_ROLE_KEY'].filter(Boolean);
    console.error(`❌  ${fehlt.join(' und ')} nicht gesetzt — ohne echten Bucket gibt es nichts abzunehmen.`);
    process.exit(2);
  }

  // Platzhalter nur, wenn nichts gesetzt ist — siehe Kopf („Datenbank").
  process.env.DATABASE_URL ??= 'postgresql://nicht-verwendet@127.0.0.1:1/abnahme_supabase';
  process.env.JWT_SECRET ??= 'abnahme-supabase-platzhalter-mindestens-32-zeichen';

  const bereinigt = (text: unknown): string => String(text).split(schluessel).join('***');

  const treiber = await import('../../src/lib/storage/supabase');
  const { leseAblageGeprueft } = await import('../../src/lib/storage/index');
  const { serverEnv } = await import('../../src/lib/env');
  const bucket = serverEnv().SUPABASE_STORAGE_BUCKET;

  let rechner: string;
  try {
    rechner = new URL(adresse).host;
  } catch {
    console.error('❌  NEXT_PUBLIC_SUPABASE_URL ist keine gültige Adresse.');
    process.exit(2);
  }
  console.log(`Supabase ${rechner} · Bucket „${bucket}"\n`);

  const pfad = `abnahme/${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(6).toString('hex')}.txt`;
  const inhalt = Buffer.from(`Clenaris-Abnahme der Ablage ${pfad}\n${randomBytes(32).toString('hex')}\n`);
  const soll = sha256(inhalt);
  const ergebnisse: Ergebnis[] = [];
  const schritt = async (name: string, lauf: () => Promise<{ ok: boolean; hinweis: string }>) => {
    try {
      const { ok, hinweis } = await lauf();
      ergebnisse.push({ schritt: name, ok, hinweis: bereinigt(hinweis) });
    } catch (fehler) {
      ergebnisse.push({ schritt: name, ok: false, hinweis: bereinigt(fehler instanceof Error ? fehler.message : fehler) });
    }
  };

  let hochgeladen = false;
  await schritt('1 Hochladen (upsert: false)', async () => {
    const r = await treiber.uploadBuffer({ path: pfad, content: inhalt, contentType: 'text/plain', upsert: false });
    hochgeladen = true;
    const ok = r.checksum === soll && r.sizeBytes === inhalt.byteLength && !('publicUrl' in r);
    return { ok, hinweis: `${r.sizeBytes} Bytes, SHA-256 ${r.checksum.slice(0, 16)}…` };
  });

  await schritt('2 Authentifiziert zurücklesen', async () => {
    const r = await treiber.holeObjekt(pfad);
    if (r.status !== 'ok') return { ok: false, hinweis: r.status === 'fehler' ? `Fehler: ${r.meldung}` : 'fehlt' };
    return { ok: r.bytes.equals(inhalt), hinweis: r.bytes.equals(inhalt) ? 'Bytes identisch' : `andere Bytes (SHA-256 ${sha256(r.bytes).slice(0, 16)}…)` };
  });

  await schritt('3 Leseweg, richtige Prüfsumme → ok', async () => {
    const r = await leseAblageGeprueft({ id: 'abnahme', path: pfad, driver: 'SUPABASE', checksum: soll }, soll);
    return { ok: r.status === 'ok' && r.pruefung === 'ok' && r.bytes.equals(inhalt), hinweis: r.status };
  });

  await schritt('4 Leseweg, falsche Prüfsumme → abweichung', async () => {
    const falsch = sha256(Buffer.from('nicht die abgelegte Datei'));
    const r = await leseAblageGeprueft({ id: 'abnahme', path: pfad, driver: 'SUPABASE', checksum: falsch }, falsch);
    return { ok: r.status === 'abweichung' && !('bytes' in r), hinweis: r.status };
  });

  await schritt('5 Fehlendes Objekt → fehlt', async () => {
    const r = await treiber.holeObjekt(`${pfad}.gibt-es-nicht`);
    return { ok: r.status === 'fehlt', hinweis: r.status === 'fehler' ? `Fehler statt „fehlt": ${r.meldung}` : r.status };
  });

  await schritt('6 Öffentliche Adresse liefert NICHT', async () => {
    const antwort = await fetch(treiber.getPublicUrl(pfad), { redirect: 'manual' });
    const rumpf = Buffer.from(await antwort.arrayBuffer());
    const geliefert = antwort.ok && rumpf.equals(inhalt);
    return {
      ok: !geliefert,
      hinweis: geliefert ? 'BUCKET IST ÖFFENTLICH — die Datei kam ohne Anmeldung' : `HTTP ${antwort.status}, keine Datei`,
    };
  });

  await schritt('7 Objektweg ohne Schlüssel liefert NICHT', async () => {
    const url = `${adresse.replace(/\/+$/, '')}/storage/v1/object/${bucket}/${pfad}`;
    const antwort = await fetch(url, { redirect: 'manual' });
    const rumpf = Buffer.from(await antwort.arrayBuffer());
    const geliefert = antwort.ok && rumpf.equals(inhalt);
    return { ok: !geliefert, hinweis: geliefert ? 'die Datei kam ohne Schlüssel' : `HTTP ${antwort.status}, keine Datei` };
  });

  await schritt('8 Zweiter Upload ohne upsert → abgewiesen', async () => {
    try {
      await treiber.uploadBuffer({ path: pfad, content: Buffer.from('überschrieben'), contentType: 'text/plain', upsert: false });
      return { ok: false, hinweis: 'angenommen — eine unveränderliche Fassung liesse sich überschreiben' };
    } catch (fehler) {
      const code = (fehler as { code?: string }).code;
      return { ok: code === 'INTEGRATION_ERROR', hinweis: `abgewiesen (${code ?? 'unbekannt'})` };
    }
  });

  await schritt('9 Aufräumen', async () => {
    if (!hochgeladen) return { ok: true, hinweis: 'nichts hochgeladen' };
    await treiber.deleteFile(pfad);
    const r = await treiber.holeObjekt(pfad);
    return { ok: r.status === 'fehlt', hinweis: r.status === 'fehlt' ? 'Prüfdatei entfernt' : `noch vorhanden (${r.status})` };
  });

  for (const e of ergebnisse) console.log(`${e.ok ? '✓' : '✗'} ${e.schritt.padEnd(44)} ${e.hinweis}`);
  const gescheitert = ergebnisse.filter((e) => !e.ok);
  console.log(
    gescheitert.length
      ? `\n❌  ${gescheitert.length} Schritt(e) nicht bestanden.`
      : '\n✓ Alle Schritte bestanden. Ergebnis mit Datum und prüfender Person in docs/MALWARE_PROTECTION.md (Abschnitt 7) festhalten.',
  );
  process.exit(gescheitert.length ? 1 : 0);
}

void main();
