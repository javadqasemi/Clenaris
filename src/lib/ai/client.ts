import 'server-only';

import Anthropic from '@anthropic-ai/sdk';
import { hasIntegration, serverEnv } from '@/lib/env';
import { IntegrationError } from '@/lib/errors';
import { logger } from '@/lib/logger';

import { ausgangsfilter, summeErsetzungen } from './governance';

const log = logger('ai');

/**
 * Anthropic-Client für alle KI-Funktionen.
 *
 * Architekturentscheide:
 *  • Ein einziger Client, zwei Modell-Stufen: `claude-opus-5` für Aufgaben mit
 *    Urteilsvermögen (Offerten kalkulieren, Berichte schreiben, Routen planen)
 *    und `claude-haiku-4-5` für Hochvolumen-Kleinkram (Klassifikation,
 *    Übersetzung kurzer Texte, Chat-Intents).
 *  • Adaptives Thinking ist eingeschaltet; die Tiefe steuern wir über
 *    `output_config.effort` statt über ein festes Token-Budget.
 *  • Jede Antwort läuft durch `assertNoRefusal`, damit ein abgelehnter Request
 *    nicht als leerer Text im Produkt landet.
 *  • Die KI trifft nie eine finale Geschäftsentscheidung: Offerten, Preise und
 *    E-Mails werden als *Entwurf* erzeugt und von einer Person freigegeben.
 */

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!hasIntegration('ai')) {
    throw new IntegrationError('Anthropic', 'KI-Funktionen sind nicht konfiguriert.');
  }
  client ??= new Anthropic({ apiKey: serverEnv().ANTHROPIC_API_KEY });
  return client;
}

export type AiTier = 'smart' | 'fast';

export function modelFor(tier: AiTier): string {
  const env = serverEnv();
  return tier === 'fast' ? env.AI_MODEL_FAST : env.AI_MODEL;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface GenerateOptions {
  system: string;
  prompt: string;
  tier?: AiTier;
  effort?: Effort;
  maxTokens?: number;
  /** Frühere Turns für mehrstufige Dialoge (Chatbot). */
  history?: Anthropic.MessageParam[];
  temperatureHint?: never;
}

/**
 * Der Ausgangsfilter (Wave 15): Jede Anfrage verlässt den Prozess nur nach
 * `ausgangsfilter` — E-Mail-Adressen, Telefonnummern, IBAN, AHV-Nummern und
 * Datenbankkennungen werden ersetzt, bevor sie beim Auftragsverarbeiter
 * ankommen. Geprotokolliert wird, **wie oft** ersetzt wurde, nie **was**.
 *
 * Der Systemtext bleibt ungefiltert: Er stammt aus dem Code (und aus dem
 * Katalog, etwa Leistungsnamen und Öffnungszeiten), nicht von Personen.
 */
function gefiltert(prompt: string, history: Anthropic.MessageParam[] | undefined) {
  const p = ausgangsfilter(prompt);
  const summen: Record<string, number>[] = [p.ersetzungen];
  const verlauf = (history ?? []).map((m) => {
    if (typeof m.content !== 'string') return m;
    const f = ausgangsfilter(m.content);
    summen.push(f.ersetzungen);
    return { ...m, content: f.text };
  });
  const ersetzungen = summeErsetzungen(...summen);
  if (Object.keys(ersetzungen).length > 0) log.info('KI-Ausgangsfilter hat ersetzt', { ersetzungen });
  return { prompt: p.text, history: verlauf };
}

/** Extrahiert den Text aus einer Antwort und prüft auf Ablehnung. */
function assertNoRefusal(message: Anthropic.Message): string {
  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category ?? 'unbekannt';
    throw new IntegrationError(
      'Anthropic',
      `Die Anfrage wurde vom Modell abgelehnt (${category}).`,
    );
  }

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  if (!text) {
    throw new IntegrationError('Anthropic', 'Das Modell hat keine Antwort geliefert.');
  }
  return text;
}

/**
 * Freitext erzeugen. Nutzt Streaming, damit auch lange Ausgaben
 * (Offertentexte, Berichte) nicht in HTTP-Timeouts laufen.
 */
export async function generateText(options: GenerateOptions): Promise<string> {
  const f = gefiltert(options.prompt, options.history);
  const stream = anthropic().messages.stream({
    model: modelFor(options.tier ?? 'smart'),
    max_tokens: options.maxTokens ?? 8_000,
    system: options.system,
    thinking: { type: 'adaptive' },
    output_config: { effort: options.effort ?? 'medium' },
    messages: [
      ...f.history,
      { role: 'user', content: f.prompt },
    ],
  });

  const message = await stream.finalMessage();
  return assertNoRefusal(message);
}

/**
 * Strukturierte Ausgabe über ein JSON-Schema.
 *
 * `strict: true` garantiert, dass `input` exakt dem Schema entspricht — damit
 * entfällt defensives Nachparsen im Aufrufer.
 */
export async function generateStructured<T>(params: {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  toolName: string;
  toolDescription: string;
  tier?: AiTier;
  effort?: Effort;
  maxTokens?: number;
}): Promise<T> {
  const f = gefiltert(params.prompt, undefined);
  const message = await anthropic().messages.create({
    model: modelFor(params.tier ?? 'smart'),
    max_tokens: params.maxTokens ?? 8_000,
    system: params.system,
    thinking: { type: 'adaptive' },
    output_config: { effort: params.effort ?? 'medium' },
    tools: [
      {
        name: params.toolName,
        description: params.toolDescription,
        input_schema: params.schema as Anthropic.Tool.InputSchema,
        strict: true,
      },
    ],
    messages: [{ role: 'user', content: f.prompt }],
  });

  if (message.stop_reason === 'refusal') {
    throw new IntegrationError('Anthropic', 'Die Anfrage wurde vom Modell abgelehnt.');
  }

  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );

  if (!toolUse) {
    throw new IntegrationError(
      'Anthropic',
      'Das Modell hat keine strukturierte Antwort geliefert.',
    );
  }

  return toolUse.input as T;
}

/** Streaming für den Chat — liefert Text-Deltas als ReadableStream (SSE-tauglich). */
export function streamText(options: GenerateOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      try {
        const f = gefiltert(options.prompt, options.history);
        const stream = anthropic().messages.stream({
          model: modelFor(options.tier ?? 'fast'),
          max_tokens: options.maxTokens ?? 2_000,
          system: options.system,
          thinking: { type: 'adaptive' },
          output_config: { effort: options.effort ?? 'low' },
          messages: [
            ...f.history,
            { role: 'user', content: f.prompt },
          ],
        });

        stream.on('text', (delta) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`));
        });

        const final = await stream.finalMessage();
        if (final.stop_reason === 'refusal') {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                error:
                  'Diese Frage kann ich nicht beantworten. Unser Team hilft Ihnen gerne persönlich weiter.',
              })}\n\n`,
            ),
          );
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
        log.error('Streaming fehlgeschlagen', { error: message });
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              error: 'Der Assistent ist momentan nicht erreichbar. Bitte versuchen Sie es später erneut.',
            })}\n\n`,
          ),
        );
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });
}
