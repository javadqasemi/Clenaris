import { redirect } from 'next/navigation';

import { prisma } from '@/lib/db';
import { serverEnv } from '@/lib/env';
import { getSession } from '@/lib/auth/session';
import { guardForPath, homeRouteFor } from '@/lib/auth/rbac';
import { AppShell } from '@/components/app/app-shell';
import { filterNavigation, type GuardedNavGroup } from '@/lib/auth/navigation';
import { getOrganizationId } from '@/server/services/organization.service';
import { countDueReviews } from '@/server/services/insight.service';

/**
 * Rahmen der Administration.
 *
 * Die Zähler in der Navigation (offene Buchungen, nicht zugeteilte Einsätze,
 * überfällige Rechnungen) werden hier serverseitig geladen. Das sind die drei
 * Zahlen, die im Tagesgeschäft eine Handlung auslösen — sie gehören sichtbar
 * in die Navigation, nicht auf eine Unterseite.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  // Ohne Bereichsparameter: es gibt eine Anmeldung für alle Rollen. Das
  // Rücksprungziel setzt die Middleware (`?weiter=…`) — sie kennt den Pfad,
  // ein Layout kennt ihn nicht.
  if (!session) redirect('/auth/anmelden');
  // Die zugelassenen Rollen stehen in `ROUTE_GUARDS` — dieselbe Liste, die
  // auch die Middleware prüft. Eine zweite, hier ausgeschriebene Aufzählung
  // wäre beim nächsten Rollenzuwachs stillschweigend falsch (genau das ist mit
  // SUPER_ADMIN passiert).
  const guard = guardForPath('/admin')!;
  if (!guard.roles.includes(session.role)) redirect(homeRouteFor(session.role));

  const organizationId = await getOrganizationId();

  const [
    pendingBookings,
    unassignedJobs,
    overdueInvoices,
    openLeads,
    pendingReviews,
    openAbsences,
    unreadMessages,
    due,
  ] = await Promise.all([
      prisma.booking.count({
        where: { organizationId, deletedAt: null, status: 'PENDING' },
      }),
      prisma.job.count({
        where: {
          organizationId,
          deletedAt: null,
          status: 'UNASSIGNED',
          scheduledStart: { gte: new Date() },
        },
      }),
      prisma.invoice.count({
        where: { organizationId, deletedAt: null, status: 'OVERDUE' },
      }),
      prisma.lead.count({
        where: { organizationId, deletedAt: null, status: { in: ['NEW', 'CONTACTED'] } },
      }),
      prisma.review.count({ where: { organizationId, status: 'PENDING' } }),
      prisma.absence.count({
        where: { status: 'REQUESTED', employee: { organizationId } },
      }),
      // Verläufe mit mindestens einer ungelesenen Kundennachricht.
      prisma.messageThread.count({
        where: {
          closed: false,
          customer: { organizationId },
          messages: { some: { authorType: 'CUSTOMER', readAt: null } },
        },
      }),
      // Fällige Prüfungen und ablaufende Dokumente — die zwei Zahlen, die im
      // Führungsbereich eine Handlung auslösen.
      countDueReviews(organizationId),
    ]);

  /**
   * Die Navigation der Administration.
   *
   * Jeder Eintrag nennt die Berechtigung, die ihn sichtbar macht. Gefiltert
   * wird auf dem Server, bevor irgendetwas gerendert wird — ein Menüpunkt, den
   * erst CSS ausblendet, stünde im ausgelieferten HTML und wäre ein Wegweiser
   * auf eine verschlossene Tür. Wird eine Gruppe dadurch leer, verschwindet
   * sie mit; eine Überschrift ohne Einträge sieht nach einem Fehler aus.
   */
  const allNavigation: GuardedNavGroup[] = [
    {
      items: [
        { href: '/admin', label: 'Übersicht', icon: 'dashboard', exact: true, permission: 'dashboard:view' },
        { href: '/admin/kalender', label: 'Einsatzkalender', icon: 'calendar', permission: 'job:read' },
      ],
    },
    {
      label: 'Auftragsabwicklung',
      items: [
        { href: '/admin/buchungen', label: 'Buchungen', icon: 'bookings', badge: pendingBookings, permission: 'booking:read' },
        { href: '/admin/einsaetze', label: 'Einsätze', icon: 'jobs', badge: unassignedJobs, permission: 'job:read' },
        { href: '/admin/offerten', label: 'Offerten', icon: 'quotes', permission: 'quote:read' },
      ],
    },
    {
      label: 'Kundschaft',
      items: [
        { href: '/admin/leads', label: 'Leads', icon: 'leads', badge: openLeads, permission: 'lead:read' },
        { href: '/admin/kunden', label: 'Kunden', icon: 'customers', permission: 'customer:read' },
        { href: '/admin/nachrichten', label: 'Nachrichten', icon: 'messages', badge: unreadMessages, permission: 'message:read' },
        { href: '/admin/objekte', label: 'Objekte', icon: 'building', permission: 'property:read' },
        { href: '/admin/aufgaben', label: 'Aufgaben', icon: 'tasks', permission: 'task:read' },
      ],
    },
    {
      label: 'Finanzen',
      items: [
        { href: '/admin/rechnungen', label: 'Rechnungen', icon: 'invoices', badge: overdueInvoices, permission: 'invoice:read' },
        { href: '/admin/zahlungen', label: 'Zahlungen', icon: 'cards', permission: 'payment:read' },
        { href: '/admin/ausgaben', label: 'Ausgaben', icon: 'expenses', permission: 'expense:read' },
        { href: '/admin/auswertungen', label: 'Auswertungen', icon: 'analytics', permission: 'report:read' },
      ],
    },
    {
      label: 'Unternehmensführung',
      items: [
        { href: '/admin/fuehrung', label: 'Cockpit', icon: 'cockpit', exact: true, permission: 'cockpit:view' },
        { href: '/admin/fuehrung/kennzahlen', label: 'Kennzahlen', icon: 'kpi', permission: 'kpi:read' },
        { href: '/admin/fuehrung/ziele', label: 'Ziele und Strategie', icon: 'target', badge: due.objectives, permission: 'objective:read' },
        { href: '/admin/fuehrung/budget', label: 'Budget', icon: 'budget', permission: 'budget:read' },
        { href: '/admin/fuehrung/investitionen', label: 'Investitionen', icon: 'investment', permission: 'investment:read' },
        { href: '/admin/fuehrung/szenarien', label: 'Szenarien', icon: 'scenario', permission: 'scenario:read' },
        { href: '/admin/fuehrung/risiken', label: 'Risiken', icon: 'shield', badge: due.risks, permission: 'risk:read' },
        { href: '/admin/fuehrung/qualitaet', label: 'Qualität und Compliance', icon: 'checklist', badge: due.controls, permission: 'control:read' },
        { href: '/admin/fuehrung/massnahmen', label: 'Massnahmen', icon: 'actions', permission: 'action:read' },
        { href: '/admin/fuehrung/dokumente', label: 'Dokumente', icon: 'documents', badge: due.documents, permission: 'document:read' },
        { href: '/admin/fuehrung/wissen', label: 'Wissen', icon: 'book', permission: 'knowledge:read' },
        { href: '/admin/fuehrung/markt', label: 'Markt und Wettbewerb', icon: 'compass', badge: due.market, permission: 'market:read' },
        { href: '/admin/fuehrung/sitzungen', label: 'Sitzungen', icon: 'meeting', permission: 'meeting:read' },
        { href: '/admin/fuehrung/berichte', label: 'Berichte', icon: 'reports', permission: 'bireport:read' },
      ],
    },
    {
      label: 'Website',
      items: [
        // Redaktions- und SEO-Maske bestehen nur aus Eingabefeldern; sie
        // erscheinen deshalb erst mit dem Schreibrecht — dieselbe Schwelle,
        // die auch die Middleware setzt. Sonst zeigte das Menü eine Tür, die
        // beim Anklicken zurückweist.
        { href: '/admin/inhalte', label: 'Website-Texte', icon: 'content', permission: 'content:update' },
        { href: '/admin/website', label: 'Fragen, Galerie, Menü', icon: 'layout', permission: 'faq:read' },
        { href: '/admin/cta', label: 'Handlungsaufrufe', icon: 'cta', permission: 'cta:read' },
        { href: '/admin/medien', label: 'Mediathek', icon: 'media', permission: 'media:read' },
        { href: '/admin/seo', label: 'Suchmaschinen', icon: 'search', permission: 'seo:update' },
        { href: '/admin/blog', label: 'Blog', icon: 'news', permission: 'blog:read' },
        { href: '/admin/bewertungen', label: 'Bewertungen', icon: 'reviews', badge: pendingReviews, permission: 'review:read' },
      ],
    },
    {
      label: 'Marketing',
      items: [
        { href: '/admin/marketing', label: 'Kampagnen', icon: 'campaigns', permission: 'newsletter:read' },
        { href: '/admin/ki', label: 'KI-Werkzeuge', icon: 'sparkles', permission: 'ai:use' },
      ],
    },
    {
      label: 'Betrieb',
      items: [
        { href: '/admin/personal', label: 'Mitarbeitende', icon: 'staff', badge: openAbsences, permission: 'employee:read' },
        { href: '/admin/einstellungen', label: 'Einstellungen', icon: 'settings', permission: 'settings:read' },
      ],
    },
    {
      label: 'System',
      items: [
        { href: '/admin/benutzer', label: 'Benutzerkonten', icon: 'users', permission: 'user:read' },
        { href: '/admin/rollen', label: 'Rollen und Rechte', icon: 'roles', permission: 'role:read' },
        { href: '/admin/protokoll', label: 'Prüfprotokoll', icon: 'protocol', permission: 'audit:read' },
        // Wer löschen darf, darf wiederherstellen — dieselbe Schwelle wie die
        // Seite selbst (`booking:delete` haben Leitung und Administration).
        { href: '/admin/papierkorb', label: 'Papierkorb', icon: 'trash', permission: 'booking:delete' },
      ],
    },
  ];

  const navigation = filterNavigation(allNavigation, session.role);

  return (
    <AppShell
      navigation={navigation}
      areaLabel="Administration"
      areaHref="/admin"
      settingsHref="/admin/einstellungen"
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
