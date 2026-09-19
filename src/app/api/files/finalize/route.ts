import { definePublicRoute } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { finalizeUploadSchema } from '@/lib/validation/files';
import { finalizeUpload } from '@/server/services/file.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';
/**
 * Beim externen Treiber lädt der Server das Objekt zurück. Bei einer grossen
 * Datei über eine langsame Verbindung dauert das; die Vorgabe von 15 Sekunden
 * wäre knapp.
 */
export const maxDuration = 60;

/**
 * POST /api/files/finalize
 *
 * Schliesst einen Upload ab — und *erst* das macht aus abgelegten Bytes eine
 * Datei, mit der die Anwendung arbeitet.
 *
 * **Warum es diesen Schritt überhaupt gibt.** Der Browser lädt direkt zum
 * Objektspeicher hoch, an der Anwendung vorbei. Das ist gewollt: Es umgeht
 * das Body-Limit serverloser Funktionen und hält grosse Baustellenfotos
 * schnell. Der Preis war, dass der Server die Datei nie zu sehen bekam — er
 * übernahm, was der Client über sie behauptete. Dieser Endpunkt holt das
 * Ansehen nach, ohne den Upload-Weg zu ändern: Er liest die tatsächlich
 * gespeicherten Bytes zurück, prüft Grösse, Signatur und Typ gegen das
 * Profil des Tickets, bildet die Prüfsumme und legt danach das `FileAsset`
 * an.
 *
 * **Ein erfolgreicher Upload ist noch keine angenommene Datei.** Solange
 * dieser Aufruf nicht durchgelaufen ist, trägt die Ablage keine Prüfsumme
 * und es gibt kein `FileAsset`. Ohne das lässt sich die Datei nirgends
 * verknüpfen und über die Ausgaberoute auch nicht abrufen.
 *
 * **Ohne Anmeldung nur dort, wo auch die Adresse ohne Anmeldung entsteht.**
 * Buchungsfoto und Bewerbungsunterlage kommen aus öffentlichen Formularen.
 * Der Dienst gleicht ab, dass ein Ticket mit hinterlegter Urheberschaft auch
 * nur von dieser Anmeldung abgeschlossen werden kann.
 */
export const POST = definePublicRoute({
  body: finalizeUploadSchema,
  /**
   * `fileTransfer`, nicht `fileUpload`. Die Menge der Uploads begrenzt das
   * Ticket, und das wurde beim Anfordern gezählt; hier geht es nur um das
   * Tempo — der Abschluss liest beim externen Speicher ein Objekt zurück.
   * Lägen beide auf demselben Zähler, wäre die tatsächliche Obergrenze ein
   * Drittel der Zahl, die in `rate-limit.ts` steht.
   */
  rateLimit: 'fileTransfer',
  handler: async ({ body, session, ip }) => {
    const ergebnis = await finalizeUpload({
      ticketId: body.ticketId,
      organizationId: await getOrganizationId(),
      session,
      filename: body.filename,
      ip,
    });

    return created({
      id: ergebnis.fileAssetId,
      url: ergebnis.url,
      checksum: ergebnis.checksum,
      sizeBytes: ergebnis.sizeBytes,
      mimeType: ergebnis.mimeType,
    });
  },
});
