import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from 'pdf-lib';

/**
 * Kontrollierte PDF-Prüfobjekte.
 *
 * **Warum erzeugt und nicht mitgeliefert.** Ein Binärblob im Repository lässt
 * sich nicht lesen. Niemand sieht einer Datei an, ob sie drei Seiten hat, ob
 * sie eine Schriftart einbettet oder was für eine Aktion in ihrem Katalog
 * steht — und genau das sind die Eigenschaften, gegen die hier geprüft wird.
 * Ein Erzeuger aus zwanzig Zeilen sagt es im Klartext, kommt ohne neue
 * Abhängigkeit aus (`pdf-lib` ist bereits da) und liefert bei jedem Lauf
 * dieselben Bytes.
 */

/**
 * Ein mehrseitiges PDF mit sichtbarem, je Seite unterschiedlichem Text.
 *
 * Die Seitenzahl ist der Prüfwert: Der Viewer muss sie im Browser genau so
 * anzeigen. Der Text je Seite dient dem zweiten Nachweis — beim Blättern muss
 * sich das gerenderte Bild tatsächlich ändern, nicht nur die Ziffer in der
 * Werkzeugleiste.
 */
export async function mehrseitigesPdf(seiten: number, titel: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(titel);
  const schrift = await doc.embedFont(StandardFonts.Helvetica);
  const fett = await doc.embedFont(StandardFonts.HelveticaBold);

  for (let i = 1; i <= seiten; i++) {
    const seite = doc.addPage([595, 842]); // A4 hoch
    seite.drawText(titel, { x: 56, y: 760, size: 20, font: fett, color: rgb(0.06, 0.09, 0.16) });
    seite.drawText(`Seite ${i} von ${seiten}`, { x: 56, y: 720, size: 32, font: fett, color: rgb(0.02, 0.4, 0.42) });
    seite.drawText(
      'Prüfobjekt der Browser-Reihe. Der Inhalt je Seite unterscheidet sich, damit sich',
      { x: 56, y: 670, size: 11, font: schrift, color: rgb(0.3, 0.33, 0.38) },
    );
    seite.drawText('ein Seitenwechsel im gerenderten Bild nachweisen lässt.', {
      x: 56,
      y: 652,
      size: 11,
      font: schrift,
      color: rgb(0.3, 0.33, 0.38),
    });
    // Ein grosser gefüllter Block: damit ist „nicht leer" messbar, auch wenn
    // die Textschicht einmal anders gerastert würde.
    seite.drawRectangle({ x: 56, y: 320, width: 483, height: 280, color: rgb(0.02, 0.4, 0.42), opacity: 0.12 });
  }

  return Buffer.from(await doc.save());
}

/**
 * Ein PDF, das JavaScript ausführen *möchte* — Katalog-`/OpenAction` und ein
 * benannter `/JavaScript`-Baum, also beide Wege, die ein Betrachter kennt.
 *
 * **Wozu.** `pdf-viewer-inner.tsx` setzt `enableScripting: false` und
 * `isEvalSupported: false`. Das ist bisher eine Aussage über eine
 * Konfigurationszeile. Mit dieser Datei wird sie zur Beobachtung: PDF.js lädt
 * seine Skript-Sandbox (`pdf.sandbox.min.mjs`) erst, wenn Scripting
 * eingeschaltet ist — und `scripts/copy-pdfjs-assets.ts` kopiert sie gar nicht
 * erst nach `public/`. Bliebe die Option unbemerkt stehen, entstünde also eine
 * sichtbare Netzwerkanfrage, die es hier nie geben darf.
 *
 * Das eingebettete Skript ist absichtlich harmlos und ohne Nebenwirkung: Es
 * würde, wenn es liefe, nur einen Hinweis erzeugen. Ein Prüfobjekt muss
 * beweisen, dass nichts ausgeführt wird — es muss nicht gefährlich sein.
 */
export async function pdfMitJavaScript(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle('Prüfobjekt mit PDF-JavaScript');
  const schrift = await doc.embedFont(StandardFonts.Helvetica);
  const seite = doc.addPage([595, 842]);
  seite.drawText('Prüfobjekt mit eingebettetem PDF-JavaScript', {
    x: 56,
    y: 760,
    size: 16,
    font: schrift,
    color: rgb(0.06, 0.09, 0.16),
  });
  seite.drawText('Der Viewer darf hiervon nichts ausführen.', {
    x: 56,
    y: 730,
    size: 12,
    font: schrift,
    color: rgb(0.3, 0.33, 0.38),
  });

  const aktion = doc.context.register(
    doc.context.obj({
      Type: PDFName.of('Action'),
      S: PDFName.of('JavaScript'),
      JS: PDFString.of(
        'try { this.info.title = "AUSGEFUEHRT"; app.alert("AUSGEFUEHRT"); } catch (e) {}',
      ),
    }),
  );

  // Weg 1: beim Öffnen.
  doc.catalog.set(PDFName.of('OpenAction'), aktion);

  // Weg 2: als benanntes Skript im Dokumentbaum.
  doc.catalog.set(
    PDFName.of('Names'),
    doc.context.register(
      doc.context.obj({
        JavaScript: doc.context.obj({
          Names: doc.context.obj([PDFString.of('Pruefskript'), aktion]),
        }),
      }),
    ),
  );

  return Buffer.from(await doc.save());
}
