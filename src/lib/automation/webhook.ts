import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

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
 *  Was bleibt: die Umbenennung zwischen Prüfung und Aufruf
 * ---------------------------------------------------------------------------
 *
 * Zwischen der Auflösung hier und der Auflösung, die `fetch` selbst vornimmt,
 * liegt ein Moment. Wer den DNS-Eintrag in diesem Moment ändert (DNS
 * Rebinding), umgeht die Prüfung. Vollständig schliessen liesse sich das nur,
 * indem die geprüfte Adresse direkt angewählt wird — und dann passt der Name
 * im TLS-Handschlag nicht mehr, der Aufruf scheitert an jedem sauber
 * eingerichteten Ziel.
 *
 * Diese Lücke wird deshalb **benannt und nicht verschwiegen**. Sie verlangt
 * einen Angreifer mit Kontrolle über einen DNS-Eintrag und ein genaues
 * Zeitfenster; davor liegen: `automation:update` (Administration und
 * Betriebsleitung), nur `https`, keine Weiterleitungen, ein Zeitlimit und
 * eine Grössengrenze. Wer das enger will, setzt `AUTOMATION_WEBHOOK_HOSTS`
 * und lässt nur benannte Ziele zu.
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

  if (art === 4) {
    const teile = adresse.split('.').map(Number);
    const [a, b] = teile;

    if (a === 0) return true; // „dieses Netz"
    if (a === 10) return true; // privat
    if (a === 127) return true; // Rückschleife
    if (a === 169 && b === 254) return true; // Link-local *und* Cloud-Metadaten
    if (a === 172 && b >= 16 && b <= 31) return true; // privat
    if (a === 192 && b === 168) return true; // privat
    if (a === 100 && b >= 64 && b <= 127) return true; // Carrier-NAT
    if (a === 192 && b === 0) return true; // IETF-Protokollzuweisungen
    if (a >= 224) return true; // Multicast und reserviert
    return false;
  }

  if (art === 6) {
    const k = adresse.toLowerCase();
    if (k === '::' || k === '::1') return true;
    if (k.startsWith('fe80')) return true; // link-local
    if (k.startsWith('fc') || k.startsWith('fd')) return true; // unique local
    if (k.startsWith('ff')) return true; // multicast
    /**
     * IPv4-in-IPv6 (`::ffff:127.0.0.1`) — ohne diese Zeile wäre die gesamte
     * IPv4-Prüfung mit einer anderen Schreibweise zu umgehen.
     */
    const eingebettet = k.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (eingebettet) return istPrivateAdresse(eingebettet[1]);
    return false;
  }

  // Keine erkennbare Adresse — abweisen.
  return true;
}

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

  const wirt = ziel.hostname.toLowerCase();
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
    adressen = await lookup(wirt, { all: true });
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

/**
 * Den Aufruf ausführen.
 *
 * Eigenschaften, jede mit einem Grund:
 *
 *  • **Keine Weiterleitungen** (`redirect: 'manual'`). Eine Weiterleitung
 *    führte an der Zielprüfung vorbei — die Gegenstelle könnte auf
 *    `http://169.254.169.254` umleiten, und `fetch` folgte.
 *  • **Zeitlimit**, sonst bindet eine langsame Gegenstelle den Lauf.
 *  • **Grössengrenze** auf die Antwort; gelesen wird sie nur, um sie zu
 *    verwerfen — der Rumpf der Gegenstelle interessiert nicht und gehört
 *    nirgends hin.
 *  • **Signatur statt Geheimnis in der Kopfzeile.** Ein gemeinsames Geheimnis
 *    im Klartext stünde in jedem Protokoll zwischen hier und dort. Der HMAC
 *    über den Rumpf beweist dasselbe und verrät nichts.
 */
/**
 * Den Antwortrumpf lesen und wegwerfen — gedeckelt.
 *
 * **Warum nicht `antwort.arrayBuffer()`.** Das puffert erst die ganze Antwort
 * und prüft danach ihre Grösse — die Grenze käme also zu spät. Eine Gegenstelle
 * mit einer endlosen Antwort füllte den Speicher, bevor irgendetwas
 * eingreifen könnte.
 *
 * Gelesen wird deshalb stückweise, und beim Überschreiten der Grenze wird der
 * Strom abgebrochen. Der Inhalt interessiert nicht: Die Gegenstelle
 * antwortet mit einem Statuscode, und das ist alles, was zählt. Gelesen wird
 * nur, damit die Verbindung sauber schliesst.
 */
async function verwerfeRumpf(antwort: Response): Promise<void> {
  const leser = antwort.body?.getReader();
  if (!leser) return;

  let gelesen = 0;
  try {
    for (;;) {
      const { done, value } = await leser.read();
      if (done) break;
      gelesen += value?.byteLength ?? 0;
      if (gelesen > WEBHOOK_MAX_ANTWORT_BYTES) {
        await leser.cancel();
        break;
      }
    }
  } catch {
    // Ein abgerissener Rumpf ändert nichts am Ergebnis.
  }
}

export async function sendeWebhook(params: {
  url: string;
  rumpf: unknown;
  secret?: string;
}): Promise<WebhookErgebnis> {
  const start = Date.now();

  const pruefung = await pruefeZiel(params.url);
  if (!pruefung.ok) {
    return { ok: false, fehler: pruefung.fehler, grund: pruefung.grund, dauerMs: Date.now() - start };
  }

  const rumpf = JSON.stringify(params.rumpf);
  const kopfzeilen: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Clenaris-Automation/1',
  };

  if (params.secret) {
    kopfzeilen['X-Clenaris-Signature'] =
      'sha256=' + createHmac('sha256', params.secret).update(rumpf).digest('hex');
  }

  const abbruch = new AbortController();
  const zeitgeber = setTimeout(() => abbruch.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const antwort = await fetch(params.url, {
      method: 'POST',
      headers: kopfzeilen,
      body: rumpf,
      redirect: 'manual',
      signal: abbruch.signal,
    });

    await verwerfeRumpf(antwort);

    if (antwort.status >= 200 && antwort.status < 300) {
      return { ok: true, status: antwort.status, dauerMs: Date.now() - start };
    }

    return {
      ok: false,
      status: antwort.status,
      fehler: 'STATUS',
      grund: `Die Gegenstelle antwortete mit ${antwort.status}.`,
      dauerMs: Date.now() - start,
    };
  } catch (fehler) {
    const abgebrochen = fehler instanceof Error && fehler.name === 'AbortError';
    return {
      ok: false,
      fehler: abgebrochen ? 'TIMEOUT' : 'NETZWERK',
      grund: abgebrochen ? 'Zeitlimit überschritten.' : 'Die Gegenstelle war nicht erreichbar.',
      dauerMs: Date.now() - start,
    };
  } finally {
    clearTimeout(zeitgeber);
  }
}
