'use client';

import * as React from 'react';
import { MessageCircle, Send, Sparkles, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/**
 * KI-Assistent auf der Website.
 *
 * Architekturentscheide:
 *  • Die Antworten kommen über Server-Sent Events; der Text erscheint
 *    schrittweise, damit die Wartezeit nicht als Stillstand wirkt.
 *  • Der Verlauf lebt nur im Komponentenzustand. Wir speichern keine
 *    Chat-Protokolle von nicht angemeldeten Besucherinnen — das wäre eine
 *    Datensammlung ohne Zweck.
 *  • Bei einem Fehler verweist der Assistent auf die Telefonnummer, statt eine
 *    technische Meldung zu zeigen.
 */

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const SUGGESTIONS = [
  'Was kostet eine Umzugsreinigung für 90 m²?',
  'Reinigen Sie auch in Ostermundigen?',
  'Wie schnell bekomme ich einen Termin?',
];

export function ChatWidget() {
  const [open, setOpen] = React.useState(false);
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [input, setInput] = React.useState('');
  const [streaming, setStreaming] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  React.useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || streaming) return;

    const history = [...messages, { role: 'user' as const, content: question }];
    setMessages([...history, { role: 'assistant', content: '' }]);
    setInput('');
    setStreaming(true);

    try {
      const response = await fetch('/api/public/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: question,
          history: history.slice(-8, -1),
        }),
      });

      if (!response.ok || !response.body) throw new Error('Antwort nicht verfügbar');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let answer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') continue;

          try {
            const parsed = JSON.parse(payload) as { delta?: string; error?: string };
            if (parsed.error) {
              answer = parsed.error;
            } else if (parsed.delta) {
              answer += parsed.delta;
            }
            setMessages((current) => {
              const next = [...current];
              next[next.length - 1] = { role: 'assistant', content: answer };
              return next;
            });
          } catch {
            /* unvollständiges Fragment — beim nächsten Chunk erneut versuchen */
          }
        }
      }
    } catch {
      setMessages((current) => {
        const next = [...current];
        next[next.length - 1] = {
          role: 'assistant',
          content:
            'Ich kann gerade nicht antworten. Rufen Sie uns an unter 031 511 22 33 — wir helfen Ihnen direkt weiter.',
        };
        return next;
      });
    } finally {
      setStreaming(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? 'Assistent schliessen' : 'Assistent öffnen'}
        className={cn(
          'fixed bottom-5 right-5 z-40 flex size-14 items-center justify-center rounded-full shadow-elevated transition-all duration-300 ease-spring',
          'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/30',
          open
            ? 'bg-foreground text-background'
            : 'bg-primary text-primary-foreground hover:scale-105',
        )}
      >
        {open ? <X className="size-5" aria-hidden /> : <MessageCircle className="size-6" aria-hidden />}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Assistent"
          className="fixed bottom-24 right-5 z-40 flex h-[min(30rem,70dvh)] w-[min(24rem,calc(100vw-2.5rem))] animate-fade-up flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-elevated"
        >
          <header className="flex items-center gap-3 border-b border-border px-4 py-3.5">
            <span className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Sparkles className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold leading-tight">Fragen zur Reinigung?</p>
              <p className="text-xs text-muted-foreground">Antwort in Sekunden</p>
            </div>
          </header>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
            {messages.length === 0 ? (
              <div className="space-y-3">
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Guten Tag. Ich beantworte Fragen zu Leistungen, Preisrahmen und Einsatzgebiet.
                  Für ein verbindliches Angebot nutzen Sie die Sofort-Offerte.
                </p>
                <div className="space-y-2">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => send(suggestion)}
                      className="w-full rounded-xl border border-border px-3.5 py-2.5 text-left text-sm transition-colors hover:border-primary/40 hover:bg-muted"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {messages.map((message, index) => (
              <div
                key={index}
                className={cn(
                  'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
                  message.role === 'user'
                    ? 'ml-auto bg-primary text-primary-foreground'
                    : 'bg-muted text-foreground',
                )}
              >
                {message.content || (
                  <span className="inline-flex gap-1" aria-label="Antwort wird geschrieben">
                    {[0, 1, 2].map((dot) => (
                      <span
                        key={dot}
                        className="size-1.5 animate-pulse rounded-full bg-muted-foreground"
                        style={{ animationDelay: `${dot * 150}ms` }}
                      />
                    ))}
                  </span>
                )}
              </div>
            ))}
          </div>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send(input);
            }}
            className="flex items-center gap-2 border-t border-border p-3"
          >
            <input
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Ihre Frage …"
              aria-label="Ihre Frage"
              maxLength={500}
              className="h-10 flex-1 rounded-xl border border-input bg-background px-3.5 text-sm focus-visible:border-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/12"
            />
            <Button type="submit" size="icon" disabled={!input.trim() || streaming} aria-label="Senden">
              <Send aria-hidden />
            </Button>
          </form>
        </div>
      ) : null}
    </>
  );
}
