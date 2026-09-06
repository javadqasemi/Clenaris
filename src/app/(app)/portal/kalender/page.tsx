import type { Metadata } from 'next';

import { requireEmployeeId } from '@/lib/auth/session';
import { PageHeader } from '@/components/app/page-parts';
import { PersonalCalendar } from '@/features/portal/personal-calendar.lazy';

export const metadata: Metadata = {
  title: 'Kalender',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Persönlicher Einsatzkalender.
 *
 * Zeigt ausschliesslich die eigenen Einsätze — die Einschränkung passiert
 * serverseitig in `/api/jobs/calendar` anhand der Rolle, nicht über einen
 * Filter im Frontend.
 */
export default async function PortalCalendarPage() {
  await requireEmployeeId();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Mein Kalender"
        description="Deine Einsätze im Wochen- und Monatsüberblick. Zum Bearbeiten öffnest du den Einsatz."
      />

      <PersonalCalendar />
    </div>
  );
}
