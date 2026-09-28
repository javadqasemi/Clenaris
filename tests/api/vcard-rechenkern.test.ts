import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';

import {
  telefonInternational,
  vcardDateiname,
  vcardErzeugen,
  vcardText,
  zeileFalten,
  type VcardFirma,
} from '../../src/lib/kontakt/vcard';
import { QR_FEHLERKORREKTUR, QR_RUHEZONE, qrSvg } from '../../src/lib/kontakt/qr';

/**
 * Visitenkarte und QR-Code der Kontaktseite (Teil I, 2026-09-28) — die reinen
 * Rechenkerne, direkt importiert.
 *
 * **Zum QR-Rundweg.** Im Repository ist kein QR-*Decoder* installiert (weder
 * `jsqr` noch `@zxing/*`; der Scanner der Applikation nutzt den
 * `BarcodeDetector` des Browsers, den es in Node nicht gibt), und ein
 * schweres Paket nur für diese Prüfung hinzuzufügen, lohnt sich nicht. Der
 * Rundweg ist deshalb zweiteilig, und jeder Teil prüft genau eine Schicht:
 *
 *  1. **Kodierung** (Bibliothek `qrcode`): Die Segmente, die `QRCode.create`
 *     für die vCard erzeugt, ergeben zusammengesetzt wieder exakt die vCard
 *     — Byte für Byte, auch mit Umlauten (UTF-8, Bytemodus).
 *  2. **Darstellung** (unser Code, `qrSvg`): Der SVG-Pfad wird zurück in eine
 *     Modulmatrix gelesen und muss Modul für Modul der Matrix der Bibliothek
 *     entsprechen, samt Ruhezone.
 *
 * Was damit **nicht** belegt ist: dass eine echte Kamera den gedruckten oder
 * angezeigten Code liest. Das bleibt eine Handprüfung (iOS-Kamera,
 * Android-Kamera/Google Lens) — im Bericht als externer Nachweis geführt.
 */

const FIRMA: VcardFirma = {
  name: 'Clenaris',
  legalName: 'Clenaris Reinigungen GmbH',
  phone: '031 123 45 67',
  email: 'info@clenaris.ch',
  url: 'https://www.clenaris.ch/',
  address: { street: 'Aarbergergasse 1', postalCode: '3011', city: 'Bern', canton: 'BE', country: 'CH' },
};

function zeilen(vcard: string): string[] {
  // Entfalten nach RFC 2425 §5.8.1: CRLF gefolgt von einem Leerzeichen fällt weg.
  return vcard.replace(/\r\n /g, '').split('\r\n').filter(Boolean);
}

describe('vCard — Inhalt', () => {
  const vcard = vcardErzeugen(FIRMA);
  const alle = zeilen(vcard);

  it('ist eine vCard 3.0 mit Anfang und Ende', () => {
    assert.equal(alle[0], 'BEGIN:VCARD');
    assert.equal(alle[1], 'VERSION:3.0');
    assert.equal(alle.at(-1), 'END:VCARD');
  });

  it('trägt Firma, Telefon, E-Mail, Website und Adresse', () => {
    assert.ok(alle.includes('FN:Clenaris'));
    assert.ok(alle.includes('ORG:Clenaris Reinigungen GmbH'));
    assert.ok(alle.includes('N:;;;;'), 'N ist in 3.0 Pflicht');
    assert.ok(alle.includes('TEL;TYPE=WORK,VOICE:+41311234567'));
    assert.ok(alle.includes('EMAIL;TYPE=INTERNET,WORK:info@clenaris.ch'));
    assert.ok(alle.includes('URL:https://www.clenaris.ch/'));
    assert.ok(alle.includes('ADR;TYPE=WORK:;;Aarbergergasse 1;Bern;BE;3011;Schweiz'));
  });

  it('endet jede Zeile mit CRLF und nirgends mit einem nackten LF oder CR', () => {
    assert.ok(vcard.endsWith('\r\n'));
    assert.equal(/(?<!\r)\n/.test(vcard), false, 'nacktes LF');
    assert.equal(/\r(?!\n)/.test(vcard), false, 'nacktes CR');
  });

  it('enthält keine internen Felder — auch wenn der Aufrufer sie mitgibt', () => {
    const mitMehr = vcardErzeugen({
      ...FIRMA,
      // Absichtlich an der Schnittstelle vorbei: Was die Eingabe nicht kennt, darf nicht erscheinen.
      ...({ iban: 'CH93 0076 2011 6238 5295 7', vatNumber: 'CHE-123.456.789 MWST', notes: 'intern' } as object),
    });
    for (const verboten of ['CH93', 'CHE-123', 'intern', 'NOTE', 'IBAN', 'MWST']) {
      assert.equal(mitMehr.includes(verboten), false, verboten);
    }
  });

  it('lässt fehlende Angaben weg, statt leere Zeilen zu schreiben', () => {
    const knapp = zeilen(vcardErzeugen({ name: 'Firma', phone: '', email: 'kein-mail', url: 'javascript:alert(1)', address: null }));
    assert.equal(knapp.some((z) => z.startsWith('TEL')), false);
    assert.equal(knapp.some((z) => z.startsWith('EMAIL')), false);
    assert.equal(knapp.some((z) => z.startsWith('URL')), false);
    assert.equal(knapp.some((z) => z.startsWith('ADR')), false);
    assert.ok(knapp.includes('ORG:Firma'), 'ohne Firmenbezeichnung gilt der Name');
  });
});

describe('vCard — Maskierung, Zeichensatz, Faltung', () => {
  it('maskiert Backslash, Komma, Semikolon und Zeilenumbruch', () => {
    assert.equal(vcardText('a\\b,c;d\ne\r\nf'), 'a\\\\b\\,c\\;d\\ne\\nf');
  });

  it('hält ein Semikolon in der Strasse im selben Adressfeld', () => {
    const adr = zeilen(vcardErzeugen({ ...FIRMA, address: { ...FIRMA.address!, street: 'Weg 1; 2. Stock' } })).find((z) =>
      z.startsWith('ADR'),
    )!;
    assert.ok(adr.includes('Weg 1\\; 2. Stock'));
    // Postfach;Zusatz;Strasse;Ort;Region;PLZ;Land — sieben Felder, nicht acht.
    assert.equal(adr.split(':')[1]!.split(/(?<!\\);/).length, 7);
  });

  it('setzt CHARSET=UTF-8 nur an Zeilen mit Umlauten', () => {
    const alle = zeilen(vcardErzeugen({ ...FIRMA, name: 'Reinigung Zürich', address: { ...FIRMA.address!, city: 'Köniz' } }));
    assert.ok(alle.includes('FN;CHARSET=UTF-8:Reinigung Zürich'));
    assert.ok(alle.some((z) => z.startsWith('ADR;TYPE=WORK;CHARSET=UTF-8:')));
    assert.ok(alle.includes('EMAIL;TYPE=INTERNET,WORK:info@clenaris.ch'), 'ASCII-Zeile ohne CHARSET');
  });

  it('faltet bei 75 Oktetten, ohne ein UTF-8-Zeichen zu zerschneiden', () => {
    const lang = `ORG;CHARSET=UTF-8:${'Reinigungsgenossenschaft Zürich-Höngg und Umgebung '.repeat(4)}`;
    const gefaltet = zeileFalten(lang);
    const physisch = gefaltet.split('\r\n');
    assert.ok(physisch.length > 1);
    for (const [index, zeile] of physisch.entries()) {
      assert.ok(Buffer.byteLength(zeile, 'utf8') <= 75, `Zeile ${index}: ${Buffer.byteLength(zeile, 'utf8')} Oktette`);
      if (index > 0) assert.ok(zeile.startsWith(' '), 'Folgezeile beginnt mit Leerzeichen');
      assert.equal(zeile.includes('�'), false);
    }
    assert.equal(gefaltet.replace(/\r\n /g, ''), lang, 'Entfalten ergibt die logische Zeile');
  });

  it('lässt kurze Zeilen ungefaltet', () => {
    assert.equal(zeileFalten('FN:Clenaris'), 'FN:Clenaris');
  });

  it('schreibt Schweizer Nummern international', () => {
    assert.equal(telefonInternational('031 123 45 67'), '+41311234567');
    assert.equal(telefonInternational('0041 31 123 45 67'), '+41311234567');
    assert.equal(telefonInternational('+41 (0)31 123 45 67'), '+41311234567');
    assert.equal(telefonInternational('abc'), null);
    assert.equal(telefonInternational(null), null);
  });

  it('baut einen Dateinamen, der den Kopf nicht aufbrechen kann', () => {
    assert.equal(vcardDateiname('Clenaris Reinigungen GmbH'), 'Clenaris-Reinigungen-GmbH.vcf');
    assert.equal(vcardDateiname('Zürich "Böse"\r\nX-Kopf: 1'), 'Zurich-Bose-X-Kopf-1.vcf');
    assert.equal(vcardDateiname('„“'), 'kontakt.vcf');
  });
});

describe('QR-Code der Visitenkarte', () => {
  const vcard = vcardErzeugen({ ...FIRMA, address: { ...FIRMA.address!, city: 'Köniz' } });

  it('kodiert die vCard verlustfrei (Segmente ergeben wieder die Zeichenkette)', () => {
    const code = QRCode.create(vcard, { errorCorrectionLevel: QR_FEHLERKORREKTUR });
    const bytes: number[] = [];
    for (const segment of code.segments) {
      const daten = segment.data as unknown;
      if (typeof daten === 'string') bytes.push(...Buffer.from(daten, 'latin1'));
      else bytes.push(...(daten as Uint8Array));
    }
    assert.equal(Buffer.from(bytes).toString('utf8'), vcard);
  });

  it('nutzt Fehlerkorrektur M', () => {
    const code = QRCode.create(vcard, { errorCorrectionLevel: QR_FEHLERKORREKTUR });
    // `errorCorrectionLevel.bit`: L=1, M=0, Q=3, H=2 (ISO/IEC 18004, Tabelle 12).
    assert.equal((code.errorCorrectionLevel as unknown as { bit: number }).bit, 0);
  });

  it('zeichnet im SVG genau die Module der Matrix, mit Ruhezone', () => {
    const svg = qrSvg(vcard);
    const code = QRCode.create(vcard, { errorCorrectionLevel: QR_FEHLERKORREKTUR });
    assert.equal(svg.module, code.modules.size);
    assert.equal(svg.kante, code.modules.size + 2 * QR_RUHEZONE);

    const gezeichnet = new Set<string>();
    for (const [, x, y, breite] of svg.pfad.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      for (let i = 0; i < Number(breite); i += 1) gezeichnet.add(`${Number(y)}:${Number(x) + i}`);
    }
    let dunkel = 0;
    for (let zeile = 0; zeile < svg.kante; zeile += 1) {
      for (let spalte = 0; spalte < svg.kante; spalte += 1) {
        const innen =
          zeile >= QR_RUHEZONE && spalte >= QR_RUHEZONE && zeile < QR_RUHEZONE + svg.module && spalte < QR_RUHEZONE + svg.module;
        const soll = innen ? Boolean(code.modules.get(zeile - QR_RUHEZONE, spalte - QR_RUHEZONE)) : false;
        if (soll) dunkel += 1;
        assert.equal(gezeichnet.has(`${zeile}:${spalte}`), soll, `Modul ${zeile}/${spalte}`);
      }
    }
    assert.equal(gezeichnet.size, dunkel);
  });

  it('bleibt bei einer vollständigen Karte in einer gut scannbaren Grösse', () => {
    // Die Kontaktseite druckt den Code 4 cm breit. Ein Modul soll dabei
    // mindestens 0.5 mm messen — darunter lesen ältere Telefonkameras aus
    // üblicher Haltedistanz unzuverlässig. 40 mm / 0.5 mm = 80 Module samt
    // Ruhezone. Eine vollständige Karte (rund 290 Byte) ergibt Version 12,
    // 65 + 8 = 73 Module, also rund 0.55 mm.
    const { kante, version } = qrSvg(vcard);
    assert.ok(40 / kante >= 0.5, `Version ${version}, ${kante} Module: ${(40 / kante).toFixed(2)} mm je Modul`);
  });
});
