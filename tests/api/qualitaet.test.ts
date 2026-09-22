import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { data, del, get, patch, post, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';

/**
 * Wave 11 — Qualitätskontrolle über HTTP.
 *
 * ---------------------------------------------------------------------------
 *  Was hier geprüft wird und was ausdrücklich nicht
 * ---------------------------------------------------------------------------
 *
 * Die Rechnung steht in `qualitaet-rechenkern.test.ts`: Gewichtung,
 * ausgeklammerte Kriterien, Toleranz, Fälligkeit, Reaktionsfrist. Nichts davon
 * wird hier wiederholt — über HTTP verdeckte der Datenbestand die Rechnung.
 *
 * Hier geht es um das, was nur der laufende Dienst beantworten kann:
 *
 *  • **Der Server rechnet.** Ein mitgeschicktes Ergebnis prallt am Schema ab,
 *    und die Punktzahl entsteht aus den Positionen.
 *  • **Der Massstab ist ein Schnappschuss.** Festgehalten wird die Fassung,
 *    die am Begehungstag galt — nicht die heute geltende.
 *  • **Abgeschlossen ist unveränderlich.** Ändern, Verwerfen und ein zweiter
 *    Abschluss enden in 422; korrigiert wird über eine Nachkontrolle, und die
 *    gibt es genau einmal.
 *  • **Die Sichtbarkeit steht in der Abfrage.** Kundschaft sieht nur die
 *    eigenen und nur abgeschlossene Begehungen — geprüft an der Antwort, nicht
 *    am Statuscode.
 */

let jars: Record<AccountName, string>;
let kundeId: string;
let objektId: string;
let leistungId: string;

const angelegteBegehungen: string[] = [];
const angelegteVertraege: string[] = [];

const heute = new Date();
const tagIn = (tage: number) => {
  const d = new Date(Date.UTC(heute.getUTCFullYear(), heute.getUTCMonth(), heute.getUTCDate() + tage));
  return d.toISOString().slice(0, 10);
};

/** Die Positionen, mit denen fast jeder Fall arbeitet: 80 % ohne Gewichtung. */
const positionen = () => [
  { label: 'Eingang und Empfang', points: 4, maxPoints: 5, weight: 1, position: 0 },
  { label: 'Büroflächen', points: 4, maxPoints: 5, weight: 1, position: 1 },
  { label: 'Sanitärbereiche', points: 4, maxPoints: 5, weight: 1, position: 2 },
];

async function begehungAnlegen(rumpf: Record<string, unknown>, jar = jars.admin) {
  const antwort = await post<{ data: { id: string } }>('/api/quality-inspections', rumpf, { jar });
  if (antwort.status === 201) angelegteBegehungen.push(data(antwort).id);
  return antwort;
}

/** Ein aktiver Vertrag mit Qualitätszusage — der Fall, in dem geurteilt wird. */
async function vertragMitZusage(ueber: { targetQualityScore?: number; inspectionIntervalDays?: number } = {}) {
  const angelegt = await post<{ data: { id: string } }>(
    '/api/contracts',
    {
      contract: {
        customerId: kundeId,
        propertyId: objektId,
        title: `Qualitätsprüfung ${Date.now()}`,
        startDate: tagIn(-200),
      },
      version: {
        effectiveFrom: tagIn(-200),
        reason: 'Erstfassung aus der Prüfreihe',
        billingCycle: 'MONTHLY',
        paymentTermDays: 30,
        pricingModel: 'FIXED_PERIOD',
        baseAmount: 1200,
        vatRate: 8.1,
        noticePeriodDays: 90,
        renewalType: 'NONE',
        targetQualityScore: ueber.targetQualityScore ?? 85,
        inspectionIntervalDays: ueber.inspectionIntervalDays ?? 90,
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
    },
    { jar: jars.admin },
  );
  assert.equal(angelegt.status, 201, JSON.stringify(angelegt.payload));
  const id = data(angelegt).id;
  angelegteVertraege.push(id);

  const aktiviert = await post(`/api/contracts/${id}/activate`, { effectiveFrom: tagIn(-200) }, { jar: jars.admin });
  assert.equal(aktiviert.status, 200, JSON.stringify(aktiviert.payload));
  return id;
}

describe('Qualitätskontrolle', () => {
  before(async () => {
    await requireServer();
    jars = await loginAll();

    const kunden = await get<{ data: { id: string }[] }>('/api/customers?pageSize=1', { jar: jars.admin });
    assert.equal(kunden.status, 200);
    kundeId = data(kunden)[0]!.id;

    const objekte = await get<{ data: { id: string; customerId: string }[] }>('/api/properties?pageSize=50', {
      jar: jars.admin,
    });
    objektId = data(objekte).find((o) => o.customerId === kundeId)?.id ?? data(objekte)[0]!.id;

    const leistungen = await get<{ data: { id: string }[] }>('/api/services?pageSize=1', { jar: jars.admin });
    leistungId = data(leistungen)[0]!.id;
  });

  after(async () => {
    for (const id of angelegteBegehungen) {
      await del(`/api/quality-inspections/${id}`, { jar: jars.admin }).catch(() => undefined);
    }
    for (const id of angelegteVertraege) {
      const geloescht = await del(`/api/contracts/${id}`, { jar: jars.admin }).catch(() => null);
      if (geloescht?.status === 204) continue;
      await post(`/api/contracts/${id}/end`, { reason: 'Aufräumen der Prüfreihe' }, { jar: jars.admin }).catch(
        () => undefined,
      );
    }
  });

  // -------------------------------------------------------------------------
  //  Der Server rechnet
  // -------------------------------------------------------------------------

  describe('Der Server rechnet, nicht der Client', () => {
    it('erzeugt Punktzahl und Urteil aus den Positionen', async () => {
      const vertragId = await vertragMitZusage({ targetQualityScore: 85 });

      const antwort = await begehungAnlegen({
        contractId: vertragId,
        inspectedAt: new Date().toISOString(),
        items: positionen(),
      });

      assert.equal(antwort.status, 201, JSON.stringify(antwort.payload));
      const begehung = data(antwort) as unknown as {
        scoreAchieved: string;
        scorePossible: string;
        scorePercent: string;
        targetScore: number;
        outcome: string;
        status: string;
        number: string | null;
      };

      assert.equal(Number(begehung.scoreAchieved), 12);
      assert.equal(Number(begehung.scorePossible), 15);
      assert.equal(Number(begehung.scorePercent), 80);
      assert.equal(begehung.targetScore, 85, 'Der Zielwert ist ein Schnappschuss der Fassung');
      assert.equal(begehung.outcome, 'KNAPP', '80 % bei 85 % Ziel liegt in der Toleranz');
      assert.equal(begehung.status, 'DRAFT', 'Eine Begehung entsteht als Entwurf');
      assert.equal(begehung.number, null, 'Die Nummer entsteht erst beim Abschluss');
    });

    /**
     * Das Schema kennt kein Feld für ein Ergebnis. Ein mitgeschicktes prallt
     * ab, statt stillschweigend übernommen zu werden — dieselbe Regel wie
     * beim Preis.
     */
    it('nimmt kein mitgeschicktes Ergebnis entgegen', async () => {
      const vertragId = await vertragMitZusage();

      const antwort = await begehungAnlegen({
        contractId: vertragId,
        inspectedAt: new Date().toISOString(),
        items: positionen(),
        scorePercent: 100,
        outcome: 'BESTANDEN',
        targetScore: 10,
        status: 'COMPLETED',
        number: 'QK-GEFAELSCHT',
      });

      assert.equal(antwort.status, 201, JSON.stringify(antwort.payload));
      const begehung = data(antwort) as unknown as {
        scorePercent: string;
        outcome: string;
        targetScore: number;
        status: string;
        number: string | null;
      };

      assert.equal(Number(begehung.scorePercent), 80, 'gerechnet, nicht übernommen');
      assert.equal(begehung.targetScore, 85, 'aus der Fassung, nicht aus dem Rumpf');
      assert.equal(begehung.status, 'DRAFT');
      assert.equal(begehung.number, null);
    });

    it('urteilt ohne Vertrag nicht, misst aber trotzdem', async () => {
      const antwort = await begehungAnlegen({
        propertyId: objektId,
        inspectedAt: new Date().toISOString(),
        items: positionen(),
      });

      assert.equal(antwort.status, 201, JSON.stringify(antwort.payload));
      const begehung = data(antwort) as unknown as { outcome: string; targetScore: number | null; scorePercent: string };
      assert.equal(begehung.outcome, 'OHNE_ZIEL');
      assert.equal(begehung.targetScore, null);
      assert.equal(Number(begehung.scorePercent), 80, 'die Messung gibt es trotzdem');
    });

    it('weist eine Begehung ohne Vertrag und ohne Objekt ab (422)', async () => {
      const antwort = await post(
        '/api/quality-inspections',
        { inspectedAt: new Date().toISOString(), items: positionen() },
        { jar: jars.admin },
      );
      assert.equal(antwort.status, 422, 'Eine Begehung ohne Bezug wäre eine Notiz');
    });
  });

  // -------------------------------------------------------------------------
  //  Abgeschlossen ist unveränderlich
  // -------------------------------------------------------------------------

  describe('Abgeschlossen ist ein Beleg', () => {
    async function abgeschlosseneBegehung() {
      const vertragId = await vertragMitZusage();
      const angelegt = await begehungAnlegen({
        contractId: vertragId,
        inspectedAt: new Date().toISOString(),
        items: positionen(),
      });
      assert.equal(angelegt.status, 201, JSON.stringify(angelegt.payload));
      const id = data(angelegt).id;

      const abgeschlossen = await post<{ data: { number: string; status: string } }>(
        `/api/quality-inspections/${id}/complete`,
        {},
        { jar: jars.admin },
      );
      assert.equal(abgeschlossen.status, 200, JSON.stringify(abgeschlossen.payload));
      return { id, vertragId, beleg: data(abgeschlossen) };
    }

    it('vergibt beim Abschluss Nummer und Zeitpunkt', async () => {
      const { beleg } = await abgeschlosseneBegehung();
      assert.match(beleg.number, /^QK-/, 'Nummer aus dem Nummernkreis, erst beim Abschluss');
      assert.equal(beleg.status, 'COMPLETED');
    });

    it('weist Ändern, Verwerfen und einen zweiten Abschluss ab (422)', async () => {
      const { id } = await abgeschlosseneBegehung();

      const geaendert = await patch(
        `/api/quality-inspections/${id}`,
        { note: 'Nachträglich schöngeschrieben' },
        { jar: jars.admin },
      );
      assert.equal(geaendert.status, 422, 'Ein Beleg wird nicht überschrieben');

      const verworfen = await del(`/api/quality-inspections/${id}`, { jar: jars.admin });
      assert.equal(verworfen.status, 422, 'Und nicht gelöscht');

      const nochmal = await post(`/api/quality-inspections/${id}/complete`, {}, { jar: jars.admin });
      assert.equal(nochmal.status, 422, 'Und nicht zweimal abgeschlossen');
    });

    it('lässt genau eine Nachkontrolle zu', async () => {
      const { id, vertragId } = await abgeschlosseneBegehung();

      const erste = await begehungAnlegen({
        contractId: vertragId,
        followUpOfId: id,
        inspectedAt: new Date().toISOString(),
        items: positionen(),
      });
      assert.equal(erste.status, 201, JSON.stringify(erste.payload));

      const zweite = await post(
        '/api/quality-inspections',
        {
          contractId: vertragId,
          followUpOfId: id,
          inspectedAt: new Date().toISOString(),
          items: positionen(),
        },
        { jar: jars.admin },
      );
      assert.equal(zweite.status, 422, 'Zwei Nachkontrollen zu einem Beleg wären zwei Korrekturen');
    });

    it('weist eine Nachkontrolle zu einem Entwurf ab (422)', async () => {
      const vertragId = await vertragMitZusage();
      const entwurf = await begehungAnlegen({
        contractId: vertragId,
        inspectedAt: new Date().toISOString(),
        items: positionen(),
      });

      const nachkontrolle = await post(
        '/api/quality-inspections',
        {
          contractId: vertragId,
          followUpOfId: data(entwurf).id,
          inspectedAt: new Date().toISOString(),
          items: positionen(),
        },
        { jar: jars.admin },
      );
      assert.equal(nachkontrolle.status, 422, 'Einen Entwurf korrigiert man, statt ihn nachzuholen');
    });

    /**
     * Eine Begehung, bei der nichts beurteilbar war, ist ein Beleg über
     * nichts — und die Zahl darauf (`null`) liesse sich von „null Punkte"
     * nicht unterscheiden, sobald jemand sie abschreibt.
     */
    it('schliesst eine Begehung ohne beurteilbare Position nicht ab (422)', async () => {
      const vertragId = await vertragMitZusage();
      const angelegt = await begehungAnlegen({
        contractId: vertragId,
        inspectedAt: new Date().toISOString(),
        items: [{ label: 'Keller — verschlossen', points: 0, maxPoints: 5, weight: 0, position: 0 }],
      });
      assert.equal(angelegt.status, 201, JSON.stringify(angelegt.payload));

      const abschluss = await post(
        `/api/quality-inspections/${data(angelegt).id}/complete`,
        {},
        { jar: jars.admin },
      );
      assert.equal(abschluss.status, 422);
    });

    it('schliesst eine Begehung ohne Positionen nicht ab (422)', async () => {
      const vertragId = await vertragMitZusage();
      const angelegt = await begehungAnlegen({
        contractId: vertragId,
        inspectedAt: new Date().toISOString(),
        items: [],
      });
      assert.equal(angelegt.status, 201, JSON.stringify(angelegt.payload));

      const abschluss = await post(
        `/api/quality-inspections/${data(angelegt).id}/complete`,
        {},
        { jar: jars.admin },
      );
      assert.equal(abschluss.status, 422);
    });
  });

  // -------------------------------------------------------------------------
  //  Der Massstab ist ein Schnappschuss
  // -------------------------------------------------------------------------

  describe('Der Massstab gilt vom Begehungstag', () => {
    it('hält die Fassung fest, die am Begehungstag galt', async () => {
      const vertragId = await vertragMitZusage({ targetQualityScore: 85 });

      const angelegt = await begehungAnlegen({
        contractId: vertragId,
        inspectedAt: new Date().toISOString(),
        items: positionen(),
      });
      assert.equal(angelegt.status, 201, JSON.stringify(angelegt.payload));
      const vorher = data(angelegt) as unknown as { contractVersionId: string; targetScore: number };
      assert.equal(vorher.targetScore, 85);

      // Eine zweite Fassung mit anderer Zusage.
      const neueFassung = await post(
        `/api/contracts/${vertragId}/versions`,
        {
          version: {
            effectiveFrom: tagIn(1),
            reason: 'Höhere Zusage ab dem nächsten Quartal',
            billingCycle: 'MONTHLY',
            paymentTermDays: 30,
            pricingModel: 'FIXED_PERIOD',
            baseAmount: 1200,
            vatRate: 8.1,
            noticePeriodDays: 90,
            renewalType: 'NONE',
            targetQualityScore: 95,
            inspectionIntervalDays: 90,
          },
        },
        { jar: jars.admin },
      );
      assert.equal(neueFassung.status, 201, JSON.stringify(neueFassung.payload));

      /*
        Die bestehende Begehung darf sich davon nicht rühren. Löste sie
        dynamisch auf „die derzeit geltende Zusage" auf, fiele sie nach jeder
        Vertragsänderung anders aus — und wäre kein Beleg.
      */
      const liste = await get<{ data: { id: string; targetScore: number; outcome: string }[] }>(
        `/api/quality-inspections?contractId=${vertragId}`,
        { jar: jars.admin },
      );
      assert.equal(liste.status, 200);
      const wieder = data(liste).find((b) => b.id === data(angelegt).id);
      assert.ok(wieder, 'Die Begehung steht weiterhin in der Liste');
      assert.equal(wieder!.targetScore, 85, 'unverändert die Zusage von damals');
      assert.equal(wieder!.outcome, 'KNAPP');
    });
  });

  // -------------------------------------------------------------------------
  //  Fälligkeit
  // -------------------------------------------------------------------------

  describe('Fälligkeit am Vertrag', () => {
    it('rechnet ab der letzten abgeschlossenen Begehung — ein Entwurf zählt nicht', async () => {
      const vertragId = await vertragMitZusage({ inspectionIntervalDays: 30 });

      const ohne = await get<{
        data: { intervallTage: number; zielwert: number; letzte: unknown; ueberfaellig: boolean };
      }>(`/api/contracts/${vertragId}/quality`, { jar: jars.admin });
      assert.equal(ohne.status, 200, JSON.stringify(ohne.payload));
      assert.equal(data(ohne).intervallTage, 30);
      assert.equal(data(ohne).zielwert, 85);
      assert.equal(data(ohne).letzte, null);
      assert.equal(data(ohne).ueberfaellig, true, 'Der Vertrag läuft seit 200 Tagen ohne Kontrolle');

      // Ein Entwurf ändert daran nichts.
      const entwurf = await begehungAnlegen({
        contractId: vertragId,
        inspectedAt: new Date().toISOString(),
        items: positionen(),
      });
      assert.equal(entwurf.status, 201);

      const mitEntwurf = await get<{ data: { letzte: unknown } }>(`/api/contracts/${vertragId}/quality`, {
        jar: jars.admin,
      });
      assert.equal(data(mitEntwurf).letzte, null, 'Ein Entwurf sagt, dass jemand begonnen hat — mehr nicht');

      // Nach dem Abschluss schon.
      const abschluss = await post(`/api/quality-inspections/${data(entwurf).id}/complete`, {}, { jar: jars.admin });
      assert.equal(abschluss.status, 200, JSON.stringify(abschluss.payload));

      const danach = await get<{
        data: { letzte: { prozent: number } | null; ueberfaellig: boolean; inTagen: number };
      }>(`/api/contracts/${vertragId}/quality`, { jar: jars.admin });
      assert.ok(data(danach).letzte, 'Jetzt gibt es eine letzte Kontrolle');
      assert.equal(data(danach).letzte!.prozent, 80);
      assert.equal(data(danach).ueberfaellig, false);
      assert.equal(data(danach).inTagen, 30, 'die nächste in dreissig Tagen');
    });

    it('kennt ohne vereinbartes Intervall keine Fälligkeit', async () => {
      const angelegt = await post<{ data: { id: string } }>(
        '/api/contracts',
        {
          contract: {
            customerId: kundeId,
            propertyId: objektId,
            title: `Ohne Zusage ${Date.now()}`,
            startDate: tagIn(-100),
          },
          version: {
            effectiveFrom: tagIn(-100),
            reason: 'Ohne Qualitätszusage',
            billingCycle: 'MONTHLY',
            paymentTermDays: 30,
            pricingModel: 'FIXED_PERIOD',
            baseAmount: 900,
            vatRate: 8.1,
            noticePeriodDays: 90,
            renewalType: 'NONE',
          },
          services: [
            {
              serviceId: leistungId,
              label: 'Unterhaltsreinigung',
              estimatedMinutes: 90,
              requiredCrewSize: 1,
              materialsBy: 'PROVIDER',
            },
          ],
        },
        { jar: jars.admin },
      );
      assert.equal(angelegt.status, 201, JSON.stringify(angelegt.payload));
      angelegteVertraege.push(data(angelegt).id);
      await post(`/api/contracts/${data(angelegt).id}/activate`, { effectiveFrom: tagIn(-100) }, { jar: jars.admin });

      const stand = await get<{ data: { intervallTage: number | null; faelligAm: string | null; ueberfaellig: boolean } }>(
        `/api/contracts/${data(angelegt).id}/quality`,
        { jar: jars.admin },
      );
      assert.equal(stand.status, 200, JSON.stringify(stand.payload));
      assert.equal(data(stand).intervallTage, null);
      assert.equal(data(stand).faelligAm, null, 'Ohne Zusage kein erfundener Termin');
      assert.equal(data(stand).ueberfaellig, false);
    });
  });

  // -------------------------------------------------------------------------
  //  Rechte und Sichtbarkeit
  // -------------------------------------------------------------------------

  describe('Rechte und Sichtbarkeit', () => {
    it('Mitarbeitende haben keinen Zugang (403)', async () => {
      assert.equal((await get('/api/quality-inspections', { jar: jars.employee })).status, 403);
      assert.equal(
        (
          await post(
            '/api/quality-inspections',
            { propertyId: objektId, inspectedAt: new Date().toISOString(), items: positionen() },
            { jar: jars.employee },
          )
        ).status,
        403,
      );
    });

    it('die Kundschaft sieht nur abgeschlossene Begehungen der eigenen Objekte', async () => {
      const vertragId = await vertragMitZusage();
      const entwurf = await begehungAnlegen({
        contractId: vertragId,
        inspectedAt: new Date().toISOString(),
        items: positionen(),
        internalNote: 'Intern: Team war unterbesetzt',
      });
      assert.equal(entwurf.status, 201);

      const liste = await get<{ data: { id: string; status: string }[] }>('/api/quality-inspections', {
        jar: jars.customer,
      });
      assert.equal(liste.status, 200, 'Der Kundenbereich darf die Liste öffnen');

      /*
        Geprüft an der Antwort, nicht am Statuscode: Eine Einschränkung, die
        nur die Anzeige betrifft, wäre auf der Leitung wirkungslos.
      */
      assert.deepEqual(
        data(liste).filter((b) => b.status !== 'COMPLETED').map((b) => b.id),
        [],
        'Kein Entwurf in der Antwort — eine halbe Begehung ist keine Feststellung',
      );
      assert.ok(
        !data(liste).some((b) => b.id === data(entwurf).id),
        'Der eben angelegte Entwurf ist für die Kundschaft nicht sichtbar',
      );

      const alsText = JSON.stringify(liste.payload);
      assert.ok(
        !alsText.includes('Team war unterbesetzt'),
        'Die interne Notiz steht nicht in der Antwort — nicht nur nicht in der Anzeige',
      );
    });

    it('die Kundschaft legt keine Begehung an (403)', async () => {
      const antwort = await post(
        '/api/quality-inspections',
        { propertyId: objektId, inspectedAt: new Date().toISOString(), items: positionen() },
        { jar: jars.customer },
      );
      assert.equal(antwort.status, 403);
    });
  });
});
