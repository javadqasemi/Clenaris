import { z } from 'zod';
import type { CtaSlot, CtaStyle } from '@prisma/client';

/**
 * Handlungsaufrufe.
 *
 * Entscheide, die hier festgeschrieben sind:
 *
 *  • **Das Ziel ist eine geschlossene Menge von Formen.** Erlaubt sind ein
 *    interner Pfad (`/offerte`), `https://…`, `tel:` und `mailto:`. Ein freies
 *    Textfeld wäre der direkte Weg zu `javascript:`-Zielen — eine
 *    Schaltfläche, die auf der öffentlichen Website Code ausführt, sobald sie
 *    jemand anklickt. Das ist kein theoretisches Risiko: die Adresse wird von
 *    einer Person eingetippt und landet unverändert in einem `href`.
 *
 *  • **Eigene Farben nur als Hexwert.** Auch hier gilt: der Wert landet in
 *    einem `style`-Attribut. `#0B7285` lässt sich prüfen, `red; background:
 *    url(…)` nicht.
 *
 *  • **Der Kurzname ist unveränderlich gedacht.** Er identifiziert den Aufruf
 *    in Auswertungen. Änderbar ist er trotzdem — aber die Oberfläche warnt.
 */

export const CTA_SLOTS = [
  'HEADER',
  'HERO_PRIMARY',
  'HERO_SECONDARY',
  'SECTION_BANNER',
  'FOOTER',
  'MOBILE_BAR',
] as const;

export const CTA_STYLES = [
  'PRIMARY',
  'SECONDARY',
  'OUTLINE',
  'GHOST',
  'ACCENT',
  'SUCCESS',
  'CUSTOM',
] as const;

/** Bricht den Build, wenn Prisma-Enum und Liste auseinanderlaufen. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const CTA_ENUMS_IN_SYNC: [
  Exact<CtaSlot, (typeof CTA_SLOTS)[number]>,
  Exact<CtaStyle, (typeof CTA_STYLES)[number]>,
] = [true, true];

/**
 * Zulässige Ziele.
 *
 * Bewusst als Positivliste. Eine Sperrliste („alles ausser javascript:")
 * übersieht `data:`, `vbscript:` und die Schreibweise mit eingestreuten
 * Steuerzeichen — eine Positivliste kann das nicht.
 */
export const ctaHrefSchema = z
  .string()
  .trim()
  .min(1, 'Ein Ziel ist erforderlich.')
  .max(500, 'Die Adresse ist zu lang.')
  .refine(
    (value) =>
      /^\/(?![/\\])[^\s]*$/.test(value) ||
      /^https:\/\/[^\s]+$/i.test(value) ||
      /^tel:\+?[0-9\s()-]{5,25}$/i.test(value) ||
      /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(value),
    'Erlaubt sind ein interner Pfad (/offerte), https://…, tel:… oder mailto:….',
  );

/**
 * Warum `(?![/\\])` im Pfadmuster steht.
 *
 * `//fremde-seite.example` sieht aus wie ein interner Pfad und *ist* im
 * Browser eine vollständige Adresse: der protokollrelative Verweis führt auf
 * `https://fremde-seite.example`. Ohne diesen Ausschluss liesse sich über die
 * Verwaltungsmaske eine Schaltfläche auf der öffentlichen Website anlegen, die
 * Besucherinnen und Besucher auf eine fremde Domain schickt — mit dem
 * Vertrauensvorschuss der eigenen Marke. Dasselbe gilt für `/\` , das einige
 * Browser gleich behandeln.
 *
 * Der Fall ist keine Theorie: das Muster `^\/` wirkt korrekt und liess ihn
 * durch, bis eine Prüfung ihn fand.
 */

const hexColor = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Bitte einen Hexwert wie #0B7285 angeben.');

const optionalHex = z
  .union([hexColor, z.literal('')])
  .optional()
  .transform((v) => (v === '' ? undefined : v));

/**
 * Seitenmuster, auf denen der Aufruf erscheint.
 *
 * `/leistungen/*` deckt alle Unterseiten ab. Leere Liste = überall.
 */
const pagePattern = z
  .string()
  .trim()
  .regex(
    /^\/[a-z0-9\-/]*\*?$/,
    'Bitte einen Pfad wie /offerte oder /leistungen/* angeben.',
  );

const ctaFields = {
  key: z
    .string()
    .trim()
    .toLowerCase()
    .min(2, 'Der Kurzname ist zu kurz.')
    .max(48, 'Der Kurzname ist zu lang.')
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      'Nur Kleinbuchstaben, Ziffern und einzelne Bindestriche.',
    ),
  label: z
    .string()
    .trim()
    .min(2, 'Eine Beschriftung ist erforderlich.')
    .max(48, 'Die Beschriftung ist zu lang — sie muss auf eine Schaltfläche passen.'),
  note: z
    .string()
    .trim()
    .max(200, 'Die Notiz ist zu lang.')
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  href: ctaHrefSchema,
  newTab: z.boolean().default(false),
  icon: z
    .string()
    .trim()
    .max(40)
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  slot: z.enum(CTA_SLOTS),
  style: z.enum(CTA_STYLES).default('PRIMARY'),
  bgColor: optionalHex,
  fgColor: optionalHex,
  pages: z.array(pagePattern).max(30, 'Höchstens 30 Seiten.').default([]),
  active: z.boolean().default(true),
  position: z.number().int().min(0).max(999).default(0),
  publishFrom: z
    .union([z.string().datetime({ offset: true }), z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/), z.literal('')])
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  publishUntil: z
    .union([z.string().datetime({ offset: true }), z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/), z.literal('')])
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
};

function ctaRules(
  value: {
    style?: (typeof CTA_STYLES)[number];
    bgColor?: string;
    fgColor?: string;
    publishFrom?: string;
    publishUntil?: string;
    href?: string;
    newTab?: boolean;
  },
  ctx: z.RefinementCtx,
) {
  if (value.style === 'CUSTOM' && (!value.bgColor || !value.fgColor)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bgColor'],
      message: 'Bei eigenen Farben sind Hintergrund und Schriftfarbe beide erforderlich.',
    });
  }

  if (value.publishFrom && value.publishUntil && value.publishUntil <= value.publishFrom) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['publishUntil'],
      message: 'Das Ende muss nach dem Beginn liegen.',
    });
  }

  // `tel:` und `mailto:` in einem neuen Tab zu öffnen erzeugt auf dem Telefon
  // ein leeres Fenster hinter dem Wählfeld. Kein Fehler, aber ein Hinweis.
  if (value.newTab && value.href && /^(tel|mailto):/i.test(value.href)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['newTab'],
      message: 'Anrufe und E-Mails öffnen kein Fenster — die Einstellung bleibt hier wirkungslos.',
    });
  }
}

export const createCtaSchema = z.object(ctaFields).superRefine(ctaRules);
export const updateCtaSchema = z.object(ctaFields).partial().superRefine(ctaRules);

export type CreateCtaInput = z.infer<typeof createCtaSchema>;
export type UpdateCtaInput = z.infer<typeof updateCtaSchema>;

/** Reihenfolge innerhalb eines Platzes in einem Zug setzen. */
export const ctaReorderSchema = z.object({
  slot: z.enum(CTA_SLOTS),
  ids: z.array(z.string().min(1)).min(1).max(50),
});

export type CtaReorderInput = z.infer<typeof ctaReorderSchema>;

// ---------------------------------------------------------------------------
//  Beschriftungen
// ---------------------------------------------------------------------------

export const CTA_SLOT_LABELS: Record<(typeof CTA_SLOTS)[number], string> = {
  HEADER: 'Kopfzeile',
  HERO_PRIMARY: 'Kopfbereich, Hauptschaltfläche',
  HERO_SECONDARY: 'Kopfbereich, zweite Schaltfläche',
  SECTION_BANNER: 'Abschlussband',
  FOOTER: 'Fusszeile',
  MOBILE_BAR: 'Feste Leiste auf dem Telefon',
};

export const CTA_SLOT_HINTS: Record<(typeof CTA_SLOTS)[number], string> = {
  HEADER: 'Rechts neben der Telefonnummer. Auf schmalen Bildschirmen nur das Symbol.',
  HERO_PRIMARY: 'Die auffälligste Schaltfläche der Seite. Höchstens eine je Seite.',
  HERO_SECONDARY: 'Die ruhigere Alternative daneben — etwa „Preise ansehen".',
  SECTION_BANNER: 'Das Band vor der Fusszeile, mit dem eine Seite endet.',
  FOOTER: 'In der Fusszeile, auf jeder Seite sichtbar.',
  MOBILE_BAR: 'Klebt unten am Bildschirmrand. Höchstens zwei — mehr verdecken den Inhalt.',
};

export const CTA_STYLE_LABELS: Record<(typeof CTA_STYLES)[number], string> = {
  PRIMARY: 'Auffällig (Hausfarbe)',
  SECONDARY: 'Gedämpft',
  OUTLINE: 'Umrandet',
  GHOST: 'Ohne Fläche',
  ACCENT: 'Akzentfarbe',
  SUCCESS: 'Grün',
  CUSTOM: 'Eigene Farben',
};
