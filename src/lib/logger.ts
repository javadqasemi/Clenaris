/**
 * Protokollierung.
 *
 * Architekturentscheide:
 *
 *  • **Struktur statt Fliesstext.** In der Produktion geht je Ereignis eine
 *    Zeile JSON hinaus. Vercel, Datadog und CloudWatch können danach filtern
 *    und aggregieren; eine zusammengesetzte Zeichenkette können sie nur
 *    volltextdurchsuchen. In der Entwicklung bleibt die Ausgabe lesbar — dort
 *    liest ein Mensch mit, keine Suchmaschine.
 *
 *  • **Personendaten werden maskiert.** E-Mail-Adressen, Telefonnummern,
 *    IBAN, AHV-Nummern und Token dürfen nicht im Klartext in einem
 *    Protokoll stehen, das Monate aufbewahrt und von Dritten betrieben wird —
 *    das verlangt das Schweizer DSG ebenso wie die DSGVO. Maskiert bleibt der
 *    Wert wiedererkennbar (`a***@example.ch`), ohne die Person preiszugeben.
 *
 *  • **Ein Schwellenwert statt verstreuter Bedingungen.** `LOG_LEVEL` steuert,
 *    was durchkommt; im Test schweigt der Logger vollständig, damit
 *    Testausgaben lesbar bleiben.
 *
 *  • **Fehler werden nie verschluckt.** `logger.error` gibt Meldung, Stapel
 *    und Ursache aus — aber nur hier, nie an die Kundschaft.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;

export type LogLevel = keyof typeof LEVELS;

function threshold(): number {
  const configured = process.env.LOG_LEVEL as LogLevel | undefined;
  if (configured && configured in LEVELS) return LEVELS[configured];
  if (process.env.NODE_ENV === 'test') return LEVELS.silent;
  return process.env.NODE_ENV === 'production' ? LEVELS.info : LEVELS.debug;
}

// --- Maskierung -------------------------------------------------------------

const EMAIL = /([\w.+-])[\w.+-]*(@[\w.-]+\.\w{2,})/g;
const PHONE = /(\+?\d[\d\s/().-]{7,}\d)/g;
const IBAN = /\b([A-Z]{2}\d{2})[\dA-Z\s]{10,30}\b/g;
const AHV = /\b756\.\d{4}\.\d{4}\.\d{2}\b/g;
/** Lange zufällige Zeichenketten — Token, Schlüssel, Signaturen. */
const TOKEN = /\b[A-Za-z0-9_-]{32,}\b/g;

/** Schlüssel, deren Wert unabhängig vom Inhalt nie im Protokoll erscheint. */
const SECRET_KEYS =
  /^(password|passwort|token|secret|authorization|cookie|apiKey|api_key|signature|refreshToken|accessToken|iban|ahvNumber)$/i;

export function redact(value: string): string {
  return value
    .replace(EMAIL, '$1***$2')
    .replace(AHV, '756.****.****.**')
    .replace(IBAN, '$1 **** **** ****')
    .replace(TOKEN, (match) => `${match.slice(0, 4)}…${match.slice(-2)}`)
    .replace(PHONE, (match) => `${match.slice(0, 4)}*****${match.slice(-2)}`);
}

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[zu tief verschachtelt]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redact(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redact(value.message),
      stack: process.env.NODE_ENV === 'production' ? undefined : value.stack,
      cause: value.cause ? scrub(value.cause, depth + 1) : undefined,
    };
  }

  if (Array.isArray(value)) return value.slice(0, 25).map((item) => scrub(item, depth + 1));

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEYS.test(key) ? '[maskiert]' : scrub(item, depth + 1);
    }
    return out;
  }

  return String(value);
}

// --- Ausgabe ----------------------------------------------------------------

interface LogFields {
  [key: string]: unknown;
}

function emit(level: Exclude<LogLevel, 'silent'>, scope: string, message: string, fields?: LogFields) {
  if (LEVELS[level] < threshold()) return;

  const safeMessage = redact(message);
  const safeFields = fields ? (scrub(fields) as LogFields) : undefined;

  // In der Produktion eine JSON-Zeile je Ereignis; sonst lesbar.
  if (process.env.NODE_ENV === 'production') {
    const line = JSON.stringify({
      level,
      scope,
      message: safeMessage,
      time: new Date().toISOString(),
      ...safeFields,
    });
    // eslint-disable-next-line no-console -- die eine Stelle, die schreiben darf
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
    return;
  }

  const prefix = `[${scope}]`;
  // eslint-disable-next-line no-console -- die eine Stelle, die schreiben darf
  const write = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (safeFields && Object.keys(safeFields).length > 0) write(prefix, safeMessage, safeFields);
  else write(prefix, safeMessage);
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Untergeordneter Bereich, etwa `logger('stripe').child('webhook')`. */
  child(sub: string): Logger;
}

/**
 * Logger für einen Bereich.
 *
 *   const log = logger('stripe');
 *   log.info('Zahlung gebucht', { invoiceId, amount });
 */
export function logger(scope: string): Logger {
  return {
    debug: (message, fields) => emit('debug', scope, message, fields),
    info: (message, fields) => emit('info', scope, message, fields),
    warn: (message, fields) => emit('warn', scope, message, fields),
    error: (message, fields) => emit('error', scope, message, fields),
    child: (sub) => logger(`${scope}/${sub}`),
  };
}
