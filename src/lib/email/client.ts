import 'server-only';

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Resend } from 'resend';
import { prisma } from '@/lib/db';
import { hasIntegration, serverEnv } from '@/lib/env';
import { logger } from '@/lib/logger';

const log = logger('email');

/**
 * E-Mail-Versand über Resend.
 *
 * Architekturentscheid: Der Versand schlägt nie hart fehl. Fällt Resend aus
 * oder fehlt der API-Key (lokale Entwicklung), wird die Nachricht in
 * `email_logs` protokolliert und in der Konsole ausgegeben, statt eine
 * Buchung oder Rechnungsstellung zu blockieren. Zustellprobleme sind ein
 * Betriebsthema, kein Grund, eine Transaktion zurückzurollen.
 */

let client: Resend | null = null;

function resend(): Resend | null {
  if (!hasIntegration('resend')) return null;
  client ??= new Resend(serverEnv().RESEND_API_KEY);
  return client;
}

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
  attachments?: { filename: string; content: Buffer | string }[];
  /** Für Nachverfolgung im Log. */
  templateKey?: string;
  entity?: string;
  entityId?: string;
  tags?: { name: string; value: string }[];
}

export interface SendEmailResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const env = serverEnv();
  const recipients = Array.isArray(input.to) ? input.to : [input.to];
  const from = env.EMAIL_FROM;

  const logBase = {
    to: recipients.join(', ').slice(0, 300),
    from,
    subject: input.subject.slice(0, 300),
    templateKey: input.templateKey ?? null,
    entity: input.entity ?? null,
    entityId: input.entityId ?? null,
  };

  const provider = resend();

  if (!provider) {
    // Entwicklungsmodus: Inhalt sichtbar machen statt still zu verwerfen.
    log.info('E-Mail simuliert (kein Anbieter konfiguriert)', {
      to: recipients,
      subject: input.subject,
      template: input.templateKey ?? null,
    });
    await prisma.emailLog
      .create({ data: { ...logBase, status: 'simulated' } })
      .catch(() => undefined);
    testPostausgang(input, recipients);
    return { ok: true, id: 'simulated' };
  }

  try {
    const bcc = [...(input.bcc ?? [])];
    if (env.EMAIL_BCC_ARCHIVE) bcc.push(env.EMAIL_BCC_ARCHIVE);

    const { data, error } = await provider.emails.send({
      from,
      to: recipients,
      subject: input.subject,
      html: input.html,
      text: input.text ?? stripHtml(input.html),
      replyTo: input.replyTo ?? env.EMAIL_REPLY_TO,
      cc: input.cc,
      bcc: bcc.length ? bcc : undefined,
      attachments: input.attachments?.map((a) => ({
        filename: a.filename,
        content: typeof a.content === 'string' ? a.content : a.content.toString('base64'),
      })),
      tags: input.tags,
    });

    if (error) {
      await prisma.emailLog
        .create({ data: { ...logBase, status: 'failed', error: error.message.slice(0, 500) } })
        .catch(() => undefined);
      log.error('Versand fehlgeschlagen', { error: error.message });
      return { ok: false, error: error.message };
    }

    await prisma.emailLog
      .create({ data: { ...logBase, status: 'sent', providerId: data?.id ?? null } })
      .catch(() => undefined);

    return { ok: true, id: data?.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
    await prisma.emailLog
      .create({ data: { ...logBase, status: 'failed', error: message.slice(0, 500) } })
      .catch(() => undefined);
    log.error('Versand fehlgeschlagen', { error: message });
    return { ok: false, error: message };
  }
}

/**
 * Postausgang der Prüfreihe — nur auf dem Testserver, nur ohne Anbieter.
 *
 * **Warum.** Der Versand ist der einzige Ort, an dem ein roher Zugangstoken
 * existiert; in der Datenbank liegt allein sein Hash. Eine Prüfung, die den
 * *tatsächlich versendeten* Link fahren will (Gate 4C, § 49), kann ihn sich
 * nirgends sonst holen. Deshalb schreibt der Testserver jede simulierte
 * Nachricht als Datei nach `<CLENARIS_TEST_CACHE_DIR>/mail/`; der Testprozess
 * liest sie dort (`tests/helpers/mail.ts`). Ein Anbieter ist nie beteiligt,
 * und ohne die Variable — also im Betrieb — passiert hier nichts. Der
 * Schutz ist derselbe wie beim dateibasierten Zähler: eine serverseitige
 * Umgebungsvariable, kein Endpunkt, keine Kopfzeile.
 */
function testPostausgang(input: SendEmailInput, recipients: string[]): void {
  const dir = process.env.CLENARIS_TEST_CACHE_DIR?.trim();
  if (!dir) return;
  try {
    const ordner = join(dir, 'mail');
    mkdirSync(ordner, { recursive: true });
    const name = `${Date.now()}-${randomBytes(4).toString('hex')}.json`;
    writeFileSync(
      join(ordner, name),
      JSON.stringify({
        at: new Date().toISOString(),
        to: recipients,
        subject: input.subject,
        html: input.html,
        text: input.text ?? stripHtml(input.html),
        templateKey: input.templateKey ?? null,
        entity: input.entity ?? null,
        entityId: input.entityId ?? null,
        attachments: (input.attachments ?? []).map((a) => a.filename),
      }),
      'utf8',
    );
  } catch {
    // Der Postausgang ist ein Prüfwerkzeug — sein Fehlen darf keinen Versand stören.
  }
}

/** Einfache HTML→Text-Konvertierung für den Plaintext-Teil. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
