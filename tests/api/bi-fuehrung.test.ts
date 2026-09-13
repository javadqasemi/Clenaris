import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { del, get, patch, post, requireServer } from '../helpers/client';
import { loginAll } from '../helpers/accounts';

/**
 * Unternehmensführung über HTTP: Rechtegrenzen, Eigentümerschaft, die
 * fachlichen Regeln (422) und die Rundläufe Ziel → Schlüsselergebnis →
 * Check-in, Budget → Zeile → Genehmigung → Abweichung, Risiko → Massnahme,
 * Szenario → Rechnung, Tafel → Nachfolgerin.
 *
 * Was hier angelegt wird, wird am Ende wieder entfernt.
 */

type Envelope<T> = { data: T };

describe('Unternehmensführung', { concurrency: 1 }, async () => {
  await requireServer();
  const jars = await loginAll();
  const created: { path: string }[] = [];
  const track = (path: string) => created.push({ path });

  after(async () => {
    for (const { path } of created.reverse()) await del(path, { jar: jars.admin });
  });

  describe('Rechtegrenzen', () => {
    it('das Cockpit ist für Geschäfts- und Betriebsleitung offen, für Kundschaft nicht', async () => {
      assert.equal((await get('/api/bi/cockpit', { jar: jars.admin })).status, 200);
      assert.equal((await get('/api/bi/cockpit', { jar: jars.manager })).status, 200);
      assert.equal((await get('/api/bi/cockpit', { jar: jars.employee })).status, 403);
      assert.equal((await get('/api/bi/cockpit', { jar: jars.customer })).status, 403);
    });

    it('die Betriebsleitung sieht im Cockpit keine Finanzgruppe', async () => {
      const admin = await get<Envelope<{ financials: boolean; groups: { name: string }[] }>>('/api/bi/cockpit', { jar: jars.admin });
      const manager = await get<Envelope<{ financials: boolean; groups: { name: string }[] }>>('/api/bi/cockpit', { jar: jars.manager });
      assert.equal(admin.payload.data.financials, true);
      assert.equal(manager.payload.data.financials, false);
      assert.ok(!manager.payload.data.groups.some((g) => g.name === 'Finanzen'), 'Finanzgruppe sichtbar');
    });

    it('Budget, Investitionen, Szenarien und Risiken bleiben der Geschäftsleitung', async () => {
      for (const path of ['/api/bi/budgets', '/api/bi/investments', '/api/bi/scenarios', '/api/bi/risks', '/api/bi/documents']) {
        assert.equal((await get(path, { jar: jars.manager })).status, 403, `${path} für Betriebsleitung offen`);
        assert.equal((await get(path, { jar: jars.customer })).status, 403, `${path} für Kundschaft offen`);
      }
    });

    it('Mitarbeitende dürfen Ziele lesen, aber nicht anlegen', async () => {
      assert.equal((await get('/api/bi/objectives', { jar: jars.employee })).status, 200);
      assert.equal((await post('/api/bi/objectives', { title: 'Unerlaubt' }, { jar: jars.employee })).status, 403);
    });

    it('Mitarbeitende sehen Dokumente nur für alle und die eigene Akte', async () => {
      const response = await get<Envelope<{ visibility: string }[]>>('/api/bi/documents', { jar: jars.employee });
      assert.equal(response.status, 200);
      for (const doc of response.payload.data) {
        assert.ok(['STAFF', 'EMPLOYEE_PRIVATE'].includes(doc.visibility), `Sichtbarkeit ${doc.visibility} für Mitarbeitende`);
      }
    });
  });

  describe('Kennzahlen', () => {
    it('liefert die Startbestückung mit Rechnern', async () => {
      const response = await get<Envelope<{ key: string; hasCalculator: boolean; source: string }[]>>('/api/bi/kpis', { jar: jars.admin });
      assert.equal(response.status, 200);
      assert.ok(response.payload.data.length >= 15, 'Seed fehlt');
      assert.ok(response.payload.data.every((k) => k.hasCalculator), 'Kennzahl ohne Rechner');
    });

    it('weist eine berechnete Kennzahl ohne Rechner ab (422)', async () => {
      const response = await post('/api/bi/kpis', { key: 'test.unbekannt', label: 'Unbekannt', source: 'DERIVED' }, { jar: jars.admin });
      assert.equal(response.status, 422);
    });

    it('legt eine manuelle Kennzahl an, nimmt einen Wert und verhindert verkehrte Schwellen', async () => {
      await del('/api/bi/kpis/__none__', { jar: jars.admin });
      const list = await get<Envelope<{ id: string; key: string }[]>>('/api/bi/kpis?q=test.manuell', { jar: jars.admin });
      for (const old of list.payload.data.filter((k) => k.key === 'test.manuell')) await del(`/api/bi/kpis/${old.id}`, { jar: jars.admin });

      const created = await post<Envelope<{ id: string }>>('/api/bi/kpis', { key: 'test.manuell', label: 'Testkennzahl', group: 'Test', source: 'MANUAL', unit: 'COUNT', targetValue: 100, warnValue: 50 }, { jar: jars.admin });
      assert.equal(created.status, 201);
      const id = created.payload.data.id;
      track(`/api/bi/kpis/${id}`);

      const value = await post(`/api/bi/kpis/${id}/value`, { period: 'MONTH', periodStart: '2026-01-01', value: 42 }, { jar: jars.admin });
      assert.equal(value.status, 201);
      const series = await get<Envelope<{ value: number }[]>>(`/api/bi/kpis/${id}/series?period=MONTH`, { jar: jars.admin });
      assert.equal(series.payload.data[0]?.value, 42);

      const wrong = await patch(`/api/bi/kpis/${id}`, { warnValue: 120 }, { jar: jars.admin });
      assert.equal(wrong.status, 422);
      assert.equal((await patch(`/api/bi/kpis/${id}`, { targetValue: 100 }, { jar: jars.manager })).status, 403);
    });
  });

  describe('Ziele', () => {
    let objectiveId = '';
    let keyResultId = '';

    it('legt ein Ziel mit Schlüsselergebnis an und rechnet den Fortschritt', async () => {
      const objective = await post<Envelope<{ id: string }>>('/api/bi/objectives', { title: 'Prüfziel Annahmequote', horizon: 'OBJECTIVE', level: 'COMPANY', status: 'ACTIVE', fiscalYear: 2026, quarter: 1 }, { jar: jars.admin });
      assert.equal(objective.status, 201);
      objectiveId = objective.payload.data.id;
      track(`/api/bi/objectives/${objectiveId}`);

      const kr = await post<Envelope<{ id: string; progressPct: number }>>(`/api/bi/objectives/${objectiveId}/key-results`, { title: 'Verträge', unit: 'COUNT', startValue: 0, targetValue: 10 }, { jar: jars.admin });
      assert.equal(kr.status, 201);
      assert.equal(kr.payload.data.progressPct, 0);
      keyResultId = kr.payload.data.id;

      const checkin = await post(`/api/bi/key-results/${keyResultId}/checkin`, { value: 4, comment: 'Vier unterschrieben' }, { jar: jars.admin });
      assert.equal(checkin.status, 201);
      const detail = await get<Envelope<{ progressPct: number; keyResults: { progressPct: number }[] }>>(`/api/bi/objectives/${objectiveId}`, { jar: jars.admin });
      assert.equal(detail.payload.data.keyResults[0].progressPct, 40);
      assert.equal(detail.payload.data.progressPct, 40);
    });

    it('Mitarbeitende sehen fremde Bereichsziele nicht (404) und können dort nicht einchecken', async () => {
      const foreign = await post<Envelope<{ id: string }>>('/api/bi/objectives', { title: 'Fremdes Bereichsziel', horizon: 'OBJECTIVE', level: 'DEPARTMENT', status: 'ACTIVE' }, { jar: jars.admin });
      track(`/api/bi/objectives/${foreign.payload.data.id}`);
      assert.equal((await get(`/api/bi/objectives/${foreign.payload.data.id}`, { jar: jars.employee })).status, 404);
      // Das Firmenziel ist lesbar, das Check-in gehört aber der verantwortlichen Person.
      assert.equal((await get(`/api/bi/objectives/${objectiveId}`, { jar: jars.employee })).status, 200);
      assert.equal((await post(`/api/bi/key-results/${keyResultId}/checkin`, { value: 9 }, { jar: jars.employee })).status, 404);
    });

    it('ein Ziel kann nicht sein eigenes übergeordnetes Ziel sein', async () => {
      assert.equal((await patch(`/api/bi/objectives/${objectiveId}`, { parentId: objectiveId }, { jar: jars.admin })).status, 422);
    });

    it('dupliziert und erscheint auf der Zeitachse', async () => {
      const copy = await post<Envelope<{ id: string; title: string }>>(`/api/bi/objectives/${objectiveId}/duplicate`, undefined, { jar: jars.admin });
      assert.equal(copy.status, 201);
      assert.ok(copy.payload.data.title.endsWith('(Kopie)'));
      track(`/api/bi/objectives/${copy.payload.data.id}`);
      const timeline = await get<Envelope<{ id: string }[]>>('/api/bi/objectives/timeline', { jar: jars.admin });
      assert.ok(timeline.payload.data.some((o) => o.id === objectiveId));
    });
  });

  describe('Budget', () => {
    it('Zeile, Genehmigung, Einfrieren, Abweichung', async () => {
      const list = await get<Envelope<{ id: string; name: string }[]>>('/api/bi/budgets', { jar: jars.admin });
      for (const old of list.payload.data.filter((b) => b.name === 'Prüfbudget')) await del(`/api/bi/budgets/${old.id}`, { jar: jars.admin });

      const budget = await post<Envelope<{ id: string }>>('/api/bi/budgets', { name: 'Prüfbudget', fiscalYear: 2031, startsOn: '2031-01-01', endsOn: '2031-12-31' }, { jar: jars.admin });
      assert.equal(budget.status, 201);
      const id = budget.payload.data.id;

      assert.equal((await post(`/api/bi/budgets/${id}/approve`, undefined, { jar: jars.admin })).status, 422, 'ohne Zeilen genehmigt');

      const line = await post<Envelope<{ id: string }>>(`/api/bi/budgets/${id}/lines`, { category: 'MARKETING', label: 'Anzeigen', plannedAmount: 12000 }, { jar: jars.admin });
      assert.equal(line.status, 201);

      const variance = await get<Envelope<{ lines: { plan: number; planToDate: number }[]; elapsedMonths: number }>>(`/api/bi/budgets/${id}/variance`, { jar: jars.admin });
      assert.equal(variance.status, 200);
      assert.equal(variance.payload.data.lines[0].plan, 12000);
      assert.equal(variance.payload.data.elapsedMonths, 0);

      assert.equal((await post(`/api/bi/budgets/${id}/approve`, undefined, { jar: jars.manager })).status, 403);
      assert.equal((await post(`/api/bi/budgets/${id}/approve`, undefined, { jar: jars.admin })).status, 200);
      assert.equal((await patch(`/api/bi/budget-lines/${line.payload.data.id}`, { plannedAmount: 15000 }, { jar: jars.admin })).status, 422, 'Plan nach Genehmigung änderbar');
      assert.equal((await patch(`/api/bi/budget-lines/${line.payload.data.id}`, { revisedAmount: 15000 }, { jar: jars.admin })).status, 200);
      assert.equal((await del(`/api/bi/budgets/${id}`, { jar: jars.admin })).status, 422, 'genehmigtes Budget löschbar');

      // Aufräumen: abschliessen ist erlaubt, löschen nicht — deshalb direkt über den Entwurfsweg nicht möglich.
      assert.equal((await post(`/api/bi/budgets/${id}/close`, undefined, { jar: jars.admin })).status, 200);
    });
  });

  describe('Investitionen und Szenarien', () => {
    it('Investition mit Abschreibungsplan; degressiv braucht einen Restwert', async () => {
      assert.equal((await post('/api/bi/investments', { name: 'Prüfmaschine', purchaseAmount: 6000, method: 'DECLINING', usefulLifeYears: 5, residualValue: 0 }, { jar: jars.admin })).status, 422);
      const investment = await post<Envelope<{ id: string }>>('/api/bi/investments', { name: 'Prüfmaschine', purchaseAmount: 24000, method: 'STRAIGHT_LINE', usefulLifeYears: 4, residualValue: 0, status: 'ACTIVE', commissionedOn: '2025-01-01' }, { jar: jars.admin });
      assert.equal(investment.status, 201);
      track(`/api/bi/investments/${investment.payload.data.id}`);
      const plan = await get<Envelope<{ schedule: { year: number; bookValue: number }[] }>>(`/api/bi/investments/${investment.payload.data.id}/depreciation`, { jar: jars.admin });
      assert.equal(plan.payload.data.schedule.length, 4);
      assert.equal(plan.payload.data.schedule[1].bookValue, 12000);
    });

    it('Szenario wird vorbelegt, gerechnet und verglichen', async () => {
      const scenario = await post<Envelope<{ id: string }>>('/api/bi/scenarios', { name: 'Prüfszenario', kind: 'EXPECTED', fiscalYear: 2031, horizonMonths: 6 }, { jar: jars.admin });
      assert.equal(scenario.status, 201);
      const id = scenario.payload.data.id;
      track(`/api/bi/scenarios/${id}`);
      const detail = await get<Envelope<{ assumptions: unknown[]; result: { months: unknown[] } | null }>>(`/api/bi/scenarios/${id}`, { jar: jars.admin });
      assert.ok(detail.payload.data.assumptions.length >= 8, 'nicht vorbelegt');
      assert.equal(detail.payload.data.result?.months.length, 6);
      const compare = await get<Envelope<{ id: string; totals: { revenue: number } }[]>>('/api/bi/scenarios/compare?fiscalYear=2031', { jar: jars.admin });
      assert.ok(compare.payload.data.some((s) => s.id === id));
    });
  });

  describe('Risiko, Kontrolle, Massnahme', () => {
    it('Schwere wird gerechnet, Prüfung verschiebt den Termin, Massnahme wird Aufgabe', async () => {
      const risk = await post<Envelope<{ id: string; severity: number }>>('/api/bi/risks', { title: 'Prüfrisiko', probability: 4, impact: 4 }, { jar: jars.admin });
      assert.equal(risk.status, 201);
      assert.equal(risk.payload.data.severity, 16);
      track(`/api/bi/risks/${risk.payload.data.id}`);

      const review = await post<Envelope<{ severity: number; nextReviewAt: string }>>(`/api/bi/risks/${risk.payload.data.id}/review`, { note: 'Geprüft', probability: 2 }, { jar: jars.admin });
      assert.equal(review.status, 200);
      assert.equal(review.payload.data.severity, 8);
      assert.ok(new Date(review.payload.data.nextReviewAt).getTime() > Date.now() + 80 * 86_400_000);

      const action = await post<Envelope<{ id: string; taskId: string | null }>>('/api/bi/actions', { title: 'Prüfmassnahme', riskId: risk.payload.data.id, assigneeId: undefined }, { jar: jars.admin });
      assert.equal(action.status, 201);
      assert.equal((await patch(`/api/bi/actions/${action.payload.data.id}`, { effectivenessChecked: true }, { jar: jars.admin })).status, 422, 'Wirksamkeit vor Abschluss');
      assert.equal((await patch(`/api/bi/actions/${action.payload.data.id}`, { completed: true }, { jar: jars.admin })).status, 200);
      assert.equal((await patch(`/api/bi/actions/${action.payload.data.id}`, { effectivenessChecked: true, effectivenessNote: 'Bestätigt' }, { jar: jars.admin })).status, 200);
      assert.equal((await post('/api/bi/actions', { title: 'Ohne Bezug' }, { jar: jars.admin })).status, 422);
    });

    it('Betriebsleitung liest Kontrollen, legt aber keine an', async () => {
      assert.equal((await get('/api/bi/controls', { jar: jars.manager })).status, 200);
      assert.equal((await post('/api/bi/controls', { title: 'Unerlaubt' }, { jar: jars.manager })).status, 403);
      const control = await post<Envelope<{ id: string }>>('/api/bi/controls', { title: 'Prüfkontrolle', kind: 'SOP', status: 'ACTIVE' }, { jar: jars.admin });
      assert.equal(control.status, 201);
      track(`/api/bi/controls/${control.payload.data.id}`);
      const review = await post<Envelope<{ status: string }>>(`/api/bi/controls/${control.payload.data.id}/review`, { outcome: 'NON_COMPLIANT', note: 'Abweichung' }, { jar: jars.admin });
      assert.equal(review.payload.data.status, 'NON_COMPLIANT');
    });
  });

  describe('Wissen, Markt, Sitzungen', () => {
    it('Personaldokument ohne Person wird abgewiesen; Sichtbarkeit fällt auf EMPLOYEE_PRIVATE', async () => {
      assert.equal((await post('/api/bi/documents', { title: 'Arbeitsvertrag', category: 'EMPLOYEE' }, { jar: jars.admin })).status, 422);
      const doc = await post<Envelope<{ id: string; visibility: string }>>('/api/bi/documents', { title: 'Prüfpolice', category: 'INSURANCE' }, { jar: jars.admin });
      assert.equal(doc.status, 201);
      assert.equal(doc.payload.data.visibility, 'MANAGEMENT');
      track(`/api/bi/documents/${doc.payload.data.id}`);
      // Mitarbeitende dürfen die Ablage lesen (nur ihren Teil) → 404 für ein
      // Geschäftsleitungsdokument; die Betriebsleitung hat gar kein Leserecht → 403.
      assert.equal((await get(`/api/bi/documents/${doc.payload.data.id}`, { jar: jars.employee })).status, 404);
      assert.equal((await get(`/api/bi/documents/${doc.payload.data.id}`, { jar: jars.manager })).status, 403);
    });

    it('SWOT-Tafel weist PESTEL-Felder ab und lässt sich ablösen', async () => {
      // Schemafehler antworten in dieser Anwendung mit 422 (`toErrorResponse` für ZodError).
      assert.equal((await post('/api/bi/analysis', { kind: 'SWOT', title: 'Falsch', preparedOn: '2026-01-01', entries: [{ bucket: 'POLITICAL', title: 'x' }] }, { jar: jars.admin })).status, 422);
      const board = await post<Envelope<{ id: string }>>('/api/bi/analysis', { kind: 'SWOT', title: 'Prüftafel', preparedOn: '2026-01-01', entries: [{ bucket: 'STRENGTH', title: 'Online-Buchung', weight: 5 }] }, { jar: jars.admin });
      assert.equal(board.status, 201);
      track(`/api/bi/analysis/${board.payload.data.id}`);
      const successor = await post<Envelope<{ id: string }>>('/api/bi/analysis', { kind: 'SWOT', title: 'Prüftafel II', preparedOn: '2026-06-01', supersedesId: board.payload.data.id }, { jar: jars.admin });
      assert.equal(successor.status, 201);
      track(`/api/bi/analysis/${successor.payload.data.id}`);
      assert.equal((await patch(`/api/bi/analysis/${board.payload.data.id}`, { title: 'Nachträglich' }, { jar: jars.admin })).status, 422, 'abgelöste Fassung änderbar');
    });

    it('Sitzung mit Pendenz erzeugt eine Aufgabe; Betriebsleitung darf Sitzungen anlegen', async () => {
      const meeting = await post<Envelope<{ id: string }>>('/api/bi/meetings', { title: 'Prüfsitzung', heldAt: new Date().toISOString(), actionItems: [{ title: 'Prüfpendenz erledigen' }] }, { jar: jars.manager });
      assert.equal(meeting.status, 201);
      track(`/api/bi/meetings/${meeting.payload.data.id}`);
      const detail = await get<Envelope<{ tasks: { title: string }[] }>>(`/api/bi/meetings/${meeting.payload.data.id}`, { jar: jars.manager });
      assert.equal(detail.payload.data.tasks.length, 1);
    });

    it('Wissensartikel: Entwürfe bleiben Mitarbeitenden verborgen', async () => {
      const article = await post<Envelope<{ id: string; slug: string }>>('/api/bi/knowledge', { title: 'Prüfartikel Entwurf', body: 'Ein Entwurf mit genügend Text für die Prüfung.', status: 'DRAFT' }, { jar: jars.admin });
      assert.equal(article.status, 201);
      track(`/api/bi/knowledge/${article.payload.data.id}`);
      assert.equal((await get(`/api/bi/knowledge/${article.payload.data.id}`, { jar: jars.employee })).status, 404);
      assert.equal((await get(`/api/bi/knowledge/${article.payload.data.id}`, { jar: jars.admin })).status, 200);
    });
  });

  describe('Berichte', () => {
    it('erzeugt einen PDF-Bericht und lädt ihn über den protokollierten Weg', async () => {
      const run = await post<Envelope<{ id: string; status: string }>>('/api/bi/reports/generate', { kind: 'BUSINESS_PERFORMANCE', format: 'PDF', periodStart: '2026-01-01', periodEnd: '2026-03-31' }, { jar: jars.admin });
      assert.equal(run.status, 201);
      assert.equal(run.payload.data.status, 'READY');
      const download = await get(`/api/bi/reports/${run.payload.data.id}/download`, { jar: jars.admin });
      assert.ok([302, 307].includes(download.status), `HTTP ${download.status}`);
      assert.equal((await get(`/api/bi/reports/${run.payload.data.id}/download`, { jar: jars.manager })).status, 403);
    });

    it('erzeugt Excel und Word', async () => {
      for (const format of ['XLSX', 'DOCX']) {
        const run = await post<Envelope<{ status: string }>>('/api/bi/reports/generate', { kind: 'FINANCIAL', format, periodStart: '2026-01-01', periodEnd: '2026-01-31' }, { jar: jars.admin });
        assert.equal(run.status, 201, format);
        assert.equal(run.payload.data.status, 'READY', format);
      }
    });

    it('Zeitplan mit nächstem Lauf', async () => {
      const schedule = await post<Envelope<{ id: string; nextRunAt: string }>>('/api/bi/report-schedules', { name: 'Prüfzeitplan', cadence: 'MONTHLY', runOnDay: 1 }, { jar: jars.admin });
      assert.equal(schedule.status, 201);
      track(`/api/bi/report-schedules/${schedule.payload.data.id}`);
      assert.ok(new Date(schedule.payload.data.nextRunAt).getTime() > Date.now());
    });
  });

  describe('Assistent', () => {
    it('antwortet mit 503 ohne Schlüssel oder mit einem Entwurf samt Vertrauensgrad', async () => {
      const response = await post<Envelope<{ confidence: string; reasoning: string; dataSources: string[] }>>('/api/bi/assistant', { kind: 'draftPestel' }, { jar: jars.admin });
      if (response.status === 503) return;
      assert.equal(response.status, 200);
      assert.ok(['niedrig', 'mittel', 'hoch'].includes(response.payload.data.confidence));
      assert.ok(response.payload.data.reasoning.length > 0);
      assert.ok(Array.isArray(response.payload.data.dataSources));
    });

    it('bleibt Mitarbeitenden verschlossen', async () => {
      assert.equal((await post('/api/bi/assistant', { kind: 'draftSwot' }, { jar: jars.employee })).status, 403);
    });
  });
});
