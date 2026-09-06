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
}

export function FilterBar({
  searchPlaceholder = 'Suchen …',
  filters = [],
  className,
  children,
}: {
  searchPlaceholder?: string;
  filters?: FilterDefinition[];
  className?: string;
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [search, setSearch] = React.useState(searchParams.get('q') ?? '');

  const apply = React.useCallback(
    (updates: Record<string, string | undefined>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (!value || value === 'alle') params.delete(key);
        else params.set(key, value);
      }
      // Jede Filteränderung beginnt wieder auf Seite 1.
      params.delete('seite');
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  // Suche entprellt anwenden.
  React.useEffect(() => {
    const current = searchParams.get('q') ?? '';
    if (search === current) return;

    const timer = window.setTimeout(() => apply({ q: search || undefined }), 400);
    return () => window.clearTimeout(timer);
  }, [search, apply, searchParams]);

  const activeCount = [...searchParams.keys()].filter(
    (key) => key !== 'seite' && searchParams.get(key),
  ).length;

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
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

      {filters.map((filter) => (
        <Select
          key={filter.param}
          value={searchParams.get(filter.param) ?? 'alle'}
          onValueChange={(value) => apply({ [filter.param]: value })}
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
