import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatKpiValue } from '../../src/lib/bi/labels';
import { anfrageFiltern, freitextSchwaerzen, mitSchutzplatzhaltern, namenVermuten } from '../../src/lib/ai/governance';
import {
  bewertungsantwortNutzlast,
  biDaten,
  biFreitext,
  einsatzberichtNutzlast,
  emailEntwurfNutzlast,
  offertentwurfNutzlast,
  uebersetzungNutzlast,
  zusammenfassungNutzlast,
  type BiTeil,
  type KiNutzlast,
} from '../../src/lib/ai/nutzlast';

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
 *
 * Zweiter Durchgang (F-15, 2026-09-27): E-Mail-Entwurf, Einsatzbericht,
 * Antwortentwurf zu Bewertungen und Führungsassistent hatten keine eigene
 * Nutzlast und sind hier erst prüfbar, seit es sie gibt — gegen den alten
 * Stand scheitern diese Fälle schon am Import. Die Fälle zu vermuteten Namen
 * scheitern gegen den alten Stand, weil „Frau Brunner" in Zusammenfassung
 * und Übersetzung wörtlich hinausging.
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

/** Als ganzes Wort — „Annahme" im Systemtext ist nicht „Anna", „Kellerreinigung" nicht „Keller". */
function keineNamen(text: string, namen: string[], funktion: string): void {
  for (const name of namen) {
    assert.ok(!new RegExp(`(?<![\\p{L}])${name}(?![\\p{L}])`, 'u').test(text), `${funktion}: Name „${name}" verlässt den Prozess:\n${text}`);
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

/** Eine eingefügte Kundenmail — Namen stehen dort, wo die Sprache sie ankündigt. */
const KUNDENMAIL = [
  'Sehr geehrte Frau Brunner,',
  'Herr Dr. Beat Zaugg hat heute wegen der Büroreinigung angerufen. Bitte richten Sie Frau Brunner aus, dass der Termin am 03.10.2026 bestätigt ist.',
  '',
  'Freundliche Grüsse',
  'Carla Rüegsegger',
  'Rüegsegger Immobilien GmbH',
].join('\n');
const NAMEN_KUNDENMAIL = ['Brunner', 'Beat', 'Zaugg', 'Carla', 'Rüegsegger'];

describe('Namen vermuten (Zusammenfassung, Übersetzung)', () => {
  it('Frau/Herr, Anrede und Grussformel: der Name geht nicht hinaus — auch nicht an anderer Stelle im Text', () => {
    const n = zusammenfassungNutzlast({ text: KUNDENMAIL });
    const text = ausgehend(n);
    keineNamen(text, NAMEN_KUNDENMAIL, 'Zusammenfassung');
    assert.ok(n.ersetzungen.name >= 5, JSON.stringify(n.ersetzungen));
    // Der fachliche Inhalt bleibt.
    for (const bleibt of ['Büroreinigung angerufen', '03.10.2026 bestätigt', 'Immobilien GmbH', 'Freundliche Grüsse']) {
      assert.ok(text.includes(bleibt), `„${bleibt}" fehlt:\n${text}`);
    }
  });

  it('Geschäftstext bleibt: „Damen und Herren", „Liebe Grüsse", „Ihr Clenaris-Team", „Herrn Keller Bescheid geben", „Kellerreinigung"', () => {
    const text = [
      'Sehr geehrte Damen und Herren',
      'Bitte Herrn Keller Bescheid geben, dass die Kellerreinigung am Montag stattfindet.',
      'Hallo zusammen, Liebe Grüsse und bis bald.',
      'Freundliche Grüsse',
      'Ihr Clenaris-Team',
    ].join('\n');
    assert.deepEqual(namenVermuten(text), ['Keller']);
    const f = freitextSchwaerzen(text, { namen: namenVermuten(text) });
    for (const bleibt of ['Sehr geehrte Damen und Herren', 'Herrn [NAME] Bescheid geben', 'Kellerreinigung am Montag', 'Hallo zusammen, Liebe Grüsse', 'Freundliche Grüsse\nIhr Clenaris-Team']) {
      assert.ok(f.text.includes(bleibt), `„${bleibt}" wurde zerstört:\n${f.text}`);
    }
  });

  it('ein Text ohne Namensstellen bleibt unverändert', () => {
    const text = 'Büro 120 m², wöchentliche Reinigung. Die Offerte ist gültig bis 31.10.2026. Ihre Fragen beantworten wir gerne.';
    assert.deepEqual(namenVermuten(text), []);
    assert.equal(freitextSchwaerzen(text, { namen: namenVermuten(text) }).text, text);
  });

  it('Übersetzung: vermutete Namen gehen geschützt hinaus und kommen im eigenen Prozess zurück', () => {
    const n = uebersetzungNutzlast({ text: KUNDENMAIL, targetLocale: 'FR' });
    keineNamen(ausgehend(n), NAMEN_KUNDENMAIL, 'Übersetzung');
    const antwort = /"""\n([\s\S]*)\n"""/.exec(n.prompt)![1]!.replace('Sehr geehrte Frau', 'Chère Madame');
    const ergebnis = n.zurueck(antwort);
    assert.ok(ergebnis.startsWith('Chère Madame Brunner,'), ergebnis);
    for (const name of ['Beat Zaugg', 'Carla Rüegsegger']) assert.ok(ergebnis.includes(name), `„${name}" kam nicht zurück:\n${ergebnis}`);
  });
});

describe('E-Mail-Entwurf', () => {
  const eingabe = {
    purpose: 'Termin mit Frau Keller bestätigen',
    recipientName: 'Anna Keller',
    senderName: 'Beat Zaugg',
    tone: 'freundlich' as const,
    context: `${FREITEXT}\nBeat übernimmt den Einsatz.\nMit freundlichen Grüssen\nDoris Egger`,
  };

  it('Alarmcodes, Passwort, AHV-Nummer, Lohnbetrag, Gesundheit, IBAN, E-Mail, Telefon und Namen — auch als Vor- oder Nachname allein — gehen nicht hinaus', () => {
    const n = emailEntwurfNutzlast(eingabe);
    const text = ausgehend(n);
    nichtsVerbotenes(text, 'E-Mail-Entwurf');
    keineNamen(text, ['Anna', 'Keller', 'Beat', 'Zaugg', 'Doris', 'Egger'], 'E-Mail-Entwurf');
    assert.ok(text.includes('Termin mit Frau {{EMPFAENGER}} bestätigen'), text);
  });

  it('Namen und geschützte Werte kommen im eigenen Prozess zurück, kein Platzhalter bleibt stehen', () => {
    const n = emailEntwurfNutzlast(eingabe);
    const ergebnis = n.zurueck(n.prompt);
    for (const wert of ['Frau Anna Keller', 'Empfänger: Anna Keller', 'Absender: Beat Zaugg', '4711#', 'Sommer2026!', "CHF 5'200.00", 'anna.keller@example.ch', 'Doris Egger']) {
      assert.ok(ergebnis.includes(wert), `„${wert}" kam nicht zurück:\n${ergebnis}`);
    }
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(ergebnis), `ein Platzhalter blieb stehen:\n${ergebnis}`);
  });

  it('die Tonalität ist ein Katalogwert, kein zweiter Freitextkanal', () => {
    const n = emailEntwurfNutzlast({ ...eingabe, tone: 'Alarmcode 4711' as never });
    assert.ok(n.prompt.includes('Tonalität: sachlich') && !n.prompt.includes('4711'), n.prompt);
  });
});

describe('Einsatzbericht', () => {
  const eingabe = {
    jobNumber: 'E-2026-00042',
    customerName: 'Keller Treuhand AG',
    serviceName: 'Büroreinigung',
    date: '24. September 2026',
    durationMinutes: 150,
    crew: ['Anna Muster', 'Beat Zaugg'],
    checklist: [
      { label: 'Eingang: Alarmcode 4711# eingeben', done: true },
      { label: 'Küche', done: false, note: 'Anna ist krankgeschrieben, ein Arztzeugnis folgt.' },
    ],
    materials: [{ name: 'Allzweckreiniger', quantity: 2, unit: 'l' }],
    notes: `Frau Keller öffnet, Beat übernimmt den Schlüssel. WLAN-Passwort: Sommer2026! Monatslohn CHF 5'200.00, AHV 756.1234.5678.97, IBAN CH93 0076 2011 6238 5295 7, anna.keller@example.ch, +41 79 123 45 67.`,
    bekannteNamen: ['Sandra', 'Keller'],
  };

  it('Alarmcodes, Passwort, AHV-Nummer, Lohnbetrag, Gesundheit, IBAN, E-Mail, Telefon, Kunde, Team und Kontaktperson gehen nicht hinaus', () => {
    const text = ausgehend(einsatzberichtNutzlast(eingabe));
    nichtsVerbotenes(text, 'Einsatzbericht');
    keineNamen(text, ['Keller Treuhand', 'Anna', 'Muster', 'Beat', 'Zaugg', 'Keller'], 'Einsatzbericht');
  });

  it('der Bericht bekommt Kunde und Team zurück, der fachliche Inhalt bleibt', () => {
    const n = einsatzberichtNutzlast(eingabe);
    for (const bleibt of ['Auftrag: E-2026-00042', 'Leistung: Büroreinigung', 'Datum: 24. September 2026', 'Dauer: 2.5 Stunden', 'Team: {{TEAM_A}}, {{TEAM_B}}', '- [x] Eingang: Alarmcode [ZUGANGSCODE] eingeben', '- 2 l Allzweckreiniger', 'Frau [NAME] öffnet, {{TEAM_B}} übernimmt']) {
      assert.ok(n.prompt.includes(bleibt), `„${bleibt}" fehlt:\n${n.prompt}`);
    }
    assert.equal(n.zurueck('Bericht für {{KUNDE}}, Team {{TEAM_A}} und {{TEAM_B}}.'), 'Bericht für Keller Treuhand AG, Team Anna Muster und Beat Zaugg.');
  });

  it('Strukturfelder sind kein Kanal an der Schwärzung vorbei', () => {
    const n = einsatzberichtNutzlast({ ...eingabe, jobNumber: 'Alarmcode 4711', date: 'Türcode 2580; Lohn 5200 CHF!', durationMinutes: Number.NaN });
    assert.ok(n.prompt.includes('Auftrag: —') && n.prompt.includes('Datum: —') && n.prompt.includes('Dauer: — Stunden'), n.prompt);
    assert.ok(!n.prompt.includes('5200'), n.prompt);
  });
});

describe('Antwortentwurf zu einer Bewertung', () => {
  const bewertung = {
    rating: 2,
    title: 'Enttäuscht von Frau Muster',
    body: [
      'Frau Muster vom Team war unfreundlich. Mein Mann ist seit dem Unfall auf Hilfe angewiesen.',
      'Rückruf unter +41 79 123 45 67 oder anna.keller@example.ch. Der Alarmcode 4711# wurde falsch eingegeben.',
      'Freundliche Grüsse',
      'Anna Keller',
    ].join('\n'),
    authorName: 'Anna Keller',
    senderName: 'Beat Zaugg',
    bekannteNamen: ['Sandra', 'Muster'],
  };

  it('Gesundheit, Code, Telefon, E-Mail, Verfasserin und genannte Mitarbeiterin gehen nicht hinaus', () => {
    const n = bewertungsantwortNutzlast(bewertung);
    const text = ausgehend(n);
    for (const verboten of ['Unfall', '4711', '79 123 45 67', 'anna.keller@example.ch']) assert.ok(!text.includes(verboten), `„${verboten}" verlässt den Prozess:\n${text}`);
    keineNamen(text, ['Anna', 'Keller', 'Muster', 'Beat', 'Zaugg'], 'Antwortentwurf');
    assert.ok(text.includes('Bewertung mit 2 von 5 Sternen') && text.includes('kritische Bewertung'), text);
    assert.ok(text.includes('Frau [NAME] vom Team war unfreundlich'), text);
  });

  it('die Anrede kommt zurück; Sterne sind eine Zahl im Bereich 1–5', () => {
    const n = bewertungsantwortNutzlast({ ...bewertung, rating: 99 });
    assert.equal(n.zurueck('Guten Tag {{EMPFAENGER}} — {{ABSENDER}}'), 'Guten Tag Anna Keller — Beat Zaugg');
    assert.ok(n.prompt.includes('Bewertung mit 5 von 5 Sternen'), n.prompt);
  });
});

describe('Führungsassistent (biDaten)', () => {
  const namen = ['Anna', 'Muster', 'Keller Treuhand AG', 'Keller'];
  const teile: BiTeil[] = [
    { art: 'zeitraum', von: new Date('2026-07-01T00:00:00Z'), bis: new Date('2026-09-30T00:00:00Z') },
    { art: 'ueberschrift', text: 'Kennzahlen:' },
    {
      art: 'kennzahlen',
      liste: [
        { gruppe: 'Finanzen', label: 'Lohnkosten', schluessel: 'laborCostPct', einheit: 'PERCENT', mehrIstBesser: false, ziel: 50, verlauf: [{ periodeStart: new Date('2026-08-01T00:00:00Z'), wert: 52, vorlaeufig: false }] },
        { gruppe: 'Finanzen', label: 'Nettoumsatz', schluessel: 'revenue.net', einheit: 'CURRENCY', mehrIstBesser: true, ziel: null, verlauf: [{ periodeStart: new Date('2026-09-01T00:00:00Z'), wert: 48200, vorlaeufig: true }] },
      ],
    },
    { art: 'ueberschrift', text: 'Auffälligkeiten (regelbasiert):' },
    {
      art: 'hinweise',
      liste: [
        { schluessel: 'concentration', schwere: 'warning', titel: 'Eine Kundschaft macht 34 % des Umsatzes aus', detail: 'Keller Treuhand AG — fällt sie weg, fehlt ein Fünftel oder mehr.' },
        { schluessel: 'trend-revenue.net', schwere: 'warning', titel: 'Nettoumsatz bricht nach drei Wachstumsmonaten ein', detail: 'Von CHF 50’000 auf CHF 40’000 — ein Rückgang um 20 %.' },
      ],
    },
    {
      art: 'ziele',
      liste: [
        {
          horizont: 'OKR', ebene: 'COMPANY', titel: 'Stammkundschaft ausbauen', status: 'ON_TRACK', fortschritt: 40, bereich: null,
          ergebnisse: [{ titel: 'Wiederkehrquote', start: 20, stand: 28, ziel: 40, fortschritt: 40, kommentar: 'Anna Muster ist krankgeschrieben, Alarmcode 4711# geändert.' }],
        },
      ],
    },
    { art: 'markt', wettbewerber: [], beobachtungen: [{ art: 'COMPETITOR', beobachtetAm: new Date('2026-09-01T00:00:00Z'), titel: 'Preissenkung', text: 'Gemeldet von anna.keller@example.ch, Monatslohn CHF 5’200 beim Mitbewerber.', auswirkung: null }] },
    {
      art: 'budget',
      wert: { name: 'Budget 2026', geschaeftsjahr: 2026, verstricheneMonate: 9, monateTotal: 12, zeilen: [{ label: 'Löhne', kategorie: 'PERSONNEL', plan: 120000, planBisher: 90000, ist: 95000, abweichung: 5000, abweichungProzent: 5.6, hochrechnung: 126000 }], total: { planBisher: 90000, ist: 95000, abweichung: 5000 }, ohneBudget: [] },
    },
    { art: 'bewertungen', liste: [{ datum: '2026-09-20', sterne: 5, leistung: 'OFFICE_CLEANING', titel: null, text: 'Frau Muster war super. Rückruf +41 79 123 45 67.\nFreundliche Grüsse\nCarla Rüegsegger', verfasser: 'Carla Rüegsegger' }] },
  ];

  it('nur aggregierte Daten: keine Kundschaft aus der Detailzeile, keine Namen, Codes, Gesundheit, Kontakt- oder Lohnangaben aus Freitext', () => {
    const f = biDaten(teile, { namen });
    for (const verboten of ['Keller Treuhand', '4711', 'krankgeschrieben', '79 123 45 67', 'anna.keller@example.ch', '5’200']) {
      assert.ok(!f.text.includes(verboten), `„${verboten}" verlässt den Prozess:\n${f.text}`);
    }
    keineNamen(f.text, ['Anna', 'Muster', 'Carla', 'Rüegsegger', 'Keller'], 'Führungsassistent');
  });

  it('die Kennzahlen bleiben: Werte, Ziele, Budgetzeilen und geprüfte Hinweisdetails', () => {
    const { text } = biDaten(teile, { namen });
    for (const bleibt of [
      'Zeitraum 2026-07-01 bis 2026-09-30',
      `[Finanzen] Lohnkosten (laborCostPct, weniger ist besser). Ziel ${formatKpiValue(50, 'PERCENT')}. Verlauf: 2026-08: ${formatKpiValue(52, 'PERCENT')}`,
      `2026-09: ${formatKpiValue(48200, 'CURRENCY')} (vorläufig)`,
      '- [warning] Eine Kundschaft macht 34 % des Umsatzes aus.',
      'Von CHF 50’000 auf CHF 40’000 — ein Rückgang um 20 %.',
      'Wiederkehrquote: 20 → 28 (Ziel 40), 40 %',
      '- Löhne [PERSONNEL]: Plan 120000, anteilig 90000, Ist 95000',
      '#1 2026-09-20 5/5 OFFICE_CLEANING',
    ]) {
      assert.ok(text.includes(bleibt), `„${bleibt}" fehlt:\n${text}`);
    }
  });

  it('ein Wert, der nicht zu seinem Feld passt, wird „—"; fremde Überschriften fallen weg', () => {
    const { text } = biDaten(
      [
        { art: 'quartal', label: 'Q3 2026; Alarmcode 4711' },
        { art: 'ueberschrift', text: 'Anna Muster verdient 7000' as never },
        { art: 'risiken', liste: [{ titel: 'Personalausfall', kategorie: 'PERSONNEL, Anna krank', wahrscheinlichkeit: 3, auswirkung: 4, schwere: 12, status: 'Lohn 5200' }] },
        { art: 'leads', liste: [{ quelle: 'WEBSITE', status: 'WON', anzahl: 7 }, { quelle: 'Anruf von 079 123 45 67', status: 'NEW', anzahl: 1 }] },
      ],
      { namen },
    );
    for (const verboten of ['4711', '7000', 'krank', '5200', '079']) assert.ok(!text.includes(verboten), `„${verboten}" verlässt den Prozess:\n${text}`);
    for (const bleibt of ['Quartal —', '- Personalausfall [—, W3×A4=12, —]', '- WEBSITE/WON: 7', '- —/NEW: 1']) {
      assert.ok(text.includes(bleibt), `„${bleibt}" fehlt:\n${text}`);
    }
  });

  it('Sitzungsnotizen und Frage: bekannte und vermutete Namen, Gesundheit und Codes geschwärzt, die Sache bleibt', () => {
    const f = biFreitext('Anna übernimmt die Offerte für die Praxis.\nBeat ist krank bis Freitag.\nMein Name ist Doris Egger, Türcode 2580.', ['Anna', 'Beat']);
    keineNamen(f.text, ['Anna', 'Beat', 'Doris', 'Egger'], 'Sitzungsnotizen');
    assert.ok(!f.text.includes('krank') && !f.text.includes('2580'), f.text);
    assert.ok(f.text.includes('[NAME] übernimmt die Offerte für die Praxis.'), f.text);
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
