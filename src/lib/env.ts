import { z } from 'zod';

/**
 * Zentrale, typsichere Konfiguration.
 *
 * Architekturentscheid: Wir validieren Umgebungsvariablen beim ersten Zugriff
 * und nicht beim Modul-Import. Next.js lädt Module auch während des Builds und
 * beim Erzeugen statischer Seiten — ein harter Import-Time-Throw würde den Build
 * auf Vercel brechen, obwohl zur Laufzeit alle Secrets vorhanden sind.
 *
 * Client-seitig sind nur `NEXT_PUBLIC_*`-Werte sichtbar; `serverEnv` darf
 * ausschliesslich in Server Components, Route Handlers und Server Actions
 * verwendet werden.
 */

const serverSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url().optional(),

  REDIS_URL: z.string().optional(),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET muss mindestens 32 Zeichen lang sein'),
  JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL: z.coerce.number().int().positive().default(2_592_000),
  AUTH_COOKIE_DOMAIN: z.string().optional(),

  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default('clenaris'),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  TWINT_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  RESEND_API_KEY: z.string().optional(),
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

  COMPANY_NAME: z.string().default('Clenaris Reinigungen GmbH'),
  COMPANY_EMAIL: z.string().default('info@clenaris.ch'),
  COMPANY_PHONE: z.string().default('+41 31 000 00 00'),
});

const clientSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),
  NEXT_PUBLIC_APP_NAME: z.string().default('Clenaris'),
  NEXT_PUBLIC_DEFAULT_LOCALE: z.enum(['de', 'en', 'fr', 'it']).default('de'),
  NEXT_PUBLIC_SUPABASE_URL: z.string().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: z.string().optional(),
  NEXT_PUBLIC_GA_MEASUREMENT_ID: z.string().optional(),
  NEXT_PUBLIC_GTM_ID: z.string().optional(),
  NEXT_PUBLIC_FACEBOOK_PIXEL_ID: z.string().optional(),
  NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION: z.string().optional(),
});

export type ServerEnv = z.infer<typeof serverSchema>;
export type ClientEnv = z.infer<typeof clientSchema>;

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

/**
 * Client-Konfiguration. Next.js ersetzt `process.env.NEXT_PUBLIC_*` zur Build-Zeit
 * statisch — deshalb müssen die Keys hier ausgeschrieben stehen.
 */
export const clientEnv: ClientEnv = clientSchema.parse({
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
  NEXT_PUBLIC_DEFAULT_LOCALE: process.env.NEXT_PUBLIC_DEFAULT_LOCALE,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
  NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY,
  NEXT_PUBLIC_GA_MEASUREMENT_ID: process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID,
  NEXT_PUBLIC_GTM_ID: process.env.NEXT_PUBLIC_GTM_ID,
  NEXT_PUBLIC_FACEBOOK_PIXEL_ID: process.env.NEXT_PUBLIC_FACEBOOK_PIXEL_ID,
  NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION: process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION,
});

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
      return Boolean(
        process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
      );
    case 'redis':
      return Boolean(process.env.REDIS_URL);
    case 'maps':
      return Boolean(process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY);
    case 'ai':
      return Boolean(process.env.ANTHROPIC_API_KEY);
    default:
      return false;
  }
}
