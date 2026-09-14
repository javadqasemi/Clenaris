/**
 * HTTP-Klient für die Prüfungen.
 *
 * Die Tests fahren die laufende Anwendung von aussen an, über echtes HTTP.
 * Das ist eine bewusste Entscheidung gegen Unit-Tests der Dienste: Was hier
 * geprüft wird, sind Berechtigungen, Statuscodes, Cookies und ausgeliefertes
 * HTML — also genau die Schichten, die ein direkter Funktionsaufruf
 * überspringt. Ein Test, der `createBooking()` aufruft, sagt nichts darüber,
 * ob der Endpunkt davor die Rechte prüft.
 *
 * Voraussetzung ist deshalb ein laufender Server. `tests/README.md` sagt, wie.
 */

export const BASE_URL = process.env.TEST_BASE_URL ?? 'http://localhost:3000';

export interface ApiResponse<T = unknown> {
  status: number;
  /** Geparste JSON-Antwort, sonst der Text, sonst `null`. */
  payload: T;
  /** Rohtext — für HTML-Prüfungen. */
  text: string;
  headers: Headers;
  /** Die gesetzten Cookies als fertiger `cookie`-Kopf. */
  cookies: string;
}

export interface CallOptions {
  /** Fertiger `cookie`-Kopf, wie ihn `ApiResponse.cookies` liefert. */
  jar?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * Weiterleitungen folgen? Standard ist `manual`: Ein 307 auf die
   * Anmeldeseite *ist* das Ergebnis, das geprüft werden soll — würde `fetch`
   * ihm folgen, sähe der Test eine 200 und hielte die Sperre für offen.
   */
  redirect?: RequestRedirect;
  /**
   * Verbleibende Versuche nach einem 429. Intern.
   *
   * Drei, nicht zwei: Das Anmeldelimit läuft in einem gleitenden Fenster von
   * fünf Minuten. Ein einzelnes Abwarten räumt es zwar leer, aber ein Lauf,
   * der genau an einer Fenstergrenze beginnt, kann zweimal hineinlaufen.
   */
  retries?: number;
}

const cookiesOf = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';')[0])
    .join('; ');

/**
 * Ein Aufruf, der das Rate-Limit aussitzt statt daran zu scheitern.
 *
 * Die Anmeldewege liegen hinter einem strengen Limit — sechs Ziffern sind
 * eine Million Möglichkeiten, und ohne Bremse wären sie in Minuten
 * durchprobiert. Eine Testreihe fährt sie schneller an, als ein Mensch es je
 * täte, und läuft deshalb hinein. Das ist kein Fehler, sondern der Beweis,
 * dass die Bremse greift: Der Test wartet die vom Server genannte Zeit ab.
 *
 * Nach zwei vergeblichen Versuchen wird der 429 durchgereicht — sonst
 * verdeckte eine Endlosschleife eine echte Fehlkonfiguration.
 */
export async function call<T = unknown>(
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<ApiResponse<T>> {
  const { jar, body, headers = {}, redirect = 'manual', retries = 3 } = options;

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    redirect,
    headers: {
      ...(jar ? { cookie: jar } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (response.status === 429 && retries > 0) {
    const wait = Number(response.headers.get('retry-after') ?? 5);
    await sleep((wait + 1) * 1000);
    return call<T>(method, path, { ...options, retries: retries - 1 });
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  return {
    status: response.status,
    payload: payload as T,
    text,
    headers: response.headers,
    cookies: cookiesOf(response),
  };
}

export const get = <T = unknown>(path: string, options?: CallOptions) =>
  call<T>('GET', path, options);
export const post = <T = unknown>(path: string, body?: unknown, options?: CallOptions) =>
  call<T>('POST', path, { ...options, body });
export const patch = <T = unknown>(path: string, body?: unknown, options?: CallOptions) =>
  call<T>('PATCH', path, { ...options, body });
export const put = <T = unknown>(path: string, body?: unknown, options?: CallOptions) =>
  call<T>('PUT', path, { ...options, body });
export const del = <T = unknown>(path: string, options?: CallOptions) =>
  call<T>('DELETE', path, options);

/** Die Nutzlast einer erfolgreichen Antwort — alle Endpunkte hüllen sie in `data`. */
export const data = <T>(response: ApiResponse<{ data: T }>): T => response.payload?.data;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Bis zur nächsten vollen Sekunde warten.
 *
 * Der Sitzungswiderruf vergleicht `iat` aus dem Zugangstoken mit dem
 * Widerrufszeitpunkt, und `iat` kennt im JWT nur Sekunden. Verglichen wird
 * streng kleiner, damit ein Token, das in derselben Sekunde wie der Widerruf
 * ausgestellt wurde, überlebt — sonst sperrte der eigene Passwortwechsel
 * einen aus. Eine Testreihe läuft schneller als eine Sekunde und liefe sonst
 * genau in dieses Fenster.
 */
export const nextSecond = () => sleep(1100 - (Date.now() % 1000));

/**
 * Ist überhaupt ein Server da?
 *
 * Ohne diese Prüfung meldeten alle Tests „Verbindung abgelehnt" und man suchte
 * den Fehler im Code statt im vergessenen `npm run start:built`.
 *
 * Angefahren wird `/api/auth/session`: öffentlich, ohne Datenbankzugriff und
 * ohne Zwischenspeicher, und es antwortet auch ohne Anmeldung mit 200.
 */
export async function requireServer(): Promise<void> {
  try {
    const response = await fetch(`${BASE_URL}/api/auth/session`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return;
    throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Kein Server unter ${BASE_URL} erreichbar (${reason}).\n` +
        'Diese Prüfungen fahren die laufende Anwendung an. Starten Sie sie mit\n' +
        '  npm run build && npm run start:built\n' +
        'oder setzen Sie TEST_BASE_URL auf eine andere Adresse.',
    );
  }
}
