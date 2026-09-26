import { z } from 'zod';

import { mapsBrowserSchluessel, supabaseAdresse } from '@/lib/laufzeit-konfiguration';

/**
 * Zentrale, typsichere Konfiguration.
 *
 * Architekturentscheid: Wir validieren Umgebungsvariablen beim ersten Zugriff
 * und nicht beim Modul-Import. Next.js lädt Module auch während des Builds und
 * beim Erzeugen statischer Seiten — ein harter Import-Time-Throw würde den Build
 * auf Vercel brechen, obwohl zur Laufzeit alle Secrets vorhanden sind.
 *
 * `serverEnv` darf ausschliesslich in Server Components, Route Handlers und
 * Server Actions verwendet werden. Was je Umgebung verschieden ist und die
 * Browser sehen dürfen, steht in `laufzeit-konfiguration.ts`.
 */

const serverSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url().optional(),

  REDIS_URL: z.string().optional(),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET muss mindestens 32 Zeichen lang sein'),
  JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL: z.coerce.number().int().positive().default(2_592_000),
  /**
   * Wie lange eine Sitzung ohne Aktivität lebt. Der Refresh-Token darf nur
   * erneuert werden, solange seine letzte Erneuerung innerhalb dieses Fensters
   * liegt; der Browser meldet sich nach derselben Frist von selbst ab.
   * `JWT_REFRESH_TTL` bleibt die absolute Obergrenze.
   */
  SESSION_IDLE_TTL: z.coerce.number().int().positive().default(900),
  AUTH_COOKIE_DOMAIN: z.string().optional(),

  /**
   * Schlüssel für die Feldverschlüsselung (`src/lib/crypto.ts`): 32 Byte als
   * 64 Hex-Zeichen. Fehlt er, leitet das Modul den Schlüssel aus `JWT_SECRET`
   * ab — die Anwendung läuft also auch ohne, aber dann hängen die
   * verschlüsselten Felder an einem Schlüssel, der einem anderen Zweck dient.
   * Die Begründung steht im Kopf von `crypto.ts`.
   */
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY muss 64 Hex-Zeichen (32 Byte) lang sein')
    .optional(),

  /**
   * Welchem Proxy-Kopf die Client-Adresse entnommen wird (`lib/http/client-ip.ts`).
   * `NONE`: keinem — die Adresse ist dann nicht verfügbar. Das ist die
   * sichere Vorgabe; ein falsch gesetzter Modus liesse gefälschte Adressen
   * ins Prüf- und Signaturprotokoll.
   */
  TRUSTED_PROXY_MODE: z.enum(['NONE', 'SINGLE_REVERSE_PROXY', 'CLOUDFLARE']).default('NONE'),

  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default('clenaris'),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  TWINT_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  RESEND_API_KEY: z.string().optional(),
  /**
   * Signaturgeheimnis der Resend-Webhooks (`whsec_…`, Svix). Ohne es nimmt
   * `/api/webhooks/resend` keine Zustellmeldungen an (503) — eine ungeprüfte
   * Meldung könnte jede Zustellung als „zugestellt" markieren.
   */
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  EMAIL_FROM: z.string().default('Clenaris <noreply@clenaris.ch>'),
  EMAIL_REPLY_TO: z.string().optional(),
  EMAIL_BCC_ARCHIVE: z.string().optional(),

  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),

  GOOGLE_MAPS_SERVER_KEY: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-opus-5'),
  AI_MODEL_FAST: z.string().default('claude-haiku-4-5'),

  CRON_SECRET: z.string().optional(),
  /**
   * Token für den Berichtseingang der Sicherheitszentrale
   * (`POST /api/cron/security-report`). Eigenes Geheimnis, nicht
   * `CRON_SECRET` (siehe `defineCronRoute`). Ohne Wert nimmt der Eingang
   * nichts an.
   */
  SECURITY_REPORT_TOKEN: z.string().optional(),

  /**
   * Herkunft dieser Instanz (`https://clenaris.qasemi.ch`) — zur Laufzeit,
   * für Links, Mails, Zahlungsrücksprünge und die Herkunftsprüfung. Geprüft
   * und gelesen in `laufzeit-konfiguration.ts` (`ursprungAus`), dort mit
   * Rückfall auf das ältere `NEXT_PUBLIC_APP_URL`.
   */
  APP_URL: z.string().optional(),

  COMPANY_NAME: z.string().default('Clenaris Reinigungen GmbH'),
  COMPANY_EMAIL: z.string().default('info@clenaris.ch'),
  COMPANY_PHONE: z.string().default('+41 31 000 00 00'),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cachedServerEnv: ServerEnv | null = null;

/** Server-Konfiguration. Wirft nur, wenn tatsächlich zur Laufzeit benötigt. */
export function serverEnv(): ServerEnv {
  if (cachedServerEnv) return cachedServerEnv;

  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Ungültige Server-Umgebungsvariablen:\n${issues}`);
  }
  cachedServerEnv = parsed.data;
  return cachedServerEnv;
}

/*
 * Hier stand bis 2026-09-26 `clientEnv`: jede `NEXT_PUBLIC_*`-Variable als
 * `process.env.NEXT_PUBLIC_…` ausgeschrieben — und damit beim Bau fest
 * eingesetzt, in Client- *und* Server-Bündeln. Ersetzt durch
 * `laufzeit-konfiguration.ts` (zur Laufzeit, mit Freigabeliste für den
 * Browser) und `seiten-url.ts` (bewusst Bauzeit, mit Begründung). Vier
 * Variablen hatten keinen Verbraucher und sind entfallen:
 * `NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_DEFAULT_LOCALE`,
 * `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
 */

export const isProduction = process.env.NODE_ENV === 'production';
export const isDevelopment = process.env.NODE_ENV === 'development';

/** Prüft, ob ein optionaler Integrationsdienst konfiguriert ist. */
export function hasIntegration(
  name: 'stripe' | 'resend' | 'twilio' | 'supabase' | 'redis' | 'maps' | 'ai',
): boolean {
  switch (name) {
    case 'stripe':
      return Boolean(process.env.STRIPE_SECRET_KEY);
    case 'resend':
      return Boolean(process.env.RESEND_API_KEY);
    case 'twilio':
      return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
    case 'supabase':
      // Zur Laufzeit gelesen (V2-1) — `process.env.NEXT_PUBLIC_…` würde beim Bau eingesetzt.
      return Boolean(supabaseAdresse() && process.env.SUPABASE_SERVICE_ROLE_KEY);
    case 'redis':
      return Boolean(process.env.REDIS_URL);
    case 'maps':
      return Boolean(mapsBrowserSchluessel());
    case 'ai':
      return Boolean(process.env.ANTHROPIC_API_KEY);
    default:
      return false;
  }
}
