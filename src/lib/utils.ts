import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Tailwind-Klassen deterministisch zusammenführen (letzte Regel gewinnt). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------------------------------------------------------
//  Formatierung — Schweizer Konventionen
// ---------------------------------------------------------------------------

const LOCALE_MAP: Record<string, string> = {
  de: 'de-CH',
  en: 'en-CH',
  fr: 'fr-CH',
  it: 'it-CH',
};

export function intlLocale(locale = 'de'): string {
  return LOCALE_MAP[locale.toLowerCase()] ?? 'de-CH';
}

/** CHF 1'234.50 — Apostroph als Tausendertrennzeichen (Schweizer Standard). */
export function formatCurrency(value: number, locale = 'de', currency = 'CHF'): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatNumber(value: number, locale = 'de', decimals = 0): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function formatPercent(value: number, locale = 'de', decimals = 1): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    style: 'percent',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value / 100);
}

export function formatDate(
  value: Date | string | number,
  locale = 'de',
  options: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: 'numeric' },
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: 'Europe/Zurich',
    ...options,
  }).format(date);
}

export function formatDateTime(value: Date | string | number, locale = 'de'): string {
  return formatDate(value, locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatTime(value: Date | string | number, locale = 'de'): string {
  return formatDate(value, locale, { hour: '2-digit', minute: '2-digit' });
}

export function formatDateLong(value: Date | string | number, locale = 'de'): string {
  return formatDate(value, locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/** "vor 3 Tagen" / "in 2 Stunden" */
export function formatRelative(value: Date | string, locale = 'de'): string {
  const date = value instanceof Date ? value : new Date(value);
  const diffMs = date.getTime() - Date.now();
  const rtf = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000_000],
    ['month', 2_592_000_000],
    ['week', 604_800_000],
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  for (const [unit, ms] of units) {
    if (Math.abs(diffMs) >= ms) return rtf.format(Math.round(diffMs / ms), unit);
  }
  return rtf.format(Math.round(diffMs / 1000), 'second');
}

/** 135 → "2 Std. 15 Min." */
export function formatDuration(minutes: number, locale = 'de'): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  const labels: Record<string, [string, string]> = {
    de: ['Std.', 'Min.'],
    en: ['h', 'min'],
    fr: ['h', 'min'],
    it: ['h', 'min'],
  };
  const [hLabel, mLabel] = labels[locale] ?? labels.de;
  if (h === 0) return `${m} ${mLabel}`;
  if (m === 0) return `${h} ${hLabel}`;
  return `${h} ${hLabel} ${m} ${mLabel}`;
}

/** Schweizer Telefonnummer normalisieren: 079 123 45 67 → +41791234567 */
export function normalizePhone(input: string, defaultCountry = '41'): string {
  const digits = input.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  if (digits.startsWith('0')) return `+${defaultCountry}${digits.slice(1)}`;
  return `+${digits}`;
}

/** +41791234567 → "079 123 45 67" */
export function formatPhone(input: string): string {
  const n = normalizePhone(input);
  const m = n.match(/^\+41(\d{2})(\d{3})(\d{2})(\d{2})$/);
  if (m) return `0${m[1]} ${m[2]} ${m[3]} ${m[4]}`;
  return input;
}

export function initials(firstName?: string | null, lastName?: string | null): string {
  return `${firstName?.[0] ?? ''}${lastName?.[0] ?? ''}`.toUpperCase() || '?';
}

export function fullName(firstName?: string | null, lastName?: string | null): string {
  return [firstName, lastName].filter(Boolean).join(' ').trim();
}

/** URL-sicherer Slug inkl. deutscher Umlaute. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

export function truncate(input: string, max = 120): string {
  return input.length <= max ? input : `${input.slice(0, max - 1).trimEnd()}…`;
}

/** Auf 5 Rappen runden (Schweizer Bargeldrundung). */
export function roundToRappen(value: number): number {
  return Math.round(value * 20) / 20;
}

/** Kaufmännisch auf 2 Nachkommastellen runden — vermeidet Float-Artefakte. */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** IBAN gruppiert darstellen: CH9300762011623852957 → CH93 0076 2011 6238 5295 7 */
export function formatIban(iban: string): string {
  return iban.replace(/\s/g, '').replace(/(.{4})/g, '$1 ').trim();
}

export function isValidSwissPostalCode(zip: string): boolean {
  return /^[1-9]\d{3}$/.test(zip.trim());
}

/** Deterministische Farbe aus einem String (Avatare, Kalender-Tags). */
export function colorFromString(input: string): string {
  const palette = [
    '#0B7285', '#1971C2', '#5F3DC4', '#C2255C', '#E8590C',
    '#2B8A3E', '#0C8599', '#862E9C', '#A61E4D', '#D9480F',
  ];
  let hash = 0;
  for (let i = 0; i < input.length; i++) hash = (hash * 31 + input.charCodeAt(i)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Array nach Schlüssel gruppieren. */
export function groupBy<T, K extends string | number>(
  items: T[],
  keyFn: (item: T) => K,
): Record<K, T[]> {
  return items.reduce(
    (acc, item) => {
      const key = keyFn(item);
      (acc[key] ??= []).push(item);
      return acc;
    },
    {} as Record<K, T[]>,
  );
}

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function sum(items: number[]): number {
  return items.reduce((a, b) => a + b, 0);
}

/** Wachstum in Prozent; 0 → 0, um Division durch Null zu vermeiden. */
export function growthPercent(current: number, previous: number): number {
  if (previous === 0) return current === 0 ? 0 : 100;
  return round2(((current - previous) / Math.abs(previous)) * 100);
}

/** Query-String aus einem Objekt bauen, leere Werte werden ausgelassen. */
export function toQueryString(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) value.forEach((v) => sp.append(key, String(v)));
    else sp.set(key, String(value));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

export function absoluteUrl(path: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

/** Datei-Grösse menschenlesbar. */
export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(decimals)} ${sizes[i]}`;
}

/** Zeitfenster-Label: "08:00 – 11:30" */
export function timeRangeLabel(start: Date | string, end: Date | string, locale = 'de'): string {
  return `${formatTime(start, locale)} – ${formatTime(end, locale)}`;
}

/** ISO-Datum (YYYY-MM-DD) in der Zeitzone Europe/Zurich. */
export function toDateKey(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
