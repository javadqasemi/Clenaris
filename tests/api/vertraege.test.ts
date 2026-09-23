import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { data, del, get, patch, post, put, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';

/**
 * Wave 10 — Verträge.
 *
 * ---------------------------------------------------------------------------
 *  Was hier geprüft wird und was ausdrücklich nicht
 * ---------------------------------------------------------------------------
 *
 * Die Serienrechnung selbst steht in `vertraege-rechenkern.test.ts`: Welche
 * Kalendertage eine Regel trifft, ist eine reine Funktion und lässt sich über
 * HTTP nur mit einem Datenbestand prüfen, der die Rechnung verdeckt.
 *
 * Hier geht es um das, was nur der laufende Dienst beantworten kann:
 *
 *  • **Der Zustandsautomat.** Ein Vertrag wird nicht dadurch aktiv, dass
 *    jemand `status` schickt — es gibt kein solches Feld. Jeder unzulässige
 *    Übergang endet in einem 422.
 *  • **Die Versionsregel.** Eine geltende Fassung ist unveränderlich; wer
 *    ändern will, versioniert.
 *  • **Die Idempotenz des Planers.** Zweimal planen, parallel planen — der
 *    Bestand bleibt derselbe. Das ist die teuerste Zusage des Moduls, und sie
 *    hängt an einem Index in der Datenbank, nicht an einer Prüfung im Code.
 *  • **Das Vier-Augen-Prinzip.** Wer beantragt, gibt nicht frei.
 *  • **Die Rechte.** Die Betriebsleitung entwirft, aktiviert aber nicht.
 *  • **Die Sichtbarkeit.** Kundschaft sieht ausschliesslich die eigenen
 *    Verträge — geprüft an der Antwort, nicht am Statuscode.
 *
 * Jeder Fall räumt vor und nach sich auf; ein 409 aus einem abgebrochenen Lauf
 * ist kein Produktfehler.
 */

let jars: Record<AccountName, string>;
let kundeId: string;
let objektId: string;
let leistungId: string;

/** Alles, was dieser Lauf angelegt hat — wird am Ende verworfen. */
const angelegteVertraege: string[] = [];

const heute = new Date();
const tagIn = (tage: number) => {
  const d = new Date(Date.UTC(heute.getUTCFullYear(), heute.getUTCMonth(), heute.getUTCDate() + tage));
  return d.toISOString().slice(0, 10);
};

/** Ein vollständiger Vertragsentwurf mit einer Leistung. */
function entwurf(ueber: Record<string, unknown> = {}) {
  return {
    contract: {
      customerId: kundeId,
      propertyId: objektId,
      title: `Prüfvertrag ${Date.now()}`,
      startDate: tagIn(1),
      ...(ueber.contract as object),
    },
    version: {
      effectiveFrom: tagIn(1),
      reason: 'Erstfassung aus der Prüfreihe',
      billingCycle: 'MONTHLY',
      paymentTermDays: 30,
      pricingModel: 'FIXED_PERIOD',
      baseAmount: 1200,
      vatRate: 8.1,
      noticePeriodDays: 90,
      renewalType: 'NONE',
      ...(ueber.version as object),
    },
    services: [
      {
        serviceId: leistungId,
        label: 'Unterhaltsreinigung Büro',
        estimatedMinutes: 120,
        requiredCrewSize: 1,
        materialsBy: 'PROVIDER',
      },
    ],
  };
}

async function neuerEntwurf(ueber: Record<string, unknown> = {}): Promise<string> {
  const antwort = await post<{ data: { id: string } }>('/api/contracts', entwurf(ueber), { jar: jars.admin });
  assert.equal(antwort.status, 201, JSON.stringify(antwort.payload));
  const id = data(antwort).id;
  angelegteVertraege.push(id);
  return id;
}

describe('Verträge', () => {
  before(async () => {
    await requireServer();
    jars = await loginAll();

    const kunden = await get<{ data: { id: string }[] }>('/api/customers?pageSize=1', { jar: jars.admin });
    assert.equal(kunden.status, 200);
    kundeId = data(kunden)[0]!.id;

    const objekte = await get<{ data: { id: string; customerId: string }[] }>('/api/properties?pageSize=50', {
      jar: jars.admin,
    });
    assert.equal(objekte.status, 200);
    // Ein Objekt **dieser** Kundschaft — ein fremdes wäre fachlich falsch und
    // würde später bei der Adressauflösung des Einsatzes auffallen.
    objektId = data(objekte).find((o) => o.customerId === kundeId)?.id ?? data(objekte)[0]!.id;

    const leistungen = await get<{ data: { id: string }[] }>('/api/services?pageSize=1', { jar: jars.admin });
    assert.equal(leistungen.status, 200);
    leistungId = data(leistungen)[0]!.id;
  });

  /**
   * Aufräumen, soweit die Regeln es zulassen.
   *
   * Ein Vertrag, der in Kraft war, **lässt sich nicht löschen** — das ist die
   * Zusage des Moduls und kein Mangel der Prüfreihe. Was geht, ist ihn zu
   * beenden: Dann legt der Dienst seine Einsatzpläne stumm, der nächtliche
   * Planer rührt ihn nicht mehr an, und er verschwindet aus jeder Sicht, die
   * nach laufenden Verträgen fragt.
   *
   * Es bleiben also Zeilen liegen, und das ist bekannt. Sie sind der Preis
   * dafür, dass „ein gelaufener Vertrag ist ein Beleg" auch in der Prüfreihe
   * gilt — eine Ausnahme dafür wäre eine Tür, die in der Anwendung nicht
   * existieren darf.
   */
  after(async () => {
    for (const id of angelegteVertraege) {
      const geloescht = await del(`/api/contracts/${id}`, { jar: jars.admin }).catch(() => null);
      if (geloescht?.status === 204) continue;
      await post(`/api/contracts/${id}/end`, { reason: 'Aufräumen der Prüfreihe' }, { jar: jars.admin }).catch(
        () => undefined,
      );
    }
  });

  // -------------------------------------------------------------------------
  //  Anlegen
  // -------------------------------------------------------------------------

  describe('Anlegen', () => {
    it('legt einen Entwurf mit erster Version und Leistung an — ohne Nummer', async () => {
      const id = await neuerEntwurf();
      const akte = await get<{ data: Record<string, unknown> }>(`/api/contracts/${id}`, { jar: jars.admin });
      assert.equal(akte.status, 200);
      const vertrag = data(akte) as {
        number: string | null;
        status: string;
        versions: { versionNumber: number; status: string; services: unknown[] }[];
      };

      assert.equal(vertrag.status, 'DRAFT');
      /**
       * Die Nummer entsteht beim Aktivieren, nicht beim Anlegen — dieselbe
       * Regel wie bei der Rechnung. Ein verworfener Entwurf soll keine Lücke
       * hinterlassen.
       */
      assert.equal(vertrag.number, null, 'Ein Entwurf hat noch keine Vertragsnummer');
      assert.equal(vertrag.versions.length, 1);
      assert.equal(vertrag.versions[0]!.versionNumber, 1);
      assert.equal(vertrag.versions[0]!.status, 'DRAFT');
      assert.equal(vertrag.versions[0]!.services.length, 1);
    });

    it('weist eine Version ohne Preis bei Festpreis ab (422)', async () => {
      const antwort = await post('/api/contracts', entwurf({ version: { baseAmount: 0 } }), { jar: jars.admin });
      assert.equal(antwort.status, 422);
    });

    it('weist Stundenabrechnung ohne Stundensatz ab (422)', async () => {
      const antwort = await post(
        '/api/contracts',
        entwurf({ version: { pricingModel: 'HOURLY', baseAmount: 0 } }),
        { jar: jars.admin },
      );
      assert.equal(antwort.status, 422);
    });

    it('weist automatische Verlängerung ohne Dauer ab (422)', async () => {
      const antwort = await post(
        '/api/contracts',
        entwurf({ version: { renewalType: 'AUTOMATIC' } }),
        { jar: jars.admin },
      );
      assert.equal(antwort.status, 422);
    });

    it('nimmt keinen Zustand entgegen — `status` ist kein Feld', async () => {
      const antwort = await post(
        '/api/contracts',
        { ...entwurf(), contract: { ...entwurf().contract, status: 'ACTIVE' } },
        { jar: jars.admin },
      );
      // Das unbekannte Feld wird ignoriert, nicht übernommen.
      if (antwort.status === 201) {
        const id = data(antwort as { payload?: { data: { id: string } } } as never) as unknown as { id: string };
        const akte = await get<{ data: { status: string } }>(`/api/contracts/${(id as { id: string }).id}`, {
          jar: jars.admin,
        });
        angelegteVertraege.push((id as { id: string }).id);
        assert.equal(data(akte).status, 'DRAFT', 'Ein mitgeschickter Zustand wirkt nicht');
      } else {
        assert.equal(antwort.status, 422);
      }
    });
  });

  // -------------------------------------------------------------------------
  //  Zustandsautomat
  // -------------------------------------------------------------------------

  describe('Zustandsautomat', () => {
    it('aktiviert und vergibt dabei die Vertragsnummer', async () => {
      const id = await neuerEntwurf();
      const antwort = await post<{ data: { status: string; number: string } }>(
        `/api/contracts/${id}/activate`,
        {},
        { jar: jars.admin },
      );
      assert.equal(antwort.status, 200, JSON.stringify(antwort.payload));
      assert.equal(data(antwort).status, 'ACTIVE');
      assert.match(data(antwort).number, /^VT-\d{4}-\d{5}$/, 'Nummer aus dem Nummernkreis');

      const akte = await get<{ data: { versions: { status: string }[] } }>(`/api/contracts/${id}`, {
        jar: jars.admin,
      });
      assert.equal(data(akte).versions[0]!.status, 'ACTIVE', 'Der Entwurf ist zur geltenden Fassung geworden');
    });

    it('lässt einen zweiten Aktivierungsversuch nicht zu (422)', async () => {
      const id = await neuerEntwurf();
      assert.equal((await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin })).status, 200);
      assert.equal((await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin })).status, 422);
    });

    it('pausiert, nimmt wieder auf und kündigt', async () => {
      const id = await neuerEntwurf();
      await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin });

      const pause = await post<{ data: { status: string } }>(
        `/api/contracts/${id}/pause`,
        { pausedFrom: tagIn(5), pausedUntil: tagIn(20), reason: 'Umbau im Objekt' },
        { jar: jars.admin },
      );
      assert.equal(pause.status, 200);
      assert.equal(data(pause).status, 'PAUSED');

      const weiter = await post<{ data: { status: string } }>(`/api/contracts/${id}/resume`, {}, { jar: jars.admin });
      assert.equal(data(weiter).status, 'ACTIVE');

      const kuendigung = await post<{ data: { status: string; terminationEffectiveAt: string } }>(
        `/api/contracts/${id}/notice`,
        { noticeGivenBy: 'CUSTOMER', reason: 'Objekt verkauft' },
        { jar: jars.admin },
      );
      assert.equal(kuendigung.status, 200, JSON.stringify(kuendigung.payload));
      assert.equal(data(kuendigung).status, 'NOTICE_GIVEN');
      assert.ok(data(kuendigung).terminationEffectiveAt, 'Das Wirkungsdatum wird gerechnet');
    });

    /**
     * Bis 2026-09-23 legte das Ende die Einsatzpläne **aller** Fassungen
     * still — ein Schreibzugriff auf die Konditionen geltender und abgelöster
     * Fassungen, den der Trigger `service_schedules_unveraenderlich` heute
     * verweigert. Was das Ende wirklich leisten muss: Nach ihm wird nichts
     * mehr geplant, und bereits geplante Einsätze danach werden abgesagt.
     */
    it('beendet, sagt geplante Einsätze danach ab und lässt die Pläne als Beleg stehen', async () => {
      const id = await neuerEntwurf();

      // Der Plan entsteht **vor** der Aktivierung: Auf einer geltenden Fassung
      // ist er gesperrt, weil die Frequenz Teil der Vereinbarung ist.
      const akte = await get<{ data: { versions: { services: { id: string }[] }[] } }>(`/api/contracts/${id}`, {
        jar: jars.admin,
      });
      const leistung = data(akte).versions[0]!.services[0]!.id;
      const plan = await post<{ data: { id: string } }>(
        `/api/contract-services/${leistung}/schedules`,
        { frequency: 'WEEKLY', weekdays: [1, 3], effectiveFrom: tagIn(1), startMinute: 360, endMinute: 600 },
        { jar: jars.admin },
      );
      assert.equal(plan.status, 201, JSON.stringify(plan.payload));

      await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin });
      const lauf = await post<{ data: { angelegt: number } }>(`/api/contracts/${id}/schedule`, { bis: tagIn(28) }, {
        jar: jars.admin,
      });
      assert.ok(data(lauf).angelegt > 0, 'Vor dem Ende gibt es geplante Einsätze');

      const ende = await post<{ data: { status: string } }>(
        `/api/contracts/${id}/end`,
        { reason: 'Prüfreihe' },
        { jar: jars.admin },
      );
      assert.equal(ende.status, 200, JSON.stringify(ende.payload));
      assert.equal(data(ende).status, 'ENDED');

      const einsaetze = await get<{ data: { status: string; scheduledStart: string }[] }>(
        `/api/jobs?contractId=${id}&pageSize=100`,
        { jar: jars.admin },
      );
      const morgen = new Date(`${tagIn(1)}T00:00:00Z`).getTime();
      const danach = data(einsaetze).filter((j) => new Date(j.scheduledStart).getTime() >= morgen);
      assert.ok(danach.length > 0);
      assert.ok(
        danach.every((j) => j.status === 'CANCELLED'),
        'Nach dem Ende verlangt der Vertrag nichts mehr — geplante Einsätze sind abgesagt',
      );

      const nachher = await get<{ data: { versions: { services: { schedules: { active: boolean }[] }[] }[] } }>(
        `/api/contracts/${id}`,
        { jar: jars.admin },
      );
      const plaene = data(nachher).versions.flatMap((v) => v.services.flatMap((s) => s.schedules));
      assert.ok(plaene.length > 0, 'Der Plan bleibt lesbar');
      assert.ok(plaene.every((p) => p.active === true), 'Die Konditionen der Fassung bleiben, wie sie vereinbart waren');

      const nochmal = await post<{ data: { angelegt: number } }>(`/api/contracts/${id}/schedule`, { bis: tagIn(28) }, {
        jar: jars.admin,
      });
      assert.equal(data(nochmal).angelegt, 0, 'Ein beendeter Vertrag plant nicht');
    });

    it('weist unzulässige Übergänge ab (422) — beendet ist beendet', async () => {
      const id = await neuerEntwurf();
      await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin });
      await post(`/api/contracts/${id}/end`, {}, { jar: jars.admin });

      assert.equal((await post(`/api/contracts/${id}/resume`, {}, { jar: jars.admin })).status, 422);
      assert.equal(
        (await post(`/api/contracts/${id}/pause`, { pausedFrom: tagIn(1), reason: 'x'.repeat(10) }, { jar: jars.admin }))
          .status,
        422,
      );
    });

    it('löscht einen Entwurf, aber keinen Vertrag, der in Kraft war (422)', async () => {
      const entwurfId = await neuerEntwurf();
      assert.equal((await del(`/api/contracts/${entwurfId}`, { jar: jars.admin })).status, 204);

      const aktivId = await neuerEntwurf();
      await post(`/api/contracts/${aktivId}/activate`, {}, { jar: jars.admin });
      assert.equal(
        (await del(`/api/contracts/${aktivId}`, { jar: jars.admin })).status,
        422,
        'Ein gelaufener Vertrag ist ein Beleg',
      );
    });
  });

  // -------------------------------------------------------------------------
  //  Versionen
  // -------------------------------------------------------------------------

  describe('Versionierung', () => {
    it('legt eine zweite Version an und kopiert den Leistungsumfang', async () => {
      const id = await neuerEntwurf();
      await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin });

      const version = await post<{ data: { id: string; versionNumber: number; status: string } }>(
        `/api/contracts/${id}/versions`,
        {
          version: {
            effectiveFrom: tagIn(30),
            reason: 'Preisanpassung zum Quartalsbeginn',
            billingCycle: 'MONTHLY',
            paymentTermDays: 30,
            pricingModel: 'FIXED_PERIOD',
            baseAmount: 1350,
            vatRate: 8.1,
            noticePeriodDays: 90,
            renewalType: 'NONE',
          },
        },
        { jar: jars.admin },
      );
      assert.equal(version.status, 201, JSON.stringify(version.payload));
      assert.equal(data(version).versionNumber, 2);
      assert.equal(data(version).status, 'DRAFT');

      const akte = await get<{ data: { versions: { versionNumber: number; services: unknown[] }[] } }>(
        `/api/contracts/${id}`,
        { jar: jars.admin },
      );
      const zwei = data(akte).versions.find((v) => v.versionNumber === 2)!;
      assert.equal(zwei.services.length, 1, 'Der Leistungsumfang wurde kopiert, nicht verlinkt');
    });

    it('lässt keinen zweiten Versionsentwurf zu (422)', async () => {
      const id = await neuerEntwurf();
      await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin });
      const rumpf = {
        version: {
          effectiveFrom: tagIn(30),
          reason: 'Erste Änderung der Prüfreihe',
          billingCycle: 'MONTHLY',
          paymentTermDays: 30,
          pricingModel: 'FIXED_PERIOD',
          baseAmount: 1400,
          vatRate: 8.1,
          noticePeriodDays: 90,
          renewalType: 'NONE',
        },
      };
      assert.equal((await post(`/api/contracts/${id}/versions`, rumpf, { jar: jars.admin })).status, 201);
      assert.equal((await post(`/api/contracts/${id}/versions`, rumpf, { jar: jars.admin })).status, 422);
    });

    it('ändert einen Versionsentwurf, aber nicht die geltende Fassung (422)', async () => {
      const id = await neuerEntwurf();
      const akteVorher = await get<{ data: { versions: { id: string }[] } }>(`/api/contracts/${id}`, {
        jar: jars.admin,
      });
      const versionId = data(akteVorher).versions[0]!.id;

      const rumpf = {
        effectiveFrom: tagIn(1),
        reason: 'Korrektur vor der Aktivierung',
        billingCycle: 'MONTHLY',
        paymentTermDays: 30,
        pricingModel: 'FIXED_PERIOD',
        baseAmount: 1250,
        vatRate: 8.1,
        noticePeriodDays: 90,
        renewalType: 'NONE',
      };
      assert.equal(
        (await patch(`/api/contracts/${id}/versions/${versionId}`, rumpf, { jar: jars.admin })).status,
        200,
        'Ein Entwurf lässt sich ändern',
      );

      await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin });
      assert.equal(
        (await patch(`/api/contracts/${id}/versions/${versionId}`, rumpf, { jar: jars.admin })).status,
        422,
        'Eine geltende Fassung ist unveränderlich',
      );
    });

    it('ersetzt den Leistungsumfang eines Entwurfs als Ganzes', async () => {
      const id = await neuerEntwurf();
      const akte = await get<{ data: { versions: { id: string }[] } }>(`/api/contracts/${id}`, { jar: jars.admin });
      const versionId = data(akte).versions[0]!.id;

      const antwort = await put<{ data: unknown[] }>(
        `/api/contracts/${id}/versions/${versionId}/services`,
        {
          services: [
            { label: 'Treppenhaus', estimatedMinutes: 60, requiredCrewSize: 1, materialsBy: 'PROVIDER', position: 0 },
            { label: 'Sanitär', estimatedMinutes: 45, requiredCrewSize: 1, materialsBy: 'CUSTOMER', position: 1 },
          ],
        },
        { jar: jars.admin },
      );
      assert.equal(antwort.status, 200, JSON.stringify(antwort.payload));
      assert.equal(data(antwort).length, 2, 'Die alte Position ist weg, nicht dazugekommen');
    });
  });

  // -------------------------------------------------------------------------
  //  Unveränderlichkeit einer geltenden Fassung
  // -------------------------------------------------------------------------

  /**
   * **Ein eindeutiger Index beweist Eindeutigkeit, nicht Unveränderlichkeit.**
   *
   * `contract_versions_eine_aktive` sorgt dafür, dass es nie zwei geltende
   * Fassungen gibt. Er sagt nichts darüber, ob die eine geltende Fassung
   * nachträglich verändert werden kann — und genau das ist die Aussage, die
   * das Modul macht. Sie wird hier über **jeden** schreibenden Weg geprüft,
   * der eine Fassung erreicht.
   */
  describe('Eine geltende Fassung ist unveränderlich', () => {
    /** Ein aktiver Vertrag samt seiner geltenden Fassung und deren Leistung. */
    async function aktiverVertrag() {
      const id = await neuerEntwurf();
      const vorher = await get<{ data: { versions: { id: string; services: { id: string }[] }[] } }>(
        `/api/contracts/${id}`,
        { jar: jars.admin },
      );
      const versionId = data(vorher).versions[0]!.id;
      const leistungId = data(vorher).versions[0]!.services[0]!.id;

      const plan = await post<{ data: { id: string } }>(
        `/api/contract-services/${leistungId}/schedules`,
        { frequency: 'WEEKLY', weekdays: [1], effectiveFrom: tagIn(1), startMinute: 360, endMinute: 600 },
        { jar: jars.admin },
      );
      assert.equal(plan.status, 201, JSON.stringify(plan.payload));

      await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin });
      return { id, versionId, leistungId, planId: data(plan).id };
    }

    const konditionen = (betrag: number) => ({
      effectiveFrom: tagIn(1),
      reason: 'Versuch, eine geltende Fassung zu ändern',
      billingCycle: 'MONTHLY',
      paymentTermDays: 30,
      pricingModel: 'FIXED_PERIOD',
      baseAmount: betrag,
      vatRate: 8.1,
      noticePeriodDays: 90,
      renewalType: 'NONE',
    });

    it('weist jede Änderung der Konditionen ab (422) — Preis, Zyklus, Zahlungsziel, Frist, Stichtag', async () => {
      const { id, versionId } = await aktiverVertrag();

      const versuche: [string, Record<string, unknown>][] = [
        ['Preis', konditionen(9999)],
        ['Abrechnungszyklus', { ...konditionen(1200), billingCycle: 'ANNUAL' }],
        ['Zahlungsziel', { ...konditionen(1200), paymentTermDays: 5 }],
        ['Kündigungsfrist', { ...konditionen(1200), noticePeriodDays: 1 }],
        ['Stichtag', { ...konditionen(1200), effectiveFrom: tagIn(90) }],
        ['Preismodell', { ...konditionen(0), pricingModel: 'HOURLY', hourlyRate: 55 }],
      ];

      for (const [was, rumpf] of versuche) {
        const antwort = await patch(`/api/contracts/${id}/versions/${versionId}`, rumpf, { jar: jars.admin });
        assert.equal(antwort.status, 422, `${was} liess sich ändern (HTTP ${antwort.status})`);
      }

      // Und der Bestand hat sich nicht bewegt.
      const nachher = await get<{ data: { versions: { baseAmount: number; billingCycle: string }[] } }>(
        `/api/contracts/${id}`,
        { jar: jars.admin },
      );
      assert.equal(data(nachher).versions[0]!.baseAmount, 1200, 'Der Preis steht unverändert');
      assert.equal(data(nachher).versions[0]!.billingCycle, 'MONTHLY');
    });

    it('weist das Ersetzen des Leistungsumfangs ab (422)', async () => {
      const { id, versionId } = await aktiverVertrag();
      const antwort = await put(
        `/api/contracts/${id}/versions/${versionId}/services`,
        { services: [{ label: 'Heimlich geändert', estimatedMinutes: 30, requiredCrewSize: 1, materialsBy: 'PROVIDER' }] },
        { jar: jars.admin },
      );
      assert.equal(antwort.status, 422);

      const nachher = await get<{ data: { versions: { services: { label: string }[] }[] } }>(
        `/api/contracts/${id}`,
        { jar: jars.admin },
      );
      assert.equal(data(nachher).versions[0]!.services[0]!.label, 'Unterhaltsreinigung Büro');
    });

    /**
     * Die Frequenz ist der Kern dessen, was vereinbart wurde, und bei
     * Abrechnung je Einsatz unmittelbar der Preis. Liesse sie sich an einer
     * geltenden Fassung ändern, wäre „unveränderlich" eine Behauptung über
     * ein Formularfeld und nicht über den Vertrag.
     */
    it('weist jede Änderung am Einsatzplan ab (422) — anlegen, ändern, entfernen', async () => {
      const { leistungId, planId } = await aktiverVertrag();

      const anlegen = await post(
        `/api/contract-services/${leistungId}/schedules`,
        { frequency: 'WEEKLY', weekdays: [2], effectiveFrom: tagIn(1), startMinute: 360, endMinute: 600 },
        { jar: jars.admin },
      );
      assert.equal(anlegen.status, 422, 'Ein zweiter Plan wäre eine zusätzliche Leistung');

      const aendern = await patch(
        `/api/contract-schedules/${planId}`,
        { frequency: 'WEEKLY', weekdays: [1, 2, 3, 4, 5], effectiveFrom: tagIn(1), startMinute: 360, endMinute: 600 },
        { jar: jars.admin },
      );
      assert.equal(aendern.status, 422, 'Von einmal auf fünfmal wöchentlich ist eine Vertragsänderung');

      const entfernen = await del(`/api/contract-schedules/${planId}`, { jar: jars.admin });
      assert.equal(entfernen.status, 422);
    });

    /**
     * Die Gegenprobe: Eine **Ausnahme** bleibt erlaubt. Wer einen einzelnen
     * Termin wegen Betriebsferien verschiebt, ändert den Vertrag nicht — und
     * eine Sperre dafür machte das Modul im Alltag unbrauchbar.
     */
    it('lässt eine Ausnahme auf der geltenden Fassung zu (201)', async () => {
      const { planId } = await aktiverVertrag();
      const antwort = await post(
        `/api/contract-schedules/${planId}/exceptions`,
        { kind: 'SKIP', originalDate: tagIn(14), reason: 'Betriebsferien' },
        { jar: jars.admin },
      );
      assert.equal(antwort.status, 201, JSON.stringify(antwort.payload));
    });

    it('nimmt weder Zustand noch Versionsnummer entgegen — sie stehen in keinem Schema', async () => {
      const { id, versionId } = await aktiverVertrag();
      // Ein Entwurf wäre änderbar; hier geht es um die Felder selbst.
      const neu = await post<{ data: { id: string; versionNumber: number } }>(
        `/api/contracts/${id}/versions`,
        { version: { ...konditionen(1300), reason: 'Zweite Fassung der Prüfreihe' } },
        { jar: jars.admin },
      );
      assert.equal(neu.status, 201);

      const geschmuggelt = await patch(
        `/api/contracts/${id}/versions/${data(neu).id}`,
        { ...konditionen(1300), reason: 'Mit Schmuggelfeldern', status: 'ACTIVE', versionNumber: 99 },
        { jar: jars.admin },
      );
      assert.equal(geschmuggelt.status, 200, 'Der Entwurf selbst lässt sich ändern');

      const akte = await get<{ data: { versions: { id: string; status: string; versionNumber: number }[] } }>(
        `/api/contracts/${id}`,
        { jar: jars.admin },
      );
      const entwurf = data(akte).versions.find((v) => v.id === data(neu).id)!;
      assert.equal(entwurf.status, 'DRAFT', 'Ein mitgeschickter Zustand wirkt nicht');
      assert.equal(entwurf.versionNumber, 2, 'Eine mitgeschickte Versionsnummer wirkt nicht');
      assert.equal(
        data(akte).versions.find((v) => v.id === versionId)!.status,
        'ACTIVE',
        'Die geltende Fassung bleibt die geltende',
      );
    });
  });

  // -------------------------------------------------------------------------
  //  Historische Wahrheit
  // -------------------------------------------------------------------------

  /**
   * **Ein Einsatz behält seine Vertragsversion.**
   *
   * Die Alternative wäre, beim Lesen auf „die aktuell aktive Fassung"
   * aufzulösen. Das ist bequem und falsch: Nach der ersten Preisanpassung
   * zeigte jeder alte Einsatz den neuen Preis, jede alte Rechnung liesse sich
   * nicht mehr nachrechnen, und die Frage „unter welchen Konditionen wurde das
   * erbracht" wäre unbeantwortbar. Der Fremdschlüssel wird deshalb beim
   * Erzeugen gesetzt und nie wieder angefasst.
   */
  describe('Versions-Schnappschuss am Einsatz', () => {
    it('alte Einsätze behalten Version 1, neue bekommen Version 2', async () => {
      const id = await neuerEntwurf();
      const vorher = await get<{ data: { versions: { id: string; services: { id: string }[] }[] } }>(
        `/api/contracts/${id}`,
        { jar: jars.admin },
      );
      const v1 = data(vorher).versions[0]!.id;
      const leistungId = data(vorher).versions[0]!.services[0]!.id;

      await post(
        `/api/contract-services/${leistungId}/schedules`,
        { frequency: 'WEEKLY', weekdays: [1, 3], effectiveFrom: tagIn(1), startMinute: 360, endMinute: 600 },
        { jar: jars.admin },
      );
      await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin });

      const ersterLauf = await post<{ data: { angelegt: number } }>(
        `/api/contracts/${id}/schedule`,
        { bis: tagIn(21) },
        { jar: jars.admin },
      );
      assert.ok(data(ersterLauf).angelegt > 0);

      const alte = await get<{ data: { id: string; contractVersionId: string }[] }>(
        `/api/jobs?contractId=${id}&pageSize=100`,
        { jar: jars.admin },
      );
      assert.equal(alte.status, 200);
      const alteIds = data(alte).map((j) => j.id);
      assert.ok(alteIds.length > 0);
      assert.ok(
        data(alte).every((j) => j.contractVersionId === v1),
        'Alle Einsätze des ersten Laufs zeigen auf Version 1',
      );

      // Zweite Fassung anlegen und in Kraft setzen — ab Tag 8.
      const stichtag = tagIn(8);
      const neueVersion = await post<{ data: { id: string; versionNumber: number } }>(
        `/api/contracts/${id}/versions`,
        {
          version: {
            effectiveFrom: stichtag,
            reason: 'Preisanpassung — die alten Einsätze dürfen davon nichts merken',
            billingCycle: 'MONTHLY',
            paymentTermDays: 30,
            pricingModel: 'FIXED_PERIOD',
            baseAmount: 1500,
            vatRate: 8.1,
            noticePeriodDays: 90,
            renewalType: 'NONE',
          },
        },
        { jar: jars.admin },
      );
      assert.equal(neueVersion.status, 201, JSON.stringify(neueVersion.payload));
      const v2 = data(neueVersion).id;

      const aktivieren = await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin });
      assert.equal(aktivieren.status, 422, 'Ein aktiver Vertrag wird nicht zweimal erstmals aktiviert');

      /**
       * Bis 2026-09-23 endete dieser Test hier: V2 liess sich an einem
       * laufenden Vertrag nicht in Kraft setzen, und die Hälfte seines Titels
       * wurde nie geprüft. Jetzt gibt es den Weg — und die Zusage wird
       * vollständig gemessen.
       */
      const wechsel = await post(`/api/contracts/${id}/versions/${v2}/activate`, {}, { jar: jars.admin });
      assert.equal(wechsel.status, 200, JSON.stringify(wechsel.payload));
      await post(`/api/contracts/${id}/schedule`, { bis: tagIn(35) }, { jar: jars.admin });

      const nachher = await get<{
        data: { id: string; contractVersionId: string; status: string; scheduledStart: string }[];
      }>(`/api/jobs?contractId=${id}&pageSize=100`, { jar: jars.admin });
      const grenze = new Date(`${stichtag}T00:00:00Z`).getTime() - 2 * 3_600_000; // Mitternacht Zürich
      const geltend = data(nachher).filter((j) => j.status !== 'CANCELLED');

      const vorStichtag = geltend.filter((j) => new Date(j.scheduledStart).getTime() < grenze);
      const abStichtag = geltend.filter((j) => new Date(j.scheduledStart).getTime() >= grenze);
      assert.ok(vorStichtag.length > 0 && abStichtag.length > 0, 'Es gibt Einsätze vor und nach dem Stichtag');
      assert.ok(vorStichtag.every((j) => j.contractVersionId === v1), 'Vor dem Stichtag bleibt es Version 1');
      assert.ok(abStichtag.every((j) => j.contractVersionId === v2), 'Ab dem Stichtag gilt Version 2 — auch für umgestellte');
      assert.ok(
        vorStichtag.every((j) => alteIds.includes(j.id)),
        'Vor dem Stichtag ist kein Einsatz neu entstanden oder verschwunden',
      );

      // Kein Termin doppelt: Je Beginnzeit genau ein geltender Einsatz.
      const beginne = geltend.map((j) => j.scheduledStart);
      assert.equal(new Set(beginne).size, beginne.length, 'Derselbe Termin existiert nicht zweimal');
      assert.notEqual(v1, v2);
    });

    it('die Abrechnungsgrundlage nennt die Version je Position', async () => {
      const id = await neuerEntwurf();
      const akte = await get<{ data: { versions: { id: string; services: { id: string }[] }[] } }>(
        `/api/contracts/${id}`,
        { jar: jars.admin },
      );
      const v1 = data(akte).versions[0]!.id;
      await post(
        `/api/contract-services/${data(akte).versions[0]!.services[0]!.id}/schedules`,
        { frequency: 'WEEKLY', weekdays: [1], effectiveFrom: tagIn(1), startMinute: 360, endMinute: 600 },
        { jar: jars.admin },
      );
      await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin });

      // Ab Tag 1: Die Grundlage nimmt die Fassung, die am ersten Tag des
      // Zeitraums galt — und die gilt erst ab morgen. Ein Zeitraum ab heute
      // hätte keine Fassung und wird abgewiesen.
      const grundlage = await get<{ data: { contractVersionId: string; positionen: unknown[] } }>(
        `/api/contracts/${id}/billing-basis?von=${tagIn(1)}&bis=${tagIn(30)}`,
        { jar: jars.admin },
      );
      assert.equal(grundlage.status, 200, JSON.stringify(grundlage.payload));
      assert.equal(data(grundlage).contractVersionId, v1, 'Die Summe ist einer Fassung zugeordnet');

      const vorBeginn = await get(`/api/contracts/${id}/billing-basis?von=${tagIn(0)}&bis=${tagIn(30)}`, {
        jar: jars.admin,
      });
      assert.equal(vorBeginn.status, 422, 'Vor dem Beginn galt keine Fassung');
    });
  });

  // -------------------------------------------------------------------------
  //  Serienplanung
  // -------------------------------------------------------------------------

  describe('Serienplanung', () => {
    /** Ein aktiver Vertrag mit einer wöchentlichen Serie. */
    async function vertragMitSerie(): Promise<{ id: string; planId: string }> {
      const id = await neuerEntwurf();
      const akte = await get<{ data: { versions: { services: { id: string }[] }[] } }>(`/api/contracts/${id}`, {
        jar: jars.admin,
      });
      const leistung = data(akte).versions[0]!.services[0]!.id;
      const plan = await post<{ data: { id: string } }>(
        `/api/contract-services/${leistung}/schedules`,
        { frequency: 'WEEKLY', weekdays: [1, 3], effectiveFrom: tagIn(1), startMinute: 360, endMinute: 600 },
        { jar: jars.admin },
      );
      assert.equal(plan.status, 201, JSON.stringify(plan.payload));
      await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin });
      return { id, planId: data(plan).id };
    }

    it('erzeugt Einsätze und meldet die Zahl', async () => {
      const { id } = await vertragMitSerie();
      const lauf = await post<{ data: { angelegt: number; uebersprungen: number } }>(
        `/api/contracts/${id}/schedule`,
        { bis: tagIn(28) },
        { jar: jars.admin },
      );
      assert.equal(lauf.status, 200, JSON.stringify(lauf.payload));
      assert.ok(data(lauf).angelegt > 0, 'Es entstehen Einsätze');
      assert.equal(data(lauf).uebersprungen, 0, 'Beim ersten Lauf gibt es nichts zu überspringen');
    });

    /**
     * **Die teuerste Zusage dieses Moduls.**
     *
     * Ein zweiter Lauf darf keinen einzigen Einsatz hinzufügen. Die Prüfung
     * schaut deshalb nicht nur auf die gemeldete Zahl, sondern zählt die
     * Einsätze in der Datenbank — eine Zahl im Antwortkörper wäre eine
     * Behauptung des Dienstes über sich selbst.
     */
    it('ist idempotent: der zweite Lauf legt nichts an', async () => {
      const { id } = await vertragMitSerie();
      const ersterLauf = await post<{ data: { angelegt: number } }>(
        `/api/contracts/${id}/schedule`,
        { bis: tagIn(28) },
        { jar: jars.admin },
      );
      const erzeugt = data(ersterLauf).angelegt;
      assert.ok(erzeugt > 0);

      const zweiterLauf = await post<{ data: { angelegt: number; uebersprungen: number } }>(
        `/api/contracts/${id}/schedule`,
        { bis: tagIn(28) },
        { jar: jars.admin },
      );
      assert.equal(data(zweiterLauf).angelegt, 0, 'Kein einziger Einsatz kommt hinzu');

      const einsaetze = await get<{ data: { id: string }[] }>(`/api/jobs?contractId=${id}&pageSize=100`, {
        jar: jars.admin,
      });
      if (einsaetze.status === 200) {
        assert.equal(data(einsaetze).length, erzeugt, 'Auch in der Datenbank ist nichts hinzugekommen');
      }
    });

    it('bleibt idempotent, wenn zwei Läufe gleichzeitig starten', async () => {
      const { id } = await vertragMitSerie();
      /**
       * Zwei gleichzeitige Läufe sind der Fall, den eine Prüfung im Code nicht
       * abfängt: Zwischen „gibt es schon?" und `INSERT` liegt ein Moment.
       * Abgefangen wird er vom eindeutigen Index — und genau das wird hier
       * gemessen.
       */
      const [a, b] = await Promise.all([
        post<{ data: { angelegt: number } }>(`/api/contracts/${id}/schedule`, { bis: tagIn(28) }, { jar: jars.admin }),
        post<{ data: { angelegt: number } }>(`/api/contracts/${id}/schedule`, { bis: tagIn(28) }, { jar: jars.admin }),
      ]);
      assert.equal(a.status, 200, JSON.stringify(a.payload));
      assert.equal(b.status, 200, JSON.stringify(b.payload));

      const gesamt = data(a).angelegt + data(b).angelegt;
      const alleine = await post<{ data: { angelegt: number; uebersprungen: number } }>(
        `/api/contracts/${id}/schedule`,
        { bis: tagIn(28) },
        { jar: jars.admin },
      );
      assert.equal(data(alleine).angelegt, 0, 'Nach zwei gleichzeitigen Läufen ist alles da und nichts doppelt');
      assert.ok(gesamt > 0, 'Zusammen haben sie etwas erzeugt');
    });

    it('der Probelauf schreibt nichts', async () => {
      const { id } = await vertragMitSerie();
      const probe = await post<{ data: { angelegt: number; probelauf: boolean } }>(
        `/api/contracts/${id}/schedule`,
        { bis: tagIn(28), probelauf: true },
        { jar: jars.admin },
      );
      assert.equal(probe.status, 200);
      assert.equal(data(probe).probelauf, true);
      assert.ok(data(probe).angelegt > 0, 'Er meldet, was entstehen würde');

      const echt = await post<{ data: { angelegt: number } }>(
        `/api/contracts/${id}/schedule`,
        { bis: tagIn(28) },
        { jar: jars.admin },
      );
      assert.equal(
        data(echt).angelegt,
        data(probe).angelegt,
        'Der Probelauf hat nichts angelegt — der echte Lauf erzeugt dieselbe Zahl',
      );
    });

    it('plant für einen pausierten Vertrag nicht', async () => {
      const { id } = await vertragMitSerie();
      await post(
        `/api/contracts/${id}/pause`,
        { pausedFrom: tagIn(0), reason: 'Pause während der Prüfreihe' },
        { jar: jars.admin },
      );
      const lauf = await post<{ data: { angelegt: number } }>(
        `/api/contracts/${id}/schedule`,
        { bis: tagIn(28) },
        { jar: jars.admin },
      );
      assert.equal(data(lauf).angelegt, 0, 'Ein pausierter Vertrag erzeugt keine Einsätze');
    });

    /**
     * Bis 2026-09-23 prüfte dieser Fall nur einen Probelauf **vor** der
     * Planung — und bestand deshalb, obwohl eine Ausnahme auf bereits
     * geplante Einsätze keine Wirkung hatte (RB-007). Jetzt wird zuerst
     * geplant und danach gemessen, was mit dem geplanten Einsatz geschieht.
     */
    it('eine Ausnahme sagt den bereits geplanten Einsatz ab', async () => {
      const { id, planId } = await vertragMitSerie();
      await post(`/api/contracts/${id}/schedule`, { bis: tagIn(28) }, { jar: jars.admin });
      const vorher = await get<{ data: { status: string }[] }>(`/api/jobs?contractId=${id}&pageSize=100`, {
        jar: jars.admin,
      });
      const geplantVorher = data(vorher).filter((j) => j.status !== 'CANCELLED').length;

      // Den ersten Termin der Serie heraussuchen und aussetzen.
      const ersterMontag = (() => {
        for (let versatz = 1; versatz <= 14; versatz++) {
          const d = new Date(Date.UTC(heute.getUTCFullYear(), heute.getUTCMonth(), heute.getUTCDate() + versatz));
          if (d.getUTCDay() === 1) return d.toISOString().slice(0, 10);
        }
        return tagIn(7);
      })();

      const ausnahme = await post(
        `/api/contract-schedules/${planId}/exceptions`,
        { kind: 'SKIP', originalDate: ersterMontag, reason: 'Betriebsferien' },
        { jar: jars.admin },
      );
      assert.equal(ausnahme.status, 201, JSON.stringify(ausnahme.payload));

      const nachher = await get<{ data: { status: string; scheduledStart: string }[] }>(
        `/api/jobs?contractId=${id}&pageSize=100`,
        { jar: jars.admin },
      );
      const amMontag = data(nachher).filter((j) => j.scheduledStart.slice(0, 10) === ersterMontag);
      assert.equal(amMontag.length, 1, 'Der Einsatz des Tages bleibt als Zeile bestehen');
      assert.equal(amMontag[0]!.status, 'CANCELLED', 'Er ist abgesagt');

      // Der Abgleich plant danach bis zum Horizont; bis Tag 28 fehlt genau einer.
      const bisTag28 = data(nachher).filter(
        (j) => j.status !== 'CANCELLED' && j.scheduledStart.slice(0, 10) <= tagIn(28),
      ).length;
      assert.equal(bisTag28, geplantVorher - 1, 'Genau ein Termin entfällt');
    });
  });

  // -------------------------------------------------------------------------
  //  Änderungsanträge und Preise
  // -------------------------------------------------------------------------

  describe('Änderungsanträge', () => {
    it('beantragen, freigeben, wirksam machen — und die alte Version bleibt', async () => {
      const id = await neuerEntwurf();
      await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin });

      const antrag = await post<{ data: { id: string; status: string } }>(
        `/api/contracts/${id}/amendments`,
        {
          type: 'PRICE',
          title: 'Teuerungsausgleich 2027',
          reason: 'Lohnkosten gestiegen, im Vertrag vorgesehen',
          effectiveFrom: tagIn(45),
        },
        { jar: jars.manager },
      );
      assert.equal(antrag.status, 201, JSON.stringify(antrag.payload));
      assert.equal(data(antrag).status, 'REVIEW');

      const freigabe = await post<{ data: { status: string } }>(
        `/api/contracts/${id}/amendments/${data(antrag).id}/decision`,
        { entscheidung: 'APPROVE' },
        { jar: jars.admin },
      );
      assert.equal(freigabe.status, 200, JSON.stringify(freigabe.payload));
      assert.equal(data(freigabe).status, 'APPROVED');

      const wirksam = await post<{ data: { version: { versionNumber: number } } }>(
        `/api/contracts/${id}/amendments/${data(antrag).id}/apply`,
        {
          version: {
            effectiveFrom: tagIn(45),
            reason: 'unbenutzt — der Dienst setzt den Antragstext ein',
            billingCycle: 'MONTHLY',
            paymentTermDays: 30,
            pricingModel: 'FIXED_PERIOD',
            baseAmount: 1320,
            vatRate: 8.1,
            noticePeriodDays: 90,
            renewalType: 'NONE',
          },
        },
        { jar: jars.admin },
      );
      assert.equal(wirksam.status, 201, JSON.stringify(wirksam.payload));
      assert.equal(data(wirksam).version.versionNumber, 2);

      const akte = await get<{ data: { versions: { versionNumber: number; status: string; baseAmount: number }[] } }>(
        `/api/contracts/${id}`,
        { jar: jars.admin },
      );
      const eins = data(akte).versions.find((v) => v.versionNumber === 1)!;
      assert.equal(eins.status, 'ACTIVE', 'Bis zur Aktivierung gilt weiterhin die erste Fassung');
      assert.equal(eins.baseAmount, 1200, 'Die alte Fassung trägt unverändert ihren Preis');
    });

    it('wer beantragt, gibt nicht frei (422)', async () => {
      const id = await neuerEntwurf();
      await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin });

      const antrag = await post<{ data: { id: string } }>(
        `/api/contracts/${id}/amendments`,
        {
          type: 'SCOPE',
          title: 'Zusätzliche Fensterreinigung',
          reason: 'Von der Kundschaft gewünscht',
          effectiveFrom: tagIn(45),
        },
        { jar: jars.admin },
      );
      assert.equal(antrag.status, 201);

      const selbstFreigabe = await post(
        `/api/contracts/${id}/amendments/${data(antrag).id}/decision`,
        { entscheidung: 'APPROVE' },
        { jar: jars.admin },
      );
      assert.equal(selbstFreigabe.status, 422, 'Vier-Augen-Prinzip — auch für die Administration');
    });

    it('lässt keinen zweiten offenen Antrag zu (422)', async () => {
      const id = await neuerEntwurf();
      await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin });
      const rumpf = {
        type: 'OTHER',
        title: 'Erster Antrag',
        reason: 'Prüfreihe, erster Antrag',
        effectiveFrom: tagIn(45),
      };
      assert.equal((await post(`/api/contracts/${id}/amendments`, rumpf, { jar: jars.admin })).status, 201);
      assert.equal(
        (await post(`/api/contracts/${id}/amendments`, { ...rumpf, title: 'Zweiter Antrag' }, { jar: jars.admin }))
          .status,
        422,
      );
    });

    it('Preisanpassung: vorschlagen, freigeben, wirksam machen', async () => {
      const id = await neuerEntwurf();
      await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin });

      const anpassung = await post<{ data: { id: string; oldAmount: number; newAmount: number; percent: number } }>(
        `/api/contracts/${id}/price-adjustments`,
        {
          effectiveFrom: tagIn(60),
          newAmount: 1320,
          reason: 'Indexanpassung gemäss Vertrag',
        },
        { jar: jars.manager },
      );
      assert.equal(anpassung.status, 201, JSON.stringify(anpassung.payload));
      assert.equal(
        Number(data(anpassung).oldAmount),
        1200,
        'Der alte Betrag kommt aus der geltenden Version, nicht aus der Anfrage',
      );

      assert.equal(
        (
          await post(
            `/api/contracts/${id}/price-adjustments/${data(anpassung).id}/decision`,
            { entscheidung: 'APPROVE' },
            { jar: jars.admin },
          )
        ).status,
        200,
      );

      const wirksam = await post<{ data: { version: { versionNumber: number } } }>(
        `/api/contracts/${id}/price-adjustments/${data(anpassung).id}/apply`,
        {},
        { jar: jars.admin },
      );
      assert.equal(wirksam.status, 201, JSON.stringify(wirksam.payload));
      assert.equal(data(wirksam).version.versionNumber, 2);
    });

    it('weist eine Preisanpassung auf denselben Betrag ab (422)', async () => {
      const id = await neuerEntwurf();
      await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin });
      const antwort = await post(
        `/api/contracts/${id}/price-adjustments`,
        { effectiveFrom: tagIn(60), newAmount: 1200, reason: 'Es gibt nichts anzupassen' },
        { jar: jars.admin },
      );
      assert.equal(antwort.status, 422);
    });
  });

  // -------------------------------------------------------------------------
  //  Abrechnung
  // -------------------------------------------------------------------------

  describe('Abrechnungsgrundlage', () => {
    it('leitet die Summe her und nennt die Vertragsversion', async () => {
      const id = await neuerEntwurf();
      await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin });

      const grundlage = await get<{
        data: { netto: number; mwst: number; brutto: number; versionNumber: number; herleitung: string };
      }>(`/api/contracts/${id}/billing-basis?von=${tagIn(1)}&bis=${tagIn(30)}`, { jar: jars.admin });

      assert.equal(grundlage.status, 200, JSON.stringify(grundlage.payload));
      assert.equal(data(grundlage).netto, 1200, 'Pauschale je Periode');
      assert.equal(data(grundlage).mwst, 97.2, '1200 × 8,1 %');
      assert.equal(data(grundlage).brutto, 1297.2);
      assert.equal(data(grundlage).versionNumber, 1, 'Die Summe ist einer Vertragsversion zugeordnet');
      assert.ok(data(grundlage).herleitung.length > 0, 'Die Herleitung steht dabei');
    });
  });

  // -------------------------------------------------------------------------
  //  Vertragsrechnung
  // -------------------------------------------------------------------------

  /**
   * Die teuerste Zusage des Abrechnungsteils: **eine Periode, eine Rechnung.**
   *
   * Sie hängt nicht an einer Prüfung im Dienst, sondern an einem Teilindex in
   * der Datenbank — zwischen „gibt es schon eine?" und dem INSERT liegt ein
   * Moment, und ein doppelter Klick, ein Wiederholungsversuch und zwei
   * gleichzeitige Monatsabschlüsse passen genau hinein. Geprüft wird deshalb
   * nicht nur der zweite Aufruf, sondern auch der gleichzeitige.
   */
  describe('Vertragsrechnung', () => {
    /** Alles, was hier entstanden ist — Rechnungen räumen sich selbst weg. */
    const angelegteRechnungen: string[] = [];

    after(async () => {
      for (const id of angelegteRechnungen) {
        await del(`/api/invoices/${id}`, { jar: jars.admin }).catch(() => undefined);
      }
    });

    /** Ein aktiver Vertrag mit Pauschale — der Fall, der immer einen Betrag ergibt. */
    async function abrechenbarerVertrag(): Promise<string> {
      const id = await neuerEntwurf({ contract: { startDate: tagIn(-400) }, version: { effectiveFrom: tagIn(-400) } });
      const antwort = await post(`/api/contracts/${id}/activate`, { effectiveFrom: tagIn(-400) }, { jar: jars.admin });
      assert.equal(antwort.status, 200, JSON.stringify(antwort.payload));
      return id;
    }

    function merke(rechnung: { invoiceId: string }) {
      if (!angelegteRechnungen.includes(rechnung.invoiceId)) angelegteRechnungen.push(rechnung.invoiceId);
    }

    it('erzeugt eine Rechnung für die Periode und nennt Vertrag, Fassung und Zeitraum', async () => {
      const id = await abrechenbarerVertrag();

      const antwort = await post<{
        data: {
          invoiceId: string;
          neu: boolean;
          brutto: number;
          netto: number;
          periodLabel: string;
          contractVersionId: string;
          versionNumber: number;
        };
      }>(`/api/contracts/${id}/invoices`, {}, { jar: jars.admin });

      assert.equal(antwort.status, 201, JSON.stringify(antwort.payload));
      merke(data(antwort));

      assert.equal(data(antwort).neu, true);
      assert.equal(data(antwort).netto, 1200, 'Pauschale je Periode');
      assert.equal(data(antwort).brutto, 1297.2, '1200 + 8,1 %');
      assert.equal(data(antwort).versionNumber, 1, 'Die Rechnung trägt die Fassung, unter der sie entstand');
      assert.ok(data(antwort).periodLabel.length > 0);

      /*
        Und die Abrechnungsübersicht führt sie auf — mit Zeitraum und Fassung.
        Geprüft wird hier und nicht an `/api/invoices/{id}`: Diesen Endpunkt
        gibt es nicht, die Rechnungsakte ist eine Seite. Die Übersicht ist der
        Ort, an dem die Herkunft fachlich sichtbar wird.
      */
      const uebersicht = await get<{
        data: { perioden: { label: string; invoice: { id: string; versionNumber: number } | null }[] };
      }>(`/api/contracts/${id}/invoices?perioden=2`, { jar: jars.admin });
      assert.equal(uebersicht.status, 200, JSON.stringify(uebersicht.payload));

      const gedeckt = data(uebersicht).perioden.find((p) => p.invoice?.id === data(antwort).invoiceId);
      assert.ok(gedeckt, 'Die erzeugte Rechnung erscheint in der Übersicht');
      assert.equal(gedeckt!.invoice!.versionNumber, 1, 'mit der Fassung, unter der sie entstand');
      assert.equal(gedeckt!.label, data(antwort).periodLabel);
    });

    /**
     * Ohne Stichtag die **abgeschlossene** Periode, nie die laufende.
     *
     * Bis 2026-09-23 war der Vorgabetag „gestern" — an jedem Tag ausser dem
     * ersten einer Periode also die laufende. Mit einem Fassungswechsel zu
     * morgen fakturierte das den angebrochenen Monat anteilig (1200 × 23/30),
     * obwohl die Maske „die vorige" verspricht. Gefunden von der Browserreihe.
     */
    it('rechnet ohne Stichtag die zuletzt abgeschlossene Periode ab — auch mit einer Fassung ab morgen', async () => {
      const id = await abrechenbarerVertrag();
      const neu = await post<{ data: { id: string } }>(
        `/api/contracts/${id}/versions`,
        {
          version: {
            effectiveFrom: tagIn(1),
            reason: 'Neuer Preis ab morgen',
            billingCycle: 'MONTHLY',
            paymentTermDays: 30,
            pricingModel: 'FIXED_PERIOD',
            baseAmount: 1500,
            vatRate: 8.1,
            noticePeriodDays: 90,
            renewalType: 'NONE',
          },
        },
        { jar: jars.admin },
      );
      assert.equal(neu.status, 201, JSON.stringify(neu.payload));
      const aktiv = await post(`/api/contracts/${id}/versions/${data(neu).id}/activate`, {}, { jar: jars.admin });
      assert.equal(aktiv.status, 200, JSON.stringify(aktiv.payload));

      const antwort = await post<{ data: { invoiceId: string; netto: number; versionNumber: number; periodEnd: string } }>(
        `/api/contracts/${id}/invoices`,
        {},
        { jar: jars.admin },
      );
      assert.equal(antwort.status, 201, JSON.stringify(antwort.payload));
      merke(data(antwort));
      assert.equal(data(antwort).netto, 1200, 'Eine volle Periode, kein angebrochener Monat');
      assert.equal(data(antwort).versionNumber, 1, 'Unter der Fassung, die damals galt');
      assert.ok(
        String(data(antwort).periodEnd).slice(0, 10) < tagIn(0),
        `Die Periode endet vor heute, nicht erst in der Zukunft (${data(antwort).periodEnd})`,
      );
    });

    it('legt beim zweiten Aufruf nichts an — dieselbe Rechnung, 200 statt 201', async () => {
      const id = await abrechenbarerVertrag();

      const erste = await post<{ data: { invoiceId: string; neu: boolean } }>(
        `/api/contracts/${id}/invoices`,
        {},
        { jar: jars.admin },
      );
      assert.equal(erste.status, 201, JSON.stringify(erste.payload));
      merke(data(erste));

      const zweite = await post<{ data: { invoiceId: string; neu: boolean } }>(
        `/api/contracts/${id}/invoices`,
        {},
        { jar: jars.admin },
      );
      assert.equal(zweite.status, 200, 'Der zweite Aufruf ist kein Fehler, sondern ein Verweis');
      assert.equal(data(zweite).neu, false);
      assert.equal(data(zweite).invoiceId, data(erste).invoiceId, 'Dieselbe Rechnung, kein zweiter Beleg');
    });

    it('verschiedene Stichtage derselben Periode ergeben dieselbe Rechnung', async () => {
      const id = await abrechenbarerVertrag();

      // Zwei Tage, die im selben Monat liegen — die Periode ist kanonisch,
      // nicht frei wählbar. Genau das ist der Schlüssel gegen Doppelabrechnung.
      const ersteAntwort = await post<{ data: { invoiceId: string } }>(
        `/api/contracts/${id}/invoices`,
        { stichtag: tagIn(-40) },
        { jar: jars.admin },
      );
      assert.equal(ersteAntwort.status, 201, JSON.stringify(ersteAntwort.payload));
      merke(data(ersteAntwort));

      const zweiteAntwort = await post<{ data: { invoiceId: string; neu: boolean } }>(
        `/api/contracts/${id}/invoices`,
        { stichtag: tagIn(-39) },
        { jar: jars.admin },
      );
      assert.equal(zweiteAntwort.status, 200);
      assert.equal(data(zweiteAntwort).invoiceId, data(ersteAntwort).invoiceId);
    });

    it('zwei gleichzeitige Läufe erzeugen genau eine Rechnung', async () => {
      const id = await abrechenbarerVertrag();

      /**
       * Der Fall, den eine Prüfung im Code nicht abdeckt: Beide Anfragen lesen
       * „es gibt noch keine", bevor eine von beiden geschrieben hat. Abgewiesen
       * wird hier nicht durch den Dienst, sondern durch den Teilindex — und der
       * unterlegene Lauf gibt die Rechnung des anderen zurück, statt zu
       * scheitern.
       */
      const [a, b] = await Promise.all([
        post<{ data: { invoiceId: string; neu: boolean } }>(
          `/api/contracts/${id}/invoices`,
          { stichtag: tagIn(-70) },
          { jar: jars.admin },
        ),
        post<{ data: { invoiceId: string; neu: boolean } }>(
          `/api/contracts/${id}/invoices`,
          { stichtag: tagIn(-70) },
          { jar: jars.admin },
        ),
      ]);

      assert.ok([200, 201].includes(a.status), `erster Lauf: HTTP ${a.status} — ${JSON.stringify(a.payload)}`);
      assert.ok([200, 201].includes(b.status), `zweiter Lauf: HTTP ${b.status} — ${JSON.stringify(b.payload)}`);
      merke(data(a));
      merke(data(b));

      assert.equal(data(a).invoiceId, data(b).invoiceId, 'Beide Läufe zeigen auf denselben Beleg');

      // Und in der Datenbank steht genau einer.
      const liste = await get<{ data: { id: string }[] }>(`/api/invoices?contractId=${id}&pageSize=50`, {
        jar: jars.admin,
      });
      assert.equal(liste.status, 200, JSON.stringify(liste.payload));
      assert.equal(data(liste).length, 1, 'Genau eine Rechnung, nicht zwei');
    });

    it('rechnet jede Periode einzeln ab — zwei Perioden, zwei Rechnungen', async () => {
      const id = await abrechenbarerVertrag();

      const a = await post<{ data: { invoiceId: string; periodStart: string } }>(
        `/api/contracts/${id}/invoices`,
        { stichtag: tagIn(-100) },
        { jar: jars.admin },
      );
      const b = await post<{ data: { invoiceId: string; periodStart: string } }>(
        `/api/contracts/${id}/invoices`,
        { stichtag: tagIn(-160) },
        { jar: jars.admin },
      );
      assert.equal(a.status, 201, JSON.stringify(a.payload));
      assert.equal(b.status, 201, JSON.stringify(b.payload));
      merke(data(a));
      merke(data(b));

      assert.notEqual(data(a).invoiceId, data(b).invoiceId);
      assert.notEqual(
        data(a).periodStart.slice(0, 10),
        data(b).periodStart.slice(0, 10),
        'Zwei verschiedene Perioden',
      );
    });

    it('eine ausgestellte Rechnung trägt die Fassung von damals — auch nach einer Preisanpassung', async () => {
      const id = await abrechenbarerVertrag();

      const rechnung = await post<{
        data: { invoiceId: string; number: string; contractVersionId: string; versionNumber: number };
      }>(`/api/contracts/${id}/invoices`, { stichtag: tagIn(-220), sofortAusstellen: true }, { jar: jars.admin });
      assert.equal(rechnung.status, 201, JSON.stringify(rechnung.payload));
      merke(data(rechnung));
      assert.equal(data(rechnung).versionNumber, 1);

      assert.match(
        data(rechnung).number,
        /^RE-/,
        'Ausgestellt heisst: Nummer aus dem Nummernkreis, danach unveränderlich',
      );

      // Jetzt eine neue Fassung mit anderem Preis.
      const version2 = await post(
        `/api/contracts/${id}/versions`,
        {
          version: {
            effectiveFrom: tagIn(-10),
            reason: 'Preisanpassung zur Prüfung des Schnappschusses',
            billingCycle: 'MONTHLY',
            paymentTermDays: 30,
            pricingModel: 'FIXED_PERIOD',
            baseAmount: 2400,
            vatRate: 8.1,
            noticePeriodDays: 90,
            renewalType: 'NONE',
          },
        },
        { jar: jars.admin },
      );
      assert.equal(version2.status, 201, JSON.stringify(version2.payload));

      /**
       * Die alte Rechnung zeigt weiter auf Fassung 1. Würde sie dynamisch auf
       * „die derzeit geltende" auflösen, wäre jede ausgestellte Rechnung nach
       * der ersten Preisanpassung falsch hergeleitet — und Art. 957a OR
       * verlangt das Gegenteil.
       */
      const nachher = await get<{
        data: { perioden: { invoice: { id: string; status: string; brutto: number; versionNumber: number } | null }[] };
      }>(`/api/contracts/${id}/invoices?perioden=12`, { jar: jars.admin });
      assert.equal(nachher.status, 200, JSON.stringify(nachher.payload));

      const zeile = data(nachher).perioden.find((p) => p.invoice?.id === data(rechnung).invoiceId);
      assert.ok(zeile, 'Die Rechnung steht weiterhin in der Übersicht');
      assert.equal(zeile!.invoice!.versionNumber, 1, 'Die Rechnung hängt unverändert an Fassung 1');
      assert.equal(zeile!.invoice!.brutto, 1297.2, 'Und der Betrag von damals steht unverändert');
      assert.equal(zeile!.invoice!.status, 'ISSUED');
    });

    it('rechnet einen Entwurf nicht ab (422)', async () => {
      const id = await neuerEntwurf();
      const antwort = await post(`/api/contracts/${id}/invoices`, {}, { jar: jars.admin });
      assert.equal(antwort.status, 422, 'Ein Vertrag, der nie in Kraft war, ergibt keinen Beleg');
    });

    it('zeigt in der Übersicht, welche Perioden offen sind', async () => {
      const id = await abrechenbarerVertrag();

      const vorher = await get<{
        data: { billingCycle: string; perioden: { label: string; invoice: { id: string } | null }[] };
      }>(`/api/contracts/${id}/invoices?perioden=3`, { jar: jars.admin });
      assert.equal(vorher.status, 200, JSON.stringify(vorher.payload));
      assert.equal(data(vorher).billingCycle, 'MONTHLY');
      assert.equal(data(vorher).perioden.length, 3);
      assert.deepEqual(
        data(vorher).perioden.map((p) => p.invoice),
        [null, null, null],
        'Vor der Abrechnung ist jede Periode offen',
      );

      const erzeugt = await post<{ data: { invoiceId: string } }>(
        `/api/contracts/${id}/invoices`,
        {},
        { jar: jars.admin },
      );
      assert.equal(erzeugt.status, 201, JSON.stringify(erzeugt.payload));
      merke(data(erzeugt));

      const nachher = await get<{ data: { perioden: { invoice: { id: string } | null }[] } }>(
        `/api/contracts/${id}/invoices?perioden=3`,
        { jar: jars.admin },
      );
      assert.equal(data(nachher).perioden[0]!.invoice?.id, data(erzeugt).invoiceId, 'Die jüngste Periode ist gedeckt');
      assert.equal(data(nachher).perioden[1]!.invoice, null, 'Die davor bleibt offen');
    });

    /**
     * Abrechnen ist **Tagesgeschäft**, nicht Zusage nach aussen.
     *
     * Die Betriebsleitung hat `contract:billing` und `invoice:create` — sie
     * stellt auch sonst Rechnungen. Hier eine höhere Hürde zu ziehen wäre
     * nicht strenger, sondern inkonsequent: Dieselbe Person könnte denselben
     * Betrag über `POST /api/invoices` von Hand erfassen, nur ohne die
     * Herkunftsangaben und ohne den Schutz gegen Doppelabrechnung.
     *
     * Die scharfe Linie liegt woanders und ist in `Rechte` geprüft:
     * aktivieren, freigeben, zur Unterschrift geben, kündigen.
     */
    it('die Betriebsleitung darf abrechnen — Mitarbeitende nicht', async () => {
      const id = await abrechenbarerVertrag();

      const betriebsleitung = await post<{ data: { invoiceId: string } }>(
        `/api/contracts/${id}/invoices`,
        {},
        { jar: jars.manager },
      );
      assert.equal(betriebsleitung.status, 201, JSON.stringify(betriebsleitung.payload));
      merke(data(betriebsleitung));

      const mitarbeitende = await post(`/api/contracts/${id}/invoices`, {}, { jar: jars.employee });
      assert.equal(mitarbeitende.status, 403, 'Mitarbeitende haben mit Verträgen nichts zu tun');

      const kundschaft = await post(`/api/contracts/${id}/invoices`, {}, { jar: jars.customer });
      assert.equal(kundschaft.status, 403, 'Und die Kundschaft rechnet sich selbst nichts ab');
    });
  });

  // -------------------------------------------------------------------------
  //  Rechte und Sichtbarkeit
  // -------------------------------------------------------------------------

  describe('Rechte', () => {
    it('die Betriebsleitung entwirft, aktiviert aber nicht (403)', async () => {
      const antwort = await post<{ data: { id: string } }>('/api/contracts', entwurf(), { jar: jars.manager });
      assert.equal(antwort.status, 201, 'Entwerfen gehört zum Tagesgeschäft');
      angelegteVertraege.push(data(antwort).id);

      assert.equal(
        (await post(`/api/contracts/${data(antwort).id}/activate`, {}, { jar: jars.manager })).status,
        403,
        'In Kraft setzen ist eine Zusage nach aussen',
      );
      assert.equal(
        (await post(`/api/contracts/${data(antwort).id}/end`, {}, { jar: jars.manager })).status,
        403,
      );
    });

    it('Mitarbeitende haben keinen Zugang (403)', async () => {
      assert.equal((await get('/api/contracts', { jar: jars.employee })).status, 403);
    });

    it('Kundschaft sieht ausschliesslich die eigenen Verträge', async () => {
      const id = await neuerEntwurf();
      await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin });

      const liste = await get<{ data: { contracts: { customer: { id: string } }[] } }>('/api/contracts', {
        jar: jars.customer,
      });
      assert.equal(liste.status, 200, 'Der Kundenbereich darf die Liste öffnen');

      /**
       * Geprüft an der **Antwort**, nicht am Statuscode: Eine Einschränkung,
       * die nur die Anzeige betrifft, wäre auf der Leitung wirkungslos.
       */
      const fremde = data(liste).contracts.filter((v) => v.customer.id !== kundeId);
      assert.deepEqual(
        fremde.map((v) => v.customer.id),
        [],
        'Kein fremder Vertrag in der Antwort',
      );

      // Und der eben angelegte Vertrag gehört einer anderen Akte als der des
      // Demokunden — er darf deshalb nicht einzeln abrufbar sein.
      const einzeln = await get(`/api/contracts/${id}`, { jar: jars.customer });
      assert.ok([403, 404].includes(einzeln.status), `erwartet 403/404, war ${einzeln.status}`);
    });
  });
});
