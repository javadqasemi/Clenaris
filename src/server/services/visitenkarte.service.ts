import 'server-only';

import { SEITEN_URL } from '@/lib/seiten-url';
import { absoluteSeitenUrl } from '@/lib/seo/metadaten';
import { vcardDateiname, vcardErzeugen } from '@/lib/kontakt/vcard';
import { getPublicCompanyInfo } from '@/server/services/organization.service';

/**
 * Die Visitenkarte der Firma — eine Quelle für den QR-Code auf `/kontakt`
 * und den Download `GET /api/public/kontakt/vcard`.
 *
 * Beide müssen byteweise dasselbe liefern: Wer den Code scannt und wer die
 * Datei lädt, soll denselben Kontakt speichern. Deshalb baut nur diese
 * Funktion die Eingabe für `vcardErzeugen`, und zwar Feld für Feld aus
 * `getPublicCompanyInfo()` — nie das ganze Objekt, das auch IBAN und
 * MWST-Nummer trägt.
 *
 * **Website.** Die gepflegte Adresse aus den Stammdaten (`website`), wenn es
 * eine gibt; sonst die kanonische Adresse der Website (`SEITEN_URL`, Bauzeit,
 * geprüft über `absoluteSeitenUrl`). Nie der `Host` einer Anfrage — die
 * Seite ist statisch vorgerendert, und eine Visitenkarte, die die Adresse
 * einer Probeumgebung trägt, wäre ein dauerhaft falscher Kontakt.
 */
export async function firmenVisitenkarte(): Promise<{ vcard: string; dateiname: string; firma: string }> {
  const firma = await getPublicCompanyInfo();

  const vcard = vcardErzeugen({
    name: firma.name,
    legalName: firma.legalName,
    phone: firma.phone,
    email: firma.email,
    url: firma.website || absoluteSeitenUrl('/', SEITEN_URL),
    address: {
      street: firma.address.street,
      postalCode: firma.address.postalCode,
      city: firma.address.city,
      canton: firma.address.canton,
      country: firma.address.country,
    },
  });

  return { vcard, dateiname: vcardDateiname(firma.name), firma: firma.name };
}
