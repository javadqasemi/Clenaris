/**
 * Deutsche Bezeichnungen der Vertragsbegriffe — an einer Stelle.
 *
 * **Warum nicht im Formular.** Dieselben Begriffe erscheinen im
 * Verwaltungsformular, in der Detailansicht, im Vertrags-PDF und im
 * Signaturprotokoll. Stünden sie im Formular, müsste das PDF aus einer
 * `'use client'`-Datei importieren — was hier zuverlässig den Build bricht —
 * oder die Übersetzung ein zweites Mal enthalten. Zwei Übersetzungen desselben
 * Begriffs laufen auseinander, und zwar genau dann, wenn einer davon
 * unterschrieben wird.
 *
 * Reine Daten: keine Prisma-Typen, kein `server-only`, kein Pfad-Alias. Damit
 * lässt sich das Modul aus Server-Komponenten, Client-Komponenten, dem
 * PDF-Renderer und aus reinen Tests gleichermassen verwenden.
 */

export const ABRECHNUNGSZYKLUS: Record<string, string> = {
  PER_VISIT: 'Je Einsatz',
  MONTHLY: 'Monatlich',
  QUARTERLY: 'Vierteljährlich',
  SEMIANNUAL: 'Halbjährlich',
  ANNUAL: 'Jährlich',
};

export const PREISMODELL: Record<string, string> = {
  FIXED_PERIOD: 'Pauschale je Periode',
  FIXED_PER_VISIT: 'Pauschale je Einsatz',
  HOURLY: 'Nach Stunden',
  UNIT_BASED: 'Nach Menge',
  CUSTOM: 'Abweichende Vereinbarung',
};

export const VERLAENGERUNG: Record<string, string> = {
  NONE: 'Keine — endet zum Enddatum',
  AUTOMATIC: 'Automatisch',
  MANUAL: 'Nur auf ausdrücklichen Wunsch',
};

export const RHYTHMUS: Record<string, string> = {
  WEEKLY: 'Wöchentlich',
  BIWEEKLY: 'Zweiwöchentlich',
  EVERY_N_WEEKS: 'Alle n Wochen',
  MONTHLY: 'Monatlich',
  QUARTERLY: 'Vierteljährlich',
  ON_DEMAND: 'Auf Abruf',
};

export const WOCHENTAG = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

export const VERTRAGSSTATUS: Record<string, string> = {
  DRAFT: 'Entwurf',
  IN_REVIEW: 'In Prüfung',
  OFFERED: 'Offeriert',
  ACTIVE: 'In Kraft',
  PAUSED: 'Ausgesetzt',
  NOTICE_GIVEN: 'Gekündigt',
  ENDED: 'Beendet',
  CANCELLED: 'Annulliert',
};

export const VERSIONSSTATUS: Record<string, string> = {
  DRAFT: 'Entwurf',
  ACTIVE: 'Geltend',
  SUPERSEDED: 'Abgelöst',
};

/** Uhrzeit aus Minuten seit Mitternacht — „06:00". */
export function uhrzeit(minuten: number): string {
  const h = Math.floor(minuten / 60);
  const m = minuten % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Der Rhythmus eines Einsatzplans in einem Satz — „Wöchentlich · Montag,
 * Donnerstag · 06:00–10:00".
 *
 * Steht so im Vertrags-PDF: Eine Frequenz als Kürzel (`BIWEEKLY`) ist in einem
 * Dokument, das jemand unterschreibt, keine Vereinbarung, sondern eine
 * Zumutung.
 */
export function rhythmusText(plan: {
  frequency: string;
  intervalWeeks?: number | null;
  weekdays?: number[] | null;
  dayOfMonth?: number | null;
  startMinute?: number | null;
  endMinute?: number | null;
}): string {
  const teile: string[] = [];

  if (plan.frequency === 'EVERY_N_WEEKS' && plan.intervalWeeks) {
    teile.push(`Alle ${plan.intervalWeeks} Wochen`);
  } else {
    teile.push(RHYTHMUS[plan.frequency] ?? plan.frequency);
  }

  if (plan.weekdays && plan.weekdays.length > 0) {
    teile.push(plan.weekdays.map((tag) => WOCHENTAG[tag] ?? String(tag)).join(', '));
  }
  if (plan.dayOfMonth) teile.push(`am ${plan.dayOfMonth}.`);
  if (plan.startMinute != null && plan.endMinute != null) {
    teile.push(`${uhrzeit(plan.startMinute)}–${uhrzeit(plan.endMinute)}`);
  }

  return teile.join(' · ');
}
