'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Vorher-/Nachher-Vergleich.
 *
 * Das Herzstück der Startseite. Reinigung ist ein Geschäft, in dem das
 * Ergebnis zählt und nicht die Beschreibung — also zeigen wir es, und zwar so,
 * dass die Besucherin es selbst aufdeckt. Die Bewegung antwortet auf ihre
 * Handlung; es gibt keine Animation, die von allein läuft.
 *
 * Bedienbar mit Maus, Finger und Tastatur (Pfeiltasten, Pos1/Ende).
 * Ohne Bilder wird eine gezeichnete Ersatzdarstellung gerendert, damit die
 * Seite auch vor dem ersten Foto-Upload vollständig aussieht.
 */

export interface BeforeAfterProps {
  beforeSrc?: string | null;
  afterSrc?: string | null;
  beforeLabel?: string;
  afterLabel?: string;
  caption?: string;
  className?: string;
  /** Startposition des Reglers in Prozent. */
  initial?: number;
}

export function BeforeAfter({
  beforeSrc,
  afterSrc,
  beforeLabel = 'Vorher',
  afterLabel = 'Nachher',
  caption,
  className,
  initial = 52,
}: BeforeAfterProps) {
  const [position, setPosition] = React.useState(initial);
  const [dragging, setDragging] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const updateFromClientX = React.useCallback((clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const next = ((clientX - rect.left) / rect.width) * 100;
    setPosition(Math.min(100, Math.max(0, next)));
  }, []);

  React.useEffect(() => {
    if (!dragging) return;

    const onMove = (event: MouseEvent | TouchEvent) => {
      const clientX =
        'touches' in event ? event.touches[0]?.clientX : (event as MouseEvent).clientX;
      if (typeof clientX === 'number') updateFromClientX(clientX);
    };
    const onUp = () => setDragging(false);

    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp);

    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchend', onUp);
    };
  }, [dragging, updateFromClientX]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 10 : 3;
    if (event.key === 'ArrowLeft') {
      setPosition((p) => Math.max(0, p - step));
      event.preventDefault();
    } else if (event.key === 'ArrowRight') {
      setPosition((p) => Math.min(100, p + step));
      event.preventDefault();
    } else if (event.key === 'Home') {
      setPosition(0);
      event.preventDefault();
    } else if (event.key === 'End') {
      setPosition(100);
      event.preventDefault();
    }
  };

  return (
    <figure className={cn('space-y-3', className)}>
      <div
        ref={containerRef}
        className="relative aspect-[4/3] w-full select-none overflow-hidden rounded-3xl border border-border bg-muted shadow-elevated sm:aspect-[16/10]"
        onMouseDown={(event) => {
          setDragging(true);
          updateFromClientX(event.clientX);
        }}
        onTouchStart={(event) => {
          setDragging(true);
          const touch = event.touches[0];
          if (touch) updateFromClientX(touch.clientX);
        }}
      >
        {/* Nachher — liegt unten, wird vom Vorher-Bild überlagert */}
        <div className="absolute inset-0">
          {afterSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={afterSrc}
              alt={afterLabel}
              className="size-full object-cover"
              draggable={false}
            />
          ) : (
            <PlaceholderPane variant="after" />
          )}
        </div>

        {/* Vorher — per clip-path beschnitten */}
        <div
          className="absolute inset-0"
          style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
        >
          {beforeSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={beforeSrc}
              alt={beforeLabel}
              className="size-full object-cover"
              draggable={false}
            />
          ) : (
            <PlaceholderPane variant="before" />
          )}
        </div>

        {/* Beschriftungen */}
        <span className="pointer-events-none absolute left-4 top-4 rounded-full bg-foreground/80 px-3 py-1 text-xs font-medium text-background backdrop-blur-sm">
          {beforeLabel}
        </span>
        <span className="pointer-events-none absolute right-4 top-4 rounded-full bg-primary/90 px-3 py-1 text-xs font-medium text-primary-foreground backdrop-blur-sm">
          {afterLabel}
        </span>

        {/* Griff */}
        <div
          className="absolute inset-y-0 z-10 w-px bg-background/90 shadow-[0_0_0_1px_rgba(0,0,0,0.08)]"
          style={{ left: `${position}%` }}
        >
          <button
            type="button"
            role="slider"
            aria-label="Vergleich verschieben"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(position)}
            aria-valuetext={`${Math.round(position)} % ${beforeLabel}`}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onMouseDown={(event) => {
              event.stopPropagation();
              setDragging(true);
            }}
            onTouchStart={(event) => {
              event.stopPropagation();
              setDragging(true);
            }}
            className={cn(
              'absolute left-1/2 top-1/2 flex size-11 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center',
              'rounded-full border-2 border-background bg-primary text-primary-foreground shadow-elevated',
              'transition-transform duration-200 ease-spring hover:scale-105',
              'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/35',
              dragging && 'scale-105',
            )}
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden>
              <path
                d="M9 6 4 12l5 6M15 6l5 6-5 6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>

      {caption ? (
        <figcaption className="text-sm text-muted-foreground">{caption}</figcaption>
      ) : null}
    </figure>
  );
}

/**
 * Ersatzdarstellung ohne Foto: eine gezeichnete Küchenzeile, links verschmutzt,
 * rechts gereinigt. Kein Platzhalter-Grau, sondern eine Illustration, die
 * dieselbe Aussage trägt wie das spätere Foto.
 */
function PlaceholderPane({ variant }: { variant: 'before' | 'after' }) {
  const before = variant === 'before';

  return (
    <svg
      viewBox="0 0 800 500"
      className="size-full"
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label={before ? 'Illustration vor der Reinigung' : 'Illustration nach der Reinigung'}
    >
      <defs>
        <linearGradient id={`wall-${variant}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={before ? '#8C8A80' : '#E8F1F1'} />
          <stop offset="100%" stopColor={before ? '#6E6C63' : '#CFE3E4'} />
        </linearGradient>
        <linearGradient id={`counter-${variant}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={before ? '#5A5750' : '#0A6E77'} />
          <stop offset="100%" stopColor={before ? '#46443E' : '#0E8A93'} />
        </linearGradient>
        <filter id={`grime-${variant}`}>
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="7" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
      </defs>

      {/* Wand */}
      <rect width="800" height="500" fill={`url(#wall-${variant})`} />

      {/* Kacheln */}
      {Array.from({ length: 9 }).map((_, col) =>
        Array.from({ length: 4 }).map((__, row) => (
          <rect
            key={`${col}-${row}`}
            x={40 + col * 82}
            y={40 + row * 62}
            width="76"
            height="56"
            rx="4"
            fill={before ? '#7C7A71' : '#F4FAFA'}
            opacity={before ? 0.5 : 0.85}
          />
        )),
      )}

      {/* Arbeitsfläche */}
      <rect x="0" y="330" width="800" height="26" fill={`url(#counter-${variant})`} />
      <rect x="0" y="356" width="800" height="144" fill={before ? '#3E3C37' : '#0C1C1F'} opacity="0.92" />

      {/* Schrankfronten */}
      {[60, 250, 440, 630].map((x) => (
        <rect
          key={x}
          x={x}
          y={378}
          width="140"
          height="102"
          rx="8"
          fill={before ? '#4A4842' : '#12262A'}
          stroke={before ? '#5C5952' : '#1D383D'}
          strokeWidth="2"
        />
      ))}

      {/* Schmutzschleier nur auf der Vorher-Seite */}
      {before ? (
        <>
          <rect width="800" height="500" filter={`url(#grime-${variant})`} opacity="0.16" />
          <ellipse cx="220" cy="300" rx="120" ry="34" fill="#2F2C26" opacity="0.28" />
          <ellipse cx="560" cy="316" rx="90" ry="24" fill="#2F2C26" opacity="0.22" />
        </>
      ) : (
        // Glanzlicht auf der Nachher-Seite
        <path
          d="M120 330 L260 330 L200 356 L60 356 Z"
          fill="#FFFFFF"
          opacity="0.22"
        />
      )}
    </svg>
  );
}
