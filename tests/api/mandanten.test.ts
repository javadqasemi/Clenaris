import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import { del, get, patch, post, requireServer } from '../helpers/client';
import { ACCOUNTS, login, loginAll, type AccountName } from '../helpers/accounts';
import { eigeneOrganisationId, fremdeOrganisation, schutzfreiAufraeumen, testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';

/**
 * Wave 16 — Mandantentrennung, bewiesen an einer fremden Organisation.
 *
 * Clenaris läuft einmandantig, ist aber mehrmandantig modelliert: Jede
 * Abfrage soll nach `organizationId` filtern. Mit nur einer Organisation im
 * Bestand ist ein fehlender Filter unsichtbar. Diese Reihe legt deshalb
 * Datensätze unter einer **fremden** Organisation an (`fremdeOrganisation()`)
 * und prüft je Bereich drei Dinge:
 *
 *  1. Die Liste der eigenen Organisation enthält den fremden Datensatz nicht
 *     — geprüft an der Antwort, nicht am Statuscode.
 *  2. Der fremde Datensatz existiert für Einzelansicht, Änderung und Löschen
 *     nicht (404; 403 nur, wo die Rolle ohnehin nicht darf).
 *  3. Ein Schreibvorgang, der auf einen fremden Datensatz **verweist**
 *     (Offerte an fremde Kundschaft), wird abgewiesen — sonst entstünde ein
 *     eigener Datensatz mit fremdem Bezug.
 *
 * 2026-09-27 kam der Rest dazu, den die Reihe bis dahin nicht anfasste:
 * Buchungen (sie fehlten ausgerechnet in der Kernliste), Verträge,
 * Zeiterfassung, Zahlungen, Gutschriften, Dateien, Automatisierungen,
 * Führungsdokumente, Website-Inhalte, Signaturvorgänge samt Offertannahme und
 * Vor-Ort-Abnahme, die öffentlichen Links und die Zwei-Faktor-Rücksetzung.
 * Die Erwartung ist überall dieselbe Regel — „fremd heisst nicht gefunden" —
 * und nicht, was eine Route heute zufällig antwortet. Wo eine Prüfung rot
 * wird, liegt der Fehler deshalb im Produkt, nicht hier.
 *
 * Die fremden Datensätze tragen die Marke `MANDANT-PRUEF` und werden vorher
 * und nachher entfernt.
 */

let jars: Record<AccountName, string>;
const RUN = Date.now();
const MARKE = 'MANDANT-PRUEF';
let org = '';
const fremd: Record<string, string> = {};

/** Konten der Mandantenreihe — an der Domain erkennbar und wegräumbar. */
const KONTO_DOMAIN = '@mandant-pruef.example.ch';
const KONTO_PASSWORT = 'Mandant-Pruefung-2026!';

/**
 * Ablagepfad der vorbereiteten Dateien. Über ihn — nicht über die Kennung —
 * räumt `aufraeumen()` auch Reste eines abgebrochenen Laufs weg, dessen
 * Kennungen niemand mehr kennt.
 */
const DATEI_ORDNER = 'mandant-pruef';

/**
 * Der Website-Baustein, den die fremde Organisation „gepflegt" hat. Ein
 * echter Schlüssel aus dem Register, damit Fassungsliste und Wiederherstellen
 * ihn überhaupt annehmen — ein erfundener Schlüssel würde schon an der
 * Validierung scheitern und bewiese nichts über die Mandantentrennung.
 */
const CMS_SCHLUESSEL = 'home.hero.lead';

const sha256 = (wert: string | Buffer) => createHash('sha256').update(wert).digest('hex');
const tagIn = (tage: number) => new Date(Date.now() + tage * 86_400_000).toISOString().slice(0, 10);

async function aufraeumen() {
  const db = testDb();
  if (!db || !org) return;

  /*
    Signaturvorgänge, Zahlungen, Gutschriften und ausgestellte Rechnungen
    lassen sich nicht auf dem normalen Weg entfernen — und das ist Absicht:
    Das Protokoll ist nur anfügbar, Finanzbelege sind unveränderlich
    (Art. 957a OR), und `SignatureRequest` hält Offerte, Einsatz und Konto per
    `Restrict`. Deshalb zuerst hier, an den Triggern vorbei und nur in der
    Testdatenbank. Unter `session_replication_role = 'replica'` greifen auch
    die Fremdschlüssel nicht; jede Tabelle wird darum ausdrücklich geleert.
  */
  const vorgaenge = await db.signatureRequest.findMany({
    where: {
      OR: [
        { organizationId: org, title: { startsWith: MARKE } },
        { quote: { title: { startsWith: MARKE } } },
        { job: { title: { startsWith: MARKE } } },
      ],
    },
    select: { id: true, participants: { select: { id: true } } },
  });
  const vorgangIds = vorgaenge.map((v) => v.id);
  const teilnehmerIds = vorgaenge.flatMap((v) => v.participants.map((p) => p.id));

  await schutzfreiAufraeumen(async (tx) => {
    await tx.signatureEvent.deleteMany({ where: { requestId: { in: vorgangIds } } });
    await tx.signatureOtpChallenge.deleteMany({ where: { participantId: { in: teilnehmerIds } } });
    await tx.deviceHandoffSession.deleteMany({
      where: { OR: [{ signatureRequestId: { in: vorgangIds } }, { job: { title: { startsWith: MARKE } } }] },
    });
    await tx.signatureParticipant.deleteMany({ where: { requestId: { in: vorgangIds } } });
    await tx.signatureRequest.deleteMany({ where: { id: { in: vorgangIds } } });
    // Die fremde Organisation ist reiner Prüfbestand; ihre Links gehören alle hierher.
    await tx.publicAccessToken.deleteMany({ where: { OR: [{ organizationId: org }, { resourceId: { in: teilnehmerIds } }] } });

    await tx.payment.deleteMany({
      where: {
        OR: [
          { reference: { startsWith: MARKE } },
          { invoice: { billToName: { startsWith: MARKE } } },
          { customer: { lastName: MARKE } },
        ],
      },
    });
    // Auch eine Gutschrift, die ein Defekt in der *eigenen* Organisation
    // ausgestellt hätte, trägt die Marke im Grund und verschwindet hier.
    await tx.creditNote.deleteMany({ where: { OR: [{ reason: { startsWith: MARKE } }, { customer: { lastName: MARKE } }] } });
    const rechnungen = await tx.invoice.findMany({ where: { organizationId: org, billToName: { startsWith: MARKE } }, select: { id: true } });
    const rechnungIds = rechnungen.map((r) => r.id);
    await tx.invoiceItem.deleteMany({ where: { invoiceId: { in: rechnungIds } } });
    await tx.invoice.deleteMany({ where: { id: { in: rechnungIds } } });
  });

  // Führung, Automatisierung, Website: gewöhnliche Datensätze der fremden Organisation.
  await db.managedDocument.deleteMany({ where: { organizationId: org, tags: { has: MARKE } } });
  /*
    Verweisprüfungen der Führung (B-13): Ziele, Risiken und Kennzahlen beider
    Organisationen, ohne Organisationsfilter — die eigenen Ziele und Risiken
    legt die Prüfung selbst an. Massnahmen vor ihren Aufgaben und Risiken,
    weil beide per Fremdschlüssel an ihnen hängen; die Aufgabe einer
    Massnahme heisst „Massnahme: …" und fiele durch den Markenfilter unten.
    Schlüsselergebnisse gehen mit dem Ziel (Cascade).
  */
  await db.correctiveAction.deleteMany({ where: { title: { startsWith: MARKE } } });
  await db.task.deleteMany({ where: { title: { startsWith: `Massnahme: ${MARKE}` } } });
  await db.riskEntry.deleteMany({ where: { title: { startsWith: MARKE } } });
  await db.objective.deleteMany({ where: { title: { startsWith: MARKE } } });
  await db.kpiDefinition.deleteMany({ where: { organizationId: org, key: { startsWith: 'mandant-pruef' } } });
  await db.automation.deleteMany({ where: { organizationId: org, name: { startsWith: MARKE } } });
  await db.contentRevision.deleteMany({ where: { organizationId: org, key: CMS_SCHLUESSEL } });
  await db.contentBlock.deleteMany({ where: { organizationId: org, key: CMS_SCHLUESSEL } });
  await db.galleryItem.deleteMany({ where: { organizationId: org, location: MARKE } });

  // Verträge ohne Organisationsfilter: Ein Defekt beim Anlegen hätte den
  // Vertrag mit fremder Kundschaft in der *eigenen* Organisation abgelegt.
  await db.contract.deleteMany({ where: { title: { startsWith: MARKE } } });
  // Einsätze, die ein Defekt beim Bestätigen der fremden Buchung erzeugt
  // hätte, tragen den Titel der Leistung, nicht die Marke — daher über die Buchung.
  await db.job.deleteMany({ where: { organizationId: org, booking: { number: { startsWith: 'BU-FREMD-' } } } });
  await db.booking.deleteMany({ where: { organizationId: org, number: { startsWith: 'BU-FREMD-' } } });

  await db.task.deleteMany({ where: { title: { startsWith: MARKE } } });
  await db.job.deleteMany({ where: { organizationId: org, title: { startsWith: MARKE } } });
  await db.invoice.deleteMany({ where: { organizationId: org, billToName: { startsWith: MARKE } } });
  await db.quote.deleteMany({ where: { organizationId: org, title: { startsWith: MARKE } } });
  await db.lead.deleteMany({ where: { organizationId: org, lastName: MARKE } });
  await db.expense.deleteMany({ where: { organizationId: org, description: { startsWith: MARKE } } });
  // Ohne Organisationsfilter: Ein Defekt legte die Ausgabe mit fremdem
  // Lieferanten in der *eigenen* Organisation ab.
  await db.expense.deleteMany({ where: { description: { startsWith: `${MARKE} Querverweis` } } });
  await db.supplier.deleteMany({ where: { organizationId: org, name: { startsWith: MARKE } } });
  await db.property.deleteMany({ where: { label: { startsWith: MARKE } } });
  await db.customer.deleteMany({ where: { organizationId: org, lastName: MARKE } });

  /*
    Dateien zuletzt: Dokumentfassungen und Signaturvorgänge, die auf sie
    zeigen, sind oben schon weg. Dazu servererzeugte PDF ohne fachliche
    Registrierung (`asset: null`) — die legt ein Renderer an, wenn ein
    Defekt einen fremden Rapport oder Beleg erzeugen liess.
  */
  await db.fileAsset.deleteMany({ where: { organizationId: org, path: { startsWith: `${org}/${DATEI_ORDNER}/` } } });
  await db.storedFile.deleteMany({
    where: {
      organizationId: org,
      OR: [{ path: { startsWith: `${org}/${DATEI_ORDNER}/` } }, { asset: { is: null }, path: { startsWith: `${org}/` } }],
    },
  });

  // Konten zuletzt: Mit dem Konto gehen Personalakte und Zeiterfassung (Cascade).
  await db.user.deleteMany({ where: { email: { endsWith: KONTO_DOMAIN } } });
}

/**
 * Eine Datei der fremden Organisation — physisch (`StoredFile` mit Bytes)
 * und fachlich (`FileAsset`), sauber geprüft und auslieferbar.
 *
 * Auslieferbar ist der Punkt: Eine Datei im Zustand `PENDING` käme auch ohne
 * Mandantenfilter als 404 zurück, und die Prüfung bewiese dann nur den
 * Schadsoftware-Riegel, nicht die Trennung. Deshalb `CLEAN` und
 * servererzeugt — die einzige verbleibende Sperre ist die Organisation.
 */
async function fremdeDatei(
  name: string,
  scope: 'CUSTOMER' | 'DOCUMENT' | 'SIGNATURE' | 'GALLERY',
  bezug: { customerId?: string } = {},
  isPublic = false,
): Promise<{ storedFileId: string; assetId: string; checksum: string }> {
  const db = testDb()!;
  const bytes = Buffer.from(`%PDF-1.4\n% ${MARKE} ${name}\n%%EOF\n`);
  const checksum = sha256(bytes);
  const pfad = `${org}/${DATEI_ORDNER}/${RUN}/${name}.pdf`;
  const stored = await db.storedFile.create({
    data: {
      organizationId: org,
      path: pfad,
      mimeType: 'application/pdf',
      sizeBytes: bytes.length,
      maxBytes: 1_000_000,
      data: bytes,
      driver: 'LOCAL',
      checksum,
      uploadedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  const asset = await db.fileAsset.create({
    data: {
      organizationId: org,
      scope,
      provenance: 'SYSTEM_GENERATED',
      scanStatus: 'CLEAN',
      path: pfad,
      url: `/api/files/blob/${stored.id}`,
      filename: `${MARKE}-${name}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: bytes.length,
      checksum,
      isPublic,
      storedFileId: stored.id,
      ...bezug,
    },
  });
  return { storedFileId: stored.id, assetId: asset.id, checksum };
}

/**
 * Ein öffentlicher Link, ausgestellt von der **fremden** Organisation.
 *
 * Über HTTP lässt er sich nicht herstellen — die Anwendung stellt nur Links
 * der eigenen Organisation aus, und genau darum geht es. Gespeichert wird wie
 * in `issuePublicToken` nur der SHA-256; der rohe Wert existiert allein in
 * dieser Prüfung. Das ist kein nachgebauter Ersatz für einen versandten Link
 * (dafür gäbe es den Postausgang), sondern die einzige Art, einen Link zu
 * haben, den diese Installation *nicht* ausgestellt hat.
 */
async function fremderLink(
  purpose: 'QUOTE_VIEW' | 'QUOTE_RESPOND' | 'INVOICE_VIEW' | 'INVOICE_PAY' | 'BOOKING_MANAGE' | 'SIGNATURE_ACCESS',
  resourceId: string,
): Promise<string> {
  const roh = randomBytes(32).toString('hex');
  await testDb()!.publicAccessToken.create({
    data: { organizationId: org, tokenHash: sha256(roh), purpose, resourceId, expiresAt: new Date(Date.now() + 7 * 86_400_000) },
  });
  return roh;
}

before(async () => {
  await requireServer();
  jars = await loginAll();
  const db = testDb();
  assert.ok(db, `kein Zugang zur Testdatenbank: ${testDbGrund()}`);
  org = (await fremdeOrganisation())!;
  await aufraeumen();

  const kunde = await db.customer.create({
    data: { organizationId: org, number: `K-FREMD-${RUN}`, firstName: 'Fremd', lastName: MARKE, email: `mandant.${RUN}@example.ch`, companyName: `${MARKE} AG` },
  });
  fremd.customer = kunde.id;
  fremd.property = (await db.property.create({ data: { customerId: kunde.id, label: `${MARKE} Objekt` } })).id;
  fremd.lead = (await db.lead.create({ data: { organizationId: org, number: `L-FREMD-${RUN}`, firstName: 'Fremd', lastName: MARKE, email: `mandant.lead.${RUN}@example.ch` } })).id;
  fremd.quote = (await db.quote.create({ data: { organizationId: org, number: `OF-FREMD-${RUN}`, title: `${MARKE} Offerte`, validUntil: new Date(Date.now() + 30 * 86_400_000), customerId: kunde.id } })).id;
  fremd.job = (
    await db.job.create({
      data: { organizationId: org, number: `JB-FREMD-${RUN}`, customerId: kunde.id, title: `${MARKE} Einsatz`, scheduledStart: new Date(), scheduledEnd: new Date(Date.now() + 3_600_000) },
    })
  ).id;
  fremd.invoice = (
    await db.invoice.create({
      data: {
        organizationId: org,
        number: `ENTWURF-FREMD-${RUN}`,
        customerId: kunde.id,
        issueDate: new Date(),
        dueDate: new Date(Date.now() + 30 * 86_400_000),
        billToName: `${MARKE} Empfänger`,
        billToStreet: 'Fremdweg 1',
        billToZip: '3000',
        billToCity: 'Bern',
      },
    })
  ).id;
  fremd.expense = (await db.expense.create({ data: { organizationId: org, description: `${MARKE} Ausgabe`, expenseDate: new Date(), netAmount: 10, grossAmount: 10.81 } })).id;
  fremd.supplier = (await db.supplier.create({ data: { organizationId: org, name: `${MARKE} Lieferant` } })).id;
  fremd.thread = (
    await db.messageThread.create({
      data: { organizationId: org, customerId: kunde.id, subject: `${MARKE} Verlauf`, messages: { create: { authorType: 'CUSTOMER', body: `${MARKE} Nachricht` } } },
    })
  ).id;
  fremd.task = (await db.task.create({ data: { organizationId: org, customerId: kunde.id, title: `${MARKE} Aufgabe` } })).id;

  /*
    Ab hier der Bestand für die Bereiche, die 2026-09-27 dazukamen.

    Eine versendete Offerte und eine ausgestellte Rechnung zusätzlich zu den
    Entwürfen oben: Öffentliche Links und Annahme greifen nur an versendeten
    Belegen. An einem Entwurf käme auch ohne Mandantenfilter eine Ablehnung
    zurück — die Prüfung wäre grün und bewiese nichts.
  */
  fremd.quoteVersendet = (
    await db.quote.create({
      data: {
        organizationId: org,
        number: `OF-FREMD-V-${RUN}`,
        title: `${MARKE} Offerte versendet`,
        status: 'SENT',
        sentAt: new Date(),
        validUntil: new Date(Date.now() + 30 * 86_400_000),
        customerId: kunde.id,
      },
    })
  ).id;
  fremd.rechnungAusgestellt = (
    await db.invoice.create({
      data: {
        organizationId: org,
        number: `RE-FREMD-${RUN}`,
        customerId: kunde.id,
        status: 'SENT',
        sentAt: new Date(),
        issueDate: new Date(),
        dueDate: new Date(Date.now() + 30 * 86_400_000),
        billToName: `${MARKE} Empfänger ausgestellt`,
        billToStreet: 'Fremdweg 1',
        billToZip: '3000',
        billToCity: 'Bern',
        netTotal: 100,
        vatAmount: 8.1,
        grossTotal: 108.1,
        balance: 58.1,
        paidAmount: 50,
      },
    })
  ).id;
  fremd.booking = (
    await db.booking.create({
      data: {
        organizationId: org,
        number: `BU-FREMD-${RUN}`,
        customerId: kunde.id,
        scheduledStart: new Date(Date.now() + 3 * 86_400_000),
        scheduledEnd: new Date(Date.now() + 3 * 86_400_000 + 7_200_000),
        durationMin: 120,
        grossTotal: 216.2,
        internalNote: `${MARKE} Buchung`,
      },
    })
  ).id;

  // Ein Konto mit Personalakte: Urheber der Signaturvorgänge, Subjekt der
  // Zeiterfassung und der Zwei-Faktor-Rücksetzung.
  const person = await db.user.create({
    data: {
      organizationId: org,
      email: `personal.${RUN}${KONTO_DOMAIN}`,
      passwordHash: 'nicht-anmeldbar',
      firstName: 'Fremd',
      lastName: 'Personal',
      role: 'EMPLOYEE',
      status: 'ACTIVE',
      twoFactorEnabled: true,
      twoFactorSecret: 'enc:v1:mandant-pruef',
      twoFactorConfirmedAt: new Date(),
    },
  });
  fremd.user = person.id;
  fremd.userEmail = person.email;
  fremd.employee = (await db.employee.create({ data: { organizationId: org, userId: person.id, employeeNumber: `M-FREMD-${RUN}`, hiredAt: new Date() } })).id;
  fremd.timeEntry = (
    await db.timeEntry.create({
      data: {
        employeeId: fremd.employee,
        jobId: fremd.job,
        startedAt: new Date(Date.now() - 3 * 3_600_000),
        endedAt: new Date(Date.now() - 3_600_000),
        minutes: 120,
        note: `${MARKE} Zeit`,
      },
    })
  ).id;

  fremd.contract = (
    await db.contract.create({
      data: {
        organizationId: org,
        customerId: kunde.id,
        title: `${MARKE} Vertrag`,
        startDate: new Date(`${tagIn(30)}T00:00:00Z`),
        versions: { create: { versionNumber: 1, effectiveFrom: new Date(`${tagIn(30)}T00:00:00Z`), reason: 'Erstfassung der Mandantenprüfung', baseAmount: 500 } },
      },
      include: { versions: true },
    })
  ).id;
  fremd.contractVersion = (await db.contractVersion.findFirstOrThrow({ where: { contractId: fremd.contract } })).id;

  fremd.payment = (
    await db.payment.create({
      data: {
        invoiceId: fremd.rechnungAusgestellt,
        customerId: kunde.id,
        amount: 50,
        status: 'SUCCEEDED',
        method: 'BANK_TRANSFER',
        provider: 'manual',
        reference: `${MARKE}-Zahlung`,
        paidAt: new Date(),
      },
    })
  ).id;
  fremd.creditNote = (
    await db.creditNote.create({
      data: {
        organizationId: org,
        number: `GS-FREMD-${RUN}`,
        invoiceId: fremd.rechnungAusgestellt,
        customerId: kunde.id,
        reason: `${MARKE} Gutschrift`,
        issueDate: new Date(),
        netTotal: 10,
        vatAmount: 0.81,
        grossTotal: 10.81,
      },
    })
  ).id;

  // Dateien: eine private an der Kundschaft, eine öffentliche (Galerie).
  const privat = await fremdeDatei('kundenakte', 'CUSTOMER', { customerId: kunde.id });
  fremd.dateiPrivat = privat.storedFileId;
  fremd.assetPrivat = privat.assetId;
  fremd.dateiOeffentlich = (await fremdeDatei('galerie', 'GALLERY', {}, true)).storedFileId;

  // Führungsdokument mit einer Fassung — ohne Fassung gäbe es nichts herunterzuladen.
  const dokDatei = await fremdeDatei('dokument', 'DOCUMENT');
  fremd.dateiDokument = dokDatei.storedFileId;
  fremd.assetDokument = dokDatei.assetId;
  const dokument = await db.managedDocument.create({
    data: { organizationId: org, title: `${MARKE} Dokument`, category: 'POLICY', visibility: 'MANAGEMENT', tags: [MARKE] },
  });
  const fassung = await db.documentVersion.create({ data: { documentId: dokument.id, version: 1, fileAssetId: dokDatei.assetId } });
  await db.managedDocument.update({ where: { id: dokument.id }, data: { currentVersionId: fassung.id } });
  fremd.dokument = dokument.id;

  // Automatisierung mit einem fälligen, noch nicht ausgeführten Lauf.
  const regel = await db.automation.create({
    data: { organizationId: org, name: `${MARKE} Regel`, trigger: 'LEAD_CREATED', active: true },
  });
  fremd.automation = regel.id;
  fremd.automationRun = (
    await db.automationRun.create({
      data: { automationId: regel.id, entity: 'Customer', entityId: kunde.id, status: 'PENDING', scheduledFor: new Date(Date.now() - 3_600_000) },
    })
  ).id;

  // Website: ein veröffentlichter Baustein mit Entwurf und einer älteren Fassung.
  const block = await db.contentBlock.create({
    data: { organizationId: org, key: CMS_SCHLUESSEL, value: `${MARKE} veröffentlicht`, draftValue: `${MARKE} Entwurf`, publishedAt: new Date() },
  });
  fremd.contentBlock = block.id;
  fremd.contentRevision = (
    await db.contentRevision.create({ data: { organizationId: org, blockId: block.id, key: CMS_SCHLUESSEL, value: `${MARKE} Fassung` } })
  ).id;
  fremd.galerie = (
    await db.galleryItem.create({
      data: { organizationId: org, title: `${MARKE} Galerie`, beforeUrl: '/fremd-vorher.jpg', afterUrl: '/fremd-nachher.jpg', location: MARKE },
    })
  ).id;

  /*
    Zwei offene Signaturvorgänge der fremden Organisation: die Annahme der
    versendeten Offerte (per Link) und die Vor-Ort-Abnahme des Einsatzes (auf
    einem übergebenen Gerät). Beide mit eingefrorenem Original (Hash A), wie
    der Signaturkern sie anlegt — ein Vorgang ohne Original gibt es nicht.
  */
  const originalOfferte = await fremdeDatei('offerte-original', 'SIGNATURE');
  const annahme = await db.signatureRequest.create({
    data: {
      organizationId: org,
      publicId: randomBytes(16).toString('hex'),
      status: 'PENDING',
      title: `${MARKE} Offertannahme`,
      quoteId: fremd.quoteVersendet,
      originalArtifactId: originalOfferte.assetId,
      originalDocumentHash: originalOfferte.checksum,
      consentVersion: 'mandant-pruef',
      createdById: person.id,
      sentAt: new Date(),
      expiresAt: new Date(Date.now() + 14 * 86_400_000),
      participants: { create: { nameSnapshot: `${MARKE} AG`, emailSnapshot: kunde.email!, customerId: kunde.id } },
    },
    include: { participants: true },
  });
  fremd.signatur = annahme.id;
  fremd.signaturTeilnehmer = annahme.participants[0]!.id;

  const originalRapport = await fremdeDatei('rapport-original', 'SIGNATURE');
  fremd.abnahme = (
    await db.signatureRequest.create({
      data: {
        organizationId: org,
        publicId: randomBytes(16).toString('hex'),
        status: 'PENDING',
        ceremonyMode: 'IN_PERSON_HANDOFF',
        presentedById: person.id,
        presentedByName: 'Fremd Personal',
        title: `${MARKE} Vor-Ort-Abnahme`,
        jobId: fremd.job,
        originalArtifactId: originalRapport.assetId,
        originalDocumentHash: originalRapport.checksum,
        consentVersion: 'mandant-pruef',
        createdById: person.id,
        expiresAt: new Date(Date.now() + 86_400_000),
        participants: { create: { nameSnapshot: `${MARKE} AG`, emailSnapshot: kunde.email!, customerId: kunde.id } },
      },
    })
  ).id;
});

after(async () => {
  await aufraeumen();
  await testDbSchliessen();
});

const BEREICHE: { name: string; liste: string; detail: (id: string) => string; schluessel: keyof typeof fremd; aendern?: Record<string, unknown> }[] = [
  { name: 'Kundschaft', liste: '/api/customers?pageSize=100', detail: (id) => `/api/customers/${id}`, schluessel: 'customer', aendern: { notes: 'übernommen' } },
  { name: 'Objekte', liste: '/api/properties?pageSize=100', detail: (id) => `/api/properties/${id}`, schluessel: 'property', aendern: { label: 'übernommen' } },
  { name: 'Anfragen', liste: '/api/leads?pageSize=100', detail: (id) => `/api/leads/${id}`, schluessel: 'lead', aendern: { message: 'übernommen' } },
  { name: 'Offerten', liste: '/api/quotes?pageSize=100', detail: (id) => `/api/quotes/${id}`, schluessel: 'quote', aendern: { title: 'übernommen' } },
  { name: 'Einsätze', liste: '/api/jobs?pageSize=100', detail: (id) => `/api/jobs/${id}`, schluessel: 'job', aendern: { title: 'übernommen' } },
  { name: 'Rechnungen', liste: '/api/invoices?pageSize=100', detail: (id) => `/api/invoices/${id}`, schluessel: 'invoice', aendern: { notes: 'übernommen' } },
  { name: 'Ausgaben', liste: '/api/expenses?pageSize=100', detail: (id) => `/api/expenses/${id}`, schluessel: 'expense', aendern: { description: 'übernommen' } },
  { name: 'Lieferanten', liste: '/api/suppliers?pageSize=100', detail: (id) => `/api/suppliers/${id}`, schluessel: 'supplier', aendern: { name: 'übernommen' } },
  // 2026-09-27: Verläufe hatten keine Organisation, und Liste wie Einzelansicht
  // filterten nicht danach — das Büro las die Korrespondenz jeder Organisation.
  { name: 'Nachrichten', liste: '/api/messages?status=all', detail: (id) => `/api/messages/${id}`, schluessel: 'thread' },
  // Ebenso Aufgaben: keine Spalte, kein Filter — fremde Aufgaben liessen sich
  // lesen, ändern (200) und löschen.
  { name: 'Aufgaben', liste: '/api/tasks?pageSize=100', detail: (id) => `/api/tasks/${id}`, schluessel: 'task', aendern: { title: 'übernommen' } },
  /*
    Ab hier mit Suchbegriff (2026-09-27). Ohne ihn hiesse „nicht in der
    Liste" nur „nicht auf der ersten Seite": Bei genug eigenen Datensätzen
    rutscht der fremde nach hinten, und die Prüfung wäre auch mit fehlendem
    Filter grün. Die Suche trifft die Marke der fremden Kundschaft bzw. den
    Titel — mit fehlendem Filter stünde der fremde Datensatz als einziger
    Treffer da.
  */
  { name: 'Buchungen', liste: `/api/bookings?q=${MARKE}`, detail: (id) => `/api/bookings/${id}`, schluessel: 'booking', aendern: { internalNote: 'übernommen' } },
  { name: 'Verträge', liste: `/api/contracts?q=${MARKE}&perPage=100`, detail: (id) => `/api/contracts/${id}`, schluessel: 'contract', aendern: { title: 'übernommen' } },
  { name: 'Führungsdokumente', liste: `/api/bi/documents?q=${MARKE}`, detail: (id) => `/api/bi/documents/${id}`, schluessel: 'dokument', aendern: { title: 'übernommen' } },
  // Nur Liste, Ändern, Löschen — eine Einzelansicht gibt es nicht (405).
  { name: 'Automatisierungen', liste: '/api/automations', detail: (id) => `/api/automations/${id}`, schluessel: 'automation', aendern: { active: false } },
  { name: 'Galerie (Website)', liste: '/api/gallery', detail: (id) => `/api/gallery/${id}`, schluessel: 'galerie', aendern: { title: 'übernommen' } },
];

/** Prisma-Modell je Schlüssel, wo der Name abweicht. */
const MODELL: Record<string, string> = { thread: 'messageThread', dokument: 'managedDocument', galerie: 'galleryItem' };

describe('Fremde Daten erscheinen nicht und lassen sich nicht anfassen', () => {
  for (const b of BEREICHE) {
    it(`${b.name}: nicht in der Liste, nicht einzeln, nicht änderbar, nicht löschbar`, async () => {
      const id = fremd[b.schluessel]!;
      const liste = await get(b.liste, { jar: jars.admin });
      assert.equal(liste.status, 200, `${b.liste}: ${liste.status}`);
      assert.ok(!liste.text.includes(id), `${b.name}: der fremde Datensatz steht in der Liste`);
      assert.ok(!liste.text.includes(MARKE), `${b.name}: die fremde Marke steht in der Liste`);

      const einzeln = await get(b.detail(id), { jar: jars.admin });
      assert.ok([404, 405].includes(einzeln.status), `${b.name} GET: ${einzeln.status}`);
      if (b.aendern) {
        const aenderung = await patch(b.detail(id), b.aendern, { jar: jars.admin });
        assert.ok([404, 405].includes(aenderung.status), `${b.name} PATCH: ${aenderung.status}`);
      }
      const loeschen = await del(b.detail(id), { jar: jars.admin });
      assert.ok([404, 405].includes(loeschen.status), `${b.name} DELETE: ${loeschen.status}`);

      const unveraendert = await (testDb() as unknown as Record<string, { findUnique: (a: unknown) => Promise<{ deletedAt?: Date | null } | null> }>)[
        MODELL[b.schluessel] ?? b.schluessel
      ]!.findUnique({ where: { id } });
      assert.ok(unveraendert, `${b.name}: der fremde Datensatz existiert noch`);
      assert.ok(!unveraendert.deletedAt, `${b.name}: der fremde Datensatz wurde nicht (weich) gelöscht`);
      // Der Statuscode allein beweist nicht, dass nichts geschrieben wurde —
      // eine Route kann erst schreiben und dann scheitern. Deshalb am Bestand.
      for (const [feld, wert] of Object.entries(b.aendern ?? {})) {
        assert.notDeepEqual((unveraendert as Record<string, unknown>)[feld], wert, `${b.name}: „${feld}" wurde am fremden Datensatz übernommen`);
      }
    });
  }
});

describe('Verweise auf fremde Datensätze werden abgewiesen', () => {
  const inZukunft = tagIn;

  it('Offerte an fremde Kundschaft', async () => {
    const r = await post('/api/quotes', { customerId: fremd.customer, title: 'Querverweis', validUntil: inZukunft(10), items: [{ name: 'Reinigung', quantity: 1, unitPrice: 10 }] }, { jar: jars.admin });
    assert.equal(r.status, 404, r.text);
  });

  it('Rechnung an fremde Kundschaft', async () => {
    const r = await post('/api/invoices', { customerId: fremd.customer, items: [{ name: 'Reinigung', quantity: 1, unitPrice: 10 }] }, { jar: jars.admin });
    assert.equal(r.status, 404, r.text);
  });

  it('Besichtigung und Reklamation für fremde Kundschaft', async () => {
    assert.equal((await post('/api/site-visits', { customerId: fremd.customer, scheduledAt: new Date().toISOString() }, { jar: jars.admin })).status, 404);
    assert.equal((await post('/api/complaints', { customerId: fremd.customer, title: 'Querverweis', description: 'x' }, { jar: jars.admin })).status, 404);
  });

  it('Antwort in einen fremden Verlauf', async () => {
    const r = await post(`/api/messages/${fremd.thread}`, { body: 'Querverweis' }, { jar: jars.admin });
    assert.equal(r.status, 404, r.text);
    assert.equal(await testDb()!.message.count({ where: { threadId: fremd.thread } }), 1, 'die Antwort steht im fremden Verlauf');
  });

  it('Aufgabe an fremder Kundschaft', async () => {
    const r = await post('/api/tasks', { title: `${MARKE} Querverweis`, customerId: fremd.customer }, { jar: jars.admin });
    assert.equal(r.status, 404, r.text);
    assert.equal(await testDb()!.task.count({ where: { title: `${MARKE} Querverweis` } }), 0, 'die Aufgabe entstand trotzdem');
  });

  it('Objekt der fremden Kundschaft an eigener Offerte', async () => {
    const eigene = await get<{ data: { id: string }[] }>('/api/customers?pageSize=1', { jar: jars.admin });
    const kunde = eigene.payload.data[0]!.id;
    const r = await post(
      '/api/quotes',
      { customerId: kunde, propertyId: fremd.property, title: 'Querverweis', validUntil: inZukunft(10), items: [{ name: 'Reinigung', quantity: 1, unitPrice: 10 }] },
      { jar: jars.admin },
    );
    assert.equal(r.status, 404, r.text);
  });
});

/**
 * Buchungen (2026-09-27): Sie fehlten in der Kernliste, obwohl sie der
 * häufigste Beleg des Betriebs sind. Über die Tabelle oben hinaus hier die
 * Übergänge — Bestätigen erzeugt Einsätze, Stornieren schickt Mails —, bei
 * denen ein fehlender Filter nicht nur liest, sondern handelt.
 */
describe('Buchungen einer fremden Organisation', () => {
  it('Bestätigen, Stornieren, Wiederherstellen und PDF greifen nicht (404) — Status und Einsätze unverändert', async () => {
    const db = testDb()!;
    const einsaetzeVorher = await db.job.count({ where: { bookingId: fremd.booking } });

    const bestaetigen = await post(`/api/bookings/${fremd.booking}/confirm`, undefined, { jar: jars.admin });
    assert.equal(bestaetigen.status, 404, `bestätigen: ${bestaetigen.text}`);
    const stornieren = await post(`/api/bookings/${fremd.booking}/cancel`, { reason: 'Querverweis-Prüfung' }, { jar: jars.admin });
    assert.equal(stornieren.status, 404, `stornieren: ${stornieren.text}`);
    const wiederherstellen = await post(`/api/bookings/${fremd.booking}/restore`, undefined, { jar: jars.admin });
    assert.equal(wiederherstellen.status, 404, `wiederherstellen: ${wiederherstellen.text}`);
    assert.equal((await get(`/api/bookings/${fremd.booking}/pdf`, { jar: jars.admin })).status, 404, 'PDF der fremden Buchung');

    const nachher = await db.booking.findUniqueOrThrow({ where: { id: fremd.booking } });
    assert.equal(nachher.status, 'PENDING', 'der Status der fremden Buchung hat sich bewegt');
    assert.equal(nachher.cancelledAt, null, 'die fremde Buchung wurde storniert');
    assert.equal(await db.job.count({ where: { bookingId: fremd.booking } }), einsaetzeVorher, 'für die fremde Buchung entstanden Einsätze');
  });

  it('Kundenkonto: eine fremde Buchung ist nicht die eigene (404)', async () => {
    const r = await get(`/api/bookings/${fremd.booking}`, { jar: jars.customer });
    assert.equal(r.status, 404, r.text);
  });
});

/**
 * Verträge binden über Monate; jeder Übergang (Pause, Kündigung, neue
 * Fassung, Aktivierung, Annahme) ist eine Zusage nach aussen. Ein fehlender
 * Filter an einem davon hiesse, dass diese Installation Zusagen im Namen
 * einer anderen Organisation macht.
 */
describe('Verträge einer fremden Organisation', () => {
  it('Pause, Kündigung, Storno, neue Fassung und Aktivierung greifen nicht (404) — der Vertrag bleibt Entwurf', async () => {
    const pfad = `/api/contracts/${fremd.contract}`;
    const versuche: [string, unknown][] = [
      [`${pfad}/pause`, { pausedFrom: tagIn(40), reason: 'Querverweis-Prüfung' }],
      [`${pfad}/notice`, { noticeGivenBy: 'CUSTOMER' }],
      [`${pfad}/cancel`, { reason: 'Querverweis-Prüfung' }],
      [`${pfad}/versions`, { version: { effectiveFrom: tagIn(60), reason: 'Querverweis-Prüfung', baseAmount: 900 } }],
      [`${pfad}/activate`, {}],
    ];
    for (const [ziel, koerper] of versuche) {
      const r = await post(ziel, koerper, { jar: jars.admin });
      assert.equal(r.status, 404, `${ziel}: ${r.status} ${r.text}`);
    }
    const db = testDb()!;
    const vertrag = await db.contract.findUniqueOrThrow({ where: { id: fremd.contract } });
    assert.equal(vertrag.status, 'DRAFT', 'der fremde Vertrag hat seinen Status geändert');
    assert.equal(vertrag.number, null, 'der fremde Vertrag hat eine Nummer aus dem eigenen Nummernkreis bekommen');
    assert.equal(await db.contractVersion.count({ where: { contractId: fremd.contract } }), 1, 'am fremden Vertrag entstand eine Fassung');
  });

  it('Annahme einer fremden Vertragsfassung beginnt nicht und lässt sich nicht zurückziehen (404)', async () => {
    const pfad = `/api/contracts/${fremd.contract}/versions/${fremd.contractVersion}/acceptance`;
    const start = await post(pfad, undefined, { jar: jars.admin });
    assert.equal(start.status, 404, start.text);
    const rueckzug = await del(pfad, { jar: jars.admin });
    assert.equal(rueckzug.status, 404, rueckzug.text);
    assert.equal(await testDb()!.signatureRequest.count({ where: { contractVersionId: fremd.contractVersion } }), 0, 'Signaturvorgang an fremder Fassung');
  });

  it('Vertrag für fremde Kundschaft wird nicht angelegt (404)', async () => {
    const r = await post(
      '/api/contracts',
      {
        contract: { customerId: fremd.customer, title: `${MARKE} Querverweis`, startDate: tagIn(30) },
        version: { effectiveFrom: tagIn(30), reason: 'Querverweis-Prüfung', baseAmount: 100 },
      },
      { jar: jars.admin },
    );
    assert.equal(r.status, 404, r.text);
    assert.equal(await testDb()!.contract.count({ where: { title: `${MARKE} Querverweis` } }), 0, 'der Vertrag entstand trotzdem');
  });
});

/**
 * Zeiterfassung: `TimeEntry` trägt keine Organisation, sie hängt an der
 * Personalakte. Genau solche Modelle sind die, an denen ein Filter vergessen
 * wird — und eine fremde Stunde in der Freigabe wäre eine fremde Lohnzeile.
 */
describe('Zeiterfassung einer fremden Organisation', () => {
  it('nicht in der Liste — auch nicht gefiltert nach der fremden Person —, nicht änderbar, nicht löschbar, nicht wieder zu öffnen', async () => {
    const id = fremd.timeEntry!;
    for (const pfad of ['/api/time?pageSize=200', `/api/time?employeeId=${fremd.employee}`, `/api/time?jobId=${fremd.job}`]) {
      const liste = await get(pfad, { jar: jars.admin });
      assert.equal(liste.status, 200, `${pfad}: ${liste.text}`);
      assert.ok(!liste.text.includes(id), `${pfad}: die fremde Zeit steht in der Liste`);
      assert.ok(!liste.text.includes(MARKE), `${pfad}: die fremde Marke steht in der Liste`);
    }
    assert.equal((await patch(`/api/time/${id}`, { note: 'übernommen' }, { jar: jars.admin })).status, 404, 'PATCH');
    assert.equal((await post(`/api/time/${id}/reopen`, undefined, { jar: jars.admin })).status, 404, 'wieder öffnen');
    assert.equal((await del(`/api/time/${id}`, { jar: jars.admin })).status, 404, 'DELETE');

    const eintrag = await testDb()!.timeEntry.findUnique({ where: { id } });
    assert.ok(eintrag, 'die fremde Zeit wurde gelöscht');
    assert.equal(eintrag.note, `${MARKE} Zeit`, 'die fremde Zeit wurde geändert');
  });

  it('Freigabe: eine fremde Zeit wird nicht freigegeben', async () => {
    const r = await post<{ data: { freigegeben: number } }>('/api/time/approve', { entryIds: [fremd.timeEntry] }, { jar: jars.admin });
    // Die Sammelfreigabe überspringt, was sie nicht findet (200 mit Zählung)
    // oder weist ab (404) — beides wahrt die Trennung. Entscheidend ist der Bestand.
    assert.ok([200, 404].includes(r.status), `Freigabe: ${r.status} ${r.text}`);
    if (r.status === 200) assert.equal(r.payload.data.freigegeben, 0, 'die Antwort meldet eine fremde Freigabe');
    const eintrag = await testDb()!.timeEntry.findUniqueOrThrow({ where: { id: fremd.timeEntry } });
    assert.equal(eintrag.approved, false, 'die fremde Zeit ist freigegeben');
  });

  it('eine Zeit für die fremde Person wird nicht erfasst (404)', async () => {
    const r = await post(
      '/api/time',
      { employeeId: fremd.employee, startedAt: new Date(Date.now() - 7_200_000).toISOString(), endedAt: new Date(Date.now() - 3_600_000).toISOString(), note: `${MARKE} Querverweis` },
      { jar: jars.admin },
    );
    assert.equal(r.status, 404, r.text);
    assert.equal(await testDb()!.timeEntry.count({ where: { employeeId: fremd.employee } }), 1, 'für die fremde Person entstand eine Zeit');
  });
});

/**
 * Zahlungen und Gutschriften sind unveränderliche Belege — ein Übergriff hier
 * lässt sich nicht einmal sauber zurücknehmen, nur stornieren. `Payment`
 * trägt keine Organisation; der Filter läuft über Rechnung oder Kundschaft
 * (`docs/MANDANTEN.md`), und genau das macht ihn empfindlich: Ein zweites
 * `OR` im selben Objekt ersetzt das erste still.
 */
describe('Zahlungen und Gutschriften einer fremden Organisation', () => {
  it('Zahlung: nicht in der Liste — auch nicht mit Suchbegriff —, nicht korrigierbar, nicht stornierbar', async () => {
    const id = fremd.payment!;
    for (const pfad of ['/api/payments?pageSize=100', `/api/payments?q=${MARKE}&pageSize=100`]) {
      const liste = await get(pfad, { jar: jars.admin });
      assert.equal(liste.status, 200, `${pfad}: ${liste.text}`);
      assert.ok(!liste.text.includes(id), `${pfad}: die fremde Zahlung steht in der Liste`);
      assert.ok(!liste.text.includes(MARKE), `${pfad}: die fremde Marke steht in der Liste`);
    }
    assert.equal((await patch(`/api/payments/${id}`, { note: 'übernommen' }, { jar: jars.admin })).status, 404, 'PATCH');
    assert.equal((await del(`/api/payments/${id}`, { jar: jars.admin })).status, 404, 'Storno');

    const zahlung = await testDb()!.payment.findUniqueOrThrow({ where: { id } });
    assert.equal(zahlung.status, 'SUCCEEDED', 'die fremde Zahlung wurde storniert');
    assert.equal(zahlung.note, null, 'die fremde Zahlung wurde korrigiert');
  });

  it('eine Zahlung auf eine fremde Rechnung wird nicht verbucht (404)', async () => {
    const r = await post(`/api/invoices/${fremd.rechnungAusgestellt}/payments`, { amount: 10, reference: `${MARKE}-Querverweis` }, { jar: jars.admin });
    assert.equal(r.status, 404, r.text);
    assert.equal(await testDb()!.payment.count({ where: { invoiceId: fremd.rechnungAusgestellt } }), 1, 'auf der fremden Rechnung entstand eine Zahlung');
  });

  it('Gutschrift: nicht in der Liste, kein PDF (404)', async () => {
    for (const pfad of ['/api/credit-notes', `/api/credit-notes?customerId=${fremd.customer}`, `/api/credit-notes?invoiceId=${fremd.rechnungAusgestellt}`]) {
      const liste = await get(pfad, { jar: jars.admin });
      assert.equal(liste.status, 200, `${pfad}: ${liste.text}`);
      assert.ok(!liste.text.includes(fremd.creditNote!), `${pfad}: die fremde Gutschrift steht in der Liste`);
      assert.ok(!liste.text.includes(MARKE), `${pfad}: die fremde Marke steht in der Liste`);
    }
    assert.equal((await get(`/api/credit-notes/${fremd.creditNote}/pdf`, { jar: jars.admin })).status, 404, 'PDF der fremden Gutschrift');
  });

  it('Gutschrift auf fremde Rechnung oder an fremde Kundschaft wird nicht ausgestellt (404)', async () => {
    const position = { name: 'Querverweis', quantity: 1, unitPrice: 5 };
    const ueberRechnung = await post(`/api/invoices/${fremd.rechnungAusgestellt}/credit-note`, { reason: `${MARKE} Querverweis`, ...position }, { jar: jars.admin });
    assert.equal(ueberRechnung.status, 404, `über die fremde Rechnung: ${ueberRechnung.text}`);

    const anKundschaft = await post('/api/credit-notes', { customerId: fremd.customer, reason: `${MARKE} Querverweis`, items: [position] }, { jar: jars.admin });
    assert.equal(anKundschaft.status, 404, `an die fremde Kundschaft: ${anKundschaft.text}`);

    // Eigene Kundschaft, fremde Bezugsrechnung: ein eigener Beleg mit fremdem Bezug.
    const eigene = await get<{ data: { id: string }[] }>('/api/customers?pageSize=1', { jar: jars.admin });
    const gemischt = await post(
      '/api/credit-notes',
      { customerId: eigene.payload.data[0]!.id, invoiceId: fremd.rechnungAusgestellt, reason: `${MARKE} Querverweis`, items: [position] },
      { jar: jars.admin },
    );
    assert.equal(gemischt.status, 404, `eigene Kundschaft, fremde Rechnung: ${gemischt.text}`);

    assert.equal(await testDb()!.creditNote.count({ where: { reason: `${MARKE} Querverweis` } }), 0, 'eine Gutschrift entstand trotzdem');
  });
});

/**
 * Dateien werden über die Kennung der physischen Datei ausgeliefert, nicht
 * über einen Fachdatensatz — die Berechtigung wird rückwärts aufgelöst
 * (`authorizeStoredFile`). Wer die Kennung einer fremden Datei kennt, darf
 * sie trotzdem nicht bekommen.
 */
describe('Dateien einer fremden Organisation', () => {
  it('private Datei: nicht auslieferbar, nicht in der Mediathek, nicht umbenennbar, nicht löschbar', async () => {
    const auslieferung = await get(`/api/files/blob/${fremd.dateiPrivat}`, { jar: jars.admin });
    assert.equal(auslieferung.status, 404, `Auslieferung: ${auslieferung.status}`);
    assert.ok(!auslieferung.text.includes(MARKE), 'die Bytes der fremden Datei kamen zurück');

    for (const pfad of ['/api/media?pageSize=100', `/api/media?q=${MARKE}`]) {
      const liste = await get(pfad, { jar: jars.admin });
      assert.equal(liste.status, 200, `${pfad}: ${liste.text}`);
      assert.ok(!liste.text.includes(fremd.assetPrivat!), `${pfad}: die fremde Datei steht in der Mediathek`);
      assert.ok(!liste.text.includes(MARKE), `${pfad}: die fremde Marke steht in der Mediathek`);
    }
    assert.equal((await patch(`/api/media/${fremd.assetPrivat}`, { filename: 'übernommen.pdf' }, { jar: jars.admin })).status, 404, 'umbenennen');
    assert.equal((await del(`/api/media/${fremd.assetPrivat}?trotzdem=1`, { jar: jars.admin })).status, 404, 'löschen');

    const asset = await testDb()!.fileAsset.findUnique({ where: { id: fremd.assetPrivat } });
    assert.ok(asset, 'die fremde Datei wurde gelöscht');
    assert.equal(asset.filename, `${MARKE}-kundenakte.pdf`, 'die fremde Datei wurde umbenannt');
  });

  it('öffentliche Datei der fremden Organisation wird hier nicht ausgeliefert (404) — weder angemeldet noch anonym', async () => {
    /*
      „Öffentlich" ist eine Aussage über die Website **ihrer** Organisation,
      nicht über jede Installation, die dieselbe Datenbank liest. Nach der
      Regel dieser Reihe ist ein fremder Datensatz hier nicht vorhanden —
      auch dann, wenn er dort für alle sichtbar ist.
    */
    for (const [wer, jar] of [['angemeldet', jars.admin], ['anonym', undefined]] as const) {
      const r = await get(`/api/files/blob/${fremd.dateiOeffentlich}`, jar ? { jar } : {});
      assert.equal(r.status, 404, `${wer}: ${r.status}`);
    }
  });
});

/**
 * Automatisierungen versenden Mails und legen Aufgaben an — ein fremder Lauf,
 * den diese Installation ausführt, handelte im Namen einer anderen
 * Organisation. Die Regel selbst deckt die Tabelle oben ab; hier der Lauf.
 */
describe('Automatisierungen einer fremden Organisation', () => {
  it('ein fälliger Lauf der fremden Regel wird vom stündlichen Lauf nicht ausgeführt', async () => {
    const lauf = await get('/api/cron/hourly', { headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? 'dev-cron-secret'}` } });
    // 500 heisst: ein Teilschritt ist gescheitert, die übrigen liefen — wie in automatisierungen.test.ts.
    assert.ok([200, 500].includes(lauf.status), `stündlicher Lauf: HTTP ${lauf.status}`);
    const nachher = await testDb()!.automationRun.findUniqueOrThrow({ where: { id: fremd.automationRun } });
    assert.equal(nachher.status, 'PENDING', 'der fremde Lauf wurde angefasst');
    assert.equal(nachher.startedAt, null, 'der fremde Lauf wurde gestartet');
    assert.equal(nachher.attempts, 0, 'der fremde Lauf wurde versucht');
  });
});

/**
 * Führungsdokumente haben eine eigene Sichtbarkeit (`documentVisibilityWhere`)
 * — und die schliesst die Organisation ein. Geprüft werden die Wege neben der
 * Einzelansicht: Download, Inhalt, Fassungen, Signaturvorgänge, und die
 * Rückrichtung — ein eigenes Dokument, das auf Fremdes zeigt.
 */
describe('Führungsdokumente einer fremden Organisation', () => {
  it('Download, Inhalt, Signaturvorgänge und Dateiroute: 404; eine neue Fassung wird nicht angehängt', async () => {
    const pfad = `/api/bi/documents/${fremd.dokument}`;
    for (const ziel of [`${pfad}/download`, `${pfad}/content`, `${pfad}/signature-requests`, `/api/files/blob/${fremd.dateiDokument}`]) {
      const r = await get(ziel, { jar: jars.admin });
      assert.equal(r.status, 404, `${ziel}: ${r.status}`);
      assert.ok(!r.text.includes(MARKE), `${ziel}: Inhalt der fremden Fassung kam zurück`);
    }
    const fassung = await post(`${pfad}/versions`, { fileId: fremd.assetDokument, changeNote: 'Querverweis' }, { jar: jars.admin });
    assert.equal(fassung.status, 404, fassung.text);
    assert.equal(await testDb()!.documentVersion.count({ where: { documentId: fremd.dokument } }), 1, 'am fremden Dokument entstand eine Fassung');
  });

  it('ein eigenes Dokument mit fremder Datei oder fremder Person wird nicht angelegt (404)', async () => {
    const mitDatei = await post('/api/bi/documents', { title: `${MARKE} Querverweis Datei`, fileId: fremd.assetDokument }, { jar: jars.admin });
    assert.equal(mitDatei.status, 404, `fremde Datei: ${mitDatei.text}`);
    const mitPerson = await post('/api/bi/documents', { title: `${MARKE} Querverweis Person`, category: 'EMPLOYEE', subjectEmployeeId: fremd.employee }, { jar: jars.admin });
    assert.equal(mitPerson.status, 404, `fremde Person: ${mitPerson.text}`);
    assert.equal(await testDb()!.managedDocument.count({ where: { title: { startsWith: `${MARKE} Querverweis` } } }), 0, 'ein Dokument entstand trotzdem');
  });
});

/**
 * Verweise der Führung und der Finanzen auf fremde Datensätze (B-13,
 * 2026-09-28).
 *
 * Diese Dienste schrieben Fremdschlüssel aus dem Anfragekörper unbesehen in
 * die Datenbank; aufgehalten hat sie nur der Fremdschlüssel, und der fragt
 * nicht, wem die Zeile gehört. Wo das Anlegen prüfte, fehlte die Prüfung beim
 * Ändern. Jede Prüfung hier stellt deshalb neben dem Statuscode auch den
 * Bestand fest — eine Route kann erst schreiben und dann scheitern.
 *
 * Die eigenen Ziele und Risiken entstehen direkt in der Datenbank: Geprüft
 * wird der Verweis, nicht das Anlegen, und ein Umweg über die Schnittstelle
 * brächte nur Ratenbegrenzung und Nebenwirkungen (Benachrichtigungen) ins Spiel.
 */
describe('Verweise der Führung und der Finanzen auf fremde Datensätze', () => {
  const eigen: Record<string, string> = {};

  before(async () => {
    const db = testDb()!;
    const eigeneOrg = (await eigeneOrganisationId())!;
    eigen.ziel = (await db.objective.create({ data: { organizationId: eigeneOrg, title: `${MARKE} Ziel eigen` } })).id;
    eigen.schluesselergebnis = (await db.keyResult.create({ data: { objectiveId: eigen.ziel, title: `${MARKE} Schlüsselergebnis`, targetValue: 100 } })).id;
    eigen.risiko = (await db.riskEntry.create({ data: { organizationId: eigeneOrg, title: `${MARKE} Risiko eigen` } })).id;
    fremd.ziel = (await db.objective.create({ data: { organizationId: org, title: `${MARKE} Ziel fremd` } })).id;
    fremd.kennzahl = (await db.kpiDefinition.create({ data: { organizationId: org, key: `mandant-pruef.${RUN}`, label: `${MARKE} Kennzahl`, source: 'MANUAL' } })).id;
  });

  /**
   * Gegen den alten Stand: 201 — die Ausgabe entstand mit dem fremden
   * Lieferanten, und die Ausgabenliste zeigte dessen Namen.
   */
  it('Ausgabe mit fremdem Lieferanten wird nicht erfasst (404)', async () => {
    const r = await post(
      '/api/expenses',
      { supplierId: fremd.supplier, description: `${MARKE} Querverweis Ausgabe`, expenseDate: tagIn(0), netAmount: 10 },
      { jar: jars.admin },
    );
    assert.equal(r.status, 404, r.text);
    assert.equal(await testDb()!.expense.count({ where: { description: `${MARKE} Querverweis Ausgabe` } }), 0, 'die Ausgabe entstand trotzdem');
    assert.equal(await testDb()!.expense.count({ where: { supplierId: fremd.supplier, NOT: { organizationId: org } } }), 0, 'eine eigene Ausgabe verweist auf den fremden Lieferanten');
  });

  /**
   * Gegen den alten Stand: 200 — das Schlüsselergebnis zeigte auf die fremde
   * Kennzahl, und der Nachtlauf übernahm deren Snapshot-Werte.
   */
  it('Schlüsselergebnis: eine fremde Kennzahl wird nicht übernommen (404)', async () => {
    const r = await patch(`/api/bi/key-results/${eigen.schluesselergebnis}`, { kpiDefinitionId: fremd.kennzahl, kpiPeriod: 'MONTH' }, { jar: jars.admin });
    assert.equal(r.status, 404, r.text);
    const nachher = await testDb()!.keyResult.findUniqueOrThrow({ where: { id: eigen.schluesselergebnis } });
    assert.equal(nachher.kpiDefinitionId, null, 'die fremde Kennzahl wurde gespeichert');
    assert.equal(nachher.kpiPeriod, null, 'die Änderung wurde teilweise übernommen');
  });

  /**
   * Gegen den alten Stand: 200 — das eigene Ziel hing unter dem fremden, und
   * die Fortschrittsrechnung schrieb in das Ziel der anderen Organisation.
   */
  it('Ziel: ein fremdes übergeordnetes Ziel und eine fremde Verantwortung werden nicht übernommen (404)', async () => {
    const pfad = `/api/bi/objectives/${eigen.ziel}`;
    const elternteil = await patch(pfad, { parentId: fremd.ziel }, { jar: jars.admin });
    assert.equal(elternteil.status, 404, `übergeordnetes Ziel: ${elternteil.text}`);
    const verantwortung = await patch(pfad, { ownerId: fremd.user }, { jar: jars.admin });
    assert.equal(verantwortung.status, 404, `Verantwortung: ${verantwortung.text}`);
    const nachher = await testDb()!.objective.findUniqueOrThrow({ where: { id: eigen.ziel } });
    assert.equal(nachher.parentId, null, 'das fremde Ziel wurde übergeordnet');
    assert.equal(nachher.ownerId, null, 'die fremde Person wurde verantwortlich');
  });

  /**
   * Gegen den alten Stand: 201 — es entstanden eine Massnahme und eine
   * Aufgabe für das fremde Konto, und das Konto wurde benachrichtigt.
   */
  it('Massnahme mit fremder Zuständigkeit wird nicht eröffnet (404) — keine Aufgabe, keine Benachrichtigung', async () => {
    const db = testDb()!;
    const titel = `${MARKE} Querverweis Massnahme`;
    const r = await post('/api/bi/actions', { title: titel, riskId: eigen.risiko, assigneeId: fremd.user }, { jar: jars.admin });
    assert.equal(r.status, 404, r.text);
    assert.equal(await db.correctiveAction.count({ where: { title: titel } }), 0, 'die Massnahme entstand trotzdem');
    assert.equal(await db.task.count({ where: { assigneeId: fremd.user } }), 0, 'für das fremde Konto entstand eine Aufgabe');
    assert.equal(await db.notification.count({ where: { userId: fremd.user } }), 0, 'das fremde Konto wurde benachrichtigt');
  });
});

/**
 * Website-Inhalte sind je Organisation gespeichert (`ContentBlock` mit
 * `organizationId`). Ein fremder Text auf dieser Website wäre die sichtbarste
 * Form eines fehlenden Filters — er stünde vor jeder Besucherin.
 */
describe('Website-Inhalte einer fremden Organisation', () => {
  it('Fassungen der fremden Organisation erscheinen nicht und lassen sich nicht zurückholen (404)', async () => {
    const liste = await get(`/api/content/revisions?key=${CMS_SCHLUESSEL}`, { jar: jars.admin });
    assert.equal(liste.status, 200, liste.text);
    assert.ok(!liste.text.includes(fremd.contentRevision!), 'die fremde Fassung steht in der Liste');
    assert.ok(!liste.text.includes(MARKE), 'die fremde Marke steht in der Liste');

    const zurueck = await post('/api/content/revisions', { revisionId: fremd.contentRevision }, { jar: jars.admin });
    assert.equal(zurueck.status, 404, zurueck.text);
    const block = await testDb()!.contentBlock.findUniqueOrThrow({ where: { id: fremd.contentBlock } });
    assert.equal(block.draftValue, `${MARKE} Entwurf`, 'der Entwurf des fremden Bausteins wurde überschrieben');
  });

  it('das Bildfeld eines fremden Galerieeintrags wird nicht überschrieben (404)', async () => {
    const r = await patch('/api/content/asset', { entity: 'galleryItem', id: fremd.galerie, field: 'beforeUrl', url: '/uebernommen.jpg' }, { jar: jars.admin });
    assert.equal(r.status, 404, r.text);
    const eintrag = await testDb()!.galleryItem.findUniqueOrThrow({ where: { id: fremd.galerie } });
    assert.equal(eintrag.beforeUrl, '/fremd-vorher.jpg', 'das Bild des fremden Eintrags wurde ersetzt');
  });

  it('die Website zeigt weder den veröffentlichten Text noch den Entwurf der fremden Organisation', async () => {
    const seite = await get('/', { redirect: 'follow' });
    assert.equal(seite.status, 200, `Startseite: ${seite.status}`);
    assert.ok(!seite.text.includes(MARKE), 'fremder Website-Text auf der eigenen Startseite');
  });
});

/**
 * Signaturvorgänge und Offertannahme (Gate 4C). Ein Vorgang bindet Bytes
 * (Hash A) und trägt Beweise; ihn fremd lesen hiesse fremde Unterschriften
 * lesen, ihn fremd versenden hiesse in fremdem Namen Links ausstellen.
 */
describe('Offertannahme und Signaturvorgänge einer fremden Organisation', () => {
  it('Vorgang: nicht lesbar, keine Integritätsprüfung, keine Artefakte (404)', async () => {
    const pfad = `/api/signatures/${fremd.signatur}`;
    for (const ziel of [pfad, `${pfad}/integrity`, `${pfad}/artifacts/original`]) {
      const r = await get(ziel, { jar: jars.admin });
      assert.equal(r.status, 404, `${ziel}: ${r.status}`);
      assert.ok(!r.text.includes(MARKE), `${ziel}: Inhalt des fremden Vorgangs kam zurück`);
    }
  });

  it('Vorgang: nicht versendbar, nicht abbrechbar (404) — Zustand und Zugänge unverändert', async () => {
    const db = testDb()!;
    const zugaengeVorher = await db.publicAccessToken.count({ where: { resourceId: fremd.signaturTeilnehmer } });

    const senden = await post(`/api/signatures/${fremd.signatur}/send`, undefined, { jar: jars.admin });
    assert.equal(senden.status, 404, `versenden: ${senden.text}`);
    const abbrechen = await post(`/api/signatures/${fremd.signatur}/cancel`, { reason: 'Querverweis-Prüfung' }, { jar: jars.admin });
    assert.equal(abbrechen.status, 404, `abbrechen: ${abbrechen.text}`);

    const vorgang = await db.signatureRequest.findUniqueOrThrow({ where: { id: fremd.signatur } });
    assert.equal(vorgang.status, 'PENDING', 'der fremde Vorgang wurde abgebrochen');
    assert.equal(await db.publicAccessToken.count({ where: { resourceId: fremd.signaturTeilnehmer } }), zugaengeVorher, 'für den fremden Vorgang wurde ein Link ausgestellt');
    assert.equal(await db.signatureEvent.count({ where: { requestId: fremd.signatur } }), 0, 'im Protokoll des fremden Vorgangs steht ein Eintrag');
  });

  it('versendete Offerte der fremden Organisation: nicht erneut versendbar (404), das Kundenkonto kann sie nicht annehmen (404)', async () => {
    const senden = await post(`/api/quotes/${fremd.quoteVersendet}/send`, {}, { jar: jars.admin });
    assert.equal(senden.status, 404, `versenden: ${senden.text}`);
    for (const decision of ['ACCEPT', 'REJECT'] as const) {
      const r = await post(`/api/quotes/${fremd.quoteVersendet}/respond`, { decision }, { jar: jars.customer });
      assert.equal(r.status, 404, `${decision} aus dem Kundenkonto: ${r.text}`);
    }
    const db = testDb()!;
    assert.equal((await db.quote.findUniqueOrThrow({ where: { id: fremd.quoteVersendet } })).status, 'SENT', 'die fremde Offerte hat ihren Status geändert');
    assert.equal(await db.signatureRequest.count({ where: { quoteId: fremd.quoteVersendet } }), 1, 'für die fremde Offerte entstand ein zweiter Vorgang');
  });
});

/**
 * Vor-Ort-Abnahme (Gate 4D). Die Übergabe sperrt die Sitzung des Personals —
 * geprüft wird deshalb mit einer **frisch** angemeldeten Sitzung, nie mit
 * `jars.admin`: Ginge die Sperre trotz fremdem Einsatz durch, legte sie sonst
 * den Rest dieser Datei lahm (siehe `frischeMitarbeiterSitzung()` in
 * `vor-ort-abnahme.test.ts`).
 */
describe('Vor-Ort-Abnahme an einem fremden Einsatz', () => {
  it('die Übergabe beginnt nicht (404), setzt kein Signaturcookie und sperrt die Sitzung nicht', async () => {
    const frisch = await login(ACCOUNTS.admin.email, ACCOUNTS.admin.password);
    assert.equal(frisch.status, 200, frisch.text);

    const start = await post(`/api/jobs/${fremd.job}/handoff`, undefined, { jar: frisch.jar });
    assert.equal(start.status, 404, start.text);
    assert.ok(!/clenaris_sig=/.test(start.cookies), 'Signaturcookie für einen fremden Einsatz');
    assert.equal((await get('/api/customers?pageSize=1', { jar: frisch.jar })).status, 200, 'die Sitzung wurde für einen fremden Einsatz gesperrt');

    const abbruch = await del(`/api/jobs/${fremd.job}/handoff`, { jar: frisch.jar });
    assert.equal(abbruch.status, 404, `abbrechen: ${abbruch.text}`);

    const db = testDb()!;
    assert.equal(await db.deviceHandoffSession.count({ where: { jobId: fremd.job } }), 0, 'Übergabe an einem fremden Einsatz');
    assert.equal(await db.signatureRequest.count({ where: { jobId: fremd.job } }), 1, 'Abnahmevorgang an einem fremden Einsatz');
    assert.equal((await db.signatureRequest.findUniqueOrThrow({ where: { id: fremd.abnahme } })).status, 'PENDING', 'die fremde Abnahme wurde abgebrochen');
  });

  it('der Rapport eines fremden Einsatzes wird nicht erzeugt (404)', async () => {
    const r = await get(`/api/jobs/${fremd.job}/report`, { jar: jars.admin });
    assert.equal(r.status, 404, `Rapport: ${r.status}`);
  });

  it('der laufende Abnahmevorgang des fremden Einsatzes ist weder lesbar noch abbrechbar (404)', async () => {
    assert.equal((await get(`/api/signatures/${fremd.abnahme}`, { jar: jars.admin })).status, 404, 'lesen');
    assert.equal((await post(`/api/signatures/${fremd.abnahme}/cancel`, {}, { jar: jars.admin })).status, 404, 'abbrechen');
  });

  /**
   * Die Verwaltung hängt keinen Verlauf an einen fremden Einsatz (2026-09-27).
   * `openThread` prüfte die Einsatz-ID nur für Mitarbeitende; für Büro und
   * Leitung entstand ein Verlauf mit der Einsatz-ID einer anderen
   * Organisation. Gegen den alten Stand: 201 und ein Verlauf.
   */
  it('ein Nachrichtenverlauf zu einem fremden Einsatz wird nicht eröffnet (404)', async () => {
    const betreff = `MANDANT-PRUEF Verlauf ${Date.now()}`;
    for (const rolle of ['admin', 'manager'] as const) {
      const antwort = await post('/api/messages', { subject: betreff, body: 'Prüfung', jobId: fremd.job }, { jar: jars[rolle] });
      assert.equal(antwort.status, 404, `${rolle}: ${antwort.text}`);
    }
    const db = testDb()!;
    assert.equal(await db.messageThread.count({ where: { jobId: fremd.job } }), 0, 'Verlauf am fremden Einsatz');
    await db.messageThread.deleteMany({ where: { subject: betreff } });
  });
});

/**
 * Öffentliche Links: Der Token ist der einzige Ausweis, und er trägt die
 * Organisation, die ihn ausgestellt hat. Diese Installation darf nur Links
 * auflösen, die **sie** ausgestellt hat — sonst öffnete sie über ihre eigene
 * Adresse Offerten, Rechnungen, Buchungen und Unterschriften einer anderen.
 *
 * Die Erwartung ist 404 wie bei einem unbekannten Link: Die Antwort soll
 * nicht verraten, dass der Link anderswo gültig wäre.
 */
describe('Öffentliche Links: ein Link der fremden Organisation löst hier nichts auf', () => {
  it('Offerte ansehen (QUOTE_VIEW): kein PDF (404)', async () => {
    const roh = await fremderLink('QUOTE_VIEW', fremd.quoteVersendet!);
    const r = await get(`/api/public/quotes/${roh}/pdf`);
    assert.equal(r.status, 404, `PDF: ${r.status}`);
  });

  it('Offerte annehmen und ablehnen (QUOTE_RESPOND): 404 — Offerte und Signaturvorgang unverändert', async () => {
    const roh = await fremderLink('QUOTE_RESPOND', fremd.quoteVersendet!);
    const db = testDb()!;
    const zugaengeVorher = await db.publicAccessToken.count({ where: { resourceId: fremd.signaturTeilnehmer } });

    const annehmen = await post(`/api/public/quotes/${roh}/respond`, { decision: 'ACCEPT' });
    assert.equal(annehmen.status, 404, `annehmen: ${annehmen.text}`);
    assert.ok(!annehmen.text.includes('#t='), 'die Antwort enthält einen Unterzeichnungslink');
    const ablehnen = await post(`/api/public/quotes/${roh}/respond`, { decision: 'REJECT', reason: 'Querverweis-Prüfung' });
    assert.equal(ablehnen.status, 404, `ablehnen: ${ablehnen.text}`);

    assert.equal((await db.quote.findUniqueOrThrow({ where: { id: fremd.quoteVersendet } })).status, 'SENT', 'die fremde Offerte hat ihren Status geändert');
    assert.equal(await db.signatureRequest.count({ where: { quoteId: fremd.quoteVersendet } }), 1, 'für die fremde Offerte entstand ein Vorgang');
    assert.equal((await db.signatureRequest.findUniqueOrThrow({ where: { id: fremd.signatur } })).status, 'PENDING', 'der fremde Vorgang wurde beendet');
    assert.equal(await db.publicAccessToken.count({ where: { resourceId: fremd.signaturTeilnehmer } }), zugaengeVorher, 'für den fremden Vorgang wurde ein Link ausgestellt');
  });

  it('Rechnung ansehen (INVOICE_VIEW) und bezahlen (INVOICE_PAY): 404', async () => {
    const ansehen = await fremderLink('INVOICE_VIEW', fremd.rechnungAusgestellt!);
    assert.equal((await get(`/api/public/invoices/${ansehen}/pdf`)).status, 404, 'PDF der fremden Rechnung');
    const bezahlen = await fremderLink('INVOICE_PAY', fremd.rechnungAusgestellt!);
    const r = await post(`/api/public/invoices/${bezahlen}/pay`, { method: 'CARD' });
    assert.equal(r.status, 404, `bezahlen: ${r.status} ${r.text}`);
  });

  it('Buchung verwalten (BOOKING_MANAGE): kein PDF (404)', async () => {
    const roh = await fremderLink('BOOKING_MANAGE', fremd.booking!);
    const r = await get(`/api/public/bookings/${roh}/pdf`);
    assert.equal(r.status, 404, `PDF: ${r.status}`);
  });

  it('Unterzeichnungslink tauschen (SIGNATURE_ACCESS): 404, keine Signatursitzung, kein Protokolleintrag', async () => {
    const roh = await fremderLink('SIGNATURE_ACCESS', fremd.signaturTeilnehmer!);
    const r = await post('/api/public/signatures/exchange', { token: roh });
    assert.equal(r.status, 404, `Tausch: ${r.status} ${r.text}`);
    assert.ok(!/clenaris_sig=/.test(r.cookies), 'Signatursitzung für einen fremden Vorgang');
    assert.equal(await testDb()!.signatureEvent.count({ where: { requestId: fremd.signatur } }), 0, 'im Protokoll des fremden Vorgangs steht ein Eintrag');
  });
});

/**
 * Benutzerkonten. Die Zwei-Faktor-Rücksetzung ist die einzige Handlung, die
 * einen Schutz von aussen entfernt (`two-factor.test.ts`) — an einem fremden
 * Konto wäre sie ein Übernahmeweg. Geprüft mit der Systemverantwortung, weil
 * nur sie die Rücksetzung überhaupt darf: Mit der Administration käme 403,
 * und die Prüfung bewiese die Rechtematrix statt der Mandantentrennung.
 */
describe('Benutzerkonten einer fremden Organisation', () => {
  it('Zwei-Faktor-Rücksetzung durch die Systemverantwortung: 404, der zweite Faktor bleibt', async () => {
    const r = await del(`/api/users/${fremd.user}/2fa`, { jar: jars.super });
    assert.equal(r.status, 404, r.text);
    const konto = await testDb()!.user.findUniqueOrThrow({ where: { id: fremd.user } });
    assert.equal(konto.twoFactorEnabled, true, 'der zweite Faktor des fremden Kontos wurde entfernt');
    assert.equal(konto.sessionsRevokedAt, null, 'die Sitzungen des fremden Kontos wurden beendet');
  });

  it('nicht in der Kontenliste, nicht änderbar, kein Zugangslink (404)', async () => {
    const liste = await get('/api/users', { jar: jars.admin });
    assert.equal(liste.status, 200, liste.text);
    assert.ok(!liste.text.includes(fremd.user!), 'das fremde Konto steht in der Liste');
    assert.ok(!liste.text.includes(fremd.userEmail!), 'die Adresse des fremden Kontos steht in der Liste');

    assert.equal((await patch(`/api/users/${fremd.user}`, { status: 'SUSPENDED' }, { jar: jars.admin })).status, 404, 'sperren');
    assert.equal((await post(`/api/users/${fremd.user}/password-reset`, undefined, { jar: jars.admin })).status, 404, 'Zugangslink');
    assert.equal((await testDb()!.user.findUniqueOrThrow({ where: { id: fremd.user } })).status, 'ACTIVE', 'das fremde Konto wurde gesperrt');
  });
});

/**
 * Die Gegenrichtung (2026-09-27): nicht „die eigene Person sieht fremde
 * Daten", sondern „eine **fremde** Person handelt in dieser Installation".
 *
 * Bis dahin fehlte der Fall, und genau dort lag die Lücke: Jede Route löste
 * die Organisation über `getOrganizationId()` auf, die Sitzung wurde nie
 * damit verglichen. Ein Administrator einer anderen Organisation meldete sich
 * an und verwaltete die Daten dieser. Geprüft wird an echten Konten, nicht an
 * nachgebauten Tokens: eines, das von Anfang an fremd ist, und eines, das
 * mitten in einer gültigen Sitzung die Organisation wechselt.
 */
describe('Konten einer fremden Organisation handeln hier nicht', () => {
  async function konto(organizationId: string, name: string): Promise<{ id: string; email: string }> {
    const db = testDb()!;
    const { hashPassword } = await import('../../src/lib/auth/password');
    const email = `${name}.${RUN}${KONTO_DOMAIN}`;
    const user = await db.user.create({
      data: {
        organizationId,
        email,
        passwordHash: await hashPassword(KONTO_PASSWORT),
        firstName: 'Mandant',
        lastName: name,
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    });
    return { id: user.id, email };
  }

  it('ein Administrator der fremden Organisation kann sich nicht anmelden — dieselbe Meldung wie beim falschen Passwort', async () => {
    const fremderAdmin = await konto(org, 'fremd');
    const anmeldung = await post<{ error: { message: string } }>('/api/auth/login', { email: fremderAdmin.email, password: KONTO_PASSWORT });
    assert.equal(anmeldung.status, 401, anmeldung.text);
    const falsch = await post<{ error: { message: string } }>('/api/auth/login', { email: fremderAdmin.email, password: 'falsch-falsch-falsch' });
    assert.equal(anmeldung.payload.error.message, falsch.payload.error.message, 'Die Anmeldung verrät nicht, dass das Konto anderswo existiert');
    assert.equal(anmeldung.cookies, '', 'Kein Cookie für ein fremdes Konto');
  });

  it('wechselt ein Konto die Organisation, endet die laufende Sitzung sofort — Endpunkt, Seite und Erneuerung', async () => {
    const db = testDb()!;
    const { eigeneOrganisationId } = await import('../helpers/testdb');
    const eigene = (await eigeneOrganisationId())!;
    const wechsler = await konto(eigene, 'wechsel');

    const anmeldung = await post('/api/auth/login', { email: wechsler.email, password: KONTO_PASSWORT });
    assert.equal(anmeldung.status, 200, anmeldung.text);
    const jar = anmeldung.cookies;
    assert.equal((await get('/api/customers?pageSize=1', { jar })).status, 200, 'Vorher: die eigene Organisation ist erreichbar');

    await db.user.update({ where: { id: wechsler.id }, data: { organizationId: org } });

    // Dasselbe, noch gültige Zugangstoken — die Datenbank entscheidet.
    assert.equal((await get('/api/customers?pageSize=1', { jar })).status, 401, 'Endpunkt: keine Sitzung mehr');
    const seite = await get('/admin/kunden', { jar });
    assert.ok([302, 303, 307].includes(seite.status), `Seite: Weiterleitung zur Anmeldung erwartet, war ${seite.status}`);
    assert.equal((await post('/api/auth/refresh', undefined, { jar })).status, 401, 'Erneuerung: kein neues Token für ein fremdes Konto');
  });
});

/**
 * Anfragen als Verkaufschancen (Phase 19, 2026-09-27): Stufe und Status sind
 * dasselbe, und jeder Verweis gehört zur eigenen Organisation.
 *
 * Bis dahin setzte nur das Kanban im Browser zur Stufe den passenden Status;
 * die Schnittstelle speicherte „Stufe gewonnen, Status neu", wenn man es ihr
 * so schickte. Und eine Stufe der fremden Organisation wurde übernommen.
 */
describe('Anfragen: Stufe, Status und Verweise', () => {
  const eigeneAnfrage = async () => {
    const r = await post<{ data: { id: string } }>(
      '/api/leads',
      { firstName: 'Pipeline', lastName: MARKE, email: `pipeline.${Date.now()}@example.ch`, source: 'OTHER' },
      { jar: jars.admin },
    );
    assert.equal(r.status, 201, r.text);
    return r.payload.data.id;
  };

  it('die Stufe bestimmt den Status — auch wenn der Aufruf etwas anderes schickt', async () => {
    const db = testDb()!;
    const { eigeneOrganisationId } = await import('../helpers/testdb');
    const eigene = (await eigeneOrganisationId())!;
    const gewonnen = await db.pipelineStage.findFirst({ where: { organizationId: eigene, key: 'won' } });
    const verloren = await db.pipelineStage.findFirst({ where: { organizationId: eigene, key: 'lost' } });
    assert.ok(gewonnen && verloren, 'Vorbedingung: die Standardstufen der eigenen Organisation');
    const id = await eigeneAnfrage();
    try {
      const r = await patch<{ data: { status: string; stageId: string } }>(`/api/leads/${id}`, { stageId: gewonnen.id, status: 'NEW' }, { jar: jars.admin });
      assert.equal(r.status, 200, r.text);
      const nachStufe = await db.lead.findUniqueOrThrow({ where: { id } });
      assert.equal(nachStufe.status, 'WON', 'Stufe „gewonnen", Status blieb „neu"');
      assert.ok(nachStufe.convertedAt, 'gewonnen ohne Abschlusszeitpunkt');

      // Umgekehrt: nur ein Status — die Stufe folgt.
      assert.equal((await patch(`/api/leads/${id}`, { status: 'LOST', lostReason: 'Preis' }, { jar: jars.admin })).status, 200);
      const nachStatus = await db.lead.findUniqueOrThrow({ where: { id } });
      assert.equal(nachStatus.stageId, verloren.id, 'Status „verloren", Stufe blieb „gewonnen"');
    } finally {
      await db.lead.deleteMany({ where: { id } });
    }
  });

  it('eine Stufe der fremden Organisation wird nicht übernommen (404)', async () => {
    const db = testDb()!;
    const fremdeStufe = await db.pipelineStage.create({ data: { organizationId: org, name: `${MARKE} Stufe`, key: `pruef-${RUN}` } });
    const id = await eigeneAnfrage();
    try {
      const r = await patch(`/api/leads/${id}`, { stageId: fremdeStufe.id }, { jar: jars.admin });
      assert.equal(r.status, 404, r.text);
      assert.equal((await db.lead.findUniqueOrThrow({ where: { id } })).stageId === fremdeStufe.id, false, 'fremde Stufe gespeichert');
    } finally {
      await db.lead.deleteMany({ where: { id } });
      await db.pipelineStage.delete({ where: { id: fremdeStufe.id } });
    }
  });
});

describe('Kundenkonto', () => {
  it('sieht keine fremden Objekte, Rechnungen und Verträge', async () => {
    // Verträge seit 2026-09-27: `contract:read_own` hält auch die Kundschaft,
    // und die Einschränkung auf die eigene Akte steht neben dem Mandantenfilter.
    for (const pfad of ['/api/properties', '/api/invoices', '/api/contracts']) {
      const r = await get(pfad, { jar: jars.customer });
      if (r.status === 403) continue;
      assert.ok(!r.text.includes(MARKE), `${pfad}: fremde Marke sichtbar`);
    }
  });
});
