import type { NextRequest } from 'next/server';
import type { ZodType, ZodTypeDef } from 'zod';
import type { UserRole } from '@prisma/client';

import { getSession, type SessionUser } from '@/lib/auth/session';
import { can, type Permission } from '@/lib/auth/rbac';
import { ForbiddenError, UnauthorizedError, ValidationError } from '@/lib/errors';
import { enforceRateLimit, getClientIp, type RateLimitName } from '@/lib/rate-limit';
import { toErrorResponse } from './response';

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
 * Erlaubt sind der Host der Anfrage selbst und der Host aus
 * `NEXT_PUBLIC_APP_URL` — letzterer, falls die Anwendung hinter einem Proxy
 * unter einem anderen Namen antwortet, als der Browser sie aufgerufen hat.
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
  const requestHost = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (requestHost) allowed.add(requestHost.split(',')[0]!.trim());
  try {
    if (process.env.NEXT_PUBLIC_APP_URL) allowed.add(new URL(process.env.NEXT_PUBLIC_APP_URL).host);
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
    try {
      assertTrustedOrigin(request);

      const ip = getClientIp(request);
      const session = await getSession();
      if (!session) throw new UnauthorizedError();

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

      const routeParams = (await args?.params) ?? {};
      const { body, query, params } = await parseInputs(request, config, routeParams);

      return await config.handler({ request, body, query, params, session, ip });
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

/** Öffentlicher Endpunkt — Session optional, aber wenn vorhanden verfügbar. */
export function definePublicRoute<
  TBody = undefined,
  TQuery = undefined,
  TParams = Record<string, string>,
>(config: PublicConfig<TBody, TQuery, TParams>) {
  return async (request: NextRequest, args: NextRouteArgs): Promise<Response> => {
    try {
      assertTrustedOrigin(request);

      const ip = getClientIp(request);
      const session = await getSession();

      if (config.rateLimit) {
        const key = config.rateLimitKey?.({ request, ip, session }) ?? ip;
        await enforceRateLimit(config.rateLimit, key);
      }

      const routeParams = (await args?.params) ?? {};
      const { body, query, params } = await parseInputs(request, config, routeParams);

      return await config.handler({ request, body, query, params, session, ip });
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

/**
 * Endpunkt, der ausschliesslich vom Scheduler aufgerufen werden darf.
 * Vercel Cron sendet `Authorization: Bearer $CRON_SECRET`.
 */
export function defineCronRoute(config: {
  handler: (request: NextRequest) => Promise<Response> | Response;
}) {
  return async (request: NextRequest): Promise<Response> => {
    try {
      const secret = process.env.CRON_SECRET;
      const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
      if (!secret || provided !== secret) {
        throw new UnauthorizedError('Ungültiges Cron-Token.');
      }
      return await config.handler(request);
    } catch (error) {
      return toErrorResponse(error);
    }
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
