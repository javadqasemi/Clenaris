import 'server-only';

import type { Prisma, SignatureEventType } from '@prisma/client';

import { sessionRef } from '@/lib/auth/signature-session';
import type { prisma, Tx } from '@/lib/db';

/**
 * Das Signaturprotokoll — anhängen, sonst nichts.
 *
 * Eigenes Modul seit Gate 4C, weil zwei Dienste schreiben: der Signaturkern
 * und die Offertannahme (`quote-acceptance.service.ts`). Importierten beide
 * einander, entstünde ein Zyklus; importieren beide dieses Modul, bleibt die
 * Regel an einer Stelle: **die einzige Schreibfunktion** für
 * `signature_events`. Ändern oder Löschen gibt es nicht — auch die Datenbank
 * lehnt es ab (Trigger in der Migration `signatur_kern`).
 */

export interface AnfrageKontext {
  ip: string | null;
  ipSource: string;
  userAgent: string | null;
}

/**
 * Woher die handelnde Person kam — für das Protokoll, ohne Anspruch auf
 * mehr Identitätssicherheit: Ein Portal-Login sagt, welches Konto
 * angemeldet war, nicht, wer vor dem Gerät sass.
 */
export type ActorSource = 'PUBLIC_LINK' | 'AUTHENTICATED_CUSTOMER';

/**
 * Ein Ereignis anhängen.
 *
 * Nie mit Geheimnissen: kein Token, kein Code, kein Cookie, kein Bild.
 * `details` ist klein und trägt eine Fassungsnummer (`v`), damit spätere
 * Leser wissen, wie sie es deuten.
 */
export async function appendSignatureEvent(
  client: Tx | typeof prisma,
  params: {
    requestId: string;
    participantId?: string | null;
    type: SignatureEventType;
    ctx?: AnfrageKontext | null;
    sessionJti?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await client.signatureEvent.create({
    data: {
      requestId: params.requestId,
      participantId: params.participantId ?? null,
      type: params.type,
      ipAddress: params.ctx?.ip ?? null,
      ipSource: params.ctx?.ipSource ?? null,
      clientReportedUserAgent: params.ctx?.userAgent ?? null,
      sessionRef: params.sessionJti ? sessionRef(params.sessionJti) : null,
      details: params.details ? ({ v: 1, ...params.details } as Prisma.InputJsonObject) : undefined,
    },
  });
}
