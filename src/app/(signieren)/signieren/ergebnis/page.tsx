import type { Metadata } from 'next';

import { SignatureExchange } from '@/features/signature/exchange';

export const metadata: Metadata = {
  title: 'Ergebnis öffnen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/** Dieselbe Tauschseite, für den Ergebnislink nach Abschluss. */
export default function ErgebnisOeffnenPage() {
  return <SignatureExchange mode="result" />;
}
