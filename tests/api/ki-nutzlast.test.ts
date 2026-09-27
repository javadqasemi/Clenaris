import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { anfrageFiltern, freitextSchwaerzen, mitSchutzplatzhaltern } from '../../src/lib/ai/governance';
import { offertentwurfNutzlast, uebersetzungNutzlast, zusammenfassungNutzlast, type KiNutzlast } from '../../src/lib/ai/nutzlast';

/**
 * Was die Freitext-Funktionen der KI tatsächlich hinausschicken (F-15,
 * 2026-09-27).
 *
 * Direkt importiert wie `bi-rechenkerne.test.ts`: Geprüft wird die Nutzlast,
 * nicht der Anbieter. `ausgehend()` schickt sie durch `anfrageFiltern` — genau
 * die Funktion, die `client.ts` vor jedem Aufruf anwendet. Was danach im
 * Prompt oder Systemtext steht, ist das, was den Prozess verlässt.
 *
 * Gegen den alten Stand scheitern die Fälle je Funktion: Zusammenfassung,
 * Übersetzung und Offertentwurf reichten den Freitext nur durch den
 * Formfilter, und Alarmcodes, Passwörter, Lohnbeträge und Gesundheitssätze
 * gingen wörtlich hinaus.
 */

/** Was den Prozess verlässt: Systemtext und die gefilterte Anfrage. */
function ausgehend(n: KiNutzlast): string {
  return `${n.system}\n${anfrageFiltern(n.prompt).prompt}`;
}

/** Ein eingefügter Text, wie er im Büro vorkommt — mit allem, was nicht hinausgehört. */
const FREITEXT = [
  'Guten Tag, hier ist Anna Keller von der Keller Treuhand AG (anna.keller@example.ch, +41 79 123 45 67).',
  'Büro 120 m², wöchentliche Reinigung, Termin 24.09.2026 um 07:30.',
  'Alarmcode 4711# beim Eingang, Schlüsselsafe Code 2580, WLAN-Passwort: Sommer2026!',
  'Unsere Reinigungskraft ist seit Montag krankgeschrieben, ein Arztzeugnis folgt.',
  "Ihr Monatslohn CHF 5'200.00 wird weiterbezahlt, AHV 756.1234.5678.97.",
  'Rückzahlung bitte auf CH93 0076 2011 6238 5295 7.',
].join('\n');

/** Je Kategorie ein Wert, der das Haus nicht verlassen darf. */
const VERBOTEN: Record<string, string[]> = {
  Alarmcode: ['4711'],
  Schlüsselsafe: ['2580'],
  Passwort: ['Sommer2026'],
  'AHV-Nummer': ['756.1234', '5678.97'],
  Lohnbetrag: ["5'200"],
  Gesundheit: ['krankgeschrieben', 'Arztzeugnis'],
  IBAN: ['CH93', '6238 5295'],
  'E-Mail': ['anna.keller@example.ch'],
  Telefon: ['79 123 45 67'],
};

function nichtsVerbotenes(text: string, funktion: string): void {
  for (const [art, werte] of Object.entries(VERBOTEN)) {
    for (const wert of werte) assert.ok(!text.includes(wert), `${funktion}: ${art} („${wert}") verlässt den Prozess:\n${text}`);
  }
}

describe('Zusammenfassung', () => {
  it('Alarmcodes, Passwort, AHV-Nummer, Lohnbetrag, Gesundheit, IBAN, E-Mail und Telefon gehen nicht hinaus', () => {
    const n = zusammenfassungNutzlast({ text: FREITEXT, maxSentences: 4 });
    nichtsVerbotenes(ausgehend(n), 'Zusammenfassung');
    assert.ok(n.ersetzungen.zugangscode >= 3, JSON.stringify(n.ersetzungen));
    assert.equal(n.ersetzungen.gesundheit, 1);
    assert.equal(n.ersetzungen.lohn, 1);
  });

  it('der fachliche Inhalt bleibt — sonst gäbe es nichts zusammenzufassen', () => {
    const text = ausgehend(zusammenfassungNutzlast({ text: FREITEXT }));
    for (const bleibt of ['Büro 120 m²', 'wöchentliche Reinigung', '24.09.2026 um 07:30', 'Alarmcode', 'Schlüsselsafe']) {
      assert.ok(text.includes(bleibt), `„${bleibt}" fehlt:\n${text}`);
    }
  });

  it('auch der Fokus ist Freitext und wird geschwärzt', () => {
    const n = zusammenfassungNutzlast({ text: FREITEXT, focus: 'Alarmcode 9911 prüfen' });
    assert.ok(!ausgehend(n).includes('9911'));
  });
});

describe('Übersetzung', () => {
  it('Alarmcodes, Passwort, AHV-Nummer, Lohnbetrag, Gesundheit, IBAN, E-Mail und Telefon gehen nicht hinaus', () => {
    const n = uebersetzungNutzlast({ text: FREITEXT, targetLocale: 'FR', preserveFormatting: true });
    nichtsVerbotenes(ausgehend(n), 'Übersetzung');
  });

  it('die geschützten Werte kommen im eigenen Prozess zurück — die Übersetzung ist vollständig', () => {
    const n = uebersetzungNutzlast({ text: FREITEXT, targetLocale: 'FR' });
    // Eine „Übersetzung", die wie das Modell die Platzhalter unverändert lässt.
    const antwort = /"""\n([\s\S]*)\n"""/.exec(n.prompt)![1]!.replace('Guten Tag', 'Bonjour');
    const ergebnis = n.zurueck(antwort);
    assert.ok(ergebnis.startsWith('Bonjour'), ergebnis);
    for (const wert of ['4711#', '2580', 'Sommer2026!', "CHF 5'200.00", '756.1234.5678.97', 'anna.keller@example.ch', 'krankgeschrieben']) {
      assert.ok(ergebnis.includes(wert), `„${wert}" kam nicht zurück:\n${ergebnis}`);
    }
    assert.ok(!/\{\{GESCHUETZT_/.test(ergebnis), `ein Platzhalter blieb stehen:\n${ergebnis}`);
  });

  it('ein Platzhalter in einem Platzhalter wird vollständig aufgelöst', () => {
    // Die E-Mail wird zuerst geschützt, danach der Wert nach „Passwort" — der
    // ist dann der erste Platzhalter selbst.
    const s = mitSchutzplatzhaltern('Passwort: anna@example.ch');
    assert.ok(!s.text.includes('anna@example.ch'), s.text);
    assert.equal(s.zurueck(s.text), 'Passwort: anna@example.ch');
  });
});

describe('Offertentwurf', () => {
  const anfrage = {
    serviceKind: 'OFFICE_CLEANING',
    propertyKind: 'OFFICE',
    squareMeters: 120,
    frequency: 'WEEKLY',
    customerMessage: FREITEXT,
    customerType: 'BUSINESS' as const,
    hourlyRate: 62,
    city: 'Bern',
    bekannteNamen: ['Anna', 'Keller', 'Keller Treuhand AG'],
  };

  it('Alarmcodes, Passwort, AHV-Nummer, Lohnbetrag, Gesundheit, IBAN, E-Mail, Telefon und bekannte Namen gehen nicht hinaus', () => {
    const text = ausgehend(offertentwurfNutzlast(anfrage));
    nichtsVerbotenes(text, 'Offertentwurf');
    // Als ganzes Wort — „Annahme" im Systemtext ist kein Name.
    for (const name of ['Anna', 'Keller']) {
      assert.ok(!new RegExp(`(?<![\\p{L}])${name}(?![\\p{L}])`, 'u').test(text), `Name „${name}" verlässt den Prozess:\n${text}`);
    }
  });

  it('nur erlaubte Felder: Katalogschlüssel, begrenzte Zahlen, ein Ortsname', () => {
    const text = ausgehend(offertentwurfNutzlast(anfrage));
    for (const bleibt of ['Leistungsart: OFFICE_CLEANING', 'Objektart: OFFICE', 'Fläche: 120 m²', 'Turnus: WEEKLY', 'Ort: Bern', 'CHF 62.00']) {
      assert.ok(text.includes(bleibt), `„${bleibt}" fehlt:\n${text}`);
    }
  });

  it('freie Zeichenketten in Strukturfeldern sind kein zweiter Kanal an der Schwärzung vorbei', () => {
    const text = ausgehend(
      offertentwurfNutzlast({
        ...anfrage,
        customerMessage: 'Bitte eine Offerte für das Büro.',
        propertyKind: 'Wohnung, Alarmcode 4711',
        frequency: 'Lohn 5200',
        city: 'Bern, Türcode 2580',
        squareMeters: Number.NaN,
        bekannteNamen: [],
      }),
    );
    nichtsVerbotenes(text, 'Offertentwurf (Strukturfelder)');
    assert.ok(!text.includes('5200'), text);
    assert.ok(text.includes('Objektart: unbekannt') && text.includes('Turnus: unbekannt'), text);
    assert.ok(!text.includes('Ort:') && !text.includes('Fläche:'), text);
  });
});

describe('Die Regeln selbst', () => {
  it('lässt fachlichen Text stehen: Arztpraxis als Kundschaft, „eingehalten", Beträge ohne Lohnbezug, Stockwerk und Uhrzeit', () => {
    const text = 'Praxisreinigung in der Arztpraxis, 200 m². Termin eingehalten, CHF 200 Rabatt. Schlüssel beim Hauswart im 2. Stock ab 07:30.';
    const f = freitextSchwaerzen(text);
    assert.equal(f.text, text, JSON.stringify(f.ersetzungen));
  });

  it('Gesundheit: der ganze Satz, nicht nur das Wort', () => {
    const f = freitextSchwaerzen('Termin am Montag. Frau Muster ist wegen einer Operation arbeitsunfähig bis Freitag. Danach wie gewohnt.');
    assert.equal(f.text, 'Termin am Montag. [GESUNDHEITSANGABE] Danach wie gewohnt.');
  });

  it('der Verlauf wird auch als Blockinhalt gefiltert; was sich nicht filtern lässt, geht nicht hinaus', () => {
    const f = anfrageFiltern('Frage', [
      { role: 'user', content: [{ type: 'text', text: 'Meine Nummer: +41 79 123 45 67' }, { type: 'image', source: { data: 'AAAA' } }] },
      { role: 'assistant', content: 'Schreiben Sie an anna.keller@example.ch' },
    ]);
    const hinaus = JSON.stringify(f.verlauf);
    assert.ok(!hinaus.includes('79 123 45 67') && !hinaus.includes('anna.keller@example.ch'), hinaus);
    assert.ok(!hinaus.includes('"image"'), 'ein Bildblock ginge ungefiltert hinaus');
    assert.equal(f.ersetzungen.block_entfernt, 1);
  });
});
