import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { bedingungenErfuellt, wertAn } from '../../src/lib/automation/conditions';
import { fuelleVorlage, platzhalterIn } from '../../src/lib/automation/template';
import { istPrivateAdresse, pruefeZiel } from '../../src/lib/automation/webhook';
import { pruefeAktionsKonfiguration } from '../../src/lib/validation/automation-config';
import { get, post, patch, del, data, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';

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

  /**
   * Der Fall, an dem eine Prüfung über die Zeichenkette scheitern würde: Ein
   * Name im **öffentlichen** DNS, der auf die Rückschleife zeigt. `localtest.me`
   * ist genau dafür gedacht und löst auf 127.0.0.1 auf.
   */
  it('weist einen öffentlichen Namen ab, der auf die Rückschleife zeigt', async (t) => {
    const ergebnis = await pruefeZiel('https://localtest.me/hook');

    if (!ergebnis.ok && ergebnis.fehler === 'UNAUFLOESBAR') {
      return t.skip('keine Namensauflösung in dieser Umgebung');
    }

    assert.equal(ergebnis.ok, false, 'ein Name auf 127.0.0.1 darf nicht durchgehen');
    assert.equal(ergebnis.ok === false && ergebnis.fehler, 'PRIVATE_ADRESSE');
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
    const nachher = await db.automationRun.findMany({ where: eigene });
    assert.equal(nachher.find((l) => l.entityId === offen)?.status, 'SUCCESS', 'Die offene Aufgabe löst die Aktion aus');
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
