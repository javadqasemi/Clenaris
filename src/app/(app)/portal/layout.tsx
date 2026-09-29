import { redirect } from 'next/navigation';

import { prisma } from '@/lib/db';
import { getSession, sessionIdleSecondsFor } from '@/lib/auth/session';
import { can, guardForPath, homeRouteFor } from '@/lib/auth/rbac';
import { filterNavigation, type GuardedNavGroup } from '@/lib/auth/navigation';
import { zuercherTagesgrenzen } from '@/lib/zuerich';
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
  /**
   * Gerät übergeben → zur Rückgabeseite, bevor irgendetwas rendert.
   *
   * Die Middleware leitet bereits um, wenn das Zugangstoken die Sperre
   * trägt; sie läuft aber auf der Edge und kann nicht nachschlagen. Ein
   * Token, das vor der Übergabe ausgestellt wurde, kommt dort also durch.
   * Hier ist die Sperre nachgeschlagen (`getSession`) und damit verbindlich.
   */
  if (session.handoffId) redirect('/geraet-uebernehmen');
  // Zugelassene Rollen zentral aus `ROUTE_GUARDS`, nicht hier aufgezählt.
  const guard = guardForPath('/portal')!;
  if (!guard.roles.includes(session.role)) redirect(homeRouteFor(session.role));

  const [todayJobs, openAbsences, openTasks] = await Promise.all([
    session.profileId
      ? prisma.job.count({
          where: {
            deletedAt: null,
            status: { notIn: ['CANCELLED', 'COMPLETED', 'VERIFIED'] },
            scheduledStart: {
              // Das ausschliessende Ende ist der Beginn des nächsten Zürcher
              // Tages — an Umstellungstagen nicht 24 Stunden später.
              gte: zuercherTagesgrenzen().von,
              lt: zuercherTagesgrenzen().bis,
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
    // Dieselbe Auswahl wie `/portal/aufgaben`: eigene, offene, eigene Organisation.
    can(session.role, 'task:read')
      ? prisma.task.count({
          where: { organizationId: session.organizationId, assigneeId: session.id, status: { in: ['OPEN', 'IN_PROGRESS'] } },
        })
      : Promise.resolve(0),
  ]);

  /**
   * Die Navigation des Portals — gefiltert wie die der Verwaltung.
   *
   * Bis 2026-09-28 stand hier eine ungefilterte Liste. Das Portal betreten
   * aber auch Büro-Rollen (`ROUTE_GUARDS`), und nicht jede hält jedes Recht:
   * Die Betriebsleitung hat kein `objective:read_own`, „Meine Ziele" führte
   * sie auf eine Fehlerseite. Einträge, deren Seite ein Recht verlangt, nennen
   * es deshalb hier — dieselbe Angabe wie `requirePermission()` der Seite, die
   * vier Ebenen (Middleware, Rechteliste, Navigation, Seite) stimmen überein.
   * Einträge ohne Angabe verlangen ein Personalprofil, kein Recht.
   */
  const allNavigation: GuardedNavGroup[] = [
    {
      items: [
        { href: '/portal', label: 'Heute', icon: 'home', exact: true, badge: todayJobs },
        { href: '/portal/einsaetze', label: 'Meine Einsätze', icon: 'tasks' },
        // Eigene Aufgaben (2026-09-28): Ziel der Aufgabenmeldungen an Mitarbeitende.
        { href: '/portal/aufgaben', label: 'Meine Aufgaben', icon: 'checklist', badge: openTasks, permission: 'task:read' },
        { href: '/portal/kalender', label: 'Kalender', icon: 'calendar' },
        { href: '/portal/ziele', label: 'Meine Ziele', icon: 'target', permission: 'objective:read_own' },
        { href: '/portal/wissen', label: 'Wissen', icon: 'book', permission: 'knowledge:read' },
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
  const navigation: NavGroup[] = filterNavigation(allNavigation, session.role);

  return (
    <AppShell
      navigation={navigation}
      areaLabel="Mitarbeitendenportal"
      areaHref="/portal"
      // Im Portal löst der Scanner nur eigene Einsätze und deren Objekte auf
      // (`scan.service.ts`), mit Links ins Portal.
      scan={can(session.role, 'dashboard:view')}
      sessionIdleSeconds={sessionIdleSecondsFor(session.persistent)}
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
