import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { data, get, patch, post, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { eigeneOrganisationId, fremdeOrganisation, schutzfreiAufraeumen, testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';

/**
 * Wave 11 — Betrieb: Reklamationen mit Reaktionsfrist, Material und Lager,
 * Geräte.
 *
 * Geprüft wird der Ablauf über HTTP und die Invarianten, die ihn tragen:
 *
 *  • Die Frist kommt aus der Vertragsfassung am Meldetag — ohne Zusage keine
 *    Frist; die Reaktion wird einmal festgehalten; Übergänge sind begrenzt
 *    und gleichzeitige ergeben keinen dritten Zustand.
 *  • Kundschaft meldet nur für Eigenes und sieht keine interne Notiz.
 *  • Der Bestand ist die Summe der Bewegungen; nie negativ, auch nicht bei
 *    gleichzeitigen Entnahmen; Bewegungen und Wartungsbelege sind in der
 *    Datenbank unveränderlich.
 *  • Rollen und Mandantentrennung (fremde Organisation).
 *
 * Aufräumen vorher und nachher: Meldungen, Material mit Präfix `PRUEF-`,
 * Geräte mit Präfix „Prüfgerät", der Prüfvertrag; Lagerbewegungen und
 * Wartungsbelege nur über `schutzfreiAufraeumen`.
 */

let jars: Record<AccountName, string>;
const RUN = Date.now();
const SKU = `PRUEF-${RUN}`;
const zuercherHeute = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const zuercherStunde = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', hour: '2-digit', hour12: false }).format(new Date()));

let kundeId = ''; // Demokundschaft (Kundenkonto)
let objektId = '';
let andereKundeId = '';
let andereObjektId = '';
let vertragId = '';
let fremdeOrg: string | null = null;

async function aufraeumen() {
  const db = testDb();
  if (!db) return;
  const materialien = await db.material.findMany({ where: { sku: { startsWith: 'PRUEF-' } }, select: { id: true } });
  const geraete = await db.equipment.findMany({ where: { name: { startsWith: 'Prüfgerät' } }, select: { id: true } });
  const meldungen = await db.complaint.findMany({ where: { title: { startsWith: 'Prüfreihe' } }, select: { id: true, correctiveActionId: true } });
  await schutzfreiAufraeumen(async (tx) => {
    const bewegungen = await tx.stockMovement.findMany({
      where: { materialId: { in: materialien.map((m) => m.id) } },
      select: { id: true, materialUsageId: true, jobId: true, quantity: true, unitCost: true },
    });
    // Den Materialaufwand der betroffenen Einsätze zurückstellen.
    for (const b of bewegungen) {
      if (b.materialUsageId && b.jobId) {
        const zeile = await tx.materialUsage.findUnique({ where: { id: b.materialUsageId }, select: { total: true } });
        if (zeile) await tx.job.update({ where: { id: b.jobId }, data: { materialCost: { decrement: zeile.total } } });
      }
    }
    await tx.stockMovement.deleteMany({ where: { id: { in: bewegungen.map((b) => b.id) } } });
    await tx.materialUsage.deleteMany({ where: { id: { in: bewegungen.map((b) => b.materialUsageId).filter((x): x is string => Boolean(x)) } } });
    await tx.material.deleteMany({ where: { id: { in: materialien.map((m) => m.id) } } });
    await tx.equipmentMaintenance.deleteMany({ where: { equipmentId: { in: geraete.map((g) => g.id) } } });
    await tx.equipment.deleteMany({ where: { id: { in: geraete.map((g) => g.id) } } });
    await tx.complaint.deleteMany({ where: { id: { in: meldungen.map((m) => m.id) } } });
    await tx.correctiveAction.deleteMany({ where: { id: { in: meldungen.map((m) => m.correctiveActionId).filter((x): x is string => Boolean(x)) } } });
    if (fremdeOrg) {
      await tx.stockMovement.deleteMany({ where: { organizationId: fremdeOrg } });
      await tx.material.deleteMany({ where: { organizationId: fremdeOrg } });
    }
  });
  /**
   * Der Prüfvertrag gehört der Demokundschaft. Beendet stünde er weiter in
   * ihrer Vertragsliste — und `vertraege.test.ts` prüft, dass diese Liste nur
   * die Verträge enthält, die jene Reihe selbst anlegt. Deshalb ganz weg,
   * ausserhalb des Schutzmodus, damit die Kaskaden auf Fassungen und
   * Leistungen greifen.
   */
  await db.contract.deleteMany({ where: { title: { startsWith: 'Prüfreihe Betrieb' } } });
}

before(async () => {
  await requireServer();
  jars = await loginAll();
  assert.ok(testDb(), `kein Zugang zur Testdatenbank: ${testDbGrund()}`);
  fremdeOrg = await fremdeOrganisation();
  await aufraeumen();

  // Die Objektliste trägt die Kundschaft verschachtelt (`customer.id`), je nach Weg auch als `customerId`.
  type Objekt = { id: string; customerId?: string; customer?: { id: string } };
  const kundeVon = (o: Objekt) => o.customerId ?? o.customer?.id ?? '';
  const eigene = data(await get<{ data: Objekt[] }>('/api/properties', { jar: jars.customer }));
  assert.ok(eigene.length > 0, 'die Demokundschaft hat ein Objekt');
  kundeId = kundeVon(eigene[0]!);
  objektId = eigene[0]!.id;
  assert.ok(kundeId, 'die Kundschaft des eigenen Objekts');
  const alle = data(await get<{ data: Objekt[] }>('/api/properties?pageSize=100', { jar: jars.admin }));
  const anderes = alle.find((o) => kundeVon(o) && kundeVon(o) !== kundeId);
  assert.ok(anderes, 'ein Objekt einer anderen Kundschaft');
  andereKundeId = kundeVon(anderes);
  andereObjektId = anderes.id;

  // Ein laufender Vertrag mit 4 Stunden Reaktionszeit, ab heute (Zürich).
  const leistung = data(await get<{ data: { id: string }[] }>('/api/services?pageSize=1', { jar: jars.admin }))[0]!.id;
  const heute = zuercherHeute();
  const entwurf = await post<{ data: { id: string } }>(
    '/api/contracts',
    {
      contract: { customerId: kundeId, propertyId: objektId, title: `Prüfreihe Betrieb ${RUN}`, startDate: heute },
      version: {
        effectiveFrom: heute,
        reason: 'Prüfreihe Betrieb',
        billingCycle: 'MONTHLY',
        paymentTermDays: 30,
        pricingModel: 'FIXED_PERIOD',
        baseAmount: 500,
        vatRate: 8.1,
        noticePeriodDays: 90,
        renewalType: 'NONE',
        responseHours: 4,
      },
      services: [{ serviceId: leistung, label: 'Unterhaltsreinigung', estimatedMinutes: 60, requiredCrewSize: 1, materialsBy: 'PROVIDER' }],
    },
    { jar: jars.admin },
  );
  assert.equal(entwurf.status, 201, JSON.stringify(entwurf.payload));
  vertragId = data(entwurf).id;
  const aktiv = await post(`/api/contracts/${vertragId}/activate`, {}, { jar: jars.admin });
  assert.equal(aktiv.status, 200, JSON.stringify(aktiv.payload));
});

after(async () => {
  await aufraeumen();
  await testDbSchliessen();
});

// ===========================================================================
//  Reklamationen
// ===========================================================================

type Meldung = {
  id: string;
  number: string;
  status: string;
  responseHours: number | null;
  responseDueAt: string | null;
  acknowledgedAt: string | null;
  reportedAt: string;
  contractId: string | null;
  frist: string;
  internalNote?: string | null;
};

describe('Reklamationen mit Reaktionsfrist', () => {
  let meldung: Meldung;

  it('die Frist kommt aus der Vertragsfassung am Meldetag', async () => {
    const antwort = await post<{ data: Meldung }>(
      '/api/complaints',
      { customerId: kundeId, propertyId: objektId, title: 'Prüfreihe: Fenster nicht gereinigt', description: 'Küche, Nordseite', severity: 'HIGH', channel: 'PHONE' },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 201, JSON.stringify(antwort.payload));
    meldung = data(antwort);
    assert.match(meldung.number, /^REK-\d{4}-\d{5}$/);
    assert.equal(meldung.contractId, vertragId);
    assert.equal(meldung.responseHours, 4);
    assert.equal(new Date(meldung.responseDueAt!).getTime() - new Date(meldung.reportedAt).getTime(), 4 * 3_600_000);
  });

  it('ohne Vertrag keine Frist — „keine Zusage", nicht „überfällig"', async () => {
    const antwort = await post<{ data: Meldung }>(
      '/api/complaints',
      { customerId: andereKundeId, title: 'Prüfreihe: ohne Vertrag', description: 'x' },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 201, JSON.stringify(antwort.payload));
    const detail = data(await get<{ data: Meldung }>(`/api/complaints/${data(antwort).id}`, { jar: jars.admin }));
    if (detail.contractId && detail.responseHours) return; // Die andere Kundschaft hat zufällig eine Zusage — kein Befund.
    assert.equal(detail.responseDueAt, null);
    assert.equal(detail.frist, 'KEINE_ZUSAGE');
  });

  it('der Meldezeitpunkt ist nicht frei: nicht in der Zukunft, nicht älter als 30 Tage', async () => {
    const zukunft = await post('/api/complaints', { customerId: kundeId, title: 'Prüfreihe: Zukunft', description: 'x', reportedAt: new Date(Date.now() + 3_600_000).toISOString() }, { jar: jars.admin });
    assert.equal(zukunft.status, 422);
    const alt = await post('/api/complaints', { customerId: kundeId, title: 'Prüfreihe: alt', description: 'x', reportedAt: new Date(Date.now() - 40 * 86_400_000).toISOString() }, { jar: jars.admin });
    assert.equal(alt.status, 422);
    // Eine mitgeschickte Frist wird verworfen — sie kommt aus dem Vertrag (4 h), nicht vom Client.
    const gesetzt = new Date(Date.now() + 99 * 3_600_000).toISOString();
    const mitFrist = await post<{ data: Meldung }>(
      '/api/complaints',
      { customerId: kundeId, propertyId: objektId, title: 'Prüfreihe: Frist setzen', description: 'x', responseDueAt: gesetzt },
      { jar: jars.admin },
    );
    assert.equal(mitFrist.status, 201, JSON.stringify(mitFrist.payload));
    assert.notEqual(data(mitFrist).responseDueAt, gesetzt);
    assert.equal(data(mitFrist).responseHours, 4);
  });

  it('eine verstrichene Frist ohne Reaktion ist verpasst', async (t) => {
    if (zuercherStunde() < 3) return t.skip('kurz nach Mitternacht liegt „vor zwei Stunden" vor der ersten Vertragsfassung');
    const antwort = await post<{ data: Meldung }>(
      '/api/complaints',
      { customerId: kundeId, propertyId: objektId, title: 'Prüfreihe: spät erfasst', description: 'x', reportedAt: new Date(Date.now() - 5 * 3_600_000).toISOString() },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 201, JSON.stringify(antwort.payload));
    const d = data(await get<{ data: Meldung }>(`/api/complaints/${data(antwort).id}`, { jar: jars.admin }));
    assert.equal(d.frist, 'VERPASST');
    const ueberfaellig = data(await get<{ data: { id: string }[] }>('/api/complaints?ueberfaellig=true', { jar: jars.admin }));
    assert.ok(ueberfaellig.some((c) => c.id === d.id));
    // Spätes Bestätigen heilt die Frist nicht.
    await post(`/api/complaints/${d.id}/transition`, { action: 'ACKNOWLEDGE' }, { jar: jars.admin });
    assert.equal(data(await get<{ data: Meldung }>(`/api/complaints/${d.id}`, { jar: jars.admin })).frist, 'VERPASST');
  });

  it('die Reaktion wird einmal festgehalten; Übergänge sind begrenzt', async () => {
    const bestaetigt = await post<{ data: Meldung }>(`/api/complaints/${meldung.id}/transition`, { action: 'ACKNOWLEDGE' }, { jar: jars.admin });
    assert.equal(bestaetigt.status, 200, JSON.stringify(bestaetigt.payload));
    const reagiert = data(bestaetigt).acknowledgedAt;
    assert.ok(reagiert);
    assert.equal((await post(`/api/complaints/${meldung.id}/transition`, { action: 'ACKNOWLEDGE' }, { jar: jars.admin })).status, 422);
    assert.equal((await post(`/api/complaints/${meldung.id}/transition`, { action: 'RESOLVE' }, { jar: jars.admin })).status, 422, 'Erledigen ohne Begründung');
    const start = await post<{ data: Meldung }>(`/api/complaints/${meldung.id}/transition`, { action: 'START' }, { jar: jars.admin });
    assert.equal(data(start).acknowledgedAt, reagiert, 'die Reaktion verschiebt sich nicht');
    const detail = data(await get<{ data: Meldung }>(`/api/complaints/${meldung.id}`, { jar: jars.admin }));
    assert.equal(detail.frist, 'EINGEHALTEN');
  });

  it('zwei gleichzeitige Übergänge ergeben genau einen', async () => {
    const [a, b] = await Promise.all([
      post(`/api/complaints/${meldung.id}/transition`, { action: 'RESOLVE', resolution: 'Nachgereinigt am Folgetag.' }, { jar: jars.admin }),
      post(`/api/complaints/${meldung.id}/transition`, { action: 'REJECT', resolution: 'Nicht Teil des Auftrags.' }, { jar: jars.admin }),
    ]);
    const stati = [a.status, b.status].sort();
    assert.deepEqual(stati, [200, 422], `erhalten ${a.status}/${b.status}`);
  });

  it('Korrekturmassnahme: genau eine je Reklamation', async () => {
    const erste = await post('/api/complaints/' + meldung.id + '/corrective-action', { title: 'Prüfreihe: Checkliste Fenster ergänzen' }, { jar: jars.admin });
    assert.equal(erste.status, 201, JSON.stringify(erste.payload));
    const zweite = await post('/api/complaints/' + meldung.id + '/corrective-action', { title: 'Noch eine' }, { jar: jars.admin });
    assert.equal(zweite.status, 422);
  });

  it('interne Notiz bleibt intern; die Kundschaft sieht nur Eigenes', async () => {
    await patch(`/api/complaints/${meldung.id}`, { internalNote: 'Prüfreihe: vertraulich' }, { jar: jars.admin });
    const liste = await get<{ data: Meldung[] }>('/api/account/complaints', { jar: jars.customer });
    assert.equal(liste.status, 200);
    assert.ok(data(liste).some((c) => c.id === meldung.id), 'die eigene Meldung erscheint');
    assert.ok(!liste.text.includes('vertraulich'), 'die interne Notiz steht nicht auf der Leitung');
    assert.ok(!liste.text.includes('Prüfreihe: ohne Vertrag'), 'fremde Meldungen erscheinen nicht');
    const einzeln = await get(`/api/account/complaints/${meldung.id}`, { jar: jars.customer });
    assert.equal(einzeln.status, 200);
    assert.ok(!einzeln.text.includes('internalNote'));
  });

  it('die Kundschaft meldet nur zu eigenen Objekten', async () => {
    const eigen = await post<{ data: Meldung }>('/api/account/complaints', { propertyId: objektId, title: 'Prüfreihe: Kundenmeldung', description: 'Staub im Treppenhaus' }, { jar: jars.customer });
    assert.equal(eigen.status, 201, JSON.stringify(eigen.payload));
    assert.equal(data(eigen).responseHours ?? 4, 4);
    assert.ok(data(eigen).responseDueAt, 'auch die Kundenmeldung bekommt die Frist aus dem Vertrag');
    const fremd = await post('/api/account/complaints', { propertyId: andereObjektId, title: 'Prüfreihe: fremd', description: 'x' }, { jar: jars.customer });
    assert.equal(fremd.status, 404);
    const andere = data(await get<{ data: { id: string }[] }>(`/api/complaints?customerId=${andereKundeId}`, { jar: jars.admin }))[0];
    if (andere) assert.equal((await get(`/api/account/complaints/${andere.id}`, { jar: jars.customer })).status, 404);
  });

  it('Rollen: Mitarbeitende und Kundschaft lesen die Verwaltungsliste nicht', async () => {
    for (const rolle of ['employee', 'customer'] as AccountName[]) {
      assert.equal((await get('/api/complaints', { jar: jars[rolle] })).status, 403, rolle);
    }
    assert.equal((await get('/api/complaints', { jar: jars.manager })).status, 200, 'die Betriebsleitung bearbeitet Reklamationen');
    assert.equal((await post('/api/account/complaints', { title: 'x', description: 'y' }, { jar: jars.employee })).status, 403);
  });
});

// ===========================================================================
//  Material und Lager
// ===========================================================================

describe('Material und Lager', () => {
  let materialId = '';
  const bestandVon = async () => data(await get<{ data: { bestand: number } }>(`/api/materials/${materialId}`, { jar: jars.admin })).bestand;

  it('Material anlegen; die Artikelnummer ist eindeutig', async () => {
    const neu = await post<{ data: { id: string } }>('/api/materials', { sku: SKU, name: 'Prüfreihe Allzweckreiniger', unit: 'l', unitCost: 4.5, minStock: 6 }, { jar: jars.admin });
    assert.equal(neu.status, 201, JSON.stringify(neu.payload));
    materialId = data(neu).id;
    assert.equal((await post('/api/materials', { sku: SKU, name: 'Doppelt' }, { jar: jars.admin })).status, 409);
  });

  it('der Bestand ist die Summe der Bewegungen und wird nie negativ', async () => {
    assert.equal((await post(`/api/materials/${materialId}/movements`, { kind: 'RECEIPT', quantity: 10, reference: 'LS-1' }, { jar: jars.admin })).status, 201);
    assert.equal((await post(`/api/materials/${materialId}/movements`, { kind: 'ISSUE', quantity: 4, note: 'Büroreinigung' }, { jar: jars.admin })).status, 201);
    assert.equal(await bestandVon(), 6);
    const zuviel = await post(`/api/materials/${materialId}/movements`, { kind: 'ISSUE', quantity: 7, note: 'zu viel' }, { jar: jars.admin });
    assert.equal(zuviel.status, 422);
    assert.equal((await post(`/api/materials/${materialId}/movements`, { kind: 'ISSUE', quantity: -2, note: 'x' }, { jar: jars.admin })).status, 422, 'Vorzeichen bestimmt die Art');
    assert.equal((await post(`/api/materials/${materialId}/movements`, { kind: 'ADJUSTMENT', quantity: -1 }, { jar: jars.admin })).status, 422, 'Korrektur ohne Begründung');
    assert.equal((await post(`/api/materials/${materialId}/movements`, { kind: 'ADJUSTMENT', quantity: -1, note: 'Inventur: ausgelaufen' }, { jar: jars.admin })).status, 201);
    assert.equal(await bestandVon(), 5);
  });

  it('Meldebestand: am oder darunter erscheint das Material als „nachbestellen"', async () => {
    const liste = data(await get<{ data: { id: string; nachbestellen: boolean }[] }>('/api/materials?nachbestellen=true', { jar: jars.admin }));
    assert.ok(liste.some((m) => m.id === materialId));
  });

  it('gleichzeitige Entnahmen brechen den Bestand nicht', async () => {
    const [a, b] = await Promise.all([
      post(`/api/materials/${materialId}/movements`, { kind: 'ISSUE', quantity: 3, note: 'parallel A' }, { jar: jars.admin }),
      post(`/api/materials/${materialId}/movements`, { kind: 'ISSUE', quantity: 3, note: 'parallel B' }, { jar: jars.admin }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [201, 422], `erhalten ${a.status}/${b.status}`);
    assert.equal(await bestandVon(), 2);
  });

  it('Entnahme für einen Einsatz: Verbrauchszeile, Bewegung und Materialaufwand zusammen', async () => {
    const einsaetze = data(await get<{ data: { id: string; status: string }[] }>('/api/jobs?pageSize=50', { jar: jars.admin }));
    const db = testDb()!;
    /**
     * Ein Einsatz, dessen Rapport nicht eingefroren ist. Welcher das ist,
     * entscheidet die Anwendung (`assertRapportNichtEingefroren`) — die
     * Prüfung probiert, statt die Regel nachzubauen.
     */
    let einsatzId = '';
    let vorher = 0;
    let entnahme: Awaited<ReturnType<typeof post<{ data: { zeile: { total: string } } }>>> | null = null;
    for (const e of einsaetze.filter((x) => !['CANCELLED', 'COMPLETED', 'VERIFIED'].includes(x.status))) {
      const job = await db.job.findUnique({ where: { id: e.id }, select: { materialCost: true } });
      const versuch = await post<{ data: { zeile: { total: string } } }>(`/api/jobs/${e.id}/material-issue`, { materialId, quantity: 2 }, { jar: jars.admin });
      if (versuch.status === 201) {
        einsatzId = e.id;
        vorher = Number(job!.materialCost);
        entnahme = versuch;
        break;
      }
    }
    assert.ok(entnahme, 'ein offener Einsatz im Demobestand');
    const einsatz = { id: einsatzId };
    assert.equal(Number(data(entnahme).zeile.total), 9, '2 × 4.50 aus dem Materialstamm');
    const nachher = await db.job.findUnique({ where: { id: einsatz.id }, select: { materialCost: true } });
    assert.equal(Number(nachher!.materialCost), Math.round((vorher + 9) * 100) / 100);
    assert.equal(await bestandVon(), 0);
    assert.equal((await post(`/api/jobs/${einsatz.id}/material-issue`, { materialId, quantity: 1 }, { jar: jars.admin })).status, 422, 'leeres Lager');
  });

  it('Lagerbewegungen sind in der Datenbank unveränderlich', async () => {
    const db = testDb()!;
    const bewegung = await db.stockMovement.findFirst({ where: { materialId }, select: { id: true } });
    await assert.rejects(db.stockMovement.update({ where: { id: bewegung!.id }, data: { quantity: 100 } }), /unveränderlich/);
    await assert.rejects(db.stockMovement.delete({ where: { id: bewegung!.id } }), /unveränderlich/);
  });

  it('Rollen und Mandanten', async () => {
    assert.equal((await get('/api/materials', { jar: jars.employee })).status, 403);
    assert.equal((await get('/api/materials', { jar: jars.customer })).status, 403);
    if (!fremdeOrg) return;
    const db = testDb()!;
    const fremd = await db.material.create({ data: { organizationId: fremdeOrg, sku: `PRUEF-FREMD-${RUN}`, name: 'Fremdes Material' } });
    const liste = data(await get<{ data: { id: string }[] }>('/api/materials?inaktive=true', { jar: jars.admin }));
    assert.ok(!liste.some((m) => m.id === fremd.id), 'fremdes Material erscheint nicht');
    assert.equal((await get(`/api/materials/${fremd.id}`, { jar: jars.admin })).status, 404);
    assert.equal((await post(`/api/materials/${fremd.id}/movements`, { kind: 'RECEIPT', quantity: 1 }, { jar: jars.admin })).status, 404);
    const eigeneOrg = await eigeneOrganisationId();
    assert.notEqual(eigeneOrg, fremdeOrg);
  });
});

// ===========================================================================
//  Geräte
// ===========================================================================

describe('Geräte', () => {
  let geraetId = '';
  let personId = '';

  it('erfassen: Inventarnummer vom Server, nächste Wartung aus Anschaffung und Intervall', async () => {
    const neu = await post<{ data: { id: string; inventoryNumber: string; nextMaintenanceOn: string } }>(
      '/api/equipment',
      { name: 'Prüfgerät Scheuersaugmaschine', category: 'Maschine', purchasedOn: '2026-01-10', maintenanceIntervalDays: 180 },
      { jar: jars.admin },
    );
    assert.equal(neu.status, 201, JSON.stringify(neu.payload));
    geraetId = data(neu).id;
    assert.match(data(neu).inventoryNumber, /^GR-\d{4}-\d{5}$/);
    assert.equal(data(neu).nextMaintenanceOn.slice(0, 10), '2026-07-09');
    personId = data(await get<{ data: { id: string }[] }>('/api/employees', { jar: jars.admin }))[0]!.id;
  });

  it('zuteilen und zurücknehmen', async () => {
    const zu = await post<{ data: { status: string } }>(`/api/equipment/${geraetId}/assign`, { employeeId: personId }, { jar: jars.admin });
    assert.equal(zu.status, 200, JSON.stringify(zu.payload));
    assert.equal(data(zu).status, 'IN_USE');
    const zurueck = await post<{ data: { status: string } }>(`/api/equipment/${geraetId}/assign`, { employeeId: null }, { jar: jars.admin });
    assert.equal(data(zurueck).status, 'AVAILABLE');
  });

  it('Wartung: keine in der Zukunft; der Beleg setzt die nächste Fälligkeit und ist unveränderlich', async () => {
    const morgen = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    assert.equal((await post(`/api/equipment/${geraetId}/maintenance`, { performedOn: morgen }, { jar: jars.admin })).status, 422);
    const heute = zuercherHeute();
    const w = await post(`/api/equipment/${geraetId}/maintenance`, { performedOn: heute, kind: 'Wartung', cost: 120 }, { jar: jars.admin });
    assert.equal(w.status, 201, JSON.stringify(w.payload));
    const g = data(await get<{ data: { nextMaintenanceOn: string } }>(`/api/equipment/${geraetId}`, { jar: jars.admin }));
    const erwartet = new Date(new Date(`${heute}T00:00:00Z`).getTime() + 180 * 86_400_000).toISOString().slice(0, 10);
    assert.equal(g.nextMaintenanceOn.slice(0, 10), erwartet);
    const db = testDb()!;
    const beleg = await db.equipmentMaintenance.findFirst({ where: { equipmentId: geraetId }, select: { id: true } });
    await assert.rejects(db.equipmentMaintenance.update({ where: { id: beleg!.id }, data: { cost: 1 } }), /unveränderlich/);
  });

  it('ausmustern mit Grund, endgültig', async () => {
    assert.equal((await post(`/api/equipment/${geraetId}/status`, { status: 'RETIRED' }, { jar: jars.admin })).status, 422);
    assert.equal((await post(`/api/equipment/${geraetId}/status`, { status: 'RETIRED', reason: 'Motorschaden' }, { jar: jars.admin })).status, 200);
    assert.equal((await post(`/api/equipment/${geraetId}/assign`, { employeeId: personId }, { jar: jars.admin })).status, 422);
    assert.equal((await post(`/api/equipment/${geraetId}/status`, { status: 'AVAILABLE' }, { jar: jars.admin })).status, 422);
  });

  it('Rollen: Mitarbeitende und Kundschaft verwalten keine Geräte', async () => {
    for (const rolle of ['employee', 'customer'] as AccountName[]) {
      assert.equal((await get('/api/equipment', { jar: jars[rolle] })).status, 403, rolle);
    }
    assert.equal((await get('/api/equipment', { jar: jars.manager })).status, 200);
  });
});
