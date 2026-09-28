import { z } from 'zod';

import { cuidSchema } from './common';

/**
 * Eingaben der KI-Endpunkte.
 *
 * Die Obergrenzen sind keine Schikane, sondern Kostenkontrolle: jedes Zeichen
 * im Prompt kostet Token. `maxSentences`, `wordCount` und `maxLength` binden
 * ausserdem die *Ausgabe*, damit ein Modell nicht ungefragt drei Seiten
 * schreibt, wo drei Sätze verlangt waren.
 */

export const blogDraftSchema = z.object({
  topic: z.string().trim().min(5, 'Bitte nennen Sie ein Thema.').max(200),
  keywords: z.array(z.string().trim().max(60)).max(10).default([]),
  wordCount: z.number().int().min(300).max(2000).default(900),
});
export type BlogDraftInput = z.infer<typeof blogDraftSchema>;

export const dispatchSuggestSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ungültiges Datum.'),
});
export type DispatchSuggestInput = z.infer<typeof dispatchSuggestSchema>;

export const emailDraftSchema = z.object({
  purpose: z.string().trim().min(3, 'Bitte nennen Sie den Zweck.').max(200),
  recipientName: z.string().trim().max(120).default('Kundin/Kunde'),
  context: z.string().trim().min(10, 'Bitte geben Sie etwas Kontext an.').max(4000),
  tone: z
    .enum(['freundlich', 'sachlich', 'entschuldigend', 'bestimmt', 'werblich'])
    .default('freundlich'),
});
export type EmailDraftInput = z.infer<typeof emailDraftSchema>;

/** Leistungsarten wie in `ServiceKind` — hier als eigenständige Liste, weil die
 *  Zod-Schicht nicht von Prisma abhängen soll. */
export const aiServiceKindEnum = z.enum([
  'OFFICE_CLEANING',
  'MOVE_OUT_CLEANING',
  'RESIDENTIAL_CLEANING',
  'WINDOW_CLEANING',
  'CONSTRUCTION_CLEANING',
  'BUILDING_MAINTENANCE',
  'SPECIAL',
]);

export const quoteDraftSchema = z.object({
  message: z.string().trim().min(10, 'Bitte beschreiben Sie die Anfrage.').max(4000),
  customerId: cuidSchema.optional(),
  leadId: cuidSchema.optional(),
  serviceKind: aiServiceKindEnum.optional(),
  propertyKind: z.string().max(40).optional(),
  squareMeters: z.number().int().min(5).max(20_000).optional(),
  rooms: z.number().min(0.5).max(200).optional(),
  windows: z.number().int().min(0).max(2000).optional(),
  frequency: z.string().max(20).optional(),
});
export type QuoteDraftInput = z.infer<typeof quoteDraftSchema>;

export const summarizeSchema = z.object({
  text: z.string().trim().min(40, 'Der Text ist zu kurz für eine Zusammenfassung.').max(40_000),
  focus: z.string().trim().max(200).optional(),
  maxSentences: z.number().int().min(2).max(15).default(6),
});
export type SummarizeInput = z.infer<typeof summarizeSchema>;

export const translateSchema = z.object({
  text: z.string().trim().min(3, 'Bitte geben Sie einen Text ein.').max(20_000),
  // Bewusst ohne Vorgabewert: „übersetzen wohin" ist die eigentliche Frage.
  targetLocale: z.enum(['DE', 'EN', 'FR', 'IT']),
  preserveFormatting: z.boolean().default(true),
});
export type TranslateInput = z.infer<typeof translateSchema>;

// ---------------------------------------------------------------------------
//  KI-Textassistent (Textkorrektur und Textvorschläge, 2026-09-28)
// ---------------------------------------------------------------------------

/**
 * Was der Textassistent mit einem Text tun kann. Die Schlüssel sind ASCII,
 * weil sie im Protokoll und in der OpenAPI-Beschreibung stehen; die
 * Beschriftung für die Oberfläche steht in `TEXT_ASSIST_AKTION_LABEL`.
 *
 * `titel` und `meta-description` liefern **Vorschläge** (bis zu drei zur
 * Auswahl), alle anderen einen einzigen umgeschriebenen Text — die
 * Unterscheidung trifft `TEXT_ASSIST_VORSCHLAGSAKTIONEN`.
 */
export const TEXT_ASSIST_AKTIONEN = [
  'rechtschreibung',
  'grammatik',
  'professioneller',
  'freundlicher',
  'kuerzer',
  'ausfuehrlicher',
  'seo',
  'titel',
  'meta-description',
] as const;
export type TextAssistAktion = (typeof TEXT_ASSIST_AKTIONEN)[number];

export const TEXT_ASSIST_AKTION_LABEL: Record<TextAssistAktion, string> = {
  rechtschreibung: 'Rechtschreibung korrigieren',
  grammatik: 'Grammatik korrigieren',
  professioneller: 'Professioneller formulieren',
  freundlicher: 'Freundlicher formulieren',
  kuerzer: 'Kürzer',
  ausfuehrlicher: 'Ausführlicher',
  seo: 'SEO verbessern',
  titel: 'Titel vorschlagen',
  'meta-description': 'Meta-Description vorschlagen',
};

export const TEXT_ASSIST_VORSCHLAGSAKTIONEN: readonly TextAssistAktion[] = ['titel', 'meta-description'];

/**
 * Welche Art Feld den Text liefert — eine **Erlaubnisliste**, kein freier
 * Feldname.
 *
 * Warum überhaupt ein Kontext: Er steuert Ton und Länge im Systemtext („ein
 * Seitentitel hat rund 60 Zeichen"). Warum eine feste Liste und kein
 * Feldname aus dem Formular: Ein freier Name wäre ein zweiter Kanal zum
 * Modell an der Schwärzung vorbei, und er wäre die Einladung, den Assistenten
 * an beliebige Felder zu hängen — auch an solche, deren Inhalt nie das Haus
 * verlassen darf (Lohn, AHV, Bank, Gesundheit, Alarmcodes). Ein neues Feld
 * braucht deshalb einen neuen Eintrag hier, und damit eine bewusste
 * Entscheidung, die in `docs/KI_GOVERNANCE.md` steht.
 */
export const TEXT_ASSIST_KONTEXTE = [
  'cms-text',
  'blog',
  'seo-title',
  'seo-description',
  'service-description',
  'email-draft',
  'quote-text',
] as const;
export type TextAssistKontext = (typeof TEXT_ASSIST_KONTEXTE)[number];

const TEXTAKTIONEN_ALLGEMEIN: readonly TextAssistAktion[] = [
  'rechtschreibung',
  'grammatik',
  'professioneller',
  'freundlicher',
  'kuerzer',
  'ausfuehrlicher',
];

/**
 * Welche Aktion zu welchem Feld passt. „SEO verbessern" in einer Offerte oder
 * „Titel vorschlagen" für einen Schlusstext wären Knöpfe, die etwas
 * Sinnloses tun — die Oberfläche zeigt nur, was hier steht, und der Server
 * weist eine andere Kombination mit 422 ab.
 */
export const TEXT_ASSIST_AKTIONEN_JE_KONTEXT: Record<TextAssistKontext, readonly TextAssistAktion[]> = {
  'cms-text': [...TEXTAKTIONEN_ALLGEMEIN, 'seo'],
  blog: [...TEXTAKTIONEN_ALLGEMEIN, 'seo', 'titel', 'meta-description'],
  'seo-title': ['rechtschreibung', 'grammatik', 'kuerzer', 'seo', 'titel'],
  'seo-description': ['rechtschreibung', 'grammatik', 'kuerzer', 'ausfuehrlicher', 'seo', 'meta-description'],
  'service-description': [...TEXTAKTIONEN_ALLGEMEIN, 'seo', 'meta-description'],
  'email-draft': TEXTAKTIONEN_ALLGEMEIN,
  'quote-text': TEXTAKTIONEN_ALLGEMEIN,
};

/** Obergrenze des Eingabetexts — Kostenkontrolle und genug für einen Blogabschnitt. */
export const TEXT_ASSIST_MAX_ZEICHEN = 6000;

export const textAssistSchema = z
  .object({
    aktion: z.enum(TEXT_ASSIST_AKTIONEN, { message: 'Unbekannte Aktion.' }),
    kontext: z.enum(TEXT_ASSIST_KONTEXTE, { message: 'Unbekannte Feldart.' }).default('cms-text'),
    text: z
      .string()
      .trim()
      .min(2, 'Bitte geben Sie zuerst einen Text ein.')
      .max(TEXT_ASSIST_MAX_ZEICHEN, `Höchstens ${TEXT_ASSIST_MAX_ZEICHEN} Zeichen — bitte markieren Sie einen Abschnitt.`),
  })
  .superRefine((wert, ctx) => {
    if (!TEXT_ASSIST_AKTIONEN_JE_KONTEXT[wert.kontext].includes(wert.aktion)) {
      ctx.addIssue({
        code: 'custom',
        path: ['aktion'],
        message: `„${TEXT_ASSIST_AKTION_LABEL[wert.aktion]}" passt nicht zu diesem Feld.`,
      });
    }
  });
export type TextAssistInput = z.infer<typeof textAssistSchema>;

/**
 * Chat auf der Website.
 *
 * Der Verlauf reist bei jeder Frage mit und ist auf acht Beiträge begrenzt.
 * Serverseitige Sitzungen wären bequemer, aber ein anonymer Besucher soll
 * keinen Datensatz erzeugen, bevor er überhaupt etwas gebucht hat.
 */
export const chatSchema = z.object({
  message: z.string().trim().min(1, 'Bitte stellen Sie eine Frage.').max(500),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(4000),
      }),
    )
    .max(8)
    .default([]),
});
export type ChatInput = z.infer<typeof chatSchema>;
