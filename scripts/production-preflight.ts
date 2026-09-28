/**
 * Produktionsvorprüfung — fail-closed, vor jedem Start einer Produktion.
 *
 *   npm run production:preflight                          vor dem Umschalten (keine offene Migration)
 *   npm run production:preflight -- --phase vor-migration offene Migrationen zulässig, aber eingestuft
 *   npm run production:preflight -- --nur-umgebung        nur die Umgebung, ohne Verbindungen (Prüfreihe)
 *
 * Ausgang 0 heisst: **jede** Prüfung lief und bestand. Eine Prüfung, die nicht
 * laufen konnte, ist kein Bestehen — `--nur-umgebung` endet deshalb mit 3,
 * auch wenn alles, was es prüfte, in Ordnung war. Ein Fehlschlag endet mit 1.
 *
 * ---------------------------------------------------------------------------
 *  Warum es das gibt
 * ---------------------------------------------------------------------------
 *
 * Der Notfallauftrag vom 2026-09-27 fand eine Produktion, in der man sich mit
 * den Demozugängen aus dem öffentlichen Repository als Verwaltung anmelden
 * konnte, ohne Schadsoftwareprüfung, mit abgeschalteter Sicherheitsmeldung und
 * einem Ursprung, der an Cloudflare vorbei erreichbar war. Nichts davon hätte
 * ein Start verhindert: Die Anwendung ist absichtlich nachsichtig — ein
 * fehlender Dienst schaltet eine Funktion ab, statt den Start zu verweigern
 * (CLAUDE.md, „Optional services"). Das ist für die Entwicklung richtig und für
 * eine Produktion gefährlich, weil jeder dieser Ausfälle lautlos ist.
 *
 * Diese Vorprüfung ist die Gegenstelle: Sie verlangt für die Produktion, was
 * die Anwendung nur empfiehlt, und sie verlangt es **vor** dem Umschalten
 * (`deploy/v2/release-aktivieren.sh` ruft sie auf).
 *
 * ---------------------------------------------------------------------------
 *  Was nie ausgegeben wird
 * ---------------------------------------------------------------------------
 *
 * Kein Wert einer Variablen, kein Passwort, keine Verbindungszeichenfolge —
 * auch nicht gekürzt oder maskiert. Meldungen nennen den **Namen** der
 * Variablen und was an ihr falsch ist. Fehler von Prisma, Redis und clamd
 * werden auf ihren Code reduziert, weil deren Meldungen Host und Benutzer
 * enthalten können. `tests/api/produktions-vorpruefung.test.ts` prüft das mit
 * Markerwerten, die in keiner Ausgabe auftauchen dürfen.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';

import { istOeffentlichesPasswort, istWegwerfDatenbank, OEFFENTLICHE_DEMO_ADRESSEN, OEFFENTLICHE_PASSWOERTER } from '../src/lib/auth/oeffentliche-zugangsdaten';

export type Stand = 'OK' | 'WARNUNG' | 'FEHLER' | 'NICHT_GEPRUEFT';

export interface Pruefung {
  id: string;
  stand: Stand;
  meldung: string;
}

type Umgebung = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
//  Bekannte Werte, die nie ein Produktionsgeheimnis sein dürfen
// ---------------------------------------------------------------------------

/**
 * Werte aus der CI, dem Testserver und der Prüfreihe. Sie stehen im
 * öffentlichen Repository; ein Geheimnis mit einem davon ist keines.
 * Die Prüfreihe (`tests/helpers/webhooks.ts`) erzeugt ihre Werte zur Laufzeit —
 * hier stehen dieselben Ausdrücke, damit dieses Skript nichts aus `tests/`
 * lädt.
 */
const BEKANNTE_TESTWERTE: readonly string[] = [
  'ci-nur-fuer-den-testlauf-mindestens-32-zeichen',
  'ci-cron-secret',
  'clenaris-pruefreihe-sicherheitsbericht-0123456789abcdef',
  `whsec_${Buffer.from('clenaris-pruefreihe-resend-webhook').toString('base64')}`,
  `whsec_${Buffer.from('clenaris-pruefreihe-stripe-webhook').toString('hex')}`,
  `ausf_${Buffer.from('clenaris-pruefreihe-release-token').toString('hex')}`,
  `sig_${Buffer.from('clenaris-pruefreihe-release-signatur').toString('hex')}`,
];

/** Die Werte aus `.env.example` — Platzhalter, Beispiele, veröffentlichte Passwörter. */
export function beispielwerte(datei = join(process.cwd(), '.env.example')): Map<string, string> {
  const werte = new Map<string, string>();
  if (!existsSync(datei)) return werte;
  for (const zeile of readFileSync(datei, 'utf8').split(/\r?\n/)) {
    const t = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*("([^"]*)"|'([^']*)'|([^#\s]*))/.exec(zeile);
    if (!t) continue;
    const wert = t[3] ?? t[4] ?? t[5] ?? '';
    if (wert !== '') werte.set(t[1]!, wert);
  }
  return werte;
}

/** Geheimnisse, die gesetzt, lang genug und keine bekannten Werte sein müssen. */
const PFLICHTGEHEIMNISSE: readonly { name: string; min: number; format?: RegExp; formatText?: string }[] = [
  { name: 'JWT_SECRET', min: 32 },
  { name: 'CRON_SECRET', min: 32 },
  { name: 'ENCRYPTION_KEY', min: 64, format: /^[0-9a-fA-F]{64}$/, formatText: '64 Hex-Zeichen' },
];

/** Geheimnisse, die fehlen dürfen (Funktion aus) — aber wenn, dann richtig. */
const WAHLGEHEIMNISSE: readonly { name: string; min: number }[] = [
  { name: 'SECURITY_REPORT_TOKEN', min: 32 },
  { name: 'RELEASE_EXECUTOR_TOKEN', min: 32 },
  { name: 'RELEASE_EXECUTOR_SIGNING_KEY', min: 32 },
  { name: 'STRIPE_SECRET_KEY', min: 20 },
  { name: 'STRIPE_WEBHOOK_SECRET', min: 20 },
  { name: 'RESEND_API_KEY', min: 10 },
  { name: 'RESEND_WEBHOOK_SECRET', min: 20 },
  { name: 'TWILIO_AUTH_TOKEN', min: 16 },
  { name: 'SUPABASE_SERVICE_ROLE_KEY', min: 20 },
  { name: 'ANTHROPIC_API_KEY', min: 20 },
  { name: 'GOOGLE_MAPS_SERVER_KEY', min: 20 },
];

function istBekannterWert(name: string, wert: string, beispiele: Map<string, string>): boolean {
  if (BEKANNTE_TESTWERTE.includes(wert)) return true;
  if (istOeffentlichesPasswort(wert)) return true;
  const beispiel = beispiele.get(name);
  if (beispiel && beispiel === wert) return true;
  // Platzhalter aus `.env.example` in abgewandelter Form („CHANGE_ME…", „sk_test_...").
  return /CHANGE_ME|PROJECTREF|xxxxxxxx|\.\.\.$/i.test(wert);
}

/** Adressen, die in einer Produktion nie die eigene Herkunft sein können. */
function unbrauchbareHerkunft(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'ist keine gültige Adresse';
  }
  if (u.protocol !== 'https:') return 'verlangt https';
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '[::1]' || /^127\./.test(host)) {
    return 'zeigt auf den eigenen Rechner';
  }
  if (/\.(local|test|invalid|example|internal)$/.test(host) || /(^|\.)example\.(com|org|net|ch)$/.test(host)) {
    return 'zeigt auf eine Test- oder Beispieldomain';
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return 'ist eine nackte IP-Adresse (Ursprung an Cloudflare vorbei)';
  if (u.pathname !== '/' || u.search || u.username || u.password) return 'enthält Pfad, Parameter oder Zugangsdaten';
  return null;
}

// ---------------------------------------------------------------------------
//  Umgebung — rein, ohne Verbindungen
// ---------------------------------------------------------------------------

export function umgebungPruefen(env: Umgebung, beispiele: Map<string, string> = beispielwerte()): Pruefung[] {
  const p: Pruefung[] = [];
  const ok = (id: string, meldung: string) => p.push({ id, stand: 'OK', meldung });
  const fehler = (id: string, meldung: string) => p.push({ id, stand: 'FEHLER', meldung });
  const warnung = (id: string, meldung: string) => p.push({ id, stand: 'WARNUNG', meldung });
  const gesetzt = (name: string) => (env[name] ?? '').trim() !== '';

  // --- Laufzeit ------------------------------------------------------------
  if (env.NODE_ENV === 'production') ok('node-env', 'NODE_ENV=production');
  else fehler('node-env', 'NODE_ENV ist nicht „production".');

  const umgebung = env.CLENARIS_UMGEBUNG?.trim();
  if (umgebung === 'production' || umgebung === 'staging') ok('umgebung', `CLENARIS_UMGEBUNG=${umgebung}`);
  else if (!umgebung) fehler('umgebung', 'CLENARIS_UMGEBUNG fehlt — eine Produktion sagt ausdrücklich, dass sie eine ist.');
  else fehler('umgebung', `CLENARIS_UMGEBUNG=${umgebung} ist keine Produktionsumgebung (Test- und Vorschauwerte öffnen Demozugänge).`);

  // --- Adressen ------------------------------------------------------------
  const appUrl = (env.APP_URL ?? env.NEXT_PUBLIC_APP_URL ?? '').trim();
  if (!appUrl) fehler('app-url', 'APP_URL fehlt.');
  else {
    const grund = unbrauchbareHerkunft(appUrl);
    if (grund) fehler('app-url', `APP_URL ${grund}.`);
    else ok('app-url', 'APP_URL ist eine öffentliche https-Herkunft.');
  }
  const seite = (env.NEXT_PUBLIC_SITE_URL ?? '').trim();
  if (seite) {
    const grund = unbrauchbareHerkunft(seite);
    if (grund) fehler('kanonische-url', `NEXT_PUBLIC_SITE_URL ${grund}.`);
    else ok('kanonische-url', 'NEXT_PUBLIC_SITE_URL ist eine öffentliche https-Herkunft.');
  } else {
    warnung('kanonische-url', 'NEXT_PUBLIC_SITE_URL nicht in der Umgebung — sie ist beim Bau festgelegt; RELEASE.json (seitenUrl) prüfen.');
  }
  for (const name of ['SECURITY_REPORT_URL', 'ALERT_WEBHOOK_URL'] as const) {
    if (!gesetzt(name)) continue;
    // Pfad und Parameter sind bei einem Meldeziel normal; alles andere nicht.
    const grund = unbrauchbareHerkunft(env[name]!.trim());
    if (grund && grund !== 'enthält Pfad, Parameter oder Zugangsdaten') {
      fehler(`adresse-${name.toLowerCase()}`, `${name} ${grund}.`);
    }
  }

  // --- Geheimnisse ---------------------------------------------------------
  for (const g of PFLICHTGEHEIMNISSE) {
    const wert = env[g.name]?.trim() ?? '';
    if (!wert) fehler(`geheimnis-${g.name.toLowerCase()}`, `${g.name} fehlt.`);
    else if (g.format && !g.format.test(wert)) fehler(`geheimnis-${g.name.toLowerCase()}`, `${g.name} hat nicht das Format ${g.formatText}.`);
    else if (wert.length < g.min) fehler(`geheimnis-${g.name.toLowerCase()}`, `${g.name} ist kürzer als ${g.min} Zeichen.`);
    else if (istBekannterWert(g.name, wert, beispiele)) fehler(`geheimnis-${g.name.toLowerCase()}`, `${g.name} ist ein öffentlich bekannter Wert (Beispiel, CI oder Prüfreihe).`);
    else ok(`geheimnis-${g.name.toLowerCase()}`, `${g.name} gesetzt, Länge und Herkunft in Ordnung.`);
  }
  if (gesetzt('ENCRYPTION_KEY') && gesetzt('JWT_SECRET') && env.ENCRYPTION_KEY!.trim() === env.JWT_SECRET!.trim()) {
    fehler('geheimnis-getrennt', 'ENCRYPTION_KEY und JWT_SECRET sind gleich — ein Schlüssel je Zweck.');
  }
  for (const g of WAHLGEHEIMNISSE) {
    const wert = env[g.name]?.trim() ?? '';
    if (!wert) continue;
    if (wert.length < g.min) fehler(`geheimnis-${g.name.toLowerCase()}`, `${g.name} ist kürzer als ${g.min} Zeichen.`);
    else if (istBekannterWert(g.name, wert, beispiele)) fehler(`geheimnis-${g.name.toLowerCase()}`, `${g.name} ist ein öffentlich bekannter Wert (Beispiel, CI oder Prüfreihe).`);
  }
  for (const name of ['DATABASE_URL', 'DIRECT_URL'] as const) {
    const wert = env[name]?.trim() ?? '';
    if (!wert) fehler(`datenbank-${name.toLowerCase()}`, `${name} fehlt.`);
    else if (istBekannterWert(name, wert, beispiele) || /:\/\/[^:@/]+:(clenaris|postgres|password|PASSWORD)@/i.test(wert)) {
      fehler(`datenbank-${name.toLowerCase()}`, `${name} trägt ein bekanntes oder Standardpasswort.`);
    } else if (istWegwerfDatenbank(wert)) {
      fehler(`datenbank-${name.toLowerCase()}`, `${name} zeigt auf eine Test-, Vorschau- oder Demodatenbank.`);
    } else ok(`datenbank-${name.toLowerCase()}`, `${name} gesetzt, keine Wegwerf-Datenbank.`);
  }

  // --- Demo- und Übergangsschalter -----------------------------------------
  const schalter: [string, (v: string) => boolean, string][] = [
    ['ALLOW_DEMO_SEED', (v) => v !== '', 'öffnet den Demo-Seed'],
    ['CLENARIS_TEST_CACHE_DIR', (v) => v !== '', 'kennzeichnet eine Prüfumgebung (Testscanner, Dateizähler)'],
    ['CLENARIS_LEGACY_FILES', (v) => v.toLowerCase() === 'allow', 'liefert ungeprüfte Altdateien aus'],
    ['LEGACY_PUBLIC_TOKENS', (v) => v !== '', 'lässt Alt-Links im Klartext zu'],
  ];
  for (const [name, aktiv, grund] of schalter) {
    const wert = env[name]?.trim() ?? '';
    if (aktiv(wert)) fehler(`schalter-${name.toLowerCase()}`, `${name} ist gesetzt und ${grund}.`);
  }
  if (!schalter.some(([name, aktiv]) => aktiv(env[name]?.trim() ?? ''))) ok('schalter', 'Keine Demo- oder Übergangsschalter gesetzt.');

  for (const name of ['SEED_ADMIN_PASSWORD', 'SEED_SUPERADMIN_PASSWORD'] as const) {
    const wert = env[name] ?? '';
    if (wert && istOeffentlichesPasswort(wert)) fehler(`startpasswort-${name.toLowerCase()}`, `${name} ist ein öffentlich bekanntes Passwort.`);
    else if (wert) warnung(`startpasswort-${name.toLowerCase()}`, `${name} steht noch in der Umgebung — nach der Ersteinrichtung entfernen.`);
  }

  // --- Proxy ---------------------------------------------------------------
  /**
   * Die Reihenfolge aus dem Notfallauftrag, Phase 4.1: `CLOUDFLARE` glaubt
   * `CF-Connecting-IP`. Das ist nur richtig, wenn **ausschliesslich**
   * Cloudflare den Ursprung erreicht — sonst setzt jeder, der die IP kennt,
   * die Kopfzeile selbst und wählt seine Adresse für Rate-Limit, Prüf- und
   * Signaturprotokoll. Die Anwendung kann das nicht sehen; also muss die
   * Person, die es an der Hetzner-Firewall eingerichtet und von aussen
   * geprüft hat, es ausdrücklich bestätigen.
   */
  const proxy = env.TRUSTED_PROXY_MODE?.trim().toUpperCase() ?? '';
  if (!proxy) fehler('proxy', 'TRUSTED_PROXY_MODE fehlt — in der Produktion ausdrücklich setzen.');
  else if (!['NONE', 'SINGLE_REVERSE_PROXY', 'CLOUDFLARE'].includes(proxy)) fehler('proxy', `TRUSTED_PROXY_MODE=${proxy} ist unbekannt.`);
  else if (proxy === 'CLOUDFLARE' && env.CLENARIS_URSPRUNG_NUR_CLOUDFLARE?.trim() !== 'bestaetigt') {
    fehler('proxy', 'TRUSTED_PROXY_MODE=CLOUDFLARE ohne CLENARIS_URSPRUNG_NUR_CLOUDFLARE=bestaetigt — erst Firewall auf Cloudflare-Bereiche beschränken und den direkten Zugriff von aussen als geschlossen prüfen.');
  } else if (proxy === 'NONE') warnung('proxy', 'TRUSTED_PROXY_MODE=NONE — hinter Nginx fehlt die Client-Adresse; Rate-Limits teilen sich einen Schlüssel.');
  else ok('proxy', `TRUSTED_PROXY_MODE=${proxy}`);

  // --- Dateien -------------------------------------------------------------
  if (!gesetzt('CLAMAV_HOST')) fehler('scanner', 'CLAMAV_HOST fehlt — ohne Scanner endet jeder Upload in ERROR und wird nie ausgeliefert. Production V2 verlangt clamd.');
  else ok('scanner', 'CLAMAV_HOST gesetzt (Erreichbarkeit: siehe Verbindungsprüfung).');

  // --- Maschinenzugänge ----------------------------------------------------
  if (!gesetzt('SECURITY_REPORT_TOKEN')) warnung('sicherheitsmeldung', 'SECURITY_REPORT_TOKEN fehlt — der Berichtseingang bleibt geschlossen (fail-closed).');
  const ausfuehrer = [gesetzt('RELEASE_EXECUTOR_TOKEN'), gesetzt('RELEASE_EXECUTOR_SIGNING_KEY')];
  if (ausfuehrer[0] !== ausfuehrer[1]) fehler('ausfuehrer', 'RELEASE_EXECUTOR_TOKEN und RELEASE_EXECUTOR_SIGNING_KEY nur gemeinsam setzen.');
  else if (ausfuehrer[0] && gesetzt('RELEASE_EXECUTOR_TOKEN') && env.RELEASE_EXECUTOR_TOKEN === env.RELEASE_EXECUTOR_SIGNING_KEY) fehler('ausfuehrer', 'Token und Signaturschlüssel des Ausführers sind gleich.');
  else if (!ausfuehrer[0]) ok('ausfuehrer', 'Release-Ausführer abgeschaltet (keine Zugangsdaten).');
  else ok('ausfuehrer', 'Release-Ausführer eingerichtet.');

  if (!gesetzt('REDIS_URL')) warnung('redis', 'REDIS_URL fehlt — Rate-Limits zählen je Prozess.');

  // --- Stand ---------------------------------------------------------------
  const version = env.APP_VERSION?.trim() ?? '';
  const manifest = releaseManifest();
  if (manifest && manifest.commit && /^[0-9a-f]{40}$/.test(manifest.commit)) {
    if (manifest.auslieferbar !== true) fehler('release', 'RELEASE.json sagt auslieferbar=false.');
    else if (version && version !== manifest.commit) fehler('release', 'APP_VERSION weicht vom Commit in RELEASE.json ab.');
    else ok('release', `Release ${manifest.commit.slice(0, 12)} (RELEASE.json, auslieferbar).`);
  } else if (/^[0-9a-f]{40}$/.test(version)) {
    warnung('release', 'Kein RELEASE.json — Stand nur über APP_VERSION belegt, nicht über ein geprüftes Artefakt.');
  } else {
    fehler('release', 'Weder RELEASE.json noch eine Commit-Kennung in APP_VERSION — der Stand ist nicht belegt.');
  }

  return p;
}

function releaseManifest(): { commit?: string; auslieferbar?: boolean } | null {
  const datei = join(process.cwd(), 'RELEASE.json');
  if (!existsSync(datei)) return null;
  try {
    return JSON.parse(readFileSync(datei, 'utf8')) as { commit?: string; auslieferbar?: boolean };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
//  Verbindungen
// ---------------------------------------------------------------------------

/** Nur Code und Klasse eines Fehlers — Meldungen tragen Host und Benutzer. */
function fehlercode(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as { code?: unknown; errorCode?: unknown; name?: unknown };
    const code = e.errorCode ?? e.code;
    if (typeof code === 'string' && /^[A-Z0-9_]{2,20}$/i.test(code)) return code;
    if (typeof e.name === 'string') return e.name;
  }
  return 'unbekannt';
}

function clamdPing(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    let antwort = '';
    const ende = (ergebnis: boolean) => {
      sock.destroy();
      resolve(ergebnis);
    };
    sock.setTimeout(5_000, () => ende(false));
    sock.on('error', () => ende(false));
    sock.on('connect', () => sock.write('zPING\0'));
    sock.on('data', (d) => {
      antwort += d.toString('utf8');
      if (antwort.includes('PONG')) ende(true);
    });
    sock.on('end', () => ende(antwort.includes('PONG')));
  });
}

export async function verbindungenPruefen(env: Umgebung, phase: 'start' | 'vor-migration', wartungsfenster: boolean): Promise<Pruefung[]> {
  const p: Pruefung[] = [];
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    // --- Datenbank -----------------------------------------------------------
    let verbunden = false;
    try {
      const [zeile] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
      verbunden = true;
      if (zeile && istWegwerfDatenbank(`postgresql://x/${zeile.db}`)) {
        p.push({ id: 'db-verbindung', stand: 'FEHLER', meldung: 'Verbunden — aber mit einer Test-, Vorschau- oder Demodatenbank.' });
      } else {
        p.push({ id: 'db-verbindung', stand: 'OK', meldung: 'Datenbank erreichbar.' });
      }
    } catch (error) {
      p.push({ id: 'db-verbindung', stand: 'FEHLER', meldung: `Datenbank nicht erreichbar (${fehlercode(error)}).` });
    }

    // --- Migrationen -------------------------------------------------------
    if (verbunden) {
      const verzeichnis = join(process.cwd(), 'prisma', 'migrations');
      const alle = readdirSync(verzeichnis).filter((n) => existsSync(join(verzeichnis, n, 'migration.sql'))).sort();
      let angewandt = new Set<string>();
      try {
        const zeilen = await prisma.$queryRaw<{ migration_name: string }[]>`
          SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
        angewandt = new Set(zeilen.map((z) => z.migration_name));
      } catch (error) {
        p.push({ id: 'migrationen', stand: 'FEHLER', meldung: `Migrationsstand nicht lesbar (${fehlercode(error)}).` });
      }
      const offen = alle.filter((m) => !angewandt.has(m));
      const fremd = [...angewandt].filter((m) => !alle.includes(m));
      if (fremd.length > 0) {
        p.push({ id: 'migrationen', stand: 'FEHLER', meldung: `${fremd.length} angewandte Migration(en), die dieses Release nicht kennt — Datenbank ist neuer als der Code.` });
      } else if (offen.length === 0) {
        p.push({ id: 'migrationen', stand: 'OK', meldung: `Alle ${alle.length} Migrationen angewandt.` });
      } else if (phase === 'start') {
        p.push({ id: 'migrationen', stand: 'FEHLER', meldung: `${offen.length} Migration(en) offen — vor dem Start migrieren (--phase vor-migration).` });
      } else {
        const { registerLesen, strengsteEinstufung } = await import('./migration-kompatibilitaet');
        const strengste = strengsteEinstufung(offen, registerLesen());
        if (strengste === 'BRECHEND' && !wartungsfenster) {
          p.push({ id: 'migrationen', stand: 'FEHLER', meldung: `${offen.length} offen, darunter BRECHEND — nur mit Wartungsfenster (--wartungsfenster) oder Erweitern → Umschalten → Rückbau.` });
        } else {
          p.push({ id: 'migrationen', stand: strengste === 'RUECKWAERTSVERTRAEGLICH' ? 'OK' : 'WARNUNG', meldung: `${offen.length} offen, strengste Einstufung ${strengste} — Migration und Umschalten unmittelbar nacheinander.` });
        }
      }
    }

    // --- Konten ------------------------------------------------------------
    /**
     * Die eigentliche Antwort auf „kann sich jemand mit den Demozugängen
     * anmelden?": Jedes aktive Konto wird gegen jedes veröffentlichte
     * Passwort geprüft — mit demselben Argon2, mit dem die Anmeldung prüft.
     * Das kostet je Konto einige hundert Millisekunden und ist genau so
     * gemeint: Eine Liste von E-Mail-Adressen sagte nur, ob Demokonten
     * *existieren*, nicht ob sie *offen* sind — und eine echte Person, die
     * ihr Passwort auf „Demo#2026Clenaris" gesetzt hat, stünde auf keiner.
     */
    if (verbunden) {
      try {
        const { verify } = await import('@node-rs/argon2');
        const konten = await prisma.user.findMany({
          where: { deletedAt: null, status: 'ACTIVE' },
          select: { id: true, email: true, role: true, passwordHash: true },
        });
        let offen = 0;
        const offeneVerwaltung: string[] = [];
        for (const konto of konten) {
          if (!konto.passwordHash) continue;
          for (const pw of OEFFENTLICHE_PASSWOERTER) {
            let treffer = false;
            try {
              treffer = await verify(konto.passwordHash, pw);
            } catch {
              treffer = false;
            }
            if (treffer) {
              offen++;
              if (konto.role === 'SUPER_ADMIN' || konto.role === 'ADMIN' || konto.role === 'MANAGER') offeneVerwaltung.push(konto.id);
              break;
            }
          }
        }
        if (offen > 0) {
          p.push({
            id: 'konten-oeffentliche-passwoerter',
            stand: 'FEHLER',
            meldung: `${offen} aktive(s) Konto/Konten mit öffentlich bekanntem Passwort, davon ${offeneVerwaltung.length} mit Verwaltungsrolle (Konto-IDs: ${offeneVerwaltung.join(', ') || '—'}). Passwort zurücksetzen oder Konto stilllegen, dann Sitzungen widerrufen (scripts/sitzungen-widerrufen.ts).`,
          });
        } else {
          p.push({ id: 'konten-oeffentliche-passwoerter', stand: 'OK', meldung: `${konten.length} aktive Konten geprüft — keines trägt ein öffentlich bekanntes Passwort.` });
        }

        const demo = konten.filter((k) => OEFFENTLICHE_DEMO_ADRESSEN.includes(k.email.toLowerCase()));
        if (demo.length > 0) {
          p.push({ id: 'konten-demo-adressen', stand: 'WARNUNG', meldung: `${demo.length} aktive(s) Konto/Konten unter einer öffentlichen Demoadresse — bewusst behalten oder stilllegen.` });
        }

        const systemverantwortung = konten.filter((k) => k.role === 'SUPER_ADMIN');
        if (systemverantwortung.length === 0) {
          p.push({ id: 'ersteinrichtung', stand: 'FEHLER', meldung: 'Kein aktives Konto der Systemverantwortung — Ersteinrichtung nicht abgeschlossen (scripts/create-admin.ts).' });
        } else if (systemverantwortung.every((k) => offeneVerwaltung.includes(k.id))) {
          p.push({ id: 'ersteinrichtung', stand: 'FEHLER', meldung: 'Jedes Konto der Systemverantwortung trägt ein öffentlich bekanntes Passwort.' });
        } else {
          p.push({ id: 'ersteinrichtung', stand: 'OK', meldung: `${systemverantwortung.length} Konto/Konten der Systemverantwortung mit eigenem Passwort.` });
        }
      } catch (error) {
        p.push({ id: 'konten-oeffentliche-passwoerter', stand: 'FEHLER', meldung: `Konten nicht prüfbar (${fehlercode(error)}).` });
      }
    }
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }

  // --- Redis -----------------------------------------------------------------
  if ((env.REDIS_URL ?? '').trim()) {
    try {
      const { default: Redis } = await import('ioredis');
      const r = new Redis(env.REDIS_URL!, { lazyConnect: true, connectTimeout: 5_000, maxRetriesPerRequest: 0, enableOfflineQueue: false });
      r.on('error', () => undefined);
      try {
        await r.connect();
        const pong = await r.ping();
        p.push({ id: 'redis-verbindung', stand: pong === 'PONG' ? 'OK' : 'FEHLER', meldung: pong === 'PONG' ? 'Redis erreichbar.' : 'Redis antwortet nicht mit PONG.' });
      } finally {
        r.disconnect();
      }
    } catch (error) {
      p.push({ id: 'redis-verbindung', stand: 'FEHLER', meldung: `Redis nicht erreichbar (${fehlercode(error)}).` });
    }
  }

  // --- clamd -----------------------------------------------------------------
  if ((env.CLAMAV_HOST ?? '').trim()) {
    const port = Number(env.CLAMAV_PORT ?? '3310');
    const lebt = await clamdPing(env.CLAMAV_HOST!.trim(), Number.isFinite(port) ? port : 3310);
    p.push({ id: 'scanner-verbindung', stand: lebt ? 'OK' : 'FEHLER', meldung: lebt ? 'clamd antwortet auf PING. Volle Abnahme: scripts/abnahme/clamd.ts.' : 'clamd antwortet nicht auf PING.' });
  }

  return p;
}

// ---------------------------------------------------------------------------
//  Ausgabe
// ---------------------------------------------------------------------------

export function auswerten(pruefungen: Pruefung[], nurUmgebung: boolean): { code: number; text: string } {
  const zeichen: Record<Stand, string> = { OK: '✓', WARNUNG: '!', FEHLER: '✗', NICHT_GEPRUEFT: '?' };
  const zeilen = pruefungen.map((x) => `  ${zeichen[x.stand]} ${x.stand.padEnd(14)} ${x.id.padEnd(36)} ${x.meldung}`);
  const fehler = pruefungen.filter((x) => x.stand === 'FEHLER').length;
  const warnungen = pruefungen.filter((x) => x.stand === 'WARNUNG').length;
  let urteil: string;
  let code: number;
  if (fehler > 0) {
    urteil = `FEHLGESCHLAGEN — ${fehler} Fehler, ${warnungen} Warnungen. Nicht starten.`;
    code = 1;
  } else if (nurUmgebung) {
    urteil = `UMGEBUNG IN ORDNUNG, VERBINDUNGEN NICHT GEPRÜFT — kein Bestehen (${warnungen} Warnungen).`;
    code = 3;
  } else {
    urteil = `BESTANDEN — ${warnungen} Warnungen.`;
    code = 0;
  }
  return { code, text: ['Produktionsvorprüfung', '', ...zeilen, '', urteil].join('\n') };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const nurUmgebung = args.includes('--nur-umgebung');
  const phaseArg = args[args.indexOf('--phase') + 1];
  const phase = args.includes('--phase') && phaseArg === 'vor-migration' ? 'vor-migration' : 'start';
  const wartungsfenster = args.includes('--wartungsfenster');

  // Dieselben Dateien wie `next start` (`.env`, `.env.production`, …) — die
  // Vorprüfung soll sehen, was die Anwendung sehen wird, nicht was die Shell
  // zufällig exportiert hat. `--ohne-dotenv` für die Prüfreihe.
  if (!args.includes('--ohne-dotenv')) {
    const { loadEnvConfig } = await import('@next/env');
    loadEnvConfig(process.cwd(), false, { info: () => undefined, error: () => undefined });
  }

  const env = process.env as Umgebung;
  const pruefungen = umgebungPruefen(env);
  if (!nurUmgebung) pruefungen.push(...(await verbindungenPruefen(env, phase, wartungsfenster)));
  const { code, text } = auswerten(pruefungen, nurUmgebung);
  (code === 0 ? console.log : console.error)(text);
  process.exit(code);
}

if (process.argv[1] && /production-preflight\.(ts|js)$/.test(process.argv[1])) {
  main().catch((error) => {
    console.error(`Produktionsvorprüfung abgebrochen (${fehlercode(error)}). Nicht starten.`);
    process.exit(1);
  });
}
