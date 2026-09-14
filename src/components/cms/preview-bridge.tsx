'use client';

import * as React from 'react';

/**
 * Die Brücke zwischen Vorschau und Redaktionsarbeitsplatz.
 *
 * Läuft ausschliesslich im Vorschaumodus und ausschliesslich *innerhalb* des
 * Rahmens. Sie macht vier Dinge:
 *
 *  1. Markierte Texte beim Überfahren hervorheben, damit sichtbar wird, was
 *     überhaupt bearbeitbar ist.
 *  2. Einfache Texte beim Klick **direkt in der Seite** beschreibbar machen
 *     und den fertigen Wortlaut an den Arbeitsplatz melden — der speichert ihn
 *     als Entwurf.
 *  3. Bausteine, die sich nicht in der Seite tippen lassen (Listen, Texte mit
 *     Platzhalter, Bilder), beim Klick an den Arbeitsplatz melden — und den
 *     Klick abfangen, damit ein bearbeitbarer Text in einem Verweis nicht die
 *     Vorschau wegnavigiert.
 *  4. Auf Zuruf des Arbeitsplatzes ein Element hervorheben und in den
 *     sichtbaren Bereich holen.
 *
 * **Warum direkt in der Seite und nicht in einer Maske daneben.** Eine
 * Überschrift beurteilt man dort, wo sie steht: in ihrer Schrift, ihrer
 * Breite, neben ihrem Bild. Eine Maske daneben zwingt zum Blickwechsel und
 * dazu, im Kopf zu übersetzen, welches Feld zu welcher Zeile gehört. Wer in
 * die Zeile selbst schreibt, sieht sofort, ob sie umbricht.
 *
 * **Warum trotzdem nicht alles inline.** Eine Liste besteht aus mehreren
 * Einträgen mit Symbolen dazwischen, ein Text mit `{datum}` zeigt in der
 * Vorschau nicht seinen Wortlaut, sondern das eingesetzte Datum. Wer dort
 * tippte, zerstörte entweder das Markup oder den Platzhalter. Diese
 * Bausteine tragen die Markierung am *umgebenden* Element (`cms.attrs`)
 * statt als eigene Hülle (`cms.text`) — genau daran erkennt die Brücke, dass
 * sie den Klick weiterreicht statt ihn selbst zu behandeln.
 *
 * **Warum `postMessage` und nicht ein direkter Zugriff auf `window.parent`.**
 * Beide Seiten liegen zwar auf derselben Domain, ein direkter Griff über die
 * Rahmengrenze wäre also technisch möglich. Er koppelt aber zwei Bäume fest
 * aneinander: Die Vorschau müsste wissen, welche Funktion sie drüben aufruft.
 * Mit Nachrichten kennt jede Seite nur ihr eigenes Vokabular — und die Vorschau
 * funktioniert unverändert, wenn sie in einem eigenen Tab geöffnet wird, wo es
 * gar kein übergeordnetes Fenster gibt. Dort ist sie dann reine Ansicht: Ohne
 * Gegenstelle gäbe es niemanden, der die Änderung speichert, und ein Text, der
 * sich tippen, aber nicht sichern lässt, ist eine Falle.
 *
 * **Warum das Speichern beim Arbeitsplatz bleibt.** Die Brücke könnte den
 * Endpunkt selbst aufrufen — dieselbe Domain, dieselben Cookies. Dann gäbe es
 * aber zwei Stellen, die Rückmeldungen zeigen, Entwürfe zählen und die Seite
 * neu laden. Die Brücke meldet nur, was geändert wurde, und bekommt zurück, ob
 * es angenommen wurde. Abgewiesene Änderungen stellt sie im Text wieder her,
 * damit die Vorschau nie etwas zeigt, das nicht gespeichert ist.
 *
 * **Warum der Klick abgefangen wird.** Redaktionelle Texte stehen in
 * Überschriften, aber auch in Schaltflächen und Verweisen. Ohne
 * `preventDefault` würde ein Klick auf den Text einer Schaltfläche die
 * Vorschau auf eine andere Seite führen — und die Redaktion verlöre die
 * Stelle, die sie gerade bearbeiten wollte.
 */

/** Gemeinsames Vokabular beider Seiten. */
export const CMS_MESSAGE = {
  /** Vorschau → Arbeitsplatz: „dieser Baustein braucht eine Maske". */
  select: 'clenaris:cms:select',
  /** Vorschau → Arbeitsplatz: „dieses Bild wurde angeklickt". */
  asset: 'clenaris:cms:asset',
  /** Vorschau → Arbeitsplatz: „ich bin bereit". */
  ready: 'clenaris:cms:ready',
  /** Vorschau → Arbeitsplatz: „dieser Text wurde in der Seite geändert" — mit dem neuen Wortlaut. */
  change: 'clenaris:cms:change',
  /**
   * Vorschau → Arbeitsplatz: „dieser Text wird gerade getippt" — mit der
   * Zeichenzahl, damit der Arbeitsplatz die Grenze daneben zeigen kann.
   * `key: null` heisst: Bearbeitung beendet.
   */
  editing: 'clenaris:cms:editing',
  /** Arbeitsplatz → Vorschau: „hebe dieses Feld hervor". */
  highlight: 'clenaris:cms:highlight',
  /** Arbeitsplatz → Vorschau: „die Änderung ist als Entwurf gespeichert". */
  saved: 'clenaris:cms:saved',
  /** Arbeitsplatz → Vorschau: „die Änderung wurde abgewiesen" — der alte Text kehrt zurück. */
  rejected: 'clenaris:cms:rejected',
} as const;

interface ActiveEdit {
  element: HTMLElement;
  key: string;
  kind: string;
  /** Wortlaut vor der Bearbeitung — für Esc und für abgewiesene Änderungen. */
  original: string;
}

export function CmsPreviewBridge() {
  React.useEffect(() => {
    const inFrame = window.parent !== window;

    const post = (payload: Record<string, unknown>) => {
      if (!inFrame) return;
      // Zielursprung ausdrücklich: `'*'` würde die Nachricht an jede Seite
      // ausliefern, die diesen Rahmen zufällig einbettet.
      window.parent.postMessage(payload, window.location.origin);
    };

    /** Der Text, in dem gerade getippt wird. */
    let active: ActiveEdit | null = null;
    /**
     * Änderungen, die zum Arbeitsplatz unterwegs sind: Schlüssel → Element
     * und alter Wortlaut. Wird die Änderung abgewiesen, kehrt der alte Text
     * zurück; bis dahin ist das Element gedämpft dargestellt.
     */
    const pending = new Map<string, { element: HTMLElement; original: string }>();

    /**
     * Bilder werden zuerst gesucht: Ein Bild kann innerhalb eines markierten
     * Textblocks liegen, umgekehrt nicht. Ohne diese Reihenfolge fiele der
     * Klick auf das Bild auf den umgebenden Text zurück.
     */
    const findTarget = (start: EventTarget | null): HTMLElement | null => {
      if (!(start instanceof Element)) return null;
      return start.closest<HTMLElement>('[data-cms-asset], [data-cms-key]');
    };

    /**
     * Lässt sich dieser Text direkt in der Seite tippen?
     *
     * Nur die eigene Hülle aus `cms.text()` — sie enthält nichts als den
     * Wortlaut. Und nicht innerhalb einer Schaltfläche: Browser lassen in
     * einem `<button>` keinen Cursor setzen, der Text sähe beschreibbar aus
     * und wäre es nicht. Solche Bausteine gehen den Weg über die Maske.
     */
    const isInline = (element: HTMLElement) =>
      inFrame &&
      element.classList.contains('cms-editable') &&
      element.closest('button, input, select, textarea') === null;

    /**
     * Den getippten Wortlaut lesen.
     *
     * `innerText` statt `textContent`: Nur `innerText` übersetzt die
     * Zeilenumbrüche, die der Browser beim Tippen einfügt, zuverlässig in
     * `\n`. Der Browser hängt am Ende gern einen leeren Umbruch an — der
     * gehört nicht zum Text. Eine einzeilige Überschrift darf gar keinen
     * Umbruch enthalten; eingefügte (etwa aus der Zwischenablage) werden zu
     * Leerzeichen.
     */
    const readValue = (element: HTMLElement, kind: string) => {
      let value = element.innerText.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
      if (kind === 'line') value = value.replace(/\s*\n\s*/g, ' ');
      return value;
    };

    const markActive = (element: HTMLElement) => {
      document
        .querySelectorAll('.cms-editable--active')
        .forEach((node) => node.classList.remove('cms-editable--active'));
      element.classList.add('cms-editable--active');
    };

    /**
     * Bearbeitung beenden, ohne den Text anzufassen.
     *
     * `active` wird als Erstes gelöscht: Das Entfernen von `contenteditable`
     * kann ein `blur` auslösen, und dessen Behandlung darf dann nicht ein
     * zweites Mal speichern.
     */
    const stopEditing = () => {
      if (!active) return;
      const { element } = active;
      active = null;

      element.removeEventListener('keydown', onKeyDown);
      element.removeEventListener('input', onInput);
      element.removeEventListener('blur', onBlur);
      element.removeEventListener('paste', onPaste);
      element.removeAttribute('contenteditable');
      element.classList.remove('cms-editable--editing');

      post({ type: CMS_MESSAGE.editing, key: null });
    };

    const cancelEditing = () => {
      if (!active) return;
      const { element, original } = active;
      stopEditing();
      element.textContent = original;
    };

    /**
     * Bearbeitung abschliessen und die Änderung melden.
     *
     * Der Text bleibt so stehen, wie er getippt wurde — gedämpft, bis der
     * Arbeitsplatz ihn bestätigt. Ein unveränderter Text löst nichts aus:
     * Sonst stünde im Prüfprotokoll ein Vorgang, der nichts geändert hat.
     */
    const commit = () => {
      if (!active) return;
      const { element, key, kind, original } = active;
      const value = readValue(element, kind);
      stopEditing();

      // Normalisiert zurückschreiben: ohne den angehängten Umbruch, ohne
      // Umbrüche in einer Zeile.
      element.textContent = value;
      if (value === original) return;

      pending.set(key, { element, original });
      element.classList.add('cms-editable--pending');
      post({ type: CMS_MESSAGE.change, key, value });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!active) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        cancelEditing();
        return;
      }

      if (event.key === 'Enter') {
        // Umschalt+Enter fügt in mehrzeiligen Texten einen Umbruch ein. In
        // einer Überschrift gibt es keinen — dort schliesst jedes Enter ab.
        if (event.shiftKey && active.kind !== 'line') return;
        event.preventDefault();
        commit();
      }
    };

    const onInput = () => {
      if (!active) return;
      post({
        type: CMS_MESSAGE.editing,
        key: active.key,
        length: readValue(active.element, active.kind).length,
      });
    };

    const onBlur = () => commit();

    /**
     * Nur nötig, wo der Browser `plaintext-only` nicht kennt: Dort landete
     * sonst das Markup der Zwischenablage — Schriftgrösse, Farbe, Verweise —
     * mitten in der Überschrift.
     */
    const onPaste = (event: ClipboardEvent) => {
      if (active?.element.contentEditable === 'plaintext-only') return;
      event.preventDefault();
      const text = event.clipboardData?.getData('text/plain') ?? '';
      document.execCommand('insertText', false, text);
    };

    const startEditing = (element: HTMLElement) => {
      if (active?.element === element) return;
      if (active) commit();

      const key = element.dataset.cmsKey ?? '';
      if (!key) return;

      active = {
        element,
        key,
        kind: element.dataset.cmsKind ?? 'text',
        original: element.textContent ?? '',
      };

      // `plaintext-only` hält Markup fern; wo der Browser es nicht kennt,
      // bleibt die Zuweisung wirkungslos und `true` mit dem Einfüge-Filter
      // oben übernimmt.
      element.contentEditable = 'plaintext-only';
      if (element.contentEditable !== 'plaintext-only') element.contentEditable = 'true';

      element.classList.remove('cms-editable--pending');
      element.classList.add('cms-editable--editing');
      element.addEventListener('keydown', onKeyDown);
      element.addEventListener('input', onInput);
      element.addEventListener('blur', onBlur);
      element.addEventListener('paste', onPaste);
      markActive(element);

      /*
        Den ganzen Text markieren: Der Klick, der die Bearbeitung startet,
        wurde abgefangen und hat keinen Cursor gesetzt. Eine Gesamtauswahl
        erlaubt das Häufigste — den Text ersetzen — ohne weiteren Handgriff;
        wer nur ein Wort ändern will, klickt erneut an die Stelle.
      */
      element.focus();
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);

      post({ type: CMS_MESSAGE.editing, key, length: active.original.length });
    };

    const onClick = (event: MouseEvent) => {
      // Ein Klick in den Text, der gerade bearbeitet wird, setzt nur den
      // Cursor — dafür braucht der Browser sein Standardverhalten.
      if (active && event.target instanceof Node && active.element.contains(event.target)) return;

      const target = findTarget(event.target);
      if (!target) return;

      event.preventDefault();
      event.stopPropagation();

      const asset = target.dataset.cmsAsset;
      if (asset) {
        if (active) commit();
        // Anschrift des Feldes: `entity:id:feld`. Die Kennung selbst kann
        // keinen Doppelpunkt enthalten, das Feld ebenso wenig.
        const [entity, id, field] = asset.split(':');
        post({ type: CMS_MESSAGE.asset, entity, id, field });
        markActive(target);
        return;
      }

      if (isInline(target)) {
        startEditing(target);
        return;
      }

      if (active) commit();
      post({ type: CMS_MESSAGE.select, key: target.dataset.cmsKey });
      markActive(target);
    };

    const onOver = (event: MouseEvent) => {
      const target = findTarget(event.target);
      if (target && target !== active?.element) target.classList.add('cms-editable--hover');
    };

    const onOut = (event: MouseEvent) => {
      const target = findTarget(event.target);
      if (target) target.classList.remove('cms-editable--hover');
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const type = event.data?.type;
      const key = String(event.data?.key ?? '');

      if (type === CMS_MESSAGE.highlight) {
        const element = document.querySelector<HTMLElement>(
          `[data-cms-key="${CSS.escape(key)}"]`,
        );
        if (!element) return;
        markActive(element);
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }

      if (type === CMS_MESSAGE.saved || type === CMS_MESSAGE.rejected) {
        const entry = pending.get(key);
        if (!entry) return;
        pending.delete(key);
        entry.element.classList.remove('cms-editable--pending');
        if (type === CMS_MESSAGE.rejected) entry.element.textContent = entry.original;
      }
    };

    // `capture`, damit der Klick vor jedem Verweis und jeder Schaltfläche
    // ankommt — sonst hat die Seite bereits navigiert.
    document.addEventListener('click', onClick, true);
    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
    window.addEventListener('message', onMessage);

    document.documentElement.classList.add('cms-preview');
    if (inFrame) document.documentElement.classList.add('cms-preview--live');
    post({ type: CMS_MESSAGE.ready });

    return () => {
      cancelEditing();
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mouseout', onOut);
      window.removeEventListener('message', onMessage);
      document.documentElement.classList.remove('cms-preview', 'cms-preview--live');
    };
  }, []);

  return null;
}
