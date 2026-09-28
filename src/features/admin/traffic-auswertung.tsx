import Link from 'next/link';

import { cn, formatNumber } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DetailSection, TableScroll } from '@/components/app/page-parts';
import {
  TRAFFIC_ZEITRAEUME,
  ZEITRAUM_BESCHRIFTUNG,
  type TrafficZeitraum,
} from '@/lib/traffic/zeitraum';

/**
 * Bausteine der Besuchsauswertung (`/admin/auswertungen/website`).
 *
 * Alles Server-Komponenten: Die Seite ist eine reine Leseansicht, und jede
 * Wahl (Zeitraum, eigene Daten) steht in der Adresse. Das hält die Auswertung
 * teilbar und neu ladbar und braucht kein Skript — auch die Datumswahl ist
 * ein gewöhnliches GET-Formular. Hier und nicht in der Seitendatei, weil eine
 * Seite ausser `default` und der Segmentkonfiguration nichts exportieren darf.
 */

const BASIS = '/admin/auswertungen/website';

/**
 * Zeitraumwahl als Zeile von Verweisen plus Formular für einen eigenen
 * Zeitraum.
 *
 * Nicht `RangePicker`: Der kennt fünf feste Zeiträume und schreibt `zeitraum`
 * über den Router; hier kommen „30 Tage" und ein freier Zeitraum dazu, und
 * der freie braucht zwei Datumsfelder. Die Optik folgt ihm (gleiche
 * Segmentleiste), die Bedienung ist ein Link je Zeitraum — mit Tastatur und
 * ohne Skript erreichbar.
 */
export function TrafficZeitraumWahl({
  aktiv,
  von,
  bis,
}: {
  aktiv: TrafficZeitraum;
  von: string;
  bis: string;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <nav aria-label="Zeitraum" className="inline-flex flex-wrap items-center gap-0.5 rounded-xl bg-muted p-1">
        {TRAFFIC_ZEITRAEUME.filter((z) => z !== 'eigen').map((z) => {
          const istAktiv = z === aktiv;
          return (
            <Link
              key={z}
              href={`${BASIS}?zeitraum=${z}`}
              aria-current={istAktiv ? 'page' : undefined}
              scroll={false}
              className={cn(
                'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                istAktiv ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {ZEITRAUM_BESCHRIFTUNG[z]}
            </Link>
          );
        })}
      </nav>

      <form method="get" action={BASIS} className="flex flex-wrap items-end gap-2" aria-label="Eigener Zeitraum">
        <input type="hidden" name="zeitraum" value="eigen" />
        <label className="space-y-1 text-meta text-muted-foreground">
          <span className="block">Von</span>
          <Input type="date" name="von" defaultValue={von} required className="h-10 w-[10.5rem]" />
        </label>
        <label className="space-y-1 text-meta text-muted-foreground">
          <span className="block">Bis</span>
          <Input type="date" name="bis" defaultValue={bis} required className="h-10 w-[10.5rem]" />
        </label>
        <Button type="submit" variant={aktiv === 'eigen' ? 'default' : 'outline'} className="h-10">
          Zeitraum anzeigen
        </Button>
      </form>
    </div>
  );
}

/**
 * Veränderung gegenüber dem Vorzeitraum in Prozent — oder `undefined`, wenn
 * es davor nichts gab. „+∞ %" hilft niemandem; die Kachel zeigt dann keinen
 * Pfeil.
 */
export function veraenderung(jetzt: number, vorher: number): number | undefined {
  if (vorher <= 0) return undefined;
  return ((jetzt - vorher) / vorher) * 100;
}

/**
 * Eine Rangliste als Tabelle mit Anteilsbalken.
 *
 * Der Balken ist Zierde neben der Zahl, nicht an ihrer Stelle: Die Zahl steht
 * immer ausgeschrieben daneben, der Balken ist für Screenreader verborgen.
 */
export function Rangliste({
  titel,
  beschreibung,
  spalte,
  zeilen,
  leer,
  zahlSpalte = 'Anzahl',
}: {
  titel: string;
  beschreibung?: string;
  spalte: string;
  zeilen: { schluessel: string; anzahl: number; beschriftung?: string }[];
  leer: string;
  zahlSpalte?: string;
}) {
  const summe = zeilen.reduce((s, z) => s + z.anzahl, 0);
  const hoechste = Math.max(1, ...zeilen.map((z) => z.anzahl));

  return (
    <DetailSection title={titel} description={beschreibung} body="flush">
      {zeilen.length === 0 || summe === 0 ? (
        <p className="px-6 py-5 text-sm text-muted-foreground">{leer}</p>
      ) : (
        <TableScroll minWidth="22rem" label={`${titel}, waagrecht scrollbar`}>
          <table className="data-table">
            <caption className="sr-only">{titel}</caption>
            <thead>
              <tr>
                <th scope="col">{spalte}</th>
                <th scope="col" className="text-right">
                  {zahlSpalte}
                </th>
                <th scope="col" className="w-[30%]">
                  <span className="sr-only">Anteil</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {zeilen.map((z) => (
                <tr key={z.schluessel}>
                  <td className="max-w-[22rem] truncate font-medium" title={z.beschriftung ?? z.schluessel}>
                    {z.beschriftung ?? z.schluessel}
                  </td>
                  <td className="num tabular-nums">{formatNumber(z.anzahl)}</td>
                  <td aria-hidden>
                    <span className="block h-1.5 rounded-full bg-muted">
                      <span
                        className="block h-1.5 rounded-full bg-primary/70"
                        style={{ width: `${Math.max(2, Math.round((z.anzahl / hoechste) * 100))}%` }}
                      />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </DetailSection>
  );
}
