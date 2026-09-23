import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors [&_svg]:size-3',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary/10 text-primary-700 dark:text-primary-700',
        neutral: 'border-border bg-muted text-muted-foreground',
        outline: 'border-border text-foreground',
        success: 'border-transparent bg-success/12 text-success',
        warning: 'border-transparent bg-warning/14 text-warning',
        destructive: 'border-transparent bg-destructive/12 text-destructive',
        info: 'border-transparent bg-info/12 text-info',
        accent: 'border-transparent bg-accent/15 text-accent',
        solid: 'border-transparent bg-primary text-primary-foreground',
      },
      size: {
        sm: 'px-2 py-px text-2xs',
        default: '',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}

/**
 * Statusanzeige mit Farbcodierung.
 * Die Zuordnung Status → Farbe liegt zentral, damit Listen, Detailseiten und
 * Kalender dieselbe Sprache sprechen.
 */
const STATUS_MAP: Record<string, { label: string; variant: BadgeProps['variant'] }> = {
  // Buchungen
  DRAFT: { label: 'Entwurf', variant: 'neutral' },
  PENDING: { label: 'Zu bestätigen', variant: 'warning' },
  CONFIRMED: { label: 'Bestätigt', variant: 'default' },
  IN_PROGRESS: { label: 'In Arbeit', variant: 'info' },
  COMPLETED: { label: 'Abgeschlossen', variant: 'success' },
  CANCELLED: { label: 'Storniert', variant: 'destructive' },
  NO_SHOW: { label: 'Nicht erschienen', variant: 'destructive' },

  // Einsätze
  UNASSIGNED: { label: 'Nicht zugeteilt', variant: 'warning' },
  SCHEDULED: { label: 'Geplant', variant: 'default' },
  DISPATCHED: { label: 'Disponiert', variant: 'info' },
  EN_ROUTE: { label: 'Unterwegs', variant: 'info' },
  ON_HOLD: { label: 'Pausiert', variant: 'warning' },
  VERIFIED: { label: 'Kontrolliert', variant: 'success' },

  // Offerten
  SENT: { label: 'Versendet', variant: 'info' },
  VIEWED: { label: 'Angesehen', variant: 'info' },
  ACCEPTED: { label: 'Angenommen', variant: 'success' },
  REJECTED: { label: 'Abgelehnt', variant: 'destructive' },
  EXPIRED: { label: 'Abgelaufen', variant: 'neutral' },
  CONVERTED: { label: 'Umgewandelt', variant: 'success' },

  // Rechnungen
  ISSUED: { label: 'Ausgestellt', variant: 'default' },
  PARTIALLY_PAID: { label: 'Teilbezahlt', variant: 'warning' },
  PAID: { label: 'Bezahlt', variant: 'success' },
  OVERDUE: { label: 'Überfällig', variant: 'destructive' },
  WRITTEN_OFF: { label: 'Abgeschrieben', variant: 'neutral' },

  // Leads
  NEW: { label: 'Neu', variant: 'default' },
  CONTACTED: { label: 'Kontaktiert', variant: 'info' },
  QUALIFIED: { label: 'Qualifiziert', variant: 'default' },
  PROPOSAL: { label: 'Offerte', variant: 'accent' },
  WON: { label: 'Gewonnen', variant: 'success' },
  LOST: { label: 'Verloren', variant: 'destructive' },

  // Abwesenheiten & Aufgaben
  REQUESTED: { label: 'Beantragt', variant: 'warning' },
  APPROVED: { label: 'Bewilligt', variant: 'success' },
  OPEN: { label: 'Offen', variant: 'neutral' },
  DONE: { label: 'Erledigt', variant: 'success' },

  // Zahlungen
  PROCESSING: { label: 'In Bearbeitung', variant: 'info' },
  SUCCEEDED: { label: 'Erfolgreich', variant: 'success' },
  FAILED: { label: 'Fehlgeschlagen', variant: 'destructive' },
  REFUNDED: { label: 'Rückerstattet', variant: 'neutral' },

  /*
    Verträge (Wave 10).

    `DRAFT`, `ACTIVE`, `CANCELLED` und `APPROVED` stehen schon oben und gelten
    hier mit — das ist der Sinn einer gemeinsamen Tabelle: „Entwurf" heisst
    überall dasselbe und sieht überall gleich aus. Neu sind nur die
    Zustände, die es bisher nirgends gab.
  */
  IN_REVIEW: { label: 'In Prüfung', variant: 'info' },
  OFFERED: { label: 'Offeriert', variant: 'accent' },
  ACTIVE: { label: 'Aktiv', variant: 'success' },
  PAUSED: { label: 'Pausiert', variant: 'warning' },
  /* Warnend, nicht zerstörend: Der Vertrag läuft bis zum Wirkungsdatum weiter. */
  NOTICE_GIVEN: { label: 'Gekündigt', variant: 'warning' },
  ENDED: { label: 'Beendet', variant: 'neutral' },
  SUPERSEDED: { label: 'Abgelöst', variant: 'neutral' },
  DISCARDED: { label: 'Verworfen', variant: 'neutral' },
  EFFECTIVE: { label: 'Wirksam', variant: 'success' },
  PLANNED: { label: 'Geplant', variant: 'neutral' },
  APPLIED: { label: 'Angewandt', variant: 'success' },
  REVIEW: { label: 'In Prüfung', variant: 'info' },

  /*
    Qualitätskontrolle (Wave 11).

    `KNAPP` ist warnend und nicht zerstörend: Der Zielwert ist verfehlt, aber
    innerhalb der Toleranz — das ist ein Hinweis, keine Massnahme. Die
    Unterscheidung wäre wertlos, wenn beides gleich aussähe.

    `OHNE_ZIEL` ist bewusst neutral und heisst „gemessen, nicht beurteilt".
    Eine grüne Färbung suggerierte ein Bestehen, das niemand zugesagt hat.
  */
  BESTANDEN: { label: 'Bestanden', variant: 'success' },
  KNAPP: { label: 'Knapp verfehlt', variant: 'warning' },
  NICHT_BESTANDEN: { label: 'Nicht bestanden', variant: 'destructive' },
  OHNE_ZIEL: { label: 'Ohne Zielwert', variant: 'neutral' },
};

export function StatusBadge({
  status,
  className,
  size,
}: {
  status: string;
  className?: string;
  size?: BadgeProps['size'];
}) {
  const config = STATUS_MAP[status] ?? { label: status, variant: 'neutral' as const };
  return (
    <Badge variant={config.variant} size={size} className={className}>
      {config.label}
    </Badge>
  );
}

export function statusLabel(status: string): string {
  return STATUS_MAP[status]?.label ?? status;
}

export { Badge, badgeVariants, STATUS_MAP };
