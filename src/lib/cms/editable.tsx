import 'server-only';

import * as React from 'react';

import { contentList, contentText, type ContentMap } from '@/server/services/content.service';

/**
 * Redaktionelle Texte so ausgeben, dass sie in der Vorschau anklickbar sind.
 *
 * **Das Problem.** Die Redaktion pflegte Texte in einer Maske und sah das
 * Ergebnis daneben in der Vorschau. Zwischen beiden musste sie selbst
 * übersetzen: Welches Feld gehört zu dieser Überschrift? Bei zwanzig
 * Bausteinen geht das noch, bei jedem weiteren wird es zum Suchspiel.
 *
 * **Die Lösung.** Im Vorschaumodus bekommt jeder gepflegte Text eine
 * Markierung mit seinem Schlüssel. Die Redaktionsmaske hört auf Klicks in der
 * Vorschau und öffnet genau das zugehörige Feld. Man zeigt auf den Text, den
 * man ändern will — statt ihn in einer Liste zu suchen.
 *
 * **Warum das die ausgelieferte Seite nicht anfasst.** Ohne Vorschaumodus gibt
 * `text()` die blosse Zeichenkette zurück, exakt wie vorher. Kein zusätzliches
 * Element, kein Attribut, kein Byte. Die Markierungen existieren nur für
 * angemeldete Redaktion mit gesetztem Vorschau-Cookie — Besucherinnen und
 * Besucher sehen dasselbe HTML wie zuvor.
 */
export interface Cms {
  /**
   * Text ausgeben — in der Vorschau in eine anklickbare Hülle gepackt.
   *
   * Rückgabetyp ist `ReactNode`, nicht `string`: Wo ein String verlangt ist
   * (ein `title`-Attribut, eine Eigenschaft einer Komponente), nimmt man
   * `raw()` und markiert stattdessen das umgebende Element mit `attrs()`.
   */
  text(key: string): React.ReactNode;
  /** Der reine Text, ohne Hülle — für Eigenschaften und Attribute. */
  raw(key: string): string;
  /** Listenbaustein. Die Liste wird als Ganzes bearbeitet, nicht je Eintrag. */
  list(key: string): string[];
  /**
   * Markierung für ein umgebendes Element.
   *
   * Für die Fälle, in denen der Text nicht als Kind steht: Aufzählungen,
   * Eigenschaften von Komponenten, Bilder.
   */
  attrs(key: string): Record<string, string>;
  /**
   * Markierung für ein Bild, das an einem Datensatz hängt.
   *
   * **Warum Bilder nicht einfach Textbausteine sind.** Die Bilder der Website
   * gehören nicht der Seite, sondern einem Objekt: das Vorher-/Nachher-Paar
   * einem Galerieeintrag, das Kopfbild einer Leistung, das Titelbild einem
   * Beitrag. Legte man sie als Bausteine ab, gäbe es dieselbe Adresse zweimal —
   * einmal am Datensatz, einmal im Baustein — und die beiden liefen
   * auseinander, sobald jemand die Galerie pflegt.
   *
   * Deshalb trägt die Markierung nicht einen Baustein-Schlüssel, sondern die
   * Anschrift des Datensatzfeldes. Die Maske schreibt damit dorthin, wo das
   * Bild ohnehin steht — und die Redaktion muss trotzdem nicht wissen, dass es
   * die Galerieverwaltung überhaupt gibt.
   */
  asset(entity: CmsAssetEntity, id: string | null | undefined, field: string): Record<string, string>;
  /** Läuft die Seite gerade im Vorschaumodus? */
  readonly preview: boolean;
}

/** Datensätze, deren Bilder aus der Vorschau heraus austauschbar sind. */
export type CmsAssetEntity = 'galleryItem' | 'service' | 'blogPost';

export function createCms(content: ContentMap, preview: boolean): Cms {
  return {
    preview,

    raw: (key) => contentText(content, key),

    list: (key) => contentList(content, key),

    attrs: (key) => (preview ? { 'data-cms-key': key } : ({} as Record<string, string>)),

    /**
     * Ohne `id` gibt es nichts zu bearbeiten — dann steht auf der Seite ein
     * Platzhalter, weil noch kein Galerieeintrag gepflegt ist. Eine Markierung
     * hiesse dort „hier lässt sich etwas ändern", und der Klick liefe ins
     * Leere.
     */
    asset: (entity, id, field) =>
      preview && id
        ? { 'data-cms-asset': `${entity}:${id}:${field}` }
        : ({} as Record<string, string>),

    text: (key) => {
      const value = contentText(content, key);
      if (!preview) return value;

      /**
       * `<span>` und nicht etwa ein `<div>`: Der Text steht in Überschriften,
       * Absätzen und Aufzählungen. Ein Element auf Blockebene würde dort das
       * Layout verändern — und eine Vorschau, die anders aussieht als die
       * Seite, ist keine.
       */
      return (
        <span data-cms-key={key} className="cms-editable">
          {value}
        </span>
      );
    },
  };
}
