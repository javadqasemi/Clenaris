import Link from 'next/link';
import { ArrowLeft, ShieldCheck } from 'lucide-react';

import { prisma } from '@/lib/db';
import { getOrganizationId } from '@/server/services/organization.service';
import { Logo } from '@/components/marketing/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { Stars } from '@/components/marketing/sections';

/**
 * Rahmen der Anmeldeseiten.
 *
 * Zweispaltig: links die Aufgabe, rechts der Grund, ihr zu vertrauen. Die
 * rechte Spalte zeigt eine echte Bewertung aus der Datenbank statt einer
 * dekorativen Grafik — dieselbe Information, die auch auf der Website steht.
 */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const organizationId = await getOrganizationId();

  const [review, ratingAgg] = await Promise.all([
    prisma.review.findFirst({
      where: { organizationId, status: 'PUBLISHED', featured: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.review.aggregate({
      where: { organizationId, status: 'PUBLISHED' },
      _avg: { rating: true },
      _count: true,
    }),
  ]);

  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      {/* Formularspalte */}
      <div className="flex flex-col">
        <header className="flex items-center justify-between p-6 sm:p-8">
          <Logo />
          <ThemeToggle />
        </header>

        <main id="inhalt" className="flex flex-1 items-center justify-center px-6 pb-16 sm:px-8">
          <div className="w-full max-w-sm">{children}</div>
        </main>

        <footer className="p-6 sm:p-8">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" aria-hidden />
            Zurück zur Website
          </Link>
        </footer>
      </div>

      {/* Vertrauensspalte */}
      <aside className="relative hidden overflow-hidden border-l border-border bg-surface lg:flex lg:flex-col lg:justify-between">
        <div className="aare-wash pointer-events-none absolute inset-0" aria-hidden />
        <div className="grid-backdrop pointer-events-none absolute inset-0" aria-hidden />

        <div className="relative flex-1" />

        <div className="relative space-y-10 p-12 xl:p-16">
          {review ? (
            <figure className="space-y-5">
              <Stars rating={review.rating} />
              <blockquote className="font-display text-2xl font-semibold leading-snug tracking-tight text-balance">
                „{review.title ?? review.body.slice(0, 90)}“
              </blockquote>
              <p className="prose-measure text-body leading-relaxed text-muted-foreground">
                {review.body}
              </p>
              <figcaption className="text-sm font-medium">{review.authorName}</figcaption>
            </figure>
          ) : null}

          <div className="flex flex-wrap items-center gap-x-8 gap-y-3 border-t border-border pt-8 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <ShieldCheck className="size-4 text-primary" aria-hidden />
              Daten in der Schweiz und der EU gespeichert
            </span>
            {ratingAgg._count > 0 ? (
              <span className="tabular-nums">
                {(ratingAgg._avg.rating ?? 5).toFixed(1)} / 5 aus {ratingAgg._count} Bewertungen
              </span>
            ) : null}
          </div>
        </div>
      </aside>
    </div>
  );
}
