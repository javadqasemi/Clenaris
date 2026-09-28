import 'server-only';

import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '@/lib/errors';
import type { ReplyMessageInput } from '@/lib/validation/messaging';
import { dateienBinden } from '@/server/services/file.service';
import { notify, notifyStaff } from '@/server/services/notification.service';
import { getOrganizationId } from '@/server/services/organization.service';

/**
 * Nachrichtenverläufe: lesen, gelesen markieren, antworten.
 *
 * Vorher im Endpunkt `/api/messages/:id` geschrieben (bis 2026-09-27). Die
 * Regeln hier — wer welchen Verlauf sieht, dass ein geschlossener Verlauf
 * keine Antwort mehr annimmt, dass nur das Büro abschliesst, dass Anhänge
 * nur aus eigenen Uploads kommen — sind Geschäftsregeln. Im Endpunkt fand
 * sie der nächste Aufrufer nicht und hätte sie nachbauen oder übergehen
 * müssen — bei einer Sichtregel ist Übergehen ein Datenleck. Der Endpunkt
 * übersetzt nur noch HTTP in diese Aufrufe;
 * Berechtigung, Validierung und Ratenbegrenzung bleiben in seiner
 * `defineRoute`-Erklärung.
 *
 * Nicht zu verwechseln mit `kommunikation.service.ts`: Jener nimmt die
 * Zustellmeldungen der E-Mail- und SMS-Anbieter auf und kennt keine
 * Verläufe.
 */

/** Was die Sichtregel von der Sitzung braucht — nicht mehr. */
export interface ThreadViewer {
  id: string;
  role: string;
  profileId: string | null;
}

/**
 * Neuen Verlauf eröffnen — vorher im Endpunkt `POST /api/messages`
 * (bis 2026-09-27; die Merkmalsprüfung sah es nicht, weil `MessageThread`
 * auch hier geschrieben wird, aber es war dieselbe Umgehung).
 *
 * Kundschaft: Der Verlauf gehört dem eigenen Kundenkonto. Büro, Leitung und
 * Mitarbeitende ohne Kundenkonto eröffnen nur Verläufe zu einem Einsatz, und
 * die bleiben **intern** (`customerId` leer) — die Kundschaft sieht sie
 * nicht. Die frühere Beschreibung („immer an die Kundschaft gebunden")
 * stimmte mit dem Verhalten nicht überein; berichtigt 2026-09-27 zugunsten
 * des Verhaltens, weil Einsatzabsprachen im Team nicht ungefragt im
 * Kundenkonto erscheinen sollen.
 */
export async function openThread(params: {
  session: ThreadViewer & { firstName: string; lastName: string };
  input: { subject: string; body: string; jobId?: string | null; bookingId?: string | null };
}): Promise<{ id: string; subject: string }> {
  const { session, input } = params;
  const organizationId = await getOrganizationId();

  const customer = await prisma.customer.findFirst({
    where: { userId: session.id, organizationId },
    select: { id: true, firstName: true, lastName: true, companyName: true },
  });

  // Mitarbeitende ohne Kundenkonto dürfen nur zu einem Auftrag schreiben.
  if (!customer && !input.jobId) {
    throw new ForbiddenError('Ohne verknüpftes Kundenkonto lässt sich nur zu einem Einsatz schreiben.');
  }

  // …und nur zu einem, dem sie zugeteilt sind. Die Einsatz-ID kommt aus dem
  // Körper; ohne Prüfung liesse sich an jeden Einsatz des Betriebs schreiben.
  //
  // Der Einsatz wird für **jede** Rolle in der eigenen Organisation gesucht
  // (2026-09-27). Vorher nur für Mitarbeitende; Büro und Leitung konnten einen
  // Verlauf an die Einsatz-ID einer fremden Organisation hängen — die
  // Buchungs-ID darunter war längst mandantengebunden, die Einsatz-ID nicht.
  if (input.jobId) {
    const gefunden = await prisma.job.count({
      where: {
        id: input.jobId,
        organizationId,
        deletedAt: null,
        ...(session.role === 'EMPLOYEE'
          ? { assignments: { some: { employeeId: session.profileId ?? '__keines__' } } }
          : {}),
      },
    });
    if (!gefunden) throw new NotFoundError('Einsatz');
  }

  if (input.bookingId) {
    const booking = await prisma.booking.findFirst({
      where: { id: input.bookingId, organizationId, ...(customer ? { customerId: customer.id } : {}) },
      select: { id: true },
    });
    if (!booking) throw new NotFoundError('Buchung');
  }

  const thread = await prisma.messageThread.create({
    data: {
      organizationId,
      subject: input.subject,
      customerId: customer?.id ?? null,
      jobId: input.jobId ?? null,
      lastMessageAt: new Date(),
      messages: {
        create: {
          authorId: session.id,
          authorType: session.role === 'CUSTOMER' ? 'CUSTOMER' : 'STAFF',
          body: input.body,
        },
      },
    },
    select: { id: true, subject: true },
  });

  const senderName = customer
    ? (customer.companyName ?? `${customer.firstName} ${customer.lastName}`)
    : `${session.firstName} ${session.lastName}`;

  // Protokolliert seit 2026-09-27 — das Eröffnen war der einzige schreibende
  // Weg dieses Dienstes ohne Eintrag. Der Betreff, nicht der Text: Die
  // Nachricht selbst gehört in den Verlauf, nicht ins Protokoll.
  await audit.created({
    organizationId,
    userId: session.id,
    entity: 'MessageThread',
    entityId: thread.id,
    summary: `Nachrichtenverlauf „${thread.subject}" eröffnet`,
  });

  if (session.role === 'CUSTOMER') {
    await notifyStaff({
      organizationId,
      title: 'Neue Nachricht von der Kundschaft',
      body: `${senderName}: ${thread.subject}`,
      link: `/admin/nachrichten?verlauf=${thread.id}`,
      permission: 'message:read',
    });
  }

  return thread;
}

/**
 * Ermittelt den Thread und prüft die Zugehörigkeit in einem Schritt.
 *
 * Drei Sichten: Das Büro sieht alles, die Kundschaft die eigenen Verläufe,
 * Mitarbeitende die Verläufe zu ihren zugeteilten Einsätzen. Die dritte fehlte
 * lange — die Rolle hat `message:read_own`, und ohne eigene Regel hiess „own"
 * für sie stillschweigend „alle".
 */
export async function loadThread(threadId: string, session: ThreadViewer) {
  // Die Organisation in der `where`-Klausel (2026-09-27): Ein fremder Verlauf
  // wird schlicht nicht gefunden. Vorher fand das Büro jeden Verlauf über die
  // Kennung und konnte in fremde Korrespondenz antworten.
  const thread = await prisma.messageThread.findFirst({
    where: { id: threadId, organizationId: await getOrganizationId() },
    include: {
      customer: { select: { id: true, userId: true, firstName: true, lastName: true, companyName: true } },
      job: { select: { assignments: { select: { employeeId: true } } } },
    },
  });
  if (!thread) throw new NotFoundError('Nachrichtenverlauf');

  /*
    Ein fremder Verlauf ist „nicht gefunden", nicht „verboten" (2026-09-27,
    Standard C19). Die frühere Antwort war 403 mit dem Kommentar „bewusst
    404-nah formuliert" — aber der Status verriet es trotzdem: 403 für einen
    Verlauf, den es gibt, 404 für einen, den es nicht gibt. Wer Kennungen
    durchprobiert, erfuhr so, welche existieren.
  */
  if (session.role === 'CUSTOMER' && thread.customer?.userId !== session.id) {
    throw new NotFoundError('Nachrichtenverlauf');
  }

  if (
    session.role === 'EMPLOYEE' &&
    !thread.job?.assignments.some((assignment) => assignment.employeeId === session.profileId)
  ) {
    throw new NotFoundError('Nachrichtenverlauf');
  }

  return thread;
}

/**
 * Verlauf lesen.
 *
 * Liefert den Verlauf und markiert beim Lesen die Gegenseite als gelesen —
 * jeweils nur die Nachrichten, die man selbst *nicht* geschrieben hat.
 */
export async function readThread(threadId: string, session: ThreadViewer) {
  const thread = await loadThread(threadId, session);

  const messages = await prisma.message.findMany({
    where: { threadId: thread.id },
    orderBy: { createdAt: 'asc' },
    include: {
      author: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
      attachments: { select: { id: true, filename: true, url: true, mimeType: true, sizeBytes: true } },
    },
  });

  const foreignType = session.role === 'CUSTOMER' ? 'STAFF' : 'CUSTOMER';
  await prisma.message.updateMany({
    where: { threadId: thread.id, authorType: foreignType, readAt: null },
    data: { readAt: new Date() },
  });

  return {
    id: thread.id,
    subject: thread.subject,
    closed: thread.closed,
    customer: thread.customer,
    messages,
  };
}

/**
 * Auf einen Verlauf antworten.
 *
 * Ein geschlossener Verlauf nimmt keine Antworten mehr an; wer nachfragen
 * will, eröffnet einen neuen. Das hält alte Akten stabil und verhindert, dass
 * eine erledigte Reklamation Monate später wieder aufgeht.
 */
export async function replyToThread({
  threadId,
  session,
  input,
}: {
  threadId: string;
  session: ThreadViewer;
  input: ReplyMessageInput;
}): Promise<{ id: string }> {
  const organizationId = await getOrganizationId();
  const thread = await loadThread(threadId, session);

  if (thread.closed) {
    throw new BusinessRuleError(
      'Dieser Verlauf ist abgeschlossen. Bitte eröffnen Sie einen neuen.',
    );
  }

  const isCustomer = session.role === 'CUSTOMER';

  const message = await prisma.$transaction(async (tx) => {
    /*
      Zeile sperren, dann „geschlossen?" erneut lesen (2026-09-27, Testmatrix
      `nachrichten.nebenlaeufigkeit`).

      Die Prüfung oben liest ausserhalb jeder Sperre. Schloss das Büro den
      Verlauf, während die Kundschaft gleichzeitig antwortete, lasen beide
      „offen": Die Antwort der Kundschaft landete *nach* der abschliessenden
      Nachricht in einem geschlossenen Verlauf — genau das, was die Regel
      „wer nachfragen will, eröffnet einen neuen" ausschliessen soll, und
      niemand im Büro sah sie, weil die Liste geschlossene Verläufe ausblendet.
      Die Sperre reiht Antworten und Abschluss desselben Verlaufs hintereinander;
      wer nach dem Abschluss an die Reihe kommt, sieht `closed` und bekommt 422.

      Die Prüfung oben bleibt: Sie beantwortet den gewöhnlichen Fall ohne
      Transaktion und ohne Sperre.
    */
    await tx.$queryRaw`SELECT "id" FROM "message_threads" WHERE "id" = ${thread.id} FOR UPDATE`;
    const stand = await tx.messageThread.findUniqueOrThrow({ where: { id: thread.id }, select: { closed: true, lastMessageAt: true } });
    if (stand.closed) {
      throw new BusinessRuleError('Dieser Verlauf ist abgeschlossen. Bitte eröffnen Sie einen neuen.');
    }

    const createdMessage = await tx.message.create({
      data: {
        threadId: thread.id,
        authorId: session.id,
        authorType: isCustomer ? 'CUSTOMER' : 'STAFF',
        body: input.body,
      },
      select: { id: true, createdAt: true },
    });

    if (input.fileIds?.length) {
      // Derselbe Weg wie Buchung und Beleg (`dateienBinden`, 2026-09-27):
      // eigene Uploads, ungebunden, abgeschlossen — und eine Kennung, die
      // nicht passt, lässt die Nachricht scheitern statt still zu fehlen.
      // Nachrichtenanhänge kommen über das Dokumentprofil.
      await dateienBinden(tx, { organizationId, fileIds: input.fileIds, uploadedById: session.id, scope: 'DOCUMENT', ziel: 'messageId', zielId: createdMessage.id });
    }

    /*
      Nie zurückdrehen: `lastMessageAt` ist der späteste Zeitpunkt, nicht der
      zuletzt geschriebene. Zwei gleichzeitige Antworten schrieben vorher in
      beliebiger Reihenfolge; gewann die ältere, stand der Verlauf in der
      Liste weiter unten, als seine neueste Nachricht es verlangt. Hinter der
      Sperre ist das kaum noch möglich — der Vergleich hält es auch dann, wenn
      die Uhr zweier Prozesse nicht übereinstimmt.
    */
    const spaetester =
      stand.lastMessageAt && stand.lastMessageAt.getTime() > createdMessage.createdAt.getTime()
        ? stand.lastMessageAt
        : createdMessage.createdAt;

    await tx.messageThread.update({
      where: { id: thread.id },
      data: {
        lastMessageAt: spaetester,
        // Nur das Büro darf abschliessen.
        ...(!isCustomer && input.close ? { closed: true } : {}),
      },
    });

    return createdMessage;
  });

  const preview = input.body.length > 140 ? `${input.body.slice(0, 137)}…` : input.body;

  if (isCustomer) {
    const senderName =
      thread.customer?.companyName ??
      `${thread.customer?.firstName ?? ''} ${thread.customer?.lastName ?? ''}`.trim();
    await notifyStaff({
      organizationId,
      title: `Antwort: ${thread.subject}`,
      body: `${senderName}: ${preview}`,
      link: `/admin/nachrichten?verlauf=${thread.id}`,
      permission: 'message:read',
    });
  } else if (thread.customer?.userId) {
    await notify({
      userId: thread.customer.userId,
      channels: ['IN_APP', 'EMAIL'],
      title: `Antwort: ${thread.subject}`,
      body: preview,
      link: `/konto/nachrichten?verlauf=${thread.id}`,
      entity: 'MessageThread',
      entityId: thread.id,
    });
  }

  return { id: message.id };
}
