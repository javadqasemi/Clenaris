/**
 * Fehler-Taxonomie der Applikation.
 *
 * Architekturentscheid: Services werfen typisierte Fehler, der HTTP-Layer
 * (`lib/api/handler.ts`) übersetzt sie genau einmal in Statuscodes und
 * RFC-7807-ähnliche JSON-Antworten. So bleibt Geschäftslogik frei von
 * HTTP-Details und ist in Cron-Jobs und Server Actions wiederverwendbar.
 */

export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PAYMENT_REQUIRED'
  | 'PAYMENT_FAILED'
  | 'INTEGRATION_ERROR'
  /** Ein Dienst ist nicht eingerichtet — vom Ausfall zu unterscheiden. */
  | 'NOT_CONFIGURED'
  | 'BUSINESS_RULE'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  /** true = darf dem Endnutzer unverändert gezeigt werden. */
  readonly expose: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    status: number,
    options: { details?: unknown; expose?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = options.details;
    this.expose = options.expose ?? true;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Bitte melden Sie sich an.') {
    super('UNAUTHORIZED', message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Für diese Aktion fehlen Ihnen die Berechtigungen.') {
    super('FORBIDDEN', message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Ressource') {
    super('NOT_FOUND', `${resource} wurde nicht gefunden.`, 404);
  }
}

/**
 * Die Eingabe ist fehlerhaft — falscher Typ, fehlendes Pflichtfeld, zu lang.
 *
 * 400 und nicht 422: 422 bleibt `BusinessRuleError` vorbehalten, wo die
 * Eingabe wohlgeformt ist und nur der Zustand die Aktion verhindert. Teilten
 * sich beide denselben Status, liesse sich am Statuscode nicht mehr ablesen,
 * ob eine Wiederholung mit denselben Daten je Sinn ergeben kann.
 */
export class ValidationError extends AppError {
  constructor(message = 'Die Eingaben sind ungültig.', details?: unknown) {
    super('VALIDATION_ERROR', message, 400, { details });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super('CONFLICT', message, 409, { details });
  }
}

export class RateLimitError extends AppError {
  readonly retryAfter: number;
  constructor(retryAfter: number, message = 'Zu viele Anfragen. Bitte später erneut versuchen.') {
    super('RATE_LIMITED', message, 429, { details: { retryAfter } });
    this.retryAfter = retryAfter;
  }
}

export class PaymentError extends AppError {
  constructor(message: string, details?: unknown) {
    super('PAYMENT_FAILED', message, 402, { details });
  }
}

/** Fehler eines externen Dienstes (Stripe, Resend, Twilio, Google Maps). */
export class IntegrationError extends AppError {
  readonly provider: string;
  constructor(provider: string, message: string, cause?: unknown) {
    super('INTEGRATION_ERROR', `${provider}: ${message}`, 502, { cause, expose: false });
    this.provider = provider;
  }
}

/**
 * Ein Dienst ist gar nicht eingerichtet — kein Ausfall, sondern eine Lücke in
 * der Konfiguration.
 *
 * **Warum das nicht dasselbe ist wie ein `IntegrationError`.** Dessen Wortlaut
 * wird bewusst verschluckt (`expose: false`) und durch „Ein externer Dienst ist
 * derzeit nicht erreichbar. Bitte später erneut versuchen." ersetzt — richtig
 * bei einem Ausfall, denn Anbieterfehler gehören nicht ins Fenster der
 * Kundschaft, und später erneut versuchen hilft tatsächlich.
 *
 * Bei einer fehlenden Konfiguration ist beides falsch. Der Dienst ist nicht
 * „derzeit" weg, sondern nie da gewesen; späteres Erneutversuchen hilft nie.
 * Genau daran ist beim Profilbild eine halbe Stunde Fehlersuche
 * verlorengegangen: Die Meldung legte einen vorübergehenden Netzfehler nahe,
 * während in Wahrheit zwei Umgebungsvariablen fehlten.
 *
 * Deshalb 503 statt 502 (der Dienst ist nicht verfügbar, nicht das
 * dahinterliegende System fehlerhaft) und `expose: true` — der Wortlaut nennt
 * die fehlenden Variablen. Das ist keine Preisgabe eines Geheimnisses: Die
 * *Namen* der Variablen stehen in `.env.example` und in der Dokumentation, die
 * Werte niemals hier.
 */
export class ConfigurationError extends AppError {
  readonly provider: string;

  constructor(provider: string, message: string) {
    super('NOT_CONFIGURED', message, 503, { expose: true });
    this.provider = provider;
  }
}

/** Verletzung einer fachlichen Regel — z. B. Storno nach Frist. */
/**
 * Die Anfrage ist wohlgeformt, verstösst aber gegen eine fachliche Regel —
 * etwa eine bereits ausgestellte Rechnung ändern zu wollen.
 *
 * 422 statt 400: `VALIDATION_ERROR` belegt bereits 400. Teilten sich beide
 * denselben Status, liesse sich am Statuscode allein nicht mehr unterscheiden,
 * ob die Eingabe falsch war oder der Vorgang im aktuellen Zustand unmöglich
 * ist — und genau das entscheidet, ob eine Wiederholung Sinn hat.
 */
export class BusinessRuleError extends AppError {
  constructor(message: string, details?: unknown) {
    super('BUSINESS_RULE', message, 422, { details });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Sichere Fehlermeldung für Endnutzer — verschluckt interne Details. */
export function publicMessage(error: unknown): string {
  if (isAppError(error) && error.expose) return error.message;
  return 'Es ist ein unerwarteter Fehler aufgetreten. Bitte versuchen Sie es erneut.';
}
