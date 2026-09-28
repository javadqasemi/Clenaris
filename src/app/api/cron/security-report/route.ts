import type { NextRequest } from 'next/server';

import { defineCronRoute } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { ValidationError } from '@/lib/errors';
import { securityReportSchema } from '@/lib/validation/security-report';
import { getOrganizationId } from '@/server/services/organization.service';
import { berichtSpeichern } from '@/server/services/security-report.service';

export const runtime = 'nodejs';

/** Grösster angenommener Rumpf. 200 Befunde à gut 1,7 kB passen; mehr ist kein Bericht mehr. */
const HOECHSTENS_BYTES = 512 * 1024;

/**
 * POST /api/cron/security-report — Bericht einer Sicherheitsprüfung
 * entgegennehmen.
 *
 * Absender: `npm run security:check -- --melden`, die Vorlagen unter
 * `ops/security-monitor/`, die Sicherung. Bearer `SECURITY_REPORT_TOKEN`
 * (zeitkonstant verglichen), **nicht** `CRON_SECRET`: Wer Berichte senden
 * darf, darf keine geplanten Läufe auslösen.
 *
 * Gespeichert wird, ausgeführt nichts. Die Grösse wird vor dem Lesen des
 * Rumpfs geprüft, der Inhalt danach gegen `securityReportSchema` (alle
 * Längen begrenzt) — ein gestohlenes Token soll die Datenbank nicht füllen
 * können.
 */
export const POST = defineCronRoute({
  secretEnv: 'SECURITY_REPORT_TOKEN',
  handler: async (request: NextRequest) => {
    const laenge = Number(request.headers.get('content-length') ?? 0);
    if (laenge > HOECHSTENS_BYTES) throw new ValidationError('Bericht zu gross.');
    const text = await request.text();
    if (text.length > HOECHSTENS_BYTES) throw new ValidationError('Bericht zu gross.');
    let roh: unknown;
    try {
      roh = JSON.parse(text);
    } catch {
      throw new ValidationError('Kein gültiges JSON.');
    }
    // Ein ZodError wird wie in jeder Route zu 422 mit Feldangaben.
    const bericht = securityReportSchema.parse(roh);
    const gespeichert = await berichtSpeichern({ organizationId: await getOrganizationId(), bericht });
    return created({ id: gespeichert.id });
  },
});
