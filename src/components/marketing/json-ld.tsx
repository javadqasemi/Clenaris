import { jsonLd } from '@/lib/json-ld';

/**
 * Der **einzige** Weg, strukturierte Daten ins HTML zu schreiben.
 *
 * Vorher stand in sieben Dateien je ein `<script type="application/ld+json">`
 * mit `dangerouslySetInnerHTML` und einer Linter-Ausnahme. Alle riefen
 * `jsonLd()` auf — aber nichts hinderte die achte Stelle daran, es zu
 * vergessen und einen Redaktionstext mit `</script>` roh hineinzuschreiben
 * (gespeichertes XSS; die Begründung steht in `lib/json-ld.ts`). Jetzt gibt
 * es genau eine Ausnahme, hier, und die Maskierung ist nicht mehr optional.
 *
 * `null` rendert nichts: Die Bauteile in `lib/seo/structured-data.ts` geben
 * `null` zurück, wenn es nichts Wahres zu sagen gibt (keine Fragen, keine
 * Bewertungen), und die Seite muss das nicht selbst abfragen.
 *
 * Kein `'use client'`: Der Block entsteht auf dem Server und enthält im
 * Vorschaumodus der Redaktion dieselben Bytes wie für Besuchende — die
 * CMS-Markierungen aus `createCms` gelangen nie hier hinein, weil die Seiten
 * Rohwerte aus der Datenbank übergeben, keine `cms.text()`-Knoten.
 */
export function JsonLd({ daten }: { daten: object | null | undefined }) {
  if (!daten) return null;
  return (
    <script
      type="application/ld+json"
      // eslint-disable-next-line react/no-danger -- einzige Stelle; `jsonLd()` maskiert `<`, `>`, `&`, U+2028/2029
      dangerouslySetInnerHTML={{ __html: jsonLd(daten) }}
    />
  );
}
