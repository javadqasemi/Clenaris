import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { bedingungenErfuellt, wertAn } from '../../src/lib/automation/conditions';
import { fuelleVorlage, platzhalterIn } from '../../src/lib/automation/template';
import { istPrivateAdresse, pruefendeVerbindungsaufloesung, pruefeZiel, sendeWebhook } from '../../src/lib/automation/webhook';
import {
  ERLAUBTE_STATUSAENDERUNGEN,
  ausgangszustaendeFuer,
  pruefeAktionsKonfiguration,
} from '../../src/lib/validation/automation-config';
import { get, post, patch, del, data, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { eigeneOrganisationId, testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';

/**
 * Wave 6 — die Automatisierungsmaschine.
 *
 * ---------------------------------------------------------------------------
 *  Der Befund, der diese Reihe nötig gemacht hat
 * ---------------------------------------------------------------------------
 *
 * Die Modelle standen seit der ersten Migration im Schema, es gab eine
 * Oberfläche zum Anlegen von Regeln — und **`automation_runs` wurde von keinem
 * Codepfad je beschrieben.** Eine Zusage, die das System nicht einlöst.
 *
 * Deshalb hat diese Reihe eine Prüfung, die sonst nirgends vorkommt: Sie legt
 * eine Regel an, löst sie über einen **echten Geschäftsvorgang** aus und sieht
 * in der Tabelle nach. Über HTTP allein wäre nicht zu unterscheiden, ob die
 * Maschine läuft oder ob wieder nichts passiert — eine Buchung wird in beiden
 * Fällen angelegt.
 *
 * ---------------------------------------------------------------------------
 *  Was direkt importiert wird
 * ---------------------------------------------------------------------------
 *
 * Bedingungen, Vorlagen und die Adressprüfung sind reine Rechnung. Bei der
 * Adressprüfung kommt ein zweiter Grund dazu: Die Kantenfälle sind private
 * Adressbereiche, und ein Prüfstand, der sie über HTTP anfahren wollte,
 * müsste den Server dazu bringen, sie tatsächlich anzurufen — also genau das
 * tun, was die Prüfung verhindern soll.
 */

let jars: Record<AccountName, string>;

// ===========================================================================
//  Bedingungen
// ===========================================================================

describe('Bedingungssprache', () => {
  const vorgang = {
    entity: 'Booking',
    entityId: 'clx1',
    status: 'PENDING',
    betrag: 480,
    kunde: { typ: 'BUSINESS', name: 'Muster AG', email: 'a@b.ch' },
  };

  it('holt Werte über einen Punktpfad', () => {
    assert.equal(wertAn(vorgang, 'kunde.typ'), 'BUSINESS');
    assert.equal(wertAn(vorgang, 'kunde.gibtesnicht'), undefined);
    assert.equal(wertAn(vorgang, 'betrag.tiefer'), undefined);
  });

  it('leere Bedingungen treffen immer zu', () => {
    assert.equal(bedingungenErfuellt({}, vorgang), true);
  });

  it('ein blosser Wert bedeutet Gleichheit', () => {
    assert.equal(bedingungenErfuellt({ status: 'PENDING' }, vorgang), true);
    assert.equal(bedingungenErfuellt({ status: 'CONFIRMED' }, vorgang), false);
    assert.equal(bedingungenErfuellt({ 'kunde.typ': 'BUSINESS' }, vorgang), true);
  });

  it('alle Bedingungen müssen halten', () => {
    assert.equal(
      bedingungenErfuellt({ status: 'PENDING', 'kunde.typ': 'BUSINESS' }, vorgang),
      true,
    );
    assert.equal(
      bedingungenErfuellt({ status: 'PENDING', 'kunde.typ': 'PRIVATE' }, vorgang),
      false,
    );
  });

  it('kennt die Vergleiche', () => {
    assert.equal(bedingungenErfuellt({ betrag: { gt: 400 } }, vorgang), true);
    assert.equal(bedingungenErfuellt({ betrag: { gt: 500 } }, vorgang), false);
    assert.equal(bedingungenErfuellt({ betrag: { gte: 480, lte: 480 } }, vorgang), true);
    assert.equal(bedingungenErfuellt({ status: { in: ['PENDING', 'CONFIRMED'] } }, vorgang), true);
    assert.equal(bedingungenErfuellt({ status: { notIn: ['PENDING'] } }, vorgang), false);
    assert.equal(bedingungenErfuellt({ status: { ne: 'CANCELLED' } }, vorgang), true);
    assert.equal(bedingungenErfuellt({ 'kunde.name': { contains: 'muster' } }, vorgang), true);
  });

  it('`exists` unterscheidet „kein Wert" von „leerer Wert"', () => {
    assert.equal(bedingungenErfuellt({ 'kunde.email': { exists: true } }, vorgang), true);
    assert.equal(bedingungenErfuellt({ 'kunde.telefon': { exists: false } }, vorgang), true);
    assert.equal(bedingungenErfuellt({ 'kunde.telefon': { exists: true } }, vorgang), false);
  });

  /**
   * Die Bedingungen kommen aus einem Json-Feld, in dem `"5"` und `5` beide
   * vorkommen — je nachdem, ob ein Formular oder ein Skript sie geschrieben
   * hat. Ein strenger Vergleich liesse eine Regel stillschweigend nie
   * greifen: Sie stünde in der Liste, wäre aktiv und täte nichts.
   */
  it('vergleicht Zahl und Zeichenkette gutmütig', () => {
    assert.equal(bedingungenErfuellt({ betrag: '480' }, vorgang), true);
    assert.equal(bedingungenErfuellt({ betrag: { gt: '400' } }, vorgang), true);
  });

  /**
   * Ein Zahlenvergleich auf einem nicht-zahligen Wert ergibt **false**, nicht
   * einen Fehler. Eine Regel „Betrag über 500" auf einem Vorgang ohne Betrag
   * soll nicht greifen — und den Lauf nicht scheitern lassen.
   */
  it('scheitert nicht an unpassenden Typen', () => {
    assert.doesNotThrow(() => bedingungenErfuellt({ status: { gt: 5 } }, vorgang));
    assert.equal(bedingungenErfuellt({ status: { gt: 5 } }, vorgang), false);
    assert.equal(bedingungenErfuellt({ 'kunde.gibtesnicht': { gt: 5 } }, vorgang), false);
  });
});

// ===========================================================================
//  Vorlagen
// ===========================================================================

describe('Vorlagen', () => {
  const vorgang = { entity: 'Booking', entityId: 'x', nummer: 'BU-2026-0001', kunde: { vorname: 'Anna' } };

  it('füllt Platzhalter über Punktpfade', () => {
    const { text } = fuelleVorlage('Guten Tag {{kunde.vorname}}, Ihre Buchung {{nummer}}.', vorgang);
    assert.equal(text, 'Guten Tag Anna, Ihre Buchung BU-2026-0001.');
  });

  /**
   * Bleibt der Platzhalter stehen, geht `Guten Tag {{kunde.vorname}}` an die
   * Kundschaft und sieht nach einem defekten System aus. Leer ist still
   * falsch, aber nicht peinlich — und die Liste sagt der Vorlagenpflege,
   * welcher Wert gefehlt hat.
   */
  it('ersetzt unbekannte Platzhalter durch nichts und meldet sie', () => {
    const { text, fehlendePlatzhalter } = fuelleVorlage('Hallo {{gibtesnicht}}!', vorgang);
    assert.equal(text, 'Hallo !');
    assert.deepEqual(fehlendePlatzhalter, ['gibtesnicht']);
  });

  /**
   * Auch bei Werten aus der eigenen Datenbank: Ein Kundenname kommt aus einem
   * öffentlichen Buchungsformular. Wer dort Markup einträgt, schriebe es sonst
   * in jede E-Mail, die seinen Namen nennt — und in die Kopie im Büro.
   */
  it('maskiert HTML im HTML-Modus', () => {
    const boes = { kunde: { vorname: '<img src=x onerror=alert(1)>' } };
    const { text } = fuelleVorlage('Hallo {{kunde.vorname}}', boes, { html: true });

    assert.ok(!text.includes('<img'), 'kein rohes Markup');
    assert.ok(text.includes('&lt;img'), 'sondern maskiert');
  });

  it('führt keinen Ausdruck aus — es gibt keinen', () => {
    const { text } = fuelleVorlage('{{ kunde.vorname }} {{nummer}}', vorgang);
    assert.equal(text, 'Anna BU-2026-0001');

    // Nichts, was nach Logik aussieht, wird ausgewertet.
    const mitLogik = fuelleVorlage('{{#if x}}ja{{/if}}', vorgang);
    assert.equal(mitLogik.text, '{{#if x}}ja{{/if}}');
  });

  it('sagt, welche Platzhalter eine Vorlage braucht', () => {
    assert.deepEqual(platzhalterIn('{{a}} und {{b.c}} und nochmal {{a}}'), ['a', 'b.c']);
  });
});

// ===========================================================================
//  Aktionskonfiguration
// ===========================================================================

/**
 * B-19 (2026-09-28): Eine Statusregel schrieb ohne Bedingung auf den
 * Ausgangszustand — sie holte abgesagte Einsätze zurück und sagte
 * abgeschlossene ab. Jetzt steht der zulässige Ausgangszustand im `where`.
 */
describe('Statusregeln: nur aus zulässigen Ausgangszuständen', () => {
  it('jedes erlaubte Ziel hat Ausgangszustände; Abgeschlossenes, Abgesagtes und Begonnenes gehören nie dazu', () => {
    for (const [ziel, stati] of Object.entries(ERLAUBTE_STATUSAENDERUNGEN)) {
      for (const status of stati) {
        const von = ausgangszustaendeFuer(ziel, status);
        assert.ok(von.length > 0, `${ziel} → ${status} hat keinen Ausgangszustand`);
        for (const tabu of ['COMPLETED', 'VERIFIED', 'CANCELLED', 'IN_PROGRESS', 'EN_ROUTE', 'WON']) {
          assert.ok(!von.includes(tabu), `${ziel} → ${status} darf nicht aus ${tabu} wechseln`);
        }
      }
    }
  });

  it('ein nicht zugelassener Wechsel hat keinen Ausgangszustand', () => {
    assert.deepEqual(ausgangszustaendeFuer('job', 'COMPLETED'), []);
    assert.deepEqual(ausgangszustaendeFuer('invoice', 'PAID'), []);
  });
});

describe('Aktionskonfiguration', () => {
  it('nimmt eine vollständige Konfiguration an', () => {
    assert.equal(
      pruefeAktionsKonfiguration('CREATE_TASK', { titel: 'Nachfassen', faelligInTagen: 3 }).ok,
      true,
    );
    assert.equal(
      pruefeAktionsKonfiguration('SEND_EMAIL', { templateKey: 'booking_reminder' }).ok,
      true,
    );
  });

  it('weist eine unvollständige ab und sagt warum', () => {
    const befund = pruefeAktionsKonfiguration('CREATE_TASK', {});
    assert.equal(befund.ok, false);
    assert.ok(befund.grund?.includes('titel'), `Grund nennt das Feld nicht: ${befund.grund}`);
  });

  /**
   * Die Sicherheitsmassnahme hinter `UPDATE_STATUS`. Ohne die Liste hiesse
   * die Aktion: „schreibe in ein beliebiges Feld eines beliebigen Datensatzes
   * einen beliebigen Wert".
   */
  it('lässt nur die freigegebenen Statuswerte zu', () => {
    assert.equal(pruefeAktionsKonfiguration('UPDATE_STATUS', { ziel: 'lead', status: 'LOST' }).ok, true);
    assert.equal(
      pruefeAktionsKonfiguration('UPDATE_STATUS', { ziel: 'lead', status: 'BELIEBIG' }).ok,
      false,
    );
  });

  /**
   * Finanzielles ist ausdrücklich nicht dabei und darf nicht nachträglich
   * hinzukommen: Belegnummern sind lückenlos zu vergeben (Art. 957a OR), und
   * eine ausgestellte Rechnung ist unveränderlich.
   */
  it('kennt kein Ziel im Finanzbereich', () => {
    for (const ziel of ['invoice', 'payment', 'quote']) {
      assert.equal(
        pruefeAktionsKonfiguration('UPDATE_STATUS', { ziel, status: 'PAID' }).ok,
        false,
        `„${ziel}" darf nicht automatisch änderbar sein`,
      );
    }
  });

  it('verlangt beim Webhook https und eine vollständige Adresse', () => {
    assert.equal(pruefeAktionsKonfiguration('WEBHOOK', { url: 'https://beispiel.ch/h' }).ok, true);
    assert.equal(pruefeAktionsKonfiguration('WEBHOOK', { url: 'http://beispiel.ch/h' }).ok, false);
    assert.equal(pruefeAktionsKonfiguration('WEBHOOK', { url: 'nicht-mal-eine-adresse' }).ok, false);
  });

  it('kennt keine freie Empfängeradresse', () => {
    const befund = pruefeAktionsKonfiguration('SEND_EMAIL', {
      templateKey: 'x_y',
      empfaenger: 'chef@konkurrenz.ch',
    });
    assert.equal(befund.ok, false, 'der Empfänger ergibt sich aus der Rolle, nicht aus einem Feld');
  });

  it('weist eine unbekannte Aktionsart ab', () => {
    assert.equal(pruefeAktionsKonfiguration('RAKETE_STARTEN', {}).ok, false);
  });
});

// ===========================================================================
//  Adressprüfung
// ===========================================================================

describe('Ausgehende Aufrufe — die Adressprüfung', () => {
  /**
   * Die Liste ist bewusst grosszügig: Im Zweifel abweisen. Ein zu Unrecht
   * abgewiesener Webhook ist eine Nachfrage, ein zu Unrecht erlaubter ist ein
   * Vorfall.
   */
  it('erkennt private und besondere Bereiche', () => {
    const privat = [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      // Der Metadatendienst der Cloud — gibt Zugangsdaten heraus.
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1',
      '224.0.0.1',
      '::1',
      'fe80::1',
      'fd00::1',
      // Dieselbe Rückschleife in IPv6-Schreibweise. Ohne diesen Fall wäre die
      // ganze IPv4-Prüfung mit einer anderen Notation zu umgehen.
      '::ffff:127.0.0.1',
      // Bis 2026-09-27 durchgelassen — die Prüfung arbeitete mit Präfixen der
      // Zeichenkette statt mit der Adresse:
      '::ffff:7f00:1', // = 127.0.0.1, hexadezimal gemappt
      '::127.0.0.1', // IPv4-kompatibel
      '64:ff9b::a9fe:a9fe', // NAT64 auf 169.254.169.254
      '2002:a9fe:a9fe::1', // 6to4 aus 169.254.169.254
      '2001:0:4136:e378::1', // Teredo
      'fe81::1', // link-local, aber nicht „fe80"
      'fec0::1', // site-local
      '198.18.0.1', // Benchmarking
      '203.0.113.7', // Dokumentation
      '0:0:0:0:0:0:0:1', // ::1 ausgeschrieben
      // Bis 2026-09-28 durchgelassen (B-18):
      '64:ff9b:1::a9fe:a9fe', // lokales NAT64 (RFC 8215)
      '192.88.99.1', // 6to4-Relay-Anycast
    ];

    for (const adresse of privat) {
      assert.equal(istPrivateAdresse(adresse), true, `${adresse} muss abgewiesen werden`);
    }
  });

  it('lässt öffentliche Adressen durch', () => {
    for (const adresse of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) {
      assert.equal(istPrivateAdresse(adresse), false, `${adresse} ist öffentlich`);
    }
  });

  it('weist Unsinn ab, statt ihn durchzulassen', () => {
    for (const unsinn of ['', 'localhost', 'kein-ip', '999.999.999.999']) {
      assert.equal(istPrivateAdresse(unsinn), true, `„${unsinn}" ist keine öffentliche Adresse`);
    }
  });

  it('prüft das Schema vor allem anderen', async () => {
    const http = await pruefeZiel('http://beispiel.ch/h');
    assert.equal(http.ok, false);
    assert.equal(http.ok === false && http.fehler, 'SCHEMA');
  });

  it('weist eine unmittelbar angegebene private Adresse ab', async () => {
    const ergebnis = await pruefeZiel('https://127.0.0.1/hook');
    assert.equal(ergebnis.ok, false);
    assert.equal(ergebnis.ok === false && ergebnis.fehler, 'PRIVATE_ADRESSE');
  });

  it('weist ein IPv6-Literal in Klammern ab, statt es als Namen aufzulösen', async () => {
    const ergebnis = await pruefeZiel('https://[::1]/hook', async () => {
      throw new Error('darf nicht aufgelöst werden');
    });
    assert.equal(ergebnis.ok === false && ergebnis.fehler, 'PRIVATE_ADRESSE');
  });

  /**
   * Der Fall, an dem eine Prüfung über die Zeichenkette scheitern würde: Ein
   * Name, der auf die Rückschleife zeigt. Bis 2026-09-27 hing dieser Fall an
   * einem echten DNS-Namen (`localtest.me`) und übersprang sich ohne
   * Namensauflösung. Jetzt mit einer kontrollierten Auflösung — immer
   * ausgeführt, nie übersprungen, ohne Netz.
   */
  it('weist einen Namen ab, der auf die Rückschleife zeigt — auch wenn nur eine von mehreren Antworten privat ist', async () => {
    const nurPrivat = await pruefeZiel('https://intern.pruef.example/hook', async () => [{ address: '127.0.0.1', family: 4 }]);
    assert.equal(nurPrivat.ok === false && nurPrivat.fehler, 'PRIVATE_ADRESSE');
    const gemischt = await pruefeZiel('https://gemischt.pruef.example/hook', async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    assert.equal(gemischt.ok === false && gemischt.fehler, 'PRIVATE_ADRESSE');
  });

  /**
   * DNS Rebinding (2026-09-27). Die Prüfung löste auf, und `fetch` löste
   * danach selbst noch einmal auf — ein Name, der beim ersten Mal öffentlich
   * und beim zweiten Mal `169.254.169.254` antwortet, kam durch. Die
   * kontrollierte Auflösung hier tut genau das. Die Verbindung muss an der
   * zweiten Antwort scheitern — vor jedem Byte ins Netz, deshalb braucht
   * diese Prüfung weder Netz noch Gegenstelle.
   */
  it('DNS Rebinding: erst öffentlich, beim Verbinden privat — die Verbindung wird verweigert', async () => {
    let aufrufe = 0;
    const kippend = async () => {
      aufrufe += 1;
      return aufrufe === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '169.254.169.254', family: 4 }];
    };
    const ergebnis = await sendeWebhook({ url: 'https://kippt.pruef.example/hook', rumpf: { test: true }, secret: 'x', aufloesen: kippend });
    assert.equal(aufrufe >= 2, true, 'die Verbindung hat selbst aufgelöst — über die geprüfte Funktion');
    assert.equal(ergebnis.ok, false);
    assert.equal(ergebnis.fehler, 'PRIVATE_ADRESSE', JSON.stringify(ergebnis));
  });

  it('die Verbindungsauflösung prüft auch mehrere Antworten (Happy Eyeballs)', async () => {
    const aufloesung = pruefendeVerbindungsaufloesung(async () => [
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '::ffff:7f00:1', family: 6 },
    ]);
    const fehler = await new Promise<Error | null>((fertig) => aufloesung('x.pruef.example', { all: true }, (e) => fertig(e)));
    assert.ok(fehler, 'eine private Antwort unter mehreren muss die Verbindung verhindern');
  });
});

// ===========================================================================
//  Über HTTP: die Maschine läuft wirklich
// ===========================================================================

/**
 * Eine Buchung im Büro erfassen.
 *
 * Die Einsatzadresse ist Pflicht — ohne sie antwortet die Validierung mit 422
 * („Bitte geben Sie die Einsatzadresse an."). Sie wird hier mitgegeben statt
 * über `addressId` gesucht: Welche Adresse eine Demokundschaft hat, ist eine
 * Frage an den Bestand, und diese Prüfreihe soll nicht daran hängen.
 */
async function erfasseBuchung(customerId: string, serviceId: string, inTagen: number) {
  const termin = new Date(Date.now() + inTagen * 24 * 60 * 60 * 1000);
  termin.setUTCHours(8, 0, 0, 0);

  return post<{ data: { id: string; number: string } }>(
    '/api/bookings',
    {
      customerId,
      serviceId,
      scheduledStart: termin.toISOString(),
      squareMeters: 80,
      rooms: 3,
      propertyKind: 'APARTMENT',
      frequency: 'ONCE',
      extras: [],
      source: 'PHONE',
      overrideCapacity: true,
      address: {
        street: 'Prüfweg',
        streetNo: '1',
        postalCode: '3000',
        city: 'Bern',
      },
    },
    { jar: jars.admin },
  );
}

describe('Die Maschine — vom Auslöser bis zum Lauf', () => {
  let automationId = '';
  let bookingId = '';

  before(async () => {
    await requireServer();
    jars = await loginAll();
  });

  after(async () => {
    if (automationId) {
      await del(`/api/automations/${automationId}`, { jar: jars.admin }).catch(() => {});
    }
    await testDbSchliessen();
  });

  it('weist eine Regel mit unbrauchbarer Aktionskonfiguration ab', async () => {
    const antwort = await post(
      '/api/automations',
      {
        name: 'Unbrauchbar',
        trigger: 'BOOKING_CREATED',
        actions: [{ type: 'CREATE_TASK', config: {} }],
      },
      { jar: jars.admin },
    );

    assert.equal(antwort.status, 422, 'Zod-Fehler kommen als 422');
    assert.ok(
      JSON.stringify(antwort.payload).includes('titel'),
      'die Meldung soll das fehlende Feld nennen',
    );
  });

  it('weist eine Regel ab, die einen Rechnungsstatus setzen will', async () => {
    const antwort = await post(
      '/api/automations',
      {
        name: 'Rechnung bezahlt setzen',
        trigger: 'INVOICE_ISSUED',
        actions: [{ type: 'UPDATE_STATUS', config: { ziel: 'invoice', status: 'PAID' } }],
      },
      { jar: jars.admin },
    );

    assert.equal(antwort.status, 422, 'Finanzielles ist nicht automatisch änderbar');
  });

  it('weist eine Regel mit privater Webhook-Adresse ab', async () => {
    const antwort = await post(
      '/api/automations',
      {
        name: 'Interner Aufruf',
        trigger: 'BOOKING_CREATED',
        actions: [{ type: 'WEBHOOK', config: { url: 'http://127.0.0.1:5432/' } }],
      },
      { jar: jars.admin },
    );

    assert.equal(antwort.status, 422, 'http scheitert schon am Schema');
  });

  /**
   * **Die Kernprüfung dieser Wave.**
   *
   * Regel anlegen, echte Buchung erfassen, in `automation_runs` nachsehen.
   * Über HTTP allein wäre nicht zu unterscheiden, ob die Maschine läuft oder
   * ob wieder nichts passiert — die Buchung entsteht in beiden Fällen.
   */
  it('ein echter Geschäftsvorgang erzeugt einen Lauf', async (t) => {
    const db = testDb();
    if (!db) return t.skip(`kein Zugang zur Testdatenbank: ${testDbGrund()}`);

    const regel = await post<{ data: { id: string } }>(
      '/api/automations',
      {
        name: `Prüfreihe ${Date.now()}`,
        description: 'Legt bei jeder neuen Buchung eine Aufgabe an.',
        trigger: 'BOOKING_CREATED',
        conditions: {},
        delayMinutes: 0,
        active: true,
        actions: [
          {
            type: 'CREATE_TASK',
            config: { titel: 'Buchung {{nummer}} prüfen', faelligInTagen: 1 },
            position: 0,
          },
        ],
      },
      { jar: jars.admin },
    );
    assert.equal(regel.status, 201, 'die Regel muss sich anlegen lassen');
    automationId = data(regel).id;

    // Eine echte Buchung über die Schnittstelle des Büros.
    const kunden = await get<{ data: { id: string }[] }>('/api/customers?pageSize=1', {
      jar: jars.admin,
    });
    const kunde = data(kunden)?.[0];
    if (!kunde) return t.skip('keine Kundenakte im Bestand');

    const dienste = await get<{ data: { id: string }[] }>('/api/services', { jar: jars.admin });
    const dienst = data(dienste)?.[0];
    if (!dienst) return t.skip('keine Leistung im Bestand');

    const buchung = await erfasseBuchung(kunde.id, dienst.id, 14);
    if (buchung.status !== 201) {
      throw new Error(
        `Buchung liess sich nicht erfassen (Status ${buchung.status}): ` +
          JSON.stringify(buchung.payload).slice(0, 300),
      );
    }
    bookingId = data(buchung).id;

    const laeufe = await db.automationRun.findMany({
      where: { automationId, entity: 'Booking', entityId: bookingId },
      select: { id: true, status: true, scheduledFor: true, attempts: true },
    });

    assert.equal(laeufe.length, 1, 'genau ein Lauf — das ist der Punkt der ganzen Wave');
    assert.equal(laeufe[0].status, 'PENDING');
    assert.equal(laeufe[0].attempts, 0, 'angelegt, noch nicht versucht');
  });

  /**
   * Eine Gegenprüfung, die nicht zur Automatisierung gehört und trotzdem
   * hierher: Diese Reihe hat den Fehler ausgelöst, also hält sie ihn fest.
   *
   * `createAddress` in `booking.service.ts` setzte `isDefault` und `isBilling`
   * bedingungslos auf `true`. Wer dreimal mit einer neuen Adresse buchte,
   * hatte danach drei Standard- und drei Rechnungsadressen — während die
   * Adressverwaltung genau eine erzwingt. Und weil `invoice.service.ts` die
   * Rechnungsadresse mit `take: 1` **ohne Sortierung** holt, wäre der
   * Rechnungsempfänger von Lauf zu Lauf ein anderer gewesen.
   */
  it('eine Buchung mit neuer Adresse lässt genau eine Standardadresse zurück', async (t) => {
    const db = testDb();
    if (!db) return t.skip(`kein Zugang zur Testdatenbank: ${testDbGrund()}`);

    const kunden = await get<{ data: { id: string }[] }>('/api/customers?pageSize=1', {
      jar: jars.admin,
    });
    const dienste = await get<{ data: { id: string }[] }>('/api/services', { jar: jars.admin });
    const kunde = data(kunden)?.[0];
    const dienst = data(dienste)?.[0];
    if (!kunde || !dienst) return t.skip('Bestand reicht nicht');

    // Zweimal buchen, jedes Mal mit einer neuen Adresse.
    for (const tage of [28, 35]) {
      const antwort = await erfasseBuchung(kunde.id, dienst.id, tage);
      assert.equal(antwort.status, 201, 'die Buchung muss gelingen');
    }

    const standard = await db.address.count({ where: { customerId: kunde.id, isDefault: true } });
    const rechnung = await db.address.count({ where: { customerId: kunde.id, isBilling: true } });

    assert.equal(standard, 1, 'genau eine Standardadresse — das ist die Regel der Adressverwaltung');
    assert.equal(
      rechnung,
      1,
      'und genau eine Rechnungsadresse, sonst ist der Rechnungsempfänger nicht bestimmt',
    );
  });

  /**
   * Der Teilindex `@@unique([automationId, entity, entityId])` ist die
   * Vorkehrung gegen doppelte E-Mails. Er wird hier direkt geprüft, weil ein
   * zweiter Auslöser über HTTP nicht herbeizuführen ist — eine Buchung lässt
   * sich nicht zweimal anlegen.
   */
  it('derselbe Vorgang erzeugt keinen zweiten Lauf', async (t) => {
    const db = testDb();
    if (!db || !automationId || !bookingId) return t.skip('kein Lauf aus dem vorherigen Fall');

    await assert.rejects(
      db.automationRun.create({
        data: {
          automationId,
          entity: 'Booking',
          entityId: bookingId,
          status: 'PENDING',
          scheduledFor: new Date(),
        },
      }),
      'der Teilindex muss den zweiten Lauf verhindern',
    );
  });

  /**
   * Eine abgeschaltete Regel erzeugt nichts. Das klingt selbstverständlich
   * und ist die Prüfung, die fehlt, wenn jemand den Filter beim Auslösen
   * vergisst — dann laufen abgeschaltete Regeln weiter, und niemand versteht,
   * warum die E-Mails nicht aufhören.
   */
  it('eine abgeschaltete Regel löst nicht mehr aus', async (t) => {
    const db = testDb();
    if (!db || !automationId) return t.skip('keine Regel aus dem vorherigen Fall');

    const aus = await patch(`/api/automations/${automationId}`, { active: false }, { jar: jars.admin });
    assert.ok(aus.status === 200 || aus.status === 204, `Abschalten kam mit ${aus.status}`);

    const vorher = await db.automationRun.count({ where: { automationId } });

    const kunden = await get<{ data: { id: string }[] }>('/api/customers?pageSize=1', {
      jar: jars.admin,
    });
    const dienste = await get<{ data: { id: string }[] }>('/api/services', { jar: jars.admin });
    const kunde = data(kunden)?.[0];
    const dienst = data(dienste)?.[0];
    if (!kunde || !dienst) return t.skip('Bestand reicht nicht');

    const buchung = await erfasseBuchung(kunde.id, dienst.id, 21);
    assert.equal(buchung.status, 201, 'die zweite Buchung muss ebenfalls gelingen');

    const nachher = await db.automationRun.count({ where: { automationId } });
    assert.equal(nachher, vorher, 'eine abgeschaltete Regel erzeugt keinen Lauf');
  });
});

// ===========================================================================
//  Rechte
// ===========================================================================

describe('Wer Regeln anlegen darf', () => {
  before(async () => {
    await requireServer();
    jars = await loginAll();
  });

  it('Mitarbeitende und Kundschaft nicht', async () => {
    for (const rolle of ['employee', 'customer'] as AccountName[]) {
      const antwort = await post(
        '/api/automations',
        {
          name: 'Unerlaubt',
          trigger: 'BOOKING_CREATED',
          actions: [{ type: 'CREATE_TASK', config: { titel: 'x y z' } }],
        },
        { jar: jars[rolle] },
      );
      assert.ok(
        antwort.status === 403 || antwort.status === 401,
        `${rolle} darf keine Regeln anlegen (kam ${antwort.status})`,
      );
    }
  });

  it('ohne Anmeldung gar nichts', async () => {
    const antwort = await get('/api/automations');
    assert.equal(antwort.status, 401);
  });
});

// ===========================================================================
//  RB-012 — jeder Auslöser hat einen Erzeuger, und ein Lauf wird ausgeführt
// ===========================================================================

describe('RB-012 — kein Auslöser ohne Erzeuger', () => {
  /**
   * Bis 2026-09-23 bot die Oberfläche zwanzig Auslöser an; elf davon
   * entstanden nie. Diese Prüfung liest den Quelltext: Jeder Auslöser der
   * Liste muss entweder als `trigger: '…'` in einem Dienst gemeldet werden
   * oder als zeitbezogene Regel in `automation-zeittrigger.service.ts`
   * stehen. Ein neuer Auslöser ohne Erzeuger lässt diese Prüfung scheitern —
   * genau dort, wo er sonst still wirkungslos wäre.
   */
  it('jeder angebotene Auslöser wird irgendwo erzeugt', async () => {
    const { AUTOMATION_TRIGGERS } = await import('../../src/lib/validation/operations-admin');
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dienste = join(__dirname, '..', '..', 'src', 'server', 'services');
    const quelltext = readdirSync(dienste)
      .filter((d) => d.endsWith('.ts'))
      .map((d) => readFileSync(join(dienste, d), 'utf8'))
      .join('\n');
    const zeitregeln = readFileSync(join(dienste, 'automation-zeittrigger.service.ts'), 'utf8');
    const zeitBlock = zeitregeln.slice(zeitregeln.indexOf('export const ZEITREGELN'), zeitregeln.indexOf('export const EREIGNIS_AUSLOESER'));

    const ohneErzeuger = AUTOMATION_TRIGGERS.filter(
      (t) => !quelltext.includes(`trigger: '${t}'`) && !new RegExp(`^\\s+${t}:`, 'm').test(zeitBlock),
    );
    assert.deepEqual(ohneErzeuger, [], `Auslöser ohne Erzeuger: ${ohneErzeuger.join(', ')}`);
  });
});

describe('RB-012 — vom zeitbezogenen Auslöser bis zur ausgeführten Aktion', () => {
  let regelId = '';
  const aufgaben: string[] = [];

  before(async () => {
    await requireServer();
    jars = await loginAll();
  });

  after(async () => {
    if (regelId) await del(`/api/automations/${regelId}`, { jar: jars.admin }).catch(() => {});
    for (const id of aufgaben) await del(`/api/tasks/${id}`, { jar: jars.admin }).catch(() => {});
    await testDbSchliessen();
  });

  const cronSecret = () => process.env.CRON_SECRET ?? 'dev-cron-secret';
  const stuendlich = () => get('/api/cron/hourly', { headers: { authorization: `Bearer ${cronSecret()}` } });

  /**
   * Der ganze Weg: Regel „Aufgabe wird fällig" → Aufgabe mit Frist in 30
   * Minuten → stündlicher Lauf meldet sie mit der Frist als Bezug → der Lauf
   * wird zur Frist fällig → ausgeführt. Und die Gegenprobe: Eine Aufgabe, die
   * vor der Ausführung erledigt wird, erzeugt keine Aktion — der Anlass wird
   * beim Ausführen noch einmal geprüft.
   */
  it('TASK_DUE: gemeldet mit Bezug auf die Frist, ausgeführt, und übersprungen, wenn der Anlass fehlt', async (t) => {
    const db = testDb();
    if (!db) return t.skip(`kein Zugang zur Testdatenbank: ${testDbGrund()}`);

    const regel = await post<{ data: { id: string } }>(
      '/api/automations',
      {
        name: `Frist-Prüfung ${Date.now()}`,
        trigger: 'TASK_DUE',
        delayMinutes: 0,
        active: true,
        actions: [{ type: 'CREATE_NOTIFICATION', config: { titel: 'Aufgabe fällig: {{titel}}', empfaenger: 'MANAGEMENT' } }],
      },
      { jar: jars.admin },
    );
    assert.equal(regel.status, 201, JSON.stringify(regel.payload));
    regelId = data(regel).id;

    const frist = new Date(Date.now() + 30 * 60_000);
    const anlegen = async (titel: string) => {
      const antwort = await post<{ data: { id: string } }>('/api/tasks', { title: titel, dueAt: frist.toISOString() }, { jar: jars.admin });
      assert.equal(antwort.status, 201, JSON.stringify(antwort.payload));
      aufgaben.push(data(antwort).id);
      return data(antwort).id;
    };
    const offen = await anlegen(`Prüfreihe offen ${Date.now()}`);
    const erledigt = await anlegen(`Prüfreihe erledigt ${Date.now()}`);

    const erster = await stuendlich();
    assert.ok([200, 500].includes(erster.status), `stündlicher Lauf: HTTP ${erster.status}`);

    // Nur die eigenen Aufgaben zählen: Offene Aufgaben aus dem Demobestand,
    // deren Frist im Suchfenster liegt, meldet der Lauf zu Recht ebenfalls.
    const eigene = { automationId: regelId, entityId: { in: [offen, erledigt] } };
    const laeufe = await db.automationRun.findMany({ where: eigene, orderBy: { entityId: 'asc' } });
    assert.equal(laeufe.length, 2, 'Beide Aufgaben wurden gemeldet');
    for (const lauf of laeufe) {
      assert.equal(lauf.status, 'PENDING', 'Vor der Frist wird noch nicht ausgeführt');
      assert.ok(Math.abs(lauf.scheduledFor.getTime() - frist.getTime()) < 60_000, 'Fällig zur Frist, nicht zum Suchlauf');
    }

    // Zeit vergehen lassen: die Läufe fällig machen; eine Aufgabe erledigen.
    await db.automationRun.updateMany({ where: eigene, data: { scheduledFor: new Date(Date.now() - 60_000) } });
    await db.task.update({ where: { id: erledigt }, data: { status: 'DONE', completedAt: new Date() } });

    const zweiter = await stuendlich();
    assert.ok([200, 500].includes(zweiter.status));
    const nachher = await db.automationRun.findMany({ where: eigene, include: { aktionen: true } });
    const offenerLauf = nachher.find((l) => l.entityId === offen);
    // Mit Fehlertext und Lauf-Antwort: Bleibt der Lauf stehen, soll die
    // Meldung sagen, ob er gar nicht angefasst wurde (Antwort des Takts) oder
    // gescheitert und zurückgestellt ist (Fehler, Versuche).
    assert.equal(
      offenerLauf?.status,
      'SUCCESS',
      `Die offene Aufgabe löst die Aktion aus — Versuche ${offenerLauf?.attempts}, Fehler ${offenerLauf?.error ?? '—'}, Aktionen ${JSON.stringify(offenerLauf?.aktionen.map((a) => [a.status, a.error]))}, Takt HTTP ${zweiter.status} ${JSON.stringify(zweiter.payload).slice(0, 600)}`,
    );
    assert.equal(nachher.find((l) => l.entityId === erledigt)?.status, 'SKIPPED', 'Die erledigte nicht mehr');

    // Ein dritter Lauf meldet nichts doppelt.
    await stuendlich();
    assert.equal(await db.automationRun.count({ where: eigene }), 2, 'Je Aufgabe genau ein Lauf');
  });

  /**
   * Ein Lauf, dessen Prozess mittendrin starb, stand für immer auf RUNNING —
   * der Scheduler sucht nur PENDING. Jetzt nimmt ihn der nächste Takt wieder
   * auf; ohne übrige Versuche endet er als FAILED mit Grund.
   */
  it('nimmt hängende Läufe wieder auf — und gibt sie nach dem letzten Versuch als FAILED auf', async (t) => {
    const db = testDb();
    if (!db) return t.skip(`kein Zugang zur Testdatenbank: ${testDbGrund()}`);
    assert.ok(regelId, 'Die Regel aus dem vorigen Fall fehlt');

    const vorlage = await db.automationRun.findFirst({ where: { automationId: regelId }, select: { entity: true } });
    assert.ok(vorlage, 'Kein Lauf als Vorlage');
    const langeHer = new Date(Date.now() - 2 * 3_600_000);
    const anlegen = (entityId: string, attempts: number) =>
      db.automationRun.create({
        data: {
          automationId: regelId,
          entity: vorlage.entity,
          entityId,
          status: 'RUNNING',
          startedAt: langeHer,
          scheduledFor: langeHer,
          attempts,
        },
        select: { id: true },
      });
    const nochVersuche = await anlegen(`haengt-${Date.now()}-a`, 1);
    const erschoepft = await anlegen(`haengt-${Date.now()}-b`, 3);

    await stuendlich();

    const a = await db.automationRun.findUniqueOrThrow({ where: { id: nochVersuche.id } });
    const b = await db.automationRun.findUniqueOrThrow({ where: { id: erschoepft.id } });
    assert.notEqual(a.status, 'RUNNING', 'Der hängende Lauf wurde wieder aufgenommen');
    // Der Vorgang existiert nicht (erfundene Kennung) — also SKIPPED nach der
    // Wiederaufnahme, aber nicht mehr RUNNING und nicht still liegen geblieben.
    assert.ok(['PENDING', 'SKIPPED'].includes(a.status), `Status ${a.status}`);
    assert.equal(b.status, 'FAILED', 'Ohne übrige Versuche endet er sichtbar');
    assert.match(b.error ?? '', /Abgebrochen/);

    await db.automationRun.deleteMany({ where: { id: { in: [nochVersuche.id, erschoepft.id] } } });
  });
});

/**
 * Genau einmal je Aktion (2026-09-27).
 *
 * Ein Lauf mit zwei Aktionen, deren zweite scheitert, wurde als Ganzes
 * wiederholt — und die erste lief bei jedem Versuch erneut: Aufgaben
 * doppelt, E-Mails an bereits Erreichte noch einmal. Der Code nahm das
 * ausdrücklich in Kauf. Jetzt trägt jede Aktion ihren eigenen Stand
 * (`AutomationActionRun`); ein Wiederholungsversuch setzt bei der
 * gescheiterten fort. Eine Aktion mit Aussenwirkung, deren Prozess
 * mittendrin starb, wird nicht blind wiederholt, sondern als „Wirkung
 * ungewiss" beendet — lieber eine Nachfrage als eine zweite Wirkung.
 */
describe('Automatisierung — jede Aktion höchstens einmal', () => {
  let regelId = '';
  const aufgaben: string[] = [];
  const RUN = Date.now();

  before(async () => {
    await requireServer();
    jars = await loginAll();
  });

  after(async () => {
    const db = testDb();
    if (regelId) await del(`/api/automations/${regelId}`, { jar: jars.admin }).catch(() => {});
    for (const id of aufgaben) await del(`/api/tasks/${id}`, { jar: jars.admin }).catch(() => {});
    if (db) await db.task.deleteMany({ where: { title: { startsWith: `Folgeaufgabe Einmal ${RUN}` } } });
    await testDbSchliessen();
  });

  const stuendlich = () => get('/api/cron/hourly', { headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? 'dev-cron-secret'}` } });

  it('scheitert die zweite Aktion, läuft die erste beim Wiederholen nicht noch einmal', async (t) => {
    const db = testDb();
    if (!db) return t.skip(`kein Zugang zur Testdatenbank: ${testDbGrund()}`);

    const regel = await post<{ data: { id: string } }>(
      '/api/automations',
      {
        name: `Einmal-Prüfung ${RUN}`,
        trigger: 'TASK_DUE',
        delayMinutes: 0,
        active: true,
        actions: [
          { type: 'CREATE_TASK', config: { titel: `Folgeaufgabe Einmal ${RUN} {{titel}}`, faelligInTagen: 1 } },
          // `.invalid` löst nie auf — ein vorübergehender Fehler, der
          // wiederholt wird, ohne Netz und ohne Gegenstelle.
          { type: 'WEBHOOK', config: { url: 'https://gegenstelle.pruef.invalid/hook' } },
        ],
      },
      { jar: jars.admin },
    );
    assert.equal(regel.status, 201, regel.text);
    regelId = data(regel).id;

    const aufgabe = await post<{ data: { id: string } }>('/api/tasks', { title: `Einmal ${RUN}`, dueAt: new Date(Date.now() + 30 * 60_000).toISOString() }, { jar: jars.admin });
    assert.equal(aufgabe.status, 201, aufgabe.text);
    aufgaben.push(data(aufgabe).id);

    await stuendlich();
    const eigene = { automationId: regelId, entityId: data(aufgabe).id };
    for (let versuch = 1; versuch <= 2; versuch++) {
      await db.automationRun.updateMany({ where: eigene, data: { scheduledFor: new Date(Date.now() - 60_000) } });
      await stuendlich();
    }

    // Nur die Folgeaufgabe der *eigenen* Aufgabe zählt: `{{titel}}` setzt
    // deren Titel ein. Eine offene Demo-Aufgabe, deren Frist zufällig im
    // Suchfenster des stündlichen Laufs liegt, löst dieselbe Regel zu Recht
    // ebenfalls aus — gezählt über das blosse Präfix lief „die erste Aktion"
    // dann scheinbar zweimal, je nach Uhrzeit des Prüflaufs (2026-09-27).
    const folge = await db.task.count({ where: { title: `Folgeaufgabe Einmal ${RUN} Einmal ${RUN}` } });
    assert.equal(folge, 1, `die erste Aktion lief ${folge}-mal`);

    const lauf = await db.automationRun.findFirstOrThrow({ where: eigene, include: { aktionen: { orderBy: { position: 'asc' } } } });
    assert.ok(lauf.attempts >= 2, `Versuche: ${lauf.attempts}`);
    assert.equal(lauf.aktionen[0]?.status, 'SUCCEEDED');
    assert.equal(lauf.aktionen[0]?.attempts, 1, 'die erfolgreiche Aktion wurde genau einmal ausgeführt');
    assert.equal(lauf.aktionen[1]?.status, 'FAILED');
    assert.ok((lauf.aktionen[1]?.attempts ?? 0) >= 2);
  });

  /**
   * Parität und Outbox (2026-09-27). Eine direkt ausgestellte Rechnung löste
   * „Rechnung ausgestellt" nie aus — nur der Weg über „Ausstellen" tat es.
   * Und das Ereignis entsteht jetzt in der Transaktion der Rechnung
   * (`AutomationEvent`) und ist danach verarbeitet.
   */
  it('eine direkt ausgestellte Rechnung löst INVOICE_ISSUED aus — über den Vermerk in ihrer Transaktion', async (t) => {
    const db = testDb();
    if (!db) return t.skip(`kein Zugang zur Testdatenbank: ${testDbGrund()}`);
    const regel = await post<{ data: { id: string } }>(
      '/api/automations',
      { name: `Parität ${RUN}`, trigger: 'INVOICE_ISSUED', delayMinutes: 60, active: true, actions: [{ type: 'CREATE_NOTIFICATION', config: { titel: 'Ausgestellt', empfaenger: 'MANAGEMENT' } }] },
      { jar: jars.admin },
    );
    assert.equal(regel.status, 201, regel.text);
    try {
      const kunde = data(await get<{ data: { id: string }[] }>('/api/customers?pageSize=1', { jar: jars.admin }))[0]!.id;
      const rechnung = await post<{ data: { id: string } }>(
        '/api/invoices',
        { customerId: kunde, notes: `Prüfreihe Parität ${RUN}`, items: [{ name: 'Reinigung', quantity: 1, unitPrice: 10 }], issueImmediately: true },
        { jar: jars.admin },
      );
      assert.equal(rechnung.status, 201, rechnung.text);
      const id = data(rechnung).id;
      const ereignis = await db.automationEvent.findFirst({ where: { trigger: 'INVOICE_ISSUED', entityId: id } });
      assert.ok(ereignis, 'kein Vermerk in der Transaktion der Rechnung');
      assert.ok(ereignis.processedAt, 'der Vermerk wurde nicht abgearbeitet');
      assert.equal(await db.automationRun.count({ where: { automationId: data(regel).id, entityId: id } }), 1, 'kein Lauf für die direkt ausgestellte Rechnung');
    } finally {
      await del(`/api/automations/${data(regel).id}`, { jar: jars.admin }).catch(() => {});
    }
  });

  it('eine Aktion mit Aussenwirkung, die mittendrin abbrach, wird nicht blind wiederholt', async (t) => {
    const db = testDb();
    if (!db) return t.skip(`kein Zugang zur Testdatenbank: ${testDbGrund()}`);
    assert.ok(regelId, 'Die Regel aus dem vorigen Fall fehlt');

    const aufgabe = await post<{ data: { id: string } }>('/api/tasks', { title: `Einmal abgebrochen ${RUN}`, dueAt: new Date().toISOString() }, { jar: jars.admin });
    aufgaben.push(data(aufgabe).id);
    const lauf = await db.automationRun.create({
      data: { automationId: regelId, entity: 'Task', entityId: data(aufgabe).id, status: 'PENDING', scheduledFor: new Date(Date.now() - 60_000) },
    });
    // Zustand nach einem Absturz mitten in Aktion 1 (Aufgabe anlegen): RUNNING, ohne Abschluss.
    await db.automationActionRun.create({ data: { runId: lauf.id, position: 0, type: 'CREATE_TASK', status: 'RUNNING', attempts: 1, startedAt: new Date(Date.now() - 3_600_000) } });

    await stuendlich();

    const nachher = await db.automationRun.findUniqueOrThrow({ where: { id: lauf.id }, include: { aktionen: { orderBy: { position: 'asc' } } } });
    assert.equal(nachher.status, 'FAILED', 'endgültig beendet, nicht wiederholt');
    assert.match(nachher.error ?? '', /ungewiss/i);
    assert.equal(await db.task.count({ where: { title: { startsWith: `Folgeaufgabe Einmal ${RUN} Einmal abgebrochen` } } }), 0, 'keine zweite Wirkung');
  });
});

/**
 * F-12 und N-07 (2026-09-27) — Erzeugerparität der Umwandlung, Identität einer
 * Aktion über eine Regeländerung hinweg, Alarm für liegengebliebene Ereignisse.
 *
 * Die Paritätsprüfung oben liest nur Quelltext: Sie findet `trigger:
 * 'BOOKING_CONFIRMED'` in `booking.service.ts` und ist zufrieden — dass die
 * Umwandlung einer Offerte eine bestätigte Buchung anlegt, ohne einen der
 * beiden Auslöser zu vermerken, sah sie nicht. Deshalb hier derselbe Weg wie
 * in der Kernprüfung der Wave: echter Vorgang über HTTP, dann in den Tabellen
 * nachsehen.
 */
describe('F-12/N-07 — Umwandlung, Regeländerung, liegengebliebene Ereignisse', () => {
  const RUN = Date.now();
  const regeln: string[] = [];
  const aufgaben: string[] = [];

  before(async () => {
    await requireServer();
    jars = await loginAll();
  });

  after(async () => {
    const db = testDb();
    for (const id of regeln) await del(`/api/automations/${id}`, { jar: jars.admin }).catch(() => {});
    for (const id of aufgaben) await del(`/api/tasks/${id}`, { jar: jars.admin }).catch(() => {});
    if (db) await db.task.deleteMany({ where: { title: { startsWith: `Folgeaufgabe Umgestellt ${RUN}` } } });
    await testDbSchliessen();
  });

  const stuendlich = () => get('/api/cron/hourly', { headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? 'dev-cron-secret'}` } });

  async function regelAnlegen(body: Record<string, unknown>): Promise<string> {
    const antwort = await post<{ data: { id: string } }>('/api/automations', body, { jar: jars.admin });
    assert.equal(antwort.status, 201, antwort.text);
    regeln.push(data(antwort).id);
    return data(antwort).id;
  }

  it('die Umwandlung Offerte → Buchung löst BOOKING_CREATED und BOOKING_CONFIRMED aus', async (t) => {
    const db = testDb();
    if (!db) return t.skip(`kein Zugang zur Testdatenbank: ${testDbGrund()}`);

    // Verzögert, damit die Läufe nur entstehen und nicht schon ausgeführt
    // werden — gefragt ist hier, ob sie entstehen.
    const regelAngelegt = await regelAnlegen({
      name: `Umwandlung angelegt ${RUN}`,
      trigger: 'BOOKING_CREATED',
      delayMinutes: 60,
      active: true,
      actions: [{ type: 'CREATE_NOTIFICATION', config: { titel: 'Buchung {{nummer}} angelegt', empfaenger: 'MANAGEMENT' } }],
    });
    const regelBestaetigt = await regelAnlegen({
      name: `Umwandlung bestätigt ${RUN}`,
      trigger: 'BOOKING_CONFIRMED',
      delayMinutes: 60,
      active: true,
      actions: [{ type: 'CREATE_NOTIFICATION', config: { titel: 'Buchung {{nummer}} bestätigt', empfaenger: 'MANAGEMENT' } }],
    });

    const kunde = data(await get<{ data: { id: string }[] }>('/api/customers?pageSize=1', { jar: jars.admin }))?.[0];
    const dienst = data(await get<{ data: { id: string }[] }>('/api/services', { jar: jars.admin }))?.[0];
    if (!kunde || !dienst) return t.skip('Bestand reicht nicht');

    const offerte = await post<{ data: { id: string } }>(
      '/api/quotes',
      {
        customerId: kunde.id,
        title: `Umwandlungsprüfung ${RUN}`,
        validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
        items: [
          { serviceId: dienst.id, name: 'Unterhaltsreinigung', quantity: 3, unit: 'Std.', unitPrice: 64, discount: 0, vatRate: 8.1, optional: false },
        ],
        discountValue: 0,
      },
      { jar: jars.admin },
    );
    assert.equal(offerte.status, 201, offerte.text);
    // Angenommen wie im Altbestand — der Signaturweg ist nicht Gegenstand
    // dieser Prüfung (`offertannahme.test.ts`), sondern was danach geschieht.
    await db.quote.update({ where: { id: data(offerte).id }, data: { status: 'ACCEPTED', acceptedAt: new Date() } });

    const termin = new Date(Date.now() + 20 * 86_400_000);
    termin.setUTCHours(8, 0, 0, 0);
    const umwandlung = await post<{ data: { id: string } }>(
      `/api/quotes/${data(offerte).id}/convert`,
      { target: 'BOOKING', scheduledStart: termin.toISOString() },
      { jar: jars.admin },
    );
    assert.equal(umwandlung.status, 201, umwandlung.text);
    const bookingId = data(umwandlung).id;

    const ereignisse = await db.automationEvent.findMany({ where: { entityId: bookingId }, select: { trigger: true, processedAt: true } });
    const ausloeser = ereignisse.map((e) => e.trigger);
    assert.ok(ausloeser.includes('BOOKING_CREATED'), `kein BOOKING_CREATED vermerkt (vermerkt: ${ausloeser.join(', ') || '—'})`);
    assert.ok(ausloeser.includes('BOOKING_CONFIRMED'), `kein BOOKING_CONFIRMED vermerkt (vermerkt: ${ausloeser.join(', ') || '—'})`);
    assert.ok(
      ereignisse.filter((e) => e.trigger === 'BOOKING_CREATED' || e.trigger === 'BOOKING_CONFIRMED').every((e) => e.processedAt),
      'die Vermerke wurden nach dem Commit abgearbeitet',
    );
    assert.equal(await db.automationRun.count({ where: { automationId: regelAngelegt, entityId: bookingId } }), 1, 'Lauf für „Buchung angelegt"');
    assert.equal(await db.automationRun.count({ where: { automationId: regelBestaetigt, entityId: bookingId } }), 1, 'Lauf für „Buchung bestätigt"');
  });

  /**
   * Die Regel wird geändert, während ein Lauf auf seine Wiederholung wartet:
   * Vorher stand an Stelle 0 ein Webhook, der scheiterte; danach steht dort
   * „Aufgabe anlegen". Der gespeicherte Stand „Stelle 0 gescheitert" gehört
   * zum Webhook. Bis 2026-09-27 wurde er als Stand der neuen Aktion gelesen
   * und die Aufgabe als „Fortsetzung" angelegt.
   */
  it('eine während der Wiederholung geänderte Regel führt an derselben Stelle keine andere Aktion als Fortsetzung aus', async (t) => {
    const db = testDb();
    if (!db) return t.skip(`kein Zugang zur Testdatenbank: ${testDbGrund()}`);

    const webhook = { type: 'WEBHOOK', config: { url: 'https://gegenstelle.pruef.invalid/umgestellt' } };
    const regelId = await regelAnlegen({
      name: `Umgestellt ${RUN}`,
      trigger: 'TASK_DUE',
      delayMinutes: 0,
      active: true,
      actions: [webhook],
    });

    const aufgabe = await post<{ data: { id: string } }>(
      '/api/tasks',
      { title: `Umgestellt ${RUN}`, dueAt: new Date(Date.now() + 30 * 60_000).toISOString() },
      { jar: jars.admin },
    );
    assert.equal(aufgabe.status, 201, aufgabe.text);
    aufgaben.push(data(aufgabe).id);
    const eigene = { automationId: regelId, entityId: data(aufgabe).id };

    // Erster Versuch: Der Webhook scheitert, der Lauf wartet auf die Wiederholung.
    await stuendlich();
    await db.automationRun.updateMany({ where: eigene, data: { scheduledFor: new Date(Date.now() - 60_000) } });
    await stuendlich();
    const wartend = await db.automationRun.findFirstOrThrow({ where: eigene, include: { aktionen: true } });
    assert.equal(wartend.status, 'PENDING', `Vorbedingung: Der Lauf wartet auf die Wiederholung (${wartend.status}, ${wartend.error ?? '—'})`);
    assert.equal(wartend.aktionen[0]?.type, 'WEBHOOK');
    assert.equal(wartend.aktionen[0]?.status, 'FAILED');

    // Die Regel umstellen: „Aufgabe anlegen" rückt an Stelle 0.
    const umgestellt = await patch(
      `/api/automations/${regelId}`,
      { actions: [{ type: 'CREATE_TASK', config: { titel: `Folgeaufgabe Umgestellt ${RUN} {{titel}}`, faelligInTagen: 1 } }, webhook] },
      { jar: jars.admin },
    );
    assert.ok([200, 204].includes(umgestellt.status), `Umstellen: HTTP ${umgestellt.status} ${umgestellt.text}`);

    await db.automationRun.updateMany({ where: eigene, data: { scheduledFor: new Date(Date.now() - 60_000) } });
    await stuendlich();

    const folge = await db.task.count({ where: { title: `Folgeaufgabe Umgestellt ${RUN} Umgestellt ${RUN}` } });
    assert.equal(folge, 0, 'die neue Aktion an Stelle 0 lief unter dem Stand der alten');
    const nachher = await db.automationRun.findFirstOrThrow({ where: eigene });
    assert.equal(nachher.status, 'FAILED', 'endgültig beendet, nicht still weitergeführt');
    assert.match(nachher.error ?? '', /Regel geändert/);
  });

  /**
   * Ein Ereignis, das `EREIGNIS_MAX_VERSUCHE` (5) erreicht hat, wird nicht
   * mehr verarbeitet. Bis 2026-09-27 blieb es danach still liegen — keine
   * Regel lief für den Vorgang, und ausser einer Logzeile erfuhr es niemand.
   *
   * Der Fehlschlag selbst lässt sich über HTTP nicht herbeiführen (die
   * Verarbeitung scheitert nur an der Datenbank oder an einem Programmfehler).
   * Deshalb wird der Zustand danach gelegt: ein Ereignis mit aufgebrauchten
   * Versuchen. Geprüft wird, was der Betrieb davon sieht.
   */
  it('ein Ereignis mit aufgebrauchten Versuchen wird der Leitung gemeldet — genau einmal', async (t) => {
    const db = testDb();
    if (!db) return t.skip(`kein Zugang zur Testdatenbank: ${testDbGrund()}`);
    const organizationId = await eigeneOrganisationId();
    if (!organizationId) return t.skip('keine Organisation im Bestand');

    const ereignis = await db.automationEvent.create({
      data: { organizationId, trigger: 'BOOKING_CREATED', entityId: `liegen-${RUN}`, attempts: 5 },
    });
    const meldungen = () =>
      db.notification.count({
        where: {
          AND: [
            { meta: { path: ['entity'], equals: 'AutomationEvent' } },
            { meta: { path: ['entityId'], equals: ereignis.id } },
          ],
        },
      });
    try {
      await stuendlich();
      const erste = await meldungen();
      assert.ok(erste > 0, 'das liegengebliebene Ereignis wurde niemandem gemeldet');

      await stuendlich();
      assert.equal(await meldungen(), erste, 'ein zweiter Takt meldet dasselbe Ereignis nicht noch einmal');
    } finally {
      await db.notification.deleteMany({
        where: {
          AND: [
            { meta: { path: ['entity'], equals: 'AutomationEvent' } },
            { meta: { path: ['entityId'], equals: ereignis.id } },
          ],
        },
      });
      await db.automationEvent.delete({ where: { id: ereignis.id } });
    }
  });
});

// ===========================================================================
//  Falscher Bezug — eine Aktion wirkt nur auf den auslösenden Vorgang
// ===========================================================================

/**
 * Testmatrix „Automatisierung / falscherBezug" (2026-09-27).
 *
 * Eine Regel läuft für **einen** Vorgang. Was sie tut — Status setzen,
 * Aufgabe anlegen, Meldung schreiben, Platzhalter füllen —, muss an genau
 * diesem Vorgang hängen. Die zwei Wege, auf denen das schiefgehen könnte:
 *
 *  • **Eine Kennung in der Konfiguration.** `config` wird als freies Json
 *    gespeichert; das Schema je Aktionsart prüft die Felder, die es kennt,
 *    und lässt weitere stehen. Läse eine Aktion `config.id` oder
 *    `config.entityId`, wäre jede Regel ein Weg, einen beliebigen Datensatz
 *    zu ändern — für jede Person mit `automation:update`, also auch für die
 *    Betriebsleitung. Die Prüfung legt deshalb die Kennung einer **anderen**
 *    Buchung in die Konfiguration und verlangt, dass diese unberührt bleibt.
 *  • **Ein Ziel einer anderen Art.** `UPDATE_STATUS` mit `ziel: 'lead'` an
 *    einer Buchungsregel hat keinen Lead, auf den es sich beziehen könnte —
 *    es darf sich keinen suchen.
 *
 * Die Gegenprobe-Buchung entsteht, **bevor** es die Regel gibt. Sonst löste
 * sie die Regel selbst aus, und ihr Storno wäre richtig statt falsch — die
 * Prüfung könnte dann nicht unterscheiden.
 */
describe('Falscher Bezug — eine Aktion wirkt nur auf den auslösenden Vorgang', () => {
  const RUN = Date.now();
  const TITEL = `Bezugsprüfung ${RUN}`;
  let regelId = '';

  before(async () => {
    await requireServer();
    jars = await loginAll();
    const db = testDb();
    if (db) {
      // Reste eines abgebrochenen Laufs — über das Präfix, nicht über die Laufnummer.
      await db.task.deleteMany({ where: { title: { startsWith: 'Bezugsprüfung ' } } });
      await db.notification.deleteMany({ where: { title: { startsWith: 'Bezugsprüfung ' } } });
      for (const alt of await db.automation.findMany({ where: { name: { startsWith: 'Bezugsprüfung ' } }, select: { id: true } })) {
        await del(`/api/automations/${alt.id}`, { jar: jars.admin }).catch(() => {});
      }
      /**
       * Zusätzlich abschalten, direkt in der Datenbank (2026-09-27). Das
       * Löschen oben scheiterte still (`.catch`), und eine Regel eines
       * abgebrochenen Laufs blieb aktiv: Sie löste auf die Gegenprobe dieses
       * Laufs aus und stornierte sie — der Fall meldete dann einen falschen
       * Bezug, den es im Produkt nicht gibt. Auf der frischen CI-Datenbank
       * trat das nie auf, auf einer gewachsenen Testdatenbank jedes Mal.
       */
      await db.automation.updateMany({ where: { name: { startsWith: 'Bezugsprüfung ' } }, data: { active: false } });
    }
  });

  after(async () => {
    const db = testDb();
    if (regelId) await del(`/api/automations/${regelId}`, { jar: jars.admin }).catch(() => {});
    if (db) {
      // Siehe `before`: Eine stehen gebliebene aktive Regel verfälscht den nächsten Lauf.
      await db.automation.updateMany({ where: { name: { startsWith: TITEL } }, data: { active: false } });
      await db.task.deleteMany({ where: { title: { startsWith: TITEL } } });
      await db.notification.deleteMany({ where: { title: { startsWith: TITEL } } });
    }
    await testDbSchliessen();
  });

  const stuendlich = () => get('/api/cron/hourly', { headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? 'dev-cron-secret'}` } });

  it('Status, Aufgabe, Meldung und Platzhalter treffen nur die auslösende Buchung — auch mit der Kennung einer anderen in der Konfiguration', async (t) => {
    const db = testDb();
    if (!db) return t.skip(`kein Zugang zur Testdatenbank: ${testDbGrund()}`);

    const kunden = data(await get<{ data: { id: string }[] }>('/api/customers?pageSize=2', { jar: jars.admin })) ?? [];
    const dienst = data(await get<{ data: { id: string }[] }>('/api/services', { jar: jars.admin }))?.[0];
    if (kunden.length < 2 || !dienst) return t.skip('Bestand reicht nicht (zwei Kundenakten, eine Leistung)');
    const [kundeAusloeser, kundeGegenprobe] = [kunden[0]!, kunden[1]!];

    // Die Gegenprobe — vor der Regel angelegt, löst sie also nicht aus.
    const gegenprobe = await erfasseBuchung(kundeGegenprobe.id, dienst.id, 42);
    assert.equal(gegenprobe.status, 201, gegenprobe.text);
    const gegenprobeId = data(gegenprobe).id;
    const gegenprobeVorher = await db.booking.findUniqueOrThrow({ where: { id: gegenprobeId }, select: { status: true, updatedAt: true } });
    const verloreneAnfragenVorher = await db.lead.count({ where: { status: 'LOST' } });

    const aktionen = (fremdeKennung: boolean) => [
      { type: 'CREATE_TASK', config: { titel: `${TITEL} {{nummer}} {{entityId}} {{kunde.id}}`, faelligInTagen: 1 } },
      { type: 'CREATE_NOTIFICATION', config: { titel: `${TITEL} {{nummer}}`, empfaenger: 'MANAGEMENT' } },
      {
        type: 'UPDATE_STATUS',
        config: {
          ziel: 'booking',
          status: 'CANCELLED',
          // Die Kennung der Gegenprobe unter jedem Namen, den eine Aktion
          // fälschlich lesen könnte.
          ...(fremdeKennung ? { id: gegenprobeId, entityId: gegenprobeId, bookingId: gegenprobeId } : {}),
        },
      },
      // Ein Ziel einer anderen Art: An einer Buchungsregel gibt es keinen Lead.
      { type: 'UPDATE_STATUS', config: { ziel: 'lead', status: 'LOST' } },
    ];
    const regelDaten = (fremdeKennung: boolean) => ({
      name: `${TITEL} Regel`,
      trigger: 'BOOKING_CREATED',
      delayMinutes: 0,
      active: true,
      actions: aktionen(fremdeKennung),
    });

    let regel = await post<{ data: { id: string } }>('/api/automations', regelDaten(true), { jar: jars.admin });
    // Weist die Maske die zusätzlichen Felder ab, ist das die strengere und
    // ebenso richtige Antwort; geprüft wird dann der Bezug ohne sie.
    if (regel.status === 422) regel = await post<{ data: { id: string } }>('/api/automations', regelDaten(false), { jar: jars.admin });
    assert.equal(regel.status, 201, regel.text);
    regelId = data(regel).id;

    const ausloeser = await erfasseBuchung(kundeAusloeser.id, dienst.id, 49);
    assert.equal(ausloeser.status, 201, ausloeser.text);
    const { id: buchungId, number: nummer } = data(ausloeser);

    assert.equal(await db.automationRun.count({ where: { automationId: regelId, entityId: buchungId } }), 1, 'Vorbedingung: ein Lauf für die auslösende Buchung');
    assert.equal(await db.automationRun.count({ where: { automationId: regelId, entityId: gegenprobeId } }), 0, 'Vorbedingung: kein Lauf für die Gegenprobe');

    await db.automationRun.updateMany({ where: { automationId: regelId, entityId: buchungId }, data: { scheduledFor: new Date(Date.now() - 60_000) } });
    const takt = await stuendlich();

    const lauf = await db.automationRun.findFirstOrThrow({
      where: { automationId: regelId, entityId: buchungId },
      include: { aktionen: { orderBy: { position: 'asc' } } },
    });
    assert.equal(
      lauf.status,
      'SUCCESS',
      `Lauf ${lauf.status}, Fehler ${lauf.error ?? '—'}, Aktionen ${JSON.stringify(lauf.aktionen.map((a) => [a.type, a.status, a.error]))}, Takt HTTP ${takt.status}`,
    );

    // UPDATE_STATUS: die auslösende Buchung storniert, die Gegenprobe unberührt.
    assert.equal((await db.booking.findUniqueOrThrow({ where: { id: buchungId }, select: { status: true } })).status, 'CANCELLED');
    const gegenprobeNachher = await db.booking.findUniqueOrThrow({ where: { id: gegenprobeId }, select: { status: true, updatedAt: true } });
    assert.equal(gegenprobeNachher.status, gegenprobeVorher.status, 'die Kennung in der Konfiguration hat eine fremde Buchung umgestellt');
    assert.equal(gegenprobeNachher.updatedAt.getTime(), gegenprobeVorher.updatedAt.getTime(), 'die fremde Buchung wurde angefasst');

    // UPDATE_STATUS mit fremder Art: übersprungen, kein Lead geändert.
    assert.equal(lauf.aktionen[3]?.status, 'SKIPPED', `Lead-Ziel an einer Buchungsregel: ${lauf.aktionen[3]?.status}`);
    assert.equal(await db.lead.count({ where: { status: 'LOST' } }), verloreneAnfragenVorher, 'eine Buchungsregel hat einen Lead auf „verloren" gesetzt');

    // CREATE_TASK: genau eine Aufgabe, Platzhalter aus der auslösenden Buchung, an deren Kundschaft.
    const aufgaben = await db.task.findMany({ where: { title: { startsWith: TITEL } }, select: { title: true, customerId: true } });
    assert.equal(aufgaben.length, 1, `Aufgaben: ${JSON.stringify(aufgaben)}`);
    assert.equal(aufgaben[0]!.title, `${TITEL} ${nummer} ${buchungId} ${kundeAusloeser.id}`, 'die Platzhalter tragen Daten eines anderen Vorgangs');
    assert.equal(aufgaben[0]!.customerId, kundeAusloeser.id, 'die Aufgabe hängt an einer anderen Kundschaft');

    // CREATE_NOTIFICATION: jede Meldung verweist auf die auslösende Buchung und nennt deren Nummer.
    const meldungen = await db.notification.findMany({ where: { title: { startsWith: TITEL } }, select: { title: true, meta: true } });
    assert.ok(meldungen.length > 0, 'keine Meldung angelegt');
    for (const meldung of meldungen) {
      assert.equal(meldung.title, `${TITEL} ${nummer}`);
      assert.deepEqual(meldung.meta, { entity: 'Booking', entityId: buchungId }, `Meldung mit fremdem Bezug: ${JSON.stringify(meldung.meta)}`);
    }
  });
});

// ===========================================================================
//  N-07 — ein abgebrochener Versand wird ohne die schon Erreichten fortgesetzt
// ===========================================================================

/**
 * Der dritte Teil von N-07 (2026-09-27), der bis hierher ohne Beleg war.
 *
 * `sendeNachricht` schreibt in das Ergebnis der Aktion, wen sie schon
 * erreicht hat (`result.zugestellt`) — auch wenn die Aktion als Ganzes
 * scheitert. Der nächste Versuch liest diese Liste und schreibt nur noch
 * denen, die fehlen. Vorher bekam, wer beim ersten Versuch erreicht wurde,
 * dieselbe Nachricht bei jedem weiteren Versuch erneut.
 *
 * **Warum der Abbruch gelegt und nicht herbeigeführt wird.** Ein echter
 * Zustellfehler braucht einen Anbieter, der ablehnt. Der Testserver hat
 * keinen — der simulierte Versand gelingt immer (`src/lib/email/client.ts`),
 * und ein Anbieter-Zugang in der Prüfreihe wäre ein echter Versand. Deshalb
 * wird der Zustand **nach** einem abgebrochenen ersten Versuch gelegt, wie in
 * „eine Aktion mit Aussenwirkung, die mittendrin abbrach" oben: ein
 * gescheiterter Aktionsstand mit derselben Kennung, die die Maschine selbst
 * schriebe, und einer Person in `zugestellt`. Geprüft wird, was die Maschine
 * daraus macht — und das am E-Mail-Protokoll, also an dem, was tatsächlich
 * hinausging.
 *
 * Der Auslöser ist `QUOTE_ACCEPTED` an einer frischen Offerte: kein
 * zeitbezogener Auslöser, den der stündliche Lauf für Demodaten mitmelden
 * würde, und eine Offerte, zu der es sonst keine E-Mail gibt — jede Zeile im
 * Protokoll zu ihr stammt aus dieser Prüfung.
 */
describe('N-07 — ein abgebrochener Versand schreibt beim nächsten Versuch nur denen, die fehlen', () => {
  const RUN = Date.now();
  const VORLAGE = `pruef_n07_${RUN}`;
  const MARKE = 'N-07 Versandprüfung';
  let regelId = '';
  let offerteId = '';

  before(async () => {
    await requireServer();
    jars = await loginAll();
  });

  after(async () => {
    const db = testDb();
    if (regelId) await del(`/api/automations/${regelId}`, { jar: jars.admin }).catch(() => {});
    if (offerteId) await del(`/api/quotes/${offerteId}`, { jar: jars.admin }).catch(() => {});
    if (db) {
      await db.emailTemplate.deleteMany({ where: { key: { startsWith: 'pruef_n07_' } } });
      if (offerteId) await db.quote.deleteMany({ where: { id: offerteId } }).catch(() => {});
    }
    await testDbSchliessen();
  });

  const stuendlich = () => get('/api/cron/hourly', { headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? 'dev-cron-secret'}` } });

  /** Dieselbe Kennung, die `aktionsKennung` im Dienst bildet: Art und Konfiguration, Schlüssel sortiert. */
  function stabilesJson(wert: unknown): string {
    if (Array.isArray(wert)) return `[${wert.map(stabilesJson).join(',')}]`;
    if (wert !== null && typeof wert === 'object') {
      const objekt = wert as Record<string, unknown>;
      return `{${Object.keys(objekt)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${stabilesJson(objekt[k])}`)
        .join(',')}}`;
    }
    return JSON.stringify(wert) ?? 'null';
  }
  const kennung = (type: string, config: unknown) =>
    createHash('sha256').update(`${type}\n${stabilesJson(config ?? {})}`).digest('hex').slice(0, 32);

  it('wer vor dem Abbruch erreicht wurde, bekommt beim Wiederholen keine zweite Nachricht — die übrigen genau eine', async (t) => {
    const db = testDb();
    if (!db) return t.skip(`kein Zugang zur Testdatenbank: ${testDbGrund()}`);
    const organizationId = await eigeneOrganisationId();
    if (!organizationId) return t.skip('keine Organisation im Bestand');

    // Der Empfängerkreis „MANAGEMENT", wie ihn `empfaengerKonten` bildet —
    // und davon, wer per E-Mail erreichbar ist.
    const leitung = await db.user.findMany({
      where: { organizationId, deletedAt: null, status: 'ACTIVE', role: { in: ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] } },
      select: { id: true, email: true, notifyByEmail: true },
      orderBy: { id: 'asc' },
    });
    const erreichbar = leitung.filter((u) => u.notifyByEmail && u.email);
    if (erreichbar.length < 2) return t.skip('Vorbedingung: mindestens zwei per E-Mail erreichbare Leitungskonten');
    const schonErreicht = erreichbar[0]!;

    await db.emailTemplate.create({
      data: { organizationId, key: VORLAGE, subject: `${MARKE} {{nummer}}`, bodyHtml: '<p>Offerte {{nummer}}</p>' },
    });

    const regel = await post<{ data: { id: string } }>(
      '/api/automations',
      {
        name: `${MARKE} ${RUN}`,
        trigger: 'QUOTE_ACCEPTED',
        delayMinutes: 0,
        active: true,
        actions: [{ type: 'SEND_EMAIL', config: { templateKey: VORLAGE, empfaenger: 'MANAGEMENT' } }],
      },
      { jar: jars.admin },
    );
    assert.equal(regel.status, 201, regel.text);
    regelId = data(regel).id;

    const kunde = data(await get<{ data: { id: string }[] }>('/api/customers?pageSize=1', { jar: jars.admin }))?.[0];
    if (!kunde) return t.skip('keine Kundenakte im Bestand');
    const offerte = await post<{ data: { id: string } }>(
      '/api/quotes',
      {
        customerId: kunde.id,
        title: `${MARKE} ${RUN}`,
        validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
        items: [{ name: 'Unterhaltsreinigung', quantity: 2, unit: 'Std.', unitPrice: 55, discount: 0, vatRate: 8.1, optional: false }],
        discountValue: 0,
      },
      { jar: jars.admin },
    );
    assert.equal(offerte.status, 201, offerte.text);
    offerteId = data(offerte).id;

    // Der Zustand nach dem abgebrochenen ersten Versuch: eine Person erreicht,
    // die Aktion gescheitert, der Lauf wartet auf die Wiederholung.
    const aktion = await db.automationAction.findFirstOrThrow({ where: { automationId: regelId, position: 0 } });
    const lauf = await db.automationRun.create({
      data: {
        automationId: regelId,
        entity: 'Quote',
        entityId: offerteId,
        status: 'PENDING',
        scheduledFor: new Date(Date.now() - 60_000),
        attempts: 1,
        error: 'Prüfreihe: Versand abgebrochen',
      },
    });
    await db.automationActionRun.create({
      data: {
        runId: lauf.id,
        position: 0,
        type: 'SEND_EMAIL',
        status: 'FAILED',
        attempts: 1,
        startedAt: new Date(Date.now() - 120_000),
        finishedAt: new Date(Date.now() - 110_000),
        error: `1 von ${leitung.length} Nachrichten nicht zugestellt: Prüfreihe`,
        result: { ergebnis: 'fehler', versandt: 1, zugestellt: [schonErreicht.id], kennung: kennung(aktion.type, aktion.config) },
      },
    });

    const takt = await stuendlich();

    const nachher = await db.automationRun.findUniqueOrThrow({ where: { id: lauf.id }, include: { aktionen: true } });
    assert.equal(
      nachher.status,
      'SUCCESS',
      `Lauf ${nachher.status}, Fehler ${nachher.error ?? '—'}, Aktionen ${JSON.stringify(nachher.aktionen.map((a) => [a.status, a.error]))}, Takt HTTP ${takt.status}`,
    );
    const stand = nachher.aktionen[0]!;
    assert.equal(stand.status, 'SUCCEEDED');
    assert.equal(stand.attempts, 2, 'die Aktion wurde fortgesetzt, nicht neu begonnen');

    // Das E-Mail-Protokoll zur Offerte: Zu ihr geht sonst nichts hinaus.
    const versandt = await db.emailLog.findMany({ where: { entity: 'Quote', entityId: offerteId }, select: { to: true } });
    const an = (email: string) => versandt.filter((m) => m.to.toLowerCase() === email.toLowerCase()).length;
    assert.equal(an(schonErreicht.email!), 0, 'wer vor dem Abbruch erreicht wurde, bekam die Nachricht ein zweites Mal');
    for (const person of erreichbar.slice(1)) {
      assert.equal(an(person.email!), 1, `${person.email}: ${an(person.email!)} Nachrichten statt einer`);
    }

    // Der Stand trägt alle Erreichten weiter — auch die aus dem ersten Versuch,
    // damit ein dritter Versuch sie ebenfalls überspränge.
    const zugestellt = [...(((stand.result ?? {}) as { zugestellt?: string[] }).zugestellt ?? [])].sort();
    assert.deepEqual(zugestellt, erreichbar.map((u) => u.id).sort(), 'die Liste der Erreichten ist unvollständig');
  });
});
