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
 *    Internet Gelieferte überschreibt. Siehe `docs/DEPLOYMENT.md`.
 *  • `CLOUDFLARE` — `CF-Connecting-IP`, und nur, wenn der Ursprung nicht
 *    direkt aus dem Internet erreichbar ist (sonst ist der Kopf fälschbar).
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

export function resolveClientIp(request: Request): ResolvedClientIp {
  const h = request.headers;

  switch (trustedProxyMode()) {
    case 'CLOUDFLARE': {
      const ip = bereinigt(h.get('cf-connecting-ip'));
      return ip ? { ip, source: 'CLOUDFLARE' } : { ip: null, source: 'UNAVAILABLE' };
    }
    case 'SINGLE_REVERSE_PROXY': {
      // `X-Real-IP` ist der Kopf, den Nginx aus `$remote_addr` setzt. Als
      // Rückfall der *erste* Eintrag von `X-Forwarded-For` — nur weil derselbe
      // Proxy ihn ebenfalls überschreibt (Dokumentation). Ohne diese Zusage
      // wäre er anhängbar.
      const real = bereinigt(h.get('x-real-ip'));
      if (real) return { ip: real, source: 'NGINX_X_REAL_IP' };
      const xff = bereinigt(h.get('x-forwarded-for')?.split(',')[0] ?? null);
      return xff ? { ip: xff, source: 'NGINX_X_REAL_IP' } : { ip: null, source: 'UNAVAILABLE' };
    }
    case 'NONE':
    default:
      // Bewusst kein Blick in irgendeinen Kopf: Ohne bekannten Proxy ist jeder
      // davon vom Absender geschrieben.
      return { ip: null, source: 'UNAVAILABLE' };
  }
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
