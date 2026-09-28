import type { Permission } from '@/lib/auth/permissions';

/**
 * Welche Schnellaktionen und Verweise ein Scantreffer anbietet — reine
 * Regeln, ohne Datenbank und ohne `server-only` (Scanplattform, Ausbau
 * 2026-09-28).
 *
 * ---------------------------------------------------------------------------
 *  Warum diese Regeln eine eigene Datei haben
 * ---------------------------------------------------------------------------
 *
 * Bis 2026-09-27 standen sie mitten in den Abfragen von `scan.service.ts`.
 * Prüfen liessen sie sich nur über HTTP, gegen einen laufenden Server und
 * einen Demobestand, der zufällig ein Gerät in Wartung und einen Einsatz mit
 * laufender Zeiterfassung enthalten musste. Die Frage „bietet der Scanner
 * einer Betriebsleiterin *Zuteilen* an, wenn das Gerät in Wartung ist?" ist
 * aber keine Frage an eine Datenbank — sie ist eine Regel. Als reine Funktion
 * prüft `tests/api/scan-regeln.test.ts` jede Rolle und jeden Zustand direkt,
 * und der Dienst liefert nur noch die Tatsachen (Status, Zuteilung, Recht).
 *
 * ---------------------------------------------------------------------------
 *  Was eine Aktion hier ist — und was nicht
 * ---------------------------------------------------------------------------
 *
 * Eine **Aktion** ist der Schlüssel einer Maske für einen *bestehenden*
 * Endpunkt (`src/features/shared/scan-aktionen.ts`). Sie wird nie von selbst
 * gesendet; der Mensch öffnet die Maske und bestätigt mit ihrem Knopf, und der
 * Endpunkt prüft Recht, Mandant, Zustand und Sperren erneut. Dass die Regel
 * hier eine Aktion anbietet, ist deshalb **keine Berechtigung** — nur die
 * Entscheidung, keinen Knopf zu zeigen, den der Endpunkt ohnehin abwiese.
 * Der Knopf, der fehlt, schützt nichts; der Endpunkt schützt.
 *
 * Ein **Verweis** ist ein Ziel zum Lesen: eine Seite (Rapport im Portal) oder
 * eine Datei (Rechnungs-PDF, Einsatzbericht). Verweise ändern nichts, und auch
 * ihre Ziele prüfen beim Abruf selbst — `GET /api/invoices/:id/pdf` verlangt
 * `invoice:read`, gleich ob der Link aus dem Scanner oder aus der Liste kam.
 * Die Adresse bildet ausschliesslich diese Datei aus der Datensatz-ID, die der
 * Server geladen hat; nie aus dem gescannten Text. Ein Code, der eine Adresse
 * enthält, wird schon in `kennung.ts` als ADRESSE abgewiesen.
 */

/** Die Schlüssel der Masken — der Server nennt sie, der Browser baut daraus die Maske. */
export type ScanAktionSchluessel =
  | 'material.eingang'
  | 'material.entnahme'
  | 'material.korrektur'
  | 'geraet.wartung'
  | 'geraet.defekt'
  | 'geraet.verfuegbar'
  | 'geraet.zuteilen'
  | 'geraet.zuruecknehmen'
  | 'einsatz.einstempeln'
  | 'einsatz.ausstempeln'
  | 'rechnung.zahlung';

export interface ScanRegelAktion {
  schluessel: ScanAktionSchluessel;
  label: string;
}

/**
 * `seite`: eine Seite der Anwendung, im selben Fenster. `datei`: ein
 * Herunterladen über einen bestehenden GET-Endpunkt (PDF) — im Browser als
 * `<a download>` dargestellt, damit der Scandialog nicht verlassen wird.
 */
export interface ScanVerweis {
  label: string;
  href: string;
  art: 'seite' | 'datei';
}

export interface ScanRegelErgebnis {
  aktionen: ScanRegelAktion[];
  verweise: ScanVerweis[];
}

type Darf = (recht: Permission) => boolean;

const NICHTS: ScanRegelErgebnis = { aktionen: [], verweise: [] };

/** Status, in denen auf einen Einsatz eingestempelt werden kann (`clockIn` in `job.service.ts`). */
export const EINSTEMPELBAR: ReadonlySet<string> = new Set(['SCHEDULED', 'DISPATCHED', 'EN_ROUTE', 'IN_PROGRESS', 'ON_HOLD']);
/** Rechnungsstatus, auf die eine Zahlung verbucht werden kann. */
export const ZAHLBAR: ReadonlySet<string> = new Set(['ISSUED', 'SENT', 'PARTIALLY_PAID', 'OVERDUE']);

/**
 * Material: Eingang, Entnahme, Inventurkorrektur — nur mit Lagerpflege und
 * nur für einen aktiven Artikel. Ein inaktiver Artikel wird nicht mehr
 * bewegt; die Materialliste blendet ihn aus, der Scan zeigt ihn, ohne Knöpfe.
 *
 * „Nachbestellen" gibt es bewusst nicht: Clenaris hat kein Bestellmodell. Ein
 * Knopf, der eine E-Mail an niemanden vorbereitet oder eine Liste füllt, die
 * niemand abarbeitet, wäre eine Scheinfunktion
 * (`docs/ENGINEERING_DEFINITION_OF_DONE.md`, „Keine Scheinfunktionen"). Der
 * Treffer zeigt stattdessen den Hinweis „am oder unter dem Meldebestand".
 */
export function materialRegeln(p: { darf: Darf; aktiv: boolean }): ScanRegelErgebnis {
  if (!p.darf('inventory:manage') || !p.aktiv) return NICHTS;
  return {
    aktionen: [
      { schluessel: 'material.eingang', label: 'Wareneingang' },
      { schluessel: 'material.entnahme', label: 'Entnahme' },
      { schluessel: 'material.korrektur', label: 'Inventurkorrektur' },
    ],
    verweise: [],
  };
}

/**
 * Gerät: Wartung, Defekt/Wieder verfügbar, Zuteilen/Zurücknehmen.
 *
 * Die Zuteilungsregeln sind die von `assignEquipment`: nicht ausgemustert, zum
 * Zuteilen nicht in Wartung. „Zuteilen" nur, wenn das Gerät frei ist — ein
 * bereits zugeteiltes Gerät wird erst zurückgenommen; ein Umhängen in einem
 * Schritt verschluckte, dass die erste Person es zurückgeben muss. Die
 * Geräteliste bietet genau dieselben Knöpfe (`admin/geraete/page.tsx`).
 */
export function geraetRegeln(p: { darf: Darf; status: string; zugeteilt: boolean }): ScanRegelErgebnis {
  if (!p.darf('equipment:manage') || p.status === 'RETIRED') return NICHTS;
  const aktionen: ScanRegelAktion[] = [{ schluessel: 'geraet.wartung', label: 'Wartung erfassen' }];
  if (p.status === 'MAINTENANCE') aktionen.push({ schluessel: 'geraet.verfuegbar', label: 'Wieder verfügbar' });
  else aktionen.push({ schluessel: 'geraet.defekt', label: 'Defekt melden' });
  if (p.zugeteilt) aktionen.push({ schluessel: 'geraet.zuruecknehmen', label: 'Zurücknehmen' });
  else if (p.status === 'AVAILABLE') aktionen.push({ schluessel: 'geraet.zuteilen', label: 'Zuteilen' });
  return { aktionen, verweise: [] };
}

/**
 * Einsatz: Einstempeln (das *ist* der Start — `clockIn` setzt den Einsatz auf
 * „in Arbeit"), Ausstempeln, Rapport.
 *
 * Stempeln nur, wer selbst zugeteilt ist und `timetracking:own` hält; das Büro
 * stempelt nicht für andere (dafür gibt es die Nacherfassung mit eigener
 * Prüfung). Läuft auf *diesem* Einsatz bereits die eigene Zeit, wird statt
 * „Einstempeln" „Ausstempeln" angeboten — ein zweites Einstempeln wiese der
 * Endpunkt ohnehin mit 422 ab, und wer vor der Tür steht, will gehen, nicht
 * die Fehlermeldung lesen.
 *
 * Rapport: Im Büro der Einsatzbericht als PDF (`GET /api/jobs/:id/report`,
 * `job:read`). Im Portal gibt es kein PDF für Mitarbeitende — ihr Rapport ist
 * die Checkliste mit Fotos und Abschluss auf der Einsatzseite (`#rapport`).
 */
export function einsatzRegeln(p: {
  darf: Darf;
  buero: boolean;
  id: string;
  status: string;
  zugeteilt: boolean;
  laeuftHier: boolean;
}): ScanRegelErgebnis {
  const aktionen: ScanRegelAktion[] = [];
  if (p.darf('timetracking:own') && p.zugeteilt) {
    if (p.laeuftHier) aktionen.push({ schluessel: 'einsatz.ausstempeln', label: 'Ausstempeln' });
    else if (EINSTEMPELBAR.has(p.status)) aktionen.push({ schluessel: 'einsatz.einstempeln', label: 'Einstempeln' });
  }
  const pfad = encodeURIComponent(p.id);
  const verweise: ScanVerweis[] = [];
  if (p.buero && p.darf('job:read')) verweise.push({ label: 'Rapport (PDF)', href: `/api/jobs/${pfad}/report`, art: 'datei' });
  else if (!p.buero && p.zugeteilt) verweise.push({ label: 'Rapport', href: `/portal/einsaetze/${pfad}#rapport`, art: 'seite' });
  return { aktionen, verweise };
}

/**
 * Rechnung: PDF mit Leserecht, „Zahlung erfassen" nur mit `payment:create`
 * und nur für eine offene Rechnung. Der Betrag wird **eingegeben**, nie aus
 * dem gescannten Zahlteil übernommen (Bedrohung 20 in
 * `docs/SECURITY_THREAT_MODEL_SCANNER.md`).
 */
export function rechnungRegeln(p: { darf: Darf; id: string; status: string }): ScanRegelErgebnis {
  if (!p.darf('invoice:read')) return NICHTS;
  return {
    aktionen: p.darf('payment:create') && ZAHLBAR.has(p.status) ? [{ schluessel: 'rechnung.zahlung', label: 'Zahlung erfassen' }] : [],
    verweise: [{ label: 'PDF', href: `/api/invoices/${encodeURIComponent(p.id)}/pdf`, art: 'datei' }],
  };
}

/**
 * Ein Verweis darf nur auf einen Pfad dieser Anwendung zeigen. Der Server
 * bildet ihn ohnehin selbst; der Browser prüft trotzdem, bevor er einen Link
 * rendert — ein `//fremd.example` oder `javascript:` aus einer künftigen
 * Änderung am Dienst soll nicht still zum anklickbaren Link werden.
 */
export function verweisSicher(href: string): boolean {
  return /^\/(?!\/)[A-Za-z0-9\-._~/%#?=&]*$/.test(href) && !href.includes('\\');
}
