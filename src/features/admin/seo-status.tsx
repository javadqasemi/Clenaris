import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { DetailSection, TableScroll } from '@/components/app/page-parts';
import { RICHTWERTE, type SeoStatusZeile } from '@/lib/seo/metadaten';

/**
 * Übersicht „SEO-Status" in `/admin/seo` (H3, 2026-09-28).
 *
 * Reine Anzeige, bewusst ohne Knopf: Die Zeilen rechnet `seoStatus()` aus
 * **denselben** Metadaten, die die Seiten ausliefern; ändern lässt sich
 * weiterhin nur über den Editor darunter (Übersichtsseiten) bzw. den
 * Datensatz (Leistung, Beitrag, Stelle). Nichts wird automatisch angepasst —
 * ein Titel über 60 Zeichen kann Absicht sein, und das entscheidet die
 * Redaktion, nicht eine Regel.
 *
 * Server-Komponente: kein Zustand, keine Interaktion, nichts für den Browser.
 */

const STUFE = {
  ok: { label: 'In Ordnung', variant: 'success', Icon: CheckCircle2 },
  hinweis: { label: 'Hinweis', variant: 'info', Icon: Info },
  warnung: { label: 'Prüfen', variant: 'warning', Icon: AlertTriangle },
} as const;

function Laenge({ wert, min, max }: { wert: number; min: number; max: number }) {
  const ausserhalb = wert === 0 || wert < min || wert > max;
  return (
    <span className={ausserhalb ? 'font-medium tabular-nums text-warning' : 'tabular-nums'}>
      {wert}
      <span className="text-muted-foreground"> / {max}</span>
    </span>
  );
}

export function SeoStatusUebersicht({ zeilen }: { zeilen: SeoStatusZeile[] }) {
  const zuPruefen = zeilen.filter((zeile) => zeile.stufe === 'warnung').length;
  const mitHinweis = zeilen.filter((zeile) => zeile.stufe === 'hinweis').length;

  return (
    <DetailSection
      title="SEO-Status"
      description={`${zeilen.length} öffentliche Seiten · ${zuPruefen} zu prüfen · ${mitHinweis} mit Hinweis. Richtwerte: Titel bis ${RICHTWERTE.titelMax} Zeichen (mit „| Clenaris"), Beschreibung ${RICHTWERTE.beschreibungMin}–${RICHTWERTE.beschreibungMax} Zeichen. Berechnet aus denselben Angaben, die die Website ausliefert.`}
      body="flush"
    >
      <TableScroll minWidth="60rem" label="SEO-Status der öffentlichen Seiten, waagrecht scrollbar">
        <table className="data-table">
          <caption className="sr-only">SEO-Status je öffentlicher Seite</caption>
          <thead>
            <tr>
              <th scope="col">Seite</th>
              <th scope="col">Quelle</th>
              <th scope="col" className="text-right">
                Titel
              </th>
              <th scope="col" className="text-right">
                Beschreibung
              </th>
              <th scope="col">Index</th>
              <th scope="col">Vorschaubild</th>
              <th scope="col">Strukturierte Daten</th>
              <th scope="col">Befund</th>
            </tr>
          </thead>
          <tbody>
            {zeilen.map((zeile) => {
              const stufe = STUFE[zeile.stufe];
              return (
                <tr key={zeile.pfad}>
                  <td>
                    <span className="block font-medium">{zeile.bezeichnung}</span>
                    <span className="block text-meta text-muted-foreground">{zeile.pfad}</span>
                  </td>
                  <td className="text-sm text-muted-foreground">{zeile.quelle}</td>
                  <td className="text-right" title={zeile.titel}>
                    <Laenge wert={zeile.titelLaenge} min={RICHTWERTE.titelMin} max={RICHTWERTE.titelMax} />
                  </td>
                  <td className="text-right">
                    <Laenge
                      wert={zeile.beschreibungLaenge}
                      min={RICHTWERTE.beschreibungMin}
                      max={RICHTWERTE.beschreibungMax}
                    />
                  </td>
                  <td>
                    {zeile.indexierbar ? (
                      <Badge variant="neutral" size="sm">
                        index
                      </Badge>
                    ) : (
                      <Badge variant="warning" size="sm">
                        noindex
                      </Badge>
                    )}
                  </td>
                  <td className="text-sm">{zeile.ogBild ? 'vorhanden' : <span className="text-muted-foreground">fehlt</span>}</td>
                  <td className="text-sm text-muted-foreground">{zeile.strukturierteDaten.join(', ')}</td>
                  <td>
                    <Badge variant={stufe.variant} size="sm" className="gap-1">
                      <stufe.Icon className="size-3" aria-hidden />
                      {stufe.label}
                    </Badge>
                    {zeile.befunde.length > 0 ? (
                      <ul className="mt-1.5 space-y-0.5 text-meta text-muted-foreground">
                        {zeile.befunde.map((befund) => (
                          <li key={befund.text}>{befund.text}</li>
                        ))}
                      </ul>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
    </DetailSection>
  );
}
