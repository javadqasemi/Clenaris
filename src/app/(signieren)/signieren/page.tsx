import type { Metadata } from 'next';

import { SignatureExchange } from '@/features/signature/exchange';

export const metadata: Metadata = {
  title: 'Unterzeichnung öffnen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Die Tauschseite. Sie tut genau eines: den Token aus dem Fragment lesen,
 * ihn aus der Adresse entfernen, gegen eine Sitzung tauschen, weiterleiten.
 * Ohne Fragment zeigt sie, dass hier nichts zu sehen ist.
 */
export default function SignierenPage() {
  return <SignatureExchange mode="sign" />;
}
