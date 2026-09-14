import 'server-only';

import type { FileScope, Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import { logger } from '@/lib/logger';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { deleteFile } from '@/lib/storage';

const log = logger('media');

/**
 * Mediathek.
 *
 * Architekturentscheide:
 *
 *  • **Die Datenbankzeile ist die Wahrheit, der Speicher folgt.** Beim
 *    Löschen wird zuerst die Datei im Objektspeicher entfernt und danach die
 *    Zeile. Andersherum entstünde bei einem Abbruch eine verwaiste Datei, die
 *    niemand mehr findet — aber weiterhin bezahlt wird. In dieser Reihenfolge
 *    entsteht im schlimmsten Fall eine Zeile ohne Datei, und die ist sichtbar
 *    und behebbar.
 *
 *  • **Verknüpfte Dateien lassen sich nicht einfach entfernen.** Ein Bild, das
 *    an einer Rechnung, einem Einsatzrapport oder einer Bewerbung hängt, ist
 *    Teil eines Belegs. Die Antwort nennt, woran es hängt.
 *
 *  • **Ein Fehlschlag im Objektspeicher wird protokolliert, nicht
 *    verschluckt.** Wenn Supabase nicht erreichbar ist, soll die Zeile
 *    stehenbleiben und die Person es erfahren — eine gelöschte Zeile mit
 *    zurückbleibender Datei wäre der stille Fall.
 */

export interface MediaFilter {
  organizationId: string;
  scope?: FileScope;
  q?: string;
  /** Nur Bilder — der häufigste Fall in der Mediathek. */
  imagesOnly?: boolean;
  page: number;
  pageSize: number;
}

export async function listMedia(filter: MediaFilter) {
  const where: Prisma.FileAssetWhereInput = {
    organizationId: filter.organizationId,
    ...(filter.scope ? { scope: filter.scope } : {}),
    ...(filter.imagesOnly ? { mimeType: { startsWith: 'image/' } } : {}),
    ...(filter.q ? { filename: { contains: filter.q, mode: 'insensitive' } } : {}),
  };

  const [items, total, sums] = await Promise.all([
    prisma.fileAsset.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
      select: {
        id: true,
        filename: true,
        url: true,
        mimeType: true,
        sizeBytes: true,
        scope: true,
        isPublic: true,
        createdAt: true,
        bookingId: true,
        quoteId: true,
        invoiceId: true,
        jobId: true,
        customerId: true,
        employeeId: true,
        propertyId: true,
        expenseId: true,
        messageId: true,
        applicationId: true,
      },
    }),
    prisma.fileAsset.count({ where }),
    prisma.fileAsset.aggregate({ where, _sum: { sizeBytes: true } }),
  ]);

  return { items, total, totalBytes: sums._sum.sizeBytes ?? 0 };
}

/** Woran hängt die Datei? Leere Liste = frei löschbar. */
export function attachmentsOf(file: {
  bookingId: string | null;
  quoteId: string | null;
  invoiceId: string | null;
  jobId: string | null;
  customerId: string | null;
  employeeId: string | null;
  propertyId: string | null;
  expenseId: string | null;
  messageId: string | null;
  applicationId: string | null;
}): string[] {
  const links: [string | null, string][] = [
    [file.invoiceId, 'einer Rechnung'],
    [file.quoteId, 'einer Offerte'],
    [file.bookingId, 'einer Buchung'],
    [file.jobId, 'einem Einsatz'],
    [file.expenseId, 'einer Ausgabe'],
    [file.applicationId, 'einer Bewerbung'],
    [file.customerId, 'einer Kundenakte'],
    [file.employeeId, 'einer Personalakte'],
    [file.propertyId, 'einem Objekt'],
    [file.messageId, 'einer Nachricht'],
  ];
  return links.filter(([id]) => id).map(([, label]) => label);
}

export async function deleteMedia({
  organizationId,
  actorId,
  ip,
  fileId,
  force,
}: {
  organizationId: string;
  actorId: string;
  ip?: string | null;
  fileId: string;
  /** true = auch löschen, wenn die Datei an einem Beleg hängt. */
  force?: boolean;
}) {
  const file = await prisma.fileAsset.findFirst({ where: { id: fileId, organizationId } });
  if (!file) throw new NotFoundError('Datei');

  const links = attachmentsOf(file);
  if (links.length > 0 && !force) {
    throw new BusinessRuleError(
      `„${file.filename}" hängt an ${links.join(' und ')}. Das Löschen würde dort eine Lücke hinterlassen — ` +
        'entfernen Sie die Datei zuerst dort, oder bestätigen Sie das Löschen ausdrücklich.',
    );
  }

  /**
   * Erst der Speicher, dann die Zeile.
   *
   * Andersherum bliebe bei einem Abbruch eine Datei zurück, die niemand mehr
   * findet — und für die weiterhin bezahlt wird. In dieser Reihenfolge bleibt
   * im schlimmsten Fall eine Zeile ohne Datei: sichtbar und behebbar.
   */
  try {
    await deleteFile(file.path);
  } catch (error) {
    log.error('Datei konnte im Speicher nicht entfernt werden', {
      fileId,
      path: file.path,
      error,
    });
    throw new BusinessRuleError(
      'Die Datei konnte im Speicher nicht entfernt werden. Der Eintrag bleibt bestehen — bitte später erneut versuchen.',
    );
  }

  await prisma.fileAsset.delete({ where: { id: fileId } });

  await audit.deleted({
    organizationId,
    userId: actorId,
    entity: 'FileAsset',
    entityId: fileId,
    summary: `Datei „${file.filename}" gelöscht (${Math.round(file.sizeBytes / 1024)} kB)`,
    ip,
  });
}

/** Dateiname und Zuordnung ändern. */
export async function updateMedia({
  organizationId,
  actorId,
  ip,
  fileId,
  filename,
  scope,
}: {
  organizationId: string;
  actorId: string;
  ip?: string | null;
  fileId: string;
  filename?: string;
  scope?: FileScope;
}) {
  const before = await prisma.fileAsset.findFirst({ where: { id: fileId, organizationId } });
  if (!before) throw new NotFoundError('Datei');

  const file = await prisma.fileAsset.update({
    where: { id: fileId },
    data: {
      ...(filename !== undefined ? { filename } : {}),
      ...(scope !== undefined ? { scope } : {}),
    },
  });

  await audit.updated({
    organizationId,
    userId: actorId,
    entity: 'FileAsset',
    entityId: fileId,
    summary: `Datei „${file.filename}" geändert`,
    changes: {
      ...(filename !== undefined && filename !== before.filename
        ? { filename: { from: before.filename, to: filename } }
        : {}),
      ...(scope !== undefined && scope !== before.scope
        ? { scope: { from: before.scope, to: scope } }
        : {}),
    },
    ip,
  });

  return file;
}

/** Datei nach dem Upload registrieren. */
export async function registerMedia({
  organizationId,
  actorId,
  ip,
  input,
}: {
  organizationId: string;
  actorId: string;
  ip?: string | null;
  input: {
    bucket: string;
    path: string;
    url: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    scope: FileScope;
    isPublic: boolean;
  };
}) {
  const file = await prisma.fileAsset.create({
    data: {
      organizationId,
      bucket: input.bucket,
      path: input.path,
      url: input.url,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      scope: input.scope,
      isPublic: input.isPublic,
      uploadedById: actorId,
    },
  });

  await audit.created({
    organizationId,
    userId: actorId,
    entity: 'FileAsset',
    entityId: file.id,
    summary: `Datei „${file.filename}" hochgeladen (${Math.round(file.sizeBytes / 1024)} kB)`,
    ip,
  });

  return file;
}
