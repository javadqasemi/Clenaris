import { Skeleton } from '@/components/ui/primitives';

/**
 * Ladeskelette für die Applikationsbereiche.
 *
 * Architekturentscheid: Next.js hält beim Navigieren die *alte* Seite
 * sichtbar, bis die neue fertig gerendert ist — solange keine `loading.tsx`
 * existiert. Bei Seiten, die Datenbankabfragen machen, wirkt das wie eine
 * eingefrorene Oberfläche: man klickt, und eine halbe Sekunde passiert
 * scheinbar nichts.
 *
 * Mit einem Skelett kommt die Antwort sofort und die Seite baut sich sichtbar
 * auf. Die Skelette bilden deshalb die *tatsächliche* Form der Zielseite ab —
 * Kopfzeile, Kennzahlenreihe, Tabelle. Ein generischer grauer Block wäre
 * ehrlicher als nichts, aber ein formgleiches Skelett verhindert zusätzlich
 * das Springen des Layouts beim Eintreffen der Daten.
 *
 * `aria-busy` und der Statusbereich sagen Screenreadern, dass geladen wird;
 * die Skelettflächen selbst sind `aria-hidden` (das steckt in `Skeleton`).
 */

function LoadingRegion({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div aria-busy="true" aria-live="polite" className="space-y-6">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

function HeaderSkeleton({ withAction = true }: { withAction?: boolean }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-2.5">
        <Skeleton className="h-8 w-56 rounded-lg" />
        <Skeleton className="h-4 w-80 max-w-full rounded" />
      </div>
      {withAction ? <Skeleton className="h-10 w-36 rounded-xl" /> : null}
    </div>
  );
}

function KpiRowSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="space-y-3 rounded-2xl border border-border bg-card p-5">
          <Skeleton className="h-3.5 w-24 rounded" />
          <Skeleton className="h-9 w-32 rounded-lg" />
          <Skeleton className="h-3 w-20 rounded" />
        </div>
      ))}
    </div>
  );
}

function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-center justify-between gap-4 border-b border-border p-5">
        <Skeleton className="h-5 w-40 rounded" />
        <Skeleton className="h-9 w-28 rounded-lg" />
      </div>
      <div className="divide-y divide-border">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex items-center gap-4 p-4 sm:px-5">
            <Skeleton className="size-9 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-48 max-w-full rounded" />
              <Skeleton className="h-3 w-32 max-w-full rounded" />
            </div>
            <Skeleton className="hidden h-4 w-24 rounded sm:block" />
            <Skeleton className="h-6 w-20 shrink-0 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Übersichtsseiten: Kopf, Kennzahlen, zwei Inhaltsblöcke. */
export function DashboardSkeleton() {
  return (
    <LoadingRegion label="Übersicht wird geladen">
      <HeaderSkeleton />
      <KpiRowSkeleton />
      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <Skeleton className="h-80 rounded-2xl" />
        <Skeleton className="h-80 rounded-2xl" />
      </div>
      <TableSkeleton rows={5} />
    </LoadingRegion>
  );
}

/** Listenseiten: Kopf, Filterleiste, Tabelle. */
export function ListSkeleton({ kpis = 0, rows = 8 }: { kpis?: number; rows?: number }) {
  return (
    <LoadingRegion label="Liste wird geladen">
      <HeaderSkeleton />
      {kpis > 0 ? <KpiRowSkeleton count={kpis} /> : null}
      <div className="flex flex-wrap gap-3">
        <Skeleton className="h-10 flex-1 min-w-48 rounded-xl" />
        <Skeleton className="h-10 w-36 rounded-xl" />
      </div>
      <TableSkeleton rows={rows} />
    </LoadingRegion>
  );
}

/** Detailseiten: Kopf, Hauptspalte, Nebenspalte. */
export function DetailSkeleton() {
  return (
    <LoadingRegion label="Details werden geladen">
      <Skeleton className="h-8 w-32 rounded-lg" />
      <HeaderSkeleton />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          <Skeleton className="h-64 rounded-2xl" />
          <Skeleton className="h-48 rounded-2xl" />
        </div>
        <div className="space-y-6">
          <Skeleton className="h-56 rounded-2xl" />
          <Skeleton className="h-40 rounded-2xl" />
        </div>
      </div>
    </LoadingRegion>
  );
}

/** Formularseiten: Kopf und gestapelte Abschnitte. */
export function FormSkeleton({ sections = 3 }: { sections?: number }) {
  return (
    <LoadingRegion label="Formular wird geladen">
      <Skeleton className="h-8 w-32 rounded-lg" />
      <HeaderSkeleton withAction={false} />
      <div className="max-w-3xl space-y-8">
        {Array.from({ length: sections }, (_, index) => (
          <div key={index} className="space-y-5 rounded-2xl border border-border bg-card p-6">
            <Skeleton className="h-5 w-36 rounded" />
            <div className="grid gap-4 sm:grid-cols-2">
              {Array.from({ length: 4 }, (_, field) => (
                <div key={field} className="space-y-2">
                  <Skeleton className="h-3.5 w-24 rounded" />
                  <Skeleton className="h-10 w-full rounded-xl" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}

/** Kalenderseiten: Kopf und ein grosses Gitter. */
export function CalendarSkeleton() {
  return (
    <LoadingRegion label="Kalender wird geladen">
      <HeaderSkeleton />
      <Skeleton className="h-[42rem] w-full rounded-2xl" />
    </LoadingRegion>
  );
}
