import type { Permission } from '../src/lib/auth/permissions';
import * as qualitaet from '../src/lib/validation/quality';
import { idParam } from '../src/lib/validation/queries';

import type { Guard, RouteDoc } from './openapi-routes';

/**
 * Die Endpunkte der Qualitätskontrolle (Wave 11) — eigene Datei, wie bei
 * Verträgen und der Unternehmensführung.
 *
 * Diese Registrierung ist **keine Dokumentation neben dem Code**, sondern die
 * Gegenprobe zu ihm: `npm run openapi` vergleicht Pfad, Methode, Schutz und
 * Schemas mit den tatsächlichen Routendateien und schlägt fehl, sobald etwas
 * auseinanderläuft.
 */

const perm = (mode: 'all' | 'any', ...permissions: Permission[]): Guard => ({
  kind: 'permissions',
  permissions,
  mode,
});

export const QUALITY_ROUTES: RouteDoc[] = [
  {
    method: 'get',
    path: '/api/quality-inspections',
    tag: 'Qualität',
    summary: 'Begehungen auflisten',
    description:
      '**Die Kundschaft liest dieselbe Liste**, eingegrenzt in der `where`-Klausel: nur die ' +
      'eigenen Objekte und Verträge, und nur abgeschlossene — ein Entwurf ist eine ' +
      'Momentaufnahme, keine Feststellung. `internalNote` fehlt in der Auswahl; ein Feld, das ' +
      'nur die Anzeige ausblendet, stünde trotzdem auf der Leitung.',
    guard: perm('any', 'quality:read', 'quality:read_own'),
    rateLimit: 'apiRead',
    query: qualitaet.qualityQuerySchema,
  },
  {
    method: 'post',
    path: '/api/quality-inspections',
    tag: 'Qualität',
    summary: 'Begehung erfassen',
    description:
      'Sie entsteht als **Entwurf**. Die Punktzahl rechnet der Server aus den Positionen; ein ' +
      'mitgeschicktes Ergebnis gibt es im Schema nicht — dieselbe Regel wie beim Preis. Der ' +
      '**Massstab wird eingefroren**: festgehalten wird, welche Vertragsfassung am Tag der ' +
      'Begehung galt und welchen Zielwert sie zusagte. Eine Kontrolle, die nach einer ' +
      'Vertragsänderung anders ausfiele, wäre kein Beleg. Abgewiesen (422): eine Begehung ohne ' +
      'Vertrag **und** ohne Objekt, eine Nachkontrolle zu einem Entwurf, eine zweite ' +
      'Nachkontrolle zu derselben Begehung.',
    guard: perm('all', 'quality:inspect'),
    rateLimit: 'apiWrite',
    body: qualitaet.qualityInspectionCreateSchema,
    status: 201,
  },
  {
    method: 'patch',
    path: '/api/quality-inspections/{id}',
    tag: 'Qualität',
    summary: 'Begehungsentwurf ändern',
    description:
      '**Nur Entwürfe** (422 sonst). Eine abgeschlossene Begehung ist ein Beleg; korrigiert ' +
      'wird über eine Nachkontrolle, nicht durch Überschreiben. Die Positionen werden als ' +
      'Ganzes ersetzt. Verschiebt jemand das Begehungsdatum, verschiebt sich auch der ' +
      'Massstab — sonst trüge die Kontrolle die Zusage eines Tages, an dem sie nicht ' +
      'stattfand.',
    guard: perm('all', 'quality:inspect'),
    rateLimit: 'apiWrite',
    params: idParam,
    body: qualitaet.qualityInspectionUpdateSchema,
  },
  {
    method: 'delete',
    path: '/api/quality-inspections/{id}',
    tag: 'Qualität',
    summary: 'Begehungsentwurf verwerfen',
    description:
      'Nur Entwürfe. Eine abgeschlossene Begehung wird nicht gelöscht — sie ist ein Beleg, und ' +
      'dafür gibt es keine Ausnahme.',
    guard: perm('all', 'quality:inspect'),
    rateLimit: 'apiWrite',
    params: idParam,
  },
  {
    method: 'post',
    path: '/api/quality-inspections/{id}/complete',
    tag: 'Qualität',
    summary: 'Begehung abschliessen',
    description:
      'Ab hier ist sie ein **Beleg**: Nummer aus dem Nummernkreis, Abschlusszeitpunkt, danach ' +
      'weder änderbar noch löschbar. Beides entsteht in *einer* Transaktion mit dem Zustand; ' +
      'die Nummer erst hier, damit ein verworfener Entwurf keine Lücke hinterlässt. Abgewiesen ' +
      '(422): eine Begehung ohne Positionen, und eine, bei der **keine** Position beurteilbar ' +
      'war — die wäre ein Beleg über nichts. Nicht bestanden meldet ans Büro, bestanden nicht.',
    guard: perm('all', 'quality:complete'),
    rateLimit: 'apiWrite',
    params: idParam,
    body: qualitaet.qualityInspectionCompleteSchema,
  },
  {
    method: 'get',
    path: '/api/contracts/{id}/quality',
    tag: 'Qualität',
    summary: 'Qualitätszusage und ihr Stand',
    description:
      'Der Endpunkt, der die drei SLA-Felder der Vertragsfassung endlich **misst**, statt sie ' +
      'nur zu speichern: zugesagter Zielwert, vereinbartes Kontrollintervall, die letzte ' +
      'abgeschlossene Begehung und wann die nächste ansteht. Gerechnet ab der **letzten ' +
      'durchgeführten** Kontrolle, nicht ab dem Vertragsbeginn — wer früher kontrolliert, ' +
      'verschiebt die nächste Frist nach hinten, statt Termine aufzustauen. Ein Entwurf zählt ' +
      'nicht. Ohne vereinbartes Intervall gibt es keine Fälligkeit, ohne zugesagten Zielwert ' +
      'kein Urteil.',
    guard: perm('all', 'quality:read'),
    rateLimit: 'apiRead',
    params: idParam,
  },
];
