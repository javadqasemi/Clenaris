import 'server-only';

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
 * Der Verlauf wird immer an die Kundschaft gebunden, auch wenn ihn das Büro
 * anlegt: sonst taucht die Antwort im Kundenkonto nicht auf.
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
  if (input.jobId && session.role === 'EMPLOYEE') {
    const assigned = await prisma.job.count({
      where: {
        id: input.jobId,
        organizationId,
        deletedAt: null,
        assignments: { some: { employeeId: session.profileId ?? '__keines__' } },
      },
    });
    if (!assigned) throw new NotFoundError('Einsatz');
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

  if (session.role === 'CUSTOMER' && thread.customer?.userId !== session.id) {
    // Bewusst 404-nah formuliert: die Existenz fremder Threads ist nichts,
    // was ein fremdes Konto bestätigt bekommen soll.
    throw new ForbiddenError('Kein Zugriff auf diesen Nachrichtenverlauf.');
  }

  if (
    session.role === 'EMPLOYEE' &&
    !thread.job?.assignments.some((assignment) => assignment.employeeId === session.profileId)
  ) {
    throw new ForbiddenError('Kein Zugriff auf diesen Nachrichtenverlauf.');
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

    await tx.messageThread.update({
      where: { id: thread.id },
      data: {
        lastMessageAt: createdMessage.createdAt,
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
