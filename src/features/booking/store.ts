'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Zustand des Buchungsassistenten.
 *
 * Architekturentscheid: Der Fortschritt wird im `sessionStorage` gespiegelt.
 * Wer den Tab neu lädt oder versehentlich zurücknavigiert, verliert die
 * Eingaben nicht — das ist im Buchungstrichter der teuerste Abbruchgrund.
 * `sessionStorage` statt `localStorage`, damit auf einem gemeinsam genutzten
 * Gerät keine Adressdaten zurückbleiben.
 *
 * Preise stehen bewusst *nicht* im Store. Sie werden bei jedem Schritt frisch
 * vom Server geholt, damit der Client keine Preislogik hält.
 */

export type BookingStep = 'leistung' | 'objekt' | 'extras' | 'termin' | 'kontakt' | 'uebersicht';

export const BOOKING_STEPS: { key: BookingStep; label: string; description: string }[] = [
  { key: 'leistung', label: 'Leistung', description: 'Was sollen wir reinigen?' },
  { key: 'objekt', label: 'Objekt', description: 'Angaben zu Ihren Räumen' },
  { key: 'extras', label: 'Zusätze', description: 'Optionale Arbeiten' },
  { key: 'termin', label: 'Termin', description: 'Wann passt es Ihnen?' },
  { key: 'kontakt', label: 'Kontakt', description: 'Wohin kommen wir?' },
  { key: 'uebersicht', label: 'Übersicht', description: 'Prüfen und buchen' },
];

export type PropertyKind =
  | 'APARTMENT'
  | 'HOUSE'
  | 'OFFICE'
  | 'COMMERCIAL'
  | 'INDUSTRIAL'
  | 'CONSTRUCTION_SITE'
  | 'PRACTICE'
  | 'RESTAURANT'
  | 'SCHOOL'
  | 'OTHER';

export type Frequency =
  | 'ONCE'
  | 'WEEKLY'
  | 'BIWEEKLY'
  | 'MONTHLY'
  | 'QUARTERLY'
  | 'SEMIANNUAL'
  | 'ANNUAL'
  | 'CUSTOM';

/** Eine gewählte Leistung — mit ihrer Art, weil davon die Pflichtangaben abhängen. */
export interface GewaehlteLeistung {
  id: string;
  slug: string;
  kind: string;
}

/** Dauerhaft geplante Leistungsarten — nur sie erlauben einen Turnus. */
export const WIEDERKEHRENDE_ARTEN = ['RESIDENTIAL_CLEANING', 'OFFICE_CLEANING'];

export interface BookingState {
  step: BookingStep;

  // Leistungen (seit 2026-09-26 eine oder mehrere, in der Reihenfolge der Wahl)
  auswahl: GewaehlteLeistung[];
  frequency: Frequency;

  // Objekt
  propertyKind: PropertyKind;
  squareMeters: number | null;
  rooms: number | null;
  bathrooms: number | null;
  windows: number | null;
  hasPets: boolean;
  propertyId: string | null;

  // Extras — je Leistung, denn „Backofen" gehört zur Umzugsreinigung, nicht
  // zur Fensterreinigung daneben: `{ [serviceId]: { [extraId]: Menge } }`.
  extras: Record<string, Record<string, number>>;

  // Termin
  scheduledStart: string | null;
  urgent: boolean;
  /**
   * Hinweis, wenn eine gewählte Uhrzeit durch eine spätere Änderung
   * ungültig wurde (Leistung dazu, Fläche grösser …). Der Assistent löscht
   * die Uhrzeit dann, statt einen Termin zu behalten, den der Server
   * ablehnen würde — und sagt, warum.
   */
  terminHinweis: string | null;

  // Kontakt & Adresse
  /**
   * Verlangt der Kontaktschritt die vier Pflichtangaben? Setzt der Assistent
   * aus der Sitzung: nein für ein Kundenkonto mit Profil, sonst ja. Der
   * Server prüft dasselbe — hier geht es darum, dass „Weiter" nicht in eine
   * 422 führt.
   */
  requiresContact: boolean;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  companyName: string;
  addressId: string | null;
  street: string;
  streetNo: string;
  postalCode: string;
  city: string;
  accessNote: string;
  customerNote: string;

  // Abschluss
  couponCode: string;
  fileIds: string[];
  acceptTerms: boolean;

  // Aktionen
  setStep: (step: BookingStep) => void;
  next: () => void;
  back: () => void;
  patch: (values: Partial<BookingState>) => void;
  /** Leistung an- oder abwählen. Abwählen verwirft auch ihre Zusatzleistungen. */
  toggleLeistung: (leistung: GewaehlteLeistung) => void;
  setExtra: (serviceId: string, extraId: string, quantity: number) => void;
  reset: () => void;
  /** Ist der aktuelle Schritt vollständig ausgefüllt? */
  canProceed: () => boolean;
}

const INITIAL = {
  step: 'leistung' as BookingStep,
  auswahl: [] as GewaehlteLeistung[],
  frequency: 'ONCE' as Frequency,
  propertyKind: 'APARTMENT' as PropertyKind,
  squareMeters: null,
  rooms: null,
  bathrooms: 1,
  windows: null,
  hasPets: false,
  propertyId: null,
  extras: {} as Record<string, Record<string, number>>,
  scheduledStart: null,
  urgent: false,
  terminHinweis: null,
  requiresContact: true,
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  companyName: '',
  addressId: null,
  street: '',
  streetNo: '',
  postalCode: '',
  city: '',
  accessNote: '',
  customerNote: '',
  couponCode: '',
  fileIds: [] as string[],
  acceptTerms: false,
};

export const useBookingStore = create<BookingState>()(
  persist(
    (set, get) => ({
      ...INITIAL,

      setStep: (step) => set({ step }),

      next: () => {
        const index = BOOKING_STEPS.findIndex((s) => s.key === get().step);
        const nextStep = BOOKING_STEPS[Math.min(index + 1, BOOKING_STEPS.length - 1)];
        set({ step: nextStep.key });
      },

      back: () => {
        const index = BOOKING_STEPS.findIndex((s) => s.key === get().step);
        const previous = BOOKING_STEPS[Math.max(index - 1, 0)];
        set({ step: previous.key });
      },

      patch: (values) => set(values),

      toggleLeistung: (leistung) =>
        set((state) => {
          const gewaehlt = state.auswahl.some((l) => l.id === leistung.id);
          const auswahl = gewaehlt
            ? state.auswahl.filter((l) => l.id !== leistung.id)
            : [...state.auswahl, leistung];
          const extras = { ...state.extras };
          if (gewaehlt) delete extras[leistung.id];
          // Ein Turnus nur, wenn *jede* gewählte Leistung wiederkehrend
          // planbar ist — eine Umzugsreinigung wöchentlich gibt es nicht.
          const wiederkehrend = auswahl.length > 0 && auswahl.every((l) => WIEDERKEHRENDE_ARTEN.includes(l.kind));
          return { auswahl, extras, ...(wiederkehrend ? {} : { frequency: 'ONCE' as Frequency }) };
        }),

      setExtra: (serviceId, extraId, quantity) =>
        set((state) => {
          const jeLeistung = { ...(state.extras[serviceId] ?? {}) };
          if (quantity <= 0) delete jeLeistung[extraId];
          else jeLeistung[extraId] = quantity;
          return { extras: { ...state.extras, [serviceId]: jeLeistung } };
        }),

      reset: () => set(INITIAL),

      canProceed: () => {
        const state = get();
        switch (state.step) {
          case 'leistung':
            return state.auswahl.length > 0;
          case 'objekt': {
            // Fensterreinigung braucht die Fensterzahl, alles andere Fläche
            // oder Zimmer — bei einer Auswahl aus beidem beides.
            const fenster = state.auswahl.some((l) => l.kind === 'WINDOW_CLEANING');
            const flaeche = state.auswahl.some((l) => l.kind !== 'WINDOW_CLEANING');
            return (
              (!fenster || Boolean(state.windows)) &&
              (!flaeche || Boolean(state.squareMeters ?? state.rooms)) &&
              state.auswahl.length > 0
            );
          }
          case 'extras':
            return true;
          case 'termin':
            return Boolean(state.scheduledStart);
          case 'kontakt': {
            const contactComplete =
              !state.requiresContact ||
              (state.firstName.trim().length > 1 &&
                state.lastName.trim().length > 1 &&
                /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.email.trim()) &&
                state.phone.trim().length >= 7);
            const addressComplete =
              Boolean(state.addressId) ||
              (state.street.trim().length > 1 &&
                /^[1-9]\d{3}$/.test(state.postalCode) &&
                state.city.trim().length > 1);
            return contactComplete && addressComplete;
          }
          case 'uebersicht':
            return state.acceptTerms;
          default:
            return false;
        }
      },
    }),
    {
      name: 'clenaris-booking',
      /**
       * Fassung 2 (2026-09-26): `serviceId` wurde zu `auswahl`, `extras` zu
       * Zusatzleistungen je Leistung. Ein im Tab gespeicherter Stand der
       * alten Form wird verworfen statt umgedeutet — eine halb übersetzte
       * Auswahl wäre schlimmer als ein Neubeginn im ersten Schritt.
       */
      version: 2,
      migrate: () => ({ ...INITIAL }) as unknown as BookingState,
      storage: createJSONStorage(() => sessionStorage),
      // Der Schritt selbst wird nicht persistiert: nach einem Neuladen soll der
      // Assistent von vorne durchlaufen, die Eingaben bleiben aber erhalten.
      partialize: ({ step: _step, ...rest }) => rest,
    },
  ),
);
