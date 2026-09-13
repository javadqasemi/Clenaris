import { redirect } from 'next/navigation';

import { prisma } from '@/lib/db';
import { serverEnv } from '@/lib/env';
import { getSession } from '@/lib/auth/session';
import { guardForPath, homeRouteFor } from '@/lib/auth/rbac';
import { AppShell, type NavGroup } from '@/components/app/app-shell';

/**
 * Rahmen des Mitarbeitendenportals.
 *
 * Zielgerät ist das Mobiltelefon: die Personen sind unterwegs, oft mit
 * Handschuhen und schlechtem Empfang. Deshalb wenige Menüpunkte, grosse
 * Berührungsflächen und keine Ansicht, die zwingend eine breite Spalte
 * braucht.
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/auth/anmelden');
  // Zugelassene Rollen zentral aus `ROUTE_GUARDS`, nicht hier aufgezählt.
  const guard = guardForPath('/portal')!;
  if (!guard.roles.includes(session.role)) redirect(homeRouteFor(session.role));

  const [todayJobs, openAbsences] = await Promise.all([
    session.profileId
      ? prisma.job.count({
          where: {
            deletedAt: null,
            status: { notIn: ['CANCELLED', 'COMPLETED', 'VERIFIED'] },
            scheduledStart: {
              gte: startOfToday(),
              lt: new Date(startOfToday().getTime() + 86_400_000),
            },
            assignments: { some: { employeeId: session.profileId } },
          },
        })
      : Promise.resolve(0),
    session.profileId
      ? prisma.absence.count({
          where: { employeeId: session.profileId, status: 'REQUESTED' },
        })
      : Promise.resolve(0),
  ]);

  const navigation: NavGroup[] = [
    {
      items: [
        { href: '/portal', label: 'Heute', icon: 'home', exact: true, badge: todayJobs },
        { href: '/portal/einsaetze', label: 'Meine Einsätze', icon: 'tasks' },
        { href: '/portal/kalender', label: 'Kalender', icon: 'calendar' },
        { href: '/portal/ziele', label: 'Meine Ziele', icon: 'target' },
        { href: '/portal/wissen', label: 'Wissen', icon: 'book' },
      ],
    },
    {
      label: 'Persönlich',
      items: [
        { href: '/portal/zeiterfassung', label: 'Zeiterfassung', icon: 'time' },
        { href: '/portal/abwesenheiten', label: 'Abwesenheiten', icon: 'calendar', badge: openAbsences },
        { href: '/portal/lohn', label: 'Lohnabrechnungen', icon: 'expenses' },
      ],
    },
  ];

  return (
    <AppShell
      navigation={navigation}
      areaLabel="Mitarbeitendenportal"
      areaHref="/portal"
      sessionIdleSeconds={serverEnv().SESSION_IDLE_TTL}
      user={{
        id: session.id,
        name: session.name,
        firstName: session.firstName,
        lastName: session.lastName,
        email: session.email,
        role: session.role,
        avatarUrl: session.avatarUrl,
        theme: session.theme,
      }}
    >
      {children}
    </AppShell>
  );
}

function startOfToday(): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}
