'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Search, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/controls';

/**
 * Filterleiste für Listenansichten.
 *
 * Alle Filter stehen in der URL — teilbar, mit funktionierendem Zurück-Knopf
 * und ohne doppelte Zustandshaltung. Die Suche ist entprellt, damit nicht bei
 * jedem Tastendruck eine Navigation ausgelöst wird.
 */

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterDefinition {
  param: string;
  label: string;
  options: FilterOption[];
  /**
   * Der Wert, den die Seite annimmt, wenn der Parameter fehlt.
   *
   * Ohne Angabe heisst „fehlt" = „alle" — so sind fast alle Listen gebaut, und
   * die Leiste streicht `alle` deshalb aus der URL. Manche Listen zeigen ohne
   * Parameter aber bewusst eine Auswahl (Massnahmen: nur offene). Für sie
   * stand bis 2026-09-28 der Auswahlknopf auf „alle", während die Seite
   * „offen" zeigte, und „Alle" liess sich gar nicht wählen: die Leiste löschte
   * den Wert, die Seite fiel auf „offen" zurück. Mit `defaultValue` zeigt der
   * Knopf ohne Parameter diesen Wert, dessen Wahl entfernt den Parameter, und
   * „alle" wird ausdrücklich als `?param=alle` in die URL geschrieben.
   */
  defaultValue?: string;
}

export function FilterBar({
  searchPlaceholder = 'Suchen …',
  filters = [],
  search: showSearch = true,
  className,
  children,
}: {
  searchPlaceholder?: string;
  filters?: FilterDefinition[];
  /**
   * Suchfeld anzeigen. Nur abschalten, wenn die Seite `q` nicht auswertet —
   * ein Suchfeld, das nichts filtert, lässt glauben, es gebe keinen Treffer.
   */
  search?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [search, setSearch] = React.useState(searchParams.get('q') ?? '');

  // Filter, bei denen „alle" nicht der Normalfall ist und deshalb ausdrücklich
  // in der URL stehen muss (siehe `defaultValue`).
  const explicitAll = React.useMemo(
    () => new Set(filters.filter((f) => f.defaultValue !== undefined).map((f) => f.param)),
    [filters],
  );

  const apply = React.useCallback(
    (updates: Record<string, string | undefined>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (!value || (value === 'alle' && !explicitAll.has(key))) params.delete(key);
        else params.set(key, value);
      }
      // Jede Filteränderung beginnt wieder auf Seite 1.
      params.delete('seite');
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams, explicitAll],
  );

  // Suche entprellt anwenden.
  React.useEffect(() => {
    if (!showSearch) return;
    const current = searchParams.get('q') ?? '';
    if (search === current) return;

    const timer = window.setTimeout(() => apply({ q: search || undefined }), 400);
    return () => window.clearTimeout(timer);
  }, [search, apply, searchParams, showSearch]);

  const activeCount = [...searchParams.keys()].filter(
    (key) => key !== 'seite' && searchParams.get(key),
  ).length;

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {showSearch ? (
        <div className="min-w-[14rem] flex-1">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={searchPlaceholder}
            startIcon={<Search />}
            aria-label="Liste durchsuchen"
            className="h-10"
          />
        </div>
      ) : null}

      {filters.map((filter) => (
        <Select
          key={filter.param}
          value={searchParams.get(filter.param) ?? filter.defaultValue ?? 'alle'}
          onValueChange={(value) =>
            // Der Standardwert steht nie in der URL — sonst gäbe es zwei
            // Adressen für dieselbe Ansicht, und „Filter zurücksetzen" bliebe
            // sichtbar, obwohl nichts vom Normalfall abweicht.
            apply({ [filter.param]: value === filter.defaultValue ? undefined : value })
          }
        >
          <SelectTrigger className="h-10 w-auto min-w-[9rem] gap-2" aria-label={filter.label}>
            <SelectValue placeholder={filter.label} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="alle">{filter.label}: alle</SelectItem>
            {filter.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ))}

      {children}

      {activeCount > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setSearch('');
            router.push(pathname, { scroll: false });
          }}
        >
          <X aria-hidden />
          Filter zurücksetzen
        </Button>
      ) : null}
    </div>
  );
}
