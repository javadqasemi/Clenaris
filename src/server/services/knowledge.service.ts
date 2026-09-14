import 'server-only';

import type { DocumentVisibility, Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import { can } from '@/lib/auth/rbac';
import type { SessionUser } from '@/lib/auth/session';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { slugify } from '@/lib/utils';
import { addDays, today } from '@/lib/bi/periods';
import type {
  CreateAnalysisBoardInput,
  CreateArticleInput,
  CreateCompetitorInput,
  CreateMarketInsightInput,
  UpdateAnalysisBoardInput,
  UpdateArticleInput,
  UpdateCompetitorInput,
  UpdateMarketInsightInput,
} from '@/lib/validation/bi-knowledge';

/**
 * Wissensdatenbank, Wettbewerber, Marktbeobachtungen, Analysetafeln.
 *
 * Die Wissensartikel tragen dieselbe Sichtbarkeitsstufe wie Dokumente, aber
 * ohne `EMPLOYEE_PRIVATE` — ein Artikel ist nie eine Personalakte. Entwürfe
 * sieht nur, wer schreiben darf.
 */

export function articleVisibilityWhere(session: SessionUser, organizationId: string): Prisma.KnowledgeArticleWhereInput {
  const base: Prisma.KnowledgeArticleWhereInput = { organizationId, deletedAt: null };
  const levels: DocumentVisibility[] =
    session.role === 'SUPER_ADMIN' || session.role === 'ADMIN'
      ? ['MANAGEMENT', 'OPERATIONS', 'STAFF']
      : session.role === 'MANAGER'
        ? ['OPERATIONS', 'STAFF']
        : ['STAFF'];
  const editor = can(session.role, 'knowledge:update');
  return { ...base, visibility: { in: levels }, ...(editor ? {} : { status: 'PUBLISHED' }) };
}

const articleInclude = { author: { select: { id: true, firstName: true, lastName: true } } } satisfies Prisma.KnowledgeArticleInclude;

export async function listArticles(
  session: SessionUser,
  organizationId: string,
  query: { q?: string; category?: string; status?: string; tag?: string; page: number; pageSize: number },
) {
  const where: Prisma.KnowledgeArticleWhereInput = {
    AND: [
      articleVisibilityWhere(session, organizationId),
      query.category ? { category: query.category } : {},
      query.status ? { status: query.status as never } : {},
      query.tag ? { tags: { has: query.tag } } : {},
      query.q ? { OR: [{ title: { contains: query.q, mode: 'insensitive' } }, { summary: { contains: query.q, mode: 'insensitive' } }, { body: { contains: query.q, mode: 'insensitive' } }] } : {},
    ],
  };
  const [items, total] = await Promise.all([
    prisma.knowledgeArticle.findMany({
      where,
      include: articleInclude,
      orderBy: [{ category: 'asc' }, { title: 'asc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.knowledgeArticle.count({ where }),
  ]);
  return { items, total };
}

export async function getArticleBySlug(session: SessionUser, organizationId: string, slug: string) {
  const article = await prisma.knowledgeArticle.findFirst({
    where: { ...articleVisibilityWhere(session, organizationId), slug },
    include: { ...articleInclude, files: { orderBy: { createdAt: 'desc' } } },
  });
  if (!article) throw new NotFoundError('Artikel');
  return article;
}

async function uniqueSlug(organizationId: string, title: string, excludeId?: string): Promise<string> {
  const base = slugify(title) || 'artikel';
  let slug = base;
  for (let i = 2; i < 100; i += 1) {
    const clash = await prisma.knowledgeArticle.findFirst({ where: { organizationId, slug, ...(excludeId ? { id: { not: excludeId } } : {}) }, select: { id: true } });
    if (!clash) return slug;
    slug = `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}

export async function createArticle(session: SessionUser, organizationId: string, input: CreateArticleInput) {
  const article = await prisma.knowledgeArticle.create({
    data: {
      organizationId,
      slug: await uniqueSlug(organizationId, input.title),
      title: input.title,
      summary: input.summary ?? null,
      body: input.body,
      category: input.category,
      tags: input.tags,
      status: input.status,
      visibility: input.visibility,
      videoUrl: input.videoUrl ?? null,
      reviewIntervalDays: input.reviewIntervalDays ?? null,
      nextReviewAt: input.reviewIntervalDays ? addDays(today(), input.reviewIntervalDays) : null,
      publishedAt: input.status === 'PUBLISHED' ? new Date() : null,
      authorId: session.id,
    },
  });
  await audit.created({ organizationId, userId: session.id, entity: 'KnowledgeArticle', entityId: article.id, summary: `Wissensartikel „${article.title}" verfasst` });
  return article;
}

export async function updateArticle(session: SessionUser, organizationId: string, id: string, input: UpdateArticleInput) {
  const before = await prisma.knowledgeArticle.findFirst({ where: { id, organizationId, deletedAt: null } });
  if (!before) throw new NotFoundError('Artikel');
  const article = await prisma.knowledgeArticle.update({
    where: { id },
    data: {
      ...(input.title !== undefined ? { title: input.title, slug: await uniqueSlug(organizationId, input.title, id) } : {}),
      ...(input.summary !== undefined ? { summary: input.summary || null } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.status !== undefined ? { status: input.status, publishedAt: input.status === 'PUBLISHED' ? (before.publishedAt ?? new Date()) : before.publishedAt } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(input.videoUrl !== undefined ? { videoUrl: input.videoUrl } : {}),
      ...(input.reviewIntervalDays !== undefined ? { reviewIntervalDays: input.reviewIntervalDays, nextReviewAt: input.reviewIntervalDays ? addDays(today(), input.reviewIntervalDays) : null } : {}),
    },
  });
  await audit.updated({ organizationId, userId: session.id, entity: 'KnowledgeArticle', entityId: id, summary: `Wissensartikel „${article.title}" geändert`, changes: { ...input, body: input.body ? '[geändert]' : undefined } });
  return article;
}

export async function deleteArticle(session: SessionUser, organizationId: string, id: string) {
  const article = await prisma.knowledgeArticle.findFirst({ where: { id, organizationId, deletedAt: null } });
  if (!article) throw new NotFoundError('Artikel');
  await prisma.knowledgeArticle.update({ where: { id }, data: { deletedAt: new Date() } });
  await audit.deleted({ organizationId, userId: session.id, entity: 'KnowledgeArticle', entityId: id, summary: `Wissensartikel „${article.title}" gelöscht` });
}

// ---------------------------------------------------------------------------
//  Wettbewerber
// ---------------------------------------------------------------------------

export async function listCompetitors(organizationId: string) {
  return prisma.competitor.findMany({ where: { organizationId, deletedAt: null }, orderBy: { name: 'asc' } });
}

export async function createCompetitor(session: SessionUser, organizationId: string, input: CreateCompetitorInput) {
  const competitor = await prisma.competitor.create({
    data: {
      organizationId,
      name: input.name,
      website: input.website ?? null,
      region: input.region ?? null,
      services: input.services,
      priceFrom: input.priceFrom ?? null,
      priceTo: input.priceTo ?? null,
      priceNote: input.priceNote ?? null,
      strengths: input.strengths ?? null,
      weaknesses: input.weaknesses ?? null,
      marketPosition: input.marketPosition ?? null,
      reviewScore: input.reviewScore ?? null,
      reviewCount: input.reviewCount ?? null,
      notes: input.notes ?? null,
      reviewIntervalDays: input.reviewIntervalDays,
      nextReviewAt: addDays(today(), input.reviewIntervalDays),
      lastReviewedAt: today(),
    },
  });
  await audit.created({ organizationId, userId: session.id, entity: 'Competitor', entityId: competitor.id, summary: `Wettbewerber „${competitor.name}" erfasst` });
  return competitor;
}

export async function updateCompetitor(session: SessionUser, organizationId: string, id: string, input: UpdateCompetitorInput) {
  const before = await prisma.competitor.findFirst({ where: { id, organizationId, deletedAt: null } });
  if (!before) throw new NotFoundError('Wettbewerber');
  // Jede Änderung gilt als Überprüfung — wer die Preise nachträgt, hat hingeschaut.
  const competitor = await prisma.competitor.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.website !== undefined ? { website: input.website } : {}),
      ...(input.region !== undefined ? { region: input.region } : {}),
      ...(input.services !== undefined ? { services: input.services } : {}),
      ...(input.priceFrom !== undefined ? { priceFrom: input.priceFrom } : {}),
      ...(input.priceTo !== undefined ? { priceTo: input.priceTo } : {}),
      ...(input.priceNote !== undefined ? { priceNote: input.priceNote } : {}),
      ...(input.strengths !== undefined ? { strengths: input.strengths } : {}),
      ...(input.weaknesses !== undefined ? { weaknesses: input.weaknesses } : {}),
      ...(input.marketPosition !== undefined ? { marketPosition: input.marketPosition } : {}),
      ...(input.reviewScore !== undefined ? { reviewScore: input.reviewScore } : {}),
      ...(input.reviewCount !== undefined ? { reviewCount: input.reviewCount } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.reviewIntervalDays !== undefined ? { reviewIntervalDays: input.reviewIntervalDays } : {}),
      lastReviewedAt: today(),
      nextReviewAt: addDays(today(), input.reviewIntervalDays ?? before.reviewIntervalDays),
    },
  });
  await audit.updated({ organizationId, userId: session.id, entity: 'Competitor', entityId: id, summary: `Wettbewerber „${competitor.name}" aktualisiert`, changes: input });
  return competitor;
}

export async function deleteCompetitor(session: SessionUser, organizationId: string, id: string) {
  const competitor = await prisma.competitor.findFirst({ where: { id, organizationId, deletedAt: null } });
  if (!competitor) throw new NotFoundError('Wettbewerber');
  await prisma.competitor.update({ where: { id }, data: { deletedAt: new Date() } });
  await audit.deleted({ organizationId, userId: session.id, entity: 'Competitor', entityId: id, summary: `Wettbewerber „${competitor.name}" gelöscht` });
}

// ---------------------------------------------------------------------------
//  Marktbeobachtungen
// ---------------------------------------------------------------------------

export async function listMarketInsights(organizationId: string, query: { q?: string; kind?: string; faellig?: string; page: number; pageSize: number }) {
  const where: Prisma.MarketInsightWhereInput = {
    organizationId,
    deletedAt: null,
    ...(query.kind ? { kind: query.kind as never } : {}),
    ...(query.faellig === '1' ? { nextReviewAt: { lt: today() } } : {}),
    ...(query.q ? { OR: [{ title: { contains: query.q, mode: 'insensitive' } }, { body: { contains: query.q, mode: 'insensitive' } }] } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.marketInsight.findMany({ where, orderBy: { observedOn: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    prisma.marketInsight.count({ where }),
  ]);
  return { items: items.map((i) => ({ ...i, outdated: Boolean(i.nextReviewAt && i.nextReviewAt < today()) })), total };
}

export async function createMarketInsight(session: SessionUser, organizationId: string, input: CreateMarketInsightInput) {
  const insight = await prisma.marketInsight.create({
    data: {
      organizationId,
      kind: input.kind,
      title: input.title,
      body: input.body,
      sourceUrl: input.sourceUrl ?? null,
      sourceName: input.sourceName ?? null,
      observedOn: input.observedOn,
      impactNote: input.impactNote ?? null,
      reviewIntervalDays: input.reviewIntervalDays,
      nextReviewAt: addDays(input.observedOn, input.reviewIntervalDays),
      createdById: session.id,
    },
  });
  await audit.created({ organizationId, userId: session.id, entity: 'MarketInsight', entityId: insight.id, summary: `Marktbeobachtung „${insight.title}" erfasst` });
  return insight;
}

export async function updateMarketInsight(session: SessionUser, organizationId: string, id: string, input: UpdateMarketInsightInput) {
  const before = await prisma.marketInsight.findFirst({ where: { id, organizationId, deletedAt: null } });
  if (!before) throw new NotFoundError('Marktbeobachtung');
  const observedOn = input.observedOn ?? before.observedOn;
  const interval = input.reviewIntervalDays ?? before.reviewIntervalDays;
  const insight = await prisma.marketInsight.update({
    where: { id },
    data: {
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
      ...(input.sourceName !== undefined ? { sourceName: input.sourceName } : {}),
      ...(input.impactNote !== undefined ? { impactNote: input.impactNote } : {}),
      observedOn,
      reviewIntervalDays: interval,
      // Eine bestätigte Beobachtung gilt ab heute wieder — sonst bliebe sie
      // nach der Prüfung weiterhin als veraltet markiert.
      nextReviewAt: addDays(today(), interval),
    },
  });
  await audit.updated({ organizationId, userId: session.id, entity: 'MarketInsight', entityId: id, summary: `Marktbeobachtung „${insight.title}" aktualisiert`, changes: input });
  return insight;
}

export async function deleteMarketInsight(session: SessionUser, organizationId: string, id: string) {
  const insight = await prisma.marketInsight.findFirst({ where: { id, organizationId, deletedAt: null } });
  if (!insight) throw new NotFoundError('Marktbeobachtung');
  await prisma.marketInsight.update({ where: { id }, data: { deletedAt: new Date() } });
  await audit.deleted({ organizationId, userId: session.id, entity: 'MarketInsight', entityId: id, summary: `Marktbeobachtung „${insight.title}" gelöscht` });
}

// ---------------------------------------------------------------------------
//  SWOT und PESTEL
// ---------------------------------------------------------------------------

const boardInclude = {
  entries: { orderBy: [{ bucket: 'asc' as const }, { weight: 'desc' as const }, { sortOrder: 'asc' as const }] },
  supersedes: { select: { id: true, title: true, preparedOn: true } },
  supersededBy: { select: { id: true, title: true, preparedOn: true } },
} satisfies Prisma.AnalysisBoardInclude;

export async function listAnalysisBoards(organizationId: string, kind?: string) {
  return prisma.analysisBoard.findMany({
    where: { organizationId, ...(kind ? { kind: kind as never } : {}) },
    include: { _count: { select: { entries: true } }, supersededBy: { select: { id: true } } },
    orderBy: [{ kind: 'asc' }, { preparedOn: 'desc' }],
  });
}

export async function getAnalysisBoard(organizationId: string, id: string) {
  const board = await prisma.analysisBoard.findFirst({ where: { id, organizationId }, include: boardInclude });
  if (!board) throw new NotFoundError('Analysetafel');
  return board;
}

export async function createAnalysisBoard(session: SessionUser, organizationId: string, input: CreateAnalysisBoardInput) {
  if (input.supersedesId) {
    const old = await prisma.analysisBoard.findFirst({ where: { id: input.supersedesId, organizationId } });
    if (!old) throw new NotFoundError('Vorgängertafel');
    if (old.kind !== input.kind) throw new BusinessRuleError('Eine SWOT-Tafel kann nur eine SWOT-Tafel ablösen — und PESTEL nur PESTEL.');
    if (old.supersededById) throw new BusinessRuleError('Diese Tafel wurde bereits durch eine neuere Fassung abgelöst.');
  }
  const board = await prisma.$transaction(async (tx) => {
    const created = await tx.analysisBoard.create({
      data: {
        organizationId,
        kind: input.kind,
        title: input.title,
        preparedOn: input.preparedOn,
        summary: input.summary ?? null,
        reviewIntervalDays: input.reviewIntervalDays,
        nextReviewAt: addDays(input.preparedOn, input.reviewIntervalDays),
        createdById: session.id,
        entries: { create: input.entries.map((e) => ({ bucket: e.bucket, title: e.title, detail: e.detail ?? null, weight: e.weight, sortOrder: e.sortOrder })) },
      },
    });
    if (input.supersedesId) {
      await tx.analysisBoard.update({ where: { id: input.supersedesId }, data: { supersededById: created.id } });
    }
    return created;
  });
  await audit.created({ organizationId, userId: session.id, entity: 'AnalysisBoard', entityId: board.id, summary: `${input.kind}-Tafel „${board.title}" angelegt` });
  return board;
}

export async function updateAnalysisBoard(session: SessionUser, organizationId: string, id: string, input: UpdateAnalysisBoardInput) {
  const before = await prisma.analysisBoard.findFirst({ where: { id, organizationId } });
  if (!before) throw new NotFoundError('Analysetafel');
  if (before.supersededById) {
    throw new BusinessRuleError('Diese Tafel ist eine abgelöste Fassung und bleibt unverändert — bearbeiten Sie die aktuelle Fassung.');
  }
  const allowed: readonly string[] = before.kind === 'SWOT' ? ['STRENGTH', 'WEAKNESS', 'OPPORTUNITY', 'THREAT'] : ['POLITICAL', 'ECONOMIC', 'SOCIAL', 'TECHNOLOGICAL', 'ENVIRONMENTAL', 'LEGAL'];
  if (input.entries && !input.entries.every((e) => allowed.includes(e.bucket))) {
    throw new BusinessRuleError('Die Einträge passen nicht zur Art der Tafel.');
  }
  const board = await prisma.$transaction(async (tx) => {
    if (input.entries) {
      await tx.analysisEntry.deleteMany({ where: { boardId: id } });
      await tx.analysisEntry.createMany({ data: input.entries.map((e) => ({ boardId: id, bucket: e.bucket, title: e.title, detail: e.detail ?? null, weight: e.weight, sortOrder: e.sortOrder })) });
    }
    return tx.analysisBoard.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.preparedOn !== undefined ? { preparedOn: input.preparedOn } : {}),
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(input.reviewIntervalDays !== undefined ? { reviewIntervalDays: input.reviewIntervalDays } : {}),
        nextReviewAt: addDays(input.preparedOn ?? today(), input.reviewIntervalDays ?? before.reviewIntervalDays),
      },
      include: boardInclude,
    });
  });
  await audit.updated({ organizationId, userId: session.id, entity: 'AnalysisBoard', entityId: id, summary: `Tafel „${board.title}" geändert` });
  return board;
}

export async function deleteAnalysisBoard(session: SessionUser, organizationId: string, id: string) {
  const board = await prisma.analysisBoard.findFirst({ where: { id, organizationId } });
  if (!board) throw new NotFoundError('Analysetafel');
  await prisma.analysisBoard.delete({ where: { id } });
  await audit.deleted({ organizationId, userId: session.id, entity: 'AnalysisBoard', entityId: id, summary: `Tafel „${board.title}" gelöscht` });
}
