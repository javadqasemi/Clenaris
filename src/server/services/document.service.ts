import 'server-only';

import type { DocumentVisibility, FileProvenance, FileScanStatus, Prisma } from '@prisma/client';
import { darfAusgeliefertWerden as pruefeAuslieferung } from '@/lib/security/malware/auslieferung';

import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import { can } from '@/lib/auth/rbac';
import type { SessionUser } from '@/lib/auth/session';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import {
  createSignedDownloadUrl,
  leseAblageGeprueft,
  readLocalBytes,
  readStoredBytes,
  usesRemoteStorage,
  type Dateiauslieferung,
} from '@/lib/storage';
import { addDays, today } from '@/lib/bi/periods';
import type { AddDocumentVersionInput, CreateDocumentInput, UpdateDocumentInput } from '@/lib/validation/bi-knowledge';
import { notify } from './notification.service';

/**
 * Dokumentenablage.
 *
 * **Die heikelste Stelle des Moduls.** Die Ablage nimmt Verträge, Policen,
 * Personaldokumente und Steuerunterlagen auf; ein Fehler hier ist sofort ein
 * Datenschutzvorfall, kein Anzeigefehler. Deshalb:
 *
 *  • Die Sichtbarkeit wirkt in der Prisma-`where`-Klausel (`visibilityWhere`),
 *    nie im Rendering. Verstecktes HTML steht trotzdem auf der Leitung.
 *  • `EMPLOYEE_PRIVATE` heisst Geschäftsleitung *und betroffene Person* —
 *    nicht „alle Mitarbeitenden". Die Betriebsleitung sieht Personaldokumente
 *    nicht, ausser es sind ihre eigenen.
 *  • Jeder Download wird protokolliert (`audit.exported`). Wer wann eine
 *    Police oder einen Arbeitsvertrag geöffnet hat, ist die Frage, die nach
 *    einem Vorfall gestellt wird.
 *  • Personaldokumente werden ohne ausdrückliche Angabe `EMPLOYEE_PRIVATE`.
 *    Ein Standardwert, den man im Formular übersehen kann, wird übersehen.
 */

export function documentVisibilityWhere(session: SessionUser, organizationId: string): Prisma.ManagedDocumentWhereInput {
  const base: Prisma.ManagedDocumentWhereInput = { organizationId, deletedAt: null };
  const own: Prisma.ManagedDocumentWhereInput | null = session.profileId
    ? { visibility: 'EMPLOYEE_PRIVATE', subjectEmployeeId: session.profileId }
    : null;

  if (can(session.role, 'document:read')) {
    if (session.role === 'SUPER_ADMIN' || session.role === 'ADMIN') return base;
    // Betriebsleitung: alles bis OPERATIONS, dazu die eigene Personalakte.
    return { ...base, OR: [{ visibility: { in: ['OPERATIONS', 'STAFF'] } }, ...(own ? [own] : [])] };
  }
  if (can(session.role, 'document:read_own')) {
    return { ...base, OR: [{ visibility: 'STAFF' }, ...(own ? [own] : [])] };
  }
  // Die Sperre als `AND`-Glied, nicht als `id` (2026-09-27): Aufrufer
  // verbreiten die Sichtregel und setzen danach ihr eigenes `id` — das hätte
  // die Sperre still ersetzt.
  return { ...base, AND: [{ id: '__keines__' }] };
}

const include = {
  currentVersion: { include: { file: { select: { id: true, filename: true, mimeType: true, sizeBytes: true, url: true, path: true } } } },
  subjectEmployee: { select: { id: true, user: { select: { firstName: true, lastName: true } } } },
  supplier: { select: { id: true, name: true } },
  _count: { select: { versions: true } },
} satisfies Prisma.ManagedDocumentInclude;

export async function listDocuments(
  session: SessionUser,
  organizationId: string,
  query: { q?: string; category?: string; visibility?: string; tag?: string; ablaufTage?: number; page: number; pageSize: number },
) {
  const where: Prisma.ManagedDocumentWhereInput = {
    AND: [
      documentVisibilityWhere(session, organizationId),
      query.category ? { category: query.category as never } : {},
      query.visibility ? { visibility: query.visibility as never } : {},
      query.tag ? { tags: { has: query.tag } } : {},
      query.ablaufTage ? { expiresOn: { gte: today(), lte: addDays(today(), query.ablaufTage) } } : {},
      query.q ? { OR: [{ title: { contains: query.q, mode: 'insensitive' } }, { description: { contains: query.q, mode: 'insensitive' } }, { tags: { has: query.q } }] } : {},
    ],
  };
  const [items, total] = await Promise.all([
    prisma.managedDocument.findMany({
      where,
      include,
      orderBy: [{ expiresOn: { sort: 'asc', nulls: 'last' } }, { updatedAt: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.managedDocument.count({ where }),
  ]);
  return { items, total };
}

export async function getDocument(session: SessionUser, organizationId: string, id: string) {
  const document = await prisma.managedDocument.findFirst({
    where: { ...documentVisibilityWhere(session, organizationId), id },
    include: {
      ...include,
      versions: { orderBy: { version: 'desc' }, include: { file: { select: { id: true, filename: true, mimeType: true, sizeBytes: true, createdAt: true } } } },
    },
  });
  if (!document) throw new NotFoundError('Dokument');
  return document;
}

function defaultVisibility(input: { category: string; visibility?: string }): DocumentVisibility {
  if (input.visibility) return input.visibility as DocumentVisibility;
  return input.category === 'EMPLOYEE' ? 'EMPLOYEE_PRIVATE' : 'MANAGEMENT';
}

/**
 * Eine bereits geprüfte Datei für dieses Dokument beanspruchen.
 *
 * **Warum das Dokument keine Datei mehr anlegt.** Vorher kamen `path`, `url`,
 * `mimeType` und `sizeBytes` aus dem Formular und wurden unbesehen zu einem
 * `FileAsset` — eine zweite Stelle neben `POST /api/media`, an der der Client
 * eine Datei erfinden konnte, und ausgerechnet für Personal- und
 * Vertragsdokumente.
 *
 * Jetzt wird nur beansprucht, was der Abschluss bereits geprüft hat. Die
 * Bedingungen in der Abfrage sind die Prüfung: richtige Organisation,
 * Prüfsumme vorhanden (also abgeschlossen) und noch keiner Fassung
 * zugeordnet. Trifft eine davon nicht zu, gibt es keine Fassung.
 *
 * **Dieselben Bindungsregeln wie `dateienBinden`** (2026-09-27): nur ein
 * eigener Upload, an nichts anderem gebunden (Nachricht, Buchung, Beleg),
 * nicht öffentlich, nicht als schädlich oder unprüfbar markiert. Vorher
 * reichten Organisation und Zweck — die Verwaltung konnte den Upload einer
 * Kundin oder den Anhang einer Nachricht zur Fassung einer Führungsakte
 * machen, und damit unter eine ganz andere Sichtbarkeit stellen. Und die
 * Zeile wird gesperrt (`FOR UPDATE`): Ohne Sperre konnten zwei
 * gleichzeitige Fassungen dieselbe Datei beanspruchen, weil „noch keiner
 * Fassung zugeordnet" für beide stimmte.
 */
async function beanspruchteDatei(
  tx: Prisma.TransactionClient,
  organizationId: string,
  fileId: string,
  uploadedById: string,
) {
  await tx.$queryRaw`SELECT id FROM file_assets WHERE id = ${fileId} FOR UPDATE`;
  const file = await tx.fileAsset.findFirst({
    where: {
      id: fileId,
      organizationId,
      uploadedById,
      checksum: { not: null },
      scope: 'DOCUMENT',
      isPublic: false,
      scanStatus: { notIn: ['INFECTED', 'QUARANTINED', 'ERROR'] },
      messageId: null,
      bookingId: null,
      expenseId: null,
      versions: { none: {} },
    },
    select: { id: true },
  });
  // 404 wie `dateienBinden` (2026-09-27): eine Datei, die nicht gebunden
  // werden darf — fremd, schon vergeben, nicht die eigene —, ist für diesen
  // Weg nicht vorhanden. Vorher 422; die Antwort verriet zwar nichts, wich aber
  // als einzige Bindungsstelle von der gemeinsamen Regel ab.
  if (!file) throw new NotFoundError('Datei');
  return file;
}

export async function createDocument(session: SessionUser, organizationId: string, input: CreateDocumentInput) {
  const visibility = defaultVisibility(input);
  if (visibility === 'EMPLOYEE_PRIVATE' && !input.subjectEmployeeId) {
    throw new BusinessRuleError('Ein Personaldokument braucht die betroffene Person — sonst weiss niemand, wer es sehen darf.');
  }
  if (input.subjectEmployeeId && !(await prisma.employee.findFirst({ where: { id: input.subjectEmployeeId, organizationId } }))) {
    throw new NotFoundError('Mitarbeitende Person');
  }

  const document = await prisma.$transaction(async (tx) => {
    const doc = await tx.managedDocument.create({
      data: {
        organizationId,
        title: input.title,
        category: input.category,
        visibility,
        description: input.description ?? null,
        tags: input.tags,
        subjectEmployeeId: input.subjectEmployeeId ?? null,
        supplierId: input.supplierId ?? null,
        validFrom: input.validFrom ?? null,
        expiresOn: input.expiresOn ?? null,
        reminderDaysBefore: input.reminderDaysBefore,
        createdById: session.id,
      },
    });
    if (input.fileId) {
      const file = await beanspruchteDatei(tx, organizationId, input.fileId, session.id);
      const version = await tx.documentVersion.create({
        data: { documentId: doc.id, version: 1, fileAssetId: file.id, changeNote: input.changeNote ?? null, uploadedById: session.id },
      });
      await tx.managedDocument.update({ where: { id: doc.id }, data: { currentVersionId: version.id } });
    }
    return doc;
  });
  await audit.created({ organizationId, userId: session.id, entity: 'ManagedDocument', entityId: document.id, summary: `Dokument „${document.title}" abgelegt (${visibility})` });
  return document;
}

export async function updateDocument(session: SessionUser, organizationId: string, id: string, input: UpdateDocumentInput) {
  const before = await prisma.managedDocument.findFirst({ where: { ...documentVisibilityWhere(session, organizationId), id } });
  if (!before) throw new NotFoundError('Dokument');
  const visibility = input.visibility ?? (input.category === 'EMPLOYEE' && before.category !== 'EMPLOYEE' ? 'EMPLOYEE_PRIVATE' : before.visibility);
  const subject = input.subjectEmployeeId === undefined ? before.subjectEmployeeId : input.subjectEmployeeId;
  if (visibility === 'EMPLOYEE_PRIVATE' && !subject) {
    throw new BusinessRuleError('Ein Personaldokument braucht die betroffene Person.');
  }
  const document = await prisma.managedDocument.update({
    where: { id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      visibility,
      ...(input.description !== undefined ? { description: input.description || null } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.subjectEmployeeId !== undefined ? { subjectEmployeeId: input.subjectEmployeeId } : {}),
      ...(input.supplierId !== undefined ? { supplierId: input.supplierId } : {}),
      ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
      ...(input.expiresOn !== undefined ? { expiresOn: input.expiresOn, expiryNotifiedAt: null } : {}),
      ...(input.reminderDaysBefore !== undefined ? { reminderDaysBefore: input.reminderDaysBefore } : {}),
    },
  });
  await audit.updated({ organizationId, userId: session.id, entity: 'ManagedDocument', entityId: id, summary: `Dokument „${document.title}" geändert`, changes: input });
  return document;
}

export async function addDocumentVersion(session: SessionUser, organizationId: string, id: string, input: AddDocumentVersionInput) {
  const document = await prisma.managedDocument.findFirst({
    where: { ...documentVisibilityWhere(session, organizationId), id },
    select: { id: true, title: true },
  });
  if (!document) throw new NotFoundError('Dokument');
  /*
    Die nächste Nummer in der Transaktion, hinter einer Zeilensperre am
    Dokument (2026-09-27). Vorher wurde sie davor gelesen: Fünf gleichzeitige
    Fassungen rechneten alle mit derselben Nummer, vier scheiterten am
    eindeutigen Index mit 409 — und die hochgeladene Datei war verloren,
    obwohl niemand etwas falsch gemacht hatte. Jetzt kommen alle fünf durch,
    lückenlos nummeriert, und die höchste gilt.
  */
  const version = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM managed_documents WHERE id = ${id} FOR UPDATE`;
    const letzte = await tx.documentVersion.findFirst({ where: { documentId: id }, orderBy: { version: 'desc' }, select: { version: true } });
    const nextVersion = (letzte?.version ?? 0) + 1;
    const file = await beanspruchteDatei(tx, organizationId, input.fileId, session.id);
    const created = await tx.documentVersion.create({
      data: { documentId: id, version: nextVersion, fileAssetId: file.id, changeNote: input.changeNote ?? null, uploadedById: session.id },
    });
    await tx.managedDocument.update({ where: { id }, data: { currentVersionId: created.id } });
    return created;
  });
  await audit.updated({ organizationId, userId: session.id, entity: 'ManagedDocument', entityId: id, summary: `Dokument „${document.title}": Fassung ${version.version} hochgeladen` });
  return version;
}

export async function deleteDocument(session: SessionUser, organizationId: string, id: string) {
  const document = await prisma.managedDocument.findFirst({ where: { ...documentVisibilityWhere(session, organizationId), id } });
  if (!document) throw new NotFoundError('Dokument');
  await prisma.managedDocument.update({ where: { id }, data: { deletedAt: new Date() } });
  await audit.deleted({ organizationId, userId: session.id, entity: 'ManagedDocument', entityId: id, summary: `Dokument „${document.title}" gelöscht` });
}

/**
 * Download einer Fassung — protokolliert, mit befristetem Verweis.
 *
 * Ohne `version` die geltende Fassung. Die Sichtbarkeit wird über das
 * Dokument geprüft, nie über die Datei: eine `FileAsset`-ID allein öffnet
 * hier nichts.
 */
export async function resolveDocumentDownload(
  session: SessionUser,
  organizationId: string,
  id: string,
  version?: number,
  ip?: string | null,
): Promise<Dateiauslieferung> {
  const document = await prisma.managedDocument.findFirst({
    where: { ...documentVisibilityWhere(session, organizationId), id },
    include: { currentVersion: { include: { file: { include: { storedFile: true } } } } },
  });
  if (!document) throw new NotFoundError('Dokument');
  const target = version
    ? await prisma.documentVersion.findFirst({
        where: { documentId: id, version },
        include: { file: { include: { storedFile: true } } },
      })
    : document.currentVersion;
  if (!target) throw new NotFoundError('Fassung');

  const file = target.file;
  auslieferbarOderNicht(file);

  /**
   * Ohne externen Objektspeicher gibt es keine befristete Adresse, auf die
   * sich weiterleiten liesse (siehe `Dateiauslieferung`). Dann liefert dieser
   * Dienst die Bytes selbst aus — hier, wo `documentVisibilityWhere` bereits
   * in der `where`-Klausel steht und `EMPLOYEE_PRIVATE` mitgeprüft ist.
   */
  /*
    Mit Ablagezeile liefert der Dienst die Bytes selbst aus, für **beide**
    Treiber und gegen die Prüfsumme gelesen (2026-09-27, F-09 c). Vorher
    leitete er beim externen Speicher auf eine befristete Supabase-Adresse
    weiter: Die Berechtigung war geprüft, die Bytes aber nicht — eine
    veränderte Datei im Bucket ging unbemerkt hinaus. Nur Fassungen ohne
    Ablagezeile (Altbestand vor F-09 c) nehmen noch den alten Weg.
  */
  const ausgeliefert: Dateiauslieferung = file.storedFile
    ? { art: 'bytes', bytes: await geprueftLesen(file.storedFile, file.checksum), filename: file.filename, mimeType: file.mimeType }
    : usesRemoteStorage()
      ? { art: 'weiterleitung', url: await createSignedDownloadUrl(file.path, 600), filename: file.filename, mimeType: file.mimeType }
      : { art: 'bytes', bytes: await fassungsBytes(file), filename: file.filename, mimeType: file.mimeType };

  await audit.exported({
    organizationId,
    userId: session.id,
    entity: 'ManagedDocument',
    entityId: id,
    summary: `Dokument „${document.title}" (Fassung ${target.version}) heruntergeladen`,
    ip,
  });
  return ausgeliefert;
}

/**
 * Das Auslieferungstor der Schadsoftwareprüfung — dasselbe wie in der
 * Dateiroute (2026-09-27).
 *
 * Dokumente gingen bis dahin daran vorbei: Die Sichtbarkeit wurde geprüft,
 * der Prüfstand nicht. Eine Fassung im Status PENDING, INFECTED oder
 * QUARANTINED liess sich herunterladen und ansehen, solange man das Dokument
 * sehen durfte. Die Antwort ist 404, nicht „in Quarantäne": Sie soll nicht
 * mehr verraten als die Dateiroute.
 */
function auslieferbarOderNicht(file: { scanStatus: FileScanStatus; provenance: FileProvenance }): void {
  if (!pruefeAuslieferung(file).erlaubt) throw new NotFoundError('Datei');
}

/**
 * Die Bytes einer Fassung — aus der Ablagezeile, sonst über den einen
 * zugelassenen Altbestandsweg.
 *
 * Herausgezogen, weil Ansehen und Herunterladen dieselbe Datei meinen. Zwei
 * Abschriften dieser Auflösung liefen bei der nächsten Änderung auseinander,
 * und die Abweichung fiele erst auf, wenn ein Dokument sich ansehen, aber
 * nicht herunterladen lässt.
 */
/**
 * Bytes aus der Ablage lesen und gegen die Prüfsumme halten — scheitert
 * geschlossen: fehlt die Datei oder weicht sie ab, gibt es sie auf diesem Weg
 * nicht (404), statt anderer Bytes. Die Quarantäne einer abweichenden Datei
 * setzt die Dateiroute (`liesFreigegebeneDatei`); hier genügt die Absage.
 * Auch vom Berichtsdownload benutzt.
 */
export async function geprueftLesen(
  ablage: { id: string; path: string; driver: 'LOCAL' | 'SUPABASE'; checksum: string | null },
  assetChecksum: string | null,
): Promise<Buffer> {
  const gelesen = await leseAblageGeprueft(ablage, assetChecksum);
  if (gelesen.status !== 'ok') throw new NotFoundError('Datei');
  return gelesen.bytes;
}

async function fassungsBytes(file: {
  url: string;
  scanStatus: FileScanStatus;
  provenance: FileProvenance;
  storedFile: { id: string; path: string; driver: 'LOCAL' | 'SUPABASE' } | null;
}): Promise<Buffer> {
  auslieferbarOderNicht(file);
  let bytes: Buffer | null = null;

  if (file.storedFile) {
    bytes = await readStoredBytes({
      id: file.storedFile.id,
      path: file.storedFile.path,
      driver: file.storedFile.driver,
    });
  } else {
    /**
     * Altbestand vor Gate 2: kein Fremdschlüssel zur Ablage, nur die
     * gespeicherte Adresse. Der kontrollierte Legacy-Weg — exakt diese eine
     * Adressform, nichts erraten. Passt sie nicht, gibt es die Datei über
     * diesen Weg nicht.
     */
    const treffer = /^\/api\/files\/blob\/([A-Za-z0-9_-]+)$/.exec(file.url);
    if (treffer) bytes = await readLocalBytes(treffer[1]!);
  }

  if (!bytes) throw new NotFoundError('Datei');
  return bytes;
}

/**
 * Die Bytes einer Dokumentfassung für die Anzeige — mit derselben
 * Sichtbarkeitsprüfung wie alles andere in diesem Dienst.
 *
 * **Warum nicht die Download-Route wiederverwendet wird.** Sie leitet auf
 * eine Speicheradresse weiter. Für den Viewer taugt das nicht: Er lädt die
 * Bytes selbst, um Zugriff, „nicht gefunden" und Beschädigung
 * auseinanderzuhalten, und eine Weiterleitung nimmt ihm diese Auskunft.
 * Vor allem aber prüft die Speicheradresse (`/api/files/blob/…`) die
 * Berechtigung gröber als dieses Modul: Sie kennt `document:read`, nicht
 * `EMPLOYEE_PRIVATE` und die betroffene Person. `documentVisibilityWhere`
 * ist die Quelle, und sie steht hier in der `where`-Klausel.
 *
 * **Welche Fassung.** Immer eine ausdrücklich benannte oder die geltende —
 * und die Antwort sagt, welche es war. Gate 4 wird eine Signatur an genau
 * eine Fassung binden; ein Viewer, der stillschweigend „die aktuelle" zeigt,
 * wäre dafür die falsche Grundlage.
 *
 * Angesehen wird protokolliert wie heruntergeladen: Ein Personaldokument zu
 * öffnen ist ein Zugriff, egal ob der Browser es speichert oder zeigt.
 */
export async function resolveDocumentContent(
  session: SessionUser,
  organizationId: string,
  id: string,
  version?: number,
  ip?: string | null,
): Promise<{ bytes: Buffer; filename: string; mimeType: string; version: number }> {
  const document = await prisma.managedDocument.findFirst({
    where: { ...documentVisibilityWhere(session, organizationId), id },
    include: { currentVersion: { include: { file: { include: { storedFile: true } } } } },
  });
  if (!document) throw new NotFoundError('Dokument');

  const target = version
    ? await prisma.documentVersion.findFirst({
        where: { documentId: id, version },
        include: { file: { include: { storedFile: true } } },
      })
    : document.currentVersion;
  if (!target) throw new NotFoundError('Fassung');

  const file = target.file;
  const bytes = await fassungsBytes(file);

  await audit.exported({
    organizationId,
    userId: session.id,
    entity: 'ManagedDocument',
    entityId: id,
    summary: `Dokument „${document.title}" (Fassung ${target.version}) angesehen`,
    ip,
  });

  return { bytes, filename: file.filename, mimeType: file.mimeType, version: target.version };
}

/** Nachtlauf: ablaufende Dokumente einmal melden. */
export async function notifyExpiringDocuments(organizationId: string): Promise<number> {
  const now = today();
  const candidates = await prisma.managedDocument.findMany({
    where: { organizationId, deletedAt: null, expiresOn: { not: null, gte: now }, expiryNotifiedAt: null },
    select: { id: true, title: true, expiresOn: true, reminderDaysBefore: true, createdById: true },
  });
  const due = candidates.filter((d) => d.expiresOn! <= addDays(now, d.reminderDaysBefore));
  if (due.length === 0) return 0;

  const recipients = await prisma.user.findMany({
    where: { organizationId, role: { in: ['ADMIN', 'SUPER_ADMIN'] }, status: 'ACTIVE', deletedAt: null },
    select: { id: true },
  });
  const lines = due.map((d) => `${d.title} — läuft am ${d.expiresOn!.toISOString().slice(0, 10)} ab`);
  for (const user of recipients) {
    await notify({
      userId: user.id,
      channels: ['IN_APP'],
      title: due.length === 1 ? 'Ein Dokument läuft bald ab' : `${due.length} Dokumente laufen bald ab`,
      body: lines.slice(0, 5).join('\n'),
      link: '/admin/fuehrung/dokumente?ablaufTage=30',
      entity: 'ManagedDocument',
    });
  }
  await prisma.managedDocument.updateMany({ where: { id: { in: due.map((d) => d.id) } }, data: { expiryNotifiedAt: now } });
  return due.length;
}
