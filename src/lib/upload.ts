import { api } from '@/lib/api/client';
import type { UploadProfileName } from '@/lib/validation/files';

/**
 * Eine Datei hochladen — der eine Weg, den alle Masken nehmen.
 *
 * **Warum das jetzt an einer Stelle steht.** Sieben Komponenten führten
 * denselben Ablauf je für sich: Adresse anfordern, hochladen, Ergebnis
 * melden. Drei Zeilen Unterschied genügten, und ein Weg liess einen Schritt
 * aus — genau so entstand die Lage, dass fünf von sieben Uploads nie ein
 * `FileAsset` bekamen und keiner je serverseitig geprüft wurde.
 *
 * Der Ablauf hat drei Schritte, und der dritte ist der entscheidende:
 *
 *  1. **Ticket holen.** Der Server wählt Pfad und Obergrenze und legt eine
 *     Zeile an, gegen die er später prüfen kann.
 *  2. **Hochladen.** Direkt zum Objektspeicher, an der Anwendung vorbei —
 *     das bleibt so, es umgeht das Body-Limit serverloser Funktionen.
 *  3. **Abschliessen.** Der Server liest die abgelegten Bytes zurück, prüft
 *     Grösse, Signatur und Typ, bildet die Prüfsumme und legt das
 *     `FileAsset` an.
 *
 * Erst nach Schritt 3 existiert die Datei fachlich. Wer die Adresse aus
 * Schritt 1 direkt an ein Fachobjekt hängt, hängt dort etwas hin, das nie
 * geprüft wurde — deshalb gibt diese Funktion die Adresse aus Schritt 1 gar
 * nicht erst heraus.
 */

export interface HochgeladeneDatei {
  /** Die Kennung des `FileAsset` — das, was an ein Fachobjekt gehängt wird. */
  id: string;
  /** Die Abrufadresse. Erst nach dem Abschluss vorhanden. */
  url: string;
  checksum: string;
  sizeBytes: number;
  mimeType: string;
}

interface UploadZiel {
  ticketId: string;
  signedUrl: string;
  path: string;
}

export async function uploadFile(params: {
  file: Blob;
  profile: UploadProfileName;
  filename: string;
  /** Fachliche Zuordnung für den Ablagepfad, etwa die Einsatz-ID. */
  scopeId?: string;
}): Promise<HochgeladeneDatei> {
  const mimeType = params.file.type || 'application/octet-stream';

  const ziel = await api.post<UploadZiel>('/api/files/upload-url', {
    profile: params.profile,
    filename: params.filename,
    mimeType,
    sizeBytes: params.file.size,
    scopeId: params.scopeId,
  });

  const antwort = await fetch(ziel.signedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType, 'x-upsert': 'true' },
    body: params.file,
  });

  if (!antwort.ok) {
    /**
     * Die Rückfallebene antwortet mit der üblichen Fehlerhülle und einer
     * verständlichen Meldung („Die Datei ist leer", „Der Inhalt passt nicht
     * zum angegebenen Typ"). Supabase antwortet anders. Wo es eine Meldung
     * gibt, wird sie gezeigt — sie ist hilfreicher als jeder Platzhalter.
     */
    const meldung = await antwort
      .json()
      .then((k: { error?: { message?: string } }) => k?.error?.message)
      .catch(() => null);
    throw new Error(meldung ?? 'Der Upload wurde vom Speicher abgelehnt.');
  }

  return api.post<HochgeladeneDatei>('/api/files/finalize', {
    ticketId: ziel.ticketId,
    filename: params.filename,
  });
}
