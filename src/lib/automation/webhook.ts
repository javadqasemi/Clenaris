import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

/**
 * Ausgehende Aufrufe — und warum eine Adresse nicht einfach eine Adresse ist.
 *
 * ---------------------------------------------------------------------------
 *  Das Problem
 * ---------------------------------------------------------------------------
 *
 * Ein Webhook ist ein Aufruf, den **der Server** ausführt. Er läuft aus dem
 * Netz des Servers heraus — und in dieses Netz hinein. Das ist die
 * serverseitige Anfragefälschung (SSRF): Wer die Adresse bestimmen darf,
 * erreicht alles, was der Server erreicht, einschliesslich dessen, was von
 * aussen nicht erreichbar ist:
 *
 *  • `http://127.0.0.1:5432` — die Datenbank,
 *  • `http://169.254.169.254/latest/meta-data/` — der Metadatendienst der
 *    Cloud, der Zugangsdaten herausgibt,
 *  • `http://10.0.0.5/admin` — der Verwaltungszugang des Nachbardienstes.
 *
 * Und das alles darf jede Person mit `automation:update`.
 *
 * ---------------------------------------------------------------------------
 *  Warum eine Prüfung der Zeichenkette nicht genügt
 * ---------------------------------------------------------------------------
 *
 * Die naheliegende Prüfung — „steht da `localhost` oder `127.`?" — ist
 * wirkungslos. Ein Name im **öffentlichen** DNS darf auf `127.0.0.1` zeigen,
 * und es gibt Dienste, die genau das anbieten. Die Zeichenkette sagt nichts
 * darüber, wo der Aufruf landet.
 *
 * Geprüft wird deshalb die **aufgelöste Adresse**, und zwar alle, die die
 * Auflösung liefert. Erst danach wird aufgerufen.
 *
 * ---------------------------------------------------------------------------
 *  Die Umbenennung zwischen Prüfung und Aufruf — geschlossen (2026-09-27)
 * ---------------------------------------------------------------------------
 *
 * Bis hierher prüfte `pruefeZiel` die Auflösung, und `fetch` löste danach
 * **selbst noch einmal** auf. Wer den DNS-Eintrag dazwischen änderte (DNS
 * Rebinding: erst öffentlich, beim zweiten Mal `127.0.0.1`), umging die
 * Prüfung. Hier stand, das lasse sich nicht schliessen, ohne dass der Name
 * im TLS-Handschlag verloren gehe.
 *
 * Das stimmte nicht. `https.request` nimmt eine eigene `lookup`-Funktion:
 * Die Verbindung fragt **diese** Funktion nach der Adresse, und sie prüft
 * jede Antwort, bevor der Socket sie anwählt. Der Name bleibt Name — er
 * steht in SNI und Zertifikatsprüfung wie bisher —, nur die Adresse, die
 * tatsächlich angewählt wird, ist genau eine geprüfte. Es gibt keine zweite,
 * ungeprüfte Auflösung mehr. `pruefeZiel` bleibt als frühe, verständliche
 * Antwort für die Maske; die Grenze ist die Verbindung.
 *
 * `AUTOMATION_WEBHOOK_HOSTS` bleibt die engere Einstellung für einen Betrieb
 * mit festen Gegenstellen.
 */

/** Zeitlimit für einen Aufruf. Länger wäre eine Einladung, den Lauf zu binden. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/** So viel Antwort wird gelesen — der Rest verworfen. */
export const WEBHOOK_MAX_ANTWORT_BYTES = 16 * 1024;

export type WebhookFehler =
  | 'SCHEMA'
  | 'NICHT_ERLAUBT'
  | 'PRIVATE_ADRESSE'
  | 'UNAUFLOESBAR'
  | 'TIMEOUT'
  | 'NETZWERK'
  | 'STATUS';

export interface WebhookErgebnis {
  ok: boolean;
  status?: number;
  fehler?: WebhookFehler;
  /** Kurze, maschinenlesbare Begründung. Nie der Antwortrumpf der Gegenstelle. */
  grund?: string;
  dauerMs: number;
}

/**
 * Liegt diese Adresse in einem Bereich, den der Server nicht von aussen
 * erreichen können soll?
 *
 * Die Liste ist bewusst grosszügig: Im Zweifel abweisen. Ein zu Unrecht
 * abgewiesener Webhook ist eine Nachfrage, ein zu Unrecht erlaubter ist ein
 * Vorfall.
 */
export function istPrivateAdresse(adresse: string): boolean {
  const art = isIP(adresse);
  if (art === 4) return istPrivateIpv4(adresse.split('.').map(Number) as [number, number, number, number]);
  if (art === 6) {
    const bytes = ipv6Bytes(adresse);
    return bytes === null ? true : istPrivateIpv6(bytes);
  }
  // Keine erkennbare Adresse — abweisen.
  return true;
}

function istPrivateIpv4([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0) return true; // „dieses Netz"
  if (a === 10) return true; // privat
  if (a === 127) return true; // Rückschleife
  if (a === 169 && b === 254) return true; // Link-local *und* Cloud-Metadaten
  if (a === 172 && b >= 16 && b <= 31) return true; // privat
  if (a === 192 && b === 168) return true; // privat
  if (a === 100 && b >= 64 && b <= 127) return true; // Carrier-NAT
  if (a === 192 && b === 0) return true; // IETF-Protokollzuweisungen, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // Benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // Multicast, reserviert, Broadcast
  return false;
}

/**
 * IPv6 vollständig als 16 Bytes — jede Schreibweise (`::`, eingebettetes
 * IPv4, führende Nullen). Die frühere Prüfung arbeitete mit Präfixen der
 * Zeichenkette und liess damit `::ffff:7f00:1` (= `127.0.0.1`), `fe81::`
 * (link-local, aber nicht `fe80`) und NAT64 `64:ff9b::a9fe:a9fe`
 * (= `169.254.169.254`) durch (2026-09-27).
 */
function ipv6Bytes(adresse: string): number[] | null {
  let text = adresse.toLowerCase().split('%')[0]!;
  // Eingebettetes IPv4 am Ende in zwei Hextets umschreiben.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const o = v4[1]!.split('.').map(Number);
    if (o.some((x) => !(x >= 0 && x <= 255))) return null;
    text = text.slice(0, -v4[1]!.length) + `${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const [links, rechts] = text.includes('::') ? text.split('::') : [text, null];
  const teileL = links ? links.split(':').filter((t) => t !== '') : [];
  const teileR = rechts !== null && rechts !== undefined ? rechts.split(':').filter((t) => t !== '') : [];
  const fehlend = 8 - teileL.length - teileR.length;
  if (rechts === null ? teileL.length !== 8 : fehlend < 0) return null;
  const hextets = [...teileL, ...Array(rechts === null ? 0 : fehlend).fill('0'), ...teileR].map((h) => parseInt(h, 16));
  if (hextets.length !== 8 || hextets.some((h) => Number.isNaN(h) || h < 0 || h > 0xffff)) return null;
  return hextets.flatMap((h) => [h >> 8, h & 0xff]);
}

function istPrivateIpv6(b: number[]): boolean {
  const alleNull = (von: number, bis: number) => b.slice(von, bis).every((x) => x === 0);
  const v4 = (ab: number) => istPrivateIpv4([b[ab]!, b[ab + 1]!, b[ab + 2]!, b[ab + 3]!]);

  if (alleNull(0, 16)) return true; // ::
  if (alleNull(0, 15) && b[15] === 1) return true; // ::1
  // IPv4-gemappt ::ffff:a.b.c.d und IPv4-kompatibel ::a.b.c.d — die
  // IPv4-Prüfung gilt dann für das eingebettete IPv4.
  if (alleNull(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4(12);
  if (alleNull(0, 12)) return v4(12);
  // NAT64 64:ff9b::/96 — übersetzt auf das eingebettete IPv4.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && alleNull(4, 12)) return v4(12);
  // 6to4 2002::/16 — trägt ein IPv4 in Byte 2–5.
  if (b[0] === 0x20 && b[1] === 0x02) return v4(2);
  // Teredo 2001:0::/32 — Tunnel, Ziel nicht prüfbar: abweisen.
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true;
  // Dokumentation 2001:db8::/32.
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true;
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return true; // fec0::/10 site-local (veraltet)
  if (b[0] === 0xff) return true; // Multicast
  return false;
}

/** Eine Namensauflösung, wie `dns.lookup` sie liefert — austauschbar für Prüfungen. */
export type Aufloeser = (name: string) => Promise<{ address: string; family: number }[]>;

const systemAufloeser: Aufloeser = (name) => lookup(name, { all: true, verbatim: true });

/**
 * Eine ausdrückliche Liste erlaubter Wirte, wenn der Betrieb sie setzt.
 *
 * Ohne die Variable ist jedes öffentliche Ziel erlaubt. Mit ihr **nur** die
 * genannten — das ist die engere Einstellung und die, die ein Betrieb mit
 * festen Gegenstellen wählen sollte.
 */
function erlaubteWirte(): string[] {
  return (process.env.AUTOMATION_WEBHOOK_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export async function pruefeZiel(
  url: string,
  aufloesen: Aufloeser = systemAufloeser,
): Promise<{ ok: true; wirt: string } | { ok: false; fehler: WebhookFehler; grund: string }> {
  let ziel: URL;
  try {
    ziel = new URL(url);
  } catch {
    return { ok: false, fehler: 'SCHEMA', grund: 'Keine gültige Adresse.' };
  }

  if (ziel.protocol !== 'https:') {
    return { ok: false, fehler: 'SCHEMA', grund: 'Nur https ist zulässig.' };
  }

  // `[::1]` → `::1`: `URL.hostname` behält die Klammern um IPv6-Literale, und
  // `isIP('[::1]')` ist 0 — ohne das Entfernen landete die Adresse in der
  // Namensauflösung statt in der Adressprüfung.
  const wirt = ziel.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  const liste = erlaubteWirte();
  if (liste.length > 0 && !liste.includes(wirt)) {
    return {
      ok: false,
      fehler: 'NICHT_ERLAUBT',
      grund: 'Dieser Wirt steht nicht in AUTOMATION_WEBHOOK_HOSTS.',
    };
  }

  /**
   * Eine unmittelbar angegebene Adresse wird direkt geprüft — `lookup` würde
   * sie zwar durchreichen, aber der kurze Weg spart einen Rundlauf und macht
   * den Fall im Code sichtbar.
   */
  if (isIP(wirt)) {
    return istPrivateAdresse(wirt)
      ? { ok: false, fehler: 'PRIVATE_ADRESSE', grund: 'Adresse liegt im privaten Bereich.' }
      : { ok: true, wirt };
  }

  let adressen: { address: string }[];
  try {
    adressen = await aufloesen(wirt);
  } catch {
    return { ok: false, fehler: 'UNAUFLOESBAR', grund: 'Der Name liess sich nicht auflösen.' };
  }

  if (adressen.length === 0) {
    return { ok: false, fehler: 'UNAUFLOESBAR', grund: 'Keine Adresse zu diesem Namen.' };
  }

  /**
   * **Alle** aufgelösten Adressen müssen öffentlich sein, nicht nur die erste.
   * Ein Name mit zwei Einträgen — einer öffentlich, einer auf `127.0.0.1` —
   * käme sonst durch, und welcher davon beim Aufruf gewählt wird, entscheidet
   * nicht diese Anwendung.
   */
  for (const { address } of adressen) {
    if (istPrivateAdresse(address)) {
      return {
        ok: false,
        fehler: 'PRIVATE_ADRESSE',
        grund: 'Der Name zeigt auf eine Adresse im privaten Bereich.',
      };
    }
  }

  return { ok: true, wirt };
}

/** Fehler der Verbindungsauflösung: das Ziel zeigte beim Anwählen auf eine private Adresse. */
class PrivatesZielBeimVerbinden extends Error {
  constructor() {
    super('Die Adresse zeigte beim Verbinden in den privaten Bereich.');
    this.name = 'PrivatesZielBeimVerbinden';
  }
}

/**
 * Die Auflösung **für die Verbindung** — im Format, das `net.connect` als
 * `lookup` erwartet. Sie liefert nur eine Adresse, die sie selbst geprüft
 * hat; ist eine der Antworten privat, bricht sie ab (dieselbe Regel wie
 * `pruefeZiel`: alle, nicht nur die erste).
 */
export function pruefendeVerbindungsaufloesung(aufloesen: Aufloeser = systemAufloeser): LookupFunction {
  return (name, optionen, rueckruf) => {
    const antworten = isIP(name) ? Promise.resolve([{ address: name, family: isIP(name) }]) : aufloesen(name);
    antworten.then(
      (adressen) => {
        if (adressen.length === 0) return rueckruf(new Error('Keine Adresse'), '', 0);
        if (adressen.some((a) => istPrivateAdresse(a.address))) return rueckruf(new PrivatesZielBeimVerbinden(), '', 0);
        if (typeof optionen === 'object' && optionen && 'all' in optionen && optionen.all) {
          // Mehrere Adressen (Happy Eyeballs) — alle geprüft.
          return (rueckruf as unknown as (e: Error | null, a: { address: string; family: number }[]) => void)(null, adressen);
        }
        rueckruf(null, adressen[0]!.address, adressen[0]!.family);
      },
      (fehler: Error) => rueckruf(fehler, '', 0),
    );
  };
}

/**
 * Den Aufruf ausführen.
 *
 * Eigenschaften, jede mit einem Grund:
 *
 *  • **Die angewählte Adresse ist die geprüfte** — die Verbindung löst über
 *    `pruefendeVerbindungsaufloesung` auf, nicht über eine zweite,
 *    ungeprüfte DNS-Abfrage (DNS Rebinding, siehe Dateikopf).
 *  • **Keine Weiterleitungen.** Eine Weiterleitung führte an der
 *    Zielprüfung vorbei; `https.request` folgt keiner, 3xx ist ein
 *    Fehlschlag, und die Signatur reist nie zu einem anderen Ziel.
 *  • **Zeitlimit**, sonst bindet eine langsame Gegenstelle den Lauf.
 *  • **Grössengrenze** auf die Antwort, stückweise gelesen und abgebrochen —
 *    eine endlose Antwort füllt nicht den Speicher.
 *  • **Signatur statt Geheimnis in der Kopfzeile.** Ein gemeinsames Geheimnis
 *    im Klartext stünde in jedem Protokoll zwischen hier und dort. Der HMAC
 *    über den Rumpf beweist dasselbe und verrät nichts.
 */
export async function sendeWebhook(params: {
  url: string;
  rumpf: unknown;
  secret?: string;
  /**
   * Gleich für jeden Versuch derselben Aktion (Lauf und Stelle). Eine
   * Gegenstelle, die `Idempotency-Key` auswertet, erkennt einen
   * Wiederholungsversuch nach einem Zeitlimit — ob der erste Versuch dort
   * ankam, weiss dieser Server nicht.
   */
  idempotenzSchluessel?: string;
  /** Nur für Prüfungen: eine kontrollierte Namensauflösung statt DNS. */
  aufloesen?: Aufloeser;
}): Promise<WebhookErgebnis> {
  const start = Date.now();
  const aufloesen = params.aufloesen ?? systemAufloeser;

  const pruefung = await pruefeZiel(params.url, aufloesen);
  if (!pruefung.ok) {
    return { ok: false, fehler: pruefung.fehler, grund: pruefung.grund, dauerMs: Date.now() - start };
  }

  const rumpf = JSON.stringify(params.rumpf);
  const kopfzeilen: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Clenaris-Automation/1',
    'Content-Length': String(Buffer.byteLength(rumpf)),
    ...(params.idempotenzSchluessel ? { 'Idempotency-Key': params.idempotenzSchluessel } : {}),
  };

  if (params.secret) {
    kopfzeilen['X-Clenaris-Signature'] =
      'sha256=' + createHmac('sha256', params.secret).update(rumpf).digest('hex');
  }

  /**
   * `https.request` statt `fetch`: nur so lässt sich die Auflösung der
   * **Verbindung** selbst bestimmen (siehe Dateikopf). Weiterleitungen folgt
   * `https.request` ohnehin nie — eine 3xx-Antwort ist hier ein Fehlschlag,
   * und das Geheimnis reist nie zu einem anderen Ziel. `agent: false`: keine
   * wiederverwendete Verbindung, die zu einer früheren Auflösung gehört.
   */
  return new Promise<WebhookErgebnis>((fertig) => {
    let erledigt = false;
    const ende = (ergebnis: Omit<WebhookErgebnis, 'dauerMs'>) => {
      if (erledigt) return;
      erledigt = true;
      fertig({ ...ergebnis, dauerMs: Date.now() - start });
    };

    const anfrage = httpsRequest(
      params.url,
      {
        method: 'POST',
        headers: kopfzeilen,
        agent: false,
        lookup: pruefendeVerbindungsaufloesung(aufloesen),
        timeout: WEBHOOK_TIMEOUT_MS,
      },
      (antwort) => {
        /**
         * Den Rumpf lesen und wegwerfen — gedeckelt. Gelesen wird nur, damit
         * die Verbindung sauber schliesst; beim Überschreiten der Grenze wird
         * sie abgebrochen. Der Inhalt der Gegenstelle gehört nirgends hin.
         */
        let gelesen = 0;
        antwort.on('data', (stueck: Buffer) => {
          gelesen += stueck.byteLength;
          if (gelesen > WEBHOOK_MAX_ANTWORT_BYTES) antwort.destroy();
        });
        const status = antwort.statusCode ?? 0;
        const abschluss = () =>
          status >= 200 && status < 300
            ? ende({ ok: true, status })
            : ende({ ok: false, status, fehler: 'STATUS', grund: `Die Gegenstelle antwortete mit ${status}.` });
        antwort.on('end', abschluss);
        antwort.on('close', abschluss);
        antwort.on('error', abschluss);
      },
    );

    anfrage.on('timeout', () => {
      anfrage.destroy();
      ende({ ok: false, fehler: 'TIMEOUT', grund: 'Zeitlimit überschritten.' });
    });
    anfrage.on('error', (fehler) =>
      ende(
        fehler instanceof PrivatesZielBeimVerbinden
          ? { ok: false, fehler: 'PRIVATE_ADRESSE', grund: fehler.message }
          : { ok: false, fehler: 'NETZWERK', grund: 'Die Gegenstelle war nicht erreichbar.' },
      ),
    );
    anfrage.end(rumpf);
  });
}
