/**
 * Welche Bildfelder aus der Website-Vorschau heraus austauschbar sind.
 *
 * **Warum eine feste Liste.** Der Aufruf an den Server nennt Tabelle und
 * Spalte. Ohne Liste wäre das eine offene Einladung, in jedes Feld jeder
 * Tabelle zu schreiben — `{ entity: 'user', field: 'role' }` genügte. Was hier
 * nicht steht, existiert für diesen Weg nicht.
 *
 * **Warum die Liste nicht im Dienst liegt.** Server und Maske brauchen sie
 * beide: der Dienst, um zu entscheiden, wohin geschrieben werden darf; die
 * Maske, um das Feld zu benennen, das die Redaktion gerade angeklickt hat.
 * Zwei Kopien liefen auseinander, und der sichtbare Schaden wäre eine Maske,
 * die ein Feld anbietet, das der Server längst ablehnt. Die Datei trägt
 * bewusst kein `server-only`.
 *
 * Sicherheitshinweis: Dass die Liste auch im Browser liegt, ändert nichts an
 * ihrer Wirkung. Geprüft wird ausschliesslich auf dem Server; die Fassung im
 * Browser beschriftet nur.
 */
export const ASSET_FIELDS = {
  galleryItem: {
    label: 'Galerieeintrag',
    fields: { beforeUrl: 'Bild „vorher"', afterUrl: 'Bild „nachher"' },
  },
  service: {
    label: 'Leistung',
    fields: { heroImage: 'Kopfbild' },
  },
  blogPost: {
    label: 'Beitrag',
    fields: { coverImage: 'Titelbild' },
  },
} as const;

export type CmsAssetEntity = keyof typeof ASSET_FIELDS;

/** Ist diese Anschrift überhaupt vorgesehen? */
export function isAssetField(entity: string, field: string): boolean {
  const table = ASSET_FIELDS[entity as CmsAssetEntity];
  return Boolean(table && field in table.fields);
}

/** Bezeichnung für die Maske, z. B. „Galerieeintrag — Bild ‚vorher'". */
export function assetFieldLabel(entity: string, field: string): string | null {
  const table = ASSET_FIELDS[entity as CmsAssetEntity];
  if (!table) return null;
  const name = (table.fields as Record<string, string>)[field];
  return name ? `${table.label} — ${name}` : null;
}
