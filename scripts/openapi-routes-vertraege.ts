import { z } from 'zod';

import type { Permission } from '../src/lib/auth/permissions';
import * as vertrag from '../src/lib/validation/contracts';
import { idParam } from '../src/lib/validation/queries';

import type { Guard, RouteDoc } from './openapi-routes';

/**
 * Die Endpunkte des Vertragsmoduls (Wave 10) — eigene Datei, wie bei der
 * Unternehmensführung.
 *
 * Diese Registrierung ist **keine Dokumentation neben dem Code**, sondern die
 * Gegenprobe zu ihm: `npm run openapi` vergleicht Pfad, Methode, Schutz und
 * Schemas mit den tatsächlichen Routendateien und schlägt fehl, sobald etwas
 * auseinanderläuft. Ein Endpunkt, der hier lascher steht als in der Route,
 * bricht den Lauf — und umgekehrt.
 */

const perm = (mode: 'all' | 'any', ...permissions: Permission[]): Guard => ({
  kind: 'permissions',
  permissions,
  mode,
});

const versionParams = z.object({ id: z.string().min(1), versionId: z.string().min(1) });
const amendmentParams = z.object({ id: z.string().min(1), amendmentId: z.string().min(1) });
const adjustmentParams = z.object({ id: z.string().min(1), adjustmentId: z.string().min(1) });

export const CONTRACT_ROUTES: RouteDoc[] = [
  {
    method: 'get',
    path: '/api/contracts',
    tag: 'Verträge',
    summary: 'Verträge auflisten',
    description:
      'Filtert nach Zustand, Kundschaft, Suchbegriff sowie nach nahender Kündigungsfrist und ' +
      'nahendem Vertragsende. **Die Einschränkung steht in der `where`-Klausel:** Wer nur ' +
      '`contract:read_own` hat, sieht ausschliesslich die Verträge der eigenen Kundenakte — ' +
      'verstecktes HTML wäre auf der Leitung trotzdem sichtbar.',
    guard: perm('any', 'contract:read', 'contract:read_own'),
    rateLimit: 'apiRead',
    query: vertrag.contractQuerySchema,
  },
  {
    method: 'post',
    path: '/api/contracts',
    tag: 'Verträge',
    summary: 'Vertragsentwurf anlegen',
    description:
      'Der Vertrag entsteht **immer mit seiner ersten Version** — ein Vertrag ohne Konditionen ' +
      'wäre ein Datensatz ohne Inhalt. Nummer und Zustand entstehen nicht hier: Die Nummer ' +
      'wird beim Aktivieren gezogen, damit ein verworfener Entwurf keine Lücke hinterlässt. ' +
      'Mit `quoteId` nur aus einer **angenommenen** Offerte (sonst 422).',
    guard: perm('all', 'contract:create'),
    rateLimit: 'apiWrite',
    body: z.object({
      contract: vertrag.contractCreateSchema,
      version: vertrag.contractVersionSchema,
      services: z.array(vertrag.contractServiceSchema).max(100).optional(),
    }),
    status: 201,
  },
  {
    method: 'get',
    path: '/api/contracts/deadlines',
    tag: 'Verträge',
    summary: 'Fristen, die auf jemanden warten',
    description:
      'Nahende Kündigungsfristen, auslaufende Verträge und fällige Preisüberprüfungen. Der ' +
      'Lauf **erinnert, er handelt nicht**: Verlängern, kündigen und Preise anpassen sind ' +
      'Verpflichtungen über Monate, die ein Mensch trifft.',
    guard: perm('all', 'contract:read'),
    rateLimit: 'apiRead',
    query: z.object({ tage: z.coerce.number().int().min(1).max(365).default(45) }),
  },
  {
    method: 'get',
    path: '/api/contracts/{id}',
    tag: 'Verträge',
    summary: 'Vertragsakte',
    description:
      'Der Vertrag mit allen Versionen, Leistungen, Einsatzplänen, Ausnahmen, ' +
      'Änderungsanträgen und Preisanpassungen — **eine** Abfrage statt sechs. Sechs Abrufe ' +
      'hintereinander wären sechs Momente, in denen sich der Zustand zwischen zwei Antworten ' +
      'ändern kann. Jede Version meldet zusätzlich, wie viele Einsätze an ihr hängen.',
    guard: perm('any', 'contract:read', 'contract:read_own'),
    rateLimit: 'apiRead',
    params: idParam,
  },
  {
    method: 'patch',
    path: '/api/contracts/{id}',
    tag: 'Verträge',
    summary: 'Kopfdaten ändern',
    description:
      'Bezeichnung, Objekt, Betreuung, Kostenstelle, Notizen. **Konditionen sind hier nicht ' +
      'dabei** — auch nicht bei einem Entwurf. Sie stehen an der Version, und zwei Türen zu ' +
      'denselben Feldern wären zwei Stellen, an denen die Versionsregel durchzusetzen wäre. ' +
      'Beginn und Ende fehlen aus demselben Grund: Wer das Ende verschiebt, verlängert den ' +
      'Vertrag.',
    guard: perm('all', 'contract:update'),
    rateLimit: 'apiWrite',
    params: idParam,
    body: vertrag.contractUpdateSchema,
  },
  {
    method: 'delete',
    path: '/api/contracts/{id}',
    tag: 'Verträge',
    summary: 'Entwurf verwerfen',
    description:
      'Weiches Löschen, **nur für Verträge, die nie in Kraft waren** (sonst 422). Ein ' +
      'gelaufener Vertrag ist ein Beleg; er wird beendet, nicht entfernt. Deshalb heisst das ' +
      'Recht `contract:delete_draft` und nicht `contract:delete`.',
    guard: perm('all', 'contract:delete_draft'),
    rateLimit: 'apiWrite',
    params: idParam,
    status: 204,
  },
  {
    method: 'post',
    path: '/api/contracts/{id}/activate',
    tag: 'Verträge',
    summary: 'In Kraft setzen',
    description:
      'Nummer, geltende Version und Zustand entstehen in **einer** Transaktion. Sie ' +
      'auseinanderzuziehen hiesse, einen Moment zuzulassen, in dem ein Vertrag aktiv ist und ' +
      'keine Version hat — und in dem eine Abrechnung mit null rechnet. Ein Vertrag ohne ' +
      'Leistungen wird abgewiesen (422), ebenso jeder Übergang, den der Zustandsautomat nicht ' +
      'kennt. Eigene Berechtigung: Die Betriebsleitung hat sie ausdrücklich nicht.',
    guard: perm('all', 'contract:activate'),
    rateLimit: 'apiWrite',
    params: idParam,
    body: vertrag.contractActivateSchema,
  },
  {
    method: 'post',
    path: '/api/contracts/{id}/pause',
    tag: 'Verträge',
    summary: 'Aussetzen',
    description:
      'Der Vertrag besteht weiter, es wird nur in einem Zeitraum nicht geleistet — ' +
      'Bauarbeiten, Leerstand, Saison. Wirkung hat es beim Serienplaner, der in diesem Fenster ' +
      'keine Einsätze mehr erzeugt.',
    guard: perm('all', 'contract:activate'),
    rateLimit: 'apiWrite',
    params: idParam,
    body: vertrag.contractPauseSchema,
  },
  {
    method: 'post',
    path: '/api/contracts/{id}/resume',
    tag: 'Verträge',
    summary: 'Pause beenden',
    description:
      'Kein Rumpf: Es gibt genau eine mögliche Wirkung. Ein Datum entgegenzunehmen lüde dazu ' +
      'ein, die Pause rückwirkend zu verkürzen — und die Einsätze, die in dieser Zeit nicht ' +
      'erzeugt wurden, entstünden dadurch nicht.',
    guard: perm('all', 'contract:activate'),
    rateLimit: 'apiWrite',
    params: idParam,
  },
  {
    method: 'post',
    path: '/api/contracts/{id}/notice',
    tag: 'Verträge',
    summary: 'Kündigung erfassen',
    description:
      '**Keine Rechtsauskunft.** Festgehalten wird, wer wann gekündigt hat; das Wirkungsdatum ' +
      'ist eine *Rechnung* aus Kündigungsfrist, Laufzeit und Verlängerungsart der geltenden ' +
      'Version und lässt sich überschreiben. Ob die Kündigung wirksam ist, entscheidet dieses ' +
      'System nicht.',
    guard: perm('all', 'contract:terminate'),
    rateLimit: 'apiWrite',
    params: idParam,
    body: vertrag.contractNoticeSchema,
  },
  {
    method: 'post',
    path: '/api/contracts/{id}/end',
    tag: 'Verträge',
    summary: 'Beenden',
    description:
      'Mit dem Ende laufen die Serien aus: Alle Einsatzpläne werden stillgelegt und bekommen ' +
      'ein Enddatum — sonst erzeugte der nächtliche Planer weiter Einsätze für einen beendeten ' +
      'Vertrag. Die Pläne werden **nicht gelöscht**; die Einsätze zeigen weiterhin auf sie. ' +
      '`ENDED` ist ein Endzustand.',
    guard: perm('all', 'contract:terminate'),
    rateLimit: 'apiWrite',
    params: idParam,
    body: z.object({ reason: z.string().trim().max(2000).optional() }),
  },
  {
    method: 'post',
    path: '/api/contracts/{id}/cancel',
    tag: 'Verträge',
    summary: 'Entwurf stornieren',
    description:
      'Behält die Zeile, im Gegensatz zum Löschen. Gedacht für den im Verkauf häufigeren Fall ' +
      '— die Kundschaft springt ab, nachdem der Vertrag schon vorlag. Dass es einen Vertrag ' +
      'gab und woran er scheiterte, ist eine Auskunft; ein gelöschter Entwurf ist keine.',
    guard: perm('all', 'contract:delete_draft'),
    rateLimit: 'apiWrite',
    params: idParam,
    body: z.object({ reason: z.string().trim().max(2000).optional() }),
  },
  {
    method: 'post',
    path: '/api/contracts/{id}/renew',
    tag: 'Verträge',
    summary: 'Laufzeit verlängern',
    description:
      '**Auch die „automatische" Verlängerung läuft hierüber.** Der nächtliche Lauf erinnert; ' +
      'verlängern tut ein Mensch, und wer es tut, gehört ins Protokoll. `renewalType: ' +
      'AUTOMATIC` sagt etwas über den *Vertrag* aus, nicht über den Server. Ein unbefristeter ' +
      'Vertrag wird abgewiesen (422).',
    guard: perm('all', 'contract:activate'),
    rateLimit: 'apiWrite',
    params: idParam,
    body: vertrag.contractRenewSchema,
  },
  {
    method: 'post',
    path: '/api/contracts/{id}/versions',
    tag: 'Verträge',
    summary: 'Neue Vertragsversion anlegen',
    description:
      'Die neue Fassung entsteht als **Entwurf**; in Kraft tritt sie über `/activate`. Ohne ' +
      '`services` wird der Leistungsumfang der geltenden Fassung samt Einsatzplänen ' +
      '**kopiert** — eine Version, die auf die Leistungen ihrer Vorgängerin zeigte, wäre kein ' +
      'eigener Stand, sondern ein Zeiger, und eine spätere Änderung veränderte rückwirkend, ' +
      'was unter der alten Fassung galt. Ein zweiter offener Entwurf wird abgewiesen (422).',
    guard: perm('all', 'contract:version'),
    rateLimit: 'apiWrite',
    params: idParam,
    body: z.object({
      version: vertrag.contractVersionSchema,
      services: z.array(vertrag.contractServiceSchema).max(100).optional(),
    }),
    status: 201,
  },
  {
    method: 'patch',
    path: '/api/contracts/{id}/versions/{versionId}',
    tag: 'Verträge',
    summary: 'Versionsentwurf ändern',
    description:
      '**Nur Entwürfe** (sonst 422). Der Preis eines laufenden Vertrags ist die Grundlage ' +
      'ausgestellter Rechnungen; wer ihn ändern will, legt eine neue Version an. Der Rumpf ' +
      'trägt die vollständigen Konditionen, nicht eine Teilmenge.',
    guard: perm('all', 'contract:version'),
    rateLimit: 'apiWrite',
    params: versionParams,
    body: vertrag.contractVersionSchema,
  },
  {
    method: 'put',
    path: '/api/contracts/{id}/versions/{versionId}/services',
    tag: 'Verträge',
    summary: 'Leistungsumfang setzen',
    description:
      '**`PUT` und als Ganzes** — dieselbe Entscheidung wie bei Qualifikationen und ' +
      'Arbeitszeiten: `PATCH` verspricht eine Teiländerung, und wer das erwartet, schickt eine ' +
      'Position und verliert die anderen. Nur auf einem Entwurf möglich; an den Leistungen ' +
      'einer geltenden Fassung hängen Einsatzpläne und Einsätze.',
    guard: perm('all', 'contract:version'),
    rateLimit: 'apiWrite',
    params: versionParams,
    body: vertrag.contractServicesReplaceSchema,
  },
  {
    method: 'post',
    path: '/api/contracts/{id}/schedule',
    tag: 'Verträge',
    summary: 'Einsätze aus den Serien erzeugen',
    description:
      '**Idempotent, und zwar in der Datenbank:** `@@unique([serviceScheduleId, ' +
      'scheduleDate])`. Der Planer *versucht* anzulegen und wertet einen Verstoss gegen den ' +
      'Index als „war schon da" — eine Prüfung im Code allein reichte nicht, weil zwischen ' +
      '„gibt es schon?" und `INSERT` ein Moment liegt, in den ein zweiter Lauf hineinpasst. ' +
      'Die Kennung ist der **Serientag**, nicht der tatsächliche Termin: Ein wegen eines ' +
      'Feiertags verschobener Einsatz behält ihn, sonst entstünde beim Nachtragen eines ' +
      'Feiertags ein zweiter. Die Antwort zeigt `angelegt` und `uebersprungen`; die zweite ' +
      'Zahl ist der Beweis. `probelauf: true` schreibt nichts.',
    guard: perm('all', 'contract:update'),
    rateLimit: 'apiWrite',
    params: idParam,
    body: vertrag.scheduleGenerateSchema,
  },
  {
    method: 'get',
    path: '/api/contracts/{id}/billing-basis',
    tag: 'Verträge',
    summary: 'Abrechnungsgrundlage einer Periode',
    description:
      '**Rechnet, schreibt nichts** — die Rechnung entsteht über den Rechnungsdienst, damit ' +
      'Nummernkreis und Belegregeln an einer Stelle bleiben. Geliefert wird die Herleitung mit ' +
      'jeder Zwischengrösse; jede Position trägt ihre **Vertragsversion**, weil eine Summe ohne ' +
      'diese Zuordnung bei einem geänderten Vertrag nicht mehr prüfbar ist. Gezählt werden nur ' +
      'abgeschlossene und geprüfte Einsätze, bei Stundenabrechnung nur freigegebene Zeiten.',
    guard: perm('all', 'contract:billing'),
    rateLimit: 'apiRead',
    params: idParam,
    query: z.object({ von: z.coerce.date(), bis: z.coerce.date() }),
  },
  {
    method: 'post',
    path: '/api/contracts/{id}/versions/{versionId}/acceptance',
    tag: 'Verträge',
    summary: 'Vertragsfassung zur elektronischen Annahme schicken',
    description:
      '**Kein zweiter Signaturweg**: Es entsteht ein gewöhnlicher Vorgang des bestehenden ' +
      'Signaturkerns — unveränderlicher Snapshot, Hash A, versionierter Zustimmungstext, ' +
      'Protokoll, Ablauf. Unterzeichnet wird eine **Vertragsfassung**, nie „der Vertrag": Was ' +
      'angenommen wird, sind konkrete Konditionen, und die stehen in der Version. Der Link geht ' +
      'per E-Mail an die Kundschaft, nicht an die auslösende Person — sonst könnte der Betrieb ' +
      'den Vertrag selbst „annehmen". Mehrfaches Auslösen versendet den bestehenden Vorgang ' +
      'erneut (200 statt 201, alter Link verfällt), statt einen zweiten anzulegen; erzwungen ' +
      'durch einen Teilindex. Ab dem Versand ist die Fassung eingefroren. Keine Aussage über QES ' +
      'oder ZertES: Der Vorgang belegt den Hergang, keine geprüfte Identität.',
    guard: perm('all', 'contract:sign'),
    rateLimit: 'apiWrite',
    params: versionParams,
    status: 201,
  },
  {
    method: 'delete',
    path: '/api/contracts/{id}/versions/{versionId}/acceptance',
    tag: 'Verträge',
    summary: 'Annahmevorgang zurückziehen',
    description:
      'Der Weg, den die Einfrierung offenlässt: Wer die Konditionen doch noch ändern will, zieht ' +
      'die Unterzeichnung zurück — sichtbar, protokolliert, mit entwertetem Link. Eine bereits ' +
      'angenommene Fassung lässt sich nicht zurückziehen (422); dafür gibt es die neue Version. ' +
      'Snapshot und Protokoll bleiben erhalten.',
    guard: perm('all', 'contract:sign'),
    rateLimit: 'apiWrite',
    params: versionParams,
  },
  {
    method: 'get',
    path: '/api/contracts/{id}/invoices',
    tag: 'Verträge',
    summary: 'Abrechnungsübersicht des Vertrags',
    description:
      'Welche Perioden fakturiert sind und welche offen — die Frage des Monatsabschlusses. Die ' +
      'Perioden entstehen aus dem Zyklus der geltenden Version, nicht aus den vorhandenen ' +
      'Rechnungen; eine vergessene Periode wäre sonst unsichtbar, weil zu ihr eben kein Beleg ' +
      'existiert. Stornierte Rechnungen zählen nicht als fakturiert.',
    guard: perm('all', 'contract:billing'),
    rateLimit: 'apiRead',
    params: idParam,
    query: vertrag.contractBillingOverviewQuerySchema,
  },
  {
    method: 'post',
    path: '/api/contracts/{id}/invoices',
    tag: 'Verträge',
    summary: 'Rechnung einer Vertragsperiode erzeugen',
    description:
      '**Idempotent.** Ein zweiter Aufruf für dieselbe Periode legt nichts an, sondern gibt die ' +
      'vorhandene Rechnung mit `neu: false` zurück — und antwortet darum mit 200 statt 201. Die ' +
      'Zusicherung steht als Teilindex in der Datenbank (`contractId` + kanonischer ' +
      'Periodenbeginn, ohne stornierte Belege), nicht als Prüfung im Code: Zwischen Lesen und ' +
      'Schreiben liegt ein Moment, in den ein zweiter Klick und zwei gleichzeitige ' +
      'Monatsabschlüsse genau hineinpassen. Kein Zeitraum und kein Betrag werden ' +
      'entgegengenommen — beide ergeben sich aus der geltenden Vertragsversion. Abgewiesen ' +
      '(422): Vertrag ohne geltende Fassung, Vertrag der nie in Kraft war, Periode ohne Betrag.',
    guard: perm('all', 'contract:billing', 'invoice:create'),
    rateLimit: 'apiWrite',
    params: idParam,
    body: vertrag.contractInvoiceSchema,
    status: 201,
  },
  {
    method: 'post',
    path: '/api/contracts/{id}/amendments',
    tag: 'Verträge',
    summary: 'Vertragsänderung beantragen',
    description:
      '**Der Antrag ist nicht die Änderung.** Er durchläuft Prüfung und Freigabe und wird erst ' +
      'dann wirksam, indem er eine neue Version erzeugt. Die Version allein sagt nur, *dass* ' +
      'sich etwas geändert hat — warum, auf wessen Wunsch und mit wessen Zustimmung steht im ' +
      'Antrag. Ein zweiter offener Antrag wird abgewiesen (422).',
    guard: perm('all', 'contract:version'),
    rateLimit: 'apiWrite',
    params: idParam,
    body: vertrag.contractAmendmentCreateSchema,
    status: 201,
  },
  {
    method: 'post',
    path: '/api/contracts/{id}/amendments/{amendmentId}/decision',
    tag: 'Verträge',
    summary: 'Änderungsantrag freigeben oder ablehnen',
    description:
      '**Vier-Augen-Prinzip, zweimal abgesichert:** im Rechteschnitt (`contract:version` hat ' +
      'die Betriebsleitung, `contract:approve` nicht) und im Dienst — wer den Antrag gestellt ' +
      'hat, kann ihn nicht selbst freigeben (422). Der Rechteschnitt allein reichte nicht, weil ' +
      'die Administration beide Rechte hat.',
    guard: perm('all', 'contract:approve'),
    rateLimit: 'apiWrite',
    params: amendmentParams,
    body: vertrag.contractAmendmentDecisionSchema,
  },
  {
    method: 'post',
    path: '/api/contracts/{id}/amendments/{amendmentId}/apply',
    tag: 'Verträge',
    summary: 'Änderungsantrag wirksam machen',
    description:
      'Erzeugt aus dem freigegebenen Antrag eine neue Vertragsversion **im Entwurf**; in Kraft ' +
      'tritt sie über `/activate`. Danach trägt der Antrag beide Versionen — die abgelöste und ' +
      'die neue —, damit „was genau hat sich geändert" beantwortbar bleibt. Der Rumpf trägt ' +
      'die vollständigen neuen Konditionen.',
    guard: perm('all', 'contract:version'),
    rateLimit: 'apiWrite',
    params: amendmentParams,
    body: vertrag.contractAmendmentApplySchema,
    status: 201,
  },
  {
    method: 'post',
    path: '/api/contracts/{id}/price-adjustments',
    tag: 'Verträge',
    summary: 'Preisanpassung vorschlagen',
    description:
      '**Keine Behauptung über Indexierung.** Ob und wie indexiert wird, steht im Vertrag; ' +
      'dieses Modul erfindet keine Regel und ruft keinen Index ab. Eine automatische Erhöhung ' +
      'findet nicht statt. `oldAmount` ist kein Feld der Anfrage — der bisherige Betrag steht ' +
      'in der geltenden Version, und ihn mitschicken zu lassen hiesse, dem Client zu erlauben, ' +
      'die Vergangenheit zu behaupten.',
    guard: perm('all', 'contract:version'),
    rateLimit: 'apiWrite',
    params: idParam,
    body: vertrag.priceAdjustmentCreateSchema,
    status: 201,
  },
  {
    method: 'post',
    path: '/api/contracts/{id}/price-adjustments/{adjustmentId}/decision',
    tag: 'Verträge',
    summary: 'Preisanpassung freigeben oder ablehnen',
    description:
      'Wer vorgeschlagen hat, kann nicht selbst zustimmen (422). Bei einer Preiserhöhung ist ' +
      'das keine Formsache: Sie geht an die Kundschaft hinaus.',
    guard: perm('all', 'contract:approve'),
    rateLimit: 'apiWrite',
    params: adjustmentParams,
    body: vertrag.priceAdjustmentDecisionSchema,
  },
  {
    method: 'post',
    path: '/api/contracts/{id}/price-adjustments/{adjustmentId}/apply',
    tag: 'Verträge',
    summary: 'Preisanpassung wirksam machen',
    description:
      '**Kein Rumpf**, und das ist der Punkt: Die neue Version übernimmt alle Konditionen der ' +
      'geltenden Fassung und ändert genau einen Wert. Ein Rumpf hier lüde ein, „bei der ' +
      'Gelegenheit" noch etwas zu verschieben — dann wäre es keine Preisanpassung mehr.',
    guard: perm('all', 'contract:version'),
    rateLimit: 'apiWrite',
    params: adjustmentParams,
    status: 201,
  },
  {
    method: 'post',
    path: '/api/contract-services/{id}/schedules',
    tag: 'Verträge',
    summary: 'Einsatzplan anlegen',
    description:
      'Mehrere Pläne je Leistung sind der Normalfall: „Büro Mo/Mi/Fr früh" und „Treppenhaus ' +
      'jeden zweiten Dienstag" sind zwei Serien derselben Position. Die Mandantenprüfung läuft ' +
      'über die ganze Kette Leistung → Version → Vertrag → Organisation.',
    guard: perm('all', 'contract:version'),
    rateLimit: 'apiWrite',
    params: idParam,
    body: vertrag.serviceScheduleSchema,
    status: 201,
  },
  {
    method: 'patch',
    path: '/api/contract-schedules/{id}',
    tag: 'Verträge',
    summary: 'Einsatzplan ändern',
    description:
      'Bereits erzeugte Einsätze bleiben unberührt — sie sind disponiert, vielleicht schon ' +
      'angekündigt. Die Änderung wirkt ab dem nächsten Planungslauf und, weil `generatedUntil` ' +
      'stehen bleibt, erst jenseits des bereits geplanten Zeitraums. Wer früher wirken will, ' +
      'verschiebt einzelne Termine über eine Ausnahme.',
    guard: perm('all', 'contract:version'),
    rateLimit: 'apiWrite',
    params: idParam,
    body: vertrag.serviceScheduleSchema,
  },
  {
    method: 'delete',
    path: '/api/contract-schedules/{id}',
    tag: 'Verträge',
    summary: 'Einsatzplan entfernen',
    description:
      'Hängen bereits Einsätze daran, wird der Plan **stillgelegt statt gelöscht** und ' +
      'zurückgegeben (200 statt 204). Sonst verlören die Einsätze ihre Herkunft, und „aus ' +
      'welchem Plan kam dieser Termin" wäre für immer unbeantwortbar.',
    guard: perm('all', 'contract:version'),
    rateLimit: 'apiWrite',
    params: idParam,
  },
  {
    method: 'post',
    path: '/api/contract-schedules/{id}/exceptions',
    tag: 'Verträge',
    summary: 'Einzelnen Termin aussetzen, verschieben oder ansetzen',
    description:
      'Eine Ausnahme ist keine Regeländerung: Wer wegen Betriebsferien einen Termin ' +
      'verschiebt, will nicht den Vertrag ändern — und eine Regeländerung wäre eine neue ' +
      'Vertragsversion. Deshalb `contract:update` und nicht `contract:version`. Eine Ausnahme ' +
      'je Serientag; ein zweiter Eintrag für denselben Tag ersetzt den ersten.',
    guard: perm('all', 'contract:update'),
    rateLimit: 'apiWrite',
    params: idParam,
    body: vertrag.scheduleExceptionSchema,
    status: 201,
  },
];
