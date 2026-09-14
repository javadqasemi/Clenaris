import { definePublicRoute } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { absoluteUrl } from '@/lib/utils';
import { logger } from '@/lib/logger';
import { quoteRequestSchema } from '@/lib/validation/crm';
import { createLeadFromContactForm } from '@/server/services/crm.service';
import { createQuoteFromRequest } from '@/server/services/quote.service';
import { notifyStaff } from '@/server/services/notification.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

const log = logger('public-quotes');

/**
 * POST /api/public/quotes — Offertanfrage von der Website.
 *
 * **Warum dieser Endpunkt überhaupt existiert.** Das Offertformular schickte
 * seine Daten an `/api/public/contact`. Dieser Endpunkt validiert mit dem
 * *Kontakt*schema, und Zod verwirft unbekannte Felder stillschweigend: Fläche,
 * Zimmerzahl, Turnus, Strasse, Wunschtermin und die angehängten Dateien kamen
 * nie im Server an. Es entstand ein gewöhnlicher Kontaktlead, in der
 * Offertenübersicht erschien nichts, und niemand konnte sehen, dass etwas
 * fehlte — die Anfrage war ja „angekommen".
 *
 * Der Ablauf jetzt:
 *
 *  1. **Lead** — bestehender wird ergänzt, sonst neuer angelegt
 *     (`createLeadFromContactForm` erkennt Doppelungen über E-Mail, Telefon
 *     sowie Name plus Firma).
 *  2. **Offertentwurf** — mit Position, Menge in der richtigen Einheit und
 *     Katalogansatz, sichtbar unter „Offerten".
 *  3. **Meldung ans Büro** mit dem Link auf den Entwurf.
 *
 * Schritt 2 und 3 dürfen scheitern, ohne die Anfrage zu verlieren: Der Lead
 * steht dann bereits, und das Büro sieht ihn. Eine Anfrage wegen eines
 * Folgeschritts zu verwerfen wäre der teuerste denkbare Fehler dieses
 * Formulars.
 */
export const POST = definePublicRoute({
  body: quoteRequestSchema,
  /**
   * Eigenes Kontingent, nicht das des Kontaktformulars.
   *
   * `quoteRequest` (10 pro Stunde) stand in der Konfiguration, wurde aber von
   * keiner Route verwendet — der einzige Grund dafür ist, dass es diese Route
   * bis jetzt nicht gab. Beide Formulare auf dasselbe Kontingent zu legen wäre
   * schädlich: Wer erst Fragen stellt und dann eine Offerte anfordert,
   * verhält sich wie ein ernsthafter Interessent und würde ausgerechnet dafür
   * ausgesperrt.
   */
  rateLimit: 'quoteRequest',
  handler: async ({ body, ip }) => {
    const organizationId = await getOrganizationId();

    const lead = await createLeadFromContactForm({
      organizationId,
      input: body,
      ip,
      activitySubject: 'Offertanfrage über die Website',
    });

    let quoteNumber: string | null = null;

    try {
      const quote = await createQuoteFromRequest({
        organizationId,
        leadId: lead.id,
        input: body,
      });
      quoteNumber = quote.number;

      await notifyStaff({
        organizationId,
        title: lead.isNew ? 'Neue Offertanfrage' : 'Weitere Offertanfrage',
        body: `${body.firstName} ${body.lastName} · ${quote.title} · Entwurf ${quote.number}`,
        link: `/admin/offerten/${quote.id}`,
        permission: 'quote:read',
      });
    } catch (error) {
      // Der Lead ist gesichert — das Büro sieht die Anfrage in jedem Fall.
      log.error('Offertentwurf konnte nicht erstellt werden', { error, leadId: lead.id });

      await notifyStaff({
        organizationId,
        title: 'Offertanfrage ohne Entwurf',
        body: `${body.firstName} ${body.lastName} · ${lead.number} — der Entwurf konnte nicht automatisch erstellt werden.`,
        link: absoluteUrl(`/admin/leads/${lead.id}`),
        permission: 'lead:read',
      });
    }

    return created({ number: lead.number, quoteNumber, status: 'received' });
  },
});
