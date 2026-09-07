import { get, post, type ApiResponse } from './client';
import { cachedJar, forgetJar, rememberJar } from './session-cache';

/**
 * Die Konten aus `prisma/seed.ts`.
 *
 * Sie stehen hier als Klartext, weil sie genau dafür gedacht sind: Demodaten
 * einer lokalen Entwicklungsdatenbank. Diese Datei gehört deshalb nie in die
 * Nähe einer produktiven Umgebung — die Prüfungen laufen gegen `localhost`
 * oder gegen eine eigens dafür aufgesetzte Instanz.
 */
export const ACCOUNTS = {
  super: { email: 'system@clenaris.ch', password: 'System#2026Clenaris', role: 'SUPER_ADMIN' },
  admin: { email: 'admin@clenaris.ch', password: 'Admin#2026Clenaris', role: 'ADMIN' },
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
  if (cached && (await stillValid(cached, role))) return cached;
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

/** Alle fünf Rollen bereitstellen, einmal pro Testdatei. */
export async function loginAll(): Promise<Record<AccountName, string>> {
  const jars = {} as Record<AccountName, string>;
  for (const name of ROLE_ORDER) {
    jars[name] = await loginAs(name);
  }
  return jars;
}
