import { BASE_URL, data, del, get, post } from '../../helpers/client';
import { ACCOUNTS, login } from '../../helpers/accounts';
import { letzteMail, linksIn } from '../../helpers/mail';
import { testDb } from '../../helpers/testdb';

/**
 * Prüfbestand über die Schnittstelle anlegen — nicht über den Browser.
 *
 * **Warum die Vorbereitung nicht im Browser passiert.** Was diese Reihe
 * beweisen soll, steht in den Gates 3, 4C und 4D: dass ein PDF rendert, dass
 * eine gezeichnete Unterschrift entsteht, dass eine Gerätesperre hält. Den Weg
 * dorthin — Offerte anlegen, Einsatz zuteilen, abschliessen — prüft die
 * bestehende HTTP-Reihe bereits vollständig und um ein Vielfaches schneller.
 * Ihn im Browser zu wiederholen, verlängerte jeden Fall um zwanzig Klicks und
 * machte ihn gegen jede Formularänderung brüchig, ohne eine einzige neue
 * Aussage zu erzeugen.
 *
 * Die Grenze ist scharf: **Alles, worüber eine Aussage getroffen wird, läuft
 * im Browser.** Ein `imageDataUrl` wird hier nie eingesetzt, eine Zustimmung
 * nie per API gegeben, ein Vorgang nie per API abgeschlossen.
 *
 * Dieselben Helfer wie die HTTP-Reihe (`tests/helpers/*`) werden dabei
 * wiederverwendet statt nachgebaut — zwei Klienten gegen dieselbe Anwendung
 * wären zwei Stellen, an denen ein Envelope-Format auseinanderlaufen kann.
 */

export interface Konto {
  jar: string;
}

/**
 * Frisch anmelden, ohne den Sitzungs-Cache der HTTP-Reihe zu berühren.
 *
 * `loginAs()` aus `tests/helpers/accounts.ts` teilt Cookies über Läufe hinweg.
 * Für die Vorbereitung ist das gleichgültig, für die Gerätesperre wäre es
 * fatal: Wird eine zwischengespeicherte Mitarbeitersitzung gesperrt, nimmt sie
 * die halbe HTTP-Reihe mit. Diese Reihe meldet deshalb grundsätzlich frisch an
 * — jeder Fall bekommt seine eigene Rotationsfamilie, was ohnehin der Zustand
 * ist, den § 32 beschreibt.
 */
export async function frischAnmelden(konto: keyof typeof ACCOUNTS): Promise<string> {
  const { email, password } = ACCOUNTS[konto];
  const antwort = await login(email, password);
  if (antwort.status !== 200) {
    throw new Error(
      `Anmeldung als ${konto} (${email}) fehlgeschlagen: HTTP ${antwort.status}. ` +
        (antwort.status === 429
          ? 'Das Anmeldelimit greift — die Zähler werden je Fall geleert, hier ging etwas daneben.'
          : 'Ist die Testdatenbank mit `npm run db:test:setup` befüllt?'),
    );
  }
  return antwort.jar;
}

// ---------------------------------------------------------------------------
//  Stammdaten aus dem Demobestand
// ---------------------------------------------------------------------------

export interface Stammdaten {
  customerId: string;
  addressId: string;
  propertyId: string;
  serviceId: string;
  employeeId: string;
  employeeUserId: string;
}

let stammdaten: Stammdaten | null = null;

/** Einmal je Worker-Prozess gelesen — sie ändern sich während eines Laufs nicht. */
export async function stammdatenLesen(adminJar: string): Promise<Stammdaten> {
  if (stammdaten) return stammdaten;

  const db = testDb();
  if (!db) throw new Error('Keine Testdatenbank — der globale Vorlauf hätte das abfangen müssen.');

  const kunde = await db.customer.findFirst({
    where: { user: { email: ACCOUNTS.customer.email } },
    select: { id: true },
  });
  if (!kunde) throw new Error(`Kein Kundendatensatz zu ${ACCOUNTS.customer.email} — Demo-Seed fehlt.`);

  const objekte = data(
    await get<{ data: { id: string; address: { id: string } | null; customer: { id: string } }[] }>(
      '/api/properties',
      { jar: adminJar },
    ),
  );
  const mitAdresse = objekte.find((objekt) => objekt.address !== null);
  if (!mitAdresse) throw new Error('Der Demobestand enthält kein Objekt mit Adresse.');

  const dienste = data(await get<{ data: { id: string }[] }>('/api/services', { jar: adminJar }));
  const personal = data(
    await get<{ data: { id: string; user: { id: string; email: string } }[] }>('/api/employees', { jar: adminJar }),
  );
  const anna = personal.find((p) => p.user.email === ACCOUNTS.employee.email);
  if (!anna) throw new Error(`Kein Personaldatensatz zu ${ACCOUNTS.employee.email}.`);

  stammdaten = {
    customerId: mitAdresse.customer.id,
    addressId: mitAdresse.address!.id,
    propertyId: mitAdresse.id,
    serviceId: dienste[0]!.id,
    employeeId: anna.id,
    employeeUserId: anna.user.id,
  };
  return stammdaten;
}

// ---------------------------------------------------------------------------
//  Dateien und Dokumente (Gate 3)
// ---------------------------------------------------------------------------

/** Upload wie in `tests/api/signatur.test.ts`: Ticket, Bytes, Abschluss. */
export async function pdfHochladen(bytes: Buffer, filename: string, jar: string): Promise<string> {
  const ticket = await post<{ data: { ticketId: string; signedUrl: string } }>(
    '/api/files/upload-url',
    { profile: 'document', filename, mimeType: 'application/pdf', sizeBytes: bytes.byteLength },
    { jar },
  );
  if (ticket.status !== 201) throw new Error(`Upload-Ticket: HTTP ${ticket.status} — ${ticket.text}`);

  const pfad = `${BASE_URL}${new URL(data(ticket).signedUrl, BASE_URL).pathname}`;
  const upload = await fetch(pfad, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/pdf' },
    body: new Uint8Array(bytes),
  });
  if (upload.status !== 200) throw new Error(`Upload: HTTP ${upload.status}`);

  const abschluss = await post<{ data: { id: string } }>(
    '/api/files/finalize',
    { ticketId: data(ticket).ticketId, filename },
    { jar },
  );
  if (abschluss.status !== 201) throw new Error(`Abschluss: HTTP ${abschluss.status} — ${abschluss.text}`);
  return data(abschluss).id;
}

export async function dokumentAnlegen(fileId: string, titel: string, jar: string): Promise<string> {
  const antwort = await post<{ data: { id: string } }>(
    '/api/bi/documents',
    { title: titel, category: 'OTHER', fileId },
    { jar },
  );
  if (antwort.status !== 201) throw new Error(`Dokument anlegen: HTTP ${antwort.status} — ${antwort.text}`);
  return data(antwort).id;
}

export const dokumentEntfernen = (id: string, jar: string) =>
  del(`/api/bi/documents/${id}`, { jar }).catch(() => undefined);

// ---------------------------------------------------------------------------
//  Offerten (Gate 4C)
// ---------------------------------------------------------------------------

const nurDatum = (d: Date) => d.toISOString().slice(0, 10);

let offertZaehler = 0;

/** Eine frische Offerte für die Demokundschaft — jeder Fall bekommt seine eigene. */
export async function offerteAnlegen(jar: string, customerId: string): Promise<{ id: string; number: string }> {
  offertZaehler += 1;
  const antwort = await post<{ data: { id: string; number: string } }>(
    '/api/quotes',
    {
      customerId,
      title: `Browserprüfung 4D.1 ${Date.now()}-${offertZaehler}`,
      validUntil: nurDatum(new Date(Date.now() + 30 * 86_400_000)),
      items: [
        {
          name: 'Unterhaltsreinigung',
          quantity: 6,
          unit: 'Std.',
          unitPrice: 64,
          discount: 0,
          vatRate: 8.1,
          optional: false,
        },
      ],
      discountValue: 0,
    },
    { jar },
  );
  if (antwort.status !== 201) throw new Error(`Offerte anlegen: HTTP ${antwort.status} — ${antwort.text}`);
  return data(antwort);
}

/**
 * Versenden — und den Token aus der **tatsächlich versendeten** Nachricht
 * lesen. In der Datenbank liegt nur sein Hash; der Postausgang ist der einzige
 * Ort, an dem der rohe Wert je existiert (§ 49 aus Gate 4C, hier für den
 * Browser).
 */
export async function versendenUndLinkLesen(quoteId: string, jar: string): Promise<string> {
  const versand = await post(`/api/quotes/${quoteId}/send`, { attachPdf: true }, { jar });
  if (versand.status !== 200) throw new Error(`Offertversand: HTTP ${versand.status} — ${versand.text}`);

  const mail = letzteMail({ entityId: quoteId });
  if (!mail) throw new Error('Keine Nachricht im Postausgang — läuft der Testserver mit CLENARIS_TEST_CACHE_DIR?');

  for (const link of linksIn(mail)) {
    if (/\/offerte\/[0-9a-f]{64}(?:$|[?#])/.test(link)) return link;
  }
  throw new Error(`Kein Offertlink in der versendeten Nachricht: ${linksIn(mail).join(', ')}`);
}

/** Aus einer vollständigen Adresse den Pfad — der Browser fährt relativ. */
export function pfadVon(url: string): string {
  return new URL(url, BASE_URL).pathname;
}

/** Der rohe 64-Hex-Wert aus einem Offertlink — nur zum Nachweis, nie zur Anzeige. */
export function tokenAus(url: string): string {
  const treffer = /\/offerte\/([0-9a-f]{64})(?:$|[?#])/.exec(url);
  if (!treffer) throw new Error('Kein Offert-Token in der Adresse.');
  return treffer[1]!;
}

// ---------------------------------------------------------------------------
//  Einsätze (Gate 4D)
// ---------------------------------------------------------------------------

let tagVersatz = 120;

const inTagen = (n: number, stunde: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(stunde, 0, 0, 0);
  return d.toISOString();
};

/**
 * Ein frischer, der Demo-Mitarbeiterin zugeteilter und abgeschlossener
 * Einsatz — der Zustand, in dem die Kundenabnahme beginnen darf.
 *
 * Jeder Fall bekommt seinen eigenen: Ein Teilindex lässt je Einsatz nur eine
 * offene Abnahme zu, und eine terminale Abnahme verbraucht den Einsatz für
 * alle folgenden Fälle.
 */
export async function abgeschlossenenEinsatzAnlegen(
  stamm: Stammdaten,
  adminJar: string,
  mitarbeiterJar: string,
): Promise<{ id: string; number: string }> {
  tagVersatz += 1;
  const antwort = await post<{ data: { id: string; number: string } }>(
    '/api/jobs',
    {
      customerId: stamm.customerId,
      addressId: stamm.addressId,
      propertyId: stamm.propertyId,
      serviceId: stamm.serviceId,
      title: `Browserprüfung 4D.1 ${Date.now()}-${tagVersatz}`,
      scheduledStart: inTagen(tagVersatz, 8),
      scheduledEnd: inTagen(tagVersatz, 11),
      estimatedMin: 180,
    },
    { jar: adminJar },
  );
  if (antwort.status !== 201) throw new Error(`Einsatz anlegen: HTTP ${antwort.status} — ${antwort.text}`);
  const job = data(antwort);

  const zuteilung = await post(
    `/api/jobs/${job.id}/assign`,
    { employeeIds: [stamm.employeeId], notify: false },
    { jar: adminJar },
  );
  if (zuteilung.status !== 200) throw new Error(`Zuteilung: HTTP ${zuteilung.status} — ${zuteilung.text}`);

  const abschluss = await post(
    `/api/jobs/${job.id}/complete`,
    { completionNote: 'Browserprüfung — alles erledigt.', materials: [] },
    { jar: mitarbeiterJar },
  );
  if (abschluss.status !== 200) throw new Error(`Abschluss: HTTP ${abschluss.status} — ${abschluss.text}`);

  return job;
}

export const einsatzEntfernen = (id: string, jar: string) =>
  del(`/api/jobs/${id}`, { jar }).catch(() => undefined);

/**
 * Offene Gerätesperren derselben Person lösen.
 *
 * Nicht Aufräumkosmetik, sondern Voraussetzung: Bleibt aus einem
 * fehlgeschlagenen Fall eine aktive Sperre liegen, scheitert der nächste Fall
 * beim Anmelden nicht — aber beim ersten angemeldeten Aufruf mit 423, und man
 * sucht den Fehler in der Sperre statt im vorherigen Fall.
 */
export async function sperrenLoesen(userId: string): Promise<void> {
  const db = testDb();
  if (!db) return;
  await db.deviceHandoffSession.updateMany({
    where: { userId, status: 'ACTIVE' },
    data: { status: 'RELEASED', releasedAt: new Date() },
  });
}
