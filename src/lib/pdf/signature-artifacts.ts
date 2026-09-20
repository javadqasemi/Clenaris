import 'server-only';

import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib';

import { ValidationError } from '@/lib/errors';

/**
 * PDF-Handgriffe für die Unterzeichnung — mit `pdf-lib`, und nur diese.
 *
 * **Was `pdf-lib` hier tut:** ein PDF laden, Seitenzahl und Seitenmasse
 * lesen, ein Unterschriftsbild oder einen getippten Namen an einer
 * geprüften Stelle zeichnen, eine Signaturseite anhängen, speichern.
 *
 * **Was es nicht tut und wofür es nicht ausgegeben wird:** Es prüft keine
 * kryptografische Signatur. Es validiert keine PAdES, keine QES, keine
 * Zertifikatskette, keinen `ByteRange`. Es kann AcroForm-Signaturfelder
 * *finden* — mehr nicht. Findet es keines, heisst das nicht, dass keine
 * Signatur existiert. Deshalb bekommen hochgeladene Dokumente
 * `DETACHED_EVIDENCE` (Original bleibt bytegenau), und nur Dokumente aus
 * Clenaris' eigener Erzeugung dürfen `EMBEDDED_VISUAL`.
 */

export interface PdfPageMasse {
  width: number;
  height: number;
  rotation: number;
}

export interface PdfBefund {
  pageCount: number;
  pages: PdfPageMasse[];
  /** AcroForm-Feld vom Typ `/Sig` gefunden. */
  hasSignatureFields: boolean;
  /** Irgendein Wörterbuch mit `/Type /Sig` oder `/ByteRange` — verdächtig, nicht bewiesen. */
  hasSignatureStructures: boolean;
  encrypted: boolean;
}

export async function inspectPdf(bytes: Buffer | Uint8Array): Promise<PdfBefund> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    throw new ValidationError('Die Datei lässt sich nicht als PDF lesen.');
  }

  const pages = doc.getPages().map((p) => ({
    width: p.getWidth(),
    height: p.getHeight(),
    rotation: p.getRotation().angle,
  }));

  let hasSignatureFields = false;
  try {
    for (const field of doc.getForm().getFields()) {
      const ft = field.acroField.dict.get(PDFName.of('FT'));
      if (ft === PDFName.of('Sig')) hasSignatureFields = true;
    }
  } catch {
    // Kein oder beschädigtes Formular — dann gibt es auch kein Feld zu finden.
  }

  let hasSignatureStructures = false;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = (obj as { dict?: unknown }).dict ?? obj;
    if (typeof (dict as { get?: unknown }).get !== 'function') continue;
    const d = dict as { get: (k: PDFName) => unknown };
    if (d.get(PDFName.of('Type')) === PDFName.of('Sig') || d.get(PDFName.of('ByteRange'))) {
      hasSignatureStructures = true;
      break;
    }
  }

  return {
    pageCount: pages.length,
    pages,
    hasSignatureFields,
    hasSignatureStructures,
    encrypted: doc.isEncrypted,
  };
}

export interface Placement {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Untergrenzen in Punkten — darunter ist nichts mehr lesbar. */
const MIN_WIDTH = 60;
const MIN_HEIGHT = 24;

/**
 * Eine Position gegen die tatsächliche Seite prüfen.
 *
 * Koordinaten sind PDF-Punkte im Koordinatensystem der Seite (Ursprung
 * unten links, so wie `pdf-lib` zeichnet). Gedrehte Seiten (`/Rotate`)
 * werden nicht umgerechnet — die Masse gelten für die ungedrehte
 * Medienbox, und genau so zeichnet `pdf-lib`. Wer auf einer gedrehten Seite
 * platziert, sieht das in der Vorschau.
 */
export function validatePlacement(p: Placement, befund: PdfBefund): void {
  if (!Number.isInteger(p.page) || p.page < 1 || p.page > befund.pageCount) {
    throw new ValidationError(`Seite ${p.page} gibt es nicht — das Dokument hat ${befund.pageCount}.`);
  }
  const seite = befund.pages[p.page - 1]!;
  for (const [name, wert] of Object.entries({ x: p.x, y: p.y, width: p.width, height: p.height })) {
    if (!Number.isFinite(wert) || wert < 0) throw new ValidationError(`Ungültiger Wert für ${name}.`);
  }
  if (p.width < MIN_WIDTH || p.height < MIN_HEIGHT) {
    throw new ValidationError('Das Unterschriftsfeld ist zu klein.');
  }
  if (p.width > seite.width / 2 || p.height > seite.height / 4) {
    throw new ValidationError('Das Unterschriftsfeld ist zu gross für die Seite.');
  }
  if (p.x + p.width > seite.width || p.y + p.height > seite.height) {
    throw new ValidationError('Das Unterschriftsfeld ragt über die Seite hinaus.');
  }
}

export interface UnterzeichnungFuerArtefakt {
  name: string;
  method: 'DRAWN' | 'TYPED';
  signedAt: Date;
  /** PNG-Bytes bei DRAWN. */
  imagePng?: Buffer | null;
  placement?: Placement | null;
}

export interface EmbeddedVisualInput {
  originalBytes: Buffer;
  requestId: string;
  publicId: string;
  title: string;
  originalHash: string;
  signers: UnterzeichnungFuerArtefakt[];
}

function zeit(d: Date): string {
  return new Intl.DateTimeFormat('de-CH', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Zurich',
  }).format(d);
}

/**
 * Das signierte Artefakt für EMBEDDED_VISUAL: Original + sichtbare
 * Unterschrift(en) + Signaturseite. Das Original wird geladen, nicht
 * verändert — das Ergebnis ist ein neues Dokument.
 *
 * Alle Unterzeichnenden auf einmal, erst wenn alle fertig sind: So gibt es
 * genau ein signiertes Artefakt und eine Hashkette A → B, nicht A → B → C
 * → D mit einem Zwischenstand je Person.
 */
export async function buildEmbeddedVisual(input: EmbeddedVisualInput): Promise<Buffer> {
  const doc = await PDFDocument.load(input.originalBytes, { updateMetadata: false });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const kursiv = await doc.embedFont(StandardFonts.HelveticaOblique);

  for (const s of input.signers) {
    if (!s.placement) continue;
    const page = doc.getPage(s.placement.page - 1);
    const { x, y, width, height } = s.placement;
    page.drawRectangle({ x, y, width, height, borderColor: rgb(0.55, 0.6, 0.65), borderWidth: 0.5 });
    if (s.method === 'DRAWN' && s.imagePng) {
      const img = await doc.embedPng(s.imagePng);
      const scale = Math.min((width - 8) / img.width, (height - 18) / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawImage(img, { x: x + (width - w) / 2, y: y + 14 + (height - 18 - h) / 2, width: w, height: h });
    } else {
      page.drawText(s.name, {
        x: x + 6,
        y: y + height / 2 - 2,
        size: Math.min(16, height / 2),
        font: kursiv,
        color: rgb(0.06, 0.09, 0.16),
      });
    }
    page.drawText(`${s.name} · elektronisch unterzeichnet ${zeit(s.signedAt)}`, {
      x: x + 4,
      y: y + 4,
      size: 6,
      font: helv,
      color: rgb(0.4, 0.45, 0.5),
    });
  }

  // Signaturseite — A4.
  const seite = doc.addPage([595.28, 841.89]);
  let cursor = 780;
  const zeile = (text: string, opts: { size?: number; bold?: boolean } = {}) => {
    seite.drawText(text, {
      x: 56,
      y: cursor,
      size: opts.size ?? 10,
      font: opts.bold ? helvBold : helv,
      color: rgb(0.06, 0.09, 0.16),
      maxWidth: 483,
    });
    cursor -= (opts.size ?? 10) + 8;
  };

  zeile('Elektronische Unterzeichnung', { size: 16, bold: true });
  cursor -= 6;
  zeile(`Dokument: ${input.title}`);
  zeile(`Vorgang: ${input.publicId}`);
  zeile(`SHA-256 des Originals: ${input.originalHash}`, { size: 8 });
  cursor -= 8;
  zeile('Unterzeichnende', { bold: true });
  for (const s of input.signers) {
    zeile(`${s.name} — ${s.method === 'DRAWN' ? 'gezeichnet' : 'getippt'} — ${zeit(s.signedAt)} (Europe/Zurich)`);
  }
  cursor -= 12;
  zeile(
    'Dieses Dokument wurde über Clenaris elektronisch unterzeichnet. Das zugehörige Signaturprotokoll',
    { size: 8 },
  );
  zeile('enthält die Prüfsummen, den Wortlaut der Zustimmung und den Ablauf. Keine qualifizierte Signatur.', {
    size: 8,
  });

  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/**
 * PNG-Bytes eines Unterschriftsbilds prüfen: Signatur (Gate 2), Grösse,
 * Abmessungen aus dem IHDR-Chunk. Kein Decoder — die Masse stehen in den
 * ersten 24 Bytes.
 */
export function inspectSignaturePng(bytes: Buffer): { width: number; height: number } {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !sig.every((b, i) => bytes[i] === b)) {
    throw new ValidationError('Die Unterschrift ist kein gültiges PNG.');
  }
  if (bytes.subarray(12, 16).toString('latin1') !== 'IHDR') {
    throw new ValidationError('Die Unterschrift ist kein gültiges PNG.');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 20 || height < 10 || width > 4000 || height > 2000) {
    throw new ValidationError('Die Unterschrift hat ungewöhnliche Abmessungen.');
  }
  return { width, height };
}
