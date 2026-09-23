import 'server-only';

import type { Prisma, SecurityCategory, SecuritySeverity } from '@prisma/client';

import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { SECURITY_EVENTS, type SecurityEventKind } from '@/lib/security/events';
import { recordSecurityEvent } from '@/lib/security/record';
import { getScanner, scannerEingerichtet } from '@/lib/security/malware';

/**
 * Das Sicherheitszentrum — die Lesesicht.
 *
 * ---------------------------------------------------------------------------
 *  Was dieses Modul ist und was es nicht ist
 * ---------------------------------------------------------------------------
 *
 * Es ist eine **Zusammenführung**, keine Erkennung. Jeder Wert hier steht
 * bereits irgendwo in der Datenbank: gesperrte Konten an `User.lockedUntil`,
 * offene Sitzungen an `RefreshToken`, Dateien in Quarantäne an
 * `FileAsset.scanStatus`, Ereignisse an `SecurityEvent`. Was fehlte, war ein
 * Ort, an dem man sie nebeneinander sieht.
 *
 * Das ist keine Bescheidenheit, sondern eine Abgrenzung: Eine eigene
 * Erkennungslogik — „ungewöhnliche Anmeldezeit", „neues Land" — wäre eine
 * Vermutung, die als Feststellung angezeigt wird. Solche Anzeigen werden nach
 * drei Fehlalarmen weggeklickt und danach auch dann, wenn sie recht haben.
 * Angezeigt wird ausschliesslich, was tatsächlich geschehen ist.
 *
 * ---------------------------------------------------------------------------
 *  Warum die Zählungen getrennt laufen und nicht als eine Abfrage
 * ---------------------------------------------------------------------------
 *
 * Sie stammen aus vier Tabellen ohne fachliche Beziehung. Ein Join wäre ein
 * Kreuzprodukt mit Filtern darauf; `$transaction` mit mehreren `count`-Läufen
 * ist hier schlicht das ehrlichere Werkzeug und geht in einem Rundlauf zur
 * Datenbank.
 */

// ---------------------------------------------------------------------------
//  Überblick
// ---------------------------------------------------------------------------

export interface SicherheitsUeberblick {
  /** Ereignisse, die eine Entscheidung verlangen und noch keine haben. */
  offeneKritische: number;
  ereignisse24h: number;
  fehlanmeldungen24h: number;
  gesperrteKonten: number;
  /** Konten mit Fehlversuchen, die noch nicht zur Sperre geführt haben. */
  kontenMitFehlversuchen: number;
  aktiveSitzungen: number;
  offeneGeraeteUebergaben: number;
  dateienInQuarantaene: number;
  dateienOhneBefund: number;
  /** Anteil der aktiven Konten mit zweitem Faktor, als Prozentwert. */
  zweitfaktorAnteil: number;
  aktiveKonten: number;
  kontenMitZweitfaktor: number;
  scanner: {
    eingerichtet: boolean;
    art: 'clamav' | 'test' | 'keiner';
    /**
     * Bei ClamAV: antwortet der Dienst gerade (`zPING`), und in welcher
     * Version. Bis 2026-09-23 zeigte die Übersicht nur „eingerichtet" — ein
     * gesetztes `CLAMAV_HOST` auf einen Dienst, der nicht läuft, sah aus wie
     * ein funktionierender Prüfer (RB-013).
     */
    erreichbar: boolean | null;
    version: string | null;
  };
}

export async function getSicherheitsUeberblick(
  organizationId: string,
): Promise<SicherheitsUeberblick> {
  const seit24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const jetzt = new Date();

  const [
    offeneKritische,
    ereignisse24h,
    fehlanmeldungen24h,
    gesperrteKonten,
    kontenMitFehlversuchen,
    aktiveSitzungen,
    offeneGeraeteUebergaben,
    dateienInQuarantaene,
    dateienOhneBefund,
    aktiveKonten,
    kontenMitZweitfaktor,
  ] = await prisma.$transaction([
    prisma.securityEvent.count({
      where: { organizationId, severity: 'CRITICAL', acknowledgedAt: null },
    }),
    prisma.securityEvent.count({ where: { organizationId, occurredAt: { gte: seit24h } } }),
    prisma.securityEvent.count({
      where: { organizationId, kind: 'LOGIN_FAILED', occurredAt: { gte: seit24h } },
    }),
    prisma.user.count({
      where: { organizationId, deletedAt: null, lockedUntil: { gt: jetzt } },
    }),
    prisma.user.count({
      where: {
        organizationId,
        deletedAt: null,
        failedLoginCount: { gt: 0 },
        // Bereits gesperrte sind oben schon gezählt; zweimal wäre irreführend.
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: jetzt } }],
      },
    }),
    /**
     * Eine „aktive Sitzung" ist ein nicht widerrufener, nicht abgelaufener
     * Erneuerungstoken. Die Zugangstokens leben fünfzehn Minuten und stehen
     * nirgends — sie liessen sich gar nicht zählen, und die Zahl wäre auch
     * keine Aussage über offene Sitzungen, sondern über die letzten Minuten.
     */
    prisma.refreshToken.count({
      where: { revokedAt: null, expiresAt: { gt: jetzt }, user: { organizationId } },
    }),
    prisma.deviceHandoffSession.count({ where: { organizationId, status: 'ACTIVE' } }),
    prisma.fileAsset.count({ where: { organizationId, scanStatus: 'QUARANTINED' } }),
    prisma.fileAsset.count({ where: { organizationId, scanStatus: 'ERROR' } }),
    prisma.user.count({ where: { organizationId, deletedAt: null, status: 'ACTIVE' } }),
    prisma.user.count({
      where: { organizationId, deletedAt: null, status: 'ACTIVE', twoFactorEnabled: true },
    }),
  ]);

  return {
    offeneKritische,
    ereignisse24h,
    fehlanmeldungen24h,
    gesperrteKonten,
    kontenMitFehlversuchen,
    aktiveSitzungen,
    offeneGeraeteUebergaben,
    dateienInQuarantaene,
    dateienOhneBefund,
    aktiveKonten,
    kontenMitZweitfaktor,
    zweitfaktorAnteil:
      aktiveKonten === 0 ? 0 : Math.round((kontenMitZweitfaktor / aktiveKonten) * 100),
    scanner: await scannerZustand(),
  };
}

async function scannerZustand(): Promise<SicherheitsUeberblick['scanner']> {
  const grund = scannerEingerichtet();
  if (grund.art !== 'clamav') return { ...grund, erreichbar: null, version: null };
  const scanner = getScanner();
  const [zustand, version] = await Promise.all([scanner?.health(), scanner?.version()]);
  return { ...grund, erreichbar: zustand?.erreichbar ?? false, version: version ?? null };
}

// ---------------------------------------------------------------------------
//  Ereignisliste
// ---------------------------------------------------------------------------

export interface EreignisFilter {
  organizationId: string;
  category?: SecurityCategory;
  severity?: SecuritySeverity;
  /** Nur die, die eine Entscheidung verlangen und keine haben. */
  nurOffen?: boolean;
  userId?: string;
  seite?: number;
  proSeite?: number;
}

export async function listSecurityEvents(filter: EreignisFilter) {
  const proSeite = Math.min(filter.proSeite ?? 50, 200);
  const seite = Math.max(filter.seite ?? 1, 1);

  const where: Prisma.SecurityEventWhereInput = {
    organizationId: filter.organizationId,
    ...(filter.category ? { category: filter.category } : {}),
    ...(filter.severity ? { severity: filter.severity } : {}),
    ...(filter.userId ? { userId: filter.userId } : {}),
    /**
     * „Offen" heisst `CRITICAL` **und** unbestätigt. Ohne die Stufe wären es
     * alle Zeilen, die nie jemand bestätigen wollte — also fast alle, und die
     * Ansicht wäre wertlos. Die Regel, welche Stufe eine Bestätigung verlangt,
     * steht in `events.ts` und wird hier nur angewandt.
     */
    ...(filter.nurOffen ? { severity: 'CRITICAL' as const, acknowledgedAt: null } : {}),
  };

  const [eintraege, gesamt] = await prisma.$transaction([
    prisma.securityEvent.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      skip: (seite - 1) * proSeite,
      take: proSeite,
      select: {
        id: true,
        kind: true,
        category: true,
        severity: true,
        summary: true,
        context: true,
        ip: true,
        occurredAt: true,
        acknowledgedAt: true,
        acknowledgedNote: true,
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
        acknowledgedBy: { select: { id: true, firstName: true, lastName: true } },
      },
    }),
    prisma.securityEvent.count({ where }),
  ]);

  return { eintraege, gesamt, seite, proSeite };
}

// ---------------------------------------------------------------------------
//  Konten und Sitzungen
// ---------------------------------------------------------------------------

/**
 * Konten, an denen gerade etwas auffällt.
 *
 * Bewusst nicht „alle Konten mit ihrem Sicherheitszustand" — das ist die
 * Benutzerverwaltung, und die gibt es. Hier stehen nur die, bei denen etwas
 * zu sehen ist: gesperrt, Fehlversuche offen, oder Sitzungen nach einem
 * Widerruf.
 */
export async function listAuffaelligeKonten(organizationId: string) {
  const jetzt = new Date();

  return prisma.user.findMany({
    where: {
      organizationId,
      deletedAt: null,
      OR: [{ lockedUntil: { gt: jetzt } }, { failedLoginCount: { gt: 0 } }],
    },
    orderBy: [{ lockedUntil: 'desc' }, { failedLoginCount: 'desc' }],
    take: 50,
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      role: true,
      status: true,
      failedLoginCount: true,
      lockedUntil: true,
      lastLoginAt: true,
      twoFactorEnabled: true,
    },
  });
}

/**
 * Ein gesperrtes Konto entsperren.
 *
 * Setzt den Zähler zurück und hebt die Frist auf — mehr nicht. Insbesondere
 * wird **kein** Passwort geändert und keine Sitzung ausgestellt: Wer entsperrt
 * wird, meldet sich selbst an. Alles andere hiesse, dass die Systemverantwortung
 * einen Zugang herstellt, statt eine Sperre aufzuheben.
 */
export async function entsperreKonto(params: {
  organizationId: string;
  userId: string;
  actorId: string;
  ip?: string | null;
}): Promise<void> {
  const user = await prisma.user.findFirst({
    where: { id: params.userId, organizationId: params.organizationId, deletedAt: null },
    select: { id: true, email: true, lockedUntil: true, failedLoginCount: true },
  });
  if (!user) throw new NotFoundError('Benutzer');

  await prisma.user.update({
    where: { id: user.id },
    data: { lockedUntil: null, failedLoginCount: 0 },
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'User',
    entityId: user.id,
    summary: `Kontosperre aufgehoben (${user.email})`,
    changes: {
      lockedUntil: { from: user.lockedUntil, to: null },
      failedLoginCount: { from: user.failedLoginCount, to: 0 },
    },
    ip: params.ip,
  });

  await recordSecurityEvent({
    organizationId: params.organizationId,
    userId: user.id,
    kind: 'USER_REACTIVATED',
    summary: 'Kontosperre durch die Systemverantwortung aufgehoben',
    context: { durch: params.actorId },
    ip: params.ip,
  });
}

/**
 * Alle Sitzungen eines Kontos beenden.
 *
 * Zwei Dinge zusammen, und beide sind nötig: Die Erneuerungstokens werden
 * widerrufen (damit sich keine neue Sitzung daraus ziehen lässt) **und**
 * `sessionsRevokedAt` wird gesetzt. Nur das Erste liesse die bereits
 * ausgestellten Zugangstokens für ihre restlichen fünfzehn Minuten weiterlaufen
 * — und genau in diesen fünfzehn Minuten würde jemand tun, wovor der Widerruf
 * schützen soll.
 */
export async function beendeSitzungen(params: {
  organizationId: string;
  userId: string;
  actorId: string;
  ip?: string | null;
}): Promise<{ widerrufen: number }> {
  const user = await prisma.user.findFirst({
    where: { id: params.userId, organizationId: params.organizationId, deletedAt: null },
    select: { id: true, email: true },
  });
  if (!user) throw new NotFoundError('Benutzer');

  const [tokens] = await prisma.$transaction([
    prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: user.id },
      data: { sessionsRevokedAt: new Date() },
    }),
  ]);

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'User',
    entityId: user.id,
    summary: `Alle Sitzungen beendet (${user.email}) — ${tokens.count} Erneuerungstoken widerrufen`,
    ip: params.ip,
  });

  await recordSecurityEvent({
    organizationId: params.organizationId,
    userId: user.id,
    kind: 'SESSIONS_REVOKED',
    summary: `Alle Sitzungen durch die Systemverantwortung beendet (${tokens.count} Token)`,
    context: { durch: params.actorId, tokens: tokens.count },
    ip: params.ip,
  });

  return { widerrufen: tokens.count };
}

// ---------------------------------------------------------------------------
//  Bestätigen
// ---------------------------------------------------------------------------

/**
 * Ein Ereignis als gesehen erklären.
 *
 * **Bestätigen ist keine Bewertung und kein Löschen.** Die Zeile bleibt
 * unverändert stehen; dazu kommen Zeitpunkt, Person und Notiz. Wer später
 * nachvollzieht, was geschah, sieht beides: das Ereignis und dass jemand
 * hingesehen hat. Ein „erledigt"-Häkchen, das die Zeile verschwinden lässt,
 * wäre die bequemere Oberfläche und die schlechtere Auskunft.
 *
 * Die bedingte Aktualisierung entscheidet den Wettlauf zweier gleichzeitiger
 * Bestätigungen in der Datenbank: Wer trifft, hat bestätigt; wer nicht trifft,
 * sieht das Ergebnis des anderen. Ohne sie überschriebe der zweite Aufruf
 * Zeitpunkt und Notiz des ersten.
 */
export async function bestaetigeEreignis(params: {
  organizationId: string;
  eventId: string;
  actorId: string;
  note?: string;
  ip?: string | null;
}): Promise<{ bestaetigt: boolean }> {
  const treffer = await prisma.securityEvent.updateMany({
    where: {
      id: params.eventId,
      organizationId: params.organizationId,
      acknowledgedAt: null,
    },
    data: {
      acknowledgedAt: new Date(),
      acknowledgedById: params.actorId,
      acknowledgedNote: params.note?.slice(0, 1000) ?? null,
    },
  });

  if (treffer.count === 0) {
    const vorhanden = await prisma.securityEvent.findFirst({
      where: { id: params.eventId, organizationId: params.organizationId },
      select: { id: true },
    });
    if (!vorhanden) throw new NotFoundError('Sicherheitsereignis');
    // Vorhanden, aber schon bestätigt. Kein Fehler — die Absicht ist erfüllt.
    return { bestaetigt: false };
  }

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'SecurityEvent',
    entityId: params.eventId,
    summary: 'Sicherheitsereignis bestätigt',
    ip: params.ip,
  });

  return { bestaetigt: true };
}

// ---------------------------------------------------------------------------
//  Katalog für die Oberfläche
// ---------------------------------------------------------------------------

/**
 * Die Bezeichnung zu einer Art.
 *
 * `kind` ist eine freie Zeichenkette in der Datenbank (siehe `events.ts`);
 * eine Zeile kann also eine Art tragen, die es im Code nicht mehr gibt — etwa
 * nach einer Umbenennung. Dann wird die Art selbst angezeigt, statt dass die
 * Zeile leer bleibt oder die Ansicht scheitert.
 */
export function ereignisBezeichnung(kind: string): string {
  return SECURITY_EVENTS[kind as SecurityEventKind]?.label ?? kind;
}
