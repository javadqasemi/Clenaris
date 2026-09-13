import { NextResponse, type NextRequest } from 'next/server';

import { toErrorResponse } from '@/lib/api/response';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { LOCAL_MAX_BYTES, readLocalFile, receiveLocalUpload } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Der eingebaute Dateispeicher — Gegenstück zur signierten Adresse von
 * Supabase.
 *
 * **Warum diese Route von Hand geschrieben ist und nicht über `defineRoute`
 * läuft.** Jener Rahmen liest den Körper als JSON und prüft ihn gegen ein
 * Zod-Schema. Hier kommen rohe Bytes an — ein Bild, ein PDF. Es gibt nichts zu
 * parsen und nichts zu validieren ausser Grösse und Herkunft.
 *
 * **Warum es keine Sitzungsprüfung gibt.** Die Adresse *ist* die Berechtigung:
 * Sie entsteht in `/api/files/upload-url`, das die Anmeldung bereits geprüft
 * hat, enthält eine nicht erratbare `cuid` und lässt sich genau einmal und nur
 * innerhalb von zwei Stunden beschreiben. Genau so verhält sich die signierte
 * Adresse von Supabase auch — der Browser, der dorthin hochlädt, schickt keine
 * Sitzung mit.
 */

/** PUT — die Datei entgegennehmen. */
export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;

    /**
     * Die angekündigte Länge zuerst prüfen, bevor der Körper gelesen wird:
     * Sonst zöge die Anwendung erst fünfzig Megabyte in den Speicher, um sie
     * anschliessend abzulehnen.
     */
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (declared > LOCAL_MAX_BYTES) {
      throw new ValidationError(
        `Die Datei ist zu gross (max. ${Math.round(LOCAL_MAX_BYTES / 1024 / 1024)} MB ohne eingerichteten Dateispeicher).`,
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
 * GET — die Datei ausliefern.
 *
 * Öffentlich lesbar, wie ein öffentlicher Bucket bei Supabase: Profilbilder
 * und Einsatzfotos erscheinen in E-Mails und PDF-Berichten, die keine Sitzung
 * mitbringen. Der Schutz liegt in der nicht erratbaren Adresse.
 *
 * `immutable` im Zwischenspeicher ist hier ehrlich: Eine Adresse wird genau
 * einmal beschrieben. Ein geändertes Profilbild bekommt eine neue.
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const file = await readLocalFile(id);

    if (!file.data) throw new NotFoundError('Datei');

    return new NextResponse(new Uint8Array(file.data), {
      status: 200,
      headers: {
        'Content-Type': file.mimeType,
        'Content-Length': String(file.sizeBytes),
        'Cache-Control': 'public, max-age=31536000, immutable',
        // Verhindert, dass ein hochgeladenes SVG oder HTML im Kontext der
        // eigenen Domain ausgeführt wird.
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
