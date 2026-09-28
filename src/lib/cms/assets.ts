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

/**
 * Ist diese Anschrift überhaupt vorgesehen?
 *
 * **Nur eigene Schlüssel** (`Object.hasOwn`, 2026-09-27). Vorher prüften
 * `ASSET_FIELDS[entity]` und `field in …` auch die Prototypenkette:
 * `constructor`, `toString` oder `__proto__` bestanden die Liste, erreichten
 * Prisma und kamen als 500 zurück. Geschrieben wurde nichts — aber eine
 * Freigabeliste, die Namen durchlässt, die nicht auf ihr stehen, ist keine.
 */
export function isAssetField(entity: string, field: string): boolean {
  if (!Object.hasOwn(ASSET_FIELDS, entity)) return false;
  return Object.hasOwn(ASSET_FIELDS[entity as CmsAssetEntity].fields, field);
}

/** Bezeichnung für die Maske, z. B. „Galerieeintrag — Bild ‚vorher'". */
export function assetFieldLabel(entity: string, field: string): string | null {
  if (!isAssetField(entity, field)) return null;
  const table = ASSET_FIELDS[entity as CmsAssetEntity];
  return `${table.label} — ${(table.fields as Record<string, string>)[field]}`;
}
