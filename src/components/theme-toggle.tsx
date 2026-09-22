'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { Check, Monitor, Moon, Sun } from 'lucide-react';

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
 * ---------------------------------------------------------------------------
 *  Warum hier alle drei Symbole im Baum stehen
 * ---------------------------------------------------------------------------
 *
 * Bis Wave 9.1 rendete diese Komponente vor dem Einhängen einen **Platzhalter**
 * — ein `<div>` gleicher Grösse — und danach den `<button>`. Der erste
 * Rendervorgang stimmte damit zwar mit dem Server überein (das war der Zweck),
 * aber der Tausch danach änderte die *Struktur* des Anwendungsrahmens, und
 * zwar im Bereich weniger Millisekunden um das Ende der Hydration herum:
 * gemessen auf `/portal/profil` Platzhalter-Tausch bei 278–311 ms,
 * Hydrationsfehler bei 303–494 ms.
 *
 * Deshalb steht jetzt immer dieselbe Struktur da: ein `<button>` mit **allen
 * drei** Symbolen, von denen zwei ausgeblendet sind. Was sich ändert, sind
 * Klassen und Beschriftung — nie ein Element. Der Preis sind zwei zusätzliche
 * SVGs im Dokument; der Gewinn ist ein Rahmen, dessen Gestalt nicht davon
 * abhängt, wie weit der Browser gerade ist.
 *
 * Vor dem Einhängen gilt „System" — derselbe Vorgabewert, den `Providers`
 * setzt und den der Server rendert.
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

  /**
   * Welches Symbol gilt — vor dem Einhängen immer „System".
   *
   * Das angezeigte Symbol folgt der tatsächlichen Darstellung, nicht der Wahl:
   * Steht die Wahl auf „System" und das Betriebssystem auf dunkel, erscheint
   * der Mond.
   */
  const sichtbar: 'monitor' | 'moon' | 'sun' = !mounted
    ? 'monitor'
    : theme === 'system'
      ? 'monitor'
      : resolvedTheme === 'dark'
        ? 'moon'
        : 'sun';

  const current = (mounted ? OPTIONS.find((option) => option.value === theme) : undefined) ?? OPTIONS[2];

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
          {/*
            Alle drei Symbole stehen im Baum; zwei sind ausgeblendet. Die
            Begründung steht oben im Kopfkommentar: Der Rahmen darf seine
            Gestalt nicht ändern, während React noch hydriert.
          */}
          <Monitor className={sichtbar === 'monitor' ? undefined : 'hidden'} aria-hidden />
          <Moon className={sichtbar === 'moon' ? undefined : 'hidden'} aria-hidden />
          <Sun className={sichtbar === 'sun' ? undefined : 'hidden'} aria-hidden />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align={align} className="w-48">
        <DropdownMenuLabel>Farbschema</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {OPTIONS.map(({ value, label, Icon }) => {
          // Der Menüinhalt entsteht erst beim Öffnen, also lange nach der
          // Hydration — hier darf die Struktur vom Zustand abhängen.
          const active = mounted && theme === value;
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
