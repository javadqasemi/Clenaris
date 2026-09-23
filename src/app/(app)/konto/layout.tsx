import { redirect } from 'next/navigation';

import { prisma } from '@/lib/db';
import { serverEnv } from '@/lib/env';
import { getSession } from '@/lib/auth/session';
import { guardForPath, homeRouteFor } from '@/lib/auth/rbac';
import { AppShell, type NavGroup } from '@/components/app/app-shell';

/**
 * Rahmen des Kundenbereichs.
 *
 * Die Zähler zeigen nur, was eine Handlung erfordert: offene Rechnungen und
 * Offerten, die auf eine Antwort warten. Alles andere bleibt ohne Abzeichen —
 * ein Badge, das nie verschwindet, wird nach zwei Tagen ignoriert.
 */
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/auth/anmelden');

  /**
   * Eigene Rollenprüfung, obwohl die Middleware dieselbe Schranke kennt.
   *
   * Die Middleware ist ein Vorfilter, keine Autorisierung — das steht so in
   * `src/middleware.ts` und gilt für jeden Bereich. Das Mitarbeitendenportal
   * zieht seine Schranke deshalb selbst nach; der Kundenbereich tat es als
   * einziger nicht und war damit die eine Seite, die vollständig auf einer
   * Edge-Schicht ruhte. Zwei Zeilen sind billiger als die Frage, ob eine
   * Umgehung der Middleware hier etwas preisgibt.
   *
   * Die zugelassenen Rollen kommen aus `ROUTE_GUARDS`, nicht aus einer
   * zweiten Aufzählung — sonst driften die beiden Listen auseinander.
   */
  // Gerät übergeben → zur Rückgabeseite (siehe `portal/layout.tsx`).
  if (session.handoffId) redirect('/geraet-uebernehmen');
  const guard = guardForPath('/konto')!;
  if (!guard.roles.includes(session.role)) redirect(homeRouteFor(session.role));

  const customerId = session.role === 'CUSTOMER' ? session.profileId : null;

  const [openInvoices, openQuotes, unreadMessages] = customerId
    ? await Promise.all([
        prisma.invoice.count({
          where: {
            customerId,
            deletedAt: null,
            balance: { gt: 0 },
            status: { notIn: ['DRAFT', 'CANCELLED'] },
          },
        }),
        prisma.quote.count({
          where: { customerId, deletedAt: null, status: { in: ['SENT', 'VIEWED'] } },
        }),
        prisma.message.count({
          where: {
            thread: { customerId },
            authorType: { in: ['STAFF', 'SYSTEM'] },
            readAt: null,
          },
        }),
      ])
    : [0, 0, 0];

  const navigation: NavGroup[] = [
    {
      items: [
        { href: '/konto', label: 'Übersicht', icon: 'home', exact: true },
        { href: '/konto/buchungen', label: 'Meine Termine', icon: 'calendar' },
      ],
    },
    {
      label: 'Dokumente',
      items: [
        { href: '/konto/offerten', label: 'Offerten', icon: 'quotes', badge: openQuotes },
        { href: '/konto/rechnungen', label: 'Rechnungen', icon: 'invoices', badge: openInvoices },
      ],
    },
    {
      label: 'Verwaltung',
      items: [
        { href: '/konto/objekte', label: 'Meine Objekte', icon: 'building' },
        { href: '/konto/nachrichten', label: 'Nachrichten', icon: 'messages', badge: unreadMessages },
        { href: '/konto/bewertungen', label: 'Bewertungen', icon: 'reviews' },
        { href: '/konto/reklamationen', label: 'Reklamationen', icon: 'quality' },
      ],
    },
  ];

  return (
    <AppShell
      navigation={navigation}
      areaLabel="Kundenbereich"
      areaHref="/konto"
      settingsHref="/konto/profil"
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
