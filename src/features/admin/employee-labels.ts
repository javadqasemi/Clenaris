/**
 * Beschriftungen der Personalakte — ohne `'use client'`.
 *
 * Server-Seiten (Liste, Akte) und Client-Bausteine (Dialoge) brauchen
 * dieselben Optionen. Aus einem Client-Modul importiert, kämen sie im
 * Server-Bundle nur als Referenz an — `EMPLOYMENT_OPTIONS.map` scheiterte
 * beim Build mit „is not a function". Deshalb liegen sie hier, in einem
 * Modul ohne Laufzeit-Annahmen.
 */
export const EMPLOYMENT_OPTIONS = [
  { value: 'FULL_TIME', label: 'Vollzeit' },
  { value: 'PART_TIME', label: 'Teilzeit' },
  { value: 'HOURLY', label: 'Im Stundenlohn' },
  { value: 'TEMPORARY', label: 'Befristet' },
  { value: 'APPRENTICE', label: 'Lernende/r' },
  { value: 'CONTRACTOR', label: 'Auf Mandat' },
];

export const EMPLOYMENT_LABELS: Record<string, string> = Object.fromEntries(
  EMPLOYMENT_OPTIONS.map((option) => [option.value, option.label]),
);
