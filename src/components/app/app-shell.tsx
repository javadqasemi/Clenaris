'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  BarChart3,
  Bell,
  Briefcase,
  Building2,
  CalendarDays,
  ChevronDown,
  ClipboardList,
  Contact,
  CreditCard,
  FileText,
  Gauge,
  Home,
  LogOut,
  Megaphone,
  Image as ImageIcon,
  KeyRound,
  Menu,
  MessageSquare,
  MousePointerClick,
  Newspaper,
  PenLine,
  Receipt,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Star,
  Timer,
  Truck,
  UserRound,
  Users,
  Wallet,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import type { UserRole } from '@prisma/client';

import { cn } from '@/lib/utils';
import { api, queryKeys } from '@/lib/api/client';
import { Logo } from '@/components/marketing/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { PersonAvatar, ScrollArea } from '@/components/ui/primitives';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/overlays';
import { NotificationPanel } from '@/components/app/notification-panel';

/**
 * Applikations-Rahmen für Administration, Mitarbeitendenportal und
 * Kundenbereich.
 *
 * Architekturentscheide:
 *  • Eine Komponente für alle drei Bereiche, konfiguriert über `navigation`.
 *    Die Bereiche unterscheiden sich im Inhalt, nicht in der Bedienlogik —
 *    wer zwischen ihnen wechselt (Admins tun das täglich), soll sich nicht
 *    umgewöhnen müssen.
 *  • Die Seitenleiste ist auf grossen Bildschirmen fix, darunter ein
 *    Schubfach. Kein einklappbarer Zwischenzustand: er kostet Zustand,
 *    Animation und Testaufwand, ohne echten Gewinn.
 *  • Der aktive Eintrag ist an Farbe *und* linker Markierung erkennbar.
 */

/**
 * Symbole der Navigation.
 *
 * Die Layouts sind Server Components und geben nur den *Namen* weiter, nicht
 * die Komponente: Funktionen lassen sich nicht über die Grenze zum Client
 * serialisieren. Die Auflösung passiert hier, auf der Client-Seite.
 */
const NAV_ICONS = {
  analytics: BarChart3,
  bookings: ShoppingBag,
  building: Building2,
  calendar: CalendarDays,
  campaigns: Megaphone,
  cards: CreditCard,
  content: PenLine,
  cta: MousePointerClick,
  customers: Users,
  dashboard: Gauge,
  expenses: Wallet,
  home: Home,
  invoices: Receipt,
  jobs: Truck,
  leads: Contact,
  media: ImageIcon,
  messages: MessageSquare,
  news: Newspaper,
  protocol: ScrollText,
  quotes: FileText,
  reviews: Star,
  roles: ShieldCheck,
  search: Search,
  settings: Settings,
  sparkles: Sparkles,
  staff: Briefcase,
  tasks: ClipboardList,
  time: Timer,
  user: UserRound,
  users: KeyRound,
} satisfies Record<string, React.ComponentType<{ className?: string }>>;

export type NavIcon = keyof typeof NAV_ICONS;

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  /** Zahl neben dem Eintrag, z. B. offene Aufgaben. */
  badge?: number;
  exact?: boolean;
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

export interface AppShellUser {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  role: UserRole;
  avatarUrl: string | null;
}

// Die Beschriftungen kommen aus der Rollendefinition — sonst laufen Oberfläche
// und Prüfprotokoll auseinander, sobald eine Rolle dazukommt.
import { ROLE_LABELS } from '@/lib/auth/rbac';

export function AppShell({
  navigation,
  user,
  areaLabel,
  areaHref,
  settingsHref,
  children,
}: {
  navigation: NavGroup[];
  user: AppShellUser;
  areaLabel: string;
  areaHref: string;
  settingsHref?: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = React.useState(false);

  React.useEffect(() => setMobileOpen(false), [pathname]);

  const unread = useQuery({
    queryKey: queryKeys.notifications(),
    queryFn: () => api.get<{ unread: number }>('/api/notifications/count'),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    router.replace('/');
    router.refresh();
  };

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center gap-3 border-b border-border px-5">
        <Logo href={areaHref} showWordmark={false} />
        <div className="min-w-0">
          <p className="truncate font-display text-sm font-bold leading-tight tracking-tight">
            Clenaris
          </p>
          <p className="truncate text-xs text-muted-foreground">{areaLabel}</p>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <nav className="space-y-6 p-3" aria-label="Bereichsnavigation">
          {navigation.map((group, groupIndex) => (
            <div key={group.label ?? groupIndex} className="space-y-1">
              {group.label ? (
                <p className="px-3 pb-1 text-xs font-medium text-muted-foreground">{group.label}</p>
              ) : null}

              {group.items.map((item) => {
                const active = item.exact
                  ? pathname === item.href
                  : pathname === item.href || pathname.startsWith(`${item.href}/`);
                const Icon = NAV_ICONS[item.icon];

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                      active
                        ? 'bg-primary/8 text-primary'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    {active ? (
                      <span
                        className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary"
                        aria-hidden
                      />
                    ) : null}
                    <Icon className="size-[1.125rem] shrink-0" aria-hidden />
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.badge ? (
                      <span className="rounded-full bg-primary/12 px-1.5 py-0.5 text-xs font-semibold tabular-nums text-primary">
                        {item.badge > 99 ? '99+' : item.badge}
                      </span>
                    ) : null}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
      </ScrollArea>

      <div className="shrink-0 border-t border-border p-3">
        <Link
          href="/"
          className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Logo href="/" showWordmark={false} className="pointer-events-none [&_svg]:size-[1.125rem]" />
          Zur Website
        </Link>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-dvh bg-surface">
      {/* Seitenleiste (Desktop) */}
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 border-r border-border bg-card lg:block">
        {sidebar}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Kopfzeile */}
        <header className="glass sticky top-0 z-40 flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Navigation öffnen">
                  <Menu aria-hidden />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-72 p-0">
                <SheetHeader className="sr-only">
                  <SheetTitle>Navigation</SheetTitle>
                </SheetHeader>
                {sidebar}
              </SheetContent>
            </Sheet>

            <Breadcrumbs navigation={navigation} pathname={pathname} areaHref={areaHref} areaLabel={areaLabel} />
          </div>

          <div className="flex items-center gap-1.5">
            <ThemeToggle className="hidden sm:inline-flex" />

            <NotificationPanel unreadCount={unread.data?.unread ?? 0}>
              <Button variant="ghost" size="icon" aria-label="Benachrichtigungen" className="relative">
                <Bell aria-hidden />
                {(unread.data?.unread ?? 0) > 0 ? (
                  <span className="absolute right-1.5 top-1.5 flex size-2 rounded-full bg-destructive ring-2 ring-background" />
                ) : null}
              </Button>
            </NotificationPanel>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-2 rounded-xl p-1 pr-2 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <PersonAvatar
                    firstName={user.firstName}
                    lastName={user.lastName}
                    src={user.avatarUrl}
                    size="sm"
                  />
                  <ChevronDown className="size-4 text-muted-foreground" aria-hidden />
                  <span className="sr-only">Konto-Menü öffnen</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel className="space-y-0.5 py-2">
                  <p className="text-sm font-medium text-foreground">{user.name}</p>
                  <p className="truncate text-xs font-normal text-muted-foreground">{user.email}</p>
                  <p className="text-xs font-normal text-muted-foreground">
                    {ROLE_LABELS[user.role] ?? user.role}
                  </p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href={`${areaHref}/profil`}>
                    <UserRound aria-hidden />
                    Mein Profil
                  </Link>
                </DropdownMenuItem>
                {settingsHref ? (
                  <DropdownMenuItem asChild>
                    <Link href={settingsHref}>
                      <Settings aria-hidden />
                      Einstellungen
                    </Link>
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={() => void logout()}>
                  <LogOut aria-hidden />
                  Abmelden
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main id="inhalt" className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}

/** Brotkrumen aus der Navigationskonfiguration ableiten. */
function Breadcrumbs({
  navigation,
  pathname,
  areaHref,
  areaLabel,
}: {
  navigation: NavGroup[];
  pathname: string;
  areaHref: string;
  areaLabel: string;
}) {
  const items = navigation.flatMap((group) => group.items);
  const match = items
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];

  return (
    <nav aria-label="Brotkrumen" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 text-sm">
        <li className="hidden sm:block">
          <Link
            href={areaHref}
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            {areaLabel}
          </Link>
        </li>
        {match && match.href !== areaHref ? (
          <>
            <li className="hidden text-muted-foreground sm:block" aria-hidden>
              /
            </li>
            <li className="truncate font-medium">{match.label}</li>
          </>
        ) : (
          <li className="truncate font-medium sm:hidden">{areaLabel}</li>
        )}
      </ol>
    </nav>
  );
}
