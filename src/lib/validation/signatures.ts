import { z } from 'zod';

import { cuidSchema, emailSchema, nameSchema, phoneSchema } from './common';

/**
 * Elektronische Unterzeichnung — Eingaben.
 *
 * Auffällig ist, was der öffentliche Ablauf **nicht** entgegennimmt: keinen
 * Zustimmungstext (den bestimmt der Server aus Fassung und Sprache des
 * Vorgangs), keine Kennungen von Vorgang oder Teilnehmer (die kommen aus
 * der Sitzung), keine Zeitstempel (Serverzeit), keine Adresse (Proxy-
 * Richtlinie). Der Client sagt nur, was nur er wissen kann: die Wahl,
 * den Namen, das Bild, den Code.
 */

export const SIGNATURE_ASSURANCE_LEVELS = ['LINK_ONLY', 'LINK_PLUS_EMAIL_CODE', 'LINK_PLUS_SMS_CODE'] as const;
export const SIGNATURE_ARTIFACT_MODES = ['EMBEDDED_VISUAL', 'DETACHED_EVIDENCE'] as const;
export const SIGNATURE_METHODS = ['DRAWN', 'TYPED'] as const;

/** Sichtbare Unterschrift — Punkte, Seite ab 1. Geprüft wird serverseitig gegen das PDF. */
export const signaturePlacementSchema = z.object({
  page: z.number().int().min(1).max(10_000),
  x: z.number().min(0).max(20_000),
  y: z.number().min(0).max(20_000),
  width: z.number().min(1).max(20_000),
  height: z.number().min(1).max(20_000),
});
export type SignaturePlacementInput = z.infer<typeof signaturePlacementSchema>;

const participantSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  phone: phoneSchema.optional(),
});

/**
 * Anfrage auf eine Dokumentfassung — der Referenzfluss von Gate 4B.
 *
 * `EMBEDDED_VISUAL` ist wählbar, wird aber nur angenommen, wenn die Prüfung
 * des PDF nichts findet, was nach einer vorhandenen Signatur aussieht; die
 * Vorgabe ist `DETACHED_EVIDENCE`, weil eine hochgeladene Datei fremd sein
 * kann.
 */
export const createDocumentSignatureRequestSchema = z.object({
  /** Ohne Angabe die geltende Fassung. */
  version: z.number().int().min(1).max(10_000).optional(),
  title: z.string().trim().min(2).max(200).optional(),
  assuranceLevel: z.enum(SIGNATURE_ASSURANCE_LEVELS).default('LINK_ONLY'),
  artifactMode: z.enum(SIGNATURE_ARTIFACT_MODES).default('DETACHED_EVIDENCE'),
  expiresInDays: z.number().int().min(1).max(90).default(14),
  placement: signaturePlacementSchema.optional(),
  participants: z.array(participantSchema).min(1).max(3),
  /** Sofort versenden (Vorgabe) oder als Entwurf anlegen. */
  send: z.boolean().default(true),
});
export type CreateDocumentSignatureRequestInput = z.infer<typeof createDocumentSignatureRequestSchema>;

/** Der Tausch: der einzige Aufruf, der den rohen Token trägt — im Körper, nie im Pfad. */
export const signatureExchangeSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/, 'Ungültiger Link.'),
});

export const signaturePublicIdParams = z.object({
  publicId: z.string().regex(/^[0-9a-f]{32}$/, 'Ungültige Kennung.'),
});

/** Welche der drei Dateien eines abgeschlossenen Vorgangs: A, B oder C. */
export const signatureResultArtifactParams = signaturePublicIdParams.extend({
  artifact: z.enum(['original', 'signed', 'evidence']),
});

export const signatureOtpVerifySchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Der Code besteht aus sechs Ziffern.'),
});

/**
 * Der Abschluss. `accepted` muss buchstäblich `true` sein — kein Text, keine
 * Fassung: Beides bestimmt der Server.
 */
export const signatureCompleteSchema = z
  .object({
    accepted: z.literal(true, { errorMap: () => ({ message: 'Die Zustimmung ist erforderlich.' }) }),
    method: z.enum(SIGNATURE_METHODS),
    name: z.string().trim().min(2).max(120),
    /** Nur bei DRAWN: PNG als Data-URL; die Bytes prüft der Server. */
    imageDataUrl: z
      .string()
      .max(700_000, 'Die Unterschrift ist zu gross.')
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, 'Ungültiges Unterschriftsformat.')
      .optional(),
  })
  .refine((d) => d.method !== 'DRAWN' || Boolean(d.imageDataUrl), {
    message: 'Bitte unterschreiben Sie im Feld.',
    path: ['imageDataUrl'],
  });
export type SignatureCompleteInput = z.infer<typeof signatureCompleteSchema>;

export const signatureDeclineSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const signatureCancelSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const signatureIdParams = z.object({ id: cuidSchema });

/** Verwaltung: welches Artefakt eines Vorgangs. */
export const signatureArtifactParams = z.object({
  id: cuidSchema,
  artifact: z.enum(['original', 'signed', 'evidence']),
});
