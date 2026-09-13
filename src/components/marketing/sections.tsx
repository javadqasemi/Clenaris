import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, Star } from 'lucide-react';

import { cn, formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { CtaButton, type CtaData } from '@/components/marketing/cta-button';

/**
 * Wiederkehrende Abschnitte der Website.
 *
 * Gestaltungsregel: Karten nur dort, wo der Inhalt ein Objekt ist. Listen und
 * Aufzählungen laufen als Protokollzeilen — Haarlinie, schmale Beschriftungs-
 * spalte, Wert. Dieses Muster zieht sich von der Website bis in die
 * Rechnungsansicht durch.
 */

export function Section({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={cn('py-20 sm:py-24', className)} {...props}>
      {children}
    </section>
  );
}

/**
 * Beschriftungen sind durchwegs `ReactNode` und nicht `string`.
 *
 * Grund ist die Redaktionsvorschau: Dort kommt jeder gepflegte Text in einer
 * anklickbaren Hülle daher (`cms.text()`), damit man in der Vorschau auf den
 * Text zeigen kann, den man ändern will. Ein `string`-Typ zwänge die Seiten,
 * stattdessen den Rohtext zu setzen — und die Hülle wäre genau dort weg, wo sie
 * gebraucht wird. Für alle bisherigen Aufrufe ändert sich nichts: Eine
 * Zeichenkette *ist* ein `ReactNode`.
 */
export function SectionIntro({
  title,
  lead,
  action,
  align = 'left',
  className,
}: {
  title: React.ReactNode;
  lead?: React.ReactNode;
  action?: { href: string; label: React.ReactNode };
  align?: 'left' | 'center';
  className?: string;
}) {
  return (
    <div
      className={cn(
        'mb-12 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between',
        align === 'center' && 'sm:flex-col sm:items-center sm:text-center',
        className,
      )}
    >
      <div className={cn('space-y-3', align === 'center' && 'max-w-2xl')}>
        <h2 className="text-headline font-bold text-balance text-foreground">{title}</h2>
        {lead ? (
          <p className={cn('text-lg leading-relaxed text-muted-foreground', align === 'left' && 'prose-measure')}>
            {lead}
          </p>
        ) : null}
      </div>

      {action ? (
        <Button asChild variant="outline" className="shrink-0">
          <Link href={action.href}>
            {action.label}
            <ArrowRight aria-hidden />
          </Link>
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Leistungszeile.
 *
 * Bewusst als Zeile statt als Kachel: die sechs Leistungen unterscheiden sich
 * in Preis und Aufwand deutlich, und eine Zeile kann Name, Nutzen und Preis
 * nebeneinander zeigen, ohne dass alle Einträge gleich aussehen müssen.
 */
export function ServiceRow({
  slug,
  name,
  shortDesc,
  priceFrom,
  priceUnit,
  index,
}: {
  slug: string;
  name: string;
  shortDesc: string;
  priceFrom: number | null;
  priceUnit: string;
  index: number;
}) {
  return (
    <Link
      href={`/leistungen/${slug}`}
      className="group grid items-baseline gap-x-8 gap-y-2 border-t border-border py-7 transition-colors hover:bg-muted/40 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-4 sm:-mx-4"
    >
      <div className="space-y-1.5">
        <h3 className="font-display text-title font-semibold tracking-tight text-foreground transition-colors group-hover:text-primary">
          {name}
        </h3>
        <p className="prose-measure text-body leading-relaxed text-muted-foreground">
          {shortDesc}
        </p>
      </div>

      <div className="flex items-center gap-4 sm:flex-col sm:items-end sm:gap-1">
        {priceFrom ? (
          <p className="whitespace-nowrap text-lg font-semibold tabular-nums text-foreground">
            ab {formatCurrency(priceFrom)}
            <span className="ml-1 text-sm font-normal text-muted-foreground">{priceUnit}</span>
          </p>
        ) : (
          <p className="whitespace-nowrap text-lg font-semibold text-foreground">Auf Anfrage</p>
        )}
        <span className="inline-flex items-center gap-1 text-sm font-medium text-primary">
          Details
          <ArrowRight
            className="size-4 transition-transform duration-200 ease-spring group-hover:translate-x-0.5"
            aria-hidden
          />
        </span>
      </div>

      <span className="sr-only">Position {index + 1}</span>
    </Link>
  );
}

/** Kennzahlenleiste — vier harte Zahlen, keine Marketingfloskeln. */
export function StatStrip({
  stats,
  className,
}: {
  stats: { value: React.ReactNode; label: React.ReactNode }[];
  className?: string;
}) {
  return (
    <dl
      className={cn(
        'grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4',
        className,
      )}
    >
      {/*
        Die Position ist hier der richtige Schlüssel: Die Leiste ist eine feste
        Folge von vier Kennzahlen, die weder umsortiert noch gefiltert wird.
        Vorher stand die Beschriftung als Schlüssel — die ist nun redaktionell
        änderbar und taugt nicht mehr als Identität.
      */}
      {stats.map((stat, index) => (
        <div key={index} className="bg-card px-6 py-7">
          <dt className="text-sm text-muted-foreground">{stat.label}</dt>
          <dd className="mt-1.5 font-display text-3xl font-bold tabular-nums tracking-tight text-foreground">
            {stat.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Stars({ rating, className }: { rating: number; className?: string }) {
  return (
    <div className={cn('flex items-center gap-0.5', className)} aria-label={`${rating} von 5 Sternen`}>
      {Array.from({ length: 5 }).map((_, index) => (
        <Star
          key={index}
          className={cn(
            'size-4',
            index < Math.round(rating) ? 'fill-accent text-accent' : 'text-border',
          )}
          aria-hidden
        />
      ))}
    </div>
  );
}

export function ReviewCard({
  authorName,
  rating,
  title,
  body,
  serviceLabel,
}: {
  authorName: string;
  rating: number;
  title?: string | null;
  body: string;
  serviceLabel?: string | null;
}) {
  return (
    <figure className="flex h-full flex-col gap-4 rounded-2xl border border-border bg-card p-6 shadow-soft">
      <Stars rating={rating} />
      <blockquote className="flex-1 space-y-2">
        {title ? <p className="font-display font-semibold text-foreground">{title}</p> : null}
        <p className="text-body leading-relaxed text-muted-foreground">{body}</p>
      </blockquote>
      <figcaption className="flex items-baseline justify-between gap-3 border-t border-border pt-4 text-sm">
        <span className="font-medium text-foreground">{authorName}</span>
        {serviceLabel ? <span className="text-muted-foreground">{serviceLabel}</span> : null}
      </figcaption>
    </figure>
  );
}

/** Ablaufdarstellung — hier sind Nummern richtig, weil es wirklich eine Folge ist. */
export function ProcessSteps({
  steps,
}: {
  steps: { title: React.ReactNode; description: React.ReactNode }[];
}) {
  return (
    <ol className="grid gap-px overflow-hidden rounded-2xl border border-border bg-border md:grid-cols-2 lg:grid-cols-4">
      {steps.map((step, index) => (
        <li key={index} className="relative bg-card p-7">
          <span className="font-display text-4xl font-bold tabular-nums leading-none text-primary/25">
            {index + 1}
          </span>
          <h3 className="mt-4 font-display text-lg font-semibold tracking-tight">{step.title}</h3>
          <p className="mt-2 text-body leading-relaxed text-muted-foreground">
            {step.description}
          </p>
        </li>
      ))}
    </ol>
  );
}

export function CallToAction({
  title,
  lead,
  primary,
  secondary,
  ctas,
}: {
  title: React.ReactNode;
  lead: React.ReactNode;
  primary: { href: string; label: string };
  secondary?: { href: string; label: string };
  /**
   * Verwaltete Handlungsaufrufe für diesen Platz.
   *
   * Sind welche gepflegt, ersetzen sie `primary` und `secondary` vollständig.
   * Die beiden bleiben als Rückfall bestehen — ohne sie stünde das Band ohne
   * Schaltfläche da, sobald jemand den letzten Aufruf abschaltet. Eine Seite,
   * die zu nichts auffordert, ist schlimmer als eine mit der
   * Auslieferungsfassung.
   */
  ctas?: CtaData[];
}) {
  const managed = ctas && ctas.length > 0;

  return (
    <div className="relative overflow-hidden rounded-3xl border border-border bg-card px-8 py-14 text-center shadow-card sm:px-14">
      <div className="aare-wash pointer-events-none absolute inset-0" aria-hidden />
      <div className="relative mx-auto max-w-2xl space-y-5">
        <h2 className="text-headline font-bold text-balance">{title}</h2>
        <p className="text-lg leading-relaxed text-muted-foreground text-pretty">{lead}</p>
        <div className="flex flex-col justify-center gap-3 pt-3 sm:flex-row">
          {managed ? (
            ctas.map((cta) => <CtaButton key={cta.id} cta={cta} size="lg" />)
          ) : (
            <>
              <Button asChild size="lg">
                <Link href={primary.href}>{primary.label}</Link>
              </Button>
              {secondary ? (
                <Button asChild size="lg" variant="outline">
                  <Link href={secondary.href}>{secondary.label}</Link>
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Vertrauensmerkmale — vier Zusagen, die wir tatsächlich einhalten können. */
export function TrustRow({
  items,
}: {
  items: { icon: React.ReactNode; title: React.ReactNode; description: React.ReactNode }[];
}) {
  return (
    <ul className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((item, index) => (
        <li key={index} className="flex gap-4">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary [&_svg]:size-5">
            {item.icon}
          </span>
          <div className="space-y-1">
            <h3 className="font-medium leading-snug text-foreground">{item.title}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">{item.description}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
