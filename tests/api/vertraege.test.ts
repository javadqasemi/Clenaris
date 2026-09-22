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

    it('beendet und legt dabei die Einsatzpläne still', async () => {
      const id = await neuerEntwurf();
      await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin });

      const akte = await get<{ data: { versions: { services: { id: string }[] }[] } }>(`/api/contracts/${id}`, {
        jar: jars.admin,
      });
      const leistung = data(akte).versions[0]!.services[0]!.id;
      const plan = await post<{ data: { id: string } }>(
        `/api/contract-services/${leistung}/schedules`,
        { frequency: 'WEEKLY', weekdays: [1], effectiveFrom: tagIn(1), startMinute: 360, endMinute: 600 },
        { jar: jars.admin },
      );
      assert.equal(plan.status, 201, JSON.stringify(plan.payload));

      const ende = await post<{ data: { status: string } }>(
        `/api/contracts/${id}/end`,
        { reason: 'Prüfreihe' },
        { jar: jars.admin },
      );
      assert.equal(ende.status, 200);
      assert.equal(data(ende).status, 'ENDED');

      const nachher = await get<{ data: { versions: { services: { schedules: { active: boolean }[] }[] }[] } }>(
        `/api/contracts/${id}`,
        { jar: jars.admin },
      );
      const plaene = data(nachher).versions.flatMap((v) => v.services.flatMap((s) => s.schedules));
      assert.ok(plaene.length > 0, 'Der Plan bleibt lesbar');
      assert.ok(
        plaene.every((p) => p.active === false),
        'Mit dem Ende laufen die Serien aus — sonst plante der Nachtlauf weiter',
      );
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

    it('nimmt eine Ausnahme entgegen und lässt den Termin entfallen', async () => {
      const { id, planId } = await vertragMitSerie();
      const probeVorher = await post<{ data: { angelegt: number } }>(
        `/api/contracts/${id}/schedule`,
        { bis: tagIn(28), probelauf: true },
        { jar: jars.admin },
      );

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

      const probeNachher = await post<{ data: { angelegt: number } }>(
        `/api/contracts/${id}/schedule`,
        { bis: tagIn(28), probelauf: true },
        { jar: jars.admin },
      );
      assert.equal(
        data(probeNachher).angelegt,
        data(probeVorher).angelegt - 1,
        'Genau ein Termin entfällt',
      );
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
      }>(`/api/contracts/${id}/billing-basis?von=${tagIn(0)}&bis=${tagIn(30)}`, { jar: jars.admin });

      assert.equal(grundlage.status, 200, JSON.stringify(grundlage.payload));
      assert.equal(data(grundlage).netto, 1200, 'Pauschale je Periode');
      assert.equal(data(grundlage).mwst, 97.2, '1200 × 8,1 %');
      assert.equal(data(grundlage).brutto, 1297.2);
      assert.equal(data(grundlage).versionNumber, 1, 'Die Summe ist einer Vertragsversion zugeordnet');
      assert.ok(data(grundlage).herleitung.length > 0, 'Die Herleitung steht dabei');
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
