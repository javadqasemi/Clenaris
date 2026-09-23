import 'server-only';

import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import { naechsterStatus, type ResendEreignis, type Zustellstatus } from '@/lib/kommunikation/zustellung';

/**
 * Zustellprotokoll (Wave 14, 2026-09-23).
 *
 * Nimmt die Meldungen der Anbieter auf (Resend für E-Mail, Twilio für SMS)
 * und schreibt sie an die Protokollzeile, die beim Versand entstand — über
 * die Kennung des Anbieters, die `sendEmail`/`sendSms` festhalten.
 *
 * **Idempotent und ordnungsfest:** Doppelte oder verspätete Meldungen ändern
 * nichts (`naechsterStatus`), Öffnen und Klicken halten den **ersten**
 * Zeitpunkt fest.
 *
 * **Kein Inhalt aus der Meldung** wird gespeichert — nur Status, Zeitpunkt
 * und bei einem Fehler dessen Code. Die Meldungen enthalten Empfänger und
 * Betreff, die ohnehin schon in der Zeile stehen.
 */

export async function meldeEmailZustellung(params: {
  providerId: string;
  ereignis: ResendEreignis;
  zeitpunkt: Date;
  fehler?: string | null;
}): Promise<{ gefunden: boolean; geaendert: boolean }> {
  const zeile = await prisma.emailLog.findFirst({
    where: { providerId: params.providerId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, openedAt: true, clickedAt: true, deliveredAt: true },
  });
  if (!zeile) return { gefunden: false, geaendert: false };

  const daten: Prisma.EmailLogUpdateInput = {};
  if (params.ereignis.status) {
    const neu = naechsterStatus(zeile.status, params.ereignis.status);
    if (neu) {
      daten.status = neu;
      daten.statusAt = params.zeitpunkt;
      if (neu === 'delivered' && !zeile.deliveredAt) daten.deliveredAt = params.zeitpunkt;
      if (['bounced', 'complained', 'failed'].includes(neu) && params.fehler) daten.error = params.fehler.slice(0, 500);
    }
  }
  if (params.ereignis.geoeffnet && !zeile.openedAt) daten.openedAt = params.zeitpunkt;
  if (params.ereignis.geklickt && !zeile.clickedAt) daten.clickedAt = params.zeitpunkt;
  if (Object.keys(daten).length === 0) return { gefunden: true, geaendert: false };
  await prisma.emailLog.update({ where: { id: zeile.id }, data: daten });
  return { gefunden: true, geaendert: true };
}

export async function meldeSmsZustellung(params: {
  providerId: string;
  status: Zustellstatus;
  zeitpunkt: Date;
  fehler?: string | null;
}): Promise<{ gefunden: boolean; geaendert: boolean }> {
  const zeile = await prisma.smsLog.findFirst({
    where: { providerId: params.providerId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, deliveredAt: true },
  });
  if (!zeile) return { gefunden: false, geaendert: false };
  const neu = naechsterStatus(zeile.status, params.status);
  if (!neu) return { gefunden: true, geaendert: false };
  await prisma.smsLog.update({
    where: { id: zeile.id },
    data: {
      status: neu,
      statusAt: params.zeitpunkt,
      ...(neu === 'delivered' && !zeile.deliveredAt ? { deliveredAt: params.zeitpunkt } : {}),
      ...(params.fehler && ['undelivered', 'failed'].includes(neu) ? { error: params.fehler.slice(0, 500) } : {}),
    },
  });
  return { gefunden: true, geaendert: true };
}

export async function listeZustellprotokoll(params: { kanal: 'email' | 'sms'; status?: string; suche?: string; seit?: Date }) {
  const seit = params.seit ?? new Date(Date.now() - 30 * 86_400_000);
  if (params.kanal === 'email') {
    const where: Prisma.EmailLogWhereInput = {
      createdAt: { gte: seit },
      ...(params.status ? { status: params.status } : {}),
      ...(params.suche ? { OR: [{ to: { contains: params.suche, mode: 'insensitive' } }, { subject: { contains: params.suche, mode: 'insensitive' } }] } : {}),
    };
    const [eintraege, jeStatus] = await Promise.all([
      prisma.emailLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 300,
        select: { id: true, to: true, subject: true, templateKey: true, status: true, error: true, createdAt: true, deliveredAt: true, openedAt: true, entity: true },
      }),
      prisma.emailLog.groupBy({ by: ['status'], where: { createdAt: { gte: seit } }, _count: { _all: true } }),
    ]);
    return { eintraege, jeStatus: jeStatus.map((s) => ({ status: s.status, anzahl: s._count._all })) };
  }
  const where: Prisma.SmsLogWhereInput = {
    createdAt: { gte: seit },
    ...(params.status ? { status: params.status } : {}),
    ...(params.suche ? { to: { contains: params.suche } } : {}),
  };
  const [eintraege, jeStatus] = await Promise.all([
    prisma.smsLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 300,
      select: { id: true, to: true, status: true, error: true, createdAt: true, deliveredAt: true, entity: true, segments: true },
    }),
    prisma.smsLog.groupBy({ by: ['status'], where: { createdAt: { gte: seit } }, _count: { _all: true } }),
  ]);
  return { eintraege, jeStatus: jeStatus.map((s) => ({ status: s.status, anzahl: s._count._all })) };
}
