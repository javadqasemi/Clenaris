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
import { readStoredBytes, verifyBytes, type UploadProfile } from '@/lib/storage';
import { loadTicket } from '@/lib/storage/tickets';

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
//  Autorisierung
// ---------------------------------------------------------------------------

/** Was die Ausgaberoute über eine Datei wissen muss. */
export interface DateiFreigabe {
  storedFileId: string;
  mimeType: string;
  filename: string;
  isPublic: boolean;
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
      return asset.customerId === session.profileId || can(rolle, 'customer:read');
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
      return can(rolle, 'property:read');
    case 'DOCUMENT':
      return can(rolle, 'document:read');
    case 'REPORT':
      return can(rolle, 'report:read');
    case 'OBJECTIVE':
    case 'INVESTMENT':
    case 'RISK':
    case 'CONTROL':
    case 'ARTICLE':
    case 'MEETING':
      return can(rolle, 'document:read');
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
  const asset = await prisma.fileAsset.findFirst({
    where: { storedFileId },
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
  if (!asset || !asset.storedFileId) return null;

  if (!(await darfLesen(asset, session))) return null;

  return {
    storedFileId: asset.storedFileId,
    mimeType: asset.mimeType,
    filename: asset.filename,
    isPublic: asset.isPublic,
  };
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
