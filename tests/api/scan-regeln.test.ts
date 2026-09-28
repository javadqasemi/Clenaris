import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { can, type ActorRole } from '../../src/lib/auth/rbac';
import {
  einsatzRegeln,
  geraetRegeln,
  materialRegeln,
  rechnungRegeln,
  verweisSicher,
} from '../../src/lib/scan/regeln';

/**
 * Welche Schnellaktionen und Verweise ein Scantreffer anbietet — je Rolle
 * und je Zustand, direkt gerechnet (Scanplattform, Ausbau 2026-09-28).
 *
 * Die Rechte kommen aus der echten Rollenzuordnung (`can` aus `rbac.ts`),
 * nicht aus einer Nachbildung: Nimmt jemand der Betriebsleitung
 * `equipment:manage` weg, soll diese Datei das merken, nicht erst ein
 * Durchlauf über HTTP. Dass der **Endpunkt** hinter jeder Aktion erneut prüft,
 * beweist `scan.test.ts` — hier geht es nur darum, keinen Knopf anzubieten,
 * den die Rolle nicht ausführen kann, und keinen zu vergessen, den sie kann.
 */

const darf = (rolle: ActorRole) => (recht: Parameters<typeof can>[1]) => can(rolle, recht);
const schluessel = (r: { aktionen: { schluessel: string }[] }) => r.aktionen.map((a) => a.schluessel);

describe('Material', () => {
  it('Betriebsleitung und Administration buchen, Mitarbeitende und Kundschaft nicht', () => {
    for (const rolle of ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] as const) {
      assert.deepEqual(schluessel(materialRegeln({ darf: darf(rolle), aktiv: true })), ['material.eingang', 'material.entnahme', 'material.korrektur'], rolle);
    }
    for (const rolle of ['EMPLOYEE', 'CUSTOMER', 'GUEST'] as const) {
      assert.deepEqual(materialRegeln({ darf: darf(rolle), aktiv: true }), { aktionen: [], verweise: [] }, rolle);
    }
  });

  it('ein inaktiver Artikel wird nicht mehr bewegt', () => {
    assert.deepEqual(schluessel(materialRegeln({ darf: darf('ADMIN'), aktiv: false })), []);
  });

  it('kein „Nachbestellen" — es gibt kein Bestellmodell, also keinen Knopf', () => {
    const alle = schluessel(materialRegeln({ darf: () => true, aktiv: true }));
    assert.ok(!alle.some((s) => /bestell/i.test(s)), alle.join(','));
  });
});

describe('Gerät', () => {
  const alles = darf('MANAGER');

  it('verfügbar und frei: Wartung, Defekt melden, Zuteilen', () => {
    assert.deepEqual(schluessel(geraetRegeln({ darf: alles, status: 'AVAILABLE', zugeteilt: false })), ['geraet.wartung', 'geraet.defekt', 'geraet.zuteilen']);
  });

  it('zugeteilt: Zurücknehmen statt Zuteilen — nie ein Umhängen in einem Schritt', () => {
    assert.deepEqual(schluessel(geraetRegeln({ darf: alles, status: 'IN_USE', zugeteilt: true })), ['geraet.wartung', 'geraet.defekt', 'geraet.zuruecknehmen']);
  });

  it('in Wartung: Wieder verfügbar, kein Zuteilen (assignEquipment wiese es ab)', () => {
    assert.deepEqual(schluessel(geraetRegeln({ darf: alles, status: 'MAINTENANCE', zugeteilt: false })), ['geraet.wartung', 'geraet.verfuegbar']);
  });

  it('ausgemustert: nichts', () => {
    assert.deepEqual(schluessel(geraetRegeln({ darf: alles, status: 'RETIRED', zugeteilt: false })), []);
  });

  it('ohne equipment:manage: nichts, gleich in welchem Zustand', () => {
    for (const rolle of ['EMPLOYEE', 'CUSTOMER'] as const) {
      for (const status of ['AVAILABLE', 'IN_USE', 'MAINTENANCE']) {
        assert.deepEqual(schluessel(geraetRegeln({ darf: darf(rolle), status, zugeteilt: status === 'IN_USE' })), [], `${rolle} ${status}`);
      }
    }
  });
});

describe('Einsatz', () => {
  const basis = { id: 'job_1', status: 'SCHEDULED', zugeteilt: true, laeuftHier: false };

  it('Mitarbeitende, zugeteilt: Einstempeln und der Rapport im Portal — kein PDF', () => {
    const r = einsatzRegeln({ ...basis, darf: darf('EMPLOYEE'), buero: false });
    assert.deepEqual(schluessel(r), ['einsatz.einstempeln']);
    assert.deepEqual(r.verweise, [{ label: 'Rapport', href: '/portal/einsaetze/job_1#rapport', art: 'seite' }]);
  });

  it('läuft die eigene Zeit hier: Ausstempeln statt Einstempeln', () => {
    const r = einsatzRegeln({ ...basis, status: 'IN_PROGRESS', laeuftHier: true, darf: darf('EMPLOYEE'), buero: false });
    assert.deepEqual(schluessel(r), ['einsatz.ausstempeln']);
  });

  it('nicht zugeteilt: weder Stempeln noch Rapport', () => {
    const r = einsatzRegeln({ ...basis, zugeteilt: false, darf: darf('EMPLOYEE'), buero: false });
    assert.deepEqual(r, { aktionen: [], verweise: [] });
  });

  it('abgeschlossen oder abgesagt: kein Einstempeln (clockIn wiese es ab)', () => {
    for (const status of ['COMPLETED', 'VERIFIED', 'CANCELLED']) {
      assert.deepEqual(schluessel(einsatzRegeln({ ...basis, status, darf: darf('EMPLOYEE'), buero: false })), [], status);
    }
  });

  it('Büro: der Bericht als PDF über den bestehenden Endpunkt, kein Stempeln ohne Zuteilung', () => {
    const r = einsatzRegeln({ ...basis, zugeteilt: false, darf: darf('MANAGER'), buero: true });
    assert.deepEqual(schluessel(r), []);
    assert.deepEqual(r.verweise, [{ label: 'Rapport (PDF)', href: '/api/jobs/job_1/report', art: 'datei' }]);
  });

  it('die ID wird für den Pfad kodiert — nie roher Text im Link', () => {
    const r = einsatzRegeln({ ...basis, id: 'a/../b?x', darf: darf('ADMIN'), buero: true });
    assert.equal(r.verweise[0]!.href, '/api/jobs/a%2F..%2Fb%3Fx/report');
  });
});

describe('Rechnung', () => {
  it('Administration: PDF und — offen — Zahlung erfassen', () => {
    const r = rechnungRegeln({ darf: darf('ADMIN'), id: 'inv_1', status: 'SENT' });
    assert.deepEqual(schluessel(r), ['rechnung.zahlung']);
    assert.deepEqual(r.verweise, [{ label: 'PDF', href: '/api/invoices/inv_1/pdf', art: 'datei' }]);
  });

  it('bezahlt, storniert oder Entwurf: PDF, aber keine Zahlung', () => {
    for (const status of ['PAID', 'CANCELLED', 'DRAFT']) {
      const r = rechnungRegeln({ darf: darf('ADMIN'), id: 'inv_1', status });
      assert.deepEqual(schluessel(r), [], status);
      assert.equal(r.verweise.length, 1, status);
    }
  });

  it('Zahlung nur mit payment:create — die Regel folgt dem Recht, nicht der Rolle', () => {
    const ohneZahlung = (recht: string) => recht !== 'payment:create';
    assert.deepEqual(schluessel(rechnungRegeln({ darf: ohneZahlung as never, id: 'inv_1', status: 'SENT' })), []);
  });

  it('Mitarbeitende und Kundschaft: nichts (auch kein PDF)', () => {
    for (const rolle of ['EMPLOYEE', 'CUSTOMER'] as const) {
      assert.deepEqual(rechnungRegeln({ darf: darf(rolle), id: 'inv_1', status: 'SENT' }), { aktionen: [], verweise: [] }, rolle);
    }
  });
});

describe('Verweise sind Pfade dieser Anwendung', () => {
  it('eigene Pfade: ja', () => {
    for (const href of ['/api/invoices/abc/pdf', '/portal/einsaetze/x#rapport', '/api/jobs/a%2Fb/report']) {
      assert.equal(verweisSicher(href), true, href);
    }
  });

  it('fremde Adressen, protokollrelative Pfade, Schemas, Backslashes: nein', () => {
    for (const href of ['https://fremd.example/x', '//fremd.example/x', 'javascript:alert(1)', '/\\fremd.example', 'api/relativ', '/a b', '']) {
      assert.equal(verweisSicher(href), false, href);
    }
  });
});
