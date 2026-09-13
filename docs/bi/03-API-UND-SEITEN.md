# Endpunkte, Dienste und Seiten

---

## 1. Neue Dateien im Überblick

```
src/lib/validation/
  bi-kpi.ts            Kennzahlen, Zielwerte, manuelle Werte
  bi-objectives.ts     Ziele, Schlüsselergebnisse, Check-ins
  bi-finance.ts        Budget, Investitionen, Szenarien
  bi-governance.ts     Risiken, Kontrollen, Massnahmen
  bi-knowledge.ts      Dokumente, Artikel, Wettbewerb, Markt, Analysen, Sitzungen
  bi-reports.ts        Berichtszeitpläne

src/server/services/
  kpi.service.ts           Registry der Rechner, Snapshot-Schreibung
  health.service.ts        Gesundheitswert und Herleitung
  insight.service.ts       Auffälligkeiten aus Snapshots
  objective.service.ts     Ziele, Fortschrittsberechnung
  budget.service.ts        Budget inkl. Ist aus Expense
  investment.service.ts    Investitionen, Abschreibungsplan
  scenario.service.ts      Szenariorechner
  governance.service.ts    Risiken, Kontrollen, Massnahmen
  document.service.ts      Ablage inkl. Sichtbarkeitsfilter
  knowledge.service.ts     Artikel, Wettbewerb, Markt, Analysen
  meeting.service.ts       Sitzungen, Pendenzen als Task
  bi-report.service.ts     Berichtserzeugung

src/app/(app)/admin/fuehrung/…   Seiten (Abschnitt 4)
src/app/api/bi/…                 Endpunkte (Abschnitt 3)
src/features/fuehrung/…          Client-Komponenten der Masken
```

Die Aufteilung folgt der bestehenden: ein Dienst je Fachbereich, ein
Validierungsmodul je Themenblock, Route Handler übersetzen nur HTTP in
Dienstaufrufe.

---

## 2. Wie jeder Endpunkt aussieht

Vorlage. Abweichungen davon sind Fehler, keine Varianten:

```ts
import { defineRoute, searchQuery } from '@/lib/api/handler';
import { buildPagination, created, paginated } from '@/lib/api/response';
import { createObjectiveSchema } from '@/lib/validation/bi-objectives';
import { listObjectives, createObjective } from '@/server/services/objective.service';

export const runtime = 'nodejs';

/** GET /api/bi/objectives — Ziele im Sichtbarkeitsbereich der Rolle. */
export const GET = defineRoute({
  permissions: ['objective:read', 'objective:read_own'],
  anyPermission: true,
  query: objectiveListQuery,
  rateLimit: 'apiRead',
  handler: async ({ query, session }) => {
    const { items, total } = await listObjectives(session, query);
    return paginated(items, buildPagination(query.page, query.pageSize, total));
  },
});

export const POST = defineRoute({
  permissions: ['objective:create'],
  body: createObjectiveSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => created(await createObjective(session, body)),
});
```

Vier Punkte, die dabei zählen:

1. **`anyPermission: true` bei `read` / `read_own`.** Der Dienst bekommt
   `session` und entscheidet über die `where`-Klausel. Die Route entscheidet
   nur, ob überhaupt jemand hereindarf.
2. **`session` geht an den Dienst, nicht nur die Filterwerte.** Ohne sie
   könnte der Dienst nicht einschränken, und die Einschränkung wanderte in
   die Route — dort steht sie beim nächsten Endpunkt nicht mehr.
3. **`rateLimit` immer gesetzt**, `apiRead` bzw. `apiWrite`.
4. **Schemas aus `src/lib/validation/`**, nie inline.

---

## 3. Endpunkte

Spalte „Schutz" ist das, was in `defineRoute` steht und in
`scripts/openapi-routes.ts` als `perm(…)` wiederholt werden muss.

### Phase 1 — Kennzahlen

| Methode | Pfad | Schutz |
| --- | --- | --- |
| GET | `/api/bi/kpis` | `kpi:read` |
| POST | `/api/bi/kpis` | `kpi:manage` |
| GET PATCH DELETE | `/api/bi/kpis/{id}` | `kpi:read` / `kpi:manage` / `kpi:manage` |
| GET | `/api/bi/kpis/{id}/series` | `kpi:read` |
| POST | `/api/bi/kpis/{id}/value` | `kpi:manage` |
| POST | `/api/bi/kpis/{id}/targets` | `kpi:manage` |

`…/series` liefert Snapshots einer Periodenart über einen Zeitraum, inklusive
Zielwert und Vorjahreswert je Punkt. `…/value` trägt einen manuellen Wert ein
und wird bei `source = DERIVED` mit `BusinessRuleError` (422) abgewiesen —
der Vorgang ist im aktuellen Zustand unmöglich, die Eingabe war nicht
fehlerhaft.

### Phase 2 — Cockpit

| Methode | Pfad | Schutz |
| --- | --- | --- |
| GET | `/api/bi/cockpit` | `cockpit:view` |
| GET | `/api/bi/cockpit/health` | `cockpit:view` |
| GET | `/api/bi/cockpit/insights` | `cockpit:view` |

`/api/bi/cockpit` filtert die Finanzkomponenten heraus, wenn die Sitzung
`cockpit:financials` nicht hat — **im Dienst, nicht in der Anzeige.**

### Phase 3 — Ziele

| Methode | Pfad | Schutz |
| --- | --- | --- |
| GET | `/api/bi/objectives` | `objective:read` \| `objective:read_own` |
| POST | `/api/bi/objectives` | `objective:create` |
| GET PATCH DELETE | `/api/bi/objectives/{id}` | read \| read_own / `objective:update` / `objective:delete` |
| GET | `/api/bi/objectives/timeline` | read \| read_own |
| POST | `/api/bi/objectives/{id}/key-results` | `objective:update` |
| PATCH DELETE | `/api/bi/key-results/{id}` | `objective:update` |
| POST | `/api/bi/key-results/{id}/checkin` | `objective:checkin` |
| POST | `/api/bi/objectives/{id}/tasks` | `objective:update`, `task:create` |

`…/timeline` bedient die Roadmap-Ansicht. Sie ist ein eigener Endpunkt, weil
sie andere Felder braucht (Start, Ende, Abhängigkeit, Fortschritt) und die
Listenabfrage sonst für beide Zwecke zu breit würde.

`…/tasks` verlangt **zwei** Rechte — ohne `anyPermission` bedeutet das: beide.
Wer ein Ziel bearbeiten darf, darf deswegen noch nicht Aufgaben anlegen.

### Phase 4 — Finanzplanung

| Methode | Pfad | Schutz |
| --- | --- | --- |
| GET POST | `/api/bi/budgets` | `budget:read` / `budget:create` |
| GET PATCH DELETE | `/api/bi/budgets/{id}` | `budget:read` / `budget:update` / `budget:delete` |
| GET | `/api/bi/budgets/{id}/variance` | `budget:read` |
| POST | `/api/bi/budgets/{id}/approve` | `budget:approve` |
| POST | `/api/bi/budgets/{id}/lines` | `budget:update` |
| PATCH DELETE | `/api/bi/budget-lines/{id}` | `budget:update` |
| GET POST | `/api/bi/investments` | `investment:read` / `investment:create` |
| GET PATCH DELETE | `/api/bi/investments/{id}` | `investment:read` / `investment:update` / `investment:delete` |
| GET | `/api/bi/investments/{id}/depreciation` | `investment:read` |
| GET POST | `/api/bi/scenarios` | `scenario:read` / `scenario:manage` |
| GET PATCH DELETE | `/api/bi/scenarios/{id}` | `scenario:read` / `scenario:manage` / `scenario:manage` |
| POST | `/api/bi/scenarios/{id}/compute` | `scenario:manage` |
| GET | `/api/bi/scenarios/compare` | `scenario:read` |

`…/variance` ist der eigentliche Zweck des Budgetmoduls: Plan, Ist aus
`Expense`, Abweichung absolut und relativ, Hochrechnung aufs Jahresende.

`…/approve` weist ein bereits genehmigtes Budget mit 422 ab und schreibt in
den `AuditLog` — das Einfrieren der Planwerte ist eine Handlung, die später
jemand nachvollziehen können muss.

### Phase 5 — Risiko und Qualität

| Methode | Pfad | Schutz |
| --- | --- | --- |
| GET POST | `/api/bi/risks` | `risk:read` / `risk:create` |
| GET PATCH DELETE | `/api/bi/risks/{id}` | `risk:read` / `risk:update` / `risk:delete` |
| POST | `/api/bi/risks/{id}/review` | `risk:update` |
| GET | `/api/bi/risks/matrix` | `risk:read` |
| GET POST | `/api/bi/controls` | `control:read` / `control:create` |
| GET PATCH DELETE | `/api/bi/controls/{id}` | `control:read` / `control:update` / `control:delete` |
| POST | `/api/bi/controls/{id}/review` | `control:update` |
| GET POST | `/api/bi/actions` | `action:read` / `action:create` |
| PATCH | `/api/bi/actions/{id}` | `action:update` |

`…/review` setzt `lastReviewedAt` auf heute und `nextReviewAt` auf
heute + `reviewIntervalDays`. Beides an **einer** Stelle, sonst driften die
Zyklen zwischen Risiken und Kontrollen auseinander.

### Phase 6 — Wissen und Markt

| Methode | Pfad | Schutz |
| --- | --- | --- |
| GET POST | `/api/bi/documents` | `document:read` \| `document:read_own` / `document:create` |
| GET PATCH DELETE | `/api/bi/documents/{id}` | read \| read_own / `document:update` / `document:delete` |
| POST | `/api/bi/documents/{id}/versions` | `document:create` |
| GET | `/api/bi/documents/{id}/download` | read \| read_own |
| GET POST | `/api/bi/knowledge` | `knowledge:read` / `knowledge:create` |
| GET PATCH DELETE | `/api/bi/knowledge/{id}` | `knowledge:read` / `knowledge:update` / `knowledge:delete` |
| GET POST | `/api/bi/competitors` | `market:read` / `market:manage` |
| PATCH DELETE | `/api/bi/competitors/{id}` | `market:manage` |
| GET POST | `/api/bi/market-insights` | `market:read` / `market:manage` |
| PATCH DELETE | `/api/bi/market-insights/{id}` | `market:manage` |
| GET POST | `/api/bi/analysis` | `market:read` / `market:manage` |
| GET PATCH | `/api/bi/analysis/{id}` | `market:read` / `market:manage` |
| GET POST | `/api/bi/meetings` | `meeting:read` / `meeting:create` |
| GET PATCH DELETE | `/api/bi/meetings/{id}` | `meeting:read` / `meeting:update` / `meeting:delete` |

**`…/documents/{id}/download` ist der wichtigste Endpunkt des Moduls.**
Er muss denselben Sichtbarkeitsfilter benutzen wie Liste und Detailansicht
(`02-BERECHTIGUNGEN.md`, Abschnitt 6.2). Ein `findUnique` nach reiner
Rechteprüfung ist der klassische horizontale Zugriffsfehler: das Recht sagt
„darf Dokumente sehen", nicht „darf *dieses* Dokument sehen". Der Download
liefert eine kurzlebige signierte URL über `src/lib/storage/`, nie den
Speicherpfad.

### Phase 7 — Berichte

| Methode | Pfad | Schutz |
| --- | --- | --- |
| GET POST | `/api/bi/report-schedules` | `bireport:read` / `bireport:manage` |
| PATCH DELETE | `/api/bi/report-schedules/{id}` | `bireport:manage` |
| GET | `/api/bi/reports` | `bireport:read` |
| POST | `/api/bi/reports/generate` | `bireport:manage` |

### KI-Fähigkeiten

**Kein neuer Endpunktbaum.** Die Anwendung hat `/api/ai/*` mit dem Recht
`ai:use` und die Fähigkeiten in `src/lib/ai/features.ts`. Dort kommen dazu:

| Fähigkeit | Eingabe |
| --- | --- |
| `bi.summarizePeriod` | Snapshots eines Zeitraums → Zusammenfassung in Prosa |
| `bi.draftSwot` | Kennzahlen, Wettbewerber, Marktbeobachtungen → SWOT-Entwurf |
| `bi.draftPestel` | Marktbeobachtungen → PESTEL-Entwurf |
| `bi.suggestRisks` | Kennzahlverlauf, offene Massnahmen → Risikovorschläge |
| `bi.explainVariance` | Budgetabweichung → Erklärung in Prosa |
| `bi.meetingMinutes` | Rohnotizen → Protokoll mit Beschlüssen und Pendenzen |
| `bi.quarterlyReview` | Ziele, Check-ins, Snapshots → Quartalsrückblick |

Alle liefern **Entwürfe**. Keine schreibt in `Objective`, `RiskEntry` oder
`BudgetLine`. Die Anwendung zieht dieses Muster schon durch —
`quote-draft`, `blog-draft`, `reply-draft`, `report/draft`. Ein Modell, das
ein Risiko selbst als mitigiert markiert, ist eine Auditfeststellung, keine
Funktion.

Umsatzprognose und Risikovorhersage laufen **nicht** über ein Sprachmodell.
Sie kommen aus `scenario.service.ts` und dem Trend über Snapshots. Ein
Modell, das eine Zahl nennt, nennt eine plausible Zahl — und plausibel ist
hier das Gefährliche.

---

## 4. Seiten

```
src/app/(app)/admin/fuehrung/
  page.tsx                       Cockpit
  kennzahlen/page.tsx            Liste, Verlauf, Vergleich
  kennzahlen/[id]/page.tsx       Detail mit Zielwerten
  ziele/page.tsx                 Baum: Strategie → Ziel → Initiative
  ziele/[id]/page.tsx            Detail, Schlüsselergebnisse, Check-ins
  ziele/neu/page.tsx
  ziele/roadmap/page.tsx         Zeitachse / Kanban / Quartal
  budget/page.tsx                Perioden
  budget/[id]/page.tsx           Zeilen, Plan/Ist/Abweichung
  investitionen/page.tsx
  investitionen/[id]/page.tsx    inkl. Abschreibungsplan
  szenarien/page.tsx             Vergleich Best / Erwartet / Schlecht
  szenarien/[id]/page.tsx        Annahmen und Rechnung
  risiken/page.tsx               Register + Matrix
  risiken/[id]/page.tsx
  qualitaet/page.tsx             Kontrollen nach Art
  qualitaet/[id]/page.tsx
  massnahmen/page.tsx            CAPA quer über alle Quellen
  dokumente/page.tsx             Ablage, Filter, Fristen
  dokumente/[id]/page.tsx        Fassungen
  wissen/page.tsx
  wissen/[slug]/page.tsx
  markt/page.tsx                 Wettbewerb, Beobachtungen, SWOT/PESTEL
  markt/analyse/[id]/page.tsx
  sitzungen/page.tsx
  sitzungen/[id]/page.tsx
  berichte/page.tsx              Zeitpläne und erzeugte Berichte
```

Im Mitarbeiterportal kommt eine Seite dazu:

```
src/app/(app)/portal/ziele/page.tsx    Die eigenen Ziele, objective:read_own
```

### 4.1 Regeln für die Seiten

**Lesen im Server Component.** Listen und Detailseiten fragen Prisma direkt
über den Dienst. React Query nur dort, wo sich etwas während des Zuschauens
ändert — hier praktisch nur die Szenariorechnung, weil sie beim Schieben
einer Annahme neu rechnet.

**Bestehende Bausteine benutzen, keine neuen erfinden.** Es gibt
`components/app/page-parts.tsx`, `data-list.tsx`, `filter-bar.tsx`,
`kpi-tile.tsx`, `sort-header.tsx`, `range-picker.tsx`, `page-skeletons.tsx`
und `charts/dashboard-charts.tsx`. Die Kontaktkarte aus dem letzten Push ist
die visuelle Richtschnur; sie wird nicht angefasst.

`kpi-tile.tsx` deckt die Kacheln des Cockpits bereits ab. Wenn ein Feld fehlt
(Zielwert, Vorjahresvergleich), wird die Komponente erweitert, nicht
daneben eine zweite gebaut.

**Leerzustände sind Pflicht, nicht Kür.** Dieses Modul ist am ersten Tag
überall leer. Ein leeres Risikoregister muss sagen, wozu es da ist und wie
der erste Eintrag entsteht — nicht „Keine Daten".

**Die Roadmap-Ansicht.** Vier Ansichten auf demselben Datenbestand
(Zeitachse, Kanban nach Status, Kalender, Quartalsraster). Die Ansichtswahl
gehört in die URL (`?ansicht=zeitachse`), nicht in den Komponentenzustand:
sonst ist ein Link auf „die Roadmap" nicht teilbar und der Zurück-Knopf
verliert die Ansicht.

---

## 5. `scripts/openapi-routes.ts`

**Jeder neue Endpunkt muss dort eingetragen werden**, mit demselben Schutz,
den die Quelle deklariert. `npm run docs` vergleicht beides und schlägt sonst
fehl — absichtlich: über die Zeit standen dort Rechte wie `job:write`, die
es im Katalog nie gab, und die Doku behauptete einen Schutz, den kein
Endpunkt prüfte.

Form des Eintrags:

```ts
{
  path: '/api/bi/objectives',
  methods: {
    get: { guard: perm('any', 'objective:read', 'objective:read_own'), query: objectiveListQuery, summary: 'Ziele auflisten' },
    post: { guard: perm('all', 'objective:create'), body: createObjectiveSchema, summary: 'Ziel anlegen' },
  },
},
```

`perm()` nimmt nur Namen aus dem Berechtigungskatalog — ein Tippfehler bricht
den Build, statt still einen falschen Schutz zu dokumentieren.

Am Ende jeder Phase:

```bash
npm run openapi   # oder: npm run docs
```

---

## 6. Fehlerbehandlung

`BusinessRuleError` (422) statt `ValidationError` (400) in genau diesen
Fällen — die Eingabe war in Ordnung, der Vorgang ist im aktuellen Zustand
unmöglich:

| Fall | Meldung |
| --- | --- |
| Manueller Wert auf abgeleitete Kennzahl | „Diese Kennzahl wird berechnet und kann nicht von Hand gesetzt werden." |
| Genehmigtes Budget ändern | „Das Budget ist genehmigt. Änderungen erfassen Sie als Nachtrag." |
| Budget zweimal genehmigen | „Dieses Budget wurde bereits genehmigt." |
| Ziel unter eigenen Nachfahren einhängen | „Ein Ziel kann nicht unter sich selbst eingehängt werden." |
| Check-in auf automatisches Schlüsselergebnis | „Dieses Schlüsselergebnis wird aus der Kennzahl berechnet." |
| Szenario ohne Annahmen rechnen | „Für die Rechnung fehlen Annahmen." |
| Investition ohne Nutzungsdauer abschreiben | „Für den Abschreibungsplan fehlt die Nutzungsdauer." |
| Dokumentfassung ohne Datei | „Zu dieser Fassung fehlt die Datei." |

Meldungen sind deutsch und für Menschen; Interna gehören nie hinein.
