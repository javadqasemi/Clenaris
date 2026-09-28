import { get, post, type ApiResponse } from './client';
import { resetRateLimits } from './rate-limit';
import { cachedJar, forgetJar, rememberJar } from './session-cache';

/**
 * Die Konten aus `prisma/seed.ts`.
 *
 * Sie stehen hier als Klartext, weil sie genau dafür gedacht sind: Demodaten
 * einer lokalen Entwicklungsdatenbank. Diese Datei gehört deshalb nie in die
 * Nähe einer produktiven Umgebung — die Prüfungen laufen gegen `localhost`
 * oder gegen eine eigens dafür aufgesetzte Instanz.
 *
 * Die beiden Verwaltungskonten lesen dieselben Umgebungsvariablen wie der
 * Seed. Grund: `prisma/seed.ts` setzt ihr Passwort aus
 * `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` und fällt nur ohne diese auf die
 * Demowerte zurück. Wer in seiner `.env` ein eigenes Startpasswort gesetzt
 * hat — was auf einem erreichbaren System richtig ist —, bekam hier sonst
 * vierzehn Fehlschläge mit der Meldung «E-Mail-Adresse oder Passwort ist
 * falsch» und suchte den Fehler im Produkt. In der CI ist nichts gesetzt,
 * dort gelten weiterhin die Demowerte.
 */
const seedValue = (name: string, fallback: string): string => {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
};

export const ACCOUNTS = {
  super: {
    email: seedValue('SEED_SUPERADMIN_EMAIL', 'system@clenaris.ch'),
    password: seedValue('SEED_SUPERADMIN_PASSWORD', 'System#2026Clenaris'),
    role: 'SUPER_ADMIN',
  },
  admin: {
    email: seedValue('SEED_ADMIN_EMAIL', 'admin@clenaris.ch'),
    password: seedValue('SEED_ADMIN_PASSWORD', 'Admin#2026Clenaris'),
    role: 'ADMIN',
  },
  manager: { email: 'manager@clenaris.ch', password: 'Demo#2026Clenaris', role: 'MANAGER' },
  employee: {
    email: 'anna.keller@clenaris.ch',
    password: 'Demo#2026Clenaris',
    role: 'EMPLOYEE',
  },
  customer: { email: 'nicole.wyss@example.ch', password: 'Demo#2026Clenaris', role: 'CUSTOMER' },
} as const;

export type AccountName = keyof typeof ACCOUNTS;

/** Alle Rollen in der Reihenfolge abnehmender Rechte. */
export const ROLE_ORDER: AccountName[] = ['super', 'admin', 'manager', 'employee', 'customer'];

export interface LoginResult extends ApiResponse<{ data: Record<string, unknown> }> {
  jar: string;
}

/** Anmeldung ohne Zwischenspeicher — für alles, was den Vorgang selbst prüft. */
export async function login(email: string, password: string): Promise<LoginResult> {
  const response = await post<{ data: Record<string, unknown> }>('/api/auth/login', {
    email,
    password,
  });
  return { ...response, jar: response.cookies };
}

/**
 * Trägt dieses Cookie noch eine gültige Sitzung der erwarteten Rolle?
 *
 * Die Rolle wird mitgeprüft, nicht nur „angemeldet ja/nein". Eine Prüfung
 * setzt die Rolle der Betriebsleitung zwischenzeitlich herab; das
 * zwischengespeicherte Cookie wäre danach zwar gültig, aber falsch — und der
 * nächste Test suchte den Fehler in der Rechtematrix.
 */
async function stillValid(jar: string, expectedRole: string): Promise<boolean> {
  const response = await get<{ data: { authenticated: boolean; role?: string } }>(
    '/api/auth/session',
    { jar },
  );
  return (
    response.status === 200 &&
    response.payload?.data?.authenticated === true &&
    response.payload.data.role === expectedRole
  );
}

/**
 * Wie lange das Zugangstoken eines Cookies noch gilt, in Sekunden — oder
 * `null`, wenn sich das nicht lesen lässt.
 *
 * Nur die Nutzlast wird gelesen, nicht geprüft; prüfen tut der Server. Es
 * geht allein um `exp`.
 */
function verbleibendeSekunden(jar: string): number | null {
  const token = /clenaris_at=([^;]+)/.exec(jar)?.[1];
  const teil = token?.split('.')[1];
  if (!teil) return null;
  try {
    const nutzlast = JSON.parse(Buffer.from(teil, 'base64url').toString('utf8')) as { exp?: number };
    return typeof nutzlast.exp === 'number' ? nutzlast.exp - Math.floor(Date.now() / 1000) : null;
  } catch {
    return null;
  }
}

/**
 * So viel Restlaufzeit muss ein Cookie am Anfang einer Datei haben.
 *
 * **Der Fehler, den das verhindert.** Das Zugangstoken lebt fünfzehn Minuten;
 * der Sitzungs-Cache überlebt Läufe. Am 2026-09-20 nahm `website-ops.test.ts`
 * ein Cookie an, das noch gut war — und wartete gleich darauf 37 Sekunden auf
 * eine Fenstergrenze des Rate-Limits. In dieser Zeit lief das Token ab; der
 * wiederholte Aufruf und alle folgenden bekamen 401. Fünf Minuten Reserve sind
 * mehr als jede Datei samt Wartezeiten dauert. Erneuert wird durch eine neue
 * Anmeldung, nicht durch `refresh`: Die Rotation des Refresh-Tokens in einem
 * Prozess machte das Cookie eines anderen zur „Wiederverwendung".
 */
const MINDEST_RESTLAUFZEIT_S = 5 * 60;

/**
 * Angemeldet sein — und dafür möglichst keine neue Anmeldung verbrauchen.
 *
 * Die Anmeldung erlaubt acht Versuche je fünf Minuten und Adresse. Das ist für
 * Menschen grosszügig und für einen Testlauf viel zu wenig: Jede Datei läuft in
 * einem eigenen Prozess, und ein voller Lauf käme sonst auf über fünfzig
 * Anmeldungen. Deshalb wird das Cookie wie in einem Browser behalten und nur
 * dann erneuert, wenn es nicht mehr trägt.
 */
export async function loginAs(account: AccountName): Promise<string> {
  const { email, password, role } = ACCOUNTS[account];

  const cached = cachedJar(account);
  const frisch = cached ? (verbleibendeSekunden(cached) ?? 0) >= MINDEST_RESTLAUFZEIT_S : false;
  if (cached && frisch && (await stillValid(cached, role))) return cached;
  if (cached) forgetJar(account);

  const result = await login(email, password);

  if (result.status !== 200) {
    throw new Error(
      `Anmeldung als ${account} (${email}) fehlgeschlagen: HTTP ${result.status}. ` +
        (result.status === 429
          ? 'Das Anmeldelimit greift — warten Sie fünf Minuten.'
          : 'Ist die Datenbank mit `npm run db:seed` befüllt?'),
    );
  }
  if (result.payload?.data?.twoFactorRequired) {
    throw new Error(
      `Für ${email} ist eine Zwei-Faktor-Anmeldung eingeschaltet. ` +
        'Die Prüfkonten müssen ohne zweiten Faktor auskommen — setzen Sie ihn zurück.',
    );
  }

  rememberJar(account, result.jar);
  return result.jar;
}

/**
 * Alle fünf Rollen bereitstellen, einmal pro Testdatei.
 *
 * Vorher werden die Rate-Limit-Zähler des Testservers geleert (siehe
 * `helpers/rate-limit.ts`): Jede Datei beginnt mit vollem Kontingent, so wie
 * ein einzelner Benutzer es hätte — statt das Kontingent zu erben, das die
 * vorherigen Dateien unter demselben Konto verbraucht haben.
 */
export async function loginAll(): Promise<Record<AccountName, string>> {
  resetRateLimits();
  const jars = {} as Record<AccountName, string>;
  for (const name of ROLE_ORDER) {
    jars[name] = await loginAs(name);
  }
  return jars;
}
