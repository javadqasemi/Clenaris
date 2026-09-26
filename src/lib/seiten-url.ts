/**
 * Was **bewusst zur Bauzeit** feststeht (V2-1, 2026-09-26).
 *
 * Die öffentliche Website wird statisch vorgerendert (Startseite, Leistungen,
 * Blog, Rechtliches, `sitemap.xml`, `robots.txt` — rund zwei Dutzend Wege).
 * Was dort im HTML steht, entsteht beim Bau, gleich wie es gelesen wird:
 * `metadataBase` (kanonische Adresse, `og:url`), die Organisationsangaben im
 * JSON-LD, die Einträge der Sitemap. Das liesse sich nur zur Laufzeit
 * erzeugen, indem die ganze Website dynamisch wird — jede Anfrage ein
 * Rendervorgang mit Datenbankzugriff, und kein Zwischenspeicher mehr vor ihr.
 *
 * Die Frage ist deshalb nicht „Bauzeit oder Laufzeit", sondern: **Hängt der
 * Wert an der Umgebung oder am Produkt?** Die kanonische Adresse der Website
 * ist die eine öffentliche Domain des Betriebs. Auch eine Probeumgebung, die
 * dasselbe Artefakt fährt, soll auf sie verweisen — das ist genau, wofür
 * `rel=canonical` da ist —, und sie gehört ohnehin mit `noindex` hinter den
 * Proxy (docs/PREPRODUCTION_READINESS.md). Dasselbe gilt für die
 * Google-Verifikation: Sie bestätigt den Besitz *dieser* Domain.
 *
 * Deshalb: Bauzeit, **ein** Wert für alle Umgebungen, im CI ausdrücklich auf
 * die Produktionsdomain gesetzt. Eine Umgebung braucht dafür keinen eigenen
 * Bau. Ändert sich die Domain selbst, ist ein neuer Bau nötig — wie bei jeder
 * anderen Änderung am Produkt.
 *
 * Alles andere — die Herkunft dieser Instanz für Links, Mails, Zahlungen,
 * Signaturen und die Herkunftsprüfung, die Analyse-Kennungen — steht in
 * `laufzeit-konfiguration.ts` und wird zur Laufzeit gelesen.
 *
 * Dies ist die **einzige** Datei, in der `process.env.NEXT_PUBLIC_…` im Code
 * stehen darf (Musterprüfung `bauzeit-oeffentlich`).
 */

function ohneSchraegstrich(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Kanonische Adresse der öffentlichen Website — Bauzeit, für alle Umgebungen gleich. */
export const SEITEN_URL: string = ohneSchraegstrich(
  process.env.NEXT_PUBLIC_SITE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
);

/** Google-Search-Console-Verifikation der kanonischen Domain — Bauzeit. */
export const GOOGLE_SITE_VERIFICATION: string | undefined = process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION || undefined;
