'use client';

/**
 * Cookie-Einwilligung.
 *
 * Umsetzung nach revidiertem Schweizer DSG und DSGVO:
 *  • Notwendige Cookies (Session, CSRF) laufen ohne Einwilligung — sie sind
 *    für den vom Nutzer angeforderten Dienst zwingend.
 *  • Analyse und Marketing erst nach aktiver Zustimmung.
 *  • Ablehnen ist genauso einfach wie Zustimmen (kein Dark Pattern).
 *  • Die Entscheidung wird mit Zeitstempel und Version gespeichert und nach
 *    12 Monaten erneut abgefragt.
 */

export interface ConsentState {
  necessary: true;
  analytics: boolean;
  marketing: boolean;
  decidedAt: string;
  version: string;
}

const STORAGE_KEY = 'clenaris-consent';
export const CONSENT_VERSION = '1.0';
const MAX_AGE_DAYS = 365;
const EVENT = 'clenaris:consent';

const DEFAULT_STATE: ConsentState = {
  necessary: true,
  analytics: false,
  marketing: false,
  decidedAt: '',
  version: CONSENT_VERSION,
};

export function hasConsent(): ConsentState {
  if (typeof window === 'undefined') return DEFAULT_STATE;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;

    const parsed = JSON.parse(raw) as ConsentState;
    if (parsed.version !== CONSENT_VERSION) return DEFAULT_STATE;

    const decided = new Date(parsed.decidedAt).getTime();
    if (Number.isNaN(decided) || Date.now() - decided > MAX_AGE_DAYS * 86_400_000) {
      return DEFAULT_STATE;
    }

    return { ...parsed, necessary: true };
  } catch {
    return DEFAULT_STATE;
  }
}

/** true, wenn noch keine gültige Entscheidung vorliegt. */
export function needsDecision(): boolean {
  return hasConsent().decidedAt === '';
}

export function setConsent(choice: { analytics: boolean; marketing: boolean }): ConsentState {
  const state: ConsentState = {
    necessary: true,
    analytics: choice.analytics,
    marketing: choice.marketing,
    decidedAt: new Date().toISOString(),
    version: CONSENT_VERSION,
  };

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* Privater Modus: die Entscheidung gilt dann nur für diese Sitzung. */
  }

  window.dispatchEvent(new CustomEvent<ConsentState>(EVENT, { detail: state }));
  return state;
}

/** Einwilligung widerrufen — verlinkt in der Datenschutzerklärung. */
export function revokeConsent(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
  window.dispatchEvent(new CustomEvent<ConsentState>(EVENT, { detail: DEFAULT_STATE }));
  window.location.reload();
}

export function onConsentChange(handler: (state: ConsentState) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<ConsentState>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
