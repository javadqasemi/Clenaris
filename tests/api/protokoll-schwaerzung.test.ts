import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  freitextSchwaerzen,
  GESCHWAERZT,
  istSensiblerSchluessel,
  wertSchwaerzen,
} from '../../src/lib/sensitive-fields';
import { get, patch, data, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';

/**
 * RB-010 — Personal- und Lohndaten im Prüfprotokoll.
 *
 * ---------------------------------------------------------------------------
 *  Der Befund
 * ---------------------------------------------------------------------------
 *
 * `updateEmployee` schrieb die vollständige Eingabe nach `audit_logs`. Die
 * Liste der zu schwärzenden Felder war exakt und kannte `hourlyRate`,
 * `monthlySalary`, `birthday`, die Notfallkontakte und die Wohnadresse nicht.
 * Dazu gab `redact()` ab der fünften Ebene den Wert **ungefiltert** zurück.
 *
 * Geprüft wird zweierlei: die Regel selbst (ohne Server) und der echte Weg —
 * eine Änderung über die Schnittstelle, danach ein Blick in die Tabelle.
 * Ein Test, der nur `redact()` aufruft, bewiese nicht, dass der Dienst es
 * auch benutzt.
 */

describe('Schwärzungsregel', () => {
  it('erkennt Lohn, Geburtsdatum, Notfall, Bank, Zugangsdaten — in jeder Schreibweise', () => {
    for (const schluessel of [
      'monthlySalary',
      'monthly_salary',
      'salaryReason',
      'birthday',
      'birthDate',
      'emergencyContact',
      'emergencyPhone',
      'iban',
      'bankAccountNumber',
      'ahvNumber',
      'password',
      'passwordHash',
      'twoFactorSecret',
      'refreshToken',
      'accessToken',
      'apiKey',
      'api_key',
      'alarmCode',
      'accessCode',
      'recoveryCodes',
      'Authorization',
      'quellensteuerCode',
    ]) {
      assert.ok(istSensiblerSchluessel(schluessel), `${schluessel} muss geschwärzt werden`);
    }
  });

  it('lässt Betriebskennzahlen und Beitragssätze stehen', () => {
    // Der Satz in `PayrollSetting` ist Konfiguration; seine Änderung muss
    // im Protokoll nachvollziehbar bleiben.
    for (const schluessel of ['ahvIvEo', 'alv', 'ktg', 'healthScore', 'status', 'title', 'city', 'internetUrl']) {
      assert.equal(istSensiblerSchluessel(schluessel), false, `${schluessel} ist kein Personendatum`);
    }
  });

  it('kennt Felder, die nur in einer Entität Personendaten sind', () => {
    assert.equal(istSensiblerSchluessel('city'), false);
    assert.equal(istSensiblerSchluessel('city', 'Employee'), true, 'Wohnort einer Person');
    assert.equal(istSensiblerSchluessel('notes', 'Employee'), true, 'interne Personalnotiz');
    assert.equal(istSensiblerSchluessel('alv', 'PayrollSetting'), false, 'Satz, nicht Betrag');
    assert.equal(istSensiblerSchluessel('alv', 'Payslip'), true, 'abgezogener Betrag einer Person');
    assert.equal(istSensiblerSchluessel('netPay', 'Payslip'), true);
    // Der Katalogpreis einer Leistung heisst genauso wie der Lohn einer
    // Person. Der erste Trockenlauf der Bereinigung hat ihn überschwärzt.
    assert.equal(istSensiblerSchluessel('hourlyRate', 'Service'), false, 'Katalogpreis bleibt sichtbar');
    assert.equal(istSensiblerSchluessel('hourlyRate', 'Employee'), true, 'Lohn wird geschwärzt');
    assert.equal(istSensiblerSchluessel('hourlyRate', 'SalaryRecord'), true);
  });

  it('schwärzt verschachtelt, in Listen und in diff-Form', () => {
    const ergebnis = wertSchwaerzen(
      {
        mitarbeiter: [{ lohn: { hourlyRate: 42.5 } }],
        monthlySalary: { from: 5200, to: 5600 },
        title: 'bleibt',
      },
      'Employee',
    ) as Record<string, unknown>;
    assert.equal(ergebnis.monthlySalary, GESCHWAERZT);
    assert.equal(ergebnis.title, 'bleibt');
    assert.doesNotMatch(JSON.stringify(ergebnis), /42\.5|5200|5600/);
  });

  it('kürzt zu tief Verschachteltes, statt es ungefiltert durchzulassen', () => {
    // Die frühere Fassung gab ab Tiefe 4 den Rohwert zurück.
    const tief = { a: { b: { c: { d: { e: { f: { g: { password: 'klartext' } } } } } } } };
    assert.doesNotMatch(JSON.stringify(wertSchwaerzen(tief)), /klartext/);
  });

  it('übersetzt Decimal und Date über toJSON statt ihre Innereien zu zeigen', () => {
    const decimalArtig = { toJSON: () => '42.50' };
    const ergebnis = wertSchwaerzen({ betrag: decimalArtig, am: new Date('2026-01-01T00:00:00Z') });
    assert.deepEqual(ergebnis, { betrag: '42.50', am: '2026-01-01T00:00:00.000Z' });
  });

  it('lässt nicht übergebene Felder weg, statt sie als geschwärzt auszuweisen', () => {
    assert.deepEqual(wertSchwaerzen({ monthlySalary: undefined }), { monthlySalary: undefined });
    assert.deepEqual(wertSchwaerzen({ monthlySalary: null }), { monthlySalary: GESCHWAERZT });
  });

  it('ersetzt IBAN, AHV-Nummer und JWT im Freitext', () => {
    const text = freitextSchwaerzen(
      'IBAN CH93 0076 2011 6238 5295 7, AHV 756.1234.5678.97, Token eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY3.abcdefghijkl',
    );
    assert.doesNotMatch(text, /6238|756\.1234|eyJhbGci/);
  });
});

describe('Prüfprotokoll über den echten Weg', () => {
  let jars: Record<AccountName, string>;
  const db = testDb();

  before(async () => {
    await requireServer();
    jars = await loginAll();
  });

  after(async () => {
    await testDbSchliessen();
  });

  it('eine Änderung der Personalakte hinterlässt Schlüssel, aber keine Werte', async (t) => {
    if (!db) return t.skip(`kein Zugang zur Testdatenbank: ${testDbGrund()}`);

    const liste = await get<{ data: { id: string }[] }>('/api/employees', { jar: jars.admin });
    assert.equal(liste.status, 200);
    const employeeId = data(liste)[0]?.id;
    assert.ok(employeeId, 'für diese Prüfung braucht es eine Personalakte');

    // Den aktuellen Lohn unverändert zurückschicken: Der Dienst protokolliert
    // die Eingabe, auch wenn sich nichts ändert — und eine neue Zeile in der
    // Lohnhistorie soll diese Prüfung nicht hinterlassen.
    const vorher = await db.employee.findUniqueOrThrow({ where: { id: employeeId } });
    const unverwechselbar = {
      emergencyContact: 'Protokollprobe Kontaktperson',
      emergencyPhone: '+41 79 555 01 23',
      notes: 'Protokollprobe interne Notiz',
      birthday: '1987-03-14',
      city: 'Protokollprobestadt',
    };

    const antwort = await patch(
      `/api/employees/${employeeId}`,
      {
        hourlyRate: vorher.hourlyRate === null ? null : Number(vorher.hourlyRate),
        ...unverwechselbar,
      },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 200, JSON.stringify(antwort.payload));

    try {
      const eintrag = await db.auditLog.findFirst({
        where: { entity: 'Employee', entityId: employeeId, action: 'UPDATE' },
        orderBy: { createdAt: 'desc' },
      });
      assert.ok(eintrag, 'die Änderung muss protokolliert sein');
      const gespeichert = JSON.stringify(eintrag.changes);

      for (const wert of Object.values(unverwechselbar)) {
        assert.ok(!gespeichert.includes(wert), `„${wert}" darf nicht im Protokoll stehen: ${gespeichert}`);
      }
      const changes = eintrag.changes as Record<string, unknown>;
      for (const schluessel of ['hourlyRate', 'birthday', 'emergencyContact', 'emergencyPhone', 'notes', 'city']) {
        assert.equal(changes[schluessel], GESCHWAERZT, `${schluessel}: die Tatsache der Änderung bleibt sichtbar`);
      }
    } finally {
      // Die Akte wieder herstellen, damit die Probe nichts im Bestand hinterlässt.
      await db.employee.update({
        where: { id: employeeId },
        data: {
          emergencyContact: vorher.emergencyContact,
          emergencyPhone: vorher.emergencyPhone,
          notes: vorher.notes,
          birthday: vorher.birthday,
          city: vorher.city,
        },
      });
    }
  });
});
