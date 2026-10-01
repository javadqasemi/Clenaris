'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity,
  BarChart3,
  Bell,
  BookOpen,
  Briefcase,
  Building2,
  CalendarDays,
  ChevronDown,
  ClipboardCheck,
  ClipboardList,
  Compass,
  Contact,
  CreditCard,
  Eraser,
  FileBarChart,
  FileSignature,
  FileText,
  FolderOpen,
  Gauge,
  GitFork,
  Home,
  Landmark,
  ListChecks,
  LogOut,
  Megaphone,
  Image as ImageIcon,
  KeyRound,
  LayoutDashboard,
  Menu,
  MessageSquare,
  MousePointerClick,
  Newspaper,
  PackageCheck,
  PenLine,
  PiggyBank,
  Presentation,
  Receipt,
  ScrollText,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Star,
  Target,
  Timer,
  Trash2,
  TrendingUp,
  Truck,
  UserRound,
  Users,
  Wallet,
  Wrench,
} from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { UserRole } from '@prisma/client';

import { cn } from '@/lib/utils';
import { abmeldungBeginnen, api, queryKeys } from '@/lib/api/client';
import { Logo, LogoMark } from '@/components/marketing/logo';
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
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/overlays';
import { GlobalSearch } from '@/components/app/global-search';
import { ScanButton } from '@/components/app/scan-button';
import { NotificationPanel } from '@/components/app/notification-panel';
import { NavigationProgress } from '@/components/app/navigation-progress';
import { ThemeSync } from '@/features/account/appearance-form';
import { SessionKeepalive, abmeldungVerbreiten } from '@/features/account/session-keepalive';

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
  contract: FileSignature,
  cta: MousePointerClick,
  customers: Users,
  dashboard: Gauge,
  expenses: Wallet,
  home: Home,
  invoices: Receipt,
  jobs: Truck,
  layout: LayoutDashboard,
  leads: Contact,
  media: ImageIcon,
  messages: MessageSquare,
  news: Newspaper,
  protocol: ScrollText,
  eraser: Eraser,
  quality: ClipboardCheck,
  quotes: FileText,
  reviews: Star,
  roles: ShieldCheck,
  search: Search,
  settings: Settings,
  sparkles: Sparkles,
  staff: Briefcase,
  tasks: ClipboardList,
  time: Timer,
  trash: Trash2,
  updates: PackageCheck,
  user: UserRound,
  users: KeyRound,
  // Unternehmensführung
  actions: Wrench,
  book: BookOpen,
  budget: PiggyBank,
  checklist: ListChecks,
  cockpit: Activity,
  compass: Compass,
  documents: FolderOpen,
  investment: Landmark,
  kpi: TrendingUp,
  meeting: Presentation,
  reports: FileBarChart,
  scenario: GitFork,
  shield: ShieldAlert,
  target: Target,
} satisfies Record<string, React.ComponentType<{ className?: string }>>;

export type NavIcon = keyof typeof NAV_ICONS;

/**
 * Seiten, die bewusst keinen Menüpunkt haben (Profil, Suche, Etikett,
 * Assistent), aber in den Brotkrumen einen Namen brauchen. Ohne diese Liste
 * stand dort nur der Bereichsname, als wäre man auf der Startseite.
 */
const SEITEN_OHNE_MENUEPUNKT: [string, string][] = [
  ['/admin/profil', 'Mein Profil'],
  ['/portal/profil', 'Mein Profil'],
  ['/konto/profil', 'Mein Profil'],
  ['/admin/suche', 'Suche'],
  ['/admin/etikett', 'Etikett'],
  ['/admin/fuehrung/assistent', 'Assistent'],
];

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
  /** Farbschema aus dem Konto — greift auf Geräten ohne eigene Wahl. */
  theme?: string | null;
}

// Die Beschriftungen kommen aus der Rollendefinition — sonst laufen Oberfläche
// und Prüfprotokoll auseinander, sobald eine Rolle dazukommt.
import { ROLE_LABELS } from '@/lib/auth/rbac';

export function AppShell({
  navigation,
  user,
  areaLabel,
  areaHref,
  search = false,
  scan = false,
  sessionIdleSeconds = 900,
  children,
}: {
  navigation: NavGroup[];
  user: AppShellUser;
  areaLabel: string;
  areaHref: string;
  /**
   * Globale Suche in der Kopfzeile. Nur die Administration setzt sie: Der
   * Endpunkt verlangt `dashboard:view`, und seine Treffer führen in
   * `/admin/…` — im Portal und im Kundenbereich wäre jeder Treffer ein Link
   * auf eine verschlossene Tür.
   */
  search?: boolean;
  /**
   * Scanner in der Kopfzeile. Administration und Portal setzen ihn — der
   * Endpunkt verlangt `dashboard:view`, den die Kundschaft nicht hat, und
   * löst je Bereich nur auf, was die Rolle dort öffnen kann.
   */
  scan?: boolean;
  /** Sekunden ohne Aktivität bis zur Abmeldung — aus `SESSION_IDLE_TTL`. */
  sessionIdleSeconds?: number;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [mobileOpen, setMobileOpen] = React.useState(false);

  React.useEffect(() => setMobileOpen(false), [pathname]);

  /**
   * **Bis zum Einhängen passiert im Rahmen nichts.**
   *
   * Das ist die tragende Regel dieser Komponente, und sie ist teuer erkauft.
   * Der Server rendert den Rahmen ohne Browserdaten; der erste Rendervorgang
   * im Browser muss dasselbe ergeben, sonst verwirft React den **ganzen** Baum
   * (`Minified React error #418`) und baut ihn neu.
   *
   * Gemessen am 2026-09-20 im vollen Chromium auf `/portal/einsaetze`: ohne
   * Eingriff 4 von 8 Aufrufen mit Hydrationsfehler. Die vollständige
   * Untersuchung samt Messreihen steht in `docs/HYDRATION.md`.
   *
   * `eingehaengt` ist der Schalter dafür: Es ist beim Rendern auf dem Server
   * und beim ersten Durchgang im Browser nachweislich `false` — `useState`
   * liefert den Anfangswert, und der Effekt läuft erst nach dem Festschreiben.
   */
  const [eingehaengt, setEingehaengt] = React.useState(false);
  React.useEffect(() => setEingehaengt(true), []);

  /**
   * Der Zähler der Glocke — abgefragt erst **nach** dem Einhängen.
   *
   * `enabled`, nicht nur eine Fallunterscheidung bei der Anzeige. Vorher lief
   * die Abfrage sofort und nur die *Anzeige* war festgenagelt. Das genügte für
   * die Gleichheit des ersten Rendervorgangs, aber nicht für die Ruhe im Baum:
   * `useQuery` hängt über `useSyncExternalStore` an einem äusseren Speicher,
   * und jede Antwort — auch eine fehlgeschlagene samt Wiederholung — stösst
   * währenddessen einen neuen Durchgang an. Mit `enabled` passiert bis zum
   * Einhängen gar nichts: keine Anfrage, kein Speicherereignis, kein
   * zusätzlicher Durchgang. Der sichtbare Unterschied ist keiner.
   *
   * `refetchOnWindowFocus` hebt die anwendungsweite Vorgabe auf: Für Listen
   * ist Nachladen beim Tab-Wechsel eine Nachladewelle, für diese eine Zahl ist
   * es der Moment, in dem sie am ehesten falsch ist. Wer nach einer halben
   * Stunde zurückkommt, soll nicht auf eine veraltete Null schauen.
   */
  const unread = useQuery({
    queryKey: queryKeys.notifications(),
    queryFn: () => api.get<{ unread: number }>('/api/notifications/count'),
    enabled: eingehaengt,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });

  const unreadCount = eingehaengt ? (unread.data?.unread ?? 0) : 0;

  const logout = async () => {
    // Vor dem Aufruf: Ab hier ist jedes 401 die erwartete Folge der Abmeldung,
    // kein Anlass für „Sitzung abgelaufen" (`abmeldungBeginnen` in `lib/api/client.ts`).
    abmeldungBeginnen();
    /*
      Die Daten der beendeten Sitzung verlassen den Speicher (2026-10-01).
      Der Abfragezwischenspeicher hängt an der Wurzel (`components/providers.tsx`)
      und überlebt die clientseitige Navigation auf die Startseite. Bis hierher
      blieben Kundenlisten, Kalender und Glocke der abgemeldeten Person im Tab
      — und wer sich danach am selben Gerät anmeldete, bekam für Abfragen mit
      gleichem Schlüssel zuerst die Daten der vorigen Sitzung zu sehen, bis
      die eigene Antwort sie ersetzte. Gefunden mit dem Fall „nach Abmelden und
      neuer Anmeldung im selben Tab" (`tests/e2e/abmelden.spec.ts`): Die Glocke
      der neuen Sitzung fragte gar nicht erst, weil der alte Wert noch frisch
      war. Abfragen, die nach dem Leeren neu anlaufen, sperrt
      `lib/api/client.ts` während der Abmeldung, ohne das Netz zu berühren.
    */
    await queryClient.cancelQueries();
    queryClient.clear();
    await api.post('/api/auth/logout').catch(() => undefined);
    // Die anderen Tabs dieser Sitzung zur Anmeldung schicken, statt sie mit
    // toten Cookies weiterarbeiten zu lassen (2026-09-28).
    abmeldungVerbreiten();
    router.replace('/');
    router.refresh();
  };

  const navigationsliste = (
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
                    {/*
                      Die Markierung des aktiven Eintrags steht **immer** im
                      Baum und wird nur ein- und ausgefärbt.

                      Vorher hing ihre Existenz an `active`, und `active` hängt
                      an `usePathname()` — dem einzigen Wert im Rahmen, der aus
                      dem Router kommt und nicht aus Server-Eigenschaften. Damit
                      war die *Zahl der Elemente* von Client-Zustand abhängig,
                      und genau das ist die Form, die einen Hydrationsfehler
                      auslöst: React verlangt beim ersten Durchgang dieselbe
                      Struktur wie im ausgelieferten HTML; abweichende
                      Attribute flickt es stillschweigend, ein fehlendes oder
                      überzähliges Element nicht.

                      Der Grundsatz, der daraus folgt und für den ganzen
                      Anwendungsrahmen gilt (`docs/HYDRATION.md` §9): **Die
                      Struktur des Rahmens darf nicht von Client-Zustand
                      abhängen — nur Attribute und Text dürfen es.**
                    */}
                    <span
                      className={cn(
                        'absolute inset-y-2 left-0 w-0.5 rounded-full',
                        active ? 'bg-primary' : 'bg-transparent',
                      )}
                      aria-hidden
                    />
                    <Icon className="size-[1.125rem] shrink-0" aria-hidden />
                    <span className="flex-1 truncate">{item.label}</span>
                    {/*
                      Die Zahl daneben kommt aus den Server-Eigenschaften und
                      ist auf beiden Seiten dieselbe — sie darf deshalb
                      weiterhin ganz entfallen.
                    */}
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
  );

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

      <ScrollArea className="flex-1">{navigationsliste}</ScrollArea>

      <div className="shrink-0 border-t border-border p-3">
        <Link
          href="/"
          className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {/*
            `LogoMark` statt `Logo`: `Logo` bringt seinen eigenen `Link` mit,
            und der landete hier im `Link` darüber — ein `<a>` im `<a>`. Das
            erlaubt das HTML-Parsing-Modell nicht; der Browser bricht den
            äusseren Anker vor dem inneren auf, React erwartet beim Hydrieren
            aber die verschachtelte Struktur aus dem Server-HTML. Ergebnis war
            ein Hydration-Fehler auf jeder Seite von `/admin`, `/portal` und
            `/konto`.

            Das frühere `pointer-events-none` zeigt, dass das Symptom bekannt
            war: Es nahm dem inneren Anker den Klick, nicht aber seine
            Existenz. `LogoMark` rendert nur das SVG und löst damit die
            Ursache statt der Wirkung — der Klickbereich bleibt die ganze
            Zeile, weil der äussere `Link` sie umschliesst.
          */}
          <LogoMark className="size-[1.125rem]" />
          Zur Website
        </Link>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-dvh bg-surface">
      {/*
        Rendert nichts — überträgt nur die Kontoeinstellung auf ein Gerät, das
        noch keine eigene getroffen hat.
      */}
      {user.theme ? <ThemeSync preference={user.theme} /> : null}
      {/*
        Ebenfalls unsichtbar: hält die Sitzung am Leben, solange gearbeitet
        wird, und beendet sie nach Leerlauf — siehe `session-keepalive.tsx`.
      */}
      <SessionKeepalive idleSeconds={sessionIdleSeconds} />
      {/*
        Rückmeldung beim Seitenwechsel. Sie hat die Skelette aus den
        `loading.tsx`-Dateien abgelöst, die in Wave 9.1 entfallen mussten —
        die Messreihe dazu steht in `docs/HYDRATION.md`. Vor dem ersten Klick
        rendert die Komponente nichts, auf dem Server wie im Browser; sonst
        brächte ausgerechnet die Abhilfe den Hydrationsfehler zurück.
      */}
      <NavigationProgress />

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
                  <SheetDescription>Bereiche dieses Kontos. Escape schliesst das Menü.</SheetDescription>
                </SheetHeader>
                {sidebar}
              </SheetContent>
            </Sheet>

            <Breadcrumbs navigation={navigation} pathname={pathname} areaHref={areaHref} areaLabel={areaLabel} />
          </div>

          {/*
            Die Suche steht in der Mitte der Kopfzeile, nicht in der
            Seitenleiste: Sie ist auf jeder Seite derselbe Einstieg und auf
            dem Telefon sonst erst hinter dem Schubfach erreichbar. `search`
            kommt aus den Server-Eigenschaften — auf beiden Seiten derselbe
            Wert, die Struktur bleibt beim Hydrieren gleich.
          */}
          {search ? (
            <div className="flex min-w-0 flex-1 items-center justify-end md:justify-center">
              <GlobalSearch />
            </div>
          ) : null}

          <div className="flex items-center gap-1.5">
            {/*
              Scanner vor allem anderen rechts — auf dem Telefon ist er der
              Grund, die App im Lager oder vor einem Gerät zu öffnen. `scan`
              kommt wie `search` aus den Server-Eigenschaften.
            */}
            {scan ? <ScanButton /> : null}
            {/*
              Früher ab `sm` ausgeblendet, weil das Dreiersegment auf einem
              Telefon die Zeile sprengte. Als Symbolknopf passt es überall —
              und gerade unterwegs wechselt man das Farbschema am ehesten.
            */}
            <ThemeToggle />

            <NotificationPanel unreadCount={unreadCount}>
              <Button
                variant="ghost"
                size="icon"
                className="relative"
                aria-label={
                  unreadCount > 0
                    ? `Benachrichtigungen: ${unreadCount} ungelesen`
                    : 'Benachrichtigungen'
                }
              >
                <Bell aria-hidden />
                {/*
                  Die Zahl, nicht nur ein Punkt. Ein Punkt sagt „irgendetwas
                  ist da" — und beantwortet damit die einzige Frage nicht, die
                  darüber entscheidet, ob man jetzt hinschaut oder später.
                */}
                {unreadCount > 0 ? (
                  <span
                    className="absolute -right-0.5 -top-0.5 flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full bg-destructive px-1 text-[0.625rem] font-bold leading-none tabular-nums text-destructive-foreground ring-2 ring-background"
                    aria-hidden
                  >
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
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
                {/*
                  Persönliche Einstellungen — in jedem Bereich, fest unter dem
                  Profil. Bis 2026-09-26 war das Ziel eine Eigenschaft des
                  Layouts, und die Administration setzte sie auf
                  `/admin/einstellungen`: Das Kontomenü führte in die
                  Betriebseinstellungen. Ein Menü, das „Mein Profil" heisst,
                  darf nur zum eigenen Konto führen; die Firmenkonfiguration
                  steht in der Seitenleiste unter „Betrieb", mit eigenem Recht.
                  Seit 2026-09-28 heisst der Eintrag auch so: „Einstellungen"
                  allein stand in der Verwaltung neben dem gleichnamigen
                  Seitenleisteneintrag der Firmenkonfiguration und liess offen,
                  welche von beiden gemeint ist.
                */}
                <DropdownMenuItem asChild>
                  <Link href={`${areaHref}/profil/einstellungen`}>
                    <Settings aria-hidden />
                    Persönliche Einstellungen
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={() => void logout()}>
                  <LogOut aria-hidden />
                  Abmelden
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {/*
          Die Arbeitsfläche wächst mit, aber nicht unbegrenzt.

          Ohne Deckel zieht sich eine Liste auf einem 49-Zöller über 4700 px:
          Der Blick muss dann zwischen der ersten und der letzten Spalte
          derselben Zeile über einen halben Meter wandern, und genau dabei
          verliert man die Zeile. 120 rem sind bei der auf solchen Geräten
          angehobenen Grundschrift (siehe `globals.css`) rund 2900 px — breit
          genug, dass eine Rechnungstabelle alle Spalten ohne Querlauf zeigt,
          schmal genug, dass eine Zeile in einem Blick erfassbar bleibt.

          Der Wert in `rem` ist hier wichtiger als in Pixeln: Er deckelt erst
          jenseits jedes üblichen Bildschirms — bis 2240 px Arbeitsfläche
          ändert sich nichts — und wächst danach im selben Takt wie die
          Schrift.
        */}
        <main id="inhalt" className="mx-auto w-full min-w-0 max-w-[120rem] flex-1 p-4 sm:p-6 lg:p-8">
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
  // `exact` gilt hier wie in der Seitenleiste (2026-09-27): Vorher hiess
  // `/admin/fuehrung/assistent` in den Brotkrumen „Cockpit", während in der
  // Seitenleiste nichts aktiv war — zwei Antworten auf „wo bin ich?".
  const match = items
    .filter((item) => pathname === item.href || (!item.exact && pathname.startsWith(`${item.href}/`)))
    .sort((a, b) => b.href.length - a.href.length)[0];

  const unterseite =
    match && match.href !== areaHref ? match.label : (SEITEN_OHNE_MENUEPUNKT.find(([pfad]) => pathname === pfad || pathname.startsWith(`${pfad}/`))?.[1] ?? null);

  /*
    Auch hier hängt die Struktur nicht mehr am Pfad.

    Vorher standen zwei verschiedene Zweige nebeneinander — zwei `<li>` für
    eine Unterseite, eines für die Bereichsstartseite. Damit hing die Zahl der
    Elemente an `usePathname()`, also am einzigen Wert im Rahmen, der nicht aus
    Server-Eigenschaften stammt. Jetzt stehen immer dieselben drei `<li>`; was
    sich ändert, sind Klassen und Text.

    Die Bedeutung bleibt gleich: Auf schmalen Geräten ist der Bereichsname
    ausgeblendet und stattdessen die Unterseite zu sehen — oder, wenn man auf
    der Bereichsstartseite steht, der Bereichsname selbst.
  */
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
        <li className={cn('text-muted-foreground', unterseite ? 'hidden sm:block' : 'hidden')} aria-hidden>
          /
        </li>
        <li className={cn('truncate font-medium', unterseite ? '' : 'sm:hidden')}>
          {unterseite ?? areaLabel}
        </li>
      </ol>
    </nav>
  );
}
