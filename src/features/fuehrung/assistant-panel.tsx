'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { ANALYSIS_BUCKET_LABELS, RISK_CATEGORY_LABELS } from '@/lib/bi/labels';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import { Alert } from '@/components/ui/primitives';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/controls';
import { DetailSection } from '@/components/app/page-parts';

/**
 * Der Führungsassistent.
 *
 * Jede Antwort zeigt drei Dinge über dem Inhalt: Begründung, Datenquellen,
 * Vertrauensgrad. Das ist kein Beiwerk — ohne die drei ist eine Empfehlung
 * eine Meinung, mit ihnen ist sie prüfbar. „Übernehmen" legt einen Entwurf an
 * (Tafel, Risiko), nie mehr; die Person entscheidet.
 */

const CAPABILITIES = [
  { value: 'summarizePeriod', label: 'Zeitraum zusammenfassen', hint: 'Kennzahlen, Auffälligkeiten, Empfehlungen — mit optionaler Frage.' },
  { value: 'quarterlyReview', label: 'Quartalsrückblick', hint: 'Erreichtes, Verfehltes, Lehren, Schwerpunkte.' },
  { value: 'draftSwot', label: 'SWOT-Entwurf', hint: 'Aus Kennzahlen, Wettbewerbern und Markt.' },
  { value: 'draftPestel', label: 'PESTEL-Entwurf', hint: 'Aus den Marktbeobachtungen.' },
  { value: 'suggestRisks', label: 'Risiken vorschlagen', hint: 'Was fehlt im Register?' },
  { value: 'explainVariance', label: 'Budgetabweichung erklären', hint: 'Je Zeile eine Ursache und Massnahme.' },
  { value: 'analyzeFeedback', label: 'Kundenfeedback auswerten', hint: 'Themen und Stimmung aus Bewertungen, anonymisiert.' },
  { value: 'marketingIdeas', label: 'Marketingvorschläge', hint: 'Aus Leadquellen, Konversion und Wettbewerb.' },
  { value: 'meetingMinutes', label: 'Protokoll aus Notizen', hint: 'Rohnotizen werden Traktanden, Beschlüsse, Pendenzen.' },
] as const;

type Capability = (typeof CAPABILITIES)[number]['value'];

interface Envelope {
  kind: string;
  summary: string;
  reasoning: string;
  dataSources: string[];
  confidence: 'niedrig' | 'mittel' | 'hoch';
  confidenceNote: string;
  [key: string]: unknown;
}

const CONFIDENCE_VARIANT: Record<string, 'success' | 'warning' | 'destructive'> = { hoch: 'success', mittel: 'warning', niedrig: 'destructive' };

function monthsAgo(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}

export function AssistantPanel({
  configured,
  budgets,
  defaultKind = 'summarizePeriod',
  compact = false,
}: {
  configured: boolean;
  budgets: { id: string; name: string }[];
  defaultKind?: Capability;
  compact?: boolean;
}) {
  const router = useRouter();
  const [kind, setKind] = React.useState<Capability>(defaultKind);
  const [from, setFrom] = React.useState(monthsAgo(3));
  const [to, setTo] = React.useState(new Date().toISOString().slice(0, 10));
  const [question, setQuestion] = React.useState('');
  const [budgetId, setBudgetId] = React.useState(budgets[0]?.id ?? '');
  const [notes, setNotes] = React.useState('');
  const [year, setYear] = React.useState(String(new Date().getFullYear()));
  const [quarter, setQuarter] = React.useState(String(Math.floor(new Date().getMonth() / 3) + 1));
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<Envelope | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const body: Record<string, unknown> = { kind };
      if (kind === 'summarizePeriod') Object.assign(body, { from, to, question: question || undefined });
      if (kind === 'analyzeFeedback') Object.assign(body, { from, to });
      if (kind === 'explainVariance') Object.assign(body, { budgetId });
      if (kind === 'meetingMinutes') Object.assign(body, { notes });
      if (kind === 'quarterlyReview') Object.assign(body, { fiscalYear: Number(year), quarter: Number(quarter) });
      setResult(await api.post<Envelope>('/api/bi/assistant', body));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Der Assistent hat nicht geantwortet.');
    } finally {
      setBusy(false);
    }
  };

  const adoptBoard = async () => {
    if (!result) return;
    const entries = (result.entries as { bucket: string; title: string; detail: string; weight: number }[]).map((e, i) => ({ ...e, sortOrder: i }));
    try {
      const created = await api.post<{ id: string }>('/api/bi/analysis', {
        kind: kind === 'draftSwot' ? 'SWOT' : 'PESTEL',
        title: `${kind === 'draftSwot' ? 'SWOT' : 'PESTEL'}-Entwurf ${new Date().toLocaleDateString('de-CH')}`,
        preparedOn: new Date().toISOString().slice(0, 10),
        summary: result.summary,
        entries,
      });
      toast.success('Tafel als Entwurf angelegt.');
      router.push(`/admin/fuehrung/markt/analyse/${created.id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Anlegen fehlgeschlagen.');
    }
  };

  const adoptRisk = async (risk: { title: string; category: string; probability: number; impact: number; description: string; mitigation: string }) => {
    try {
      await api.post('/api/bi/risks', { title: risk.title, category: risk.category, probability: risk.probability, impact: risk.impact, description: risk.description, mitigationPlan: risk.mitigation, status: 'IDENTIFIED' });
      toast.success(`Risiko „${risk.title}" erfasst.`);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Erfassen fehlgeschlagen.');
    }
  };

  const capability = CAPABILITIES.find((c) => c.value === kind)!;

  return (
    <DetailSection
      title="Führungsassistent"
      description="Entwürfe mit Begründung, Datenquelle und Vertrauensgrad. Übernommen wird nur, was Sie ausdrücklich anlegen."
      body="form"
    >
      {!configured ? (
        <Alert variant="warning" title="KI ist nicht konfiguriert">
          Hinterlegen Sie <code className="text-xs">ANTHROPIC_API_KEY</code>, damit der Assistent arbeitet. Alle übrigen Funktionen laufen unabhängig davon.
        </Alert>
      ) : null}

      <div className={cn('grid gap-4', compact ? '' : 'sm:grid-cols-2')}>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="assistant-kind">Was soll entstehen?</Label>
          <Select value={kind} onValueChange={(v) => setKind(v as Capability)}>
            <SelectTrigger id="assistant-kind"><SelectValue /></SelectTrigger>
            <SelectContent>{CAPABILITIES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
          </Select>
          <p className="text-meta text-muted-foreground">{capability.hint}</p>
        </div>

        {kind === 'summarizePeriod' || kind === 'analyzeFeedback' ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="assistant-from">Von</Label>
              <Input id="assistant-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="assistant-to">Bis</Label>
              <Input id="assistant-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </>
        ) : null}
        {kind === 'summarizePeriod' ? (
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="assistant-question">Frage (optional)</Label>
            <Input id="assistant-question" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Warum ist die Marge gesunken?" />
          </div>
        ) : null}
        {kind === 'quarterlyReview' ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="assistant-year">Jahr</Label>
              <Input id="assistant-year" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="assistant-quarter">Quartal</Label>
              <Select value={quarter} onValueChange={setQuarter}>
                <SelectTrigger id="assistant-quarter"><SelectValue /></SelectTrigger>
                <SelectContent>{['1', '2', '3', '4'].map((q) => <SelectItem key={q} value={q}>Q{q}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </>
        ) : null}
        {kind === 'explainVariance' ? (
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="assistant-budget">Budget</Label>
            <Select value={budgetId} onValueChange={setBudgetId}>
              <SelectTrigger id="assistant-budget"><SelectValue placeholder="Budget wählen" /></SelectTrigger>
              <SelectContent>{budgets.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        ) : null}
        {kind === 'meetingMinutes' ? (
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="assistant-notes" required>Rohnotizen</Label>
            <Textarea id="assistant-notes" rows={6} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Stichworte aus der Sitzung …" />
          </div>
        ) : null}
      </div>

      <div className="flex justify-end">
        <Button onClick={run} loading={busy} disabled={!configured || (kind === 'meetingMinutes' && notes.trim().length < 20) || (kind === 'explainVariance' && !budgetId)}>
          <Sparkles aria-hidden />
          Entwurf erstellen
        </Button>
      </div>

      {error ? <Alert variant="destructive">{error}</Alert> : null}

      {result ? (
        <div className="space-y-5 rounded-2xl border border-border bg-muted/30 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={CONFIDENCE_VARIANT[result.confidence] ?? 'neutral'}>Vertrauen: {result.confidence}</Badge>
            <span className="text-sm text-muted-foreground">{result.confidenceNote}</span>
          </div>
          <p className="prose-measure leading-relaxed">{result.summary}</p>

          <ResultBody result={result} onAdoptBoard={adoptBoard} onAdoptRisk={adoptRisk} />

          <dl className="grid gap-3 border-t border-border pt-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="font-medium">Begründung</dt>
              <dd className="mt-1 leading-relaxed text-muted-foreground">{result.reasoning}</dd>
            </div>
            <div>
              <dt className="font-medium">Datenquellen</dt>
              <dd className="mt-1">
                <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">{result.dataSources.map((s, i) => <li key={i}>{s}</li>)}</ul>
              </dd>
            </div>
          </dl>
        </div>
      ) : null}
    </DetailSection>
  );
}

function ResultBody({ result, onAdoptBoard, onAdoptRisk }: { result: Envelope; onAdoptBoard: () => void; onAdoptRisk: (r: never) => void }) {
  const list = (title: string, items: unknown) =>
    Array.isArray(items) && items.length ? (
      <div>
        <h4 className="text-sm font-semibold">{title}</h4>
        <ul className="mt-1 list-disc space-y-1 pl-4 text-sm">{(items as string[]).map((x, i) => <li key={i}>{x}</li>)}</ul>
      </div>
    ) : null;

  switch (result.kind) {
    case 'summarizePeriod': {
      const findings = result.findings as { title: string; detail: string; severity: string }[];
      const recs = result.recommendations as { action: string; rationale: string; area: string }[];
      return (
        <div className="grid gap-5 sm:grid-cols-2">
          {result.answer ? <p className="sm:col-span-2 rounded-xl bg-card p-4 text-sm leading-relaxed"><strong>Antwort:</strong> {String(result.answer)}</p> : null}
          <div>
            <h4 className="text-sm font-semibold">Feststellungen</h4>
            <ul className="mt-1 space-y-2 text-sm">{findings.map((f, i) => <li key={i}><Badge size="sm" variant={f.severity === 'kritisch' ? 'destructive' : f.severity === 'warnung' ? 'warning' : 'neutral'}>{f.severity}</Badge> <strong>{f.title}</strong> — {f.detail}</li>)}</ul>
          </div>
          <div>
            <h4 className="text-sm font-semibold">Empfehlungen</h4>
            <ul className="mt-1 space-y-2 text-sm">{recs.map((r, i) => <li key={i}><Badge size="sm" variant="outline">{r.area}</Badge> <strong>{r.action}</strong> — {r.rationale}</li>)}</ul>
          </div>
        </div>
      );
    }
    case 'draftSwot':
    case 'draftPestel': {
      const entries = result.entries as { bucket: string; title: string; detail: string; weight: number }[];
      const buckets = [...new Set(entries.map((e) => e.bucket))];
      return (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {buckets.map((b) => (
              <div key={b} className="rounded-xl bg-card p-3">
                <h4 className="text-sm font-semibold">{ANALYSIS_BUCKET_LABELS[b] ?? b}</h4>
                <ul className="mt-1 space-y-1 text-sm">{entries.filter((e) => e.bucket === b).map((e, i) => <li key={i}><strong>{e.title}</strong> <span className="text-xs text-muted-foreground">({e.weight})</span> — {e.detail}</li>)}</ul>
              </div>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={onAdoptBoard}>Als Tafel-Entwurf anlegen</Button>
        </div>
      );
    }
    case 'suggestRisks': {
      const risks = result.risks as { title: string; category: string; probability: number; impact: number; description: string; mitigation: string }[];
      return (
        <ul className="space-y-3">
          {risks.map((r, i) => (
            <li key={i} className="flex flex-wrap items-start justify-between gap-3 rounded-xl bg-card p-3 text-sm">
              <div className="min-w-0 space-y-1">
                <p><strong>{r.title}</strong> <Badge size="sm" variant="neutral">{RISK_CATEGORY_LABELS[r.category] ?? r.category}</Badge> <span className="text-xs text-muted-foreground">W{r.probability} × A{r.impact}</span></p>
                <p className="text-muted-foreground">{r.description}</p>
                <p><span className="font-medium">Massnahme:</span> {r.mitigation}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => onAdoptRisk(r as never)}>Ins Register</Button>
            </li>
          ))}
        </ul>
      );
    }
    case 'explainVariance': {
      const lines = result.lines as { label: string; explanation: string; action: string | null }[];
      return <ul className="space-y-2 text-sm">{lines.map((l, i) => <li key={i} className="rounded-xl bg-card p-3"><strong>{l.label}</strong> — {l.explanation}{l.action ? <span className="block text-muted-foreground">Massnahme: {l.action}</span> : null}</li>)}</ul>;
    }
    case 'meetingMinutes': {
      const items = result.actionItems as { title: string; assignee: string | null; dueHint: string | null }[];
      return (
        <div className="space-y-3 text-sm">
          <div><h4 className="font-semibold">Traktanden</h4><p className="whitespace-pre-wrap">{String(result.agenda)}</p></div>
          <div><h4 className="font-semibold">Protokoll</h4><p className="whitespace-pre-wrap">{String(result.minutes)}</p></div>
          <div><h4 className="font-semibold">Beschlüsse</h4><p className="whitespace-pre-wrap">{String(result.decisions)}</p></div>
          <div><h4 className="font-semibold">Pendenzen</h4><ul className="list-disc pl-4">{items.map((a, i) => <li key={i}>{a.title}{a.assignee ? ` — ${a.assignee}` : ''}{a.dueHint ? ` (${a.dueHint})` : ''}</li>)}</ul></div>
          <p className="text-muted-foreground">Kopieren Sie den Entwurf in die Sitzung — er wird nicht automatisch gespeichert.</p>
        </div>
      );
    }
    case 'quarterlyReview':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          {list('Erreicht', result.achievements)}
          {list('Verfehlt', result.misses)}
          {list('Lehren', result.lessons)}
          {list('Schwerpunkte nächstes Quartal', result.nextQuarterFocus)}
        </div>
      );
    case 'analyzeFeedback': {
      const themes = result.themes as { theme: string; sentiment: string; count: number; example: string }[];
      return (
        <div className="space-y-4">
          <ul className="space-y-2 text-sm">{themes.map((t, i) => <li key={i}><Badge size="sm" variant={t.sentiment === 'positiv' ? 'success' : t.sentiment === 'negativ' ? 'destructive' : 'neutral'}>{t.sentiment}</Badge> <strong>{t.theme}</strong> ({t.count}) — <span className="text-muted-foreground">{t.example}</span></li>)}</ul>
          {list('Empfehlungen', result.recommendations)}
        </div>
      );
    }
    case 'marketingIdeas': {
      const ideas = result.ideas as { title: string; channel: string; rationale: string; effort: string; expectedEffect: string }[];
      return <ul className="space-y-2 text-sm">{ideas.map((x, i) => <li key={i} className="rounded-xl bg-card p-3"><strong>{x.title}</strong> <Badge size="sm" variant="outline">{x.channel}</Badge> <Badge size="sm" variant="neutral">Aufwand {x.effort}</Badge><p className="mt-1 text-muted-foreground">{x.rationale}</p><p>Erwartete Wirkung: {x.expectedEffect}</p></li>)}</ul>;
    }
    default:
      return null;
  }
}
