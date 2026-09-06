'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { Monitor, Moon, Sun } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Umschalter für Hell / Dunkel / System.
 *
 * Als Dreiersegment statt als Zwei-Zustands-Schalter: „System" ist eine echte,
 * eigenständige Wahl, und wer sie trifft, soll sie auch sehen. Bis die
 * Client-Hydration abgeschlossen ist, wird ein Platzhalter gleicher Grösse
 * gerendert — sonst springt das Layout.
 */
const OPTIONS = [
  { value: 'light', label: 'Hell', Icon: Sun },
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'dark', label: 'Dunkel', Icon: Moon },
] as const;

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => setMounted(true), []);

  if (!mounted) {
    return <div className={cn('h-9 w-[7.5rem] rounded-xl bg-muted', className)} aria-hidden />;
  }

  return (
    <div
      className={cn('inline-flex items-center gap-0.5 rounded-xl bg-muted p-1', className)}
      role="radiogroup"
      aria-label="Farbschema"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => setTheme(value)}
            className={cn(
              'flex size-8 items-center justify-center rounded-lg transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'bg-card text-foreground shadow-soft'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-4" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
