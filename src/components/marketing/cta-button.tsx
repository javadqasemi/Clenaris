'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as Icons from 'lucide-react';

import { cn } from '@/lib/utils';
import { isVisible } from '@/lib/cta/match';
import { Button } from '@/components/ui/button';

/**
 * Handlungsaufrufe aus der Datenbank darstellen.
 *
 * Entscheide:
 *
 *  • **Das Symbol wird über eine Positivliste aufgelöst, nicht über den
 *    ganzen Lucide-Namensraum.** `Icons[name]` mit einem Wert aus der
 *    Datenbank würde jeden Export der Bibliothek erreichbar machen —
 *    einschliesslich `createLucideIcon` und interner Helfer, die als React-
 *    Komponente gerendert einen Laufzeitfehler auf der Startseite ergäben.
 *    Die Liste enthält, was auf einer Schaltfläche eines Reinigungsbetriebs
 *    sinnvoll ist.
 *
 *  • **`rel="noopener noreferrer"` bei jedem neuen Tab.** Ohne `noopener`
 *    erhält die Zielseite über `window.opener` Zugriff auf die aufrufende
 *    Seite. Bei einer Adresse, die eine Person eintippt, ist das kein
 *    theoretisches Risiko.
 *
 *  • **Eigene Farben landen in `style`, nicht in einer Klasse.** Tailwind
 *    erzeugt seine Klassen zur Bauzeit; eine Farbe aus der Datenbank kann es
 *    nicht kennen. `style` ist hier die ehrliche Lösung — der Wert ist als
 *    Hexwert validiert und kann nichts anderes einschleusen.
 */

/** Symbole, die auf einer Schaltfläche vorkommen. */
const ICON_MAP = {
  Phone: Icons.Phone,
  PhoneCall: Icons.PhoneCall,
  MessageCircle: Icons.MessageCircle,
  MessageSquare: Icons.MessageSquare,
  Mail: Icons.Mail,
  Calendar: Icons.Calendar,
  CalendarCheck: Icons.CalendarCheck,
  CalendarPlus: Icons.CalendarPlus,
  FileText: Icons.FileText,
  Calculator: Icons.Calculator,
  Sparkles: Icons.Sparkles,
  ArrowRight: Icons.ArrowRight,
  Send: Icons.Send,
  MapPin: Icons.MapPin,
  Clock: Icons.Clock,
  CheckCircle2: Icons.CheckCircle2,
  Star: Icons.Star,
  ThumbsUp: Icons.ThumbsUp,
  Users: Icons.Users,
  Truck: Icons.Truck,
  Home: Icons.Home,
  Building2: Icons.Building2,
} as const;

export type CtaIconName = keyof typeof ICON_MAP;

export const CTA_ICON_NAMES = Object.keys(ICON_MAP) as CtaIconName[];

export interface CtaData {
  id: string;
  key: string;
  label: string;
  href: string;
  newTab: boolean;
  icon: string | null;
  slot: string;
  style: string;
  bgColor: string | null;
  fgColor: string | null;
  /** Nur für die Auswahl im Browser nötig — auf dem Server bereits gefiltert. */
  pages?: string[];
  publishFrom?: string | null;
  publishUntil?: string | null;
}

const STYLE_TO_VARIANT: Record<string, 'default' | 'secondary' | 'outline' | 'ghost' | 'accent' | 'success'> = {
  PRIMARY: 'default',
  SECONDARY: 'secondary',
  OUTLINE: 'outline',
  GHOST: 'ghost',
  ACCENT: 'accent',
  SUCCESS: 'success',
  CUSTOM: 'default',
};

export function CtaIcon({ name, className }: { name: string | null; className?: string }) {
  if (!name) return null;
  const Icon = ICON_MAP[name as CtaIconName];
  if (!Icon) return null;
  return <Icon className={className} aria-hidden />;
}

/**
 * Eine einzelne Schaltfläche.
 *
 * `tel:` und `mailto:` bekommen ein `<a>`, alles andere ein `<Link>`: der
 * Router von Next.js soll ein Wählprotokoll nicht abfangen.
 */
export function CtaButton({
  cta,
  size = 'default',
  className,
  fullWidth,
}: {
  cta: CtaData;
  size?: 'sm' | 'default' | 'lg';
  className?: string;
  fullWidth?: boolean;
}) {
  const custom =
    cta.style === 'CUSTOM' && cta.bgColor && cta.fgColor
      ? { backgroundColor: cta.bgColor, color: cta.fgColor, borderColor: cta.bgColor }
      : undefined;

  const external = /^(https?|tel|mailto):/i.test(cta.href);
  const opensTab = cta.newTab && /^https?:/i.test(cta.href);

  const content = (
    <>
      <CtaIcon name={cta.icon} />
      {cta.label}
    </>
  );

  return (
    <Button
      asChild
      variant={STYLE_TO_VARIANT[cta.style] ?? 'default'}
      size={size}
      width={fullWidth ? 'full' : 'auto'}
      className={cn(custom && 'hover:brightness-95', className)}
      style={custom}
    >
      {external ? (
        <a
          href={cta.href}
          {...(opensTab ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          data-cta={cta.key}
        >
          {content}
          {opensTab ? <span className="sr-only">(öffnet in neuem Tab)</span> : null}
        </a>
      ) : (
        <Link href={cta.href} data-cta={cta.key}>
          {content}
        </Link>
      )}
    </Button>
  );
}

/**
 * Alle Aufrufe eines Platzes, im Browser nach dem aktuellen Pfad gefiltert.
 *
 * Für Kopf- und Fusszeile: die liegen im Layout und kennen den Pfad nicht.
 * Das Layout reicht deshalb *alle* Aufrufe des Platzes herein — eine Handvoll
 * Zeilen — und hier fällt die Auswahl. Die Regel selbst kommt aus
 * `lib/cta/match`, damit sie mit der Serverseite nicht auseinanderläuft.
 */
export function CtaSlot({
  ctas,
  size = 'default',
  className,
  itemClassName,
  max,
}: {
  ctas: CtaData[];
  size?: 'sm' | 'default' | 'lg';
  className?: string;
  itemClassName?: string;
  /** Höchstzahl sichtbarer Schaltflächen — schützt das Layout. */
  max?: number;
}) {
  const pathname = usePathname();

  const visible = React.useMemo(() => {
    const now = new Date();
    const matching = ctas.filter((cta) =>
      isVisible(
        {
          pages: cta.pages ?? [],
          publishFrom: cta.publishFrom ?? null,
          publishUntil: cta.publishUntil ?? null,
        },
        pathname,
        now,
      ),
    );
    return max ? matching.slice(0, max) : matching;
  }, [ctas, pathname, max]);

  if (visible.length === 0) return null;

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {visible.map((cta) => (
        <CtaButton key={cta.id} cta={cta} size={size} className={itemClassName} />
      ))}
    </div>
  );
}
