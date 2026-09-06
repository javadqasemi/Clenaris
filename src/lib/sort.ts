/**
 * Sortierung von Listenansichten.
 *
 * Architekturentscheid: Die Sortierung steht in der URL (`?sort=…&order=…`),
 * nicht im Komponentenzustand. Das kostet eine Navigation je Klick und bringt
 * dafür drei Dinge, die ein lokaler Zustand nicht kann: die Ansicht ist
 * teilbar, der Zurück-Knopf funktioniert, und — entscheidend — sortiert wird
 * in der *Datenbank* über alle Treffer statt im Browser über die gerade
 * sichtbaren fünfundzwanzig. Eine Sortierung, die nur die aktuelle Seite
 * ordnet, ist keine Sortierung, sondern eine Falle: Seite 2 beginnt dann
 * wieder von vorn.
 *
 * Die Whitelist ist Pflicht. `orderBy: { [feld]: … }` mit einem Wert aus der
 * Adresszeile wäre sonst ein Weg, nach beliebigen Spalten zu sortieren —
 * unkritisch bei Prisma (unbekannte Felder führen zu einem Fehler, nicht zu
 * einer Injektion), aber ein 500er für jeden manipulierten Link.
 */

export type SortOrder = 'asc' | 'desc';

export interface SortState {
  sort: string;
  order: SortOrder;
}

/** Spalte, nach der sortiert werden darf, mit ihrer natürlichen Richtung. */
export interface SortColumn {
  field: string;
  /**
   * Richtung beim ersten Klick.
   *
   * Für Datum und Betrag ist absteigend die erwartete Antwort auf „sortier
   * mir das": das Neueste und das Grösste zuerst. Für Namen aufsteigend.
   */
  defaultOrder: SortOrder;
}

/**
 * Sortierwunsch aus der Adresszeile auflösen.
 *
 * Unbekannte Felder und Richtungen fallen still auf den Standard zurück —
 * ein manipulierter Link soll die Liste nicht zerbrechen lassen.
 */
export function resolveSort(
  params: { sort?: string; order?: string },
  allowed: readonly string[],
  fallback: SortState,
): SortState {
  const sort = params.sort && allowed.includes(params.sort) ? params.sort : fallback.sort;
  const order: SortOrder =
    params.order === 'asc' || params.order === 'desc'
      ? params.order
      : sort === fallback.sort
        ? fallback.order
        : 'asc';
  return { sort, order };
}

/**
 * Sortierparameter in ein Prisma-`orderBy` übersetzen.
 *
 * Die zweite Spalte ist kein Schmuck: sortiert man nach einem Feld mit vielen
 * gleichen Werten — Status, Kategorie —, ist die Reihenfolge innerhalb einer
 * Gruppe ohne zweites Kriterium undefiniert. Beim Blättern erschiene dann
 * derselbe Datensatz auf zwei Seiten oder auf keiner.
 */
export function orderByFor(
  state: SortState,
  tiebreaker: string = 'id',
): Record<string, SortOrder>[] {
  if (state.sort === tiebreaker) return [{ [state.sort]: state.order }];
  return [{ [state.sort]: state.order }, { [tiebreaker]: 'desc' }];
}
