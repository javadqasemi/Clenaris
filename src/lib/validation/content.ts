import { z } from 'zod';

import { jobApplicationSchema } from './crm';

/**
 * Inhalte, Moderation und Bewerbungen.
 *
 * Alles, was auf der öffentlichen Website landet oder von dort hereinkommt.
 */

export const createBlogPostSchema = z.object({
  title: z.string().trim().min(5, 'Der Titel ist zu kurz.').max(200),
  excerpt: z.string().trim().min(10, 'Der Anriss ist zu kurz.').max(500),
  content: z.string().trim().min(100, 'Der Beitrag ist zu kurz.').max(60_000),
  seoTitle: z.string().trim().max(120).optional(),
  seoDescription: z.string().trim().max(300).optional(),
  keywords: z.array(z.string().trim().max(60)).max(15).default([]),
  categorySlug: z.string().trim().max(80).optional(),
});
export type CreateBlogPostInput = z.infer<typeof createBlogPostSchema>;

/**
 * Moderation einer Bewertung.
 *
 * `reply` verlangt mindestens zehn Zeichen: „Danke!" unter einer
 * Ein-Stern-Bewertung schadet mehr als gar keine Antwort.
 */
export const moderateReviewSchema = z.object({
  status: z.enum(['PENDING', 'PUBLISHED', 'REJECTED']).optional(),
  featured: z.boolean().optional(),
  reply: z.string().trim().min(10).max(2000).optional(),
});
export type ModerateReviewInput = z.infer<typeof moderateReviewSchema>;

export const updateApplicationSchema = z.object({
  status: z
    .enum(['RECEIVED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN'])
    .optional(),
  rating: z.number().int().min(1).max(5).nullish(),
  internalNote: z.string().trim().max(4000).optional(),
});
export type UpdateApplicationInput = z.infer<typeof updateApplicationSchema>;

/** Öffentliche Bewerbung: wie intern, plus die bereits hochgeladene CV-URL. */
export const publicApplicationSchema = jobApplicationSchema.extend({
  cvUrl: z.string().url().optional(),
});
export type PublicApplicationInput = z.infer<typeof publicApplicationSchema>;
