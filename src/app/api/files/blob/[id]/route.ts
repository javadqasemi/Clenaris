import { NextResponse, type NextRequest } from 'next/server';

import { binaerAntwort } from '@/lib/api/binary-response';
import { toErrorResponse } from '@/lib/api/response';
import { getSession } from '@/lib/auth/session';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { LOCAL_MAX_BYTES, readLocalFile, receiveLocalUpload } from '@/lib/storage';
import { enforceRateLimit, getClientIp } from '@/lib/rate-limit';
import { sanitizeFilename } from '@/lib/storage';
import { describeUploadLimit } from '@/lib/validation/files';
import { authorizeStoredFile } from '@/server/services/file.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Der eingebaute Dateispeicher — Gegenstück zur signierten Adresse von
 * Supabase.
 *
 * **Warum diese Route von Hand geschrieben ist und nicht über `defineRoute`
 * läuft.** Jener Rahmen liest den Körper als JSON und prüft ihn gegen ein
 * Zod-Schema. Hier kommen rohe Bytes an — ein Bild, ein PDF. Es gibt nichts
 * zu parsen. Das Kontingent, das `defineRoute` sonst mitbringt, wird deshalb
 * von Hand angefordert.
 *
 * **Korrektur der früheren Begründung.** Hier stand: „Warum es keine
 * Sitzungsprüfung gibt. Die Adresse *ist* die Berechtigung … enthält eine
 * nicht erratbare `cuid`." Beides war falsch.
 *
 * Eine cuid ist kein Geheimnis. Nachgemessen an den Kennungen dieser
 * Datenbank: acht der 25 Zeichen sind der auf die Millisekunde genaue
 * Erstellungszeitpunkt, vier ein laufender Zähler, vier ein pro Prozess
 * konstanter Fingerabdruck — über 36 Zeilen kamen zwei verschiedene Werte
 * vor. Zufällig sind rund 41 Bit. Dazu gab es weder ein Kontingent noch
 * einen Protokolleintrag, dafür `Cache-Control: public, immutable`. Über
 * diesen Weg lagen Lebensläufe und Personaldokumente.
 *
 * Die Kennung ist jetzt eine Kennung. Wer lesen darf, entscheidet das
 * zugehörige `FileAsset` und dessen Beziehung zum Geschäftsobjekt
 * (`file.service.ts`). Wer schreiben darf, entscheidet das Upload-Ticket.
 */

/**
 * PUT — die Datei entgegennehmen.
 *
 * Das Ticket ist hier tatsächlich die Schreibberechtigung, und das ist etwas
 * anderes als eine Leseberechtigung: Es wurde serverseitig für genau einen
 * Pfad ausgestellt, ist zwei Stunden gültig und lässt sich genau einmal
 * beschreiben. Der Wert dessen, was jemand damit anrichten kann, ist eine
 * abgelehnte Datei — nicht der Inhalt einer fremden.
 *
 * Angenommen heisst die Datei damit noch nicht; das entscheidet
 * `POST /api/files/finalize`.
 */
export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    // `fileTransfer`, nicht `fileUpload`: Das Ticket, ohne das dieser Aufruf
    // nichts kann, wurde beim Anfordern bereits gezählt. Beides auf denselben
    // Zähler zu legen drittelte die tatsächliche Obergrenze.
    await enforceRateLimit('fileTransfer', getClientIp(request));

    const { id } = await context.params;

    /**
     * Die angekündigte Länge zuerst prüfen, bevor der Körper gelesen wird:
     * Sonst zöge die Anwendung erst einen halben Gigabyte in den Speicher, um
     * ihn anschliessend abzulehnen.
     */
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (declared > LOCAL_MAX_BYTES) {
      throw new ValidationError(
        `Die Datei ist zu gross (max. ${describeUploadLimit(LOCAL_MAX_BYTES)} ohne eingerichteten Dateispeicher).`,
      );
    }

    const body = await request.arrayBuffer();

    const result = await receiveLocalUpload({
      id,
      data: Buffer.from(body),
      mimeType: request.headers.get('content-type'),
    });

    return NextResponse.json({ data: result }, { status: 200 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * Welche Typen im Browserfenster angezeigt werden dürfen.
 *
 * Alles andere wird zum Herunterladen angeboten. `nosniff` verhindert, dass
 * der Browser einen Typ errät; diese Liste verhindert, dass er einen
 * angegebenen ausführt. Ein als `text/html` abgelegtes Dokument gibt es
 * nicht — kein Upload-Profil lässt den Typ zu —, aber die Entscheidung
 * hängt hier nicht an dieser Annahme.
 */
const INLINE_TYPEN = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/heic',
]);

/**
 * GET — die Datei ausliefern.
 *
 * Drei Ausgänge, und der Reihe nach:
 *
 *  • **Öffentliches Asset** (`FileAsset.isPublic`): Teambild, Galerie,
 *    Kopfbild, Firmenlogo. Sie stehen auf der Website und erscheinen in
 *    E-Mails; sie brauchen keine Sitzung und dürfen zwischengespeichert
 *    werden. Die Kennung schützt hier nichts und soll es auch nicht.
 *
 *  • **Private Datei**: Sitzung, gleiche Organisation, Rolle und tatsächliche
 *    Beziehung zum Geschäftsobjekt. Kein öffentlicher Zwischenspeicher.
 *
 *  • **Alles andere**: 404. Auch für eine Datei, die es gibt, die dieser
 *    Person aber nicht gehört — sonst wäre die Route ein Orakel dafür,
 *    welche Kennungen existieren.
 *
 * Extern geteilte Dateien gehen nicht über diesen Weg. Eine Rechnung, die
 * eine Kundin ohne Konto abruft, läuft über die Rechnungsroute mit ihrem
 * `PublicAccessToken`; die prüft Zweck und Ressource. Hier eine zweite,
 * schwächere Tür danebenzustellen, wäre genau der Fehler, den Gate 2
 * beseitigt.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;

    /**
     * Auch die Ausgabe bekommt ein Kontingent. Es ersetzt keine Prüfung —
     * die steht darunter — sondern begrenzt, wie schnell jemand Kennungen
     * durchprobieren kann, und schützt die Datenbank davor, grosse Blobs am
     * Stück auszuliefern.
     */
    await enforceRateLimit('fileDownload', getClientIp(request));

    /*
      Gerätesperre (2026-09-27). Diese Route ist von Hand gebaut und lief
      deshalb an der Sperre vorbei, die `defineRoute` durchsetzt: Wer das
      übergebene Gerät hielt, lud private Dateien mit der Sitzung des
      Personals. Eine gesperrte Sitzung gilt hier als **keine** Sitzung — wie
      in `definePublicRoute`: Öffentliches (das Logo auf der Abnahmeseite)
      bleibt erreichbar, Privates endet in 404. Ein 423 für alles hätte auch
      die öffentlichen Bilder der Abnahmeseite gesperrt.
    */
    const roheSitzung = await getSession();
    const session = roheSitzung?.handoffId ? null : roheSitzung;
    const freigabe = await authorizeStoredFile(id, session);
    if (!freigabe) throw new NotFoundError('Datei');

    const file = await readLocalFile(freigabe.storedFileId);
    if (!file.data) throw new NotFoundError('Datei');

    const inline = INLINE_TYPEN.has(freigabe.mimeType);
    // Der Name wird entschärft und in Anführungszeichen gesetzt. Ein
    // Zeilenumbruch oder ein Anführungszeichen im Namen wäre sonst der Weg,
    // einen zweiten Kopfzeileneintrag einzuschleusen.
    const name = sanitizeFilename(freigabe.filename);

    return binaerAntwort({
      bytes: file.data,
      mimeType: freigabe.mimeType,
      filename: name,
      disposition: inline ? 'inline' : 'attachment',
      request,
      /**
       * Öffentliche Assets dürfen lange liegen bleiben: Eine Adresse wird
       * genau einmal beschrieben, ein geändertes Bild bekommt eine neue.
       *
       * Private Dateien dürfen das nicht. `public, immutable` hiesse, dass
       * ein Lebenslauf ein Jahr lang in jedem Zwischenspeicher zwischen
       * Server und Browser liegen darf — auch in geteilten. Die Prüfung
       * oben wäre damit einmalig statt bei jedem Abruf.
       */
      cacheControl: freigabe.isPublic
        ? 'public, max-age=31536000, immutable'
        : 'private, no-store, max-age=0, must-revalidate',
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
