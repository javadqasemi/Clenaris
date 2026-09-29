import { definePublicRoute } from '@/lib/api/handler';
import { firmenVisitenkarte } from '@/server/services/visitenkarte.service';

export const runtime = 'nodejs';

/**
 * GET /api/public/kontakt/vcard — die Visitenkarte der Firma als `.vcf`
 * (Schaltfläche „Kontakt speichern" auf `/kontakt`).
 *
 * **Öffentlich, gedrosselt wie jede Leseanfrage** (`apiRead`): Die Datei
 * enthält nur, was die Fusszeile ohnehin zeigt; die Drosselung schützt die
 * Datenbank, nicht den Inhalt.
 *
 * **Zwischenspeicher: öffentlich, eine Stunde**, mit einem Tag
 * `stale-while-revalidate`. Die Firmendaten ändern sich selten, und die
 * Kontaktseite, die denselben Inhalt als QR-Code trägt, wird ebenfalls
 * stündlich neu erzeugt (`revalidate = 3600`) — die beiden laufen damit
 * höchstens eine Stunde auseinander. Länger wäre bei einer Nummernänderung
 * zu lang.
 *
 * **`attachment`**, weil die Datei gespeichert und nicht angezeigt werden
 * soll; iOS und Android bieten dann „Zu Kontakten hinzufügen" an. Der
 * Dateiname ist ASCII und frei von Anführungszeichen (`vcardDateiname`) —
 * er entsteht aus dem Firmennamen und darf den Kopf nicht aufbrechen.
 * `nosniff`, damit kein Browser aus `text/vcard` etwas anderes errät.
 *
 * Nichts aus der Anfrage fliesst in die Antwort: keine Abfrage, kein Host.
 */
export const GET = definePublicRoute({
  rateLimit: 'apiRead',
  handler: async () => {
    const { vcard, dateiname } = await firmenVisitenkarte();

    return new Response(vcard, {
      status: 200,
      headers: {
        'Content-Type': 'text/vcard; charset=utf-8',
        'Content-Disposition': `attachment; filename="${dateiname}"`,
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  },
});
