import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { BASE_URL, data, del, get, patch, post, put, requireServer } from '../helpers/client';
import { ACCOUNTS, loginAll, type AccountName } from '../helpers/accounts';
import { zuercherHeute } from '../helpers/datum';
import { letzteMail, linksIn, mailOutboxAvailable } from '../helpers/mail';
import {
  eigeneOrganisationId,
  lohnBelegeEntfernen,
  schutzfreiAufraeumen,
  testDb,
  testDbGrund,
  testDbSchliessen,
} from '../helpers/testdb';
import { PRUEF_AUSFUEHRER_SCHLUESSEL, PRUEF_AUSFUEHRER_TOKEN } from '../helpers/webhooks';
import { SIGNATUR_KOPF, ZEIT_KOPF, signieren } from '../../src/lib/release/ausfuehrer-signatur';

/**
 * Geschäftsabläufe von Anfang bis Ende — sieben Wege, je ein `describe`, je
 * Schritt ein `it`, und jeder Schritt arbeitet mit dem Ergebnis des vorigen.
 *
 * ---------------------------------------------------------------------------
 *  Warum es diese Datei neben den Fachreihen gibt
 * ---------------------------------------------------------------------------
 *
 * Jede Fachreihe prüft ihren Abschnitt gründlich — `offertannahme` die
 * Annahme, `vertraege` den Planer, `zeiterfassung` die Freigabe,
 * `lohnabrechnung` den Lauf. Was keine von ihnen prüft, ist die **Naht**
 * zwischen den Abschnitten: dass die angenommene Offerte tatsächlich einen
 * Vertrag trägt, dass der Einsatz aus diesem Vertrag zugeteilt, gestempelt,
 * abgeschlossen und auf genau der Rechnung landet, die danach bezahlt wird.
 * Solche Nähte brechen still: Jede Hälfte ist grün, und der Weg dazwischen
 * führt ins Leere. Genau das ist in diesem Projekt schon passiert (der
 * versendete Offertlink aus Gate 1, der auf eine 404-Seite führte).
 *
 * Deshalb nimmt hier jeder Schritt den **tatsächlichen** Ausgang des vorigen
 * — keine vorbereitete Zeile aus der Datenbank, kein gesetzter Status. Die
 * Datenbank dient nur zum Aufräumen, zum Nachschlagen von Stammdaten und für
 * Aussagen, die über HTTP nicht zu beobachten sind (Prüfprotokoll, Scanstand
 * einer Datei, Hash statt Rohwert).
 *
 * ---------------------------------------------------------------------------
 *  Was hier ausdrücklich **nicht** vorgetäuscht wird
 * ---------------------------------------------------------------------------
 *
 *  • Zahlungen laufen über die Zahlungserfassung des Büros
 *    (`POST /api/invoices/:id/payments`), nicht über einen erfundenen
 *    Stripe-Erfolg. Ein Webhook ohne echten Anbieter bewiese nur, dass der
 *    Test sich selbst glaubt.
 *  • Links kommen aus dem Postausgang des Testservers (`helpers/mail.ts`) —
 *    nie ein selbst gelegter Ersatztoken. Ohne Postausgang überspringen sich
 *    die betroffenen Wege, wie in `offertannahme.test.ts`.
 *  • Die Schadsoftwareprüfung ist der deterministische Prüfer, den der
 *    Testserver ohnehin fährt (`src/lib/security/malware/test-scanner.ts`).
 *  • Fällig wird ein Release-Auftrag wie in `release-center.test.ts`: Der
 *    Termin wird über die Oberfläche gesetzt und danach in der Testdatenbank
 *    in die Vergangenheit gelegt — die Oberfläche lässt zu Recht keinen
 *    Termin in der Vergangenheit zu, und fünfzehn Minuten warten wäre keine
 *    Prüfung, sondern ein Schlaf.
 *
 * ---------------------------------------------------------------------------
 *  Aufräumen
 * ---------------------------------------------------------------------------
 *
 * Jeder Weg räumt vor und nach sich auf, auch Reste abgebrochener Läufe
 * (gefunden über eine Marke im Titel, in der Notiz oder im Schlüssel, nicht
 * über die Laufnummer). Was die Anwendung zu Recht nicht löschen lässt —
 * ausgestellte Rechnungen, Zahlungen, veröffentlichte Lohnabrechnungen,
 * abgeschlossene Begehungen —, entfernt `schutzfreiAufraeumen` an den
 * Triggern vorbei, wie in `finanzbelege.test.ts` und
 * `buchung-integritaet.test.ts`. Zwei Dinge bleiben bewusst liegen, weil
 * ihre Unveränderlichkeit der Gegenstand anderer Reihen ist: ein Vertrag, der
 * in Kraft war (er wird beendet, nicht gelöscht — `vertraege.test.ts`), und
 * die angenommene Offerte samt Unterzeichnungsvorgang (Ereignisse sind nicht
 * löschbar — `offertannahme.test.ts`).
 */

const RUN = Date.now();
const db = testDb();

/** Die gemeinsame Marke — jeder Weg hängt seinen Buchstaben an. */
const MARKE = 'Prüfreihe Geschäftsabläufe';
const MARKE_A = `${MARKE} A`;
const MARKE_C = `${MARKE} C`;
const MARKE_E = `${MARKE} E`;

const ohneDb = db ? false : `Keine Testdatenbank: ${testDbGrund()}`;
const ohnePost = !db
  ? `Keine Testdatenbank: ${testDbGrund()}`
  : mailOutboxAvailable()
    ? false
    : 'Kein Postausgang — Testserver ohne CLENARIS_TEST_CACHE_DIR gestartet.';

let jars: Record<AccountName, string>;

/** Stammdaten aus dem Demobestand — gelesen, nie verändert. */
const stamm = { org: '', customerId: '', addressId: '', propertyId: '', serviceId: '', annaId: '', superId: '' };

// ---------------------------------------------------------------------------
//  Werkzeuge
// ---------------------------------------------------------------------------

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// Der Zürcher Kalendertag, wie ihn die Dienste nehmen (`tests/helpers/datum.ts`).
const heute = zuercherHeute();
const tagIn = (tage: number) =>
  new Date(Date.UTC(heute.getUTCFullYear(), heute.getUTCMonth(), heute.getUTCDate() + tage)).toISOString().slice(0, 10);

/**
 * Der Zürcher Kalendertag eines Zeitpunkts. Nicht `toISOString()`: Ein
 * Einsatz um 00:30 Ortszeit läge in UTC am Vortag, und die Vertragsperiode
 * dazu wäre die falsche.
 */
const zuercherTag = (zeitpunkt: string | Date) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Zurich' }).format(new Date(zeitpunkt));

/** Bytes einer Antwort — für PDF-Signaturen und Prüfsummen, nicht als Text. */
async function bytesVon(pfad: string, jar?: string) {
  const antwort = await fetch(`${BASE_URL}${pfad}`, { headers: jar ? { cookie: jar } : {} });
  return {
    status: antwort.status,
    bytes: Buffer.from(await antwort.arrayBuffer()),
    typ: antwort.headers.get('content-type') ?? '',
  };
}

/** Den Offert-Token aus der tatsächlich versendeten Nachricht — wie `offertannahme.test.ts`. */
function offertTokenAusPost(quoteId: string): string | null {
  const mail = letzteMail({ entityId: quoteId });
  if (!mail) return null;
  for (const link of linksIn(mail)) {
    const treffer = /\/offerte\/([0-9a-f]{64})(?:$|[?#])/.exec(link);
    if (treffer) return treffer[1]!;
  }
  return null;
}

/**
 * Ausgestellte Rechnungen samt Zahlungen entfernen — an den Triggern vorbei.
 *
 * Unter `session_replication_role = 'replica'` greifen auch die Kaskaden
 * nicht; Positionen, Zahlungen, Gutschriften, Mahnungen und das beim
 * Ausstellen abgelegte PDF werden deshalb einzeln entfernt. Den Kundenwert,
 * den eine verbuchte Zahlung erhöht hat, setzt die Prüfung danach zurück —
 * derselbe Ausgleich wie in `finanzbelege.test.ts`.
 */
async function rechnungenEntfernen(ids: string[]): Promise<void> {
  if (!db || ids.length === 0) return;
  const zahlungen = await db.payment.findMany({
    where: { invoiceId: { in: ids }, status: 'SUCCEEDED' },
    select: { amount: true, invoice: { select: { customerId: true } } },
  });
  const assets = await db.fileAsset.findMany({ where: { invoiceId: { in: ids } }, select: { id: true, storedFileId: true } });
  await schutzfreiAufraeumen(async (tx) => {
    await tx.payment.deleteMany({ where: { invoiceId: { in: ids } } });
    await tx.creditNote.deleteMany({ where: { invoiceId: { in: ids } } });
    await tx.paymentReminder.deleteMany({ where: { invoiceId: { in: ids } } });
    await tx.invoiceItem.deleteMany({ where: { invoiceId: { in: ids } } });
    await tx.fileAsset.deleteMany({ where: { id: { in: assets.map((a) => a.id) } } });
    const abgelegt = assets.map((a) => a.storedFileId).filter((x): x is string => Boolean(x));
    if (abgelegt.length > 0) await tx.storedFile.deleteMany({ where: { id: { in: abgelegt } } });
    await tx.invoice.deleteMany({ where: { id: { in: ids } } });
  });
  const jeKunde = new Map<string, number>();
  for (const z of zahlungen) {
    const kunde = z.invoice?.customerId;
    if (!kunde) continue;
    jeKunde.set(kunde, (jeKunde.get(kunde) ?? 0) + Number(z.amount));
  }
  for (const [kunde, betrag] of jeKunde) {
    await db.customer
      .update({ where: { id: kunde }, data: { lifetimeValue: { decrement: betrag } } })
      .catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
//  Vorbereitung
// ---------------------------------------------------------------------------

before(async () => {
  await requireServer();
  jars = await loginAll();
  if (!db) return;

  stamm.org = (await eigeneOrganisationId()) ?? '';
  assert.ok(stamm.org, 'die eigene Organisation fehlt — `npm run db:test:setup`?');

  /**
   * Ein Objekt **mit Adresse** und seine Kundschaft — wie
   * `tests/e2e/helpers/bestand.ts`. Ohne Adresse entstünde aus dem Vertrag
   * ein Einsatz ohne Ort, und Rapport wie Stempelnachweis prüften einen
   * Sonderfall statt des Alltags.
   */
  const objekte = data(
    await get<{ data: { id: string; address: { id: string } | null; customer: { id: string } }[] }>('/api/properties', {
      jar: jars.admin,
    }),
  );
  const mitAdresse = objekte.find((o) => o.address !== null);
  assert.ok(mitAdresse, 'der Demobestand enthält kein Objekt mit Adresse');
  stamm.customerId = mitAdresse.customer.id;
  stamm.addressId = mitAdresse.address!.id;
  stamm.propertyId = mitAdresse.id;

  stamm.serviceId = data(await get<{ data: { id: string }[] }>('/api/services', { jar: jars.admin }))[0]!.id;

  const personal = data(
    await get<{ data: { id: string; user: { email: string } }[] }>('/api/employees', { jar: jars.admin }),
  );
  stamm.annaId = personal.find((p) => p.user.email === ACCOUNTS.employee.email)?.id ?? '';
  assert.ok(stamm.annaId, `keine Personalakte zu ${ACCOUNTS.employee.email}`);

  stamm.superId = (await db.user.findUniqueOrThrow({ where: { email: ACCOUNTS.super.email }, select: { id: true } })).id;
});

after(async () => {
  await testDbSchliessen();
});

// ===========================================================================
//  A — Anfrage → Offerte → Annahme → Vertrag → Einsatz → Rechnung → bezahlt
// ===========================================================================

async function ablaufAAufraeumen(): Promise<void> {
  if (!db) return;
  const vertraege = await db.contract.findMany({
    where: { title: { startsWith: MARKE_A } },
    select: { id: true, status: true },
  });
  const vertragIds = vertraege.map((v) => v.id);
  const rechnungen = await db.invoice.findMany({ where: { contractId: { in: vertragIds } }, select: { id: true } });
  await rechnungenEntfernen(rechnungen.map((r) => r.id));

  /**
   * Eine abgeschlossene Begehung ist ein Beleg und lässt sich über die
   * Anwendung nicht verwerfen (`qualitaet.test.ts`); die Zeiten der
   * Mitarbeiterin tragen die Marke in der Notiz, die beim Stempeln
   * mitgegeben wurde.
   */
  await schutzfreiAufraeumen(async (tx) => {
    const begehungen = await tx.qualityInspection.findMany({ where: { note: MARKE_A }, select: { id: true } });
    const ids = begehungen.map((b) => b.id);
    await tx.qualityInspectionItem.deleteMany({ where: { inspectionId: { in: ids } } });
    await tx.qualityInspection.deleteMany({ where: { id: { in: ids } } });
    await tx.timeEntry.deleteMany({ where: { note: MARKE_A } });
  });

  // Ein Vertrag, der in Kraft war, wird beendet, nicht gelöscht — `vertraege.test.ts`.
  for (const v of vertraege) {
    if (v.status === 'ENDED' || v.status === 'CANCELLED') continue;
    const geloescht = await del(`/api/contracts/${v.id}`, { jar: jars.admin }).catch(() => null);
    if (geloescht?.status === 204) continue;
    await post(`/api/contracts/${v.id}/end`, { reason: 'Aufräumen der Prüfreihe Geschäftsabläufe' }, { jar: jars.admin }).catch(
      () => undefined,
    );
  }

  /**
   * Die Anfrage in den Papierkorb — über die Anwendung, nicht hart gelöscht:
   * An ihr hängt die angenommene Offerte, und die bleibt samt Vorgang stehen.
   */
  const anfragen = await db.lead.findMany({ where: { company: MARKE_A, deletedAt: null }, select: { id: true } });
  for (const anfrage of anfragen) await del(`/api/leads/${anfrage.id}`, { jar: jars.admin }).catch(() => undefined);
}

describe('A — Anfrage, Offerte, Vertrag, Einsatz, Rechnung, Zahlung', { concurrency: 1, skip: ohnePost }, () => {
  const s = {
    leadId: '',
    quoteId: '',
    token: '',
    contractId: '',
    contractServiceId: '',
    versionId: '',
    jobId: '',
    jobTag: '',
    timeEntryId: '',
    inspectionId: '',
    invoiceId: '',
    brutto: 0,
  };

  before(ablaufAAufraeumen);
  after(ablaufAAufraeumen);

  it('1. eine telefonische Anfrage wird erfasst', async () => {
    const antwort = await post<{ data: { id: string } }>(
      '/api/leads',
      {
        firstName: 'Ablauf',
        lastName: `Anfrage${RUN}`,
        email: `pruef.ablauf.${RUN}@example.ch`,
        company: MARKE_A,
        serviceKind: 'OFFICE_CLEANING',
        message: 'Büro 120 m², Unterhaltsreinigung gewünscht.',
        source: 'PHONE',
        tagIds: [],
      },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 201, antwort.text);
    s.leadId = data(antwort).id;
  });

  it('2. die Pipeline-Stufe wechselt auf „Qualifiziert" — und der Status folgt der Stufe', async () => {
    assert.ok(s.leadId, 'Schritt 1 hat keine Anfrage angelegt');
    const stufe = await db!.pipelineStage.findFirst({ where: { organizationId: stamm.org, key: 'qualified' }, select: { id: true } });
    assert.ok(stufe, 'Vorbedingung: die Standardstufe „qualified" der eigenen Organisation');

    const antwort = await patch<{ data: { status: string; stageId: string } }>(
      `/api/leads/${s.leadId}`,
      { stageId: stufe.id },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 200, antwort.text);
    assert.equal(data(antwort).stageId, stufe.id);
    assert.equal(data(antwort).status, 'QUALIFIED', 'die Stufe bestimmt den Status, nicht die Maske');
  });

  it('3. eine Offerte zur Anfrage hebt sie in die Angebotsphase', async () => {
    assert.ok(s.leadId);
    const antwort = await post<{ data: { id: string } }>(
      '/api/quotes',
      {
        customerId: stamm.customerId,
        leadId: s.leadId,
        propertyId: stamm.propertyId,
        title: `${MARKE_A} ${RUN}`,
        validUntil: tagIn(30),
        items: [{ name: 'Unterhaltsreinigung je Einsatz', quantity: 1, unit: 'Einsatz', unitPrice: 180, discount: 0, vatRate: 8.1, optional: false }],
        discountValue: 0,
      },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 201, antwort.text);
    s.quoteId = data(antwort).id;

    const anfrage = await db!.lead.findUniqueOrThrow({ where: { id: s.leadId }, select: { status: true } });
    assert.equal(anfrage.status, 'PROPOSAL');
  });

  it('4. der Versand verschickt einen Link, der die Offerte öffnet', async () => {
    assert.ok(s.quoteId);
    const versand = await post(`/api/quotes/${s.quoteId}/send`, { attachPdf: true }, { jar: jars.admin });
    assert.equal(versand.status, 200, versand.text);

    const token = offertTokenAusPost(s.quoteId);
    assert.ok(token, 'im Postausgang liegt keine Nachricht mit einem Offertlink');
    s.token = token;

    assert.equal((await get(`/offerte/${s.token}`)).status, 200, 'der versendete Link öffnet die Offerte');
  });

  it('5. die Kundschaft nimmt über den versendeten Link an — erst die Unterzeichnung entscheidet', async () => {
    assert.ok(s.token);
    const start = await post<{ data: { requiresSignature: boolean; signatureUrl?: string } }>(
      `/api/public/quotes/${s.token}/respond`,
      { decision: 'ACCEPT' },
    );
    assert.equal(start.status, 200, start.text);
    assert.equal(data(start).requiresSignature, true);
    const roh = /^\/signieren#t=([0-9a-f]{64})$/.exec(data(start).signatureUrl ?? '')?.[1];
    assert.ok(roh, `unerwartete Signaturadresse: ${data(start).signatureUrl}`);

    const vorher = data(await get<{ data: { status: string } }>(`/api/quotes/${s.quoteId}`, { jar: jars.admin }));
    assert.notEqual(vorher.status, 'ACCEPTED', 'der Start allein nimmt nicht an');

    const tausch = await post<{ data: { publicId: string } }>('/api/public/signatures/exchange', { token: roh });
    assert.equal(tausch.status, 200, tausch.text);
    const fertig = await post<{ data: { requestStatus: string } }>(
      `/api/public/signatures/${data(tausch).publicId}/complete`,
      { accepted: true, method: 'TYPED', name: 'Ablauf Anfrage' },
      { jar: tausch.cookies },
    );
    assert.equal(fertig.status, 200, fertig.text);
    assert.equal(data(fertig).requestStatus, 'COMPLETED');

    const nachher = data(await get<{ data: { status: string } }>(`/api/quotes/${s.quoteId}`, { jar: jars.admin }));
    assert.equal(nachher.status, 'ACCEPTED');
    const anfrage = await db!.lead.findUniqueOrThrow({ where: { id: s.leadId }, select: { status: true } });
    assert.equal(anfrage.status, 'WON', 'die angenommene Offerte gewinnt die Anfrage');
  });

  it('6. aus der angenommenen Offerte entsteht ein Vertrag', async () => {
    assert.ok(s.quoteId);
    /**
     * Abrechnung **je Einsatz**: Nur so landet der Einsatz, der in diesem
     * Weg gestempelt und abgeschlossen wird, als eigene Position auf der
     * Rechnung — bei einer Pauschale stünde er bloss in der Herleitung, und
     * die Naht Einsatz → Rechnung bliebe ungeprüft.
     */
    const antwort = await post<{ data: { id: string } }>(
      '/api/contracts',
      {
        contract: {
          customerId: stamm.customerId,
          propertyId: stamm.propertyId,
          quoteId: s.quoteId,
          title: `${MARKE_A} ${RUN}`,
          startDate: tagIn(0),
        },
        version: {
          effectiveFrom: tagIn(0),
          reason: 'Erstfassung aus der angenommenen Offerte',
          billingCycle: 'MONTHLY',
          paymentTermDays: 30,
          pricingModel: 'FIXED_PER_VISIT',
          baseAmount: 180,
          vatRate: 8.1,
          noticePeriodDays: 90,
          renewalType: 'NONE',
          targetQualityScore: 85,
          inspectionIntervalDays: 90,
        },
        services: [
          { serviceId: stamm.serviceId, label: 'Unterhaltsreinigung Büro', estimatedMinutes: 60, requiredCrewSize: 1, materialsBy: 'PROVIDER' },
        ],
      },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 201, antwort.text);
    s.contractId = data(antwort).id;

    const akte = data(
      await get<{ data: { status: string; versions: { id: string; services: { id: string }[] }[] } }>(`/api/contracts/${s.contractId}`, {
        jar: jars.admin,
      }),
    );
    assert.equal(akte.status, 'DRAFT');
    s.versionId = akte.versions[0]!.id;
    s.contractServiceId = akte.versions[0]!.services[0]!.id;

    const zeile = await db!.contract.findUniqueOrThrow({ where: { id: s.contractId }, select: { quoteId: true } });
    assert.equal(zeile.quoteId, s.quoteId, 'der Vertrag kennt seine Offerte');
  });

  it('7. der Einsatzplan entsteht auf dem Entwurf', async () => {
    assert.ok(s.contractServiceId);
    /**
     * Täglich und um 14:00 Zürcher Zeit: Jeder Tag trägt einen Termin, und
     * die Uhrzeit liegt weit weg von Mitternacht — die Vertragsperiode wird
     * am Zürcher Kalendertag geschnitten, und ein Termin um 00:30 hätte die
     * Rechnung vom Datum der Prüfung abhängig gemacht.
     */
    const plan = await post(
      `/api/contract-services/${s.contractServiceId}/schedules`,
      {
        frequency: 'WEEKLY',
        interval: 1,
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        startMinute: 840,
        endMinute: 900,
        effectiveFrom: tagIn(0),
        holidayHandling: 'IGNORE',
        active: true,
      },
      { jar: jars.admin },
    );
    assert.equal(plan.status, 201, plan.text);
  });

  it('8. in Kraft gesetzt, erzeugt der Planer die Einsätze der Serie', async () => {
    assert.ok(s.contractId);
    const aktiv = await post<{ data: { status: string; number: string } }>(`/api/contracts/${s.contractId}/activate`, {}, { jar: jars.admin });
    assert.equal(aktiv.status, 200, aktiv.text);
    assert.equal(data(aktiv).status, 'ACTIVE');
    assert.match(data(aktiv).number, /^VT-/, 'die Vertragsnummer entsteht beim Aktivieren');

    const lauf = await post<{ data: { angelegt: number } }>(`/api/contracts/${s.contractId}/schedule`, { bis: tagIn(3) }, { jar: jars.admin });
    assert.equal(lauf.status, 200, lauf.text);
    assert.ok(data(lauf).angelegt > 0, 'der Planer hat keinen Einsatz erzeugt');

    const einsaetze = data(
      await get<{ data: { id: string; contractVersionId: string | null }[] }>(`/api/jobs?contractId=${s.contractId}&pageSize=100`, {
        jar: jars.admin,
      }),
    );
    assert.ok(einsaetze.length > 0);
    assert.ok(einsaetze.every((e) => e.contractVersionId === s.versionId), 'jeder Einsatz trägt die geltende Fassung');
  });

  it('9. ein Einsatz wird der Mitarbeiterin zugeteilt', async () => {
    assert.ok(s.contractId);
    const einsaetze = data(
      await get<{ data: { id: string; scheduledStart: string; status: string }[] }>(
        `/api/jobs?contractId=${s.contractId}&pageSize=100`,
        { jar: jars.admin },
      ),
    )
      .filter((e) => e.status !== 'CANCELLED')
      .sort((x, y) => x.scheduledStart.localeCompare(y.scheduledStart));

    /**
     * Der erste Einsatz, den die Eignungsprüfung zulässt. Die Demo-
     * Mitarbeiterin hat eigene Einsätze im Bestand; überschneidet sich einer
     * davon, weist `assignment.service.ts` die Zuteilung zu Recht ab — das
     * ist die Regel, nicht ein Fehler dieses Wegs. Also der nächste Tag.
     */
    let letzte = '';
    for (const einsatz of einsaetze) {
      const zuteilung = await post(`/api/jobs/${einsatz.id}/assign`, { employeeIds: [stamm.annaId], notify: false }, { jar: jars.admin });
      if (zuteilung.status === 200) {
        s.jobId = einsatz.id;
        s.jobTag = zuercherTag(einsatz.scheduledStart);
        break;
      }
      letzte = `${zuteilung.status} ${zuteilung.text}`;
    }
    assert.ok(s.jobId, `kein Einsatz der Serie liess sich zuteilen — zuletzt: ${letzte}`);

    // Die Einzelansicht prüft die Zuteilung in der Abfrage — vorher wäre sie 404.
    const eigener = await get(`/api/jobs/${s.jobId}`, { jar: jars.employee });
    assert.equal(eigener.status, 200, 'die Mitarbeiterin sieht den zugeteilten Einsatz');
  });

  it('10. die Mitarbeiterin stempelt ein und aus', async () => {
    assert.ok(s.jobId);
    /**
     * Über ihre eigene Sitzung, nicht über die Verwaltung: `clock-in` prüft
     * die Zuteilung gegen `session.profileId`. Die Marke steht in der Notiz,
     * damit ein abgebrochener Lauf keine offene Erfassung hinterlässt, die
     * das nächste Einstempeln blockiert.
     */
    const ein = await post<{ data: { timeEntryId: string } }>('/api/time/clock-in', { jobId: s.jobId, note: MARKE_A }, { jar: jars.employee });
    assert.equal(ein.status, 201, ein.text);
    s.timeEntryId = data(ein).timeEntryId;

    const aus = await post<{ data: { minutes: number } }>('/api/time/clock-out', { jobId: s.jobId, note: MARKE_A }, { jar: jars.employee });
    assert.equal(aus.status, 200, aus.text);
    assert.ok(data(aus).minutes >= 0, 'die Dauer rechnet der Server');

    const einsatz = data(
      await get<{ data: { status: string; timeEntries: { id: string; endedAt: string | null }[] } }>(`/api/jobs/${s.jobId}`, {
        jar: jars.employee,
      }),
    );
    assert.equal(einsatz.status, 'IN_PROGRESS', 'das Einstempeln startet den Einsatz');
    const eintrag = einsatz.timeEntries.find((t) => t.id === s.timeEntryId);
    assert.ok(eintrag?.endedAt, 'die Erfassung ist abgeschlossen und hängt am Einsatz');
  });

  it('11. Abschluss durch die Mitarbeiterin, danach der Rapport als PDF', async () => {
    assert.ok(s.jobId);
    const abschluss = await post<{ data: { status: string } }>(
      `/api/jobs/${s.jobId}/complete`,
      { completionNote: 'Alle Räume gereinigt, Abfall entsorgt.', materials: [] },
      { jar: jars.employee },
    );
    assert.equal(abschluss.status, 200, abschluss.text);
    assert.equal(data(abschluss).status, 'COMPLETED');

    const rapport = await bytesVon(`/api/jobs/${s.jobId}/report`, jars.admin);
    assert.equal(rapport.status, 200);
    assert.ok(rapport.typ.includes('application/pdf'), rapport.typ);
    assert.equal(rapport.bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'der Rapport ist ein PDF, keine Fehlerseite');
  });

  it('12. die Qualitätsprüfung zum Einsatz misst gegen die Zusage der Fassung', async () => {
    assert.ok(s.jobId);
    const angelegt = await post<{ data: { id: string; scorePercent: string; targetScore: number; outcome: string; status: string } }>(
      '/api/quality-inspections',
      {
        contractId: s.contractId,
        jobId: s.jobId,
        inspectedAt: new Date().toISOString(),
        note: MARKE_A,
        items: [
          { label: 'Arbeitsplätze', points: 5, maxPoints: 5, weight: 1, position: 0 },
          { label: 'Sanitärbereiche', points: 5, maxPoints: 5, weight: 1, position: 1 },
        ],
      },
      { jar: jars.admin },
    );
    assert.equal(angelegt.status, 201, angelegt.text);
    s.inspectionId = data(angelegt).id;
    assert.equal(Number(data(angelegt).scorePercent), 100, 'der Server rechnet aus den Positionen');
    assert.equal(data(angelegt).targetScore, 85, 'der Zielwert kommt aus der Vertragsfassung');
    assert.equal(data(angelegt).outcome, 'BESTANDEN');

    const abschluss = await post<{ data: { number: string; status: string } }>(
      `/api/quality-inspections/${s.inspectionId}/complete`,
      {},
      { jar: jars.admin },
    );
    assert.equal(abschluss.status, 200, abschluss.text);
    assert.equal(data(abschluss).status, 'COMPLETED');
    assert.match(data(abschluss).number, /^QK-/);
  });

  it('13. die Vertragsrechnung führt genau den abgeschlossenen Einsatz', async () => {
    assert.ok(s.jobTag);
    const antwort = await post<{ data: { invoiceId: string; number: string; status: string; netto: number; brutto: number; neu: boolean } }>(
      `/api/contracts/${s.contractId}/invoices`,
      { stichtag: s.jobTag, sofortAusstellen: true },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 201, antwort.text);
    const rechnung = data(antwort);
    s.invoiceId = rechnung.invoiceId;
    s.brutto = rechnung.brutto;
    assert.equal(rechnung.neu, true);
    assert.match(rechnung.number, /^RE-/, 'ausgestellt heisst: Nummer aus dem Nummernkreis');
    assert.equal(rechnung.netto, 180, 'ein abgeschlossener Einsatz × CHF 180 — die übrigen Termine sind nicht erbracht');
    assert.equal(rechnung.brutto, 194.58, '180 + 8,1 % MWST');

    const positionen = await db!.invoiceItem.findMany({ where: { invoiceId: s.invoiceId }, select: { jobId: true } });
    assert.deepEqual(
      positionen.map((p) => p.jobId),
      [s.jobId],
      'die Position verweist auf den Einsatz, aus dem sie entstand',
    );
  });

  it('14. die Zahlung wird im Büro erfasst — der Saldo ist null', async () => {
    assert.ok(s.invoiceId);
    const zahlung = await post<{ data: { status: string; balance: string | number; fullyPaid: boolean } }>(
      `/api/invoices/${s.invoiceId}/payments`,
      { amount: s.brutto, method: 'BANK_TRANSFER', reference: `${MARKE_A} ${RUN}` },
      { jar: jars.admin },
    );
    assert.equal(zahlung.status, 201, zahlung.text);
    assert.equal(data(zahlung).fullyPaid, true);
    assert.equal(data(zahlung).status, 'PAID');

    const liste = data(
      await get<{ data: { id: string; status: string; balance: string; paidAmount: string }[] }>(
        `/api/invoices?contractId=${s.contractId}&pageSize=10`,
        { jar: jars.admin },
      ),
    );
    const rechnung = liste.find((r) => r.id === s.invoiceId);
    assert.ok(rechnung, 'die Rechnung erscheint beim Vertrag');
    assert.equal(rechnung.status, 'PAID');
    assert.equal(Number(rechnung.balance), 0, 'Saldo 0');
    assert.equal(Number(rechnung.paidAmount), s.brutto);
  });
});

// ===========================================================================
//  B — öffentliche Buchung mit mehreren Leistungen bis zur bezahlten Rechnung
// ===========================================================================

const GAST_PRAEFIX = 'ablauf.gast.';
const LEISTUNG_PRAEFIX = 'ablauf-';

async function ablaufBAufraeumen(): Promise<void> {
  if (!db) return;
  const leistungen = (await db.service.findMany({ where: { slug: { startsWith: LEISTUNG_PRAEFIX } }, select: { id: true } })).map((x) => x.id);
  const kunden = (await db.customer.findMany({ where: { email: { startsWith: GAST_PRAEFIX } }, select: { id: true } })).map((x) => x.id);
  const buchungen = (
    await db.booking.findMany({
      where: { OR: [{ items: { some: { serviceId: { in: leistungen } } } }, { customerId: { in: kunden } }] },
      select: { id: true },
    })
  ).map((x) => x.id);
  const einsaetze = (await db.job.findMany({ where: { bookingId: { in: buchungen } }, select: { id: true } })).map((x) => x.id);
  const rechnungen = (
    await db.invoice.findMany({
      where: { OR: [{ customerId: { in: kunden } }, { items: { some: { jobId: { in: einsaetze } } } }] },
      select: { id: true },
    })
  ).map((x) => x.id);

  await rechnungenEntfernen(rechnungen);
  // Dieselbe Reihenfolge wie `buchung-integritaet.test.ts` — die Kaskaden greifen unter `replica` nicht.
  await schutzfreiAufraeumen(async (tx) => {
    await tx.timeEntry.deleteMany({ where: { jobId: { in: einsaetze } } });
    await tx.jobChecklistItem.deleteMany({ where: { jobId: { in: einsaetze } } });
    await tx.jobAssignment.deleteMany({ where: { jobId: { in: einsaetze } } });
    await tx.activity.deleteMany({ where: { jobId: { in: einsaetze } } });
    await tx.job.deleteMany({ where: { id: { in: einsaetze } } });
    await tx.bookingItem.deleteMany({ where: { bookingId: { in: buchungen } } });
    await tx.bookingExtra.deleteMany({ where: { bookingId: { in: buchungen } } });
    await tx.activity.deleteMany({ where: { bookingId: { in: buchungen } } });
    await tx.publicAccessToken.deleteMany({ where: { resourceId: { in: buchungen } } });
    await tx.booking.deleteMany({ where: { id: { in: buchungen } } });
    await tx.address.deleteMany({ where: { customerId: { in: kunden } } });
    await tx.activity.deleteMany({ where: { customerId: { in: kunden } } });
    await tx.customer.deleteMany({ where: { id: { in: kunden } } });
    await tx.service.deleteMany({ where: { id: { in: leistungen } } });
  });
}

describe('B — öffentliche Buchung mit zwei Leistungen bis „bezahlt"', { concurrency: 1, skip: ohneDb }, () => {
  const s = {
    buero: '',
    fenster: '',
    start: '',
    bookingId: '',
    customerId: '',
    jobId: '',
    invoiceId: '',
  };
  const leistungen = () => [
    { serviceId: s.buero, extras: [] },
    { serviceId: s.fenster, extras: [] },
  ];

  before(async () => {
    await ablaufBAufraeumen();
    /**
     * Zwei eigene Leistungen mit festen Dauern, direkt in der Testdatenbank —
     * dasselbe Vorgehen wie `mehrere-leistungen.test.ts`. Der Katalog des
     * Demobestands rechnet teils nach Fläche; eine Prüfung, deren Dauer an
     * der Katalogpflege hängt, prüfte die Katalogpflege.
     */
    const anlegen = async (schluessel: string, kind: string) =>
      (
        await db!.service.create({
          data: {
            organizationId: stamm.org,
            slug: `${LEISTUNG_PRAEFIX}${schluessel}-${RUN}`,
            kind: kind as never,
            name: `Ablauf ${schluessel} ${RUN}`,
            shortDesc: 'Prüfleistung',
            description: 'Nur für die Prüfreihe Geschäftsabläufe.',
            pricingModel: 'PER_HOUR',
            hourlyRate: 60,
            basePrice: 0,
            minPrice: 0,
            minHours: 1,
            defaultDurationMin: 60,
            minutesPerSqm: 0,
            defaultCrewSize: 1,
            bufferMinutes: 0,
            vatRate: 8.1,
          },
        })
      ).id;
    s.buero = await anlegen('buero', 'OFFICE_CLEANING');
    s.fenster = await anlegen('fenster', 'WINDOW_CLEANING');
  });
  after(ablaufBAufraeumen);

  it('1. der Preis zweier Leistungen kommt vom Server, Zeile für Zeile', async () => {
    const antwort = await post<{ data: { durationMinutes: number; grossTotal: number; positionen: { serviceId: string }[] } }>(
      '/api/public/pricing/estimate',
      { leistungen: leistungen() },
    );
    assert.equal(antwort.status, 200, antwort.text);
    assert.equal(data(antwort).durationMinutes, 120, 'die Dauer ist die Summe beider Leistungen');
    assert.deepEqual(data(antwort).positionen.map((p) => p.serviceId), [s.buero, s.fenster]);
    assert.ok(data(antwort).grossTotal > 0);
  });

  it('2. die Verfügbarkeit nennt einen buchbaren Termin für beide zusammen', async () => {
    const antwort = await post<{ data: { dauerMin: number; tage: { date: string; available: boolean; slots: { start: string; available: boolean }[] }[] } }>(
      '/api/public/availability',
      { leistungen: leistungen(), von: tagIn(7), tage: 21 },
    );
    assert.equal(antwort.status, 200, antwort.text);
    assert.equal(data(antwort).dauerMin, 120);
    const slot = data(antwort)
      .tage.filter((t) => t.available)
      .flatMap((t) => t.slots)
      .find((x) => x.available);
    assert.ok(slot, 'in drei Wochen ab nächster Woche kein freies Zeitfenster — Einsatzzeiten befüllt?');
    s.start = slot.start;
  });

  it('3. die Gastbuchung legt Buchung und Kundschaft an', async () => {
    assert.ok(s.start);
    const antwort = await post<{ data: { id: string; number: string; isNewCustomer: boolean } }>('/api/public/bookings', {
      leistungen: leistungen(),
      frequency: 'ONCE',
      scheduledStart: s.start,
      propertyKind: 'OFFICE',
      squareMeters: 80,
      hasPets: false,
      firstName: 'Ablauf',
      lastName: `Gast${RUN}`,
      email: `${GAST_PRAEFIX}${RUN}@example.ch`,
      phone: '+41 79 123 45 67',
      address: { street: 'Bundesgasse', streetNo: '5', postalCode: '3011', city: 'Bern', canton: 'BE', country: 'CH' },
      acceptTerms: true,
      website: '',
    });
    assert.equal(antwort.status, 201, antwort.text);
    assert.equal(data(antwort).isNewCustomer, true);
    s.bookingId = data(antwort).id;

    const buchung = data(
      await get<{ data: { customerId: string; status: string; items: { serviceId: string | null }[] } }>(`/api/bookings/${s.bookingId}`, {
        jar: jars.admin,
      }),
    );
    s.customerId = buchung.customerId;
    for (const leistung of [s.buero, s.fenster]) {
      assert.ok(buchung.items.some((i) => i.serviceId === leistung), 'jede gebuchte Leistung steht an der Buchung');
    }
  });

  it('4. das Büro bestätigt — daraus entsteht der Einsatz', async () => {
    assert.ok(s.bookingId);
    const bestaetigt = await post<{ data: { status: string } }>(`/api/bookings/${s.bookingId}/confirm`, undefined, { jar: jars.admin });
    assert.equal(bestaetigt.status, 200, bestaetigt.text);
    assert.equal(data(bestaetigt).status, 'CONFIRMED');

    const buchung = data(await get<{ data: { jobs: { id: string }[] } }>(`/api/bookings/${s.bookingId}`, { jar: jars.admin }));
    assert.equal(buchung.jobs.length, 1, 'genau ein Einsatz aus der Buchung');
    s.jobId = buchung.jobs[0]!.id;
  });

  it('5. der Einsatz wird mit abgehakter Checkliste abgeschlossen — die Buchung ist erledigt', async () => {
    assert.ok(s.jobId);
    const einsatz = data(
      await get<{ data: { checklist: { id: string; done: boolean }[] } }>(`/api/jobs/${s.jobId}`, { jar: jars.admin }),
    );
    /**
     * Abgehakt über den Endpunkt der Baustelle, nicht über die Datenbank:
     * Die Checkliste ist der Leistungsnachweis, und ohne sie verweigert der
     * Dienst den Abschluss zu Recht.
     */
    for (const punkt of einsatz.checklist.filter((p) => !p.done)) {
      const haken = await post(`/api/jobs/checklist/${punkt.id}`, { done: true }, { jar: jars.admin });
      assert.equal(haken.status, 200, haken.text);
    }

    const abschluss = await post<{ data: { status: string } }>(
      `/api/jobs/${s.jobId}/complete`,
      { completionNote: 'Büro und Fenster gereinigt.', materials: [] },
      { jar: jars.admin },
    );
    assert.equal(abschluss.status, 200, abschluss.text);
    assert.equal(data(abschluss).status, 'COMPLETED');

    const buchung = data(await get<{ data: { status: string } }>(`/api/bookings/${s.bookingId}`, { jar: jars.admin }));
    assert.equal(buchung.status, 'COMPLETED', 'sind alle Einsätze erledigt, ist es die Buchung auch');
  });

  it('6. die Rechnung entsteht aus der Buchung und wird ausgestellt', async () => {
    assert.ok(s.bookingId);
    const entwurf = await post<{ data: { id: string; status: string } }>(`/api/bookings/${s.bookingId}/invoice`, undefined, { jar: jars.admin });
    assert.equal(entwurf.status, 201, entwurf.text);
    assert.equal(data(entwurf).status, 'DRAFT', 'aus der Buchung entsteht zuerst ein Entwurf');
    s.invoiceId = data(entwurf).id;

    const ausgestellt = await post<{ data: { number: string; status: string } }>(`/api/invoices/${s.invoiceId}/issue`, undefined, { jar: jars.admin });
    assert.equal(ausgestellt.status, 200, ausgestellt.text);
    assert.match(data(ausgestellt).number, /^RE-/);

    const positionen = await db!.invoiceItem.findMany({ where: { invoiceId: s.invoiceId }, select: { name: true } });
    const namen = positionen.map((p) => p.name).join(' | ');
    for (const leistung of [`Ablauf buero ${RUN}`, `Ablauf fenster ${RUN}`]) {
      assert.ok(namen.includes(leistung), `die Rechnung nennt ${leistung} nicht: ${namen}`);
    }
  });

  it('7. die Zahlung wird erfasst — die Rechnung ist bezahlt', async () => {
    assert.ok(s.invoiceId);
    const vorher = data(
      await get<{ data: { id: string; balance: string; grossTotal: string }[] }>(`/api/invoices?customerId=${s.customerId}&pageSize=10`, {
        jar: jars.admin,
      }),
    ).find((r) => r.id === s.invoiceId);
    assert.ok(vorher, 'die Rechnung erscheint bei der Gastkundschaft');
    assert.equal(Number(vorher.balance), Number(vorher.grossTotal), 'vor der Zahlung ist alles offen');

    const zahlung = await post<{ data: { status: string; fullyPaid: boolean } }>(
      `/api/invoices/${s.invoiceId}/payments`,
      { amount: Number(vorher.balance), method: 'BANK_TRANSFER', reference: `${MARKE} B ${RUN}` },
      { jar: jars.admin },
    );
    assert.equal(zahlung.status, 201, zahlung.text);
    assert.equal(data(zahlung).fullyPaid, true);

    const nachher = data(
      await get<{ data: { id: string; status: string; balance: string }[] }>(`/api/invoices?customerId=${s.customerId}&pageSize=10`, {
        jar: jars.admin,
      }),
    ).find((r) => r.id === s.invoiceId);
    assert.equal(nachher?.status, 'PAID');
    assert.equal(Number(nachher?.balance), 0);
  });
});

// ===========================================================================
//  C — Einsatz → Zeit → Freigabe → Lohnlauf → veröffentlichte Abrechnung
// ===========================================================================

/**
 * Ein **abgeschlossener** Monat, weit genug zurück, dass weder der Demo-
 * Seed (Einsätze rund um heute) noch `lohnabrechnung.test.ts` (die Monate −2,
 * −5 und −7 sowie 2021/22) ihn berühren: zehn Monate vor heute. Ein laufender
 * Monat wird zu Recht nicht abgerechnet.
 */
const LOHN = (() => {
  const d = new Date(Date.UTC(heute.getUTCFullYear(), heute.getUTCMonth() - 10, 15, 7, 0, 0));
  return { jahr: d.getUTCFullYear(), monat: d.getUTCMonth() + 1, beginn: d, ende: new Date(d.getTime() + 3 * 3_600_000) };
})();

async function ablaufCAufraeumen(): Promise<void> {
  if (!db || !stamm.annaId) return;
  const einsaetze = (await db.job.findMany({ where: { title: { startsWith: MARKE_C } }, select: { id: true } })).map((x) => x.id);
  /**
   * Eine veröffentlichte Abrechnung verweigert die Datenbank zu löschen, und
   * eine bezahlte Zeit ebenso — der Weg an den Triggern vorbei ist derselbe
   * wie in `lohnabrechnung.test.ts` (`lohnBelegeEntfernen`).
   */
  await schutzfreiAufraeumen(async (tx) => {
    const abrechnungen = await tx.payslip.findMany({
      where: { employeeId: stamm.annaId, year: LOHN.jahr, month: LOHN.monat },
      select: { id: true },
    });
    await lohnBelegeEntfernen(tx, abrechnungen.map((a) => a.id));
    await tx.timeEntry.deleteMany({ where: { OR: [{ note: MARKE_C }, { jobId: { in: einsaetze } }] } });
    await tx.jobAssignment.deleteMany({ where: { jobId: { in: einsaetze } } });
    await tx.jobChecklistItem.deleteMany({ where: { jobId: { in: einsaetze } } });
    await tx.activity.deleteMany({ where: { jobId: { in: einsaetze } } });
    await tx.job.deleteMany({ where: { id: { in: einsaetze } } });
  });
}

describe('C — Einsatz, Zeit, Freigabe, Lohnlauf, Abrechnung als PDF', { concurrency: 1, skip: ohneDb }, () => {
  const s = { jobId: '', timeEntryId: '', payslipId: '' };

  before(ablaufCAufraeumen);
  after(ablaufCAufraeumen);

  it('1. ein Einsatz im abgerechneten Monat wird angelegt', async () => {
    const antwort = await post<{ data: { id: string; status: string } }>(
      '/api/jobs',
      {
        customerId: stamm.customerId,
        addressId: stamm.addressId,
        propertyId: stamm.propertyId,
        title: `${MARKE_C} ${RUN}`,
        scheduledStart: LOHN.beginn.toISOString(),
        scheduledEnd: LOHN.ende.toISOString(),
        estimatedMin: 180,
      },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 201, antwort.text);
    s.jobId = data(antwort).id;
  });

  it('2. die Mitarbeiterin wird zugeteilt', async () => {
    assert.ok(s.jobId);
    const zuteilung = await post(`/api/jobs/${s.jobId}/assign`, { employeeIds: [stamm.annaId], notify: false }, { jar: jars.admin });
    assert.equal(zuteilung.status, 200, zuteilung.text);
  });

  it('3. die Zeit wird auf den Einsatz erfasst — die Dauer rechnet der Server', async () => {
    assert.ok(s.jobId);
    /**
     * Von der Verwaltung nachgetragen (`POST /api/time`), nicht gestempelt:
     * Stempeln setzt die Serveruhr, und ein abgerechneter Monat liegt in der
     * Vergangenheit. Genau für diesen Fall — vergessenes Stempeln — gibt es
     * die Erfassung von Hand; sie ist als `manual` gekennzeichnet.
     */
    const antwort = await post<{ data: { id: string; minutes: number } }>(
      '/api/time',
      {
        employeeId: stamm.annaId,
        jobId: s.jobId,
        startedAt: LOHN.beginn.toISOString(),
        endedAt: LOHN.ende.toISOString(),
        breakMin: 0,
        note: MARKE_C,
      },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 201, antwort.text);
    s.timeEntryId = data(antwort).id;
    assert.equal(data(antwort).minutes, 180);
  });

  it('4. die Zeit wird freigegeben', async () => {
    assert.ok(s.timeEntryId);
    const freigabe = await post<{ data: { freigegeben: number } }>('/api/time/approve', { entryIds: [s.timeEntryId] }, { jar: jars.admin });
    assert.equal(freigabe.status, 200, freigabe.text);
    assert.equal(data(freigabe).freigegeben, 1);
  });

  it('5. der Lohnlauf erzeugt die Abrechnung aus der freigegebenen Zeit', async () => {
    assert.ok(s.timeEntryId);
    const lauf = await post<{ data: { ergebnisse: { employeeId: string; status: string; payslipId?: string; offeneErfassungen?: number }[] } }>(
      '/api/payroll/run',
      { year: LOHN.jahr, month: LOHN.monat, employeeIds: [stamm.annaId] },
      { jar: jars.admin },
    );
    assert.equal(lauf.status, 200, lauf.text);
    const eintrag = data(lauf).ergebnisse.find((e) => e.employeeId === stamm.annaId);
    assert.ok(eintrag?.payslipId, `keine Abrechnung entstanden: ${lauf.text}`);
    s.payslipId = eintrag.payslipId;

    const detail = data(
      await get<{ data: { hours: string | number; grossPay: string; published: boolean } }>(`/api/payroll/payslips/${s.payslipId}`, {
        jar: jars.admin,
      }),
    );
    assert.ok(Number(detail.hours) >= 3, `die drei freigegebenen Stunden fehlen (${detail.hours})`);
    assert.ok(Number(detail.grossPay) > 0);
    assert.equal(detail.published, false);

    // Ein Entwurf existiert für die eigene Person nicht — `lohnabrechnung.test.ts`.
    assert.equal((await get(`/api/payroll/payslips/${s.payslipId}`, { jar: jars.employee })).status, 404);
  });

  it('6. veröffentlicht — erst jetzt sieht die Mitarbeiterin ihre Abrechnung als PDF', async () => {
    assert.ok(s.payslipId);
    const veroeffentlicht = await post<{ data: { veroeffentlicht: number } }>(
      '/api/payroll/publish',
      { payslipIds: [s.payslipId], trotzUngepruefterSaetze: true },
      { jar: jars.admin },
    );
    assert.equal(veroeffentlicht.status, 200, veroeffentlicht.text);
    assert.equal(data(veroeffentlicht).veroeffentlicht, 1);

    const eigenes = await bytesVon(`/api/payroll/payslips/${s.payslipId}/pdf`, jars.employee);
    assert.equal(eigenes.status, 200, 'die angestellte Person lädt die eigene veröffentlichte Abrechnung');
    assert.ok(eigenes.typ.includes('application/pdf'), eigenes.typ);
    assert.equal(eigenes.bytes.subarray(0, 4).toString('latin1'), '%PDF');

    const gespeichert = await db!.payslip.findUniqueOrThrow({ where: { id: s.payslipId }, select: { pdfChecksum: true } });
    assert.equal(sha256(eigenes.bytes), gespeichert.pdfChecksum, 'ausgeliefert wird genau die veröffentlichte Fassung');

    // Die Gegenprobe: Lohn ist nichts für die Betriebsleitung und die Kundschaft.
    assert.ok([403, 404].includes((await bytesVon(`/api/payroll/payslips/${s.payslipId}/pdf`, jars.manager)).status));
    assert.equal((await bytesVon(`/api/payroll/payslips/${s.payslipId}/pdf`, jars.customer)).status, 403);
  });
});

// ===========================================================================
//  D — Datei: hochladen → Quarantäne → Prüfung → CLEAN → berechtigter Abruf
// ===========================================================================

const DATEI_PRAEFIX = 'geschaeftsablauf-';

describe('D — Datei von der Quarantäne bis zum berechtigten Abruf', { concurrency: 1, skip: ohneDb }, () => {
  const bytes = Buffer.from(`Protokoll der Begehung, Prüfreihe Geschäftsabläufe ${RUN}.\n`, 'utf8');
  const dateiname = `${DATEI_PRAEFIX}${RUN}.txt`;
  const s = { ticketId: '', signedUrl: '', assetId: '', url: '' };

  async function aufraeumen(): Promise<void> {
    if (!db) return;
    const assets = await db.fileAsset.findMany({ where: { filename: { startsWith: DATEI_PRAEFIX } }, select: { id: true, storedFileId: true } });
    await db.fileAsset.deleteMany({ where: { id: { in: assets.map((a) => a.id) } } });
    const abgelegt = [...assets.map((a) => a.storedFileId), s.ticketId].filter((x): x is string => Boolean(x));
    if (abgelegt.length > 0) await db.storedFile.deleteMany({ where: { id: { in: abgelegt } } });
  }

  before(aufraeumen);
  after(aufraeumen);

  it('1. das Ticket gibt nur eine Schreibadresse heraus', async () => {
    const ticket = await post<{ data: { ticketId: string; signedUrl: string } }>(
      '/api/files/upload-url',
      { profile: 'document', filename: dateiname, mimeType: 'text/plain', sizeBytes: bytes.byteLength },
      { jar: jars.admin },
    );
    assert.equal(ticket.status, 201, ticket.text);
    s.ticketId = data(ticket).ticketId;
    s.signedUrl = data(ticket).signedUrl;
  });

  it('2. hochgeladen, aber nicht abgeschlossen: die Bytes liegen in Quarantäne und sind nicht abrufbar', async () => {
    assert.ok(s.ticketId);
    const pfad = `${BASE_URL}${new URL(s.signedUrl, BASE_URL).pathname}`;
    const upload = await fetch(pfad, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: new Uint8Array(bytes) });
    assert.equal(upload.status, 200, 'Upload fehlgeschlagen');

    /**
     * Ungeprüfte Bytes haben kein `FileAsset` — und ohne `FileAsset` gibt es
     * weder eine Berechtigung noch einen Prüfstand, an dem die Auslieferung
     * hängen könnte. Auch die Verwaltung bekommt sie nicht.
     */
    assert.equal((await get(`/api/files/blob/${s.ticketId}`, { jar: jars.admin })).status, 404);
    assert.equal(await db!.fileAsset.count({ where: { storedFileId: s.ticketId } }), 0, 'vor dem Abschluss darf kein Asset bestehen');
  });

  it('3. der Abschluss prüft die Bytes — der Prüfer meldet CLEAN', async () => {
    assert.ok(s.ticketId);
    const abschluss = await post<{ data: { id: string; url: string; checksum: string } }>(
      '/api/files/finalize',
      { ticketId: s.ticketId, filename: dateiname },
      { jar: jars.admin },
    );
    assert.equal(abschluss.status, 201, abschluss.text);
    s.assetId = data(abschluss).id;
    s.url = data(abschluss).url;
    assert.equal(data(abschluss).checksum, sha256(bytes), 'die Prüfsumme gehört zu genau diesen Bytes');

    const asset = await db!.fileAsset.findUniqueOrThrow({
      where: { id: s.assetId },
      select: { scanStatus: true, scanner: true, scannedAt: true, isPublic: true },
    });
    assert.equal(asset.scanStatus, 'CLEAN', 'der deterministische Prüfer des Testservers hat nichts gefunden');
    assert.ok(asset.scanner, 'der Prüfer ist vermerkt');
    assert.ok(asset.scannedAt, 'und der Zeitpunkt der Prüfung');
    assert.equal(asset.isPublic, false, 'ein Dokument ist nie öffentlich');
  });

  it('4. die berechtigte Rolle bekommt genau die geprüften Bytes', async () => {
    assert.ok(s.url);
    const abruf = await bytesVon(s.url, jars.admin);
    assert.equal(abruf.status, 200);
    assert.equal(sha256(abruf.bytes), sha256(bytes), 'ausgeliefert wird, was geprüft wurde');
  });

  it('5. eine fremde Rolle und eine Anfrage ohne Sitzung bekommen nichts', async () => {
    assert.ok(s.url);
    assert.equal((await bytesVon(s.url, jars.customer)).status, 404, 'die Kundschaft sieht ein internes Dokument');
    assert.equal((await bytesVon(s.url)).status, 404, 'ohne Sitzung öffnet die Kennung nichts');
  });
});

// ===========================================================================
//  E — öffentlicher Offertlink: Ressource, Widerruf, Handlung, Abschluss
// ===========================================================================

async function ablaufEAufraeumen(): Promise<void> {
  if (!db) return;
  const offerten = await db.quote.findMany({ where: { title: { startsWith: MARKE_E }, deletedAt: null }, select: { id: true } });
  for (const offerte of offerten) await del(`/api/quotes/${offerte.id}`, { jar: jars.admin }).catch(() => undefined);
}

describe('E — öffentlicher Zugangslink: ansehen, widerrufen, beantworten', { concurrency: 1, skip: ohnePost }, () => {
  const s = { quoteId: '', ersterToken: '', zweiterToken: '' };

  before(ablaufEAufraeumen);
  after(ablaufEAufraeumen);

  it('1. der Versand stellt einen Link aus', async () => {
    const angelegt = await post<{ data: { id: string } }>(
      '/api/quotes',
      {
        customerId: stamm.customerId,
        title: `${MARKE_E} ${RUN}`,
        validUntil: tagIn(30),
        items: [{ name: 'Fensterreinigung', quantity: 3, unit: 'Std.', unitPrice: 68, discount: 0, vatRate: 8.1, optional: false }],
        discountValue: 0,
      },
      { jar: jars.admin },
    );
    assert.equal(angelegt.status, 201, angelegt.text);
    s.quoteId = data(angelegt).id;

    const versand = await post(`/api/quotes/${s.quoteId}/send`, { attachPdf: false }, { jar: jars.admin });
    assert.equal(versand.status, 200, versand.text);
    const token = offertTokenAusPost(s.quoteId);
    assert.ok(token, 'im Postausgang liegt kein Offertlink');
    s.ersterToken = token;
  });

  it('2. der Link öffnet die Ressource — Seite und PDF', async () => {
    assert.ok(s.ersterToken);
    assert.equal((await get(`/offerte/${s.ersterToken}`)).status, 200);
    const pdf = await bytesVon(`/api/public/quotes/${s.ersterToken}/pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.bytes.subarray(0, 4).toString('latin1'), '%PDF');
  });

  it('3. ein erneuter Versand widerruft den ersten Link', async () => {
    assert.ok(s.quoteId);
    /**
     * Der Widerruf über HTTP: `sendQuote` zieht vor jedem Versand die offenen
     * `QUOTE_RESPOND`-Links derselben Offerte zurück. Zwei gültige Schlüssel
     * in zwei Postfächern zeigten sonst auf zwei Stände derselben Offerte.
     */
    const nochmal = await post(`/api/quotes/${s.quoteId}/send`, { attachPdf: false }, { jar: jars.admin });
    assert.equal(nochmal.status, 200, nochmal.text);
    const token = offertTokenAusPost(s.quoteId);
    assert.ok(token, 'der zweite Versand hat keinen Link verschickt');
    assert.notEqual(token, s.ersterToken, 'jeder Versand stellt einen frischen Link aus');
    s.zweiterToken = token;

    assert.equal((await get(`/api/public/quotes/${s.ersterToken}/pdf`)).status, 404, 'der widerrufene Link öffnet nichts mehr');
    const mitAltemLink = await post(`/api/public/quotes/${s.ersterToken}/respond`, { decision: 'REJECT', reason: 'mit altem Link' });
    assert.ok(mitAltemLink.status >= 400 && mitAltemLink.status < 500, `der widerrufene Link handelt, HTTP ${mitAltemLink.status}`);
    const offerte = await db!.quote.findUniqueOrThrow({ where: { id: s.quoteId }, select: { status: true } });
    assert.equal(offerte.status, 'SENT', 'der alte Link hat nichts bewirkt');

    // Und in der Datenbank liegt der Widerruf, nicht der Rohwert.
    const alt = await db!.publicAccessToken.findUnique({ where: { tokenHash: sha256(Buffer.from(s.ersterToken)) }, select: { revokedAt: true } });
    assert.ok(alt?.revokedAt, 'der erste Link ist als widerrufen vermerkt');
  });

  it('4. mit dem gültigen Link wird gehandelt — die Ablehnung schliesst den Vorgang ab', async () => {
    assert.ok(s.zweiterToken);
    const ablehnung = await post<{ data: { requiresSignature: boolean; status?: string } }>(
      `/api/public/quotes/${s.zweiterToken}/respond`,
      { decision: 'REJECT', reason: 'Budget für dieses Jahr ausgeschöpft' },
    );
    assert.equal(ablehnung.status, 200, ablehnung.text);
    assert.equal(data(ablehnung).requiresSignature, false, 'eine Ablehnung braucht keine Unterschrift');
    assert.equal(data(ablehnung).status, 'REJECTED');
  });

  it('5. abgeschlossen ist abgeschlossen: keine Annahme danach, kein Vorgang', async () => {
    assert.ok(s.zweiterToken);
    const zuSpaet = await post(`/api/public/quotes/${s.zweiterToken}/respond`, { decision: 'ACCEPT' });
    assert.equal(zuSpaet.status, 422, zuSpaet.text);
    const offerte = await db!.quote.findUniqueOrThrow({ where: { id: s.quoteId }, select: { status: true, rejectedAt: true } });
    assert.equal(offerte.status, 'REJECTED');
    assert.ok(offerte.rejectedAt);
    assert.equal(await db!.signatureRequest.count({ where: { quoteId: s.quoteId } }), 0, 'eine Ablehnung erzeugt keinen Unterzeichnungsvorgang');
  });
});

// ===========================================================================
//  F — Scanner: Code auflösen → Berechtigung → Schnellaktion → Protokoll
// ===========================================================================

const SKU_PRAEFIX = 'ABLAUF-SCAN-';

describe('F — Scan eines Etiketts bis zum Protokolleintrag der Schnellaktion', { concurrency: 1, skip: ohneDb }, () => {
  const s = { materialId: '', codeId: '', inhalt: '', bewegungId: '' };

  async function aufraeumen(): Promise<void> {
    if (!db) return;
    const materialien = (await db.material.findMany({ where: { sku: { startsWith: SKU_PRAEFIX } }, select: { id: true } })).map((m) => m.id);
    // Wie `scan.test.ts`: Bewegungen sind in der Datenbank unveränderlich.
    await schutzfreiAufraeumen(async (tx) => {
      await tx.scanCode.deleteMany({ where: { entityId: { in: materialien } } });
      await tx.stockMovement.deleteMany({ where: { materialId: { in: materialien } } });
      await tx.material.deleteMany({ where: { id: { in: materialien } } });
    });
  }

  before(aufraeumen);
  after(aufraeumen);

  it('1. ein Artikel bekommt sein Etikett', async () => {
    const material = await post<{ data: { id: string } }>(
      '/api/materials',
      { sku: `${SKU_PRAEFIX}${RUN}`, name: 'Ablauf Allzweckreiniger', unit: 'l', minStock: 5 },
      { jar: jars.manager },
    );
    assert.equal(material.status, 201, material.text);
    s.materialId = data(material).id;

    const etikett = await post<{ data: { id: string; inhalt: string } }>(
      '/api/scan/codes',
      { entityType: 'MATERIAL', entityId: s.materialId },
      { jar: jars.manager },
    );
    assert.equal(etikett.status, 201, etikett.text);
    s.codeId = data(etikett).id;
    s.inhalt = data(etikett).inhalt;
    assert.ok(!s.inhalt.includes(s.materialId), 'der Code trägt nichts vom Datensatz');
  });

  it('2. der Scan löst den Code auf und bietet die Schnellaktionen an', async () => {
    assert.ok(s.inhalt);
    const antwort = await post<{ data: { eingabe: { art: string }; treffer: { id: string; aktionen: { schluessel: string }[] }[] } }>(
      '/api/scan/resolve',
      { text: s.inhalt },
      { jar: jars.manager },
    );
    assert.equal(antwort.status, 200, antwort.text);
    assert.equal(data(antwort).eingabe.art, 'INTERN');
    const treffer = data(antwort).treffer.find((t) => t.id === s.materialId);
    assert.ok(treffer, 'der Artikel wird nicht gefunden');
    assert.ok(treffer.aktionen.some((a) => a.schluessel === 'material.eingang'), 'Wareneingang wird nicht angeboten');
  });

  it('3. ohne Leserecht dieselbe Antwort wie für einen unbekannten Code — und der Endpunkt prüft erneut', async () => {
    assert.ok(s.inhalt);
    const mitarbeitende = data(await post<{ data: { treffer: unknown[]; hinweis: string | null } }>('/api/scan/resolve', { text: s.inhalt }, { jar: jars.employee }));
    const unbekannt = data(
      await post<{ data: { treffer: unknown[]; hinweis: string | null } }>('/api/scan/resolve', { text: 'CLX1:ZZZZZZZZZZZZZZZZZZZZ' }, { jar: jars.employee }),
    );
    assert.deepEqual(mitarbeitende.treffer, []);
    assert.equal(mitarbeitende.hinweis, unbekannt.hinweis, 'die Antwort verrät, dass hinter dem Code etwas liegt');
    assert.equal((await post('/api/scan/resolve', { text: s.inhalt }, { jar: jars.customer })).status, 403);

    // Wer die Kennung kennt, bucht trotzdem nicht: Die Schnellaktion ist kein Freibrief.
    const buchung = await post(`/api/materials/${s.materialId}/movements`, { kind: 'RECEIPT', quantity: 1 }, { jar: jars.employee });
    assert.equal(buchung.status, 403);
  });

  it('4. die Schnellaktion „Wareneingang" bucht über den bestehenden Endpunkt', async () => {
    assert.ok(s.materialId);
    const buchung = await post<{ data: { id: string } }>(
      `/api/materials/${s.materialId}/movements`,
      { kind: 'RECEIPT', quantity: 7, reference: `LS-ABLAUF-${RUN}` },
      { jar: jars.manager },
    );
    assert.equal(buchung.status, 201, buchung.text);
    s.bewegungId = data(buchung).id;

    const nachher = data(
      await post<{ data: { treffer: { id: string; merkmale: { label: string; wert: string }[] }[] } }>(
        '/api/scan/resolve',
        { text: s.inhalt },
        { jar: jars.manager },
      ),
    );
    const treffer = nachher.treffer.find((t) => t.id === s.materialId);
    assert.ok(treffer?.merkmale.some((m) => m.label === 'Bestand' && m.wert.startsWith('7')), JSON.stringify(nachher));
  });

  it('5. Etikett und Buchung stehen im Prüfprotokoll — der Code selbst nicht', async () => {
    assert.ok(s.bewegungId);
    const bewegung = await db!.auditLog.findFirst({ where: { entity: 'StockMovement', entityId: s.bewegungId } });
    assert.ok(bewegung, 'die Buchung steht nicht im Protokoll');
    assert.equal(bewegung.action, 'CREATE');

    const etikett = await db!.auditLog.findMany({ where: { entity: 'ScanCode', entityId: s.codeId } });
    assert.ok(etikett.some((e) => e.action === 'CREATE'), 'das Erzeugen des Etiketts fehlt im Protokoll');
    for (const e of etikett) {
      assert.ok(!(e.summary ?? '').includes(s.inhalt.slice(5)), 'der Code steht im Protokoll');
    }
  });
});

// ===========================================================================
//  G — Release: Detail → freigeben → terminieren → fällig → Übernahme → Ergebnis
// ===========================================================================

describe('G — Release von der Freigabe bis zum gemeldeten Ergebnis', { concurrency: 1, skip: ohneDb }, () => {
  /** Eine eigene Hauptversion, damit sich nichts mit `release-center.test.ts` kreuzt. */
  const VERSION = `8.${RUN % 1_000_000}.0`;
  const SUMMARY = `Prüfversion Geschäftsabläufe ${RUN}`;
  const SUMME = createHash('sha256').update(`ablauf-artefakt-${RUN}`).digest('hex');
  const COMMIT = createHash('sha1').update(`ablauf-commit-${RUN}`).digest('hex');
  const SCHLUESSEL = `ablauf-${RUN}`;
  const s = { releaseId: '', auftragId: '' };

  async function aufraeumen(): Promise<void> {
    if (!db) return;
    // Auch Reste abgebrochener Läufe: Ein liegengebliebener fälliger Auftrag
    // würde vom Werkzeug in `release-center.test.ts` abgeholt.
    const releases = await db.release.findMany({ where: { summary: { startsWith: 'Prüfversion Geschäftsabläufe' } }, select: { id: true } });
    const ids = releases.map((r) => r.id);
    await db.releaseDeferral.deleteMany({ where: { releaseId: { in: ids } } });
    await db.releaseRequest.deleteMany({ where: { releaseId: { in: ids } } });
    await db.release.deleteMany({ where: { id: { in: ids } } });
  }

  /** Ein signierter Aufruf des Ausführers — dieselbe Form wie `release-center.test.ts`. */
  async function ausfuehrer(methode: 'GET' | 'POST', pfad: string, rumpf?: unknown) {
    const text = rumpf === undefined ? '' : JSON.stringify(rumpf);
    const zeit = Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = {
      [ZEIT_KOPF]: String(zeit),
      [SIGNATUR_KOPF]: signieren(PRUEF_AUSFUEHRER_SCHLUESSEL, { methode, pfad, zeit, rumpf: text }),
      authorization: `Bearer ${PRUEF_AUSFUEHRER_TOKEN}`,
    };
    if (rumpf !== undefined) headers['content-type'] = 'application/json';
    const antwort = await fetch(`${BASE_URL}${pfad}`, { method: methode, headers, body: rumpf === undefined ? undefined : text });
    const inhalt = await antwort.text();
    let daten: Record<string, unknown> | null = null;
    try {
      daten = (JSON.parse(inhalt) as { data?: Record<string, unknown> }).data ?? null;
    } catch {
      /* kein JSON */
    }
    return { status: antwort.status, text: inhalt, daten };
  }

  before(async () => {
    await aufraeumen();
    /**
     * Die Version entsteht in der Testdatenbank: Einen Endpunkt, der
     * Versionen annimmt, gibt es absichtlich nicht
     * (`scripts/release-registrieren.ts`, `release-center.test.ts`).
     */
    s.releaseId = (
      await db!.release.create({
        data: {
          version: VERSION,
          releasedAt: new Date(),
          kind: 'MINOR',
          summary: SUMMARY,
          features: ['Geschäftsabläufe durchgehend geprüft'],
          fixes: [],
          securityFixes: [],
          migrations: [],
          ciStatus: 'PASSED',
          expectedDowntimeMinutes: 3,
          commit: COMMIT,
          artifactSha256: SUMME,
          artifactSizeBytes: 2048,
        },
      })
    ).id;
  });
  after(aufraeumen);

  it('1. die Detailansicht nennt die Version, ohne dass etwas entschieden ist', async () => {
    const detail = await get<{ data: { zustand: string; release: { version: string }; offenerAuftrag: unknown } }>(
      `/api/system/releases/${s.releaseId}`,
      { jar: jars.super },
    );
    assert.equal(detail.status, 200, detail.text);
    assert.equal(data(detail).release.version, VERSION);
    assert.equal(data(detail).zustand, 'AVAILABLE');
    assert.equal(data(detail).offenerAuftrag, null);

    const seite = (await get(`/admin/updates/${s.releaseId}`, { jar: jars.super })).text.replace(/<!-- -->/g, '');
    assert.ok(seite.includes(VERSION), 'die Detailseite nennt die Version nicht');
    assert.equal((await get(`/api/system/releases/${s.releaseId}`, { jar: jars.admin })).status, 403, 'nur die Systemverantwortung');
  });

  it('2. die Systemverantwortung gibt frei', async () => {
    const frei = await post<{ data: { status: string; toVersion: string } }>(`/api/system/releases/${s.releaseId}/freigabe`, undefined, {
      jar: jars.super,
    });
    assert.equal(frei.status, 200, frei.text);
    assert.equal(data(frei).status, 'APPROVED');
    assert.equal(data(frei).toVersion, VERSION);

    const detail = data(await get<{ data: { offenerAuftrag: { id: string } | null } }>(`/api/system/releases/${s.releaseId}`, { jar: jars.super }));
    assert.ok(detail.offenerAuftrag, 'die Freigabe hat keinen Auftrag angelegt');
    s.auftragId = detail.offenerAuftrag.id;
  });

  it('3. terminiert — und durch Zeitablauf fällig', async () => {
    assert.ok(s.auftragId);
    const termin = await put<{ data: { status: string } }>(
      `/api/system/releases/${s.releaseId}/termin`,
      { scheduledFor: new Date(Date.now() + 86_400_000).toISOString() },
      { jar: jars.super },
    );
    assert.equal(termin.status, 200, termin.text);
    assert.equal(data(termin).status, 'SCHEDULED');

    // Vor dem Termin gibt es nichts zu übernehmen.
    const zuFrueh = await ausfuehrer('GET', '/api/cron/release-auftraege?umgebung=test');
    assert.equal(zuFrueh.status, 200, zuFrueh.text);
    const vorher = zuFrueh.daten!.auftraege as { auftragId: string }[];
    assert.ok(!vorher.some((a) => a.auftragId === s.auftragId), 'ein Auftrag von morgen ist schon fällig');

    /**
     * Der Termin rückt in die Vergangenheit — in der Testdatenbank, wie in
     * `release-center.test.ts`: Die Oberfläche lässt zu Recht keinen Termin
     * in der Vergangenheit zu, und warten wäre keine Prüfung.
     */
    await db!.releaseRequest.update({ where: { id: s.auftragId }, data: { scheduledFor: new Date(Date.now() - 60_000) } });
  });

  it('4. der Ausführer sieht den fälligen Auftrag ohne Hindernis und übernimmt ihn signiert', async () => {
    assert.ok(s.auftragId);
    const liste = await ausfuehrer('GET', '/api/cron/release-auftraege?umgebung=test');
    assert.equal(liste.status, 200, liste.text);
    const auftrag = (liste.daten!.auftraege as { auftragId: string; hindernis: string | null; commit: string; artefaktSha256: string }[]).find(
      (a) => a.auftragId === s.auftragId,
    );
    assert.ok(auftrag, 'der fällige Auftrag fehlt in der Liste des Ausführers');
    assert.equal(auftrag.hindernis, null);
    assert.equal(auftrag.commit, COMMIT);
    assert.equal(auftrag.artefaktSha256, SUMME);

    const uebernahme = await ausfuehrer('POST', '/api/cron/release-auftraege/uebernehmen', {
      auftragId: s.auftragId,
      umgebung: 'test',
      ausfuehrer: 'pruefreihe/geschaeftsablauf',
      ausfuehrungsSchluessel: SCHLUESSEL,
      artefaktSha256: SUMME,
      ciNachweis: `https://github.com/beispiel/clenaris/actions/runs/${RUN}`,
    });
    assert.equal(uebernahme.status, 200, uebernahme.text);
    assert.equal(uebernahme.daten!.wiederholt, false);

    const detail = data(await get<{ data: { zustand: string } }>(`/api/system/releases/${s.releaseId}`, { jar: jars.super }));
    assert.equal(detail.zustand, 'DEPLOYING');
  });

  it('5. das Ergebnis „erfolgreich" wird mit der Zielversion gemeldet', async () => {
    assert.ok(s.auftragId);
    const ergebnis = await ausfuehrer('POST', '/api/cron/release-auftraege/ergebnis', {
      auftragId: s.auftragId,
      ausfuehrungsSchluessel: SCHLUESSEL,
      ergebnis: 'SUCCEEDED',
      laufendeVersion: VERSION,
      meldung: 'Health Check meldet die Zielversion.',
    });
    assert.equal(ergebnis.status, 200, ergebnis.text);

    const detail = data(
      await get<{ data: { auftraege: { id: string; status: string; finishedAt: string | null }[] } }>(`/api/system/releases/${s.releaseId}`, {
        jar: jars.super,
      }),
    );
    const auftrag = detail.auftraege.find((a) => a.id === s.auftragId);
    assert.equal(auftrag?.status, 'SUCCEEDED');
    assert.ok(auftrag?.finishedAt, 'das Ende der Ausführung ist vermerkt');
  });

  it('6. das Prüfprotokoll trägt jede Entscheidung mit Person und jeden Übergang des Ausführers ohne', async () => {
    assert.ok(s.auftragId);
    const entscheidungen = await db!.auditLog.findMany({
      where: { entity: 'ReleaseRequest', summary: { contains: VERSION }, userId: stamm.superId },
      orderBy: { createdAt: 'asc' },
    });
    const texte = entscheidungen.map((e) => e.summary ?? '');
    for (const muster of [/freigegeben/, /terminiert/]) {
      assert.ok(texte.some((t) => muster.test(t)), `kein Eintrag für ${muster}: ${texte.join(' | ')}`);
    }

    const ausfuehrung = await db!.auditLog.findMany({ where: { entity: 'ReleaseRequest', entityId: s.auftragId, userId: null }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(
      ausfuehrung.map((e) => (e.changes as { status?: { to: string } }).status?.to),
      ['DEPLOYING', 'SUCCEEDED'],
    );
    for (const e of ausfuehrung) {
      assert.equal((e.changes as { ausfuehrer?: string }).ausfuehrer, 'pruefreihe/geschaeftsablauf');
    }
    const alles = JSON.stringify(ausfuehrung);
    assert.ok(!alles.includes(PRUEF_AUSFUEHRER_TOKEN) && !alles.includes(PRUEF_AUSFUEHRER_SCHLUESSEL), 'Geheimnis im Protokoll');
  });
});
