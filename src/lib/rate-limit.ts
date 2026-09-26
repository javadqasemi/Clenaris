import { cache } from '@/lib/redis';
import { RateLimitError } from '@/lib/errors';
import { resolveClientIp } from '@/lib/http/client-ip';

/**
 * Fixed-Window-Rate-Limiting über Redis (bzw. In-Memory-Fallback).
 *
 * Architekturentscheid: Fixed Window statt Sliding Log — ein einziger
 * `INCR`+`EXPIRE` pro Request, damit das Limit selbst unter Last billig bleibt.
 * Für die Missbrauchsabwehr, die wir hier brauchen (Login-Bruteforce,
 * Formular-Spam, teure KI-Endpunkte), ist die Ungenauigkeit an der
 * Fenstergrenze irrelevant. Cloudflare übernimmt vorgelagert die
 * volumetrische Abwehr.
 */

export interface RateLimitRule {
  /** Erlaubte Anfragen pro Fenster. */
  limit: number;
  /** Fensterlänge in Sekunden. */
  windowSeconds: number;
}

export const RATE_LIMITS = {
  login: { limit: 8, windowSeconds: 300 },
  register: { limit: 5, windowSeconds: 3600 },
  passwordReset: { limit: 4, windowSeconds: 3600 },
  contactForm: { limit: 6, windowSeconds: 3600 },
  bookingCreate: { limit: 12, windowSeconds: 3600 },
  quoteRequest: { limit: 10, windowSeconds: 3600 },
  priceEstimate: { limit: 90, windowSeconds: 60 },
  newsletter: { limit: 5, windowSeconds: 3600 },
  aiGenerate: { limit: 30, windowSeconds: 3600 },
  aiChat: { limit: 60, windowSeconds: 3600 },
  /**
   * Ein Upload-Ticket anfordern.
   *
   * **Hier und nur hier wird die Zahl der Uploads begrenzt.** Ein Ticket ist
   * die Erlaubnis, genau eine Datei abzulegen; ohne Ticket geht weder das
   * Schreiben der Bytes noch der Abschluss. Wer 60 Dateien in zehn Minuten
   * hochladen will, holt 60 Tickets, und dabei greift dieses Kontingent.
   */
  fileUpload: { limit: 60, windowSeconds: 600 },
  /**
   * Bytes schreiben und Upload abschliessen.
   *
   * **Warum eigene, deutlich weitere Zahlen.** Beide Schritte lagen zuerst
   * ebenfalls auf `fileUpload`. Das klang sparsam und war falsch: Ein
   * einziger Upload besteht seit Gate 2 aus drei Aufrufen — Ticket, Bytes,
   * Abschluss. Auf demselben Zähler hätte das die tatsächliche Obergrenze
   * von sechzig Dateien auf zwanzig gedrittelt, ohne dass irgendwo stünde,
   * dass sie zwanzig ist. Die eigene Prüfreihe lief prompt hinein; im
   * Betrieb wäre es eine Person gewesen, die nach dem zwanzigsten
   * Baustellenfoto nicht mehr weiterkommt.
   *
   * Ein Kontingent braucht es hier trotzdem: Der Schreibschritt nimmt einen
   * grossen Körper entgegen, der Abschluss löst beim externen Speicher einen
   * serverseitigen Download aus. Beide setzen aber ein Ticket voraus, das
   * bereits gezählt wurde — sie begrenzen also nicht die Menge, sondern das
   * Tempo.
   */
  fileTransfer: { limit: 240, windowSeconds: 600 },
  /**
   * Dateien ausliefern.
   *
   * Zweitrangig hinter der eigentlichen Prüfung — das Kontingent ersetzt
   * weder Sitzung noch Berechtigung, es begrenzt nur, wie schnell jemand
   * Kennungen durchprobieren kann, und schützt die Datenbank davor, grosse
   * Binärdaten am Stück auszuliefern. Eine Seite mit vielen Bildern lädt
   * leicht dreissig Dateien auf einmal; deshalb grosszügig.
   */
  fileDownload: { limit: 300, windowSeconds: 60 },
  apiRead: { limit: 300, windowSeconds: 60 },
  apiWrite: { limit: 90, windowSeconds: 60 },
  webhook: { limit: 600, windowSeconds: 60 },
  /**
   * Scans auflösen (Scanplattform, 2026-09-26).
   *
   * Enger als `apiRead`, weil ein Scan exakte Nummern prüft: Rechnungs-,
   * Kunden- und Einsatznummern sind fortlaufend, und 300 Versuche pro Minute
   * wären ein bequemes Werkzeug, um sie durchzuzählen — zwar nur innerhalb
   * des eigenen Leserechts, aber genau dafür gibt es die Liste. 60 pro Minute
   * ist ein Scan pro Sekunde; schneller scannt auch ein Handscanner an der
   * Inventur nicht dauerhaft. Etikettcodes selbst tragen 100 Bit Zufall; das
   * Limit schützt sie nicht, es schützt die Nummern.
   */
  scanResolve: { limit: 60, windowSeconds: 60 },

  /**
   * Links ohne Anmeldung — enger als `apiRead`/`apiWrite`.
   *
   * **Warum eigene Kontingente.** Bei einem angemeldeten Endpunkt schützt das
   * Limit vor Überlast; der Zugang selbst hängt an der Sitzung. Bei einem
   * Capability-Link ist das Limit die *zweite* Verteidigungslinie hinter der
   * Entropie des Tokens — und die einzige, die greift, während jemand rät.
   *
   * `apiRead` mit 300/min und `apiWrite` mit 90/min ergeben zusammen 390
   * Versuche pro Minute, also 23 400 pro Stunde und IP. Gegen 256 Bit Entropie
   * ist das bedeutungslos; gegen die alten cuid-Tokens mit vorhersagbarem
   * Kopf war es zu viel. Da alte Links während des Übergangs weiterhin
   * akzeptiert werden, gelten hier die engeren Zahlen — sie kosten legitime
   * Nutzung nichts: Wer eine Offerte ansieht, lädt sie wenige Male, nicht
   * sechzigmal pro Minute.
   */
  publicTokenRead: { limit: 60, windowSeconds: 60 },
  /**
   * Abschliessende Handlungen: Offerte annehmen oder ablehnen, Rechnung
   * bezahlen, später eine Unterschrift finalisieren.
   *
   * **Gezählt wird pro Token, nicht pro IP** — siehe `rateLimitKey` an den
   * betroffenen Routen. Das ist der eigentliche Punkt dieses Kontingents, und
   * er wurde erst beim zweiten Anlauf richtig:
   *
   * Wogegen es schützt, ist nicht das Erraten eines Tokens — dafür ist die
   * Leseroute der billigere Weg, und gegen 256 Bit Entropie hilft ohnehin
   * kein Kontingent. Es schützt gegen die *Kosten*, die ein gültiger Link
   * auslösen kann: Eine Annahme rendert ein PDF neu und verschickt zwei
   * Nachrichten. Diese Kosten hängen an der Ressource, nicht am Absender.
   *
   * Pro IP zu zählen war deshalb doppelt falsch. Es traf die Falschen —
   * hinter einer Adresse kann ein ganzes Unternehmen stehen, und die eigene
   * Prüfreihe lief prompt hinein — und es traf den Richtigen nicht: Wer eine
   * einzelne Offerte hämmern will, wechselt die Adresse.
   *
   * Zehn Versuche in zehn Minuten **je Link** sind grosszügig für einen
   * Menschen, der einmal zusagt und vielleicht einmal neu lädt, und hart für
   * alles andere.
   */
  publicTokenAction: { limit: 10, windowSeconds: 600 },
  /**
   * Einmalkennwort anfordern. Eng, weil jede Anforderung eine E-Mail oder
   * eine kostenpflichtige SMS auslöst — das Limit schützt hier auch die
   * Rechnung, nicht nur das Verfahren.
   */
  otpRequest: { limit: 5, windowSeconds: 900 },
  /**
   * Einmalkennwort prüfen. Sechs Ziffern sind eine Million Möglichkeiten;
   * ohne Bremse wären sie in Minuten durchprobiert.
   */
  otpVerify: { limit: 8, windowSeconds: 900 },
  /**
   * Einen Signaturlink gegen eine Sitzung tauschen. Der Tausch ist der
   * einzige Aufruf, der den rohen Token trägt; wer hier rät, rät gegen
   * 256 Bit — das Kontingent begrenzt nur das Tempo.
   */
  signatureExchange: { limit: 20, windowSeconds: 600 },
  /**
   * Unterzeichnen und Ablehnen: je Teilnehmer gezählt (Schlüssel ist der
   * Hash der Teilnehmerkennung, nie ein Geheimnis). Zehn Versuche reichen
   * für jeden ehrlichen Ablauf mit Wiederholung.
   */
  signatureFinalize: { limit: 10, windowSeconds: 600 },
  /**
   * Gerät nach der Kundenabnahme wieder übernehmen (Gate 4D).
   *
   * Gezählt **je Übergabe**, nicht je Konto: Ein kontoweites Limit liesse
   * sich von aussen auslösen — dreimal daneben getippt, und die Person käme
   * auf keinem ihrer Geräte mehr hinein. Die Übergabe ist der engere und
   * richtigere Schlüssel; sie endet ohnehin mit dem Entsperren.
   *
   * Zehn Versuche sind grosszügig für jemanden, der auf einem Telefon
   * zwischen zwei Terminen ein Passwort eintippt, und eng genug, dass
   * Raten über ein liegengelassenes Gerät nicht lohnt.
   */
  handoffUnlock: { limit: 10, windowSeconds: 900 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  retryAfter: number;
}

/**
 * Zählt einen Treffer und meldet, ob das Limit überschritten wurde.
 * `identifier` ist üblicherweise IP, User-ID oder E-Mail.
 */
export async function checkRateLimit(
  name: RateLimitName,
  identifier: string,
): Promise<RateLimitResult> {
  const rule = RATE_LIMITS[name];
  const key = `rl:${name}:${identifier}`;

  const count = await cache.incr(key, rule.windowSeconds);
  const remaining = Math.max(0, rule.limit - count);
  const success = count <= rule.limit;
  const retryAfter = success ? 0 : Math.max(1, await cache.ttl(key));

  return { success, limit: rule.limit, remaining, retryAfter };
}

/** Wie `checkRateLimit`, wirft aber bei Überschreitung. */
export async function enforceRateLimit(
  name: RateLimitName,
  identifier: string,
): Promise<RateLimitResult> {
  const result = await checkRateLimit(name, identifier);
  if (!result.success) throw new RateLimitError(result.retryAfter);
  return result;
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
  };
  if (!result.success) headers['Retry-After'] = String(result.retryAfter);
  return headers;
}

/** Zähler zurücksetzen — z. B. nach erfolgreichem Login. */
export async function resetRateLimit(name: RateLimitName, identifier: string): Promise<void> {
  await cache.del(`rl:${name}:${identifier}`);
}

/**
 * Client-IP als Zählschlüssel.
 *
 * **Korrektur.** Hier stand eine Kette `cf-connecting-ip → x-real-ip →
 * x-forwarded-for`, die jedem Kopf glaubte. Die Auflösung liegt jetzt in
 * `lib/http/client-ip.ts` und folgt `TRUSTED_PROXY_MODE`. Ist keine Adresse
 * bekannt, zählt alles in einem Topf (`unbekannt`) — das ist die ehrliche
 * Folge davon, dass die Betreiberin keinen Proxy benannt hat, und steht so in
 * `docs/DEPLOYMENT.md`.
 */
export function getClientIp(request: Request): string {
  return resolveClientIp(request).ip ?? 'unbekannt';
}
