import 'server-only';

import { redact } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

import { SECURITY_EVENTS, type SecurityEventKind } from './events';

const log = logger('security');

/**
 * Ein Sicherheitsereignis festhalten.
 *
 * ---------------------------------------------------------------------------
 *  Dieselben zwei Eigenschaften wie `recordAudit` — aus demselben Grund
 * ---------------------------------------------------------------------------
 *
 * **Ausserhalb der Geschäftstransaktion, und Fehler werden geschluckt.** Das
 * sieht falsch aus für ein Sicherheitsprotokoll und ist es nicht: Die
 * Alternative wäre, dass ein voller Datenträger oder eine Sperre auf der
 * Protokolltabelle die Anmeldung scheitern lässt. Ein Protokoll, das den
 * Betrieb anhalten kann, ist selbst ein Angriffsziel — wer es zum Überlaufen
 * bringt, legt die Anwendung lahm.
 *
 * Der Preis ist, dass ein Ereignis verlorengehen kann. Der wird bezahlt und
 * nicht verschwiegen: Der Fehlschlag steht im Anwendungsprotokoll, und die
 * Zustände selbst (`lockedUntil`, `sessionsRevokedAt`, `scanStatus`,
 * `revokedAt`) stehen ohnehin an ihren Datensätzen. Dieser Strom ist die
 * bequeme Sicht darauf, nicht die einzige Quelle.
 *
 * ---------------------------------------------------------------------------
 *  Was nicht hineingeht
 * ---------------------------------------------------------------------------
 *
 * `context` läuft durch `redact` aus `lib/audit.ts` — dieselbe Liste, nicht
 * eine zweite. Eine zweite Liste wäre eine, die beim nächsten neuen Geheimnis
 * nur an einer Stelle ergänzt wird.
 *
 * Was `redact` nicht kann, muss die aufrufende Stelle lassen: Ein roher
 * Zugangstoken unter dem Schlüssel `wert` heisst `wert` und wird durchgelassen.
 * Deshalb steht in `events.ts` bei `PUBLIC_LINK_*` ausdrücklich, dass der
 * Tokenwert dort nichts zu suchen hat — auch nicht gehasht, denn ein Hash im
 * Protokoll erlaubt den Abgleich gegen einen abgefangenen Wert.
 */
export interface SecurityEventInput {
  organizationId: string;
  kind: SecurityEventKind;
  /** Wen es betrifft. `null`, wenn kein Konto feststeht. */
  userId?: string | null;
  /**
   * Ein Satz auf Deutsch. Ohne Angabe wird die Bezeichnung aus dem Katalog
   * genommen — das ist der Normalfall und ausdrücklich in Ordnung.
   */
  summary?: string;
  context?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

export async function recordSecurityEvent(input: SecurityEventInput): Promise<void> {
  const art = SECURITY_EVENTS[input.kind];

  try {
    await prisma.securityEvent.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId ?? null,
        kind: input.kind,
        category: art.category,
        severity: art.severity,
        summary: (input.summary ?? art.label).slice(0, 500),
        context: input.context ? (redact(input.context) as object) : undefined,
        ip: input.ip ?? null,
        userAgent: input.userAgent?.slice(0, 300) ?? null,
      },
    });
  } catch (error) {
    log.error('Sicherheitsereignis konnte nicht festgehalten werden', {
      kind: input.kind,
      error,
    });
  }
}
