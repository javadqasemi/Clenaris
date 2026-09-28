import type { Metadata } from 'next';
import { MousePointerClick } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { formatDate, formatNumber } from '@/lib/utils';
import { trafficZeitraumAufloesen } from '@/lib/traffic/zeitraum';
import {
  BROWSER_BESCHRIFTUNG,
  EREIGNIS_BESCHRIFTUNG,
  GERAET_BESCHRIFTUNG,
} from '@/lib/traffic/ereignisse';
import { trafficAuswertungQuerySchema } from '@/lib/validation/traffic';
import { getOrganizationId } from '@/server/services/organization.service';
import { trafficAuswertung } from '@/server/services/traffic.service';
import { DetailSection, EmptyState, PageHeader, TableScroll } from '@/components/app/page-parts';
import { KpiTile } from '@/components/app/kpi-tile';
import { AuswertungenReiter } from '@/features/admin/auswertungen-reiter';
import { Rangliste, TrafficZeitraumWahl, veraenderung } from '@/features/admin/traffic-auswertung';

export const metadata: Metadata = {
  title: 'Website-Besuche',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Besuchsauswertung der Website — die zweite Sicht unter „Auswertungen".
 *
 * Liest als Server Component direkt über den Dienst (`trafficAuswertung`);
 * geschrieben wird hier nichts. `requirePermission` statt
 * `requirePagePermission`: Die Seite ist eine Leseansicht, kein
 * Bearbeitungsformular, und eine Rolle ohne Recht soll die Fehlergrenze des
 * Bereichs sehen wie bei den übrigen Auswertungen.
 *
 * Ein unbrauchbarer Zeitraum in der Adresse ergibt keinen Fehler, sondern
 * „30 Tage" (`safeParse` + Rückfall in `trafficZeitraumAufloesen`) — wer einen
 * Link mit Tippfehler öffnet, soll eine Auswertung sehen, keine Fehlerseite.
 */
export default async function WebsiteBesuchePage({
  searchParams,
}: {
  searchParams: Promise<{ zeitraum?: string; von?: string; bis?: string }>;
}) {
  const session = await requirePermission('traffic:read');
  const params = await searchParams;
  const geprueft = trafficAuswertungQuerySchema.safeParse(params);
  const query = geprueft.success ? geprueft.data : { zeitraum: '30tage' as const, von: undefined, bis: undefined };

  const zeitraum = trafficZeitraumAufloesen(query.zeitraum, query.von, query.bis);
  const daten = await trafficAuswertung(await getOrganizationId(), zeitraum);

  const leer = daten.seitenansichten === 0 && daten.konversionen.every((k) => k.ereignisse === 0);
  const einstiegeGesamt = daten.geraete.reduce((s, g) => s + g.anzahl, 0);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Website-Besuche"
        description={`${formatDate(zeitraum.vonTag)} – ${formatDate(zeitraum.bisTag)} · Zürcher Tage · nur Besuche mit Einwilligung „Statistik"`}
      >
        <AuswertungenReiter rolle={session.role} aktiv="website" />
      </PageHeader>

      <TrafficZeitraumWahl aktiv={zeitraum.art} von={daten.von} bis={daten.bis} />

      {/*
        Was die Zahlen sind und was nicht — sichtbar, nicht in einem Tooltip.
        Wer die Auswertung liest, soll nicht glauben, hier stünden alle
        Besucherinnen oder einzelne Personen.
      */}
      <p className="prose-measure text-sm leading-relaxed text-muted-foreground">
        Gezählt werden Seitenansichten und <strong className="font-medium text-foreground">Sitzungen</strong>{' '}
        — eine Sitzung ist ein Browser-Tab an einem Tag. Einzelne Besucherinnen und Besucher werden
        nicht verfolgt und nicht wiedererkannt. Gemessen wird nur, wer im Cookie-Hinweis der
        Statistik zugestimmt hat; Browser mit „Nicht verfolgen“ und Werbeblocker fehlen ganz. Die
        Zahlen liegen deshalb unter der tatsächlichen Besucherzahl und eignen sich für Vergleiche
        über die Zeit, nicht als absolute Grösse.
      </p>

      {leer ? (
        <EmptyState
          icon={<MousePointerClick aria-hidden />}
          title="Keine Besuche in diesem Zeitraum"
          description="Es liegen keine gemessenen Besuche vor. Das ist normal, solange niemand der Statistik zugestimmt hat oder die Messung neu ist. Ein längerer Zeitraum zeigt vielleicht ältere Besuche."
          action={{ href: '/admin/auswertungen/website?zeitraum=jahr', label: 'Laufendes Jahr anzeigen' }}
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiTile
              label="Seitenansichten"
              value={formatNumber(daten.seitenansichten)}
              changePercent={veraenderung(daten.seitenansichten, daten.vorher.seitenansichten)}
              hint="ggü. Vorzeitraum"
            />
            <KpiTile
              label="Sitzungen"
              value={formatNumber(daten.sitzungen)}
              changePercent={veraenderung(daten.sitzungen, daten.vorher.sitzungen)}
              hint="Tab je Tag, keine Personen"
            />
            <KpiTile
              label="Seiten je Sitzung"
              value={formatNumber(daten.seitenJeSitzung, 'de', 1)}
            />
            <KpiTile
              label="Konversionsrate"
              value={`${formatNumber(daten.konversionsrate, 'de', 1)} %`}
              hint={`${formatNumber(daten.konvertierteSitzungen)} Sitzungen mit Anfrage, Buchung oder Kontakt`}
            />
          </div>

          <DetailSection
            title="Konversionen"
            description="Ereignisse und Anteil der Sitzungen, in denen sie mindestens einmal vorkamen."
            body="flush"
          >
            <TableScroll minWidth="30rem" label="Konversionen, waagrecht scrollbar">
              <table className="data-table">
                <caption className="sr-only">Konversionen im Zeitraum</caption>
                <thead>
                  <tr>
                    <th scope="col">Ereignis</th>
                    <th scope="col" className="text-right">
                      Anzahl
                    </th>
                    <th scope="col" className="text-right">
                      Sitzungen
                    </th>
                    <th scope="col" className="text-right">
                      Rate
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {daten.konversionen.map((k) => (
                    <tr key={k.name}>
                      <td className="font-medium">{EREIGNIS_BESCHRIFTUNG[k.name]}</td>
                      <td className="num tabular-nums">{formatNumber(k.ereignisse)}</td>
                      <td className="num tabular-nums">{formatNumber(k.sitzungen)}</td>
                      <td className="num tabular-nums">{formatNumber(k.rate, 'de', 1)} %</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </DetailSection>

          <div className="grid gap-6 xl:grid-cols-2">
            <Rangliste
              titel="Einstiegsseiten"
              beschreibung="Die erste Seite einer Sitzung."
              spalte="Seite"
              zahlSpalte="Einstiege"
              zeilen={daten.einstiegsseiten}
              leer="Keine Einstiege im Zeitraum."
            />
            <Rangliste
              titel="Meistbesuchte Seiten"
              spalte="Seite"
              zahlSpalte="Ansichten"
              zeilen={daten.topSeiten}
              leer="Keine Seitenansichten im Zeitraum."
            />
            <Rangliste
              titel="Herkunft"
              beschreibung="Die verweisende Website beim Einstieg — ohne Direktaufrufe und ohne die eigene Website."
              spalte="Website"
              zahlSpalte="Einstiege"
              zeilen={daten.herkunft}
              leer="Keine verweisenden Websites erfasst. Direktaufrufe und Browser, die den Referrer unterdrücken, erscheinen hier nicht."
            />
            <Rangliste
              titel="Kampagnen (utm_campaign)"
              spalte="Kampagne"
              zahlSpalte="Einstiege"
              zeilen={daten.utmKampagne}
              leer="Keine Einstiege mit Kampagnenparameter."
            />
            <Rangliste
              titel="Quelle (utm_source)"
              spalte="Quelle"
              zahlSpalte="Einstiege"
              zeilen={daten.utmQuelle}
              leer="Keine Einstiege mit Quellenparameter."
            />
            <Rangliste
              titel="Medium (utm_medium)"
              spalte="Medium"
              zahlSpalte="Einstiege"
              zeilen={daten.utmMedium}
              leer="Keine Einstiege mit Mediumparameter."
            />
            <Rangliste
              titel="Geräte"
              beschreibung="Gerätefamilie beim Einstieg. iPads melden sich als Computer."
              spalte="Gerät"
              zahlSpalte="Einstiege"
              zeilen={daten.geraete.map((g) => ({
                schluessel: g.geraet,
                beschriftung: GERAET_BESCHRIFTUNG[g.geraet],
                anzahl: g.anzahl,
              }))}
              leer={einstiegeGesamt === 0 ? 'Keine Einstiege im Zeitraum.' : 'Keine Angaben.'}
            />
            <Rangliste
              titel="Browser"
              spalte="Browser"
              zahlSpalte="Einstiege"
              zeilen={daten.browser.map((b) => ({
                schluessel: b.browser,
                beschriftung: BROWSER_BESCHRIFTUNG[b.browser],
                anzahl: b.anzahl,
              }))}
              leer="Keine Einstiege im Zeitraum."
            />
          </div>
        </>
      )}
    </div>
  );
}
