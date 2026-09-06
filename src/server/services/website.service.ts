import 'server-only';

import { revalidatePath } from 'next/cache';
import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import { audit, diff } from '@/lib/audit';
import { BusinessRuleError, ConflictError, NotFoundError } from '@/lib/errors';
import type {
  CreateFaqInput,
  CreateGalleryItemInput,
  CreateJobPostingInput,
  UpdateFaqInput,
  UpdateGalleryItemInput,
  UpdateJobPostingInput,
  WebsiteReorderInput,
} from '@/lib/validation/website';

/**
 * Redaktionelle Objekte der Website: häufige Fragen, Referenzbilder,
 * Stellenangebote.
 *
 * Architekturentscheide:
 *
 *  • **Jede Änderung erneuert den betroffenen Seitenbaum.** Die öffentlichen
 *    Seiten sind statisch erzeugt; ohne `revalidatePath` speichert die
 *    Redaktion, sieht nichts und hält das Speichern für kaputt. Anders als
 *    beim Katalog reicht hier meist ein gezielter Pfad — eine FAQ erscheint
 *    auf `/faq` und auf der Startseite, nicht überall.
 *
 *  • **Kein Papierkorb.** Diese Datensätze sind klein und schnell neu
 *    erfasst; ein Papierkorb wäre mehr Verwaltung als Nutzen. Ein
 *    Stellenangebot mit Bewerbungen daran ist die Ausnahme — es lässt sich
 *    archivieren statt löschen.
 */

interface Actor {
  organizationId: string;
  actorId: string;
  ip?: string | null;
}

// ---------------------------------------------------------------------------
//  Häufige Fragen
// ---------------------------------------------------------------------------

export async function listFaqs(organizationId: string) {
  return prisma.faq.findMany({
    where: { organizationId },
    orderBy: [{ category: 'asc' }, { position: 'asc' }],
  });
}

export async function createFaq({ organizationId, actorId, ip, input }: Actor & { input: CreateFaqInput }) {
  const faq = await prisma.faq.create({
    data: {
      organizationId,
      question: input.question,
      answer: input.answer,
      category: input.category,
      locale: input.locale,
      position: input.position,
      active: input.active,
    },
  });

  await audit.created({
    organizationId,
    userId: actorId,
    entity: 'Faq',
    entityId: faq.id,
    summary: `Frage „${faq.question}" angelegt`,
    ip,
  });

  revalidatePath('/faq');
  revalidatePath('/');
  return faq;
}

export async function updateFaq({
  organizationId,
  actorId,
  ip,
  faqId,
  input,
}: Actor & { faqId: string; input: UpdateFaqInput }) {
  const before = await prisma.faq.findFirst({ where: { id: faqId, organizationId } });
  if (!before) throw new NotFoundError('Frage');

  const faq = await prisma.faq.update({
    where: { id: faqId },
    data: {
      ...(input.question !== undefined ? { question: input.question } : {}),
      ...(input.answer !== undefined ? { answer: input.answer } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    },
  });

  await audit.updated({
    organizationId,
    userId: actorId,
    entity: 'Faq',
    entityId: faqId,
    summary: `Frage „${faq.question}" geändert`,
    changes: diff(before as Record<string, unknown>, faq as Record<string, unknown>),
    ip,
  });

  revalidatePath('/faq');
  revalidatePath('/');
  return faq;
}

export async function deleteFaq({ organizationId, actorId, ip, faqId }: Actor & { faqId: string }) {
  const faq = await prisma.faq.findFirst({ where: { id: faqId, organizationId } });
  if (!faq) throw new NotFoundError('Frage');

  await prisma.faq.delete({ where: { id: faqId } });

  await audit.deleted({
    organizationId,
    userId: actorId,
    entity: 'Faq',
    entityId: faqId,
    summary: `Frage „${faq.question}" gelöscht`,
    ip,
  });

  revalidatePath('/faq');
  revalidatePath('/');
}

// ---------------------------------------------------------------------------
//  Galerie
// ---------------------------------------------------------------------------

export async function listGalleryItems(organizationId: string) {
  return prisma.galleryItem.findMany({
    where: { organizationId },
    orderBy: [{ position: 'asc' }, { createdAt: 'desc' }],
  });
}

export async function createGalleryItem({
  organizationId,
  actorId,
  ip,
  input,
}: Actor & { input: CreateGalleryItemInput }) {
  const item = await prisma.galleryItem.create({
    data: {
      organizationId,
      title: input.title,
      description: input.description ?? null,
      serviceKind: input.serviceKind ?? null,
      beforeUrl: input.beforeUrl,
      afterUrl: input.afterUrl,
      location: input.location ?? null,
      featured: input.featured,
      position: input.position,
      published: input.published,
    },
  });

  await audit.created({
    organizationId,
    userId: actorId,
    entity: 'GalleryItem',
    entityId: item.id,
    summary: `Galerieeintrag „${item.title}" angelegt`,
    ip,
  });

  revalidateGallery();
  return item;
}

export async function updateGalleryItem({
  organizationId,
  actorId,
  ip,
  itemId,
  input,
}: Actor & { itemId: string; input: UpdateGalleryItemInput }) {
  const before = await prisma.galleryItem.findFirst({ where: { id: itemId, organizationId } });
  if (!before) throw new NotFoundError('Galerieeintrag');

  /**
   * Beim Teil-Update gegen den gespeicherten Stand prüfen: sonst liesse sich
   * das Nachher-Bild auf die Adresse des Vorher-Bildes setzen, und der
   * Schieberegler auf der Startseite zeigte nichts mehr.
   */
  const beforeUrl = input.beforeUrl ?? before.beforeUrl;
  const afterUrl = input.afterUrl ?? before.afterUrl;
  if (beforeUrl === afterUrl) {
    throw new BusinessRuleError(
      'Vorher und Nachher zeigen dasselbe Bild — der Vergleich bliebe leer.',
    );
  }

  const item = await prisma.galleryItem.update({
    where: { id: itemId },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description ?? null } : {}),
      ...(input.serviceKind !== undefined ? { serviceKind: input.serviceKind ?? null } : {}),
      ...(input.beforeUrl !== undefined ? { beforeUrl: input.beforeUrl } : {}),
      ...(input.afterUrl !== undefined ? { afterUrl: input.afterUrl } : {}),
      ...(input.location !== undefined ? { location: input.location ?? null } : {}),
      ...(input.featured !== undefined ? { featured: input.featured } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
      ...(input.published !== undefined ? { published: input.published } : {}),
    },
  });

  await audit.updated({
    organizationId,
    userId: actorId,
    entity: 'GalleryItem',
    entityId: itemId,
    summary: `Galerieeintrag „${item.title}" geändert`,
    changes: diff(before as Record<string, unknown>, item as Record<string, unknown>),
    ip,
  });

  revalidateGallery();
  return item;
}

export async function deleteGalleryItem({
  organizationId,
  actorId,
  ip,
  itemId,
}: Actor & { itemId: string }) {
  const item = await prisma.galleryItem.findFirst({ where: { id: itemId, organizationId } });
  if (!item) throw new NotFoundError('Galerieeintrag');

  await prisma.galleryItem.delete({ where: { id: itemId } });

  await audit.deleted({
    organizationId,
    userId: actorId,
    entity: 'GalleryItem',
    entityId: itemId,
    summary: `Galerieeintrag „${item.title}" gelöscht`,
    ip,
  });

  revalidateGallery();
}

function revalidateGallery(): void {
  revalidatePath('/galerie');
  // Der hervorgehobene Eintrag steht im Kopfbereich der Startseite.
  revalidatePath('/');
}

// ---------------------------------------------------------------------------
//  Stellenangebote
// ---------------------------------------------------------------------------

export async function listJobPostings(organizationId: string) {
  return prisma.jobPosting.findMany({
    where: { organizationId },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    include: { _count: { select: { applications: true } } },
  });
}

export async function createJobPosting({
  organizationId,
  actorId,
  ip,
  input,
}: Actor & { input: CreateJobPostingInput }) {
  try {
    const posting = await prisma.jobPosting.create({
      data: {
        organizationId,
        slug: input.slug,
        title: input.title,
        location: input.location,
        employmentType: input.employmentType,
        workloadFrom: input.workloadFrom,
        workloadTo: input.workloadTo,
        description: input.description,
        requirements: input.requirements,
        benefits: input.benefits,
        salaryFrom: input.salaryFrom ?? null,
        salaryTo: input.salaryTo ?? null,
        status: input.status,
        // Das Veröffentlichungsdatum entsteht beim Veröffentlichen, nicht beim
        // Anlegen — ein Entwurf hat kein Datum.
        publishedAt: input.status === 'PUBLISHED' ? new Date() : null,
        closesAt: input.closesAt ? new Date(`${input.closesAt}T00:00:00.000Z`) : null,
      },
    });

    await audit.created({
      organizationId,
      userId: actorId,
      entity: 'JobPosting',
      entityId: posting.id,
      summary: `Stellenangebot „${posting.title}" angelegt`,
      ip,
    });

    revalidateCareers();
    return posting;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictError('Dieser Kurzname ist bereits vergeben.');
    }
    throw error;
  }
}

export async function updateJobPosting({
  organizationId,
  actorId,
  ip,
  postingId,
  input,
}: Actor & { postingId: string; input: UpdateJobPostingInput }) {
  const before = await prisma.jobPosting.findFirst({ where: { id: postingId, organizationId } });
  if (!before) throw new NotFoundError('Stellenangebot');

  // Beim ersten Veröffentlichen das Datum setzen — und nie wieder ändern:
  // sonst rutschte die Anzeige bei jeder Korrektur in Stellenportalen nach
  // oben, als wäre sie neu.
  const publishing = input.status === 'PUBLISHED' && before.status !== 'PUBLISHED';

  try {
    const posting = await prisma.jobPosting.update({
      where: { id: postingId },
      data: {
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
        ...(input.employmentType !== undefined ? { employmentType: input.employmentType } : {}),
        ...(input.workloadFrom !== undefined ? { workloadFrom: input.workloadFrom } : {}),
        ...(input.workloadTo !== undefined ? { workloadTo: input.workloadTo } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.requirements !== undefined ? { requirements: input.requirements } : {}),
        ...(input.benefits !== undefined ? { benefits: input.benefits } : {}),
        ...(input.salaryFrom !== undefined ? { salaryFrom: input.salaryFrom ?? null } : {}),
        ...(input.salaryTo !== undefined ? { salaryTo: input.salaryTo ?? null } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(publishing ? { publishedAt: before.publishedAt ?? new Date() } : {}),
        ...(input.closesAt !== undefined
          ? { closesAt: input.closesAt ? new Date(`${input.closesAt}T00:00:00.000Z`) : null }
          : {}),
      },
    });

    await audit.updated({
      organizationId,
      userId: actorId,
      entity: 'JobPosting',
      entityId: postingId,
      summary: `Stellenangebot „${posting.title}" geändert`,
      changes: diff(before as Record<string, unknown>, posting as Record<string, unknown>),
      ip,
    });

    revalidateCareers();
    return posting;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictError('Dieser Kurzname ist bereits vergeben.');
    }
    throw error;
  }
}

export async function deleteJobPosting({
  organizationId,
  actorId,
  ip,
  postingId,
}: Actor & { postingId: string }) {
  const posting = await prisma.jobPosting.findFirst({
    where: { id: postingId, organizationId },
    include: { _count: { select: { applications: true } } },
  });
  if (!posting) throw new NotFoundError('Stellenangebot');

  /**
   * Bewerbungen sind Personendaten mit Aufbewahrungspflicht und einem
   * Anspruch auf Auskunft. Eine Bewerbung ohne die Stelle, auf die sie sich
   * bezieht, ist nicht mehr beauskunftbar — deshalb wird archiviert statt
   * gelöscht.
   */
  if (posting._count.applications > 0) {
    throw new BusinessRuleError(
      `Auf dieses Angebot liegen ${posting._count.applications} Bewerbungen. Archivieren Sie es stattdessen — ` +
        'eine Bewerbung ohne zugehörige Stelle liesse sich gegenüber der bewerbenden Person nicht mehr erklären.',
    );
  }

  await prisma.jobPosting.delete({ where: { id: postingId } });

  await audit.deleted({
    organizationId,
    userId: actorId,
    entity: 'JobPosting',
    entityId: postingId,
    summary: `Stellenangebot „${posting.title}" gelöscht`,
    ip,
  });

  revalidateCareers();
}

function revalidateCareers(): void {
  revalidatePath('/karriere');
  revalidatePath('/karriere/[slug]', 'page');
}

// ---------------------------------------------------------------------------
//  Reihenfolge
// ---------------------------------------------------------------------------

export async function reorderWebsite({
  organizationId,
  actorId,
  ip,
  input,
}: Actor & { input: WebsiteReorderInput }) {
  const { entity, ids } = input;

  const owned =
    entity === 'faq'
      ? await prisma.faq.findMany({ where: { organizationId, id: { in: ids } }, select: { id: true } })
      : await prisma.galleryItem.findMany({
          where: { organizationId, id: { in: ids } },
          select: { id: true },
        });

  const allowed = new Set(owned.map((row) => row.id));
  const ordered = ids.filter((id) => allowed.has(id));
  if (ordered.length === 0) throw new NotFoundError('Einträge');

  await prisma.$transaction(
    ordered.map((id, index) =>
      entity === 'faq'
        ? prisma.faq.update({ where: { id }, data: { position: index } })
        : prisma.galleryItem.update({ where: { id }, data: { position: index } }),
    ),
  );

  await audit.updated({
    organizationId,
    userId: actorId,
    entity: entity === 'faq' ? 'Faq' : 'GalleryItem',
    summary: `Reihenfolge geändert (${ordered.length} Einträge)`,
    ip,
  });

  if (entity === 'faq') {
    revalidatePath('/faq');
    revalidatePath('/');
  } else {
    revalidateGallery();
  }

  return { updated: ordered.length };
}
