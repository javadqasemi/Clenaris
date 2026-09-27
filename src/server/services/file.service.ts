import 'server-only';

import type { FileScope, Prisma } from '@prisma/client';

import { can } from '@/lib/auth/rbac';
import type { SessionUser } from '@/lib/auth/session';
import { sha256Hex } from '@/lib/crypto';
import { prisma } from '@/lib/db';
import {
  BusinessRuleError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@/lib/errors';
import { audit } from '@/lib/audit';
import { recordSecurityEvent } from '@/lib/security/record';
import { logger } from '@/lib/logger';
import {
  leseAblageGeprueft,
  readStoredBytes,
  verifyBytes,
  type UploadProfile,
} from '@/lib/storage';
import { pruefeDateipolitik } from '@/lib/storage/dateipolitik';
import { loadTicket } from '@/lib/storage/tickets';
import { SCAN_MAX_ATTEMPTS, getScanner } from '@/lib/security/malware';
import { darfAusgeliefertWerden as pruefeAuslieferung } from '@/lib/security/malware/auslieferung';

import { documentVisibilityWhere } from './document.service';
import { getOrganizationId } from './organization.service';
import { propertyVisibilityWhere } from './property.service';

const log = logger('file.security');

/**
 * Die Sicherheitsgrenze für Dateien.
 *
 * **Der Abschluss, nicht der Upload, nimmt eine Datei an.** Bis Gate 2 galt
 * eine Datei als angenommen, sobald sie im Speicher lag: Der Browser lud
 * direkt zu Supabase hoch, meldete Pfad, Typ und Grösse, und die Anwendung
 * schrieb das so in die Datenbank. Geprüft wurde nie ein einziges Byte — es
 * gab auf diesem Weg auch keine Stelle, an der der Server die Datei je zu
 * sehen bekam.
 *
 * Dieser Dienst zieht die Grenze an einen Ort, den beide Speicherwege
 * durchlaufen müssen: Der Server liest die *tatsächlich abgelegten* Bytes
 * zurück, prüft Grösse, Signatur und Typ, bildet die Prüfsumme und legt erst
 * danach das `FileAsset` an. Vorher existiert die Datei fachlich nicht.
 *
 * **Drei Schichten, drei Aufgaben.** `StoredFile` ist die physische Ebene:
 * Treiber, Pfad, Bytes, Grösse, Prüfsumme, Ticket. `FileAsset` ist die
 * fachliche: Organisation, Bereich, Beziehung zum Geschäftsobjekt,
 * öffentlich oder nicht. Die Berechtigung entsteht ausschliesslich auf der
 * fachlichen Ebene — eine Kennung öffnet nichts.
 */

// ---------------------------------------------------------------------------
//  Abschluss
// ---------------------------------------------------------------------------

/**
 * Wofür ein Upload-Profil steht, wenn daraus ein Fachobjekt wird.
 *
 * **Warum das hier steht und nicht vom Client kommt.** Vorher durfte der
 * Client `scope` und `isPublic` frei setzen — `POST /api/media` nahm sogar
 * `isPublic: true` als Vorgabe. Damit liess sich jede hochgeladene Datei zu
 * einem öffentlichen Asset erklären. Beides ergibt sich jetzt aus dem
 * Profil, das der Server beim Ausstellen des Tickets selbst gewählt hat.
 *
 * **Das Profil ist trotzdem keine Berechtigung** (siehe Kopf von
 * `tickets.ts`): Es sagt, welche Dateien erlaubt sind und wohin sie fachlich
 * gehören — nicht, wer sie später lesen darf. Das entscheidet die Beziehung
 * zum Geschäftsobjekt.
 */
const PROFIL_ZUORDNUNG: Record<
  UploadProfile,
  { scope: FileScope; oeffentlich: boolean }
> = {
  // Öffentlich, weil sie auf der Website erscheinen: Das Team steht auf
  // „Über uns", Galerie und Kopfbilder auf den Leistungsseiten.
  gallery: { scope: 'GALLERY', oeffentlich: true },

  // Ein Profilbild ist nur dann öffentlich, wenn die Person zum Team gehört
  // — Mitarbeiterbilder erscheinen auf „Über uns". Das Bild einer Kundin
  // gehört dort nicht hin; die Unterscheidung trifft `zuordnungFuer`.
  avatar: { scope: 'EMPLOYEE', oeffentlich: true },

  jobPhoto: { scope: 'JOB', oeffentlich: false },
  bookingPhoto: { scope: 'BOOKING', oeffentlich: false },
  cv: { scope: 'APPLICATION', oeffentlich: false },
  document: { scope: 'DOCUMENT', oeffentlich: false },
  receipt: { scope: 'EXPENSE', oeffentlich: false },
  invoice: { scope: 'INVOICE', oeffentlich: false },
  quote: { scope: 'QUOTE', oeffentlich: false },
};

interface Zuordnung {
  scope: FileScope;
  oeffentlich: boolean;
  beziehung: { customerId?: string; employeeId?: string };
}

function zuordnungFuer(profile: UploadProfile, session: SessionUser | null): Zuordnung {
  const basis = PROFIL_ZUORDNUNG[profile];

  if (profile === 'avatar') {
    const istKundschaft = session?.role === 'CUSTOMER';
    return {
      scope: istKundschaft ? 'CUSTOMER' : 'EMPLOYEE',
      // Das Bild einer Kundin erscheint nirgends öffentlich. Es hier
      // mitzuveröffentlichen, nur weil Mitarbeiterbilder öffentlich sind,
      // wäre genau die Art stiller Ausweitung, die niemandem auffällt.
      oeffentlich: !istKundschaft,
      beziehung:
        session?.profileId && istKundschaft
          ? { customerId: session.profileId }
          : session?.profileId
            ? { employeeId: session.profileId }
            : {},
    };
  }

  return { ...basis, beziehung: {} };
}

/**
 * Hochgeladene Dateien an ein Geschäftsobjekt binden — **der eine Weg**
 * (2026-09-27).
 *
 * Bis dahin band jede Stelle selbst, und fast jede zu weit: Die Buchung und
 * der Ausgabenbeleg nahmen jede Datei der Organisation, deren Kennung jemand
 * kannte, und **überschrieben ihren Zweck** — eine Lohnabrechnung wurde zum
 * Beleg und für jede Rolle mit `expense:read` lesbar; die Kontaktformulare
 * setzten den Zweck fremder Dateien auf `OTHER`. Eine Kennung ist keine
 * Berechtigung.
 *
 * Gebunden wird jetzt nur, was **diese** Person hochgeladen hat, mit dem
 * Zweck, den das Upload-Profil für genau diese Verwendung vergibt, was noch
 * an keinem Objekt dieser Art hängt, abgeschlossen ist (Prüfsumme) und nicht
 * als schädlich oder unprüfbar gilt. Der Zweck wird nie umgeschrieben. Die
 * Bindung ist ein einziger bedingter Übergang; passt eine Kennung nicht,
 * scheitert der ganze Vorgang — eine still übergangene Kennung verdeckte
 * genau den Versuch, der hier abgewiesen wird.
 *
 * Noch nicht fertig geprüfte Dateien (PENDING, SCANNING) dürfen gebunden
 * werden: Ausgeliefert werden sie trotzdem erst, wenn der Prüfer sie für
 * sauber hält (`pruefeAuslieferung`).
 */
export async function dateienBinden(
  tx: Prisma.TransactionClient,
  p: {
    organizationId: string;
    fileIds: string[];
    uploadedById: string;
    scope: FileScope;
    /**
     * `jobId` seit F-09b (2026-09-27): Einsatzfotos banden bis dahin im
     * Routenhandler selbst, ohne Urheberschaft und Prüfbefund anzusehen.
     */
    ziel: 'bookingId' | 'expenseId' | 'messageId' | 'jobId';
    zielId: string;
  },
): Promise<void> {
  const ids = [...new Set(p.fileIds)];
  if (ids.length === 0) return;
  const gebunden = await tx.fileAsset.updateMany({
    where: {
      id: { in: ids },
      organizationId: p.organizationId,
      uploadedById: p.uploadedById,
      scope: p.scope,
      isPublic: false,
      checksum: { not: null },
      scanStatus: { notIn: ['INFECTED', 'QUARANTINED', 'ERROR'] },
      [p.ziel]: null,
    },
    data: { [p.ziel]: p.zielId },
  });
  if (gebunden.count !== ids.length) throw new NotFoundError('Datei');
}

export interface AbschlussErgebnis {
  fileAssetId: string;
  url: string;
  checksum: string;
  sizeBytes: number;
  mimeType: string;
  /** true, wenn dieser Aufruf den Abschluss vollzogen hat; false bei Wiederholung. */
  neu: boolean;
}

/**
 * Einen Upload abschliessen: prüfen, hashen, registrieren.
 *
 * Die Reihenfolge ist die aus der Vorgabe, und jeder Schritt hat einen
 * eigenen Grund:
 *
 *  1. Ticket laden — ohne Ticket gab es keine Genehmigung.
 *  2. Organisation abgleichen — ein Ticket einer fremden Organisation lässt
 *     sich nicht abschliessen, auch nicht mit gültiger Sitzung.
 *  3. Urheberschaft abgleichen — fremde Tickets gehören nicht mir.
 *  4. Ablauf prüfen.
 *  5. Bytes zurücklesen — *die* gespeicherten, nicht die gemeldeten.
 *  6. Grösse, Typ und Signatur gegen das Profil des Tickets prüfen.
 *  7. Prüfsumme bilden.
 *  8. In *einer* Transaktion: Ticket abschliessen und `FileAsset` anlegen.
 *
 * **Wiederholbarkeit.** Ein Browser, der beim Abschluss ein Zeitlimit sieht
 * und es erneut versucht, darf keine zweite Datei erzeugen. Zwei Wege
 * sichern das: Ein bereits abgeschlossenes Ticket liefert sein vorhandenes
 * Asset zurück, statt ein neues anzulegen; und für den Fall, dass zwei
 * Anfragen gleichzeitig durch diese Prüfung kommen, entscheidet der
 * eindeutige Index auf `FileAsset.storedFileId`. PostgreSQL bestimmt den
 * Gewinner, der Verlierer liest das Ergebnis des Gewinners.
 */
export async function finalizeUpload(params: {
  ticketId: string;
  organizationId: string;
  session: SessionUser | null;
  filename: string;
  ip?: string | null;
}): Promise<AbschlussErgebnis> {
  const ticket = await loadTicket(params.ticketId);
  if (!ticket) throw new NotFoundError('Upload');

  if (ticket.organizationId !== params.organizationId) {
    // Bewusst dieselbe Meldung wie bei „gibt es nicht": Ob ein Ticket einer
    // fremden Organisation existiert, geht niemanden etwas an.
    throw new NotFoundError('Upload');
  }

  /**
   * Wer das Ticket geholt hat, schliesst es ab.
   *
   * `uploadedById = null` steht für die beiden Wege ohne Anmeldung
   * (Buchungsfoto, Bewerbungsunterlage). Dort gibt es niemanden, gegen den
   * sich vergleichen liesse; die Kennung des Tickets ist in diesem einen
   * Fall tatsächlich alles, was es gibt — dafür kann daraus auch nur ein
   * Anhang ohne Fachbeziehung entstehen.
   */
  if (ticket.uploadedById && ticket.uploadedById !== params.session?.id) {
    throw new ForbiddenError('Dieser Upload gehört zu einer anderen Anmeldung.');
  }

  if (ticket.asset) {
    const vorhanden = await prisma.fileAsset.findUnique({
      where: { id: ticket.asset.id },
      select: { id: true, url: true, checksum: true, sizeBytes: true, mimeType: true },
    });
    if (vorhanden?.checksum) {
      return {
        fileAssetId: vorhanden.id,
        url: vorhanden.url,
        checksum: vorhanden.checksum,
        sizeBytes: vorhanden.sizeBytes,
        mimeType: vorhanden.mimeType,
        neu: false,
      };
    }
  }

  if (!ticket.profile) {
    throw new BusinessRuleError('Dieses Upload-Ticket kann nicht abgeschlossen werden.');
  }

  if (ticket.expiresAt.getTime() < Date.now()) {
    throw new BusinessRuleError('Dieser Upload ist abgelaufen. Bitte erneut hochladen.');
  }

  const bytes = await readStoredBytes({
    id: ticket.id,
    path: ticket.path,
    driver: ticket.driver,
  });

  if (!bytes) {
    throw new BusinessRuleError(
      'Zu diesem Upload liegt keine Datei vor. Bitte den Upload wiederholen.',
    );
  }

  // Die eine Prüfung, durch die jede angenommene Benutzerdatei geht.
  const befund = verifyBytes(ticket.profile as UploadProfile, ticket.mimeType, bytes);

  /**
   * Name und Endung, nachdem der Inhalt nachgewiesen ist.
   *
   * Die Reihenfolge ist Absicht: `verifyBytes` stellt fest, *was* die Datei
   * ist; erst danach lässt sich beurteilen, ob ihr Name dazu passt. Umgekehrt
   * würde man eine Endung gegen eine Behauptung prüfen.
   *
   * Der Fall, den das abfängt: Ein Inhalt, der nachweislich ein PDF ist, unter
   * dem Namen `rechnung.pdf.exe`. Im Speicher ist er harmlos — auf dem
   * Rechner der Person, die ihn herunterlädt, nicht. Windows blendet bekannte
   * Endungen standardmässig aus; im Ordner steht dann `rechnung.pdf`.
   */
  try {
    pruefeDateipolitik(params.filename, befund.mimeType);
  } catch (fehler) {
    /**
     * Die Ablehnung wird gemeldet und dann unverändert weitergeworfen.
     *
     * Der Grund für das Protokoll ist nicht die einzelne Datei — die ist
     * abgewiesen und damit erledigt. Es ist das Muster: Eine `.exe` unter
     * falschem Namen kommt gelegentlich versehentlich vorbei, zwanzig davon
     * aus derselben Sitzung nicht. Ohne Eintrag wäre der Unterschied für
     * niemanden sichtbar.
     *
     * Der Dateiname steht im Zusammenhang, weil er hier der Gegenstand ist.
     */
    await recordSecurityEvent({
      organizationId: ticket.organizationId,
      userId: params.session?.id ?? null,
      kind: 'FILE_POLICY_REJECTED',
      summary:
        fehler instanceof ValidationError
          ? fehler.message
          : 'Datei wegen Name, Endung oder Typ abgewiesen',
      context: { filename: params.filename, mimeType: befund.mimeType },
      ip: params.ip,
    });

    throw fehler;
  }

  const { scope, oeffentlich, beziehung } = zuordnungFuer(
    ticket.profile as UploadProfile,
    params.session,
  );

  const url = ticket.driver === 'SUPABASE' ? ticket.path : `/api/files/blob/${ticket.id}`;

  try {
    const asset = await prisma.$transaction(async (tx) => {
      await tx.storedFile.update({
        where: { id: ticket.id },
        data: {
          checksum: befund.checksum,
          // Die tatsächliche Grösse ersetzt die angekündigte. Beim externen
          // Treiber ist sie bis hierher 0 geblieben — der Server sah die
          // Datei ja erst jetzt.
          sizeBytes: befund.sizeBytes,
          uploadedAt: ticket.uploadedAt ?? new Date(),
        },
      });

      return tx.fileAsset.create({
        data: {
          organizationId: ticket.organizationId,
          scope,
          path: ticket.path,
          url,
          filename: params.filename,
          mimeType: befund.mimeType,
          sizeBytes: befund.sizeBytes,
          // Momentaufnahme der physischen Prüfsumme. Beide sind hier per
          // Konstruktion gleich und werden danach nie getrennt geändert.
          checksum: befund.checksum,
          isPublic: oeffentlich,
          storedFileId: ticket.id,
          uploadedById: params.session?.id ?? null,
          /**
           * Ausdrücklich, obwohl es die Vorgabe ist. Diese Zeile ist die
           * Gegenstelle zu `signature.service.ts` und `bi-report.service.ts`,
           * die `SYSTEM_GENERATED` setzen — wer den Abschluss liest, soll
           * sehen, dass hier bewusst die misstrauischste Einstufung steht.
           */
          provenance: 'USER_UPLOAD',
          scanStatus: 'PENDING',
          ...beziehung,
        },
        select: { id: true, url: true },
      });
    });

    await audit.created({
      organizationId: ticket.organizationId,
      userId: params.session?.id,
      entity: 'FileAsset',
      entityId: asset.id,
      summary: `Datei „${params.filename}" geprüft und übernommen (${Math.round(befund.sizeBytes / 1024)} kB, ${befund.mimeType})`,
      ip: params.ip,
    });

    /**
     * Der Prüflauf, gleich im Anschluss.
     *
     * **Warum hier und nicht in einer Warteschlange:** Die gibt es noch
     * nicht (Wave 6). `scanFileAsset` ist so gebaut, dass sie von dort
     * unverändert aufgerufen werden kann — sie nimmt eine Kennung und ist
     * beliebig oft ausführbar.
     *
     * **Warum der Abschluss trotzdem gelingt, wenn der Prüfer streikt:** Der
     * Upload ist angenommen und die Datei liegt fest; ob sie ausgeliefert
     * wird, entscheidet der Zustand, nicht dieser Aufruf. Eine Ausnahme hier
     * würde den Abschluss zurückrollen und den Browser eine bereits
     * gespeicherte Datei erneut hochladen lassen — und beim nächsten Versuch
     * genauso scheitern. Der Fehler gehört an die Datei, nicht an die
     * Antwort.
     */
    try {
      await scanFileAsset(asset.id);
    } catch (fehler) {
      log.error('Prüflauf nach dem Abschluss fehlgeschlagen', { fileAssetId: asset.id, fehler });
    }

    return {
      fileAssetId: asset.id,
      url: asset.url,
      checksum: befund.checksum,
      sizeBytes: befund.sizeBytes,
      mimeType: befund.mimeType,
      neu: true,
    };
  } catch (error) {
    /**
     * Der eindeutige Index hat zugeschlagen: Eine zweite Anfrage war
     * schneller. Das ist kein Fehler, sondern genau der Zweck des Index —
     * das Ergebnis der Gewinnerin ist auch unseres.
     */
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === 'P2002'
    ) {
      const vorhanden = await prisma.fileAsset.findUnique({
        where: { storedFileId: ticket.id },
        select: { id: true, url: true, checksum: true, sizeBytes: true, mimeType: true },
      });
      if (vorhanden?.checksum) {
        return {
          fileAssetId: vorhanden.id,
          url: vorhanden.url,
          checksum: vorhanden.checksum,
          sizeBytes: vorhanden.sizeBytes,
          mimeType: vorhanden.mimeType,
          neu: false,
        };
      }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
//  Schadsoftwareprüfung
// ---------------------------------------------------------------------------

export type ScanErgebnis =
  | { status: 'CLEAN' }
  | { status: 'INFECTED'; detectionName: string }
  | { status: 'ERROR'; code: string }
  | { status: 'QUARANTINED'; grund: string }
  /** Ein anderer Lauf hat die Datei bereits in Arbeit oder abgeschlossen. */
  | { status: 'UEBERSPRUNGEN'; grund: string };

/**
 * Eine Datei prüfen und ihren Zustand fortschreiben.
 *
 * ---------------------------------------------------------------------------
 *  Die Anspruchnahme — warum der erste Schritt ein UPDATE ist
 * ---------------------------------------------------------------------------
 *
 * Zwei Prüfläufe über dieselbe Datei sind kein hypothetischer Fall: Der
 * Abschluss stösst einen an, ein Wiederholungslauf einen zweiten, und ein
 * ungeduldiger Browser schickt den Abschluss ein drittes Mal. Ohne
 * Anspruchnahme schreiben sie am Ende in beliebiger Reihenfolge — und der
 * letzte gewinnt, auch wenn er der ältere Befund ist.
 *
 * Deshalb beginnt der Lauf mit einem bedingten `updateMany`: von `PENDING`
 * oder `ERROR` auf `SCANNING`. PostgreSQL entscheidet, wer zuerst kommt; wer
 * `count === 0` sieht, hat verloren und hört auf. Das ist dieselbe
 * Konstruktion wie beim Abschluss (`storedFileId` eindeutig) und bei der
 * Offertannahme (Teilindex) — die Nebenläufigkeit steht in der Datenbank,
 * nicht in der Anwendung.
 *
 * ---------------------------------------------------------------------------
 *  Die Hash-Gegenprobe — TOCTOU
 * ---------------------------------------------------------------------------
 *
 * Geprüft werden die Bytes, die wir **jetzt** lesen. Ausgeliefert werden die
 * Bytes, die **später** gelesen werden. Zwischen beidem liegt Zeit, und ein
 * Befund über andere Bytes als die ausgelieferten ist wertlos.
 *
 * Der Abschluss hat `FileAsset.checksum` gesetzt. Dieser Lauf rechnet die
 * Prüfsumme der gelesenen Bytes neu und vergleicht. Weichen sie ab, hat sich
 * die Datei nach dem Abschluss geändert — das darf auf keinem vorgesehenen
 * Weg passieren, und wenn es doch passiert, ist die Datei nicht
 * vertrauenswürdig. Sie geht dann nicht in `ERROR`, sondern direkt in
 * `QUARANTINED`: `ERROR` heisst „wir wissen nichts", hier wissen wir etwas.
 *
 * ---------------------------------------------------------------------------
 *  Warteschlangenfähig, aber ohne Warteschlange
 * ---------------------------------------------------------------------------
 *
 * Diese Funktion nimmt eine Kennung und gibt ein Ergebnis zurück. Sie hält
 * keinen Zustand, kennt keinen Auslöser und darf beliebig oft aufgerufen
 * werden. Wave 6 kann sie unverändert aus einer Warteschlange heraus
 * aufrufen; bis dahin ruft der Abschluss sie direkt. Eine zweite,
 * warteschlangenspezifische Fassung würde genau die Doppelpflege erzeugen,
 * die dieser Entwurf vermeidet.
 */
export async function scanFileAsset(fileAssetId: string): Promise<ScanErgebnis> {
  const asset = await prisma.fileAsset.findUnique({
    where: { id: fileAssetId },
    select: {
      id: true,
      organizationId: true,
      filename: true,
      mimeType: true,
      checksum: true,
      provenance: true,
      scanStatus: true,
      scanAttempts: true,
      // Für das Sicherheitsereignis: Bei einem Fund soll auf der Übersicht
      // stehen, über wessen Anmeldung die Datei hereinkam. `null` bei den
      // beiden Wegen ohne Anmeldung (Buchungsfoto, Bewerbungsunterlage).
      uploadedById: true,
      storedFile: { select: { id: true, path: true, driver: true } },
    },
  });

  if (!asset) return { status: 'UEBERSPRUNGEN', grund: 'unbekannt' };

  /**
   * Servererzeugte Artefakte gehen nicht durch den Prüfer.
   *
   * Nicht aus Bequemlichkeit: Ihre Bytes entstehen im selben Prozess aus
   * unseren eigenen Daten — ein Rechnungs-PDF, ein Rapport, ein
   * Signaturartefakt. Es gibt keinen Weg, auf dem fremder Inhalt
   * hineinkäme, ausser über einen Fehler in unserem eigenen Renderer, und
   * den würde ein Virenscanner nicht finden.
   *
   * Die Einstufung steht ausdrücklich in der Zeile (`provenance`), nicht in
   * einer Annahme über Dateitypen. „Alle PDF sind sauber" wäre genau die
   * pauschale Regel, die diese Unterscheidung vermeiden soll.
   */
  if (asset.provenance === 'SYSTEM_GENERATED' || asset.provenance === 'TRUSTED_IMPORT') {
    return { status: 'UEBERSPRUNGEN', grund: 'vertrauenswürdige Herkunft' };
  }

  if (asset.scanAttempts >= SCAN_MAX_ATTEMPTS && asset.scanStatus === 'ERROR') {
    return { status: 'UEBERSPRUNGEN', grund: 'Versuchsgrenze erreicht' };
  }

  // Anspruchnahme. Wer hier nichts trifft, hat verloren und hört auf.
  const beansprucht = await prisma.fileAsset.updateMany({
    where: { id: asset.id, scanStatus: { in: ['PENDING', 'ERROR'] } },
    data: { scanStatus: 'SCANNING', scanStartedAt: new Date(), scanAttempts: { increment: 1 } },
  });
  if (beansprucht.count === 0) {
    return { status: 'UEBERSPRUNGEN', grund: 'bereits in Arbeit oder abgeschlossen' };
  }

  const abschluss = async (
    daten: Prisma.FileAssetUpdateManyMutationInput,
  ): Promise<boolean> => {
    // Nur schreiben, solange *dieser* Lauf den Anspruch hält.
    const treffer = await prisma.fileAsset.updateMany({
      where: { id: asset.id, scanStatus: 'SCANNING' },
      data: daten,
    });
    return treffer.count > 0;
  };

  const scanner = getScanner();
  if (!scanner) {
    /**
     * Kein Prüfer eingerichtet. Die Datei bleibt liegen — sie wird **nicht**
     * durchgewunken. Das ist der eine Fall, in dem eine Zeile „dann eben
     * ohne Prüfung" die ganze Kette entwerten würde.
     */
    await abschluss({ scanStatus: 'ERROR', lastScanErrorCode: 'NO_SCANNER', scanner: null });

    /**
     * Ein Betriebszustand, kein Dateiproblem — deshalb `SCANNER_MISSING` und
     * nicht `FILE_SCAN_UNAVAILABLE`. Die Unterscheidung zählt: Bei „nicht
     * erreichbar" wartet man, bei „nicht eingerichtet" stellt man etwas ein.
     */
    await recordSecurityEvent({
      organizationId: asset.organizationId,
      kind: 'SCANNER_MISSING',
      summary: 'Datei angenommen, aber kein Prüfer eingerichtet — sie bleibt gesperrt',
      context: { fileAssetId: asset.id },
    });

    return { status: 'ERROR', code: 'NO_SCANNER' };
  }

  if (!asset.storedFile) {
    await abschluss({ scanStatus: 'ERROR', lastScanErrorCode: 'NO_BYTES' });
    return { status: 'ERROR', code: 'NO_BYTES' };
  }

  const bytes = await readStoredBytes({
    id: asset.storedFile.id,
    path: asset.storedFile.path,
    driver: asset.storedFile.driver,
  });

  if (!bytes) {
    await abschluss({ scanStatus: 'ERROR', lastScanErrorCode: 'NO_BYTES' });
    return { status: 'ERROR', code: 'NO_BYTES' };
  }

  // TOCTOU: Sind das noch dieselben Bytes wie beim Abschluss?
  const jetzt = sha256Hex(bytes);
  if (asset.checksum && jetzt !== asset.checksum) {
    await abschluss({
      scanStatus: 'QUARANTINED',
      quarantinedAt: new Date(),
      lastScanErrorCode: 'CHECKSUM_MISMATCH',
      scanner: scanner.name,
    });
    await audit.denied({
      organizationId: asset.organizationId,
      entity: 'FileAsset',
      entityId: asset.id,
      summary: 'Datei in Quarantäne: Die Bytes weichen von der beim Abschluss gebildeten Prüfsumme ab.',
    });
    /**
     * Der schwerere der beiden Quarantänefälle. Ein Fund heisst, der Prüfer
     * hat gearbeitet. Veränderte Bytes heissen, jemand hatte Zugriff auf die
     * Ablage — und dann ist diese eine Datei die kleinere Frage.
     */
    await recordSecurityEvent({
      organizationId: asset.organizationId,
      kind: 'FILE_QUARANTINED',
      summary:
        'Die gespeicherten Bytes weichen von der beim Abschluss gebildeten Prüfsumme ab — Datei isoliert',
      context: { fileAssetId: asset.id, filename: asset.filename, grund: 'CHECKSUM_MISMATCH' },
    });

    log.error('Prüfsumme weicht ab — Datei in Quarantäne', { fileAssetId: asset.id });
    return { status: 'QUARANTINED', grund: 'CHECKSUM_MISMATCH' };
  }

  const version = await scanner.version();
  const befund = await scanner.scan(bytes, { filename: asset.filename });

  if (befund.ergebnis === 'clean') {
    await abschluss({
      scanStatus: 'CLEAN',
      scannedAt: new Date(),
      scanner: scanner.name,
      scannerVersion: version,
      lastScanErrorCode: null,
    });
    return { status: 'CLEAN' };
  }

  if (befund.ergebnis === 'infected') {
    const name = befund.detectionName ?? 'unbenannt';
    /**
     * Fund heisst sofort Quarantäne, nicht erst `INFECTED` und später
     * jemand-räumt-auf. Zwischen beidem läge ein Zeitraum, in dem der
     * Zustand „bekannt schädlich" bereits feststeht und die Isolierung noch
     * nicht — und genau in diesem Zeitraum würde jemand die Datei abrufen.
     */
    await abschluss({
      scanStatus: 'QUARANTINED',
      scannedAt: new Date(),
      quarantinedAt: new Date(),
      scanner: scanner.name,
      scannerVersion: version,
      detectionName: name,
    });
    await audit.denied({
      organizationId: asset.organizationId,
      entity: 'FileAsset',
      entityId: asset.id,
      summary: `Schadsoftware gefunden (${name}) — Datei in Quarantäne.`,
    });
    await recordSecurityEvent({
      organizationId: asset.organizationId,
      userId: asset.uploadedById ?? null,
      kind: 'FILE_SCAN_INFECTED',
      summary: `Schadsoftware gefunden (${name}) — Datei isoliert`,
      context: {
        fileAssetId: asset.id,
        filename: asset.filename,
        detectionName: name,
        scanner: scanner.name,
      },
    });

    log.error('Schadsoftware gefunden', { fileAssetId: asset.id, detectionName: name });
    return { status: 'INFECTED', detectionName: name };
  }

  const code = befund.fehlerCode ?? 'UNKNOWN';
  await abschluss({
    scanStatus: 'ERROR',
    scanner: scanner.name,
    scannerVersion: version,
    lastScanErrorCode: code,
  });
  /**
   * Nur nach dem **letzten** Versuch. Ein Fehlschlag mitten in der Reihe
   * erzeugt kein Ereignis: Ein kurzer Netzaussetzer meldete sonst für jede
   * gerade hochgeladene Datei eine Zeile, und ein Protokoll, das bei einer
   * Störung überläuft, wird beim nächsten Mal nicht mehr gelesen.
   *
   * `scanAttempts` ist zu Beginn dieses Laufs bereits erhöht worden — der
   * Vergleich `>=` trifft also den Lauf, nach dem nichts mehr folgt.
   */
  if (asset.scanAttempts + 1 >= SCAN_MAX_ATTEMPTS) {
    await recordSecurityEvent({
      organizationId: asset.organizationId,
      kind: 'FILE_SCAN_UNAVAILABLE',
      summary: `Prüfung nach ${SCAN_MAX_ATTEMPTS} Versuchen ohne Ergebnis (${code}) — Datei bleibt gesperrt`,
      context: { fileAssetId: asset.id, filename: asset.filename, code },
    });
  }

  log.warn('Prüflauf ohne Ergebnis', { fileAssetId: asset.id, code });
  return { status: 'ERROR', code };
}

/**
 * Der wiederkehrende Nachlauf über Dateien ohne Befund.
 *
 * ---------------------------------------------------------------------------
 *  Wofür
 * ---------------------------------------------------------------------------
 *
 * Zwei Sorten Dateien liegen gesperrt herum und kommen nicht von selbst frei:
 *
 *  • **Altbestand** aus der Zeit vor der Prüfung (`LEGACY_UNSCANNED`). Die
 *    Migration hat sie ehrlich als ungeprüft markiert — das ist richtig und
 *    hat die Folge, dass sie nicht mehr abrufbar sind.
 *  • **Fälle, bei denen der Prüfer beim Abschluss nicht erreichbar war**
 *    (`ERROR`). Der Upload ist durch, die Datei liegt fest, und niemand hat
 *    je wieder hingesehen.
 *
 * Bis Wave 6 gab es dafür nur `scripts/scan-backfill.ts` — einen Lauf von
 * Hand. Der ist richtig für eine einmalige Umstellung und falsch für einen
 * Zustand, der jeden Tag neu entsteht: Wer soll ihn täglich starten?
 *
 * ---------------------------------------------------------------------------
 *  Warum begrenzt
 * ---------------------------------------------------------------------------
 *
 * Ein Nachtlauf, der zehntausend Dateien durch den Prüfer schiebt, ist selbst
 * eine Störung — er bindet den Prüfer, die Datenbank und das Zeitfenster des
 * Schedulers. Begrenzt wird deshalb, was ein Lauf anfasst; der Rest kommt in
 * der nächsten Nacht. `scanFileAsset` beansprucht jede Datei einzeln, also
 * stören sich zwei Läufe auch dann nicht, wenn sie sich überschneiden.
 */
export async function runScanNachlauf(
  organizationId: string,
  limit = 200,
): Promise<{ geprueft: number; sauber: number; befund: number; ohneErgebnis: number }> {
  const offen = await prisma.fileAsset.findMany({
    where: {
      organizationId,
      provenance: { in: ['LEGACY_UNSCANNED', 'USER_UPLOAD'] },
      scanStatus: { in: ['PENDING', 'ERROR'] },
      scanAttempts: { lt: SCAN_MAX_ATTEMPTS },
    },
    // Die ältesten zuerst: Was am längsten gesperrt liegt, wartet am längsten.
    orderBy: { createdAt: 'asc' },
    take: Math.min(limit, 1000),
    select: { id: true },
  });

  const zahlen = { geprueft: 0, sauber: 0, befund: 0, ohneErgebnis: 0 };

  for (const { id } of offen) {
    const ergebnis = await scanFileAsset(id);
    zahlen.geprueft += 1;
    if (ergebnis.status === 'CLEAN') zahlen.sauber += 1;
    else if (ergebnis.status === 'INFECTED' || ergebnis.status === 'QUARANTINED') {
      zahlen.befund += 1;
    } else if (ergebnis.status === 'ERROR') zahlen.ohneErgebnis += 1;
  }

  return zahlen;
}

/**
 * Die Auslieferungsentscheidung steht in `lib/security/malware/auslieferung.ts`
 * und wird hier nur weitergereicht.
 *
 * Sie ist eine reine Funktion von Prüfstand und Herkunft — kein
 * Datenbankzugriff, keine Sitzung. Dieses Modul trägt `server-only`; dort
 * stünde die Regel ohne laufenden Server nicht zur Prüfung zur Verfügung, und
 * eine Regel dieser Tragweite ungeprüft zu lassen wäre der falsche Handel.
 */
export { darfAusgeliefertWerden } from '@/lib/security/malware/auslieferung';

// ---------------------------------------------------------------------------
//  Autorisierung
// ---------------------------------------------------------------------------

/** Was die Ausgaberoute über eine Datei wissen muss. */
export interface DateiFreigabe {
  storedFileId: string;
  mimeType: string;
  filename: string;
  isPublic: boolean;
  /**
   * Seit F-09 c: woher die Bytes kommen und woran sie gemessen werden. Die
   * Route liest nicht mehr selbst (sie kannte nur die Rückfallebene), sondern
   * übergibt diese Freigabe an `liesFreigegebeneDatei`.
   */
  fileAssetId: string;
  organizationId: string;
  assetChecksum: string | null;
  ablage: { id: string; path: string; driver: 'LOCAL' | 'SUPABASE'; checksum: string | null };
}

const MIT_BEZIEHUNGEN = {
  id: true,
  scope: true,
  isPublic: true,
  filename: true,
  mimeType: true,
  organizationId: true,
  storedFileId: true,
  uploadedById: true,
  // Für die Auslieferungssperre. Sie steht neben der Berechtigung, nicht in
  // ihr: Eine infizierte Datei bleibt infiziert, auch für die Geschäftsleitung.
  scanStatus: true,
  provenance: true,
  employeeId: true,
  customerId: true,
  jobId: true,
  bookingId: true,
  invoiceId: true,
  quoteId: true,
  expenseId: true,
  messageId: true,
  applicationId: true,
  propertyId: true,
  // Für den Leseweg nach der Freigabe (F-09 c): Treiber, Pfad und beide
  // Prüfsummen. Sie entscheiden nichts über die Berechtigung.
  checksum: true,
  storedFile: { select: { id: true, path: true, driver: true, checksum: true } },
} as const;

type AssetMitBeziehungen = Prisma.FileAssetGetPayload<{ select: typeof MIT_BEZIEHUNGEN }>;

/**
 * Darf diese Sitzung diese Datei lesen?
 *
 * **Die Regel, die vorher fehlte.** Bis Gate 2 lautete die Antwort: „Wer die
 * Kennung kennt, bekommt die Datei." Jetzt führt der Weg von der Datei
 * rückwärts zum Geschäftsobjekt und von dort zur Rolle — dieselbe Prüfung,
 * die auch die Seite anwenden würde, auf der die Datei erscheint.
 *
 * Eigentümerschaft steht dabei in der Bedingung, nicht in der Anzeige: Eine
 * Mitarbeiterin sieht die Fotos ihrer Einsätze, nicht die aller.
 */
async function darfLesen(
  asset: AssetMitBeziehungen,
  session: SessionUser | null,
): Promise<boolean> {
  if (asset.isPublic) return true;
  if (!session) return false;
  if (session.organizationId !== asset.organizationId) return false;

  // Wer eine Datei selbst hochgeladen hat, darf sie ansehen. Das deckt die
  // Fälle ab, in denen die Fachbeziehung erst später entsteht — eine
  // Bewerbungsunterlage etwa hängt vor dem Absenden an nichts.
  if (asset.uploadedById && asset.uploadedById === session.id) return true;

  const rolle = session.role;

  switch (asset.scope) {
    case 'EMPLOYEE':
      return asset.employeeId === session.profileId || can(rolle, 'employee:read');
    case 'CUSTOMER':
      // Die eigene Akte, oder Büro. `customer:read` hält auch das Personal —
      // für die Adresse eines Einsatzes, nicht für die Unterlagen jeder
      // Kundschaft (2026-09-27; dieselbe Linie wie `propertyVisibilityWhere`).
      if (rolle === 'CUSTOMER') return asset.customerId === session.profileId;
      return can(rolle, 'customer:read') && rolle !== 'EMPLOYEE';
    case 'JOB':
      if (can(rolle, 'job:read')) return true;
      return istEinsatzBeteiligt(asset, session);
    case 'BOOKING':
      if (can(rolle, 'booking:read')) return true;
      return istBuchungsEigentuemer(asset, session);
    case 'INVOICE':
      return can(rolle, 'invoice:read');
    case 'QUOTE':
      return can(rolle, 'quote:read');
    case 'EXPENSE':
      return can(rolle, 'expense:read');
    case 'MESSAGE':
      return can(rolle, 'message:read');
    case 'APPLICATION':
      return can(rolle, 'application:read');
    case 'PROPERTY':
      /*
        Nach der Beziehung, nicht nach der Berechtigung (2026-09-27).
        `property:read` hält auch die **Kundschaft** — für die eigenen
        Objekte. Hier genügte sie allein: Jede Kundschaft las mit einer
        Kennung die Objektunterlagen jeder anderen Kundschaft derselben
        Organisation (Grundrisse, Schlüsselfotos). Jetzt gilt dieselbe Regel
        wie für das Objekt selbst (`propertyVisibilityWhere`): Büro alles,
        Kundschaft die eigenen, Personal die seiner Einsätze.
      */
      if (!asset.propertyId) return can(rolle, 'property:read') && rolle !== 'CUSTOMER' && rolle !== 'EMPLOYEE';
      return (
        (await prisma.property.count({
          where: { id: asset.propertyId, ...propertyVisibilityWhere(session, asset.organizationId) },
        })) > 0
      );
    case 'DOCUMENT':
      /*
        Verwaltete Dokumente haben eine eigene Sichtbarkeit
        (`EMPLOYEE_PRIVATE`: nur Leitung und die betroffene Person). Die
        Dateiroute kannte sie nicht — sie prüfte nur `document:read`, und wer
        die Kennung einer Fassung kannte, umging die Sichtbarkeit (so stand es
        bis 2026-09-27 sogar in `storage/index.ts`). Hängt die Datei an einer
        Dokumentfassung, entscheidet jetzt dieselbe Bedingung wie die Liste.
      */
      {
        const fassung = await prisma.documentVersion.findFirst({
          where: { fileAssetId: asset.id },
          select: { documentId: true },
        });
        if (fassung) {
          return (
            (await prisma.managedDocument.count({
              where: { id: fassung.documentId, ...documentVisibilityWhere(session, asset.organizationId) },
            })) > 0
          );
        }
        return can(rolle, 'document:read');
      }
    case 'REPORT':
      return can(rolle, 'report:read');
    case 'OBJECTIVE':
    case 'INVESTMENT':
    case 'RISK':
    case 'CONTROL':
    case 'ARTICLE':
    case 'MEETING':
      return can(rolle, 'document:read');
    case 'PAYROLL':
      /**
       * Lohnabrechnungen und Lohnausweise. Über den allgemeinen Dateiweg nur
       * mit Einsicht in **alle** Abrechnungen — ohne diesen Fall wäre die
       * Datei unter `default` mit `media:read` gelandet, und das hält auch die
       * Betriebsleitung, die bewusst keinen Lohneinblick hat. Die eigene
       * Abrechnung holt die angestellte Person über
       * `/api/payroll/payslips/:id/pdf`, wo die Eigentümerschaft in der
       * Abfrage steht.
       */
      return can(rolle, 'payslip:read_all');
    case 'BLOG':
    case 'GALLERY':
      // Diese beiden sind öffentlich, wenn sie öffentlich sein sollen. Steht
      // `isPublic` auf false, war das eine Entscheidung — und dann bleibt es
      // bei der Redaktionsberechtigung.
      return can(rolle, 'media:read');
    case 'OTHER':
    default:
      // Unbekannter oder unzugeordneter Bereich: fail closed. Lieber eine
      // Datei zu wenig ausliefern als eine zu viel.
      return can(rolle, 'media:read');
  }
}

/**
 * Einsatzfotos für die tatsächlich zugeteilte Person.
 *
 * **`job:read_assigned` allein genügt nicht.** Die Berechtigung sagt „darf
 * die eigenen Einsätze sehen", nicht „darf *diesen* Einsatz sehen". Wer sie
 * hält, hält sie für alle Einsätze; die Einschränkung entsteht erst aus der
 * Zuteilung. Sie hier nicht abzufragen hiesse, jeder Person im Betrieb die
 * Fotos jedes Einsatzes zu öffnen — eine Berechtigungsprüfung, die sich
 * richtig liest und nichts prüft.
 */
async function istEinsatzBeteiligt(
  asset: AssetMitBeziehungen,
  session: SessionUser,
): Promise<boolean> {
  if (!asset.jobId || !session.profileId) return false;
  if (!can(session.role, 'job:read_assigned')) return false;

  const zuteilung = await prisma.jobAssignment.findFirst({
    where: { jobId: asset.jobId, employeeId: session.profileId },
    select: { id: true },
  });
  return zuteilung !== null;
}

/**
 * Buchungsanhänge für die Kundschaft, der die Buchung gehört.
 *
 * Dieselbe Überlegung wie beim Einsatz: `booking:read_own` beantwortet nicht,
 * *welche* Buchung. Das tut nur die Buchung selbst.
 */
async function istBuchungsEigentuemer(
  asset: AssetMitBeziehungen,
  session: SessionUser,
): Promise<boolean> {
  if (!asset.bookingId || !session.profileId) return false;
  if (!can(session.role, 'booking:read_own')) return false;

  const buchung = await prisma.booking.findFirst({
    where: { id: asset.bookingId, customerId: session.profileId },
    select: { id: true },
  });
  return buchung !== null;
}

/**
 * Die Datei hinter einer `StoredFile`-Kennung freigeben — oder eben nicht.
 *
 * `null` heisst in jedem Fall „nicht erreichbar", ohne zu verraten, woran es
 * lag: Eine Kennung, die es nicht gibt, und eine, die einer fremden Datei
 * gehört, müssen sich gleich anfühlen. Sonst wäre die Route ein Orakel dafür,
 * welche Kennungen existieren.
 */
export async function authorizeStoredFile(
  storedFileId: string,
  session: SessionUser | null,
): Promise<DateiFreigabe | null> {
  /*
    Die Organisation dieser Installation im `where` (2026-09-27). Vorher
    suchte die Freigabe nur nach der Kennung, und `darfLesen` gab eine
    öffentliche Datei vor jeder Organisationsprüfung frei — die öffentlichen
    Bilder einer fremden Organisation wurden hier ausgeliefert, angemeldet wie
    anonym. „Öffentlich" heisst „öffentlich auf der eigenen Website", nicht
    „über jede Installation erreichbar". Eine fremde Datei ist damit, wie
    überall, schlicht nicht gefunden.
  */
  const asset = await prisma.fileAsset.findFirst({
    where: { storedFileId, organizationId: await getOrganizationId() },
    select: MIT_BEZIEHUNGEN,
  });

  /**
   * Ohne `FileAsset` gibt es keine fachliche Grundlage für eine Freigabe.
   *
   * Betroffen sind zwei Gruppen: Zeilen aus der Zeit vor Gate 2, deren
   * Zuordnung nie festgehalten wurde, und servererzeugte Dateien wie
   * Rechnungs-PDF, die bewusst keine fachliche Registrierung haben. Beide
   * bleiben über diesen Weg verschlossen. Die PDF erreicht man über die
   * Rechnung — angemeldet oder über einen `PublicAccessToken` —, und dieser
   * Weg prüft die Berechtigung selbst. Eine zweite, schwächere Tür daneben
   * wäre genau das Problem, das Gate 2 beseitigt.
   */
  if (!asset || !asset.storedFileId || !asset.storedFile) return null;

  if (!(await darfLesen(asset, session))) return null;

  /**
   * Die zweite Tür: Berechtigung **und** Prüfstand.
   *
   * Sie steht hinter der Berechtigungsprüfung, nicht davor — und zwar aus
   * demselben Grund, aus dem `null` nicht sagt, woran es lag: Wer keinen
   * Zugriff auf die Datei hat, soll auch nicht erfahren, dass sie in
   * Quarantäne liegt. Das wäre eine Auskunft über fremde Daten.
   *
   * `null` in beiden Fällen. Die Route unterscheidet sie nicht, weil sie den
   * Unterschied nicht preisgeben soll.
   */
  const freigabe = pruefeAuslieferung(asset);
  if (!freigabe.erlaubt) {
    log.warn('Datei nicht ausgeliefert', {
      fileAssetId: asset.id,
      grund: freigabe.grund,
    });
    return null;
  }

  if (freigabe.grund === 'LEGACY_ALLOWED') {
    /**
     * Jeder Zugriff auf ungeprüften Altbestand wird festgehalten. Das ist
     * der Preis der Übergangseinstellung: Sie ist zulässig, aber nicht
     * unbemerkt.
     */
    log.warn('Ungeprüfter Altbestand ausgeliefert (CLENARIS_LEGACY_FILES=allow)', {
      fileAssetId: asset.id,
    });
  }

  return {
    storedFileId: asset.storedFileId,
    mimeType: asset.mimeType,
    filename: asset.filename,
    isPublic: asset.isPublic,
    fileAssetId: asset.id,
    organizationId: asset.organizationId,
    assetChecksum: asset.checksum,
    ablage: asset.storedFile,
  };
}

/**
 * Die Bytes einer freigegebenen Datei — aus dem Treiber, in dem sie liegen,
 * und nur, wenn sie noch die sind, die abgelegt wurden (F-09 c, 2026-09-27).
 *
 * **Warum das hier steht und nicht in der Route.** Die Route las bis dahin
 * selbst, und zwar nur die Rückfallebene. Mit Supabase fand sie für jede
 * private Datei keine Bytes — der berechtigte Leseweg fehlte, und die
 * einzige Adresse, die zu solchen Dateien gespeichert war, war die
 * öffentliche. Jetzt gilt: Die Berechtigung entscheidet `authorizeStoredFile`
 * (samt Prüfstand), die Bytes holt `leseAblageGeprueft` aus dem richtigen
 * Speicher, und was aus einer Abweichung folgt, entscheidet dieser Dienst —
 * weil nur er Protokoll und Quarantäne führt.
 *
 * **Fail closed.** `null` für „nicht auslieferbar", in jedem der drei Fälle:
 * Die Bytes fehlen, sie weichen von der Prüfsumme ab, oder die beiden
 * Datensätze widersprechen sich. Die Route macht daraus dieselbe 404 wie für
 * eine fremde Datei. Wer die Freigabe schon hat, erfährt dadurch nichts
 * Neues über fremde Daten; er bekommt nur keine Bytes, für die niemand mehr
 * einstehen kann.
 *
 * **Veränderte Bytes gehen in Quarantäne** — dieselbe Folge wie im Prüflauf
 * (`scanFileAsset`, Abschnitt „Hash-Gegenprobe"), aus demselben Grund: Die
 * Ablage wurde nach dem Abschluss verändert, und das darf auf keinem
 * vorgesehenen Weg passieren. Der Übergang ist bedingt (`scanStatus` noch
 * nicht `QUARANTINED`), damit hundert Abrufe einer veränderten Datei ein
 * Ereignis erzeugen und nicht hundert. Bei servererzeugten Dateien sperrt der
 * Zustand die Auslieferung nicht (`darfAusgeliefertWerden` entscheidet dort
 * über die Herkunft) — gesperrt bleibt sie trotzdem, weil diese Gegenprobe
 * bei jedem Abruf erneut scheitert, solange die Bytes nicht stimmen.
 *
 * Ein **Widerspruch** der Datensätze löst dagegen keine Quarantäne aus: Er
 * entsteht auch ohne fremden Zugriff für einen Augenblick, wenn ein
 * Signaturartefakt neu abgelegt und sein `FileAsset` erst danach
 * nachgeführt wird. Verweigert wird trotzdem; das Protokoll hält es fest.
 */
export async function liesFreigegebeneDatei(freigabe: DateiFreigabe): Promise<Buffer | null> {
  const gelesen = await leseAblageGeprueft(freigabe.ablage, freigabe.assetChecksum);

  if (gelesen.status === 'ok') {
    if (gelesen.pruefung === 'ungeprueft') {
      // Nur Altbestand ohne Prüfsumme kommt hierher, und über den hat
      // `darfAusgeliefertWerden` bereits entschieden. Festgehalten wird es
      // trotzdem: Diese Auslieferung trägt keine Integritätszusicherung.
      log.warn('Datei ohne Prüfsumme ausgeliefert', { fileAssetId: freigabe.fileAssetId });
    }
    return gelesen.bytes;
  }

  if (gelesen.status === 'fehlt') {
    log.warn('Freigegebene Datei ohne Bytes im Speicher', {
      fileAssetId: freigabe.fileAssetId,
      treiber: freigabe.ablage.driver,
    });
    return null;
  }

  if (gelesen.status === 'widerspruch') {
    log.error('Prüfsummen von Ablage und Datei widersprechen sich — nicht ausgeliefert', {
      fileAssetId: freigabe.fileAssetId,
    });
    return null;
  }

  // Abweichung: Die Bytes im Speicher sind nicht mehr die abgelegten.
  log.error('Prüfsumme beim Abruf weicht ab — nicht ausgeliefert, Datei in Quarantäne', {
    fileAssetId: freigabe.fileAssetId,
    treiber: freigabe.ablage.driver,
  });
  const isoliert = await prisma.fileAsset.updateMany({
    where: { id: freigabe.fileAssetId, scanStatus: { not: 'QUARANTINED' } },
    data: {
      scanStatus: 'QUARANTINED',
      quarantinedAt: new Date(),
      lastScanErrorCode: 'CHECKSUM_MISMATCH',
    },
  });
  if (isoliert.count > 0) {
    await audit.denied({
      organizationId: freigabe.organizationId,
      entity: 'FileAsset',
      entityId: freigabe.fileAssetId,
      summary: 'Datei in Quarantäne: Die Bytes im Speicher weichen beim Abruf von der beim Ablegen gebildeten Prüfsumme ab.',
    });
    await recordSecurityEvent({
      organizationId: freigabe.organizationId,
      kind: 'FILE_QUARANTINED',
      summary:
        'Die gespeicherten Bytes weichen beim Abruf von der Prüfsumme ab — Datei isoliert, nicht ausgeliefert',
      context: {
        fileAssetId: freigabe.fileAssetId,
        filename: freigabe.filename,
        grund: 'CHECKSUM_MISMATCH',
        treiber: freigabe.ablage.driver,
      },
    });
  }
  return null;
}

/**
 * Freigabe für die interne serverseitige Verarbeitung.
 *
 * Der PDF-Renderer und der Berichtslauf greifen auf Dateien zu, ohne dass
 * eine Sitzung im Spiel wäre. Sie gehen ausdrücklich über diese Funktion und
 * nicht über die HTTP-Route — damit im Code sichtbar bleibt, wo eine Prüfung
 * bewusst übersprungen wird.
 */
export async function readInternal(storedFileId: string) {
  return prisma.storedFile.findUnique({
    where: { id: storedFileId },
    select: { data: true, mimeType: true, sizeBytes: true, path: true, checksum: true },
  });
}

// ---------------------------------------------------------------------------
//  Integrität
// ---------------------------------------------------------------------------

export type IntegritaetsBefund =
  | { status: 'ok'; checksum: string }
  | { status: 'ungeprueft'; grund: string }
  | { status: 'fehlt'; grund: string }
  | { status: 'abweichung'; erwartet: string; tatsaechlich: string };

/**
 * Stimmen die gespeicherten Bytes noch mit der Prüfsumme überein?
 *
 * **`ungeprueft` ist nicht `ok`.** Dateien aus der Zeit vor Gate 2 tragen
 * keine Prüfsumme. Sie hier stillschweigend durchzuwinken hiesse, eine
 * Zusicherung zu geben, für die es keine Grundlage gibt — und genau das war
 * der Fehler, den dieses Gate behebt. Der Status sagt, was Sache ist.
 */
export async function verifyFileIntegrity(fileAssetId: string): Promise<IntegritaetsBefund> {
  const asset = await prisma.fileAsset.findUnique({
    where: { id: fileAssetId },
    select: {
      checksum: true,
      path: true,
      storedFile: { select: { id: true, path: true, driver: true, checksum: true } },
    },
  });

  if (!asset) throw new NotFoundError('Datei');

  const erwartet = asset.storedFile?.checksum ?? asset.checksum;
  if (!erwartet) {
    return {
      status: 'ungeprueft',
      grund: 'Diese Datei stammt aus der Zeit vor der Byteprüfung und trägt keine Prüfsumme.',
    };
  }

  if (!asset.storedFile) {
    return {
      status: 'ungeprueft',
      grund: 'Zu dieser Datei ist keine physische Ablage verknüpft.',
    };
  }

  const bytes = await readStoredBytes(asset.storedFile);
  if (!bytes) {
    return { status: 'fehlt', grund: 'Die hinterlegte Datei ist nicht mehr auffindbar.' };
  }

  const tatsaechlich = sha256Hex(bytes);

  if (tatsaechlich !== erwartet) {
    return { status: 'abweichung', erwartet, tatsaechlich };
  }

  return { status: 'ok', checksum: erwartet };
}

/** Eine Datei fachlich einem Geschäftsobjekt zuordnen — nach dem Abschluss. */
export async function linkFileAsset(params: {
  fileAssetId: string;
  organizationId: string;
  relation: Partial<
    Record<
      | 'bookingId'
      | 'jobId'
      | 'invoiceId'
      | 'quoteId'
      | 'expenseId'
      | 'messageId'
      | 'applicationId'
      | 'customerId'
      | 'employeeId'
      | 'propertyId',
      string
    >
  >;
}): Promise<void> {
  const treffer = await prisma.fileAsset.updateMany({
    where: {
      id: params.fileAssetId,
      organizationId: params.organizationId,
      // Nur abgeschlossene Dateien lassen sich verknüpfen. Ohne diese
      // Bedingung könnte ein nicht geprüftes Objekt doch noch an einem
      // Geschäftsobjekt landen — der Umweg um die Sicherheitsgrenze.
      checksum: { not: null },
    },
    data: params.relation,
  });

  if (treffer.count === 0) {
    throw new ValidationError('Diese Datei ist nicht verfügbar.');
  }
}
