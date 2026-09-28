import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { activeHandoffForCurrentDevice } from '@/server/services/device-handoff.service';

export const runtime = 'nodejs';

/**
 * GET /api/handoff — läuft auf diesem Gerät gerade eine Kundenabnahme?
 *
 * Einer von genau zwei Endpunkten mit `allowDuringHandoff`. Die
 * Entsperrmaske und der Kundenmodus müssen den Zustand lesen können, sonst
 * gäbe es keinen Weg zurück — und die Maske wüsste nicht, ob die
 * Unterschrift schon geleistet ist.
 *
 * Ausgegeben wird nur, was die Rückgabemaske braucht: Einsatznummer,
 * Zeitpunkte, Zustand des Vorgangs. Keine Rapportdaten, keine Kundendaten,
 * kein Token — wer das Gerät gerade hält, ist nicht das Personal.
 */
export const GET = defineRoute({
  allowDuringHandoff: true,
  // Die Rückgabemaske fragt im Abstand von Sekunden; `apiRead` lässt ihr
  // reichlich Luft und begrenzt trotzdem, wer den Endpunkt in einer Schleife
  // anfährt (Sicherheitsstandard C9, gefunden von `security:check`).
  rateLimit: 'apiRead',
  handler: async () => {
    const handoff = await activeHandoffForCurrentDevice();
    if (!handoff) return ok({ active: false }, { headers: { 'Cache-Control': 'no-store' } });

    return ok(
      {
        active: true,
        jobNumber: handoff.jobNumber,
        publicId: handoff.signaturePublicId,
        signatureStatus: handoff.signatureStatus,
        startedAt: handoff.startedAt,
        expiresAt: handoff.expiresAt,
        presentedByName: handoff.presentedByName,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  },
});
