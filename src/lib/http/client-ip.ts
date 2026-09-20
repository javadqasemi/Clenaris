/**
 * Die Adresse der anfragenden Stelle — und woher die Anwendung sie weiss.
 *
 * **Warum das eine eigene Datei mit einer Richtlinie ist.** Vorher stand in
 * `rate-limit.ts` eine Kette `cf-connecting-ip → x-real-ip → x-forwarded-for`,
 * die jedem Kopf glaubte, den irgendwer schickte. Steht kein Cloudflare vor
 * der Anwendung, setzt der Client `CF-Connecting-IP` selbst; steht kein Proxy
 * davor, schreibt er `X-Forwarded-For` nach Belieben. Die gespeicherte
 * Adresse — im Prüfprotokoll, bei der Offertannahme, im Rate-Limit — war
 * damit eine Behauptung des Absenders. Für ein Signaturprotokoll ist das
 * unbrauchbar, und für alles andere war es nie besser.
 *
 * Jetzt sagt die Betreiberin, was vor der Anwendung steht
 * (`TRUSTED_PROXY_MODE`), und nur diesem einen Kopf wird geglaubt:
 *
 *  • `NONE` (Vorgabe) — kein vertrauenswürdiger Proxy bekannt. Next.js gibt
 *    die Socket-Adresse nicht preis; die Adresse ist dann **nicht
 *    verfügbar**. Das ist die ehrliche Antwort, keine Notlösung: Eine
 *    unbekannte Adresse ist besser als eine erfundene.
 *  • `SINGLE_REVERSE_PROXY` — genau ein Proxy (Nginx) davor, der
 *    `X-Real-IP` aus seiner eigenen Socket-Adresse **setzt** und alles vom
 *    Internet Gelieferte überschreibt. Siehe `docs/DEPLOYMENT.md` 13.5.1.
 *  • `CLOUDFLARE` — `CF-Connecting-IP`, und nur, wenn der Ursprung nicht
 *    direkt aus dem Internet erreichbar ist (sonst ist der Kopf fälschbar).
 *
 * **Was dieser Code nicht leisten kann — und nicht behauptet.** Er sieht nur
 * Kopfzeilen. Ob `X-Real-IP` wirklich vom eigenen Nginx stammt oder von einem
 * Client, der den Anwendungsport direkt erreicht, lässt sich hier nicht
 * unterscheiden. `SINGLE_REVERSE_PROXY` und `CLOUDFLARE` sind deshalb keine
 * Spoofing-Sperren, sondern **Zusagen über die Topologie**: Der Modus ist nur
 * dann richtig, wenn der Ursprung ausschliesslich über den benannten Proxy
 * erreichbar ist (Loopback-Bindung oder Firewall) und dieser die Kopfzeile
 * überschreibt statt weiterreicht. Fehlt eine der beiden Bedingungen, ist der
 * gespeicherte Wert wieder eine Behauptung des Absenders — der Modus macht ihn
 * nicht wahrer. Wer die Topologie nicht kennt, lässt `NONE`.
 *
 * Die Quelle wird mitgeliefert (`source`) und im Signaturprotokoll neben der
 * Adresse gespeichert. Eine IP-Adresse ist ein technisches Metadatum, kein
 * Identitätsnachweis — das gilt in jedem Modus.
 */

export type TrustedProxyMode = 'NONE' | 'SINGLE_REVERSE_PROXY' | 'CLOUDFLARE';

export type IpSource = 'CLOUDFLARE' | 'NGINX_X_REAL_IP' | 'DIRECT' | 'UNAVAILABLE';

export interface ResolvedClientIp {
  ip: string | null;
  source: IpSource;
}

const MODES: ReadonlySet<string> = new Set(['NONE', 'SINGLE_REVERSE_PROXY', 'CLOUDFLARE']);

/**
 * Über `process.env` statt `serverEnv()`: Diese Funktion läuft auch dort, wo
 * das vollständige Umgebungsschema nicht geladen werden soll (Rate-Limit im
 * Anfragepfad). Ein unbekannter Wert fällt auf `NONE` — die sichere Seite.
 */
export function trustedProxyMode(): TrustedProxyMode {
  const wert = process.env.TRUSTED_PROXY_MODE?.trim().toUpperCase();
  return wert && MODES.has(wert) ? (wert as TrustedProxyMode) : 'NONE';
}

/** IPv4 oder IPv6, ohne Zone-Suffix, höchstens 45 Zeichen — mehr ist kein Adresswert. */
const IP_FORM = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{2,45})$/i;

function bereinigt(wert: string | null): string | null {
  if (!wert) return null;
  const v = wert.trim();
  return IP_FORM.test(v) ? v : null;
}

/**
 * Der Kern arbeitet auf `Headers`, nicht auf `Request`.
 *
 * Der Grund ist eine konkrete Lücke: `session.ts` und `auth.service.ts` haben
 * die Adresse früher selbst aus den Kopfzeilen gelesen — mit der alten Kette
 * `cf-connecting-ip → x-real-ip → x-forwarded-for`, die hier längst
 * abgeschafft war. Sie taten es, weil sie im Server-Component-Kontext nur
 * `headers()` haben und kein `Request`, und die einzige angebotene Funktion
 * ein `Request` verlangte. Eine Richtlinie, die man nicht überall aufrufen
 * kann, wird eben nicht überall aufgerufen; die zweite Kette war die Folge,
 * nicht die Ursache.
 *
 * Deshalb ist `Headers` der Einstiegspunkt und `resolveClientIp` nur noch die
 * bequeme Hülle für Aufrufer, die ein `Request` haben.
 */
export function resolveClientIpFromHeaders(h: Headers): ResolvedClientIp {
  switch (trustedProxyMode()) {
    case 'CLOUDFLARE': {
      const ip = bereinigt(h.get('cf-connecting-ip'));
      return ip ? { ip, source: 'CLOUDFLARE' } : { ip: null, source: 'UNAVAILABLE' };
    }
    case 'SINGLE_REVERSE_PROXY': {
      /**
       * Ausschliesslich `X-Real-IP` — der Kopf, den Nginx aus `$remote_addr`
       * setzt. Bis Gate 4C stand hier ein Rückfall auf den ersten Eintrag von
       * `X-Forwarded-For`; er ist weg. Die Deployment-Invariante verlangt,
       * dass der Proxy `X-Real-IP` selbst setzt. Fehlt der Kopf, ist der
       * Proxy falsch konfiguriert oder die Anfrage kam an ihm vorbei — in
       * beiden Fällen ist „nicht verfügbar" die richtige Antwort, nicht ein
       * zweiter Kopf, dem man nun ersatzweise glaubt. Fail-closed.
       */
      const real = bereinigt(h.get('x-real-ip'));
      return real ? { ip: real, source: 'NGINX_X_REAL_IP' } : { ip: null, source: 'UNAVAILABLE' };
    }
    case 'NONE':
    default:
      // Bewusst kein Blick in irgendeinen Kopf: Ohne bekannten Proxy ist jeder
      // davon vom Absender geschrieben.
      return { ip: null, source: 'UNAVAILABLE' };
  }
}

export function resolveClientIp(request: Request): ResolvedClientIp {
  return resolveClientIpFromHeaders(request.headers);
}

/**
 * Adresse oder `null`, für Aufrufer mit `Headers` — etwa `createSession` und
 * die Anmeldung, die `session.ip` und `lastLoginIp` festhalten.
 *
 * Bewusst `null` statt `'unbekannt'`: Diese beiden Felder sind nullable und
 * sollen den Unterschied zwischen „keine Adresse bekannt" und einer echten
 * Adresse behalten. Der Ersatzwert `'unbekannt'` gehört allein in den
 * Rate-Limit-Schlüssel, wo ein String gebraucht wird.
 */
export function clientIpFromHeaders(h: Headers): string | null {
  return resolveClientIpFromHeaders(h).ip;
}

/**
 * Browser-Angabe, gedeckelt und von Steuerzeichen befreit.
 *
 * Der Wert ist frei wählbar und beweist nichts; im Protokoll heisst er
 * deshalb „Client-Angabe". Hier geht es nur darum, dass er die Datenbank
 * nicht mit Kilobytes oder Zeilenumbrüchen füllt.
 */
export function clientReportedUserAgent(request: Request): string | null {
  const ua = request.headers.get('user-agent');
  if (!ua) return null;
  // eslint-disable-next-line no-control-regex
  const sauber = ua.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return sauber ? sauber.slice(0, 512) : null;
}
