import 'server-only';

import { cookies } from 'next/headers';

import { prisma } from '@/lib/db';
import { recordSecurityEvent } from '@/lib/security/record';
import { AppError, UnauthorizedError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { ACCESS_COOKIE, REFRESH_COOKIE, hashToken, verifyRefreshToken } from '@/lib/auth/jwt';
import { createSession, sessionIdleSecondsFor } from '@/lib/auth/session';

const log = logger('auth/refresh');

/**
 * Sitzung erneuern — Rotation mit Wiederverwendungserkennung und Leerlauffenster.
 *
 * **Warum es diese Funktion gibt.** Der Zugangstoken lebt fünfzehn Minuten,
 * und bis hierher hat ihn nichts je erneuert: Wer eine Viertelstunde nach
 * der Anmeldung eine Seite öffnete, stand vor der Anmeldemaske — mitten in
 * der Arbeit, mit einem gültigen Refresh-Token im Browser, der nie gefragt
 * wurde. Jetzt rufen drei Stellen hier an: die Middleware (Seitenaufruf mit
 * abgelaufenem Zugangstoken), der API-Klient (401 auf einen Aufruf) und der
 * Aktivitätswächter im Rahmen der Anwendung (vorbeugend, solange gearbeitet
 * wird).
 *
 * **Das Leerlauffenster.** Erneuert wird nur, wenn der vorgelegte
 * Refresh-Token selbst jünger ist als `SESSION_IDLE_TTL`. Jede Erneuerung
 * stellt einen neuen Token aus, also wandert das Fenster mit der Aktivität —
 * und schliesst sich, sobald fünfzehn Minuten lang niemand etwas tut. Ohne
 * dieses Fenster wäre die Sitzung dreissig Tage lang wiederbelebbar, auch
 * aus einem vergessenen Tab auf einem geteilten Gerät. `JWT_REFRESH_TTL`
 * bleibt die absolute Obergrenze, die kein Fenster überschreitet.
 *
 * **Rotation.** Jeder Refresh gibt einen neuen Token derselben `family` aus
 * und widerruft den alten. Taucht ein bereits widerrufener Token erneut auf,
 * wurde er gestohlen — dann wird die ganze Familie invalidiert und die Person
 * muss sich neu anmelden (OAuth 2.1, Refresh Token Rotation).
 */
export async function refreshSession(): Promise<{ id: string; role: string; email: string }> {
  const store = await cookies();
  const token = store.get(REFRESH_COOKIE)?.value;
  if (!token) throw new UnauthorizedError('Keine Sitzung gefunden.');

  const forget = () => {
    store.delete(REFRESH_COOKIE);
    store.delete(ACCESS_COOKIE);
  };

  const claims = await verifyRefreshToken(token);
  if (!claims) {
    forget();
    throw new UnauthorizedError('Die Sitzung ist abgelaufen.');
  }

  const tokenHash = await hashToken(token);
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: {
      user: { select: { id: true, status: true, deletedAt: true, organizationId: true } },
    },
  });

  if (!record || record.expiresAt < new Date()) {
    forget();
    throw new UnauthorizedError('Die Sitzung ist abgelaufen.');
  }

  /*
    Verlorener Wettlauf, keine Wiederverwendung (2026-09-27).

    Middleware, API-Klient und Aktivitätswächter rufen hier an — in jedem
    offenen Tab. Legen zwei denselben Token fast gleichzeitig vor, gewinnt
    einer die Rotation; der andere sieht einen Token, den **die Rotation**
    eben verbraucht hat. Bis hierher galt auch das als Diebstahl: Die
    Familie wurde gesperrt und die Person mitten in der Arbeit abgemeldet,
    mit Sicherheitsmeldung.

    Innerhalb von `ROTATIONS_KULANZ_MS` nach einer Rotation wird deshalb nur
    abgewiesen — ohne Sperre und **ohne Cookies zu löschen**: Die Antwort des
    Gewinners hat im Browser bereits die neuen gesetzt, und ein Löschen hier
    käme womöglich danach an und nähme sie wieder weg. Nach der Frist, oder
    bei einem Token, den nicht die Rotation verbraucht hat (Abmelden,
    Leerlauf), bleibt es bei der Wiederverwendungserkennung darunter. Ein
    Dieb, der innerhalb derselben Sekunden rät, bekommt ebenfalls nur 401.
  */
  if (record.revokedAt && record.rotatedAt && Date.now() - record.rotatedAt.getTime() < ROTATIONS_KULANZ_MS) {
    throw new RotationsWettlaufError();
  }

  if (record.revokedAt) {
    await prisma.refreshToken.updateMany({
      where: { family: record.family, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    forget();
    log.warn('Token-Wiederverwendung erkannt — Familie gesperrt', { family: record.family });

    /**
     * Das schwerwiegendste Ereignis, das dieser Ablauf erzeugen kann.
     *
     * Ein Erneuerungstoken wird beim ersten Gebrauch verbraucht. Kommt er ein
     * zweites Mal, gibt es genau zwei Erklärungen: ein Wettlauf zweier Tabs
     * derselben Person — oder jemand hat eine Kopie. Unterscheiden lässt sich
     * das von hier aus nicht, und deshalb wird die ganze Familie gesperrt und
     * der Fall gemeldet, statt ihn als Bedienfehler abzutun.
     *
     * `family` steht im Zusammenhang, weil es die Zuordnung zu einem Browser
     * herstellt und dafür gebraucht wird. Es ist eine Kennung, kein Zugang —
     * der Tokenhash bleibt draussen, wie überall.
     */
    if (record.user) {
      await recordSecurityEvent({
        organizationId: record.user.organizationId,
        userId: record.user.id,
        kind: 'REFRESH_REUSE_DETECTED',
        summary: 'Erneuerungstoken ein zweites Mal vorgelegt — alle Sitzungen dieses Browsers beendet',
        context: { family: record.family },
      });
    }

    throw new UnauthorizedError(
      'Aus Sicherheitsgründen wurde die Sitzung beendet. Bitte melden Sie sich erneut an.',
    );
  }

  // Leerlauf: der Token wurde bei der letzten Aktivität ausgestellt. Liegt
  // die länger zurück als das Fenster, ist die Sitzung eingeschlafen — und
  // ein eingeschlafener Token wird widerrufen, nicht nur abgewiesen, damit
  // er auch später nicht mehr taugt. Das Fenster hängt an „Angemeldet
  // bleiben" (signierter Anspruch `rem`, seit 2026-09-28).
  const dauerhaft = claims.rem === true;
  const idleMs = sessionIdleSecondsFor(dauerhaft) * 1000;
  if (record.createdAt.getTime() + idleMs < Date.now()) {
    await prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
    forget();
    throw new UnauthorizedError('Die Sitzung wurde nach längerer Inaktivität beendet.');
  }

  if (!record.user || record.user.deletedAt || record.user.status !== 'ACTIVE') {
    forget();
    throw new UnauthorizedError('Dieses Konto ist nicht mehr aktiv.');
  }

  /*
    Die Rotation ist ein **bedingter** Übergang (2026-09-27): Nur wer den
    Token im Zustand „nicht widerrufen" antrifft, verbraucht ihn. Vorher stand
    hier ein unbedingtes Widerrufen nach dem Lesen — zwei gleichzeitige
    Aufrufe lasen beide einen gültigen Token und stellten beide einen neuen
    aus: Die Familie gabelte sich in zwei lebende Tokens. Jetzt trifft genau
    einer die Zeile; die anderen landen in der Kulanz oben.
  */
  const jetzt = new Date();
  const verbraucht = await prisma.refreshToken.updateMany({
    where: { id: record.id, revokedAt: null },
    data: { revokedAt: jetzt, rotatedAt: jetzt },
  });
  if (verbraucht.count === 0) throw new RotationsWettlaufError();
  const session = await createSession({ userId: record.user.id, family: record.family, persistent: dauerhaft });
  return { id: session.user.id, role: session.user.role, email: session.user.email };
}

/**
 * Wie lange ein durch Rotation verbrauchter Token als „anderer Tab war
 * schneller" gilt statt als Wiederverwendung. Zehn Sekunden decken parallele
 * Anfragen eines Seitenaufbaus und langsame Mobilnetze; länger würde die
 * Wiederverwendungserkennung ohne Grund abschwächen.
 */
const ROTATIONS_KULANZ_MS = 10_000;

/**
 * Der verlorene Wettlauf — ein 401 mit eigener Meldung, ohne Familiensperre
 * und ohne gelöschte Cookies.
 *
 * Der Seitenweg (`GET /api/auth/refresh`) leitet auch hier zur Anmeldung,
 * nicht ans Ziel: Kämen die Cookies des Gewinners nie an (etwa weil der
 * Gewinner eine Wiederholung war), liefe eine Weiterleitung ans Ziel im Kreis
 * zwischen Middleware und Erneuerung. Die Anmeldemaske ist der sichere
 * Ausgang; der API-Klient im Browser wiederholt ohnehin mit den neuen Cookies.
 */
export class RotationsWettlaufError extends AppError {
  constructor() {
    // Eigener Code, damit der API-Klient ihn vom „abgelaufen" unterscheiden
    // kann: Er wiederholt dann mit den Cookies, die der andere Tab soeben
    // gesetzt hat, statt zur Anmeldung zu gehen.
    super('SESSION_ROTATED', 'Die Sitzung wurde soeben in einem anderen Fenster erneuert.', 401);
  }
}
