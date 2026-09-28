/**
 * Vorschaubestand — damit sich Gate 3, 4C und 4D von Hand im Browser ansehen
 * lassen.
 *
 *   npm run db:preview:setup     # einmal: Datenbank, Migrationen, Konfiguration
 *   npm run preview:server       # Server auf 127.0.0.1:3000
 *   npm run db:preview:seed      # dieser Seed (braucht den laufenden Server)
 *
 * ---------------------------------------------------------------------------
 *  Der Schutzschalter
 * ---------------------------------------------------------------------------
 *
 * Dieser Seed legt Kundschaft, Offerten, Einsätze und Dokumente an und
 * verbraucht dabei Nummern aus `NumberSequence`. Er läuft deshalb **nur**
 * gegen eine Datenbank, die auf das Zeichen genau `clenaris_preview` heisst.
 * Kein Muster, keine Ähnlichkeit, keine Übersteuerung per Umgebungsvariable —
 * ein Schalter, den man umlegen kann, wird umgelegt.
 *
 * ---------------------------------------------------------------------------
 *  Warum zwei Wege: Prisma und HTTP
 * ---------------------------------------------------------------------------
 *
 * **Konten und Stammdaten** schreibt dieser Seed direkt über Prisma. Ein
 * aktives Konto mit bekanntem Passwort lässt sich über die Schnittstelle gar
 * nicht anlegen — die Anwendung lädt ein, sie vergibt keine Passwörter.
 *
 * **Alles Fachliche geht über die laufende Anwendung**, und das ist der Punkt:
 * Eine Offerte, deren Nummer von Hand in die Tabelle geschrieben wurde,
 * beweist beim Durchklicken nichts. Die Offerte hier zieht ihre Nummer aus
 * derselben Folge wie im Betrieb, der Versand stellt denselben
 * `QUOTE_RESPOND`-Zugang aus, und das PDF läuft durch denselben
 * Abschlussweg mit Byteprüfung und Prüfsumme wie jeder Upload. Ein
 * hineingeschriebener Ersatztoken oder eine erfundene Prüfsumme sähen im
 * Browser genauso aus — bis zu dem Klick, der sie auffliegen lässt.
 *
 * ---------------------------------------------------------------------------
 *  Was dieser Seed ausdrücklich **nicht** tut
 * ---------------------------------------------------------------------------
 *
 * Er nimmt keine Offerte an, unterschreibt keinen Rapport und startet keine
 * Geräteübergabe. Genau das soll die Person am Bildschirm selbst auslösen;
 * ein vorbereiteter Vorgang nähme ihr die Prüfung ab, die sie durchführen
 * will. Der Bestand endet vor der ersten Unterschrift.
 *
 * ---------------------------------------------------------------------------
 *  Wiederholbarkeit
 * ---------------------------------------------------------------------------
 *
 * Jeder Datensatz hat eine stabile Kennung — feste E-Mail-Adressen, feste
 * Kunden- und Personalnummern, feste Titel mit dem Präfix `PREVIEW`. Ein
 * zweiter Lauf findet sie wieder und legt nichts Neues an. Was bereits
 * angenommen oder abgenommen wurde, wird dabei **nicht** zurückgesetzt: Der
 * Seed baut auf, er räumt nicht ab. Für einen frischen Stand gibt es
 * `npm run db:preview:setup -- --frisch`.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { hash } from '@node-rs/argon2';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { config } from 'dotenv';

import { databaseNameOf } from './seed-guard';
import { PREVIEW_DB, previewUrlAus } from '../scripts/setup-preview-db';
import { previewCacheDir } from '../scripts/preview-server';

// ---------------------------------------------------------------------------
//  Schutzschalter — vor jeder Verbindung
// ---------------------------------------------------------------------------

/**
 * Die Adresse wird hier **abgeleitet**, nicht erwartet.
 *
 * Ein Seed, der auf ein gesetztes `DATABASE_URL` vertraut, ist genau einen
 * vergessenen Export davon entfernt, gegen die Entwicklungsdatenbank zu
 * laufen. Also derselbe Weg wie in `scripts/setup-preview-db.ts`: aus der
 * Entwicklungsadresse den Host übernehmen, den Namen ersetzen — und dann auf
 * das Zeichen genau prüfen.
 */
config();
const entwicklungsUrl = process.env.DATABASE_URL;
const previewUrl = process.env.PREVIEW_DATABASE_URL ?? (entwicklungsUrl ? previewUrlAus(entwicklungsUrl) : null);
const zielName = databaseNameOf(previewUrl ?? undefined);

if (!previewUrl || zielName !== PREVIEW_DB) {
  console.error(
    [
      '',
      '❌  Vorschau-Seed abgebrochen — Schutzschalter.',
      '',
      `    Zieldatenbank : ${zielName ?? '(aus DATABASE_URL nicht lesbar)'}`,
      `    Zulässig      : ${PREVIEW_DB} (auf das Zeichen genau)`,
      '',
      '    Dieser Seed legt Kundschaft, Offerten, Einsätze und Dokumente an und',
      '    verbraucht Belegnummern. Gegen die Entwicklungs- oder Testdatenbank',
      '    läuft er nicht, und es gibt keinen Weg, das zu übersteuern.',
      '',
      '    Richtig ist:  npm run db:preview:setup',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

// Die Adresse ausdrücklich setzen — nicht die aus `.env` übernehmen.
const prisma = new PrismaClient({ datasources: { db: { url: previewUrl } } });

const BASIS = process.env.PREVIEW_BASE_URL?.trim() || 'http://127.0.0.1:3000';
const ORG_SLUG = 'clenaris';
const ARGON_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/**
 * Die Zugangsdaten der Vorschau — fest verdrahtet, damit jeder Lauf dieselben
 * ergibt, und ausschliesslich in `clenaris_preview` gültig. Aus `.env` wird
 * dafür nichts gelesen.
 */
const PREVIEW_KONTEN = {
  admin: { email: 'admin@preview.clenaris.local', passwort: 'Preview#2026Admin' },
  employee: { email: 'mitarbeiterin@preview.clenaris.local', passwort: 'Preview#2026Team' },
  customer: { email: 'kundin@preview.clenaris.local', passwort: 'Preview#2026Kunde' },
} as const;

const KUNDENNUMMER = 'K-PV-00001';
const PERSONALNUMMER = 'MA-PV-00001';

const TITEL = {
  offerteA: 'PREVIEW Reinigungsofferte Bürohaus Aarestrasse',
  offerteB: 'PREVIEW Offerte Treppenhaus und Waschküche',
  einsatzAbgeschlossen: 'PREVIEW Endreinigung Bürohaus Aarestrasse',
  einsatzGeplant: 'PREVIEW Unterhaltsreinigung Bürohaus (Folgetermin)',
  dokument: 'PREVIEW Qualitätsrichtlinie Reinigung',
} as const;

// ---------------------------------------------------------------------------
//  Ein winziger HTTP-Klient — die Anwendung wird von aussen bedient
// ---------------------------------------------------------------------------

interface Antwort<T = unknown> {
  status: number;
  payload: T;
  text: string;
  cookies: string;
}

async function ruf<T = unknown>(
  methode: string,
  pfad: string,
  optionen: { jar?: string; body?: unknown } = {},
): Promise<Antwort<T>> {
  const antwort = await fetch(`${BASIS}${pfad}`, {
    method: methode,
    redirect: 'manual',
    headers: {
      ...(optionen.jar ? { cookie: optionen.jar } : {}),
      ...(optionen.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(optionen.body !== undefined ? { body: JSON.stringify(optionen.body) } : {}),
  });

  const text = await antwort.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  return {
    status: antwort.status,
    payload: payload as T,
    text,
    cookies: (antwort.headers.getSetCookie?.() ?? []).map((k) => k.split(';')[0]).join('; '),
  };
}

const hole = <T>(pfad: string, jar?: string) => ruf<T>('GET', pfad, { jar });
const sende = <T>(pfad: string, body: unknown, jar?: string) => ruf<T>('POST', pfad, { jar, body });
const setze = <T>(pfad: string, body: unknown, jar?: string) => ruf<T>('PUT', pfad, { jar, body });

/** Die Nutzlast einer erfolgreichen Antwort — alle Endpunkte hüllen sie in `data`. */
function nutzlast<T>(antwort: Antwort<{ data: T }>, was: string): T {
  if (antwort.status >= 400) {
    throw new Error(`${was}: HTTP ${antwort.status} — ${antwort.text.slice(0, 400)}`);
  }
  return antwort.payload.data;
}

async function anmelden(konto: { email: string; passwort: string }): Promise<string> {
  const antwort = await sende('/api/auth/login', { email: konto.email, password: konto.passwort });
  if (antwort.status !== 200) {
    throw new Error(
      `Anmeldung als ${konto.email} fehlgeschlagen: HTTP ${antwort.status}. ` +
        'Läuft der Vorschauserver gegen clenaris_preview? (`npm run preview:server`)',
    );
  }
  return antwort.cookies;
}

// ---------------------------------------------------------------------------
//  Postausgang — der einzige Ort, an dem der rohe Offert-Zugang existiert
// ---------------------------------------------------------------------------

function offertLinkAusPostausgang(quoteId: string): string | null {
  const ordner = join(previewCacheDir(), 'mail');
  if (!existsSync(ordner)) return null;

  const nachrichten = readdirSync(ordner)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(ordner, f), 'utf8')) as { entityId?: string; html?: string };
      } catch {
        return null;
      }
    })
    .filter((m): m is { entityId?: string; html?: string } => m !== null)
    .filter((m) => m.entityId === quoteId);

  const letzte = nachrichten.at(-1);
  if (!letzte?.html) return null;

  for (const treffer of letzte.html.matchAll(/href="([^"]+)"/g)) {
    const link = treffer[1]!.replace(/&amp;/g, '&');
    if (/\/offerte\/[0-9a-f]{64}(?:$|[?#])/.test(link)) return link;
  }
  return null;
}

// ---------------------------------------------------------------------------
//  Das Vorschau-PDF
// ---------------------------------------------------------------------------

/** Drei Seiten mit unterscheidbarem Inhalt — damit sich Blättern beobachten lässt. */
async function qualitaetsrichtlinie(): Promise<Buffer> {
  const seiten = [
    {
      titel: 'Clenaris Preview – Qualitätsrichtlinie',
      zeilen: [
        'Diese Richtlinie gilt für alle Reinigungsarbeiten der Clenaris Reinigungen GmbH.',
        'Sie beschreibt den verbindlichen Mindeststandard und die Nachweispflichten.',
        '',
        '1. Jede Fläche wird sichtgeprüft und protokolliert.',
        '2. Reinigungsmittel werden ausschliesslich verdünnt nach Herstellerangabe eingesetzt.',
        '3. Beschädigungen werden vor Arbeitsbeginn fotografisch festgehalten.',
        '4. Der Rapport wird vor Ort mit der Kundschaft durchgegangen.',
      ],
    },
    {
      titel: 'Arbeitsablauf',
      zeilen: [
        'Der Ablauf ist für alle Einsätze gleich und wird nicht abgekürzt.',
        '',
        'Schritt 1  Ankunft, Schlüsselübernahme, Sichtkontrolle',
        'Schritt 2  Materialaufbau, Absperrung bei Nassreinigung',
        'Schritt 3  Reinigung von oben nach unten, von hinten nach vorn',
        'Schritt 4  Kontrollgang anhand der Checkliste',
        'Schritt 5  Rapport abschliessen, Kundenabnahme einholen',
        'Schritt 6  Schlüsselrückgabe und Abmeldung',
      ],
    },
    {
      titel: 'Kontrollpunkte',
      zeilen: [
        'Die folgenden Punkte werden bei jeder Endreinigung einzeln abgenommen.',
        '',
        // Kein Kästchen-Zeichen: Die eingebettete Standardschrift kann nur
        // WinAnsi, und „□" (U+25A1) lässt sich darin nicht kodieren.
        '[  ]  Böden nass gereinigt, keine Schlieren',
        '[  ]  Fensterrahmen und Fenstergriffe entstaubt',
        '[  ]  Sanitärbereich entkalkt und desinfiziert',
        '[  ]  Küche: Backofen, Dampfabzug, Kühlschrank innen',
        '[  ]  Schalter, Türgriffe und Handläufe wischdesinfiziert',
        '[  ]  Abfall entsorgt, Behälter gereinigt',
        '[  ]  Schlüssel vollständig zurückgegeben',
      ],
    },
  ];

  const doc = await PDFDocument.create();
  doc.setTitle('Clenaris Preview – Qualitätsrichtlinie');
  doc.setSubject('Vorschaudokument, kein verbindliches Betriebsdokument');
  const text = await doc.embedFont(StandardFonts.Helvetica);
  const fett = await doc.embedFont(StandardFonts.HelveticaBold);

  seiten.forEach((inhalt, index) => {
    const seite = doc.addPage([595, 842]);
    seite.drawRectangle({ x: 0, y: 762, width: 595, height: 80, color: rgb(0.02, 0.4, 0.42), opacity: 0.1 });
    seite.drawText(inhalt.titel, { x: 56, y: 792, size: 20, font: fett, color: rgb(0.06, 0.09, 0.16) });
    seite.drawText(`Seite ${index + 1} von ${seiten.length}`, {
      x: 56,
      y: 772,
      size: 10,
      font: text,
      color: rgb(0.35, 0.38, 0.42),
    });

    let y = 710;
    for (const zeile of inhalt.zeilen) {
      if (zeile !== '') {
        seite.drawText(zeile, { x: 56, y, size: 11, font: text, color: rgb(0.13, 0.16, 0.2) });
      }
      y -= 22;
    }

    seite.drawText('Vorschaudokument — erfundener Inhalt, nur für die lokale Sichtprüfung.', {
      x: 56,
      y: 60,
      size: 9,
      font: text,
      color: rgb(0.5, 0.53, 0.57),
    });
  });

  return Buffer.from(await doc.save());
}

// ---------------------------------------------------------------------------
//  Ablauf
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('');
  console.log(`  Vorschaudatenbank : ${zielName}`);
  console.log(`  Anwendung         : ${BASIS}`);
  console.log('');

  const org = await prisma.organization.findUniqueOrThrow({ where: { slug: ORG_SLUG } });

  // =========================================================================
  //  1) Konten und Stammdaten — über Prisma
  // =========================================================================

  const adminKonto = await prisma.user.findUnique({ where: { email: PREVIEW_KONTEN.admin.email } });
  if (!adminKonto) {
    throw new Error(
      `Kein Vorschau-Administrationskonto (${PREVIEW_KONTEN.admin.email}). ` +
        'Zuerst `npm run db:preview:setup` — der Konfigurations-Seed legt es an.',
    );
  }

  const mitarbeiterPasswort = await hash(PREVIEW_KONTEN.employee.passwort, ARGON_OPTIONS);
  const mitarbeiterKonto = await prisma.user.upsert({
    where: { email: PREVIEW_KONTEN.employee.email },
    update: {
      passwordHash: mitarbeiterPasswort,
      role: 'EMPLOYEE',
      status: 'ACTIVE',
      deletedAt: null,
      lockedUntil: null,
      failedLoginCount: 0,
      mustChangePassword: false,
    },
    create: {
      organizationId: org.id,
      email: PREVIEW_KONTEN.employee.email,
      passwordHash: mitarbeiterPasswort,
      firstName: 'Petra',
      lastName: 'Vorschau',
      phone: '+41 79 000 00 11',
      role: 'EMPLOYEE',
      status: 'ACTIVE',
      emailVerified: new Date(),
      locale: 'DE',
    },
  });

  const mitarbeiterin = await prisma.employee.upsert({
    where: { userId: mitarbeiterKonto.id },
    update: { active: true, terminatedAt: null, position: 'Reinigungsfachfrau (Vorschau)' },
    create: {
      organizationId: org.id,
      userId: mitarbeiterKonto.id,
      employeeNumber: PERSONALNUMMER,
      employmentType: 'FULL_TIME',
      position: 'Reinigungsfachfrau (Vorschau)',
      department: 'Reinigung',
      hourlyRate: 33,
      color: '#0B7285',
      hiredAt: new Date('2026-01-06T00:00:00.000Z'),
      active: true,
    },
  });

  const kundenPasswort = await hash(PREVIEW_KONTEN.customer.passwort, ARGON_OPTIONS);
  const kundenKonto = await prisma.user.upsert({
    where: { email: PREVIEW_KONTEN.customer.email },
    update: {
      passwordHash: kundenPasswort,
      role: 'CUSTOMER',
      status: 'ACTIVE',
      deletedAt: null,
      lockedUntil: null,
      failedLoginCount: 0,
      mustChangePassword: false,
    },
    create: {
      organizationId: org.id,
      email: PREVIEW_KONTEN.customer.email,
      passwordHash: kundenPasswort,
      firstName: 'Martina',
      lastName: 'Beispiel',
      phone: '+41 79 000 00 22',
      role: 'CUSTOMER',
      status: 'ACTIVE',
      emailVerified: new Date(),
      locale: 'DE',
    },
  });

  const kunde = await prisma.customer.upsert({
    where: { organizationId_number: { organizationId: org.id, number: KUNDENNUMMER } },
    update: { userId: kundenKonto.id, email: PREVIEW_KONTEN.customer.email, deletedAt: null },
    create: {
      organizationId: org.id,
      number: KUNDENNUMMER,
      userId: kundenKonto.id,
      type: 'BUSINESS',
      companyName: 'Beispiel Treuhand AG (Vorschau)',
      firstName: 'Martina',
      lastName: 'Beispiel',
      email: PREVIEW_KONTEN.customer.email,
      phone: '+41 31 000 00 22',
      language: 'DE',
    },
  });

  const adresse =
    (await prisma.address.findFirst({ where: { customerId: kunde.id } })) ??
    (await prisma.address.create({
      data: {
        customerId: kunde.id,
        label: 'Geschäftsadresse',
        street: 'Aarestrasse',
        streetNo: '14',
        postalCode: '3005',
        city: 'Bern',
        canton: 'BE',
        country: 'CH',
        isDefault: true,
        isBilling: true,
      },
    }));

  const objekt =
    (await prisma.property.findFirst({ where: { customerId: kunde.id } })) ??
    (await prisma.property.create({
      data: {
        customerId: kunde.id,
        addressId: adresse.id,
        label: 'Bürohaus Aarestrasse, 2. OG',
        kind: 'OFFICE',
        squareMeters: 240,
        rooms: 9,
        bathrooms: 2,
        windows: 18,
        notes: 'Vorschauobjekt. Schlüsseldepot beim Hauswart, Code im Einsatzblatt.',
      },
    }));

  console.log('✓ Konten und Stammdaten (Administration, Mitarbeiterin, Kundschaft, Adresse, Objekt)');

  // =========================================================================
  //  2) Fachbestand — über die laufende Anwendung
  // =========================================================================

  const adminJar = await anmelden(PREVIEW_KONTEN.admin);
  const mitarbeiterJar = await anmelden(PREVIEW_KONTEN.employee);

  const dienste = nutzlast<{ id: string; slug: string; name: string }[]>(
    await hole('/api/services', adminJar),
    'Leistungen lesen',
  );
  const unterhalt = dienste.find((d) => d.slug === 'unterhaltsreinigung') ?? dienste[0]!;
  const umzug = dienste.find((d) => d.slug === 'umzugsreinigung') ?? unterhalt;

  // --- Offerten -------------------------------------------------------------

  const inTagen = (n: number) => new Date(Date.now() + n * 86_400_000);
  const nurDatum = (d: Date) => d.toISOString().slice(0, 10);

  interface Offerte {
    id: string;
    number: string;
    status: string;
    title: string;
  }

  const bestehendeOfferten = nutzlast<Offerte[]>(
    await hole('/api/quotes?pageSize=100', adminJar),
    'Offerten lesen',
  );

  async function offerteSichern(titel: string, positionen: unknown[]): Promise<Offerte> {
    const vorhanden = bestehendeOfferten.find((q) => q.title === titel);
    if (vorhanden) {
      console.log(`  · Offerte „${titel}" gibt es bereits (${vorhanden.number}, ${vorhanden.status})`);
      return vorhanden;
    }
    const neu = nutzlast<Offerte>(
      await sende(
        '/api/quotes',
        {
          customerId: kunde.id,
          title: titel,
          validUntil: nurDatum(inTagen(30)),
          items: positionen,
          discountValue: 0,
          introText:
            'Vielen Dank für Ihre Anfrage. Gerne unterbreiten wir Ihnen folgendes Angebot für die Räumlichkeiten an der Aarestrasse 14.',
          outroText:
            'Die Ausführung erfolgt nach Absprache innerhalb von zehn Arbeitstagen. Wir freuen uns auf Ihre Rückmeldung.',
        },
        adminJar,
      ),
      `Offerte „${titel}" anlegen`,
    );
    return neu;
  }

  const offerteA = await offerteSichern(TITEL.offerteA, [
    { name: 'Unterhaltsreinigung Büroräume', description: '2× wöchentlich, 240 m²', quantity: 8, unit: 'Std.', unitPrice: 62, discount: 0, vatRate: 8.1, optional: false },
    { name: 'Fensterreinigung innen und aussen', description: '18 Fenster inkl. Rahmen', quantity: 18, unit: 'Stk.', unitPrice: 16, discount: 0, vatRate: 8.1, optional: false },
    { name: 'Endreinigung nach Umbau', description: 'Einmalig, inkl. Feinreinigung', quantity: 1, unit: 'Pauschale', unitPrice: 890, discount: 0, vatRate: 8.1, optional: false },
    { name: 'Teppichtiefenreinigung (optional)', description: 'Sprühextraktion, 40 m²', quantity: 1, unit: 'Pauschale', unitPrice: 320, discount: 0, vatRate: 8.1, optional: true },
  ]);

  const offerteB = await offerteSichern(TITEL.offerteB, [
    { name: 'Treppenhausreinigung', quantity: 4, unit: 'Std.', unitPrice: 58, discount: 0, vatRate: 8.1, optional: false },
    { name: 'Waschküche und Kellerabgang', quantity: 2, unit: 'Std.', unitPrice: 58, discount: 0, vatRate: 8.1, optional: false },
  ]);

  /**
   * Versenden — aber nur, solange die Offerte noch nicht versendet ist. Ein
   * zweiter Versand stellte einen zweiten Zugang aus; der Bestand soll beim
   * wiederholten Lauf gleich bleiben.
   */
  let offertLink = offertLinkAusPostausgang(offerteA.id);
  if (!offertLink) {
    const versand = await sende(`/api/quotes/${offerteA.id}/send`, { attachPdf: true }, adminJar);
    if (versand.status !== 200) {
      throw new Error(`Offertversand: HTTP ${versand.status} — ${versand.text.slice(0, 300)}`);
    }
    offertLink = offertLinkAusPostausgang(offerteA.id);
  }
  console.log(`✓ Offerten: ${offerteA.number} (versendet) und ${offerteB.number} (Entwurf)`);

  // --- Einsätze -------------------------------------------------------------

  interface Einsatz {
    id: string;
    number: string;
    status: string;
    title: string;
  }

  const bestehendeEinsaetze = nutzlast<Einsatz[]>(await hole('/api/jobs?pageSize=100', adminJar), 'Einsätze lesen');

  async function einsatzSichern(
    titel: string,
    dienstId: string,
    tageVoraus: number,
    stunde: number,
  ): Promise<Einsatz> {
    const vorhanden = bestehendeEinsaetze.find((j) => j.title === titel);
    if (vorhanden) {
      console.log(`  · Einsatz „${titel}" gibt es bereits (${vorhanden.number}, ${vorhanden.status})`);
      return vorhanden;
    }
    const beginn = new Date();
    beginn.setDate(beginn.getDate() + tageVoraus);
    beginn.setHours(stunde, 0, 0, 0);
    const ende = new Date(beginn);
    ende.setHours(stunde + 4, 0, 0, 0);

    const neu = nutzlast<Einsatz>(
      await sende(
        '/api/jobs',
        {
          customerId: kunde.id,
          addressId: adresse.id,
          propertyId: objekt.id,
          serviceId: dienstId,
          title: titel,
          scheduledStart: beginn.toISOString(),
          scheduledEnd: ende.toISOString(),
          estimatedMin: 240,
          notes: 'Vorschaueinsatz. Schlüssel beim Hauswart, Parkplatz im Hof.',
        },
        adminJar,
      ),
      `Einsatz „${titel}" anlegen`,
    );

    const zuteilung = await sende(
      `/api/jobs/${neu.id}/assign`,
      { employeeIds: [mitarbeiterin.id], notify: false },
      adminJar,
    );
    if (zuteilung.status !== 200) {
      throw new Error(`Zuteilung für ${neu.number}: HTTP ${zuteilung.status} — ${zuteilung.text.slice(0, 300)}`);
    }
    return neu;
  }

  // Der Einsatz für die Kundenabnahme liegt in der Vergangenheit — er ist ja
  // ausgeführt. Der Folgetermin liegt vorn und bleibt offen.
  const einsatzA = await einsatzSichern(TITEL.einsatzAbgeschlossen, umzug.id, -3, 8);
  const einsatzB = await einsatzSichern(TITEL.einsatzGeplant, unterhalt.id, 6, 7);

  // --- Rapport des abgeschlossenen Einsatzes --------------------------------

  const standA = nutzlast<{ status: string; checklist: { id: string; label: string; done: boolean }[] }>(
    await hole(`/api/jobs/${einsatzA.id}`, adminJar),
    'Einsatz lesen',
  );

  if (standA.status !== 'COMPLETED' && standA.status !== 'VERIFIED') {
    if (standA.checklist.length === 0) {
      const checkliste = await setze(
        `/api/jobs/${einsatzA.id}/checklist`,
        {
          items: [
            { label: 'Böden nass gereinigt', room: 'Alle Räume', required: true },
            { label: 'Fensterrahmen und Griffe entstaubt', room: 'Alle Räume', required: true },
            { label: 'Sanitärbereich entkalkt und desinfiziert', room: 'WC / Dusche', required: true },
            { label: 'Küche: Backofen, Dampfabzug, Kühlschrank innen', room: 'Teeküche', required: true },
            { label: 'Schalter, Türgriffe, Handläufe wischdesinfiziert', room: 'Alle Räume', required: true },
            { label: 'Abfall entsorgt, Behälter gereinigt', room: 'Alle Räume', required: true },
            { label: 'Storen und Vorhangschienen entstaubt', room: 'Büro Süd', required: false },
          ],
          keepProgress: true,
        },
        adminJar,
      );
      if (checkliste.status !== 200) {
        throw new Error(`Checkliste: HTTP ${checkliste.status} — ${checkliste.text.slice(0, 300)}`);
      }
    }

    // Die Mitarbeiterin hakt ab — so entsteht der Rapport, den die Kundschaft
    // später liest.
    const mitCheckliste = nutzlast<{ checklist: { id: string; label: string; done: boolean; required: boolean }[] }>(
      await hole(`/api/jobs/${einsatzA.id}`, mitarbeiterJar),
      'Checkliste lesen',
    );
    for (const punkt of mitCheckliste.checklist) {
      if (punkt.done) continue;
      // Der freiwillige Punkt bleibt offen — ein Rapport, in dem alles
      // abgehakt ist, zeigt nicht, wie ein offener Punkt aussieht.
      if (!punkt.required) continue;
      // `POST`, nicht `PATCH`: Der Endpunkt ist bewusst schlank gehalten,
      // weil er auf der Baustelle im Sekundentakt aufgerufen wird.
      const haken = await sende(`/api/jobs/checklist/${punkt.id}`, { done: true }, mitarbeiterJar);
      if (haken.status !== 200) {
        throw new Error(`Checklistenpunkt: HTTP ${haken.status} — ${haken.text.slice(0, 200)}`);
      }
    }

    const abschluss = await sende(
      `/api/jobs/${einsatzA.id}/complete`,
      {
        completionNote:
          'Endreinigung vollständig ausgeführt. Sämtliche Böden nass gereinigt, Sanitärbereich entkalkt, Küche inklusive Backofen und Dampfabzug gereinigt. Zwei Wasserflecken an der Decke im Büro Nord fotografiert und dem Hauswart gemeldet — nicht reinigungsbedingt. Storen im Büro Süd konnten wegen Montagearbeiten nicht entstaubt werden; Nachholtermin ist mit der Kundschaft besprochen.',
        materials: [
          { name: 'Allzweckreiniger Konzentrat', sku: 'CL-100', quantity: 2, unit: 'Liter', unitCost: 8.4, billable: true },
          { name: 'Entkalker Sanitär', sku: 'CL-220', quantity: 1, unit: 'Liter', unitCost: 12.9, billable: true },
          { name: 'Mikrofasertücher', sku: 'CL-410', quantity: 12, unit: 'Stk.', unitCost: 1.6, billable: false },
          { name: 'Abfallsäcke 110 l', sku: 'CL-905', quantity: 6, unit: 'Stk.', unitCost: 0.9, billable: false },
        ],
      },
      mitarbeiterJar,
    );
    if (abschluss.status !== 200) {
      throw new Error(`Einsatzabschluss: HTTP ${abschluss.status} — ${abschluss.text.slice(0, 300)}`);
    }
  }

  /**
   * Arbeitszeit nachtragen, falls der Abschluss keine gesetzt hat. Ohne
   * `actualStart`/`actualEnd` zeigt der Rapport keine Arbeitszeit — und genau
   * die soll die Kundschaft im Kundenmodus sehen.
   */
  const einsatzZeit = await prisma.job.findUniqueOrThrow({
    where: { id: einsatzA.id },
    select: { actualStart: true, actualEnd: true, scheduledStart: true, customerAcceptedAt: true, status: true },
  });
  if (!einsatzZeit.actualStart || !einsatzZeit.actualEnd) {
    const beginn = new Date(einsatzZeit.scheduledStart);
    beginn.setMinutes(beginn.getMinutes() + 8);
    const ende = new Date(beginn);
    ende.setMinutes(ende.getMinutes() + 265);
    await prisma.job.update({ where: { id: einsatzA.id }, data: { actualStart: beginn, actualEnd: ende } });
  }

  console.log(`✓ Einsätze: ${einsatzA.number} (abgeschlossen, Rapport gefüllt) und ${einsatzB.number} (geplant)`);

  // --- Führungsdokument mit echtem PDF --------------------------------------

  interface Dokument {
    id: string;
    title: string;
  }
  const bestehendeDokumente = nutzlast<Dokument[]>(
    await hole('/api/bi/documents?pageSize=100', adminJar),
    'Dokumente lesen',
  );

  let dokument = bestehendeDokumente.find((d) => d.title === TITEL.dokument) ?? null;
  if (!dokument) {
    const bytes = await qualitaetsrichtlinie();
    const dateiname = 'clenaris-preview-qualitaetsrichtlinie.pdf';

    const ticket = nutzlast<{ ticketId: string; signedUrl: string }>(
      await sende(
        '/api/files/upload-url',
        { profile: 'document', filename: dateiname, mimeType: 'application/pdf', sizeBytes: bytes.byteLength },
        adminJar,
      ),
      'Upload-Ticket',
    );

    const ziel = new URL(ticket.signedUrl, BASIS);
    const upload = await fetch(`${BASIS}${ziel.pathname}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      body: new Uint8Array(bytes),
    });
    if (upload.status !== 200) throw new Error(`Upload: HTTP ${upload.status}`);

    const datei = nutzlast<{ id: string; checksum: string }>(
      await sende('/api/files/finalize', { ticketId: ticket.ticketId, filename: dateiname }, adminJar),
      'Dateiabschluss',
    );

    dokument = nutzlast<Dokument>(
      await sende(
        '/api/bi/documents',
        {
          title: TITEL.dokument,
          category: 'OTHER',
          fileId: datei.id,
          description:
            'Vorschaudokument mit drei Seiten — Qualitätsrichtlinie, Arbeitsablauf, Kontrollpunkte. Erfundener Inhalt.',
        },
        adminJar,
      ),
      'Dokument anlegen',
    );
    console.log(`✓ Führungsdokument mit dreiseitigem PDF (Prüfsumme ${datei.checksum.slice(0, 12)}…)`);
  } else {
    console.log(`  · Führungsdokument „${TITEL.dokument}" gibt es bereits`);
  }

  // =========================================================================
  //  3) Zusammenfassung
  // =========================================================================

  const [vorgaenge, sperren] = await Promise.all([
    prisma.signatureRequest.count(),
    prisma.deviceHandoffSession.count(),
  ]);

  const endstand = await prisma.job.findUniqueOrThrow({
    where: { id: einsatzA.id },
    select: { status: true, customerAcceptedAt: true },
  });

  console.log('');
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log('  VORSCHAUBESTAND BEREIT');
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log('');
  console.log('  Zugänge (NUR LOKALE VORSCHAU):');
  console.log(`    Administration : ${PREVIEW_KONTEN.admin.email} / ${PREVIEW_KONTEN.admin.passwort}`);
  console.log(`    Mitarbeiterin  : ${PREVIEW_KONTEN.employee.email} / ${PREVIEW_KONTEN.employee.passwort}`);
  console.log(`    Kundschaft     : ${PREVIEW_KONTEN.customer.email} / ${PREVIEW_KONTEN.customer.passwort}`);
  console.log('');
  console.log(`  Offerte (Gate 4C) : ${offerteA.number} — ${TITEL.offerteA}`);
  console.log(`  Öffentlicher Link : ${offertLink ?? '(nicht im Postausgang gefunden)'}`);
  console.log(`  Zweite Offerte    : ${offerteB.number} (Entwurf, zum Vergleich)`);
  console.log('');
  console.log(`  Einsatz (Gate 4D) : ${einsatzA.number} — Status ${endstand.status}, Kundenabnahme ${endstand.customerAcceptedAt ? 'bereits erfolgt' : 'offen'}`);
  console.log(`  Zweiter Einsatz   : ${einsatzB.number} (geplant)`);
  console.log('');
  console.log(`  Dokument (Gate 3) : ${TITEL.dokument}`);
  console.log('');
  console.log(`  Signaturvorgänge  : ${vorgaenge}   Gerätesperren : ${sperren}   (beide sollen 0 sein)`);
  console.log('');

  await prisma.$disconnect();
}

main().catch(async (fehler) => {
  console.error('');
  console.error(`❌  ${fehler instanceof Error ? fehler.message : String(fehler)}`);
  console.error('');
  await prisma.$disconnect();
  process.exit(1);
});
