'use client';

import * as React from 'react';
import {
  ClipboardCopy,
  FileText,
  Languages,
  Mail,
  Route,
  Sparkles,
  TextQuote,
} from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import { Alert } from '@/components/ui/primitives';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/controls';

/**
 * KI-Werkzeugkasten für das Büro.
 *
 * Gestaltungsentscheid: jedes Werkzeug erzeugt einen *Entwurf*, den eine
 * Person prüft und kopiert. Nichts wird automatisch versendet oder
 * gespeichert. Das ist keine technische Einschränkung, sondern eine bewusste
 * Rollenverteilung: das Modell schreibt schnell, die Person entscheidet.
 */

type ToolKey = 'email' | 'summary' | 'translate' | 'disposition';

const TOOLS: { key: ToolKey; label: string; description: string; Icon: typeof Mail }[] = [
  {
    key: 'email',
    label: 'E-Mail verfassen',
    description: 'Antwort, Nachfassen oder Entschuldigung — im Ton der Firma.',
    Icon: Mail,
  },
  {
    key: 'summary',
    label: 'Text zusammenfassen',
    description: 'Lange Anfragen und Protokolle auf das Wesentliche kürzen.',
    Icon: TextQuote,
  },
  {
    key: 'translate',
    label: 'Übersetzen',
    description: 'Kundenkommunikation in Französisch, Italienisch oder Englisch.',
    Icon: Languages,
  },
  {
    key: 'disposition',
    label: 'Tagesplanung',
    description: 'Reihenfolge und Startzeiten für die Einsätze eines Tages vorschlagen.',
    Icon: Route,
  },
];

const TONES = [
  { value: 'freundlich', label: 'Freundlich' },
  { value: 'sachlich', label: 'Sachlich' },
  { value: 'entschuldigend', label: 'Entschuldigend' },
  { value: 'bestimmt', label: 'Bestimmt' },
  { value: 'werblich', label: 'Werblich' },
];

const LANGUAGES = [
  { value: 'FR', label: 'Französisch' },
  { value: 'IT', label: 'Italienisch' },
  { value: 'EN', label: 'Englisch' },
  { value: 'DE', label: 'Deutsch' },
];

export function AiWorkspace({ defaultTool }: { defaultTool?: string }) {
  const [tool, setTool] = React.useState<ToolKey>(
    TOOLS.some((item) => item.key === defaultTool) ? (defaultTool as ToolKey) : 'email',
  );
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Eingaben je Werkzeug
  const [purpose, setPurpose] = React.useState('');
  const [recipient, setRecipient] = React.useState('');
  const [tone, setTone] = React.useState('freundlich');
  const [context, setContext] = React.useState('');
  const [language, setLanguage] = React.useState('FR');
  const [date, setDate] = React.useState(() => new Date().toISOString().slice(0, 10));

  const run = async () => {
    setPending(true);
    setError(null);
    setResult(null);

    try {
      let text: string;

      switch (tool) {
        case 'email': {
          const response = await api.post<{ subject: string; body: string }>('/api/ai/email', {
            purpose,
            recipientName: recipient || 'Kundin/Kunde',
            context,
            tone,
          });
          text = `Betreff: ${response.subject}\n\n${response.body}`;
          break;
        }

        case 'summary': {
          const response = await api.post<{ text: string }>('/api/ai/summarize', {
            text: context,
          });
          text = response.text;
          break;
        }

        case 'translate': {
          const response = await api.post<{ text: string }>('/api/ai/translate', {
            text: context,
            targetLocale: language,
          });
          text = response.text;
          break;
        }

        case 'disposition': {
          const response = await api.post<{
            summary: string;
            order: { jobId: string; suggestedStart: string; reason: string }[];
            warnings: string[];
            totalTravelMinutes: number;
          }>('/api/ai/dispatch', { date });

          text = [
            response.summary,
            '',
            'Vorgeschlagene Reihenfolge:',
            ...response.order.map(
              (stop, index) => `${index + 1}. ${stop.suggestedStart} Uhr — ${stop.reason}`,
            ),
            '',
            `Geschätzte Fahrzeit insgesamt: ${response.totalTravelMinutes} Minuten.`,
            ...(response.warnings.length > 0
              ? ['', 'Hinweise:', ...response.warnings.map((warning) => `• ${warning}`)]
              : []),
          ].join('\n');
          break;
        }
      }

      setResult(text);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : 'Der Entwurf konnte nicht erstellt werden. Bitte später erneut versuchen.';
      setError(message);
      toast.error(message);
    } finally {
      setPending(false);
    }
  };

  const copy = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result);
    toast.success('In die Zwischenablage kopiert.');
  };

  const canRun =
    (tool === 'email' && purpose.trim().length > 3 && context.trim().length > 10) ||
    (tool === 'summary' && context.trim().length > 40) ||
    (tool === 'translate' && context.trim().length > 3) ||
    tool === 'disposition';

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_1fr] lg:items-start">
      {/* Werkzeugwahl */}
      <nav aria-label="KI-Werkzeuge" className="space-y-2">
        {TOOLS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => {
              setTool(item.key);
              setResult(null);
              setError(null);
            }}
            aria-pressed={tool === item.key}
            className={cn(
              'flex w-full items-start gap-3 rounded-2xl border-2 p-4 text-left transition-all duration-200',
              'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/15',
              tool === item.key
                ? 'border-primary bg-primary/[0.04]'
                : 'border-border bg-card hover:border-primary/40',
            )}
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary">
              <item.Icon className="size-4" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block font-medium">{item.label}</span>
              <span className="block text-sm leading-relaxed text-muted-foreground">
                {item.description}
              </span>
            </span>
          </button>
        ))}
      </nav>

      {/* Eingabe und Ergebnis */}
      <div className="space-y-6">
        <div className="space-y-4 rounded-2xl border border-border bg-card p-6">
          {tool === 'email' ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="ai-purpose" required>
                    Zweck
                  </Label>
                  <Input
                    id="ai-purpose"
                    value={purpose}
                    onChange={(event) => setPurpose(event.target.value)}
                    placeholder="z. B. Terminverschiebung mitteilen"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ai-recipient">Empfänger</Label>
                  <Input
                    id="ai-recipient"
                    value={recipient}
                    onChange={(event) => setRecipient(event.target.value)}
                    placeholder="Frau Muster"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="ai-tone">Tonalität</Label>
                <Select value={tone} onValueChange={setTone}>
                  <SelectTrigger id="ai-tone" className="sm:max-w-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TONES.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          ) : null}

          {tool === 'translate' ? (
            <div className="space-y-2">
              <Label htmlFor="ai-language">Zielsprache</Label>
              <Select value={language} onValueChange={setLanguage}>
                <SelectTrigger id="ai-language" className="sm:max-w-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGES.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {tool === 'disposition' ? (
            <div className="space-y-2">
              <Label htmlFor="ai-date" required>
                Einsatztag
              </Label>
              <Input
                id="ai-date"
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                className="sm:max-w-xs"
              />
              <p className="text-sm text-muted-foreground">
                Wir laden alle Einsätze dieses Tages und schlagen Reihenfolge und Startzeiten vor.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="ai-context" required>
                {tool === 'email'
                  ? 'Kontext'
                  : tool === 'summary'
                    ? 'Text zum Zusammenfassen'
                    : 'Text zum Übersetzen'}
              </Label>
              <Textarea
                id="ai-context"
                value={context}
                onChange={(event) => setContext(event.target.value)}
                rows={8}
                placeholder={
                  tool === 'email'
                    ? 'Was ist passiert? Welche Fakten sollen in die E-Mail? Nennen Sie Daten und Beträge konkret.'
                    : 'Text hier einfügen …'
                }
              />
            </div>
          )}

          <div className="flex items-center justify-between gap-4">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Der Entwurf ersetzt keine Prüfung. Zahlen und Zusagen bitte gegenlesen, bevor Sie ihn
              verwenden.
            </p>
            <Button onClick={run} loading={pending} disabled={!canRun}>
              <Sparkles aria-hidden />
              Entwurf erstellen
            </Button>
          </div>
        </div>

        {error ? <Alert variant="destructive">{error}</Alert> : null}

        {result ? (
          <div className="space-y-3 rounded-2xl border border-border bg-card p-6">
            <div className="flex items-center justify-between gap-4">
              <h2 className="flex items-center gap-2 font-display text-base font-semibold">
                <FileText className="size-4 text-primary" aria-hidden />
                Entwurf
              </h2>
              <Button variant="outline" size="sm" onClick={copy}>
                <ClipboardCopy aria-hidden />
                Kopieren
              </Button>
            </div>

            <Textarea
              value={result}
              onChange={(event) => setResult(event.target.value)}
              rows={16}
              aria-label="Erzeugter Entwurf"
              className="font-[inherit]"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
