import 'server-only';

import { cookies, headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { cache as reactCache } from 'react';
import type { UserRole } from '@prisma/client';

import { prisma } from '@/lib/db';
import { serverEnv } from '@/lib/env';
import { clientIpFromHeaders } from '@/lib/http/client-ip';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  cookieOptions,
  hashToken,
  randomToken,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from './jwt';
import { can, type Permission } from './rbac';
import { DeviceHandoffLockedError, ForbiddenError, UnauthorizedError } from '@/lib/errors';

export interface SessionUser {
  id: string;
  organizationId: string;
  email: string;
  firstName: string;
  lastName: string;
  name: string;
  role: UserRole;
  avatarUrl: string | null;
  locale: string;
  /** Farbschema aus dem Konto — Vorgabe für Geräte ohne eigene Wahl. */
  theme: string | null;
  /** Customer-ID bzw. Employee-ID der Person, falls vorhanden. */
  profileId: string | null;
  /**
   * Läuft auf diesem Gerät gerade eine Geräteübergabe (Gate 4D)? Dann steht
   * hier deren Kennung, und die Sitzung ist für alles gesperrt, was nicht
   * ausdrücklich während einer Übergabe erlaubt ist.
   */
  handoffId: string | null;
}

/**
 * Aktuelle Session lesen.
 *
 * `React.cache` dedupliziert den Aufruf innerhalb eines Requests: Layout,
 * Page und mehrere Server Components teilen sich eine einzige Auswertung.
 *
 * Die eine Datenbankabfrage hier prüft, ob das Token nach dem letzten Widerruf
 * ausgestellt wurde — siehe `revokeAllSessions`. Sie kostet einen Zugriff über
 * den Primärschlüssel pro angemeldetem Request und entfällt für alle nicht
 * angemeldeten: ohne Cookie kehrt die Funktion schon vorher zurück, die
 * öffentliche Website rührt sie also nicht an.
 *
 * Ein Zwischenspeicher wäre verlockend und wurde verworfen: Redis ist in
 * diesem Projekt optional und fällt sonst auf einen prozesslokalen Speicher
 * zurück. Eine zweite Instanz sähe den Widerruf dann bis zum Ablauf der
 * Zwischenspeicherung nicht — bei einer Sperre ist das die eine Minute, die
 * nicht passieren darf.
 */
export const getSession = reactCache(async (): Promise<SessionUser | null> => {
  const store = await cookies();
  const token = store.get(ACCESS_COOKIE)?.value;
  if (!token) return null;

  const claims = await verifyAccessToken(token);
  if (!claims) return null;

  const [widerrufen, handoffId] = await Promise.all([
    tokenWasRevoked(claims.sub, claims.iat),
    aktiveUebergabe(claims.lck),
  ]);
  if (widerrufen) return null;

  return {
    id: claims.sub,
    organizationId: claims.org,
    email: claims.email,
    firstName: claims.name.split(' ')[0] ?? '',
    lastName: claims.name.split(' ').slice(1).join(' '),
    name: claims.name,
    role: claims.role,
    avatarUrl: (claims.avatar as string | undefined) ?? null,
    locale: (claims.locale as string | undefined) ?? 'de',
    theme: (claims.thm as string | undefined) ?? null,
    profileId: claims.pid ?? null,
    handoffId,
  };
});

/**
 * Läuft für diesen Browser eine Geräteübergabe? — die verbindliche Antwort.
 *
 * **Warum das Token allein nicht genügt.** Der Anspruch `lck` wird beim
 * Ausstellen eingeprägt, und das Zugangstoken lebt fünfzehn Minuten. Ein
 * Token, das *vor* der Übergabe ausgestellt wurde, trägt ihn also nicht —
 * und wer eine Kopie davon behalten hat, käme damit an der Sperre vorbei,
 * genau so lange, wie das Gerät in fremder Hand ist. Für eine
 * Kontosperrung nimmt dieses Projekt ein solches Fenster bewusst in Kauf
 * (siehe `tokenWasRevoked`); hier nicht: Dort ist der Angreifer irgendwo im
 * Netz, hier hält er das Gerät.
 *
 * Deshalb entscheidet die Datenbank. Die Abfrage läuft **parallel** zur
 * ohnehin nötigen Widerrufsprüfung, trifft einen Teilindex und kostet damit
 * keine zusätzliche Wartezeit, sondern nur eine zweite Zeile im selben
 * Rundgang. Ein Zwischenspeicher kam aus demselben Grund nicht in Frage wie
 * dort: PM2 läuft im Cluster, und eine Sperre, die der nächste Worker nicht
 * sieht, ist keine.
 *
 * Trägt das Token die Sperre bereits, wird sie geglaubt — falsch liegen
 * kann sie nur in die sichere Richtung, und der Weg zurück führt ohnehin
 * über das Entsperren, das die Zeile anfasst.
 */
async function aktiveUebergabe(claim: string | undefined): Promise<string | null> {
  if (claim) return claim;

  const family = await currentSessionFamily();
  if (!family) return null;

  const offen = await prisma.deviceHandoffSession.findFirst({
    where: { sessionFamily: family, status: 'ACTIVE' },
    select: { id: true },
  });
  return offen?.id ?? null;
}

/**
 * Session inkl. frischer DB-Prüfung. Für sicherheitskritische Operationen
 * (Zahlungen, Rollenänderungen), wo ein gesperrter Account sofort wirken muss.
 */
export async function getVerifiedSession(): Promise<SessionUser | null> {
  const session = await getSession();
  if (!session) return null;

  const user = await prisma.user.findFirst({
    where: { id: session.id, status: 'ACTIVE', deletedAt: null },
    select: { id: true, role: true, organizationId: true },
  });
  if (!user) return null;

  // Rolle könnte seit Ausstellung des Tokens geändert worden sein.
  return { ...session, role: user.role, organizationId: user.organizationId };
}

/**
 * Wurde dieses Zugangstoken vor dem letzten Widerruf ausgestellt?
 *
 * Der Vergleich läuft auf Sekunden, weil `iat` im JWT nur Sekunden kennt und
 * abgerundet wird. Verglichen wird deshalb streng kleiner: Ein Token, das in
 * derselben Sekunde wie der Widerruf ausgestellt wurde, überlebt. Das ist
 * gewollt — beim Passwortwechsel wird zuerst widerrufen und unmittelbar
 * danach eine neue Sitzung ausgestellt, und die soll nicht sich selbst
 * aussperren. Der Preis ist ein Fenster von unter einer Sekunde.
 *
 * Fehlt `iat`, gilt das Token als widerrufen, sobald es je einen Widerruf gab.
 * Ein Token ohne Ausstellungszeitpunkt lässt sich nicht einordnen, und im
 * Zweifel schliesst diese Prüfung.
 */
async function tokenWasRevoked(userId: string, issuedAt: number | undefined): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { sessionsRevokedAt: true },
  });

  // Konto gelöscht oder nie existent: das Token gehört zu niemandem mehr.
  if (!user) return true;
  if (!user.sessionsRevokedAt) return false;
  if (issuedAt === undefined) return true;

  return issuedAt < Math.floor(user.sessionsRevokedAt.getTime() / 1000);
}

/**
 * Die Rotationsfamilie des aktuellen Browsers — oder `null`.
 *
 * Sie benennt genau einen Browser und überlebt jede Token-Rotation; damit
 * ist sie der richtige Anker für eine Gerätesperre. Der Refresh-Token liegt
 * unter Pfad `/`, geht also bei jedem Aufruf mit; gelesen wird aus ihm nur
 * die Familie, und die ist kein Geheimnis: Sie eröffnet keinen Zugriff, der
 * Token selbst liegt allein als Hash in der Datenbank.
 */
export async function currentSessionFamily(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(REFRESH_COOKIE)?.value;
  if (!token) return null;
  const claims = await verifyRefreshToken(token);
  return claims?.fam ?? null;
}

/**
 * Sitzung mit Sperrprüfung — der Weg für alles, was dem Personal gehört.
 *
 * Während eine Geräteübergabe läuft, hält jemand anderes dieses Gerät. Die
 * Sitzung bleibt bestehen (kein Abmelden, siehe `device-handoff.service.ts`),
 * aber sie trägt nichts mehr: Jede Seite und jeder Endpunkt, der hierher
 * kommt, endet mit 423. Freigegeben wird sie erst, wenn die Person am Gerät
 * ihr Passwort bestätigt.
 */
export async function requireSession(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  if (session.handoffId) throw new DeviceHandoffLockedError();
  return session;
}

/**
 * Sitzung **ohne** Sperrprüfung — ausschliesslich für die wenigen Stellen,
 * die während einer Übergabe arbeiten müssen: die Entsperrmaske und der
 * Endpunkt, der sie bedient. Sonst nirgends.
 */
export async function requireSessionDespiteHandoff(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  return session;
}

export async function requireRole(...roles: UserRole[]): Promise<SessionUser> {
  const session = await requireSession();
  if (!roles.includes(session.role)) {
    throw new ForbiddenError(`Rolle ${session.role} ist für diese Aktion nicht berechtigt.`);
  }
  return session;
}

export async function requirePermission(...permissions: Permission[]): Promise<SessionUser> {
  const session = await requireSession();
  const missing = permissions.filter((p) => !can(session.role, p));
  if (missing.length > 0) {
    throw new ForbiddenError(`Fehlende Berechtigung: ${missing.join(', ')}`);
  }
  return session;
}

/**
 * Seitenschutz für Server Components.
 *
 * Unterschied zu `requirePermission`: fehlt die Berechtigung, endet die Seite
 * mit 404 statt mit einem Fehler.
 *
 * Zwei Gründe. Erstens landet ein geworfener Fehler in der Fehlergrenze des
 * Bereichs — die Person sähe „Da ist etwas schiefgelaufen", obwohl nichts
 * schiefgegangen ist. Zweitens verrät ein 403 die *Existenz* der Seite: wer
 * sie nicht benutzen darf, muss auch nicht wissen, dass es sie gibt. In der
 * Navigation taucht sie ohnehin nicht auf.
 *
 * Für Endpunkte bleibt es beim 403 — dort ist der Aufrufer die eigene
 * Applikation, und die soll den Unterschied kennen.
 */
export async function requirePagePermission(
  ...permissions: Permission[]
): Promise<SessionUser> {
  const session = await requireSession();
  const missing = permissions.filter((p) => !can(session.role, p));
  if (missing.length > 0) notFound();
  return session;
}

/** Die Customer-ID der aktuellen Session — für „nur eigene Daten"-Filter. */
export async function requireCustomerId(): Promise<{ session: SessionUser; customerId: string }> {
  const session = await requireSession();
  if (session.role === 'CUSTOMER') {
    if (!session.profileId) throw new ForbiddenError('Kein Kundenprofil verknüpft.');
    return { session, customerId: session.profileId };
  }
  throw new ForbiddenError('Diese Ressource ist Kundenkonten vorbehalten.');
}

export async function requireEmployeeId(): Promise<{ session: SessionUser; employeeId: string }> {
  const session = await requireSession();
  if (!session.profileId || session.role === 'CUSTOMER') {
    throw new ForbiddenError('Kein Mitarbeitendenprofil verknüpft.');
  }
  return { session, employeeId: session.profileId };
}

// ---------------------------------------------------------------------------
//  Session-Lebenszyklus
// ---------------------------------------------------------------------------

interface CreateSessionInput {
  userId: string;
  /** Bestehende Rotationsfamilie beim Refresh weiterführen. */
  family?: string;
}

/**
 * Erzeugt Access- und Refresh-Token, setzt beide Cookies und persistiert den
 * Refresh-Token-Hash. Rotation: jeder Refresh erzeugt einen neuen Token in
 * derselben `family`; taucht ein bereits widerrufener Token wieder auf, wird
 * die ganze Familie invalidiert (Token-Reuse-Detection).
 */
export async function createSession({ userId, family }: CreateSessionInput) {
  const env = serverEnv();

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      locale: true,
      avatarUrl: true,
      theme: true,
      organizationId: true,
      customer: { select: { id: true } },
      employee: { select: { id: true } },
    },
  });

  // Das Profil folgt der Rolle, nicht der Reihenfolge „Kundschaft, sonst
  // Personal": Eine Person kann beides haben (privat gebucht *und*
  // angestellt). Mit der alten Regel war sie als Mitarbeitende mit einer
  // Kunden-ID unterwegs — und die Zeiterfassung hätte auf einen Datensatz
  // gebucht, den es in der Personaltabelle nicht gibt.
  const profileId =
    user.role === 'CUSTOMER' ? (user.customer?.id ?? undefined) : (user.employee?.id ?? undefined);

  const jti = randomToken(24);
  const tokenFamily = family ?? randomToken(16);

  /**
   * Läuft für diesen Browser eine Geräteübergabe?
   *
   * Die Abfrage steht **hier**, an der einzigen Stelle, die Zugangstoken
   * ausstellt — und deshalb greift sie auf allen Wegen: beim Start der
   * Übergabe, bei jeder stillen Erneuerung und beim Entsperren. Wer das
   * Zugangstoken im Kundenmodus löscht und erneuern lässt, bekommt die
   * Sperre erneut eingeprägt, statt sie loszuwerden.
   *
   * Nur bei fortgeführter Familie: Eine frische Anmeldung beginnt eine neue
   * Familie und damit einen neuen Browserkontext; sie erbt keine Sperre.
   * Das ist gewollt und kein Schlupfloch — sie verlangt das Passwort, also
   * genau das, was auch das Entsperren verlangt.
   */
  const sperre = family
    ? await prisma.deviceHandoffSession.findFirst({
        where: { sessionFamily: family, status: 'ACTIVE' },
        select: { id: true },
      })
    : null;

  const accessToken = await signAccessToken({
    sub: user.id,
    org: user.organizationId,
    role: user.role,
    email: user.email,
    name: `${user.firstName} ${user.lastName}`.trim(),
    pid: profileId,
    locale: user.locale.toLowerCase(),
    avatar: user.avatarUrl ?? undefined,
    thm: user.theme ?? undefined,
    lck: sperre?.id,
  } as never);

  const refreshToken = await signRefreshToken({ userId: user.id, jti, family: tokenFamily });

  const hdrs = await headers();
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: await hashToken(refreshToken),
      family: tokenFamily,
      userAgent: hdrs.get('user-agent')?.slice(0, 300) ?? null,
      ip: clientIpFrom(hdrs),
      expiresAt: new Date(Date.now() + env.JWT_REFRESH_TTL * 1000),
    },
  });

  const store = await cookies();
  store.set(ACCESS_COOKIE, accessToken, cookieOptions(env.JWT_ACCESS_TTL));
  store.set(REFRESH_COOKIE, refreshToken, cookieOptions(env.JWT_REFRESH_TTL));

  return { accessToken, refreshToken, user };
}

export async function destroySession() {
  const store = await cookies();
  const refreshToken = store.get(REFRESH_COOKIE)?.value;

  if (refreshToken) {
    const tokenHash = await hashToken(refreshToken);
    await prisma.refreshToken
      .updateMany({ where: { tokenHash }, data: { revokedAt: new Date() } })
      .catch(() => undefined);
  }

  store.delete(ACCESS_COOKIE);
  store.delete(REFRESH_COOKIE);
}

/**
 * Alle Sessions eines Benutzers beenden (Passwortwechsel, Sperrung,
 * Rollenwechsel, Zurücksetzen des zweiten Faktors).
 *
 * Zwei Schritte, weil es zwei Arten von Token gibt:
 *
 *  • Der **Refresh-Token** liegt als Hash in der Datenbank und wird auf
 *    widerrufen gesetzt. Damit lässt sich keine neue Sitzung mehr erneuern.
 *
 *  • Der **Zugangstoken** ist ein signiertes JWT und liegt nirgends — er
 *    lässt sich nicht löschen. Stattdessen merkt sich das Konto den Zeitpunkt
 *    des Widerrufs; `getSession` verwirft jedes Token, das davor ausgestellt
 *    wurde. Ohne diesen zweiten Schritt liefe eine gesperrte Sitzung noch bis
 *    zu fünfzehn Minuten weiter — genau in der Zeit, in der die Sperre wirken
 *    soll.
 */
export async function revokeAllSessions(userId: string) {
  const now = new Date();
  await prisma.$transaction([
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    }),
    prisma.user.update({
      where: { id: userId },
      data: { sessionsRevokedAt: now },
    }),
  ]);
}

/**
 * Die Adresse der anfragenden Stelle — aus der **einen** Richtlinie.
 *
 * Hier stand bis Gate 4D.2 eine eigene Kette
 * `cf-connecting-ip → x-real-ip → x-forwarded-for`, die jedem dieser Köpfe
 * glaubte. Sie war ein Überbleibsel: In `lib/http/client-ip.ts` war dieselbe
 * Kette längst durch `TRUSTED_PROXY_MODE` ersetzt worden, in dieser Datei
 * nicht. Zwei Auswertungen bedeuten zwei Sicherheitsniveaus, und das
 * schwächere gewinnt immer dort, wo niemand hinschaut.
 *
 * Betroffen waren `RefreshToken.ip` und `User.lastLoginIp` — also genau die
 * Felder, in die man bei einem Vorfall zuerst schaut. Ein Angreifer konnte
 * sie mit einer einzigen Kopfzeile beliebig füllen, ohne dass irgendeine
 * Prüfung dazwischenlag. Das Signaturprotokoll war nie betroffen; es bezieht
 * `ctx.ip` seit Gate 4B aus `getClientIp`.
 *
 * Diese Funktion bleibt als Name bestehen, damit die Aufrufstellen lesbar
 * bleiben, hat aber keine eigene Logik mehr.
 */
export function clientIpFrom(hdrs: Headers): string | null {
  return clientIpFromHeaders(hdrs);
}
