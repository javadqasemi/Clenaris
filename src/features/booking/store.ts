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

export interface BookingState {
  step: BookingStep;

  // Leistung
  serviceId: string | null;
  serviceSlug: string | null;
  frequency: Frequency;

  // Objekt
  propertyKind: PropertyKind;
  squareMeters: number | null;
  rooms: number | null;
  bathrooms: number | null;
  windows: number | null;
  hasPets: boolean;
  propertyId: string | null;

  // Extras
  extras: Record<string, number>;

  // Termin
  scheduledStart: string | null;
  urgent: boolean;

  // Kontakt & Adresse
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
  setExtra: (extraId: string, quantity: number) => void;
  reset: () => void;
  /** Ist der aktuelle Schritt vollständig ausgefüllt? */
  canProceed: () => boolean;
}

const INITIAL = {
  step: 'leistung' as BookingStep,
  serviceId: null,
  serviceSlug: null,
  frequency: 'ONCE' as Frequency,
  propertyKind: 'APARTMENT' as PropertyKind,
  squareMeters: null,
  rooms: null,
  bathrooms: 1,
  windows: null,
  hasPets: false,
  propertyId: null,
  extras: {} as Record<string, number>,
  scheduledStart: null,
  urgent: false,
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

      setExtra: (extraId, quantity) =>
        set((state) => {
          const extras = { ...state.extras };
          if (quantity <= 0) delete extras[extraId];
          else extras[extraId] = quantity;
          return { extras };
        }),

      reset: () => set(INITIAL),

      canProceed: () => {
        const state = get();
        switch (state.step) {
          case 'leistung':
            return Boolean(state.serviceId);
          case 'objekt':
            // Fensterreinigung braucht die Fensterzahl, alles andere die Fläche.
            return Boolean(state.squareMeters ?? state.windows ?? state.rooms);
          case 'extras':
            return true;
          case 'termin':
            return Boolean(state.scheduledStart);
          case 'kontakt':
            return (
              Boolean(state.addressId) ||
              (state.street.trim().length > 1 &&
                /^[1-9]\d{3}$/.test(state.postalCode) &&
                state.city.trim().length > 1)
            );
          case 'uebersicht':
            return state.acceptTerms;
          default:
            return false;
        }
      },
    }),
    {
      name: 'clenaris-booking',
      storage: createJSONStorage(() => sessionStorage),
      // Der Schritt selbst wird nicht persistiert: nach einem Neuladen soll der
      // Assistent von vorne durchlaufen, die Eingaben bleiben aber erhalten.
      partialize: ({ step: _step, ...rest }) => rest,
    },
  ),
);
