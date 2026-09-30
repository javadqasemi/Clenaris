import type { SecurityReportStatus } from '@prisma/client';

import { IDENTITAETS_NAMEN, type Identitaet, type IdentitaetsZustand } from '@/lib/release/identitaet';
import { formatDateTime } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { ListCard, TableScroll } from '@/components/app/page-parts';
import type { QuellenZustand } from '@/server/services/security-report.service';

/**
 * Betriebssicherheit von aussen in der Sicherheitszentrale (2026-09-26).
 *
 * Eine Serverkomponente ohne jede Handlung: Sie zeigt, was Prüfungen
 * ausserhalb der Anwendung gemeldet haben (`SecurityReport`), und wie alt
 * das ist. Es gibt hier keinen Knopf „Prüfung starten" und keinen, der ein
 * Programm auf dem Server aufruft — das ist die Abgrenzung aus
 * `docs/SECURITY_AUTOMATION.md`, nicht eine fehlende Funktion.
 *
 * **Ausgeblieben schlägt Status.** Ein grüner Bericht von vorletzter Woche
 * wird als „ausgeblieben" gezeigt, nicht als „in Ordnung": Ein
 * Überwachungsrechner, der verstummt ist, sähe sonst aus wie einer, der
 * nichts findet.
 */

const STATUS: Record<SecurityReportStatus, { text: string; variant: 'success' | 'warning' | 'destructive' | 'neutral' }> = {
  OK: { text: 'In Ordnung', variant: 'success' },
  WARNUNG: { text: 'Warnung', variant: 'warning' },
  KRITISCH: { text: 'Kritisch', variant: 'destructive' },
  NICHT_GEPRUEFT: { text: 'Nicht geprüft', variant: 'neutral' },
};

/**
 * Bekannte Kennzahlen mit Bezeichnung und Einheit. Unbekannte erscheinen
 * unter ihrem Schlüssel — eine neue Kennzahl eines Skripts soll nicht
 * verschwinden, nur weil sie hier noch nicht steht.
 */
const KENNZAHL: Record<string, { label: string; einheit?: string }> = {
  erreichbar: { label: 'Erreichbar' },
  antwortMs: { label: 'Antwortzeit', einheit: 'ms' },
  healthStatus: { label: 'Health-Status' },
  tlsTageBisAblauf: { label: 'TLS-Zertifikat gültig noch', einheit: 'Tage' },
  kopfzeilenFehlend: { label: 'Fehlende Sicherheitskopfzeilen' },
  offengelegteDateien: { label: 'Offen erreichbare Dateien' },
  backupAlterStunden: { label: 'Letzte Sicherung vor', einheit: 'h' },
  wiederherstellungGeprueftAm: { label: 'Wiederherstellung zuletzt geprüft' },
  wiederherstellungErgebnis: { label: 'Ergebnis der Wiederherstellungsprobe' },
  zapWarnungen: { label: 'ZAP-Warnungen' },
  zapFehler: { label: 'ZAP-Fehler' },
  paketeMitUpdates: { label: 'Betriebssystempakete mit Updates' },
  sicherheitsupdates: { label: 'davon Sicherheitsupdates' },
  aideAbweichungen: { label: 'AIDE-Abweichungen' },
  malwareSignaturenAlterStunden: { label: 'Malware-Signaturen alt', einheit: 'h' },
};

/**
 * Farbe je Identitätszustand (2026-09-30). „Ohne RELEASE.json" ist eine
 * Warnung und kein Alarm: In der Entwicklung und auf einem Prüfbau ohne
 * Manifest ist es der Normalfall, in der Produktion verhindert es die
 * Vorprüfung ohnehin. Widersprüchlich und ungültig dagegen heissen, dass
 * jemand ein Manifest neben einen Bau gelegt hat, zu dem es nicht gehört —
 * das ist in keiner Umgebung ein Normalfall.
 */
const IDENTITAET_FARBE: Record<IdentitaetsZustand, 'success' | 'warning' | 'destructive'> = {
  belegt: 'success',
  'ohne-manifest': 'warning',
  widerspruechlich: 'destructive',
  ungueltig: 'destructive',
};

function wert(schluessel: string, v: number | string | boolean): string {
  const k = KENNZAHL[schluessel];
  const text = typeof v === 'boolean' ? (v ? 'ja' : 'nein') : String(v);
  return k?.einheit ? `${text} ${k.einheit}` : text;
}

function alter(von: Date, jetzt: Date): string {
  const minuten = Math.round((jetzt.getTime() - von.getTime()) / 60_000);
  if (minuten < 90) return `vor ${minuten} min`;
  const stunden = Math.round(minuten / 60);
  if (stunden < 48) return `vor ${stunden} h`;
  return `vor ${Math.round(stunden / 24)} Tagen`;
}

export function Sicherheitsberichte({
  zustaende,
  identitaet,
  scanner,
  jetzt,
}: {
  zustaende: QuellenZustand[];
  /** Die Identität der Instanz (`release/identitaet.ts`) — bis 2026-09-30 stand hier `APP_VERSION`. */
  identitaet: Pick<Identitaet, 'belegt' | 'zustand' | 'version' | 'commit' | 'buildId' | 'grund'>;
  scanner: { eingerichtet: boolean; art: string; erreichbar: boolean | null; version: string | null };
  jetzt: Date;
}) {
  const befunde = zustaende
    .filter((z) => z.letzter && !z.ausgeblieben)
    .flatMap((z) => z.letzter!.befunde.filter((b) => b.schwere === 'kritisch' || b.schwere === 'hoch').map((b) => ({ ...b, quelle: z.label })))
    .slice(0, 15);

  return (
    <ListCard>
      <div className="px-6 pt-5">
        <h2 className="font-display text-title">Betriebssicherheit von aussen</h2>
        <p className="text-meta text-muted-foreground">
          Gemeldet von Prüfungen ausserhalb der Anwendung (CI, Überwachungsrechner, Sicherung) über{' '}
          <code className="font-mono text-2xs">/api/cron/security-report</code>. Von hier aus wird nichts gestartet.
        </p>
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div>
            <dt className="inline text-muted-foreground">Laufender Stand: </dt>
            <dd className="inline" data-identitaet={identitaet.zustand}>
              <Badge size="sm" variant={IDENTITAET_FARBE[identitaet.zustand]}>
                {IDENTITAETS_NAMEN[identitaet.zustand]}
              </Badge>{' '}
              <span className="font-mono text-xs tabular-nums">
                v{identitaet.version}
                {identitaet.commit ? (
                  <>
                    {' · '}
                    <span title={identitaet.commit}>{identitaet.commit.slice(0, 12)}</span>
                  </>
                ) : null}
                {identitaet.buildId ? ` · Build ${identitaet.buildId}` : ''}
              </span>
              {identitaet.grund ? <span className="block text-2xs text-muted-foreground">{identitaet.grund}</span> : null}
            </dd>
          </div>
          <div>
            <dt className="inline text-muted-foreground">Schadsoftwareprüfer: </dt>
            <dd className="inline">
              {!scanner.eingerichtet
                ? 'nicht eingerichtet'
                : scanner.art === 'clamav'
                  ? scanner.erreichbar
                    ? `ClamAV erreichbar${scanner.version ? ` (${scanner.version})` : ''}`
                    : 'ClamAV eingerichtet, antwortet nicht'
                  : 'Testprüfer (keine Schadsoftwareprüfung)'}
            </dd>
          </div>
        </dl>
      </div>
      <TableScroll minWidth="56rem">
        <table className="data-table" data-sicherheitsberichte>
          <caption className="sr-only">Zustand der Sicherheitsprüfungen ausserhalb der Anwendung</caption>
          <thead>
            <tr>
              <th scope="col">Prüfung</th>
              <th scope="col">Zustand</th>
              <th scope="col">Letzter Bericht</th>
              <th scope="col">Zusammenfassung</th>
              <th scope="col">Kennzahlen</th>
            </tr>
          </thead>
          <tbody>
            {zustaende.map((z) => (
              <tr key={z.quelle} data-quelle={z.quelle}>
                <td className="font-medium">
                  {z.label}
                  <span className="block text-2xs text-muted-foreground">erwartet spätestens alle {z.erwartetAlleStunden < 48 ? `${z.erwartetAlleStunden} h` : `${Math.round(z.erwartetAlleStunden / 24)} Tage`}</span>
                </td>
                <td>
                  {!z.letzter ? (
                    <Badge variant="neutral">Noch nie gemeldet</Badge>
                  ) : z.ausgeblieben ? (
                    <Badge variant="destructive">Ausgeblieben</Badge>
                  ) : (
                    <Badge variant={STATUS[z.letzter.status].variant}>{STATUS[z.letzter.status].text}</Badge>
                  )}
                </td>
                <td className="whitespace-nowrap tabular-nums text-muted-foreground">
                  {z.letzter ? (
                    <>
                      {formatDateTime(z.letzter.receivedAt)}
                      <span className="block text-2xs">{alter(z.letzter.receivedAt, jetzt)}{z.letzter.version ? ` · ${z.letzter.version}` : ''}</span>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="cell-wide text-xs leading-relaxed">{z.letzter?.summary ?? <span className="text-muted-foreground">—</span>}</td>
                <td className="text-xs">
                  {z.letzter && Object.keys(z.letzter.kennzahlen).length ? (
                    <dl className="space-y-0.5">
                      {Object.entries(z.letzter.kennzahlen).slice(0, 8).map(([k, v]) => (
                        <div key={k}>
                          <dt className="inline text-muted-foreground">{KENNZAHL[k]?.label ?? k}: </dt>
                          <dd className="inline tabular-nums">{wert(k, v)}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      {befunde.length ? (
        <div className="border-t border-border px-6 py-4">
          <h3 className="text-sm font-semibold">Befunde der Stufe hoch und kritisch</h3>
          <ul className="mt-2 space-y-2 text-xs" data-sicherheitsbefunde>
            {befunde.map((b, i) => (
              <li key={`${b.quelle}-${b.id ?? i}`}>
                <Badge size="sm" variant={b.schwere === 'kritisch' ? 'destructive' : 'warning'}>
                  {b.schwere}
                </Badge>{' '}
                <span className="font-medium">{b.titel}</span>
                <span className="block text-muted-foreground">
                  {b.quelle}
                  {b.ort ? ` · ${b.ort}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </ListCard>
  );
}
