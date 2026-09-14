/**
 * Prüfungen am ausgelieferten HTML.
 *
 * Bewusst über reguläre Ausdrücke statt über einen DOM-Parser. Zwei Gründe:
 * Es kommt keine Abhängigkeit in den Prüfpfad, und gesucht wird ohnehin nach
 * Klassennamen und Attributen — also nach Zeichenketten, nicht nach Struktur.
 * Wo eine echte Baumnavigation nötig wäre, gehört die Prüfung ohnehin in einen
 * Browsertest.
 */

/** Wie oft kommt ein Muster vor? */
export const countMatches = (html: string, pattern: RegExp): number =>
  (html.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)) ?? []).length;

/**
 * Rasterspuren, die sich nicht zusammenziehen können.
 *
 * `1fr` neben einer festen Spur weigert sich, unter die Breite seines Inhalts
 * zu schrumpfen, und schiebt die Nachbarn aus dem Rahmen — genau das Bild
 * einer „ausserhalb der Tabelle" stehenden Angabe. `minmax(0,1fr)` darf.
 */
export function unsafeGridTracks(html: string): string[] {
  const tracks = html.match(/grid-cols-\[[^\]]+\]/g) ?? [];
  return [
    ...new Set(
      tracks.filter((track) => {
        const stripped = track.replace(/minmax\(0,[^)]*\)/g, '');
        return (
          /\d+(\.\d+)?rem|\d+px|_auto|\[auto/.test(stripped) &&
          /(?:\[|_)\d*\.?\d*fr/.test(stripped)
        );
      }),
    ),
  ];
}

/** Feste Breiten, die den schmalsten Rahmen (320 px) sprengen. */
export function rigidWidths(html: string): string[] {
  return [
    ...new Set(
      (html.match(/\bw-\[(\d+)px\]/g) ?? []).filter(
        (match) => Number(/(\d+)/.exec(match)?.[1] ?? 0) > 320,
      ),
    ),
  ];
}

export const dataTableCount = (html: string) => countMatches(html, /class="[^"]*\bdata-table\b/);
export const hasHorizontalScroller = (html: string) => /overflow-x-auto/.test(html);

/** Der Inhalt des ersten `<title>`. */
export function pageTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  // React setzt zwischen statischem Text und eingesetzten Werten `<!-- -->`.
  return match ? match[1].replace(/<!--[\s\S]*?-->/g, '').trim() : null;
}

/** Der Inhalt eines `<meta name="…" content="…">`. */
export function metaContent(html: string, name: string): string | null {
  const pattern = new RegExp(
    `<meta[^>]+name=["']${name}["'][^>]*content=["']([^"']*)["']`,
    'i',
  );
  const reversed = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*name=["']${name}["']`,
    'i',
  );
  return (pattern.exec(html) ?? reversed.exec(html))?.[1] ?? null;
}

/** Alle `href`-Werte, die auf eigene Seiten zeigen. */
export function internalLinks(html: string): string[] {
  return [
    ...new Set(
      (html.match(/href="(\/[^"#?]*)"/g) ?? [])
        .map((match) => /href="([^"]*)"/.exec(match)?.[1] ?? '')
        .filter((href) => href.length > 0 && !href.startsWith('//')),
    ),
  ];
}

/**
 * Steht ein Text im HTML?
 *
 * Deckt die Umschreibung von `&`, `<`, `>` und den Anführungszeichen ab —
 * sonst scheitert die Suche nach „Mitarbeitende & Rollen" an genau dem
 * kaufmännischen Und.
 */
export function containsText(html: string, text: string): boolean {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return html.includes(text) || html.includes(escaped);
}
