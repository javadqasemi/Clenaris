import { createHash, timingSafeEqual } from 'node:crypto';

import type { NextRequest } from 'next/server';
import type { ZodType, ZodTypeDef } from 'zod';
import type { UserRole } from '@prisma/client';

import { getSession, type SessionUser } from '@/lib/auth/session';
import { can, type Permission } from '@/lib/auth/rbac';
import {
  DeviceHandoffLockedError,
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from '@/lib/errors';
import { enforceRateLimit, getClientIp, type RateLimitName } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { laufzeitUrsprung } from '@/lib/laufzeit-konfiguration';
import { trustedProxyMode } from '@/lib/http/client-ip';
import {
  mitAnfrageKontext,
  neueRequestId,
  routenVorlage,
  type AnfrageKontext,
} from '@/lib/observability/context';
import { beobachteAnfrage } from '@/lib/observability/metrics';
import { toErrorResponse } from './response';
// Deutsche Zod-Vorgaben für jede Route — siehe die Begründung in der Datei.
import '@/lib/validation/fehlerkarte';

const beobachtung = logger('http');

/**
 * Die Beobachtungshülle um jeden Endpunkt.
 *
 * ---------------------------------------------------------------------------
 *  Warum sie hier sitzt und nicht in der Middleware
 * ---------------------------------------------------------------------------
 *
 * Die Middleware läuft auf Edge. Dort gibt es kein `AsyncLocalStorage`, keine
 * Prisma-Verbindung und keinen gemeinsamen Speicher mit dem Node-Prozess, der
 * die Anfrage tatsächlich bedient — Kennzahlen aus der Middleware wären
 * Kennzahlen aus einem anderen Prozess. Ausserdem sieht die Middleware nicht,
 * was der Handler am Ende antwortet.
 *
 * Diese Fabrik ist die Stelle, durch die **jeder** Endpunkt läuft. Das ist
 * dieselbe Überlegung, aus der hier schon Herkunftsprüfung, Sitzung,
 * Gerätesperre, Rechte und Rate-Limit stehen: Eine Prüfung in den einzelnen
 * Handlern wäre eine Prüfung, die in dem einen vergessen wird, der sie
 * gebraucht hätte.
 *
 * ---------------------------------------------------------------------------
 *  Was sie tut
 * ---------------------------------------------------------------------------
 *
 *  1. Kennung erzeugen und den Kontext für die Dauer der Anfrage setzen —
 *     danach trägt jede Protokollzeile dieselbe Kennung, ohne dass sie jemand
 *     weiterreicht.
 *  2. Den Handler laufen lassen und die Dauer messen.
 *  3. Die Kennung in die Antwort schreiben (`X-Request-Id`).
 *  4. Die Anfrage in den Kennzahlen aufnehmen — unter der **Vorlage** des
 *     Pfads, nie unter dem Pfad selbst.
 *  5. Fehlschläge protokollieren: 5xx als Fehler, 4xx als Hinweis auf
 *     `debug`. Ein abgelehnter Zugriff ist der Normalfall einer
 *     funktionierenden Rechteprüfung und gehört nicht auf `warn` — sonst
 *     besteht das Protokoll aus abgewiesenen Anfragen und niemand liest es.
 *
 * Die Hülle **fängt nichts ab**. Die Fehlerbehandlung bleibt, wo sie war; hier
 * wird nur gemessen und weitergereicht.
 */
async function mitBeobachtung(
  request: NextRequest,
  routeParams: Record<string, unknown>,
  fn: () => Promise<Response>,
): Promise<Response> {
  const pfad = new URL(request.url).pathname;
  const kontext: AnfrageKontext = {
    requestId: neueRequestId(),
    route: routenVorlage(pfad, routeParams),
    method: request.method,
    startedAt: Date.now(),
  };

  return mitAnfrageKontext(kontext, async () => {
    let antwort: Response;
    try {
      antwort = await fn();
    } catch (fehler) {
      /**
       * Hierher kommt nur, was die Fehlerbehandlung der Fabrik **nicht**
       * gefangen hat — also ein Fehler in der Fehlerbehandlung selbst oder
       * etwas ausserhalb ihres `try`. Selten, und genau deshalb soll es nicht
       * spurlos durchgehen: Die Anfrage wird als 500 gezählt und der Fehler
       * protokolliert, bevor er weiterfliegt.
       */
      beobachteAnfrage({ ...kontext, status: 500, dauerMs: Date.now() - kontext.startedAt });
      beobachtung.error('Unbehandelter Fehler im Endpunkt', {
        route: kontext.route,
        method: kontext.method,
        error: fehler,
      });
      throw fehler;
    }

    const dauerMs = Date.now() - kontext.startedAt;
    beobachteAnfrage({ ...kontext, status: antwort.status, dauerMs });

    if (antwort.status >= 500) {
      beobachtung.error('Endpunkt antwortet mit Serverfehler', {
        route: kontext.route,
        method: kontext.method,
        status: antwort.status,
        dauerMs,
      });
    } else if (antwort.status >= 400) {
      beobachtung.debug('Endpunkt weist ab', {
        route: kontext.route,
        method: kontext.method,
        status: antwort.status,
        dauerMs,
      });
    }

    /**
     * Die Kopfzeile wird auf einer **Kopie** gesetzt.
     *
     * `Response.headers` ist bei einer bereits erzeugten Antwort
     * unveränderlich; ein `set` darauf wirft in Node. Die Kopie behält Rumpf
     * und Statuscode und bekommt die Kennung dazu.
     */
    const kopfzeilen = new Headers(antwort.headers);
    kopfzeilen.set('X-Request-Id', kontext.requestId);
    kopfzeilen.set('Server-Timing', `app;dur=${dauerMs}`);

    return new Response(antwort.body, {
      status: antwort.status,
      statusText: antwort.statusText,
      headers: kopfzeilen,
    });
  });
}

/**
 * Route-Handler-Fabrik.
 *
 * Architekturentscheid: Statt in jedem der ~90 Endpunkte Auth, Validierung,
 * Rate-Limiting und Fehlerbehandlung zu wiederholen, deklariert jeder Handler
 * seine Anforderungen einmal. Das erzwingt Konsistenz (kein Endpunkt kann
 * versehentlich ungeschützt bleiben) und hält die Handler auf reine Fachlogik
 * reduziert.
 *
 *   export const POST = defineRoute({
 *     permissions: ['booking:create'],
 *     body: createBookingSchema,
 *     rateLimit: 'apiWrite',
 *     handler: async ({ body, session }) => created(await createBooking(session, body)),
 *   });
 */

export interface RouteContext<TBody, TQuery, TParams> {
  request: NextRequest;
  body: TBody;
  query: TQuery;
  params: TParams;
  session: SessionUser;
  ip: string;
}

export interface PublicRouteContext<TBody, TQuery, TParams>
  extends Omit<RouteContext<TBody, TQuery, TParams>, 'session'> {
  session: SessionUser | null;
}

/**
 * `ZodType<Out, Def, unknown>` statt `ZodSchema<T>`: der *Eingabe*typ bleibt
 * offen, der Handler bekommt den *Ausgabe*typ. Nur so sind `.default()` und
 * `.transform()` im Schema korrekt typisiert — sonst gälten Felder mit
 * Standardwert im Handler weiterhin als `undefined`.
 */
type Schema<T> = ZodType<T, ZodTypeDef, unknown>;

interface BaseConfig<TBody, TQuery, TParams> {
  body?: Schema<TBody>;
  query?: Schema<TQuery>;
  params?: Schema<TParams>;
  rateLimit?: RateLimitName;
  /** Rate-Limit-Schlüssel; Standard ist die Client-IP. */
  rateLimitKey?: (ctx: { request: NextRequest; ip: string; session: SessionUser | null }) => string;
}

interface ProtectedConfig<TBody, TQuery, TParams> extends BaseConfig<TBody, TQuery, TParams> {
  permissions?: Permission[];
  /** true = mindestens eine Berechtigung genügt (Standard: alle nötig). */
  anyPermission?: boolean;
  /**
   * Zusätzliche Rollenschranke.
   *
   * Für die wenigen Fälle, in denen die Einschränkung wirklich an der Rolle
   * hängt und nicht an einer Fähigkeit — etwa das Anlegen von Personal samt
   * Lohn- und AHV-Feldern. Wo eine Berechtigung die Regel ausdrücken kann,
   * ist sie vorzuziehen: sie überlebt eine spätere Rollenerweiterung.
   */
  roles?: UserRole[];
  /**
   * Darf dieser Endpunkt laufen, während das Gerät übergeben ist (Gate 4D)?
   *
   * Vorgabe ist `false`, und das ist der Punkt: Während der Kunde das Gerät
   * hält, ist **jeder** angemeldete Endpunkt gesperrt, bis ihn jemand
   * ausdrücklich freigibt. Eine Erlaubnisliste, die man vergisst zu pflegen,
   * lässt Türen offen; eine Verbotsliste, die man vergisst zu pflegen,
   * schliesst sie. Erlaubt ist nur, was die Übergabe selbst braucht — die
   * Statusabfrage und das Entsperren.
   *
   * Die öffentlichen Signaturendpunkte laufen über `definePublicRoute` und
   * sind von der Sperre ohnehin nicht betroffen: Sie hängen an der
   * Signatursitzung des Kunden, nicht an der Mitarbeitersitzung.
   */
  allowDuringHandoff?: boolean;
  handler: (ctx: RouteContext<TBody, TQuery, TParams>) => Promise<Response> | Response;
}

interface PublicConfig<TBody, TQuery, TParams> extends BaseConfig<TBody, TQuery, TParams> {
  handler: (
    ctx: PublicRouteContext<TBody, TQuery, TParams>,
  ) => Promise<Response> | Response;
}

/**
 * Zweites Argument eines Next-Route-Handlers.
 *
 * Next.js erzeugt die erwartete Signatur pro Route neu — bei `[id]` ist
 * `params` ein `Promise<{ id: string }>`, bei statischen Routen ein leeres
 * Objekt. Eine feste Form wäre für jeweils die andere Variante inkompatibel,
 * deshalb bleibt der Inhalt hier absichtlich offen und wird über die
 * `params`-Schemas der einzelnen Routen validiert.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NextRouteArgs = { params: Promise<any> };

/**
 * Herkunftsprüfung für ändernde Anfragen.
 *
 * Die Sitzung liegt in einem Cookie mit `SameSite=Lax`. Das genügt gegen
 * fremd ausgelöste Formulare in allen aktuellen Browsern — aber es ist genau
 * *eine* Verteidigungslinie, und sie hängt an einem Cookie-Attribut, das eine
 * spätere Konfiguration (`AUTH_COOKIE_DOMAIN`, ein anderes `sameSite`) still
 * aufweichen kann. Die zweite Linie steht deshalb hier: Ein Browser schickt
 * bei jedem `POST`, `PUT`, `PATCH` und `DELETE` den `Origin`-Kopf mit, und
 * der muss zu dieser Anwendung gehören.
 *
 * Fehlt der Kopf, wird nicht geblockt: Nicht-Browser-Klienten (Tests, Cron,
 * Webhooks, `curl`) senden keinen, und für sie ist CSRF kein Angriffsvektor —
 * sie tragen kein fremdgesteuertes Cookie. Geprüft wird nur, was ein Browser
 * behauptet. `null` als Herkunft (Sandbox-Rahmen, Weiterleitungsketten) gilt
 * als fremd.
 *
 * Erlaubt sind der Host der Anfrage selbst und der Host aus `APP_URL`
 * (`laufzeitUrsprung()`, Server-Umgebung, zur Laufzeit) — letzterer, falls
 * die Anwendung hinter einem Proxy unter einem anderen Namen antwortet, als
 * der Browser sie aufgerufen hat.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function assertTrustedOrigin(request: NextRequest): void {
  if (SAFE_METHODS.has(request.method)) return;

  const origin = request.headers.get('origin');
  if (origin === null) return;

  let originHost: string | null = null;
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = null;
  }

  const allowed = new Set<string>();
  // `X-Forwarded-Host` zählt nur, wenn ein Proxy davorsteht, dem die
  // Anwendung ausdrücklich glaubt (`TRUSTED_PROXY_MODE`, wie bei der
  // Client-Adresse). Ohne Proxy setzt diesen Kopf nur der Aufrufer selbst —
  // und dann könnte er die vertraute Herkunft um einen beliebigen Host
  // erweitern (V2-1, Phase 9, 2026-09-26). Ein Browser kann den Kopf
  // quer über Herkünfte zwar nicht ohne Preflight setzen; die Regel „die
  // vertraute Herkunft kommt nur aus der Server-Umgebung" soll aber nicht
  // davon abhängen, welcher Klient anfragt.
  const requestHost =
    (trustedProxyMode() !== 'NONE' ? request.headers.get('x-forwarded-host') : null) ?? request.headers.get('host');
  if (requestHost) allowed.add(requestHost.split(',')[0]!.trim());
  try {
    // Zur Laufzeit aus der Server-Umgebung (V2-1) — bis 2026-09-26 stand hier
    // `process.env.NEXT_PUBLIC_APP_URL`, beim Bau eingesetzt: Ein Artefakt aus
    // dem CI hätte `localhost:3000` als vertraute Herkunft mitgebracht.
    allowed.add(new URL(laufzeitUrsprung()).host);
  } catch {
    /* Eine ungültige App-URL scheitert an anderer Stelle lauter. */
  }

  if (!originHost || !allowed.has(originHost)) {
    throw new ForbiddenError('Die Anfrage stammt von einer fremden Herkunft und wurde abgelehnt.');
  }
}

async function parseInputs<TBody, TQuery, TParams>(
  request: NextRequest,
  config: BaseConfig<TBody, TQuery, TParams>,
  routeParams: Record<string, string>,
) {
  let body = undefined as TBody;
  if (config.body) {
    let raw: unknown;
    try {
      const text = await request.text();
      raw = text ? JSON.parse(text) : {};
    } catch {
      throw new ValidationError('Der Anfragekörper ist kein gültiges JSON.');
    }
    body = config.body.parse(raw);
  }

  let query = undefined as TQuery;
  if (config.query) {
    const searchParams = Object.fromEntries(request.nextUrl.searchParams.entries());
    query = config.query.parse(searchParams);
  }

  let params = routeParams as TParams;
  if (config.params) {
    params = config.params.parse(routeParams);
  }

  return { body, query, params };
}

/** Geschützter Endpunkt — erfordert eine gültige Session. */
export function defineRoute<TBody = undefined, TQuery = undefined, TParams = Record<string, string>>(
  config: ProtectedConfig<TBody, TQuery, TParams>,
) {
  return async (request: NextRequest, args: NextRouteArgs): Promise<Response> => {
    /**
     * Die Parameter werden **vor** der Hülle aufgelöst, weil die Vorlage des
     * Pfads sie braucht. Ohne sie hiesse die Kennzahlenreihe
     * `/api/jobs/clx123/team` statt `/api/jobs/:id/team` — und dann gäbe es
     * eine Reihe je Einsatz.
     */
    const routeParams = (await args?.params) ?? {};

    return mitBeobachtung(request, routeParams, async () => {
    try {
      assertTrustedOrigin(request);

      const ip = getClientIp(request);
      const session = await getSession();
      if (!session) throw new UnauthorizedError();

      /**
       * Die Gerätesperre steht **vor** Rolle und Berechtigung.
       *
       * Sie ist keine Frage der Rechte — die Person hat sie weiterhin —,
       * sondern eine des Geräts: Es liegt gerade beim Kunden. Deshalb hier,
       * an der einen Stelle, durch die jeder angemeldete Endpunkt läuft.
       * Eine Prüfung in den einzelnen Handlern wäre eine Prüfung, die in
       * dem einen vergessen wird, der sie gebraucht hätte.
       */
      if (session.handoffId && !config.allowDuringHandoff) {
        throw new DeviceHandoffLockedError();
      }

      if (config.roles?.length && !config.roles.includes(session.role)) {
        throw new ForbiddenError('Diese Aktion ist Ihrer Rolle nicht erlaubt.');
      }

      if (config.permissions?.length) {
        const check = config.anyPermission
          ? config.permissions.some((p) => can(session.role, p))
          : config.permissions.every((p) => can(session.role, p));
        if (!check) {
          throw new ForbiddenError(
            `Fehlende Berechtigung: ${config.permissions.join(config.anyPermission ? ' oder ' : ', ')}`,
          );
        }
      }

      if (config.rateLimit) {
        const key = config.rateLimitKey?.({ request, ip, session }) ?? session.id;
        await enforceRateLimit(config.rateLimit, key);
      }

      const { body, query, params } = await parseInputs(request, config, routeParams);

      return await config.handler({ request, body, query, params, session, ip });
    } catch (error) {
      return toErrorResponse(error);
    }
    });
  };
}

/** Öffentlicher Endpunkt — Session optional, aber wenn vorhanden verfügbar. */
export function definePublicRoute<
  TBody = undefined,
  TQuery = undefined,
  TParams = Record<string, string>,
>(config: PublicConfig<TBody, TQuery, TParams>) {
  return async (request: NextRequest, args: NextRouteArgs): Promise<Response> => {
    const routeParams = (await args?.params) ?? {};

    return mitBeobachtung(request, routeParams, async () => {
    try {
      assertTrustedOrigin(request);

      const ip = getClientIp(request);
      /**
       * Während einer Geräteübergabe gilt die Mitarbeitersitzung hier als
       * nicht vorhanden.
       *
       * Öffentliche Endpunkte werden nicht gesperrt — die Signaturwege des
       * Kunden laufen über sie. Sie dürfen die Sitzung der Person, die das
       * Gerät übergeben hat, aber auch nicht *sehen*: Sonst schriebe ein
       * Endpunkt, der „falls angemeldet, dann diese Person" auswertet, dem
       * Kunden die Identität des Personals zu. Der Unterzeichner weist sich
       * allein über die Signatursitzung aus.
       */
      const roh = await getSession();
      const session = roh?.handoffId ? null : roh;

      if (config.rateLimit) {
        const key = config.rateLimitKey?.({ request, ip, session }) ?? ip;
        await enforceRateLimit(config.rateLimit, key);
      }

      const { body, query, params } = await parseInputs(request, config, routeParams);

      return await config.handler({ request, body, query, params, session, ip });
    } catch (error) {
      return toErrorResponse(error);
    }
    });
  };
}

/**
 * Zeichenkettenvergleich in konstanter Zeit.
 *
 * `===` bricht beim ersten abweichenden Byte ab. Wer das Zeitverhalten misst,
 * kann ein Geheimnis daran Zeichen für Zeichen erraten, statt es zu suchen —
 * aus 2^256 Versuchen werden einige hundert. Über das Internet ist das Rauschen
 * meist grösser als das Signal, aber der Scheduler läuft im selben Netz wie
 * die Anwendung, oft sogar auf demselben Wirt.
 *
 * Die Längen werden zuerst über den Hash angeglichen — `timingSafeEqual` wirft
 * bei ungleich langen Puffern, und diese Ausnahme wäre selbst wieder ein
 * Seitenkanal, der die Länge des Geheimnisses verrät.
 */
function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Endpunkt, der ausschliesslich vom Scheduler aufgerufen werden darf.
 * Vercel Cron sendet `Authorization: Bearer $CRON_SECRET`.
 */
type CronGeheimnis = 'CRON_SECRET' | 'SECURITY_REPORT_TOKEN' | 'RELEASE_EXECUTOR_TOKEN';

export function defineCronRoute(config: {
  handler: (request: NextRequest) => Promise<Response> | Response;
  /**
   * Welches Geheimnis das Bearer-Token prüft. Vorgabe `CRON_SECRET`.
   *
   * `SECURITY_REPORT_TOKEN` für den Berichtseingang der Sicherheitszentrale:
   * Ein Überwachungsrechner, der Berichte senden darf, soll damit nicht auch
   * die geplanten Läufe auslösen können — und umgekehrt. Ein gemeinsames
   * Geheimnis hätte beide Rechte an denselben Rechner gebunden.
   */
  secretEnv?: CronGeheimnis | CronGeheimnis[];
}) {
  return async (request: NextRequest): Promise<Response> => {
    /**
     * Auch der Scheduler läuft durch die Beobachtung, und gerade er: Der
     * nächtliche Lauf ist die Anfrage, die am ehesten stillschweigend
     * scheitert — sie hat keinen Benutzer, der sich meldet. Die Kennung in der
     * Antwort ist der einzige Faden zurück ins Protokoll.
     *
     * Parameter gibt es hier keine; die Vorlage ist der Pfad selbst.
     */
    return mitBeobachtung(request, {}, async () => {
    try {
      // Mehrere erlaubte Geheimnisse nur für rein lesende Endpunkte (der
      // Zustand der Läufe für die Überwachung) — jedes wird zeitkonstant
      // verglichen, ein leeres zählt nicht.
      const namen = Array.isArray(config.secretEnv) ? config.secretEnv : [config.secretEnv ?? 'CRON_SECRET'];
      const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
      const passt = namen.some((name) => {
        const secret = process.env[name];
        return Boolean(secret && provided && secretsMatch(provided, secret));
      });
      if (!passt) {
        throw new UnauthorizedError('Ungültiges Cron-Token.');
      }
      return await config.handler(request);
    } catch (error) {
      return toErrorResponse(error);
    }
    });
  };
}

// ---------------------------------------------------------------------------
//  Wiederverwendbare Query-Schemas
// ---------------------------------------------------------------------------

/**
 * Wiederkehrende Query- und Parameter-Schemas.
 *
 * Sie liegen in `lib/validation/queries` und werden hier nur
 * weitergereicht: dieses Modul zieht `server-only` nach sich, das
 * Validierungsmodul nicht — und die OpenAPI-Erzeugung braucht die Schemas
 * ohne Server-Laufzeit.
 */
export {
  paginationQuery,
  searchQuery,
  dateRangeQuery,
  idParam,
} from '@/lib/validation/queries';

export function skipTake(page: number, pageSize: number) {
  return { skip: (page - 1) * pageSize, take: pageSize };
}

/** `sort`/`order` in ein Prisma-`orderBy` übersetzen, mit Whitelist. */
export function orderByFrom(
  sort: string | undefined,
  order: 'asc' | 'desc',
  allowed: string[],
  fallback: string,
): Record<string, 'asc' | 'desc'> {
  const field = sort && allowed.includes(sort) ? sort : fallback;
  return { [field]: order };
}
