import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * Wortmarke.
 *
 * Das Zeichen ist eine stilisierte Welle — die Aare, die durch Bern fliesst,
 * und zugleich die Bewegung eines Wischzugs. Zwei Bedeutungen, eine Form.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn('size-8', className)}
      fill="none"
      aria-hidden
    >
      <rect width="32" height="32" rx="9" fill="hsl(var(--primary))" />
      <path
        d="M6.5 20.5c2.6-3.4 5.2-3.4 7.8 0s5.2 3.4 7.8 0"
        stroke="hsl(var(--primary-foreground))"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M9 13.5c2-2.6 4-2.6 6 0"
        stroke="hsl(var(--primary-foreground))"
        strokeWidth="2.4"
        strokeLinecap="round"
        opacity="0.55"
      />
    </svg>
  );
}

export function Logo({
  className,
  href = '/',
  showWordmark = true,
}: {
  className?: string;
  href?: string;
  showWordmark?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'inline-flex items-center gap-2.5 rounded-lg transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background',
        className,
      )}
      aria-label="Clenaris — zur Startseite"
    >
      <LogoMark />
      {/* Der Schriftgrad der Wortmarke liegt bewusst ausserhalb der Skala: er
          wird auf die Bildmarke daneben optisch abgestimmt, nicht auf den
          Lesetext. */}
      {showWordmark ? (
        <span className="font-display text-[1.35rem] font-bold leading-none tracking-[-0.04em] text-foreground">
          Clenaris
        </span>
      ) : null}
    </Link>
  );
}
