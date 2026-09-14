import 'server-only';

import type { DocumentVisibility, Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import { can } from '@/lib/auth/rbac';
import type { SessionUser } from '@/lib/auth/session';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { createSignedDownloadUrl } from '@/lib/storage';
import { addDays, today } from '@/lib/bi/periods';
import type { AddDocumentVersionInput, CreateDocumentInput, UpdateDocumentInput } from '@/lib/validation/bi-knowledge';
import { notify } from './notification.service';

/**
 * Dokumentenablage.
 *
 * **Die heikelste Stelle des Moduls.** Die Ablage nimmt Verträge, Policen,
 * Personaldokumente und Steuerunterlagen auf; ein Fehler hier ist sofort ein
 * Datenschutzvorfall, kein Anzeigefehler. Deshalb:
 *
 *  • Die Sichtbarkeit wirkt in der Prisma-`where`-Klausel (`visibilityWhere`),
 *    nie im Rendering. Verstecktes HTML steht trotzdem auf der Leitung.
 *  • `EMPLOYEE_PRIVATE` heisst Geschäftsleitung *und betroffene Person* —
 *    nicht „alle Mitarbeitenden". Die Betriebsleitung sieht Personaldokumente
 *    nicht, ausser es sind ihre eigenen.
 *  • Jeder Download wird protokolliert (`audit.exported`). Wer wann eine
 *    Police oder einen Arbeitsvertrag geöffnet hat, ist die Frage, die nach
 *    einem Vorfall gestellt wird.
 *  • Personaldokumente werden ohne ausdrückliche Angabe `EMPLOYEE_PRIVATE`.
 *    Ein Standardwert, den man im Formular übersehen kann, wird übersehen.
 */

export function documentVisibilityWhere(session: SessionUser, organizationId: string): Prisma.ManagedDocumentWhereInput {
  const base: Prisma.ManagedDocumentWhereInput = { organizationId, deletedAt: null };
  const own: Prisma.ManagedDocumentWhereInput | null = session.profileId
    ? { visibility: 'EMPLOYEE_PRIVATE', subjectEmployeeId: session.profileId }
    : null;

  if (can(session.role, 'document:read')) {
    if (session.role === 'SUPER_ADMIN' || session.role === 'ADMIN') return base;
    // Betriebsleitung: alles bis OPERATIONS, dazu die eigene Personalakte.
    return { ...base, OR: [{ visibility: { in: ['OPERATIONS', 'STAFF'] } }, ...(own ? [own] : [])] };
  }
  if (can(session.role, 'document:read_own')) {
    return { ...base, OR: [{ visibility: 'STAFF' }, ...(own ? [own] : [])] };
  }
  return { ...base, id: '__keines__' };
}

const include = {
  currentVersion: { include: { file: { select: { id: true, filename: true, mimeType: true, sizeBytes: true, url: true, path: true } } } },
  subjectEmployee: { select: { id: true, user: { select: { firstName: true, lastName: true } } } },
  supplier: { select: { id: true, name: true } },
  _count: { select: { versions: true } },
} satisfies Prisma.ManagedDocumentInclude;

export async function listDocuments(
  session: SessionUser,
  organizationId: string,
  query: { q?: string; category?: string; visibility?: string; tag?: string; ablaufTage?: number; page: number; pageSize: number },
) {
  const where: Prisma.ManagedDocumentWhereInput = {
    AND: [
      documentVisibilityWhere(session, organizationId),
      query.category ? { category: query.category as never } : {},
      query.visibility ? { visibility: query.visibility as never } : {},
      query.tag ? { tags: { has: query.tag } } : {},
      query.ablaufTage ? { expiresOn: { gte: today(), lte: addDays(today(), query.ablaufTage) } } : {},
      query.q ? { OR: [{ title: { contains: query.q, mode: 'insensitive' } }, { description: { contains: query.q, mode: 'insensitive' } }, { tags: { has: query.q } }] } : {},
    ],
  };
  const [items, total] = await Promise.all([
    prisma.managedDocument.findMany({
      where,
      include,
      orderBy: [{ expiresOn: { sort: 'asc', nulls: 'last' } }, { updatedAt: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.managedDocument.count({ where }),
  ]);
  return { items, total };
}

export async function getDocument(session: SessionUser, organizationId: string, id: string) {
  const document = await prisma.managedDocument.findFirst({
    where: { ...documentVisibilityWhere(session, organizationId), id },
    include: {
      ...include,
      versions: { orderBy: { version: 'desc' }, include: { file: { select: { id: true, filename: true, mimeType: true, sizeBytes: true, createdAt: true } } } },
    },
  });
  if (!document) throw new NotFoundError('Dokument');
  return document;
}

function defaultVisibility(input: { category: string; visibility?: string }): DocumentVisibility {
  if (input.visibility) return input.visibility as DocumentVisibility;
  return input.category === 'EMPLOYEE' ? 'EMPLOYEE_PRIVATE' : 'MANAGEMENT';
}

export async function createDocument(session: SessionUser, organizationId: string, input: CreateDocumentInput) {
  const visibility = defaultVisibility(input);
  if (visibility === 'EMPLOYEE_PRIVATE' && !input.subjectEmployeeId) {
    throw new BusinessRuleError('Ein Personaldokument braucht die betroffene Person — sonst weiss niemand, wer es sehen darf.');
  }
  if (input.subjectEmployeeId && !(await prisma.employee.findFirst({ where: { id: input.subjectEmployeeId, organizationId } }))) {
    throw new NotFoundError('Mitarbeitende Person');
  }

  const document = await prisma.$transaction(async (tx) => {
    const doc = await tx.managedDocument.create({
      data: {
        organizationId,
        title: input.title,
        category: input.category,
        visibility,
        description: input.description ?? null,
        tags: input.tags,
        subjectEmployeeId: input.subjectEmployeeId ?? null,
        supplierId: input.supplierId ?? null,
        validFrom: input.validFrom ?? null,
        expiresOn: input.expiresOn ?? null,
        reminderDaysBefore: input.reminderDaysBefore,
        createdById: session.id,
      },
    });
    if (input.file) {
      const file = await tx.fileAsset.create({
        data: { organizationId, path: input.file.path, url: input.file.url, filename: input.file.filename, mimeType: input.file.mimeType, sizeBytes: input.file.sizeBytes, scope: 'DOCUMENT', isPublic: false, uploadedById: session.id },
      });
      const version = await tx.documentVersion.create({
        data: { documentId: doc.id, version: 1, fileAssetId: file.id, changeNote: input.changeNote ?? null, uploadedById: session.id },
      });
      await tx.managedDocument.update({ where: { id: doc.id }, data: { currentVersionId: version.id } });
    }
    return doc;
  });
  await audit.created({ organizationId, userId: session.id, entity: 'ManagedDocument', entityId: document.id, summary: `Dokument „${document.title}" abgelegt (${visibility})` });
  return document;
}

export async function updateDocument(session: SessionUser, organizationId: string, id: string, input: UpdateDocumentInput) {
  const before = await prisma.managedDocument.findFirst({ where: { ...documentVisibilityWhere(session, organizationId), id } });
  if (!before) throw new NotFoundError('Dokument');
  const visibility = input.visibility ?? (input.category === 'EMPLOYEE' && before.category !== 'EMPLOYEE' ? 'EMPLOYEE_PRIVATE' : before.visibility);
  const subject = input.subjectEmployeeId === undefined ? before.subjectEmployeeId : input.subjectEmployeeId;
  if (visibility === 'EMPLOYEE_PRIVATE' && !subject) {
    throw new BusinessRuleError('Ein Personaldokument braucht die betroffene Person.');
  }
  const document = await prisma.managedDocument.update({
    where: { id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      visibility,
      ...(input.description !== undefined ? { description: input.description || null } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.subjectEmployeeId !== undefined ? { subjectEmployeeId: input.subjectEmployeeId } : {}),
      ...(input.supplierId !== undefined ? { supplierId: input.supplierId } : {}),
      ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
      ...(input.expiresOn !== undefined ? { expiresOn: input.expiresOn, expiryNotifiedAt: null } : {}),
      ...(input.reminderDaysBefore !== undefined ? { reminderDaysBefore: input.reminderDaysBefore } : {}),
    },
  });
  await audit.updated({ organizationId, userId: session.id, entity: 'ManagedDocument', entityId: id, summary: `Dokument „${document.title}" geändert`, changes: input });
  return document;
}

export async function addDocumentVersion(session: SessionUser, organizationId: string, id: string, input: AddDocumentVersionInput) {
  const document = await prisma.managedDocument.findFirst({
    where: { ...documentVisibilityWhere(session, organizationId), id },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  });
  if (!document) throw new NotFoundError('Dokument');
  const nextVersion = (document.versions[0]?.version ?? 0) + 1;
  const version = await prisma.$transaction(async (tx) => {
    const file = await tx.fileAsset.create({
      data: { organizationId, path: input.file.path, url: input.file.url, filename: input.file.filename, mimeType: input.file.mimeType, sizeBytes: input.file.sizeBytes, scope: 'DOCUMENT', isPublic: false, uploadedById: session.id },
    });
    const created = await tx.documentVersion.create({
      data: { documentId: id, version: nextVersion, fileAssetId: file.id, changeNote: input.changeNote ?? null, uploadedById: session.id },
    });
    await tx.managedDocument.update({ where: { id }, data: { currentVersionId: created.id } });
    return created;
  });
  await audit.updated({ organizationId, userId: session.id, entity: 'ManagedDocument', entityId: id, summary: `Dokument „${document.title}": Fassung ${nextVersion} hochgeladen` });
  return version;
}

export async function deleteDocument(session: SessionUser, organizationId: string, id: string) {
  const document = await prisma.managedDocument.findFirst({ where: { ...documentVisibilityWhere(session, organizationId), id } });
  if (!document) throw new NotFoundError('Dokument');
  await prisma.managedDocument.update({ where: { id }, data: { deletedAt: new Date() } });
  await audit.deleted({ organizationId, userId: session.id, entity: 'ManagedDocument', entityId: id, summary: `Dokument „${document.title}" gelöscht` });
}

/**
 * Download einer Fassung — protokolliert, mit befristetem Verweis.
 *
 * Ohne `version` die geltende Fassung. Die Sichtbarkeit wird über das
 * Dokument geprüft, nie über die Datei: eine `FileAsset`-ID allein öffnet
 * hier nichts.
 */
export async function resolveDocumentDownload(session: SessionUser, organizationId: string, id: string, version?: number, ip?: string | null) {
  const document = await prisma.managedDocument.findFirst({
    where: { ...documentVisibilityWhere(session, organizationId), id },
    include: { currentVersion: { include: { file: true } } },
  });
  if (!document) throw new NotFoundError('Dokument');
  const target = version
    ? await prisma.documentVersion.findFirst({ where: { documentId: id, version }, include: { file: true } })
    : document.currentVersion;
  if (!target) throw new NotFoundError('Fassung');
  const url = await createSignedDownloadUrl(target.file.path, 600);
  await audit.exported({
    organizationId,
    userId: session.id,
    entity: 'ManagedDocument',
    entityId: id,
    summary: `Dokument „${document.title}" (Fassung ${target.version}) heruntergeladen`,
    ip,
  });
  return { url, filename: target.file.filename, mimeType: target.file.mimeType };
}

/** Nachtlauf: ablaufende Dokumente einmal melden. */
export async function notifyExpiringDocuments(organizationId: string): Promise<number> {
  const now = today();
  const candidates = await prisma.managedDocument.findMany({
    where: { organizationId, deletedAt: null, expiresOn: { not: null, gte: now }, expiryNotifiedAt: null },
    select: { id: true, title: true, expiresOn: true, reminderDaysBefore: true, createdById: true },
  });
  const due = candidates.filter((d) => d.expiresOn! <= addDays(now, d.reminderDaysBefore));
  if (due.length === 0) return 0;

  const recipients = await prisma.user.findMany({
    where: { organizationId, role: { in: ['ADMIN', 'SUPER_ADMIN'] }, status: 'ACTIVE', deletedAt: null },
    select: { id: true },
  });
  const lines = due.map((d) => `${d.title} — läuft am ${d.expiresOn!.toISOString().slice(0, 10)} ab`);
  for (const user of recipients) {
    await notify({
      userId: user.id,
      channels: ['IN_APP'],
      title: due.length === 1 ? 'Ein Dokument läuft bald ab' : `${due.length} Dokumente laufen bald ab`,
      body: lines.slice(0, 5).join('\n'),
      link: '/admin/fuehrung/dokumente?ablaufTage=30',
      entity: 'ManagedDocument',
    });
  }
  await prisma.managedDocument.updateMany({ where: { id: { in: due.map((d) => d.id) } }, data: { expiryNotifiedAt: now } });
  return due.length;
}
