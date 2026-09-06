import 'server-only';

import QRCode from 'qrcode';

/**
 * Schweizer QR-Rechnung (QR-Bill, Standard v2.3 von SIX).
 *
 * Architekturentscheid: Wir erzeugen die Nutzlast selbst statt eine Bibliothek
 * zu verwenden. Der Standard ist ein simples, streng definiertes Zeilenformat —
 * eine eigene Implementierung ist rund 100 Zeilen, dafür ohne Abhängigkeit von
 * einem schlecht gepflegten Paket, und die Feldreihenfolge ist im Code
 * dokumentiert und damit prüfbar.
 *
 * Wichtig: Die QR-Referenz (27 Stellen, Prüfziffer nach Modulo-10 rekursiv)
 * darf nur mit einer QR-IBAN verwendet werden. Bei normaler IBAN gilt „NON"
 * (keine Referenz) oder eine Creditor Reference (SCOR).
 */

export interface QrBillParams {
  /** QR-IBAN (Institut-ID 30000–31999) oder normale IBAN. */
  iban: string;
  creditor: {
    name: string;
    street: string;
    buildingNumber: string;
    postalCode: string;
    city: string;
    country: string;
  };
  debtor?: {
    name: string;
    street: string;
    buildingNumber: string;
    postalCode: string;
    city: string;
    country: string;
  } | null;
  amount: number;
  currency: 'CHF' | 'EUR';
  /** 27-stellige QR-Referenz (nur mit QR-IBAN) oder undefined. */
  reference?: string | null;
  /** Unstrukturierte Mitteilung, max. 140 Zeichen. */
  message?: string | null;
}

function normalizeIban(iban: string): string {
  return iban.replace(/\s+/g, '').toUpperCase();
}

/** QR-IBAN erkennen: Institut-Identifikation (Stellen 5–9) im Bereich 30000–31999. */
export function isQrIban(iban: string): boolean {
  const clean = normalizeIban(iban);
  if (!/^CH\d{2}\d{5}/.test(clean)) return false;
  const institution = Number(clean.slice(4, 9));
  return institution >= 30_000 && institution <= 31_999;
}

/**
 * Prüfziffer nach Modulo-10 rekursiv (ESR-Verfahren).
 * Tabelle aus der Spezifikation der Schweizerischen Post.
 */
const MOD10_TABLE = [
  [0, 9, 4, 6, 8, 2, 7, 1, 3, 5],
  [9, 4, 6, 8, 2, 7, 1, 3, 5, 0],
  [4, 6, 8, 2, 7, 1, 3, 5, 0, 9],
  [6, 8, 2, 7, 1, 3, 5, 0, 9, 4],
  [8, 2, 7, 1, 3, 5, 0, 9, 4, 6],
  [2, 7, 1, 3, 5, 0, 9, 4, 6, 8],
  [7, 1, 3, 5, 0, 9, 4, 6, 8, 2],
  [1, 3, 5, 0, 9, 4, 6, 8, 2, 7],
  [3, 5, 0, 9, 4, 6, 8, 2, 7, 1],
  [5, 0, 9, 4, 6, 8, 2, 7, 1, 3],
];

export function mod10Recursive(input: string): number {
  let carry = 0;
  for (const char of input) {
    const digit = Number(char);
    if (Number.isNaN(digit)) continue;
    carry = MOD10_TABLE[carry][digit];
  }
  return (10 - carry) % 10;
}

/**
 * Erzeugt eine 27-stellige QR-Referenz aus einer laufenden Nummer.
 * Aufbau: [optionale Kundennummer][laufende Nummer] auf 26 Stellen mit
 * führenden Nullen + Prüfziffer.
 */
export function buildQrReference(params: {
  invoiceSequence: number;
  customerSequence?: number;
}): string {
  const customerPart = String(params.customerSequence ?? 0).padStart(6, '0');
  const invoicePart = String(params.invoiceSequence).padStart(20, '0');
  const base = `${customerPart}${invoicePart}`.slice(-26);
  return `${base}${mod10Recursive(base)}`;
}

/** 210000000003139471430009017 → "21 00000 00003 13947 14300 09017" */
export function formatQrReference(reference: string): string {
  const clean = reference.replace(/\s/g, '');
  const head = clean.slice(0, 2);
  const rest = clean.slice(2).replace(/(.{5})/g, '$1 ').trim();
  return `${head} ${rest}`;
}

/**
 * Baut die Nutzlast des Swiss QR Code.
 * Die Reihenfolge und Anzahl der Zeilen ist normiert — nichts weglassen,
 * leere Felder bleiben leere Zeilen.
 */
export function buildQrPayload(params: QrBillParams): string {
  const iban = normalizeIban(params.iban);
  const useQrReference = Boolean(params.reference) && isQrIban(iban);

  const lines = [
    'SPC', // QRType
    '0200', // Version 2.00
    '1', // Coding Type: UTF-8
    iban, // IBAN / QR-IBAN

    // --- Zahlungsempfänger (Creditor), strukturierte Adresse ---
    'S',
    params.creditor.name.slice(0, 70),
    params.creditor.street.slice(0, 70),
    params.creditor.buildingNumber.slice(0, 16),
    params.creditor.postalCode.slice(0, 16),
    params.creditor.city.slice(0, 35),
    params.creditor.country.slice(0, 2),

    // --- Endgültiger Zahlungsempfänger (nicht verwendet) ---
    '', '', '', '', '', '', '',

    // --- Betrag ---
    params.amount > 0 ? params.amount.toFixed(2) : '',
    params.currency,

    // --- Zahlungspflichtiger (Debtor) ---
    ...(params.debtor
      ? [
          'S',
          params.debtor.name.slice(0, 70),
          params.debtor.street.slice(0, 70),
          params.debtor.buildingNumber.slice(0, 16),
          params.debtor.postalCode.slice(0, 16),
          params.debtor.city.slice(0, 35),
          params.debtor.country.slice(0, 2),
        ]
      : ['', '', '', '', '', '', '']),

    // --- Referenz ---
    useQrReference ? 'QRR' : 'NON',
    useQrReference ? params.reference!.replace(/\s/g, '') : '',

    // --- Zusätzliche Informationen ---
    (params.message ?? '').slice(0, 140),
    'EPD', // Trailer: End Payment Data
  ];

  return lines.join('\r\n');
}

/**
 * Erzeugt den QR-Code als PNG-Data-URL.
 * Fehlerkorrekturstufe M und Rand 0 sind vom Standard vorgeschrieben; das
 * Schweizerkreuz wird beim Rendern der PDF über die Mitte gelegt.
 */
export async function renderQrCode(params: QrBillParams): Promise<string> {
  const payload = buildQrPayload(params);
  return QRCode.toDataURL(payload, {
    errorCorrectionLevel: 'M',
    margin: 0,
    width: 600,
    color: { dark: '#000000', light: '#FFFFFF' },
  });
}

/** Adresse in Strasse und Hausnummer trennen ("Bahnhofstrasse 12a"). */
export function splitStreet(street: string): { street: string; buildingNumber: string } {
  const match = street.trim().match(/^(.*?)[\s,]+(\d+[a-zA-Z]?(?:[-/]\d+[a-zA-Z]?)?)$/);
  if (match) return { street: match[1].trim(), buildingNumber: match[2] };
  return { street: street.trim(), buildingNumber: '' };
}
