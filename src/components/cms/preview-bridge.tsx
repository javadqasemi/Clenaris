'use client';

import * as React from 'react';

/**
 * Die Brücke zwischen Vorschau und Redaktionsmaske.
 *
 * Läuft ausschliesslich im Vorschaumodus und ausschliesslich *innerhalb* des
 * Rahmens. Sie macht drei Dinge:
 *
 *  1. Markierte Texte beim Überfahren hervorheben, damit sichtbar wird, was
 *     überhaupt bearbeitbar ist.
 *  2. Beim Klick die Maske im übergeordneten Fenster benachrichtigen — und den
 *     Klick abfangen, damit ein bearbeitbarer Text in einem Verweis nicht die
 *     Vorschau wegnavigiert.
 *  3. Auf Zuruf der Maske ein Element hervorheben und in den sichtbaren
 *     Bereich holen.
 *
 * **Warum `postMessage` und nicht ein direkter Zugriff auf `window.parent`.**
 * Beide Seiten liegen zwar auf derselben Domain, ein direkter Griff über die
 * Rahmengrenze wäre also technisch möglich. Er koppelt aber zwei Bäume fest
 * aneinander: Die Vorschau müsste wissen, welche Funktion sie drüben aufruft.
 * Mit Nachrichten kennt jede Seite nur ihr eigenes Vokabular — und die Vorschau
 * funktioniert unverändert, wenn sie in einem eigenen Tab geöffnet wird, wo es
 * gar kein übergeordnetes Fenster gibt.
 *
 * **Warum der Klick abgefangen wird.** Redaktionelle Texte stehen in
 * Überschriften, aber auch in Schaltflächen und Verweisen. Ohne
 * `preventDefault` würde ein Klick auf den Text einer Schaltfläche die
 * Vorschau auf eine andere Seite führen — und die Redaktion verlöre die
 * Stelle, die sie gerade bearbeiten wollte.
 */

/** Gemeinsames Vokabular beider Seiten. */
export const CMS_MESSAGE = {
  /** Vorschau → Maske: „dieses Feld wurde angeklickt". */
  select: 'clenaris:cms:select',
  /** Vorschau → Maske: „dieses Bild wurde angeklickt". */
  asset: 'clenaris:cms:asset',
  /** Vorschau → Maske: „ich bin bereit". */
  ready: 'clenaris:cms:ready',
  /** Maske → Vorschau: „hebe dieses Feld hervor". */
  highlight: 'clenaris:cms:highlight',
} as const;

export function CmsPreviewBridge() {
  React.useEffect(() => {
    const inFrame = window.parent !== window;

    const post = (payload: Record<string, unknown>) => {
      if (!inFrame) return;
      // Zielursprung ausdrücklich: `'*'` würde die Nachricht an jede Seite
      // ausliefern, die diesen Rahmen zufällig einbettet.
      window.parent.postMessage(payload, window.location.origin);
    };

    /**
     * Bilder werden zuerst gesucht: Ein Bild kann innerhalb eines markierten
     * Textblocks liegen, umgekehrt nicht. Ohne diese Reihenfolge fiele der
     * Klick auf das Bild auf den umgebenden Text zurück.
     */
    const findTarget = (start: EventTarget | null): HTMLElement | null => {
      if (!(start instanceof Element)) return null;
      return start.closest<HTMLElement>('[data-cms-asset], [data-cms-key]');
    };

    const onClick = (event: MouseEvent) => {
      const target = findTarget(event.target);
      if (!target) return;

      event.preventDefault();
      event.stopPropagation();

      const asset = target.dataset.cmsAsset;
      if (asset) {
        // Anschrift des Feldes: `entity:id:feld`. Die Kennung selbst kann
        // keinen Doppelpunkt enthalten, das Feld ebenso wenig.
        const [entity, id, field] = asset.split(':');
        post({ type: CMS_MESSAGE.asset, entity, id, field });
      } else {
        post({ type: CMS_MESSAGE.select, key: target.dataset.cmsKey });
      }

      markActive(target);
    };

    const onOver = (event: MouseEvent) => {
      const target = findTarget(event.target);
      if (target) target.classList.add('cms-editable--hover');
    };

    const onOut = (event: MouseEvent) => {
      const target = findTarget(event.target);
      if (target) target.classList.remove('cms-editable--hover');
    };

    const markActive = (element: HTMLElement) => {
      document
        .querySelectorAll('.cms-editable--active')
        .forEach((node) => node.classList.remove('cms-editable--active'));
      element.classList.add('cms-editable--active');
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== CMS_MESSAGE.highlight) return;

      const element = document.querySelector<HTMLElement>(
        `[data-cms-key="${CSS.escape(String(event.data.key))}"]`,
      );
      if (!element) return;

      markActive(element);
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };

    // `capture`, damit der Klick vor jedem Verweis und jeder Schaltfläche
    // ankommt — sonst hat die Seite bereits navigiert.
    document.addEventListener('click', onClick, true);
    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
    window.addEventListener('message', onMessage);

    document.documentElement.classList.add('cms-preview');
    post({ type: CMS_MESSAGE.ready });

    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mouseout', onOut);
      window.removeEventListener('message', onMessage);
      document.documentElement.classList.remove('cms-preview');
    };
  }, []);

  return null;
}
