import 'server-only';

import twilio from 'twilio';
import { prisma } from '@/lib/db';
import { hasIntegration, serverEnv } from '@/lib/env';
import { normalizePhone } from '@/lib/utils';
import { logger } from '@/lib/logger';

const log = logger('sms');

/**
 * SMS-Versand über Twilio.
 *
 * Wie beim E-Mail-Client gilt: Fehler werden protokolliert, nicht geworfen.
 * SMS ist ein Zusatzkanal (Terminerinnerungen, Einsatzbenachrichtigungen an
 * das Team) — ein Ausfall darf keinen Geschäftsvorgang blockieren.
 */

let client: ReturnType<typeof twilio> | null = null;

function twilioClient() {
  if (!hasIntegration('twilio')) return null;
  const env = serverEnv();
  client ??= twilio(env.TWILIO_ACCOUNT_SID!, env.TWILIO_AUTH_TOKEN!);
  return client;
}

export interface SendSmsInput {
  to: string;
  body: string;
  entity?: string;
  entityId?: string;
}

export async function sendSms(input: SendSmsInput): Promise<{ ok: boolean; id?: string }> {
  const to = normalizePhone(input.to);
  // Twilio zählt 160 Zeichen pro Segment (70 bei Unicode). Wir kürzen defensiv.
  const body = input.body.slice(0, 640);
  const segments = Math.ceil(body.length / 153) || 1;

  const logBase = {
    to,
    body: body.slice(0, 500),
    segments,
    entity: input.entity ?? null,
    entityId: input.entityId ?? null,
  };

  const provider = twilioClient();

  if (!provider) {
    log.info('SMS simuliert (kein Anbieter konfiguriert)', { to, body });
    await prisma.smsLog.create({ data: { ...logBase, status: 'simulated' } }).catch(() => undefined);
    return { ok: true, id: 'simulated' };
  }

  try {
    const env = serverEnv();
    const message = await provider.messages.create({
      to,
      body,
      ...(env.TWILIO_MESSAGING_SERVICE_SID
        ? { messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID }
        : { from: env.TWILIO_FROM_NUMBER }),
    });

    await prisma.smsLog
      .create({ data: { ...logBase, status: 'sent', providerId: message.sid } })
      .catch(() => undefined);

    return { ok: true, id: message.sid };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
    await prisma.smsLog
      .create({ data: { ...logBase, status: 'failed', error: message.slice(0, 500) } })
      .catch(() => undefined);
    log.error('Versand fehlgeschlagen', { error: message });
    return { ok: false };
  }
}

/**
 * SMS-Vorlagen. Bewusst kurz gehalten: eine SMS soll in ein Segment passen,
 * damit die Kosten kalkulierbar bleiben.
 */
export const smsTemplates = {
  bookingConfirmed: (params: { date: string; time: string; company: string }) =>
    `${params.company}: Ihr Reinigungstermin am ${params.date} um ${params.time} Uhr ist bestätigt. Details in Ihrem Kundenkonto.`,

  bookingReminder: (params: { date: string; time: string; company: string }) =>
    `Erinnerung: Ihr Reinigungstermin ist am ${params.date} um ${params.time} Uhr. ${params.company}`,

  bookingCancelled: (params: { date: string; company: string }) =>
    `${params.company}: Ihr Termin am ${params.date} wurde storniert. Bei Fragen erreichen Sie uns telefonisch.`,

  jobAssigned: (params: { date: string; time: string; address: string }) =>
    `Neuer Einsatz: ${params.date} um ${params.time} Uhr, ${params.address}. Details im Portal.`,

  jobReminder: (params: { time: string; address: string }) =>
    `Dein Einsatz beginnt um ${params.time} Uhr: ${params.address}`,

  invoiceOverdue: (params: { number: string; amount: string; company: string }) =>
    `${params.company}: Rechnung ${params.number} über ${params.amount} ist fällig. Jetzt online bezahlen.`,

  verificationCode: (params: { code: string; company: string }) =>
    `${params.company}: Ihr Bestätigungscode lautet ${params.code}. Gültig für 10 Minuten.`,
};
