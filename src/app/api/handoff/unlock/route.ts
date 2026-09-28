import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { handoffUnlockSchema } from '@/lib/validation/signatures';
import { releaseHandoff } from '@/server/services/device-handoff.service';

export const runtime = 'nodejs';

/**
 * POST /api/handoff/unlock — das Gerät wieder übernehmen.
 *
 * **Eine Bestätigung, keine Anmeldung.** Die Sitzung besteht die ganze Zeit
 * über; sie war nur gesperrt, solange jemand anderes das Gerät hielt. Wer
 * hier das Passwort des bereits angemeldeten Kontos bestätigt, bekommt
 * dieselbe Sitzung zurück — dieselbe Rotationsfamilie, kein neuer
 * Benutzername, kein zweiter Faktor, keine E-Mail. Genau das war der Zweck
 * der Übung: Eine Abnahme zwischen zwei Terminen darf nicht jedes Mal eine
 * vollständige Neuanmeldung auf einem Telefon bedeuten.
 *
 * `allowDuringHandoff`, denn sonst schlösse sich die Tür hinter der Person,
 * die sie öffnen soll. Das Kontingent zählt je Übergabe (nicht je Konto),
 * damit falsches Tippen niemanden auf seinen übrigen Geräten aussperrt.
 */
export const POST = defineRoute({
  allowDuringHandoff: true,
  body: handoffUnlockSchema,
  handler: async ({ body, session, ip }) => {
    const ergebnis = await releaseHandoff({ session, password: body.password, ip });
    return ok(
      {
        jobId: ergebnis.jobId,
        jobNumber: ergebnis.jobNumber,
        signatureStatus: ergebnis.signatureStatus,
        weiter: `/portal/einsaetze/${ergebnis.jobId}`,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  },
});
