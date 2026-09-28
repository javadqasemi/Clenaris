import type { Metadata } from 'next';

import { HandoffUnlock } from '@/features/portal/handoff-unlock';

export const metadata: Metadata = {
  title: 'Zurück zum Mitarbeiterbereich',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Die Rückgabeseite — im Rahmen der Abnahme, nicht im Anwendungsrahmen.
 *
 * Absichtlich hier und nicht unter `/portal`: Der Anwendungsrahmen liest die
 * Sitzung über `requireSession()`, und die wirft während einer Übergabe 423.
 * Diese Seite muss aber genau dann erreichbar sein — sie ist der Weg zurück.
 * Sie zieht ihren Zustand deshalb über `/api/handoff`, einen der zwei
 * Endpunkte, die während einer Übergabe antworten dürfen.
 */
export default function GeraetUebernehmenPage() {
  return <HandoffUnlock />;
}
