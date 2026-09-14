'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BookOpen,
  Briefcase,
  ChevronDown,
  HelpCircle,
  Images,
  Menu,
  Phone,
  Star,
  Users,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { isVisible } from '@/lib/cta/match';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/marketing/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { AccountButton, ACCOUNT_LINKS } from '@/components/marketing/account-button';
import { ServiceIcon } from '@/components/marketing/service-icon';
import { CtaButton, CtaSlot, type CtaData } from '@/components/marketing/cta-button';
import {
  NavPanel,
  NavPanelAction,
  NavPanelFooter,
  NavPanelGrid,
  NavPanelHeading,
  NavPanelItem,
} from '@/components/marketing/nav-panel';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/overlays';

/**
 * Kopfzeile der öffentlichen Website.
 *
 * Gestaltungsentscheide:
 *
 *  • **Vier Einträge, nicht sieben.** Die Navigation folgt den Fragen, die
 *    Besuchende tatsächlich stellen — was macht ihr, was kostet es, kommt ihr
 *    zu mir, kann ich euch trauen. Alles Weitere (Galerie, Bewertungen, FAQ,
 *    Ratgeber, Stellen) liegt darunter im Menü „Einblick", statt die Leiste
 *    zu verlängern. Vorher standen sieben Punkte oben und vier Seiten waren
 *    nur über den Fussbereich erreichbar; jetzt ist alles oben auffindbar und
 *    die Leiste trotzdem kürzer.
 *
 *  • **Der aktive Punkt ist an Farbe *und* Unterstrich erkennbar.** Farbe
 *    allein trägt die Information nicht — bei Rot-Grün-Schwäche und auf
 *    schlechten Bildschirmen verschwindet sie.
 *
 *  • **Die Telefonnummer schrumpft mit.** Ab 1280 px steht sie ausgeschrieben,
 *    darunter bleibt der Hörer als Schaltfläche. Das spart rund 130 px, ohne
 *    den wichtigsten Kontaktweg eines lokalen Betriebs zu verstecken.
 *
 *  • Glas kommt in der ganzen Applikation nur an zwei Stellen vor — hier und
 *    in der schwebenden Buchungsleiste. Eine Wirkung, die überall auftaucht,
 *    ist keine Wirkung mehr.
 */

export interface HeaderService {
  slug: string;
  name: string;
  shortDesc: string;
  /** Name des Lucide-Symbols, wie am Katalogdatensatz hinterlegt. */
  icon: string;
}

/** Direkte Einträge — die beiden häufigsten Fragen vor der Buchung. */
const DIRECT_LINKS = [
  { href: '/preise', label: 'Preise' },
  { href: '/einsatzgebiet', label: 'Einsatzgebiet' },
];

/**
 * Alles, was Vertrauen stiftet, unter einem Dach. Der Name ist absichtlich
 * nicht „Mehr": ein Menü, das nicht sagt, was drin ist, wird nicht geöffnet.
 */
const INSIGHT_LINKS = [
  {
    href: '/galerie',
    label: 'Vorher / Nachher',
    description: 'Ergebnisse aus echten Aufträgen',
    Icon: Images,
  },
  {
    href: '/bewertungen',
    label: 'Bewertungen',
    description: 'Was Kundschaft über uns schreibt',
    Icon: Star,
  },
  {
    href: '/ueber-uns',
    label: 'Über uns',
    description: 'Team, Werte und Arbeitsweise',
    Icon: Users,
  },
  {
    href: '/faq',
    label: 'Häufige Fragen',
    description: 'Ablauf, Schlüssel, Abgabegarantie',
    Icon: HelpCircle,
  },
  {
    href: '/blog',
    label: 'Ratgeber',
    description: 'Tipps zu Reinigung und Übergabe',
    Icon: BookOpen,
  },
  {
    href: '/karriere',
    label: 'Offene Stellen',
    description: 'Wir stellen laufend ein',
    Icon: Briefcase,
  },
];

const INSIGHT_PATHS = INSIGHT_LINKS.map((link) => link.href);

export function SiteHeader({
  services,
  phone,
  ctas,
  mobileCtas,
}: {
  services: HeaderService[];
  phone: string;
  /** Aufrufe für die Kopfzeile — noch ungefiltert, siehe `CtaSlot`. */
  ctas: CtaData[];
  /** Aufrufe für das mobile Menü. */
  mobileCtas: CtaData[];
}) {
  const pathname = usePathname();
  const [scrolled, setScrolled] = React.useState(false);
  const [mobileOpen, setMobileOpen] = React.useState(false);

  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  React.useEffect(() => setMobileOpen(false), [pathname]);

  /**
   * Im mobilen Menü stehen dieselben Aufrufe wie in der Kopfzeile, ergänzt um
   * die für die feste Leiste gedachten. Die Auswahl nach Pfad passiert hier
   * von Hand, weil die Schaltflächen einzeln und über die volle Breite
   * gerendert werden — `CtaSlot` setzt sie nebeneinander.
   */
  const mobileButtons = React.useMemo(() => {
    const now = new Date();
    return [...ctas, ...mobileCtas]
      .filter((cta) =>
        isVisible(
          {
            pages: cta.pages ?? [],
            publishFrom: cta.publishFrom ?? null,
            publishUntil: cta.publishUntil ?? null,
          },
          pathname,
          now,
        ),
      )
      .slice(0, 3);
  }, [ctas, mobileCtas, pathname]);

  const servicesActive = pathname.startsWith('/leistungen');
  const insightActive = INSIGHT_PATHS.some(
    (href) => pathname === href || pathname.startsWith(`${href}/`),
  );

  /** Gemeinsame Gestalt der obersten Ebene — Menütitel wie Direktlinks. */
  const topLevel = (active: boolean) =>
    cn(
      'relative inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors',
      'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      // Unterstrich zusätzlich zur Farbe: die Information darf nicht allein
      // an der Farbe hängen.
      'after:absolute after:inset-x-3 after:-bottom-0.5 after:h-0.5 after:rounded-full after:bg-primary after:transition-opacity',
      active ? 'text-primary after:opacity-100' : 'text-foreground after:opacity-0',
    );

  return (
    <header
      className={cn(
        'sticky top-0 z-50 w-full transition-[background-color,border-color,box-shadow] duration-300',
        scrolled ? 'glass border-b border-border shadow-soft' : 'border-b border-transparent',
      )}
    >
      <div className="container flex h-[4.5rem] items-center justify-between gap-4">
        <div className="flex items-center gap-8">
          <Logo />

          <nav className="hidden items-center gap-1 lg:flex" aria-label="Hauptnavigation">
            {/* Leistungen */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className={topLevel(servicesActive)} aria-current={servicesActive ? 'true' : undefined}>
                  Leistungen
                  <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-[44rem] max-w-[calc(100vw-2rem)] p-0">
                <NavPanel>
                  <NavPanelHeading>Was wir für Sie tun</NavPanelHeading>
                  <NavPanelGrid>
                    {services.map((service) => (
                      <NavPanelItem
                        key={service.slug}
                        href={`/leistungen/${service.slug}`}
                        label={service.name}
                        description={service.shortDesc}
                        icon={<ServiceIcon name={service.icon} />}
                      />
                    ))}
                  </NavPanelGrid>
                </NavPanel>

                <NavPanelFooter>
                  {/*
                    Hervorgehoben ist der Preisrechner, nicht die Übersicht:
                    „was kostet das" ist die Frage, mit der die meisten
                    hierherkommen.
                  */}
                  <NavPanelAction href="/preise" emphasis>
                    Preis in 60 Sekunden berechnen
                  </NavPanelAction>
                  <NavPanelAction href="/offerte">Individuelle Offerte anfordern</NavPanelAction>
                </NavPanelFooter>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Preise, Einsatzgebiet */}
            {DIRECT_LINKS.map((link) => {
              const active = pathname === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? 'page' : undefined}
                  className={topLevel(active)}
                >
                  {link.label}
                </Link>
              );
            })}

            {/* Einblick */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className={topLevel(insightActive)} aria-current={insightActive ? 'true' : undefined}>
                  Einblick
                  <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-[36rem] max-w-[calc(100vw-2rem)] p-0">
                <NavPanel>
                  <NavPanelHeading>Wer wir sind, wie wir arbeiten</NavPanelHeading>
                  <NavPanelGrid>
                    {INSIGHT_LINKS.map(({ href, label, description, Icon }) => (
                      <NavPanelItem
                        key={href}
                        href={href}
                        label={label}
                        description={description}
                        icon={<Icon />}
                      />
                    ))}
                  </NavPanelGrid>
                </NavPanel>

                <NavPanelFooter>
                  <NavPanelAction href="/kontakt">
                    Frage offen? Wir antworten innert 24 Stunden
                  </NavPanelAction>
                </NavPanelFooter>
              </DropdownMenuContent>
            </DropdownMenu>

            <Link
              href="/kontakt"
              aria-current={pathname === '/kontakt' ? 'page' : undefined}
              className={topLevel(pathname === '/kontakt')}
            >
              Kontakt
            </Link>
          </nav>
        </div>

        <div className="flex items-center gap-1.5">
          {/*
            Anrufen und Buchen sind die beiden Handlungen, wegen derer jemand
            hier ist — sie bleiben auf jedem Bildschirm sichtbar und wandern
            nicht ins Hamburger-Menü. Ab 1280 px steht die Nummer
            ausgeschrieben, darunter genügt der Hörer; das spart rund 130 px.
          */}
          <Button asChild variant="ghost" size="icon" className="xl:hidden">
            <a href={`tel:${phone.replace(/\s/g, '')}`} aria-label={`Anrufen: ${phone}`}>
              <Phone aria-hidden />
            </a>
          </Button>
          <a
            href={`tel:${phone.replace(/\s/g, '')}`}
            className="hidden items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium tabular-nums text-foreground transition-colors hover:bg-muted xl:inline-flex"
          >
            <Phone className="size-4 text-primary" aria-hidden />
            {phone}
          </a>

          {/*
            Die Schaltflächen der Kopfzeile kommen aus der Verwaltung. Höchstens
            zwei — mehr drängen auf einem Telefon Hörer und Menü aus der Zeile.

            Reihenfolge: erst die Handlung, wegen der jemand hier ist („Termin
            buchen"), dann Anmelden, ganz rechts das Farbschema. Das Wichtigste
            steht damit direkt neben dem Buchungsknopf, die Einstellung am Rand.
          */}
          <CtaSlot ctas={ctas} size="sm" max={2} className="gap-1.5" />

          <AccountButton className="hidden sm:inline-flex" />
          <ThemeToggle className="hidden md:inline-flex" />

          {/* Mobil */}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Menü öffnen">
                <Menu aria-hidden />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-[min(24rem,92vw)]">
              <SheetHeader>
                <SheetTitle>Menü</SheetTitle>
              </SheetHeader>
              <SheetBody className="py-4">
                {/*
                  Buchen und Anrufen stehen im mobilen Menü *oben*, nicht unten:
                  wer das Menü auf dem Telefon öffnet, will meistens genau das.
                */}
                <div className="space-y-2.5 pb-5">
                  {mobileButtons.map((cta) => (
                    <CtaButton key={cta.id} cta={cta} size="lg" fullWidth />
                  ))}
                  <Button asChild width="full" size="lg" variant="outline">
                    <a href={`tel:${phone.replace(/\s/g, '')}`}>
                      <Phone aria-hidden />
                      {phone}
                    </a>
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">
                    Werktags 07–18 Uhr · Antwort innert 24 Stunden
                  </p>
                </div>

                <nav className="space-y-1 border-t border-border pt-4" aria-label="Mobile Navigation">
                  <MobileGroup label="Leistungen" />
                  {services.map((service) => (
                    <MobileLink
                      key={service.slug}
                      href={`/leistungen/${service.slug}`}
                      label={service.name}
                      pathname={pathname}
                      icon={<ServiceIcon name={service.icon} />}
                    />
                  ))}
                  <MobileLink href="/leistungen" label="Alle Leistungen" pathname={pathname} />

                  <MobileGroup label="Buchen und Preise" />
                  {DIRECT_LINKS.map((link) => (
                    <MobileLink key={link.href} href={link.href} label={link.label} pathname={pathname} />
                  ))}
                  <MobileLink href="/offerte" label="Offerte anfordern" pathname={pathname} />

                  <MobileGroup label="Einblick" />
                  {INSIGHT_LINKS.map(({ href, label, Icon }) => (
                    <MobileLink
                      key={href}
                      href={href}
                      label={label}
                      pathname={pathname}
                      icon={<Icon />}
                    />
                  ))}

                  <MobileGroup label="Kontakt und Konto" />
                  <MobileLink href="/kontakt" label="Kontakt" pathname={pathname} />
                  {ACCOUNT_LINKS.map((link) => (
                    <MobileLink key={link.href} href={link.href} label={link.label} pathname={pathname} />
                  ))}
                </nav>

                {/*
                  Im Schubfach ist Platz — deshalb steht hier die Beschriftung
                  neben dem Symbol. In der Kopfzeile trägt das Symbol allein.
                */}
                <div className="mt-6 flex items-center justify-between gap-3 border-t border-border pt-5">
                  <span className="text-sm font-medium text-muted-foreground">Farbschema</span>
                  <ThemeToggle />
                </div>
              </SheetBody>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}

function MobileGroup({ label }: { label: string }) {
  return (
    <p className="px-3 pb-1 pt-4 text-xs font-medium text-muted-foreground first:pt-0">{label}</p>
  );
}

function MobileLink({
  href,
  label,
  pathname,
  icon,
}: {
  href: string;
  label: string;
  pathname: string;
  icon?: React.ReactNode;
}) {
  const active = pathname === href;
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors hover:bg-muted',
        active && 'bg-primary/8 text-primary',
      )}
    >
      {/* Markierung links statt nur Farbe — dieselbe Regel wie in der App. */}
      <span
        className={cn('h-5 w-0.5 shrink-0 rounded-full', active ? 'bg-primary' : 'bg-transparent')}
        aria-hidden
      />
      {icon ? (
        <span
          className="flex size-5 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-[1.125rem]"
          aria-hidden
        >
          {icon}
        </span>
      ) : (
        <span className="size-5 shrink-0" aria-hidden />
      )}
      {label}
    </Link>
  );
}
