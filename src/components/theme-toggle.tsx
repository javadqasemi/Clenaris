'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { Check, Monitor, Moon, Sun } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/overlays';

/**
 * Umschalter für Hell / Dunkel / System.
 *
 * Gestaltungsentscheide:
 *
 *  • **Ein Symbol, nicht drei.** Das Dreiersegment brauchte 7.5 rem in einer
 *    Kopfzeile, in der jeder Pixel an die Telefonnummer und den Buchungsknopf
 *    geht. Ein Symbolknopf mit Menü kostet 2.5 rem und zeigt trotzdem beides:
 *    welcher Modus gilt (das Symbol) und welche zur Wahl stehen (das Menü).
 *
 *  • **Das Symbol zeigt die *Wirkung*, nicht die Einstellung.** Steht die Wahl
 *    auf „System" und das Betriebssystem auf dunkel, erscheint der Mond. Wer
 *    auf den Knopf schaut, will wissen, was gerade gilt; welche Regel dahinter
 *    steht, sagt das geöffnete Menü mit dem Haken.
 *
 *  • **Standard ist „System".** Gesetzt in `Providers` (`defaultTheme`), nicht
 *    hier — sonst gäbe es zwei Orte, an denen der Standard steht.
 *
 * Bis die Client-Hydration abgeschlossen ist, wird ein Platzhalter gleicher
 * Grösse gerendert: `theme` ist auf dem Server unbekannt, und ein Symbol, das
 * nach dem ersten Frame wechselt, liest sich wie ein Fehler.
 */
const OPTIONS = [
  { value: 'light', label: 'Hell', Icon: Sun },
  { value: 'dark', label: 'Dunkel', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
] as const;

export function ThemeToggle({
  className,
  align = 'end',
}: {
  className?: string;
  align?: 'start' | 'center' | 'end';
}) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <div
        className={cn('size-10 shrink-0 rounded-xl bg-muted/60', className)}
        aria-hidden
      />
    );
  }

  // Das angezeigte Symbol folgt der tatsächlichen Darstellung, nicht der Wahl.
  const TriggerIcon = theme === 'system' ? Monitor : resolvedTheme === 'dark' ? Moon : Sun;
  const current = OPTIONS.find((option) => option.value === theme) ?? OPTIONS[2];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={className}
          aria-label={`Farbschema: ${current.label}. Ändern`}
          title={`Farbschema: ${current.label}`}
        >
          <TriggerIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align={align} className="w-48">
        <DropdownMenuLabel>Farbschema</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {OPTIONS.map(({ value, label, Icon }) => {
          const active = theme === value;
          return (
            <DropdownMenuItem key={value} onSelect={() => setTheme(value)}>
              <Icon aria-hidden />
              <span className="flex-1">{label}</span>
              {active ? (
                <Check className="size-4 text-primary" aria-hidden />
              ) : null}
              {active ? <span className="sr-only">(aktiv)</span> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
