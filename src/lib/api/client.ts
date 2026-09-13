'use client';

/**
 * Typisierter API-Client für das Frontend.
 *
 * Architekturentscheid: Ein schlanker `fetch`-Wrapper statt einer weiteren
 * Abhängigkeit. Er packt den `{ data, meta }`-Umschlag aus, wirft bei Fehlern
 * einen `ApiError` mit Statuscode und Felddetails, und React Query kümmert
 * sich um Caching und Wiederholungen.
 */

export interface ApiFieldError {
  field: string;
  message: string;
  code?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors: ApiFieldError[];

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fieldErrors = Array.isArray(details) ? (details as ApiFieldError[]) : [];
  }

  /** Fehlermeldung für ein bestimmtes Formularfeld. */
  fieldError(field: string): string | undefined {
    return this.fieldErrors.find((error) => error.field === field)?.message;
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Query-Parameter; leere Werte werden ausgelassen. */
  params?: Record<string, unknown>;
}

/**
 * Stille Sitzungserneuerung bei einem 401.
 *
 * Der Zugangstoken lebt fünfzehn Minuten. Läuft er ab, während eine Seite
 * offen ist, antwortet der nächste Aufruf mit 401 — und bis hierher hiess
 * das: Fehlermeldung, dann Anmeldemaske, mitten in der Arbeit. Jetzt wird
 * einmal erneuert und der Aufruf wiederholt. Mehrere gleichzeitige 401er
 * teilen sich eine Erneuerung (`refreshing`): sonst rotierten sie den
 * Refresh-Token um die Wette, und die zweite Rotation gälte als
 * Wiederverwendung — genau der Fall, der die ganze Sitzung sperrt.
 *
 * Endpunkte unter `/api/auth/` sind ausgenommen: Ein 401 bei der Anmeldung
 * ist eine Antwort, kein abgelaufenes Token.
 */
let refreshing: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

function isAuthEndpoint(path: string): boolean {
  return path.startsWith('/api/auth/');
}

/** Zur Anmeldung, mit dem aktuellen Ort als Rücksprungziel. */
function goToLogin(): void {
  const here = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/auth/anmelden?weiter=${encodeURIComponent(here)}&grund=abgelaufen`);
}

async function request<T>(path: string, options: RequestOptions = {}, retried = false): Promise<T> {
  const { body, params, headers, ...rest } = options;

  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, String(v)));
      else url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString(), {
    ...rest,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });

  if (response.status === 401 && !retried && !isAuthEndpoint(path)) {
    if (await tryRefresh()) return request<T>(path, options, true);
    goToLogin();
  }

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    if (!response.ok) {
      throw new ApiError(response.status, 'INTERNAL_ERROR', 'Unerwartete Antwort vom Server.');
    }
    return (await response.blob()) as T;
  }

  const payload = (await response.json()) as {
    data?: T;
    meta?: unknown;
    error?: { code: string; message: string; details?: unknown };
  };

  if (!response.ok || payload.error) {
    throw new ApiError(
      response.status,
      payload.error?.code ?? 'INTERNAL_ERROR',
      payload.error?.message ?? 'Es ist ein Fehler aufgetreten.',
      payload.error?.details,
    );
  }

  return payload.data as T;
}

/** Wie `request`, gibt aber zusätzlich `meta` (Paginierung) zurück. */
async function requestWithMeta<T, M = unknown>(
  path: string,
  options: RequestOptions = {},
  retried = false,
): Promise<{ data: T; meta: M }> {
  const { body, params, headers, ...rest } = options;

  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, String(v)));
      else url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString(), {
    ...rest,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });

  if (response.status === 401 && !retried && !isAuthEndpoint(path)) {
    if (await tryRefresh()) return requestWithMeta<T, M>(path, options, true);
    goToLogin();
  }

  const payload = (await response.json()) as {
    data?: T;
    meta?: M;
    error?: { code: string; message: string; details?: unknown };
  };

  if (!response.ok || payload.error) {
    throw new ApiError(
      response.status,
      payload.error?.code ?? 'INTERNAL_ERROR',
      payload.error?.message ?? 'Es ist ein Fehler aufgetreten.',
      payload.error?.details,
    );
  }

  return { data: payload.data as T, meta: payload.meta as M };
}

export const api = {
  get: <T>(path: string, params?: Record<string, unknown>) =>
    request<T>(path, { method: 'GET', params }),

  list: <T, M = PaginationMeta>(path: string, params?: Record<string, unknown>) =>
    requestWithMeta<T, M>(path, { method: 'GET', params }),

  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),

  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),

  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),

  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),

  /** Datei herunterladen und im Browser speichern. */
  async download(path: string, filename?: string, params?: Record<string, unknown>) {
    const url = new URL(path, window.location.origin);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const response = await fetch(url.toString(), { credentials: 'same-origin' });
    if (!response.ok) {
      throw new ApiError(response.status, 'INTERNAL_ERROR', 'Der Download ist fehlgeschlagen.');
    }

    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition');
    const suggested = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];

    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename ?? (suggested ? decodeURIComponent(suggested) : 'download');
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  },
};

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

/** Zentrale Query-Keys — verhindert Tippfehler bei der Invalidierung. */
export const queryKeys = {
  bookings: (filters?: unknown) => ['bookings', filters] as const,
  booking: (id: string) => ['bookings', id] as const,
  jobs: (filters?: unknown) => ['jobs', filters] as const,
  job: (id: string) => ['jobs', id] as const,
  calendar: (range: unknown) => ['jobs', 'calendar', range] as const,
  customers: (filters?: unknown) => ['customers', filters] as const,
  customer: (id: string) => ['customers', id] as const,
  leads: (filters?: unknown) => ['leads', filters] as const,
  pipeline: () => ['leads', 'pipeline'] as const,
  quotes: (filters?: unknown) => ['quotes', filters] as const,
  quote: (id: string) => ['quotes', id] as const,
  invoices: (filters?: unknown) => ['invoices', filters] as const,
  invoice: (id: string) => ['invoices', id] as const,
  employees: (filters?: unknown) => ['employees', filters] as const,
  employee: (id: string) => ['employees', id] as const,
  dashboard: (range: string) => ['dashboard', range] as const,
  reports: (type: string, params?: unknown) => ['reports', type, params] as const,
  notifications: () => ['notifications'] as const,
  availability: (params: unknown) => ['availability', params] as const,
  estimate: (params: unknown) => ['estimate', params] as const,
  services: () => ['services'] as const,
  tasks: (filters?: unknown) => ['tasks', filters] as const,
  schedule: (params: unknown) => ['schedule', params] as const,
  threads: (status?: string) => ['messages', status] as const,
  thread: (id: string) => ['messages', 'thread', id] as const,
  reviews: () => ['reviews'] as const,
};
