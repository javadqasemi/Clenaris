/**
 * Datenbank-Seed — die Konfiguration eines arbeitsfähigen Betriebs.
 *
 * Firma, Öffnungszeiten und Feiertage, Einsatzgebiet, Steuersätze,
 * Leistungskatalog mit Zusätzen und Preisregeln, Team, Lieferant, häufige
 * Fragen, Stellenausschreibungen, Gutscheine, Automationen, Handlungsaufrufe
 * und Navigation.
 *
 * **Keine Geschäftsdaten.** Keine Kundschaft, keine Buchungen, keine
 * Rechnungen, keine Bewertungen, keine Galerie, keine Blogartikel. Das ist
 * Absicht: Diese Datensätze wären erfunden, und erfundene Kundenstimmen auf
 * einer öffentlichen Website sind nicht bloss unsauber, sondern
 * wettbewerbsrechtlich heikel. Ein Betrieb, der loslegt, soll mit einer
 * leeren Bewertungsliste starten und sie mit echten Stimmen füllen.
 *
 * Wer Demodaten zum Entwickeln oder Vorführen braucht — und die Prüfsuite
 * braucht sie —, nimmt zusätzlich `prisma/seed-demo.ts`.
 *
 * Beide Seeds sind idempotent: Mehrfaches Ausführen aktualisiert bestehende
 * Datensätze, statt Duplikate zu erzeugen.
 *
 *   npm run db:seed        nur diese Konfiguration
 *   npm run db:seed:demo   zusätzlich die Demodaten
 */

import { PrismaClient, type Prisma } from '@prisma/client';
import { hash } from '@node-rs/argon2';

const prisma = new PrismaClient();

const ORG_SLUG = 'clenaris';
const ARGON_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

function daysFromNow(days: number, hour = 8, minute = 0): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hour, minute, 0, 0);
  return date;
}

function randomCode(length = 6): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

async function main() {
  console.log('🌱  Seed startet …\n');

  // =========================================================================
  //  1) Organisation
  // =========================================================================
  const org = await prisma.organization.upsert({
    where: { slug: ORG_SLUG },
    update: {},
    create: {
      slug: ORG_SLUG,
      name: process.env.COMPANY_NAME ?? 'Clenaris Reinigungen GmbH',
      legalName: 'Clenaris Reinigungen GmbH',
      email: process.env.COMPANY_EMAIL ?? 'info@clenaris.ch',
      phone: process.env.COMPANY_PHONE ?? '+41 31 511 22 33',
      website: 'https://clenaris.ch',
      street: process.env.COMPANY_STREET ?? 'Bahnhofstrasse',
      streetNo: '1',
      postalCode: process.env.COMPANY_ZIP ?? '3011',
      city: process.env.COMPANY_CITY ?? 'Bern',
      canton: 'BE',
      country: 'CH',
      vatNumber: process.env.COMPANY_VAT_NUMBER ?? 'CHE-123.456.789 MWST',
      uid: 'CHE-123.456.789',
      iban: (process.env.COMPANY_IBAN ?? 'CH93 0076 2011 6238 5295 7').replace(/\s/g, ''),
      qrIban: (process.env.COMPANY_QR_IBAN ?? 'CH44 3199 9123 0008 8901 2').replace(/\s/g, ''),
      bankName: 'Berner Kantonalbank AG',
      defaultVat: 8.1,
      currency: 'CHF',
      timezone: 'Europe/Zurich',
      locale: 'DE',
      paymentTerm: 30,
      primaryColor: '#0B7285',
      secondaryColor: '#0F172A',
      whatsapp: '+41 79 511 22 33',
      mapsUrl: 'https://maps.google.com/?q=Bahnhofstrasse+1,+3011+Bern',
      facebookUrl: 'https://facebook.com/clenaris',
      instagramUrl: 'https://instagram.com/clenaris',
      linkedinUrl: 'https://linkedin.com/company/clenaris',
      settings: {
        bookingLeadTimeHours: 4,
        cancellationWindowHours: 24,
        autoConfirmBookings: false,
        reviewRequestDelayHours: 24,
      },
    },
  });
  console.log(`✓ Organisation: ${org.name}`);

  // =========================================================================
  //  2) Öffnungszeiten & Feiertage
  // =========================================================================
  const hours = [
    { weekday: 0, closed: true, opensAt: null, closesAt: null }, // Sonntag
    { weekday: 1, closed: false, opensAt: '07:00', closesAt: '18:00' },
    { weekday: 2, closed: false, opensAt: '07:00', closesAt: '18:00' },
    { weekday: 3, closed: false, opensAt: '07:00', closesAt: '18:00' },
    { weekday: 4, closed: false, opensAt: '07:00', closesAt: '18:00' },
    { weekday: 5, closed: false, opensAt: '07:00', closesAt: '18:00' },
    { weekday: 6, closed: false, opensAt: '08:00', closesAt: '14:00' }, // Samstag
  ];

  for (const entry of hours) {
    await prisma.openingHours.upsert({
      where: { organizationId_weekday: { organizationId: org.id, weekday: entry.weekday } },
      update: entry,
      create: { organizationId: org.id, ...entry },
    });
  }

  const year = new Date().getFullYear();
  const holidays = [
    { name: 'Neujahr', date: `${year}-01-01` },
    { name: 'Berchtoldstag', date: `${year}-01-02` },
    { name: 'Karfreitag', date: `${year}-04-03` },
    { name: 'Ostermontag', date: `${year}-04-06` },
    { name: 'Tag der Arbeit', date: `${year}-05-01` },
    { name: 'Auffahrt', date: `${year}-05-14` },
    { name: 'Pfingstmontag', date: `${year}-05-25` },
    { name: 'Bundesfeier', date: `${year}-08-01` },
    { name: 'Weihnachten', date: `${year}-12-25` },
    { name: 'Stephanstag', date: `${year}-12-26` },
  ];

  for (const holiday of holidays) {
    await prisma.holiday.upsert({
      where: {
        organizationId_date_name: {
          organizationId: org.id,
          date: new Date(`${holiday.date}T00:00:00.000Z`),
          name: holiday.name,
        },
      },
      update: {},
      create: {
        organizationId: org.id,
        name: holiday.name,
        date: new Date(`${holiday.date}T00:00:00.000Z`),
        recurring: true,
        canton: 'BE',
      },
    });
  }
  console.log(`✓ Öffnungszeiten und ${holidays.length} Feiertage`);

  // =========================================================================
  //  3) Einsatzgebiet (Kanton Bern)
  // =========================================================================
  const areas = [
    { postalCode: '3000', city: 'Bern', travelFee: 0, travelMinutes: 5, lat: 46.948, lng: 7.4474 },
    { postalCode: '3005', city: 'Bern', travelFee: 0, travelMinutes: 8, lat: 46.9385, lng: 7.4443 },
    { postalCode: '3006', city: 'Bern', travelFee: 0, travelMinutes: 9, lat: 46.9469, lng: 7.4708 },
    { postalCode: '3007', city: 'Bern', travelFee: 0, travelMinutes: 7, lat: 46.943, lng: 7.4308 },
    { postalCode: '3008', city: 'Bern', travelFee: 0, travelMinutes: 8, lat: 46.9455, lng: 7.4213 },
    { postalCode: '3011', city: 'Bern', travelFee: 0, travelMinutes: 3, lat: 46.9481, lng: 7.4474 },
    { postalCode: '3012', city: 'Bern', travelFee: 0, travelMinutes: 8, lat: 46.9531, lng: 7.4344 },
    { postalCode: '3013', city: 'Bern', travelFee: 0, travelMinutes: 9, lat: 46.9585, lng: 7.4483 },
    { postalCode: '3014', city: 'Bern', travelFee: 0, travelMinutes: 11, lat: 46.9628, lng: 7.4499 },
    { postalCode: '3018', city: 'Bern', travelFee: 15, travelMinutes: 14, lat: 46.9377, lng: 7.4008 },
    { postalCode: '3027', city: 'Bern', travelFee: 15, travelMinutes: 16, lat: 46.9642, lng: 7.3892 },
    { postalCode: '3032', city: 'Hinterkappelen', travelFee: 25, travelMinutes: 18 },
    { postalCode: '3037', city: 'Herrenschwanden', travelFee: 25, travelMinutes: 15 },
    { postalCode: '3048', city: 'Worblaufen', travelFee: 25, travelMinutes: 14 },
    { postalCode: '3052', city: 'Zollikofen', travelFee: 25, travelMinutes: 16 },
    { postalCode: '3053', city: 'Münchenbuchsee', travelFee: 35, travelMinutes: 21 },
    { postalCode: '3063', city: 'Ittigen', travelFee: 25, travelMinutes: 13 },
    { postalCode: '3065', city: 'Bolligen', travelFee: 25, travelMinutes: 17 },
    { postalCode: '3072', city: 'Ostermundigen', travelFee: 20, travelMinutes: 12 },
    { postalCode: '3073', city: 'Gümligen', travelFee: 25, travelMinutes: 15 },
    { postalCode: '3074', city: 'Muri bei Bern', travelFee: 25, travelMinutes: 14 },
    { postalCode: '3084', city: 'Wabern', travelFee: 20, travelMinutes: 12 },
    { postalCode: '3095', city: 'Spiegel bei Bern', travelFee: 20, travelMinutes: 13 },
    { postalCode: '3097', city: 'Liebefeld', travelFee: 20, travelMinutes: 11 },
    { postalCode: '3098', city: 'Köniz', travelFee: 25, travelMinutes: 15 },
    { postalCode: '3110', city: 'Münsingen', travelFee: 45, travelMinutes: 26 },
    { postalCode: '3123', city: 'Belp', travelFee: 35, travelMinutes: 22 },
    { postalCode: '3172', city: 'Niederwangen', travelFee: 30, travelMinutes: 18 },
    { postalCode: '3184', city: 'Wünnewil', travelFee: 45, travelMinutes: 28 },
    { postalCode: '3250', city: 'Lyss', travelFee: 55, travelMinutes: 32 },
    { postalCode: '3400', city: 'Burgdorf', travelFee: 55, travelMinutes: 33 },
    { postalCode: '3600', city: 'Thun', travelFee: 65, travelMinutes: 38 },
    { postalCode: '2502', city: 'Biel/Bienne', travelFee: 70, travelMinutes: 42 },
  ];

  for (const area of areas) {
    await prisma.serviceArea.upsert({
      where: { organizationId_postalCode: { organizationId: org.id, postalCode: area.postalCode } },
      update: { travelFee: area.travelFee, travelMinutes: area.travelMinutes },
      create: {
        organizationId: org.id,
        postalCode: area.postalCode,
        city: area.city,
        canton: 'BE',
        travelFee: area.travelFee,
        travelMinutes: area.travelMinutes,
        lat: area.lat ?? null,
        lng: area.lng ?? null,
        active: true,
      },
    });
  }
  console.log(`✓ ${areas.length} Postleitzahlen im Einsatzgebiet`);

  // =========================================================================
  //  4) Steuersätze & Pipeline
  // =========================================================================
  const taxRates = [
    { name: 'Normalsatz', rate: 8.1, isDefault: true },
    { name: 'Reduzierter Satz', rate: 2.6, isDefault: false },
    { name: 'Beherbergung', rate: 3.8, isDefault: false },
    { name: 'Von der Steuer befreit', rate: 0, isDefault: false },
  ];
  for (const rate of taxRates) {
    await prisma.taxRate.upsert({
      where: { organizationId_name: { organizationId: org.id, name: rate.name } },
      update: { rate: rate.rate },
      create: { organizationId: org.id, ...rate },
    });
  }

  const stages = [
    { key: 'new', name: 'Neu', color: '#94A3B8', position: 0 },
    { key: 'contacted', name: 'Kontaktiert', color: '#1971C2', position: 1 },
    { key: 'qualified', name: 'Qualifiziert', color: '#0B7285', position: 2 },
    { key: 'proposal', name: 'Offerte versendet', color: '#5F3DC4', position: 3 },
    { key: 'won', name: 'Gewonnen', color: '#2B8A3E', position: 4, isWon: true },
    { key: 'lost', name: 'Verloren', color: '#C92A2A', position: 5, isLost: true },
  ];
  for (const stage of stages) {
    await prisma.pipelineStage.upsert({
      where: { organizationId_key: { organizationId: org.id, key: stage.key } },
      update: { name: stage.name, color: stage.color, position: stage.position },
      create: { organizationId: org.id, ...stage },
    });
  }

  const tagNames = [
    { name: 'Stammkunde', color: '#2B8A3E' },
    { name: 'Grosskunde', color: '#5F3DC4' },
    { name: 'Liegenschaftsverwaltung', color: '#1971C2' },
    { name: 'Abo-Vertrag', color: '#0B7285' },
    { name: 'Zahlungsverzug', color: '#C92A2A' },
    { name: 'Empfehlung', color: '#E8590C' },
  ];
  for (const tag of tagNames) {
    await prisma.tag.upsert({
      where: { organizationId_name: { organizationId: org.id, name: tag.name } },
      update: { color: tag.color },
      create: { organizationId: org.id, ...tag },
    });
  }
  console.log('✓ Steuersätze, Pipeline-Stufen und Labels');

  // =========================================================================
  //  5) Leistungskatalog
  // =========================================================================
  const categories = [
    { slug: 'privat', name: 'Private Haushalte', icon: 'Home', position: 0, description: 'Regelmässige und einmalige Reinigung für Wohnungen und Häuser.' },
    { slug: 'geschaeft', name: 'Geschäftskunden', icon: 'Building2', position: 1, description: 'Büros, Praxen, Ladenlokale und Liegenschaften.' },
    { slug: 'spezial', name: 'Spezialreinigung', icon: 'Sparkles', position: 2, description: 'Umzug, Baustelle, Fenster und Sonderaufträge.' },
  ];

  const categoryIds: Record<string, string> = {};
  for (const category of categories) {
    const created = await prisma.serviceCategory.upsert({
      where: { organizationId_slug: { organizationId: org.id, slug: category.slug } },
      update: { name: category.name, description: category.description },
      create: { organizationId: org.id, ...category },
    });
    categoryIds[category.slug] = created.id;
  }

  // `Unchecked…` verwenden: wir setzen `categoryId` als Skalar, nicht über eine
  // verschachtelte `connect`-Relation.
  const services: Prisma.ServiceUncheckedCreateWithoutOrganizationInput[] = [
    {
      slug: 'unterhaltsreinigung',
      kind: 'RESIDENTIAL_CLEANING',
      name: 'Unterhaltsreinigung',
      nameEn: 'Regular home cleaning',
      nameFr: 'Nettoyage d’entretien',
      nameIt: 'Pulizia di mantenimento',
      shortDesc: 'Ihre Wohnung regelmässig sauber — ohne dass Sie einen Finger rühren.',
      description:
        'Wir übernehmen die wiederkehrende Reinigung Ihrer Wohnung oder Ihres Hauses: Böden, Bad, Küche, Staub und Fensterbänke. Immer dasselbe Team, immer dieselbe Qualität. Reinigungsmittel und Material bringen wir mit.',
      icon: 'Home',
      featured: true,
      position: 0,
      pricingModel: 'PER_HOUR',
      basePrice: 0,
      hourlyRate: 62,
      minPrice: 124,
      minHours: 2,
      minutesPerSqm: 1.2,
      defaultDurationMin: 150,
      defaultCrewSize: 1,
      bufferMinutes: 30,
      seoTitle: 'Unterhaltsreinigung Bern — ab CHF 62/Std. | Clenaris',
      seoDescription:
        'Regelmässige Wohnungsreinigung im Raum Bern. Festes Team, transparente Preise ab CHF 62 pro Stunde. Jetzt online buchen.',
      keywords: ['Unterhaltsreinigung Bern', 'Putzfrau Bern', 'Wohnungsreinigung', 'Haushaltshilfe Bern'],
      bulletPoints: [
        'Festes, geprüftes Team',
        'Material und Reinigungsmittel inklusive',
        'Bis 15 % Rabatt bei wiederkehrender Reinigung',
        'Jederzeit kündbar, keine Mindestlaufzeit',
      ],
      includes: [
        'Böden saugen und feucht reinigen',
        'Bad und WC reinigen und entkalken',
        'Küche inkl. Arbeitsflächen und Spüle',
        'Staub wischen auf allen erreichbaren Flächen',
        'Abfall entsorgen',
      ],
      excludes: ['Fensterreinigung aussen', 'Backofen innen', 'Kellerräume', 'Wäsche und Bügeln'],
    },
    {
      slug: 'umzugsreinigung',
      kind: 'MOVE_OUT_CLEANING',
      name: 'Umzugsreinigung mit Abgabegarantie',
      nameEn: 'Move-out cleaning',
      nameFr: 'Nettoyage de déménagement',
      nameIt: 'Pulizia di trasloco',
      shortDesc: 'Wohnungsabgabe ohne Stress — wir garantieren die Abnahme.',
      description:
        'Die Umzugsreinigung entscheidet über Ihre Kaution. Wir reinigen nach dem offiziellen Abgabeprotokoll und begleiten die Übergabe. Sollte die Verwaltung etwas beanstanden, kommen wir kostenlos zurück — das ist unsere Abgabegarantie.',
      icon: 'Truck',
      featured: true,
      position: 1,
      pricingModel: 'PER_SQM',
      basePrice: 120,
      pricePerSqm: 6.5,
      minPrice: 480,
      minHours: 4,
      minutesPerSqm: 2.4,
      defaultDurationMin: 420,
      defaultCrewSize: 2,
      bufferMinutes: 60,
      seoTitle: 'Umzugsreinigung Bern mit Abgabegarantie | Clenaris',
      seoDescription:
        'Umzugsreinigung im Raum Bern mit Abnahmegarantie. Fixpreis nach m², Termin online buchbar. Wir übergeben die Wohnung für Sie.',
      keywords: ['Umzugsreinigung Bern', 'Wohnungsübergabe', 'Abgabegarantie', 'Endreinigung Bern'],
      bulletPoints: [
        'Abgabegarantie: kostenlose Nachreinigung',
        'Fixpreis nach Quadratmetern',
        'Fenster, Storen und Backofen inklusive',
        'Übergabebegleitung auf Wunsch',
      ],
      includes: [
        'Küche inkl. Backofen, Dampfabzug und Kühlschrank',
        'Bad vollständig entkalkt, inkl. Fugen',
        'Fenster innen und aussen inkl. Rahmen und Storen',
        'Böden, Sockelleisten und Heizkörper',
        'Keller, Estrich und Balkon',
      ],
      excludes: ['Entsorgung von Mobiliar', 'Malerarbeiten', 'Teppichshampoonierung'],
    },
    {
      slug: 'bueroreinigung',
      kind: 'OFFICE_CLEANING',
      name: 'Büroreinigung',
      nameEn: 'Office cleaning',
      nameFr: 'Nettoyage de bureaux',
      nameIt: 'Pulizia uffici',
      shortDesc: 'Saubere Arbeitsplätze — ausserhalb Ihrer Geschäftszeiten.',
      description:
        'Wir reinigen Ihre Büroräume, Sitzungszimmer und Sanitäranlagen zu Randzeiten, damit der Betrieb ungestört läuft. Auf Wunsch mit Schlüsseldepot, Verbrauchsmaterialverwaltung und monatlicher Qualitätskontrolle.',
      icon: 'Building2',
      featured: true,
      position: 2,
      pricingModel: 'PER_SQM',
      basePrice: 0,
      pricePerSqm: 1.1,
      minPrice: 180,
      minHours: 2,
      minutesPerSqm: 1,
      defaultDurationMin: 180,
      defaultCrewSize: 2,
      seoTitle: 'Büroreinigung Bern — zuverlässig und diskret | Clenaris',
      seoDescription:
        'Professionelle Büroreinigung im Raum Bern. Reinigung ausserhalb der Geschäftszeiten, Verbrauchsmaterial inklusive. Offerte in 24 Stunden.',
      keywords: ['Büroreinigung Bern', 'Unterhaltsreinigung Gewerbe', 'Reinigungsfirma Bern'],
      bulletPoints: [
        'Reinigung ausserhalb der Geschäftszeiten',
        'Fixes Team mit Schlüsseldepot',
        'Verbrauchsmaterial auf Wunsch inklusive',
        'Monatlicher Qualitätsbericht',
      ],
      includes: [
        'Arbeitsplätze und Sitzungszimmer',
        'Sanitäranlagen inkl. Desinfektion',
        'Küche und Pausenräume',
        'Böden, Glastüren und Eingangsbereich',
        'Abfall- und Recyclingentsorgung',
      ],
      excludes: ['IT-Geräte im Detail', 'Aussenanlagen', 'Fassadenreinigung'],
    },
    {
      slug: 'fensterreinigung',
      kind: 'WINDOW_CLEANING',
      name: 'Fensterreinigung',
      nameEn: 'Window cleaning',
      nameFr: 'Nettoyage de vitres',
      nameIt: 'Pulizia vetri',
      shortDesc: 'Streifenfreie Sicht — innen, aussen, inklusive Rahmen und Storen.',
      description:
        'Wir reinigen Fenster streifenfrei mit entmineralisiertem Wasser. Rahmen, Falze und Fensterbänke werden feucht nachgezogen, Storen abgestaubt. Für höhere Lagen arbeiten wir mit Teleskopsystemen bis 12 Meter.',
      icon: 'PanelsTopLeft',
      position: 3,
      pricingModel: 'PER_UNIT',
      basePrice: 60,
      hourlyRate: 14,
      minPrice: 160,
      minHours: 1.5,
      defaultDurationMin: 120,
      defaultCrewSize: 1,
      seoTitle: 'Fensterreinigung Bern — ab CHF 14 pro Fenster | Clenaris',
      seoDescription:
        'Streifenfreie Fensterreinigung im Raum Bern. Inkl. Rahmen, Falze und Storen. Preis pro Fenster, sofort online berechenbar.',
      keywords: ['Fensterreinigung Bern', 'Fensterputzer Bern', 'Storenreinigung'],
      bulletPoints: [
        'Preis pro Fenster, keine Überraschungen',
        'Osmose-Verfahren für streifenfreie Ergebnisse',
        'Rahmen, Falze und Fensterbänke inklusive',
        'Arbeiten bis 12 Meter Höhe',
      ],
      includes: ['Glas innen und aussen', 'Rahmen und Falze', 'Fensterbänke', 'Storen abstauben'],
      excludes: ['Storenreparatur', 'Fassadenreinigung', 'Dachfenster über 12 m'],
    },
    {
      slug: 'baureinigung',
      kind: 'CONSTRUCTION_CLEANING',
      name: 'Baureinigung',
      nameEn: 'Post-construction cleaning',
      nameFr: 'Nettoyage de chantier',
      nameIt: 'Pulizia cantiere',
      shortDesc: 'Von der Grobreinigung bis zur bezugsbereiten Übergabe.',
      description:
        'Wir übernehmen Bauzwischen-, Bauend- und Bauschlussreinigung. Zementschleier, Kleberreste und Farbspritzer entfernen wir fachgerecht, ohne Oberflächen zu beschädigen. Terminplanung in Absprache mit der Bauleitung.',
      icon: 'HardHat',
      position: 4,
      pricingModel: 'PER_SQM',
      basePrice: 180,
      pricePerSqm: 8.5,
      minPrice: 850,
      minHours: 6,
      minutesPerSqm: 3.2,
      defaultDurationMin: 480,
      defaultCrewSize: 3,
      seoTitle: 'Baureinigung Bern — Grob-, End- und Schlussreinigung | Clenaris',
      seoDescription:
        'Baureinigung im Kanton Bern. Zementschleierentfernung, Endreinigung und Übergabekontrolle mit der Bauleitung.',
      keywords: ['Baureinigung Bern', 'Bauendreinigung', 'Zementschleierentfernung'],
      bulletPoints: [
        'Grob-, End- und Schlussreinigung aus einer Hand',
        'Fachgerechte Entfernung von Zementschleier',
        'Industriesauger und Bautrockner',
        'Übergabeprotokoll mit der Bauleitung',
      ],
      includes: [
        'Bauschutt und Verpackungen entfernen',
        'Fenster inkl. Schutzfolien',
        'Sanitär- und Küchenbereiche',
        'Böden nass reinigen und imprägnieren',
      ],
      excludes: ['Entsorgungsgebühren Mulde', 'Gerüstbau', 'Asbestsanierung'],
    },
    {
      slug: 'hauswartung',
      kind: 'BUILDING_MAINTENANCE',
      name: 'Hauswartung & Liegenschaftsbetreuung',
      nameEn: 'Building maintenance',
      nameFr: 'Conciergerie',
      nameIt: 'Custodia stabili',
      shortDesc: 'Treppenhaus, Umgebung und Winterdienst — alles aus einer Hand.',
      description:
        'Wir betreuen Ihre Liegenschaft ganzjährig: Treppenhausreinigung, Waschküche, Aussenanlagen, Entsorgungsstelle und Winterdienst. Sie erhalten einen festen Ansprechpartner und ein monatliches Protokoll inklusive Schadenmeldungen.',
      icon: 'Building',
      position: 5,
      pricingModel: 'ON_REQUEST',
      basePrice: 0,
      minPrice: 0,
      minHours: 2,
      defaultDurationMin: 180,
      defaultCrewSize: 1,
      seoTitle: 'Hauswartung Bern — Liegenschaftsbetreuung | Clenaris',
      seoDescription:
        'Hauswartung und Liegenschaftsbetreuung im Raum Bern: Treppenhaus, Umgebung, Entsorgung und Winterdienst. Individuelle Offerte.',
      keywords: ['Hauswartung Bern', 'Liegenschaftsbetreuung', 'Treppenhausreinigung Bern'],
      bulletPoints: [
        'Fester Ansprechpartner',
        'Monatliches Protokoll mit Schadenmeldungen',
        'Winterdienst nach SIA-Norm',
        'Rufbereitschaft für Notfälle',
      ],
      includes: [
        'Treppenhaus und Eingangsbereich',
        'Waschküche und Trocknungsraum',
        'Umgebungspflege und Kehren',
        'Entsorgungsstelle kontrollieren',
        'Beleuchtung und kleine Reparaturen',
      ],
      excludes: ['Gartenbau', 'Sanitärinstallationen', 'Elektroarbeiten'],
    },
  ];

  const serviceIds: Record<string, string> = {};
  for (const service of services) {
    const categorySlug =
      service.kind === 'RESIDENTIAL_CLEANING'
        ? 'privat'
        : service.kind === 'OFFICE_CLEANING' || service.kind === 'BUILDING_MAINTENANCE'
          ? 'geschaeft'
          : 'spezial';

    const created = await prisma.service.upsert({
      where: { organizationId_slug: { organizationId: org.id, slug: service.slug } },
      update: {
        name: service.name,
        shortDesc: service.shortDesc,
        description: service.description,
        hourlyRate: service.hourlyRate,
        pricePerSqm: service.pricePerSqm,
        basePrice: service.basePrice,
        minPrice: service.minPrice,
      },
      create: {
        ...service,
        organizationId: org.id,
        categoryId: categoryIds[categorySlug],
      },
    });
    serviceIds[service.slug] = created.id;
  }
  console.log(`✓ ${services.length} Dienstleistungen in ${categories.length} Kategorien`);

  // =========================================================================
  //  6) Zusatzleistungen
  // =========================================================================
  const extras = [
    { slug: 'backofen', name: 'Backofen innen reinigen', price: 45, durationMin: 40, icon: 'Flame', description: 'Fettlösung und Nachreinigung inkl. Backblech.' },
    { slug: 'kuehlschrank', name: 'Kühlschrank innen reinigen', price: 35, durationMin: 25, icon: 'Refrigerator', description: 'Ausräumen, reinigen, desinfizieren.' },
    { slug: 'fenster-innen', name: 'Fenster innen (pro Fenster)', price: 9, durationMin: 6, icon: 'PanelsTopLeft', description: 'Glas und Rahmen innen.' },
    { slug: 'balkon', name: 'Balkon / Terrasse', price: 55, durationMin: 40, icon: 'Trees', description: 'Boden, Geländer und Fensterbänke.' },
    { slug: 'keller', name: 'Keller / Estrich', price: 65, durationMin: 50, icon: 'Package', description: 'Saugen, feucht reinigen, Spinnweben entfernen.' },
    { slug: 'schraenke-innen', name: 'Schränke innen', price: 40, durationMin: 35, icon: 'Archive', description: 'Alle Küchen- und Wandschränke innen.' },
    { slug: 'teppich', name: 'Teppichshampoonierung (pro 10 m²)', price: 75, durationMin: 45, icon: 'Layers', description: 'Sprühextraktion inkl. Trocknungszeit.' },
    { slug: 'desinfektion', name: 'Desinfektion Kontaktflächen', price: 50, durationMin: 30, icon: 'ShieldCheck', description: 'Türgriffe, Schalter, Armaturen.' },
    { slug: 'storen', name: 'Storen / Lamellen reinigen', price: 25, durationMin: 20, icon: 'Blinds', description: 'Pro Fensterfront, feucht gereinigt.' },
    { slug: 'polster', name: 'Polstermöbel reinigen', price: 95, durationMin: 60, icon: 'Sofa', description: 'Sofa bis 3 Plätze, Sprühextraktion.' },
    { slug: 'express', name: 'Express-Termin (innert 48 Std.)', price: 60, durationMin: 0, icon: 'Zap', description: 'Priorisierte Einplanung.' },
    { slug: 'schluesselservice', name: 'Schlüsselservice', price: 20, durationMin: 0, icon: 'Key', description: 'Abholung und Rückgabe des Schlüssels.' },
  ];

  const extraIds: Record<string, string> = {};
  for (const [index, extra] of extras.entries()) {
    const created = await prisma.serviceExtra.upsert({
      where: { organizationId_slug: { organizationId: org.id, slug: extra.slug } },
      update: { price: extra.price, name: extra.name },
      create: {
        organizationId: org.id,
        slug: extra.slug,
        name: extra.name,
        description: extra.description,
        icon: extra.icon,
        price: extra.price,
        durationMin: extra.durationMin,
        position: index,
      },
    });
    extraIds[extra.slug] = created.id;
  }

  // Zusatzleistungen den passenden Diensten zuordnen.
  const extraMapping: Record<string, string[]> = {
    unterhaltsreinigung: ['backofen', 'kuehlschrank', 'fenster-innen', 'balkon', 'desinfektion', 'polster', 'express', 'schluesselservice'],
    umzugsreinigung: ['balkon', 'keller', 'schraenke-innen', 'teppich', 'storen', 'polster', 'express'],
    bueroreinigung: ['fenster-innen', 'desinfektion', 'teppich', 'storen'],
    fensterreinigung: ['storen', 'express'],
    baureinigung: ['keller', 'teppich', 'storen'],
  };

  for (const [serviceSlug, extraSlugs] of Object.entries(extraMapping)) {
    for (const extraSlug of extraSlugs) {
      await prisma.serviceExtraOnService.upsert({
        where: {
          serviceId_extraId: {
            serviceId: serviceIds[serviceSlug],
            extraId: extraIds[extraSlug],
          },
        },
        update: {},
        create: { serviceId: serviceIds[serviceSlug], extraId: extraIds[extraSlug] },
      });
    }
  }
  console.log(`✓ ${extras.length} Zusatzleistungen`);

  // =========================================================================
  //  7) Preisregeln
  // =========================================================================
  await prisma.priceRule.deleteMany({ where: { service: { organizationId: org.id } } });

  const priceRules = [
    {
      serviceId: null,
      name: 'Samstagszuschlag',
      condition: { weekday: [6] },
      multiplier: 1.25,
      surcharge: 0,
      priority: 10,
    },
    {
      serviceId: null,
      name: 'Abendzuschlag ab 18 Uhr',
      condition: { hourFrom: 18 },
      multiplier: 1.2,
      surcharge: 0,
      priority: 11,
    },
    {
      serviceId: serviceIds['unterhaltsreinigung'],
      name: 'Zuschlag Haustiere',
      condition: { hasPets: true },
      multiplier: 1,
      surcharge: 15,
      priority: 20,
    },
    {
      serviceId: serviceIds['unterhaltsreinigung'],
      name: 'Grossobjektrabatt ab 150 m²',
      condition: { minSqm: 150 },
      multiplier: 0.94,
      surcharge: 0,
      priority: 30,
    },
    {
      serviceId: serviceIds['umzugsreinigung'],
      name: 'Zuschlag Einfamilienhaus',
      condition: { propertyKind: ['HOUSE'] },
      multiplier: 1.15,
      surcharge: 0,
      priority: 20,
    },
    {
      serviceId: serviceIds['bueroreinigung'],
      name: 'Rabatt Grossfläche ab 400 m²',
      condition: { minSqm: 400 },
      multiplier: 0.9,
      surcharge: 0,
      priority: 30,
    },
  ];

  for (const rule of priceRules) {
    await prisma.priceRule.create({
      data: {
        serviceId: rule.serviceId,
        name: rule.name,
        condition: rule.condition as Prisma.InputJsonValue,
        multiplier: rule.multiplier,
        surcharge: rule.surcharge,
        priority: rule.priority,
        active: true,
      },
    });
  }
  console.log(`✓ ${priceRules.length} Preisregeln`);

  // =========================================================================
  //  8) Benutzer & Team
  // =========================================================================
  const adminPassword = await hash(
    process.env.SEED_ADMIN_PASSWORD ?? 'Admin#2026Clenaris',
    ARGON_OPTIONS,
  );
  const demoPassword = await hash('Demo#2026Clenaris', ARGON_OPTIONS);

  const admin = await prisma.user.upsert({
    where: { email: process.env.SEED_ADMIN_EMAIL ?? 'admin@clenaris.ch' },
    update: { passwordHash: adminPassword, role: 'ADMIN', status: 'ACTIVE' },
    create: {
      organizationId: org.id,
      email: process.env.SEED_ADMIN_EMAIL ?? 'admin@clenaris.ch',
      passwordHash: adminPassword,
      firstName: 'Sandra',
      lastName: 'Bühler',
      role: 'ADMIN',
      status: 'ACTIVE',
      emailVerified: new Date(),
      locale: 'DE',
    },
  });

  /**
   * Systemverantwortung: vergibt Rollen und liest das Prüfprotokoll.
   *
   * Bewusst ein eigenes Konto und nicht die Administration selbst — wer
   * überwacht wird, soll die Überwachung nicht einsehen und sich nicht selbst
   * höherstufen können.
   */
  await prisma.user.upsert({
    where: { email: process.env.SEED_SUPERADMIN_EMAIL ?? 'system@clenaris.ch' },
    update: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
    create: {
      organizationId: org.id,
      email: process.env.SEED_SUPERADMIN_EMAIL ?? 'system@clenaris.ch',
      passwordHash: await hash(
        process.env.SEED_SUPERADMIN_PASSWORD ?? 'System#2026Clenaris',
        ARGON_OPTIONS,
      ),
      firstName: 'System',
      lastName: 'Verantwortung',
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      emailVerified: new Date(),
      locale: 'DE',
    },
  });

  const teamMembers = [
    { email: 'manager@clenaris.ch', firstName: 'Marco', lastName: 'Zbinden', role: 'MANAGER' as const, position: 'Betriebsleiter', hourlyRate: 48, color: '#5F3DC4', skills: ['Disposition', 'Qualitätskontrolle', 'Baureinigung'] },
    { email: 'anna.keller@clenaris.ch', firstName: 'Anna', lastName: 'Keller', role: 'EMPLOYEE' as const, position: 'Teamleiterin Reinigung', hourlyRate: 34, color: '#0B7285', skills: ['Umzugsreinigung', 'Fensterreinigung', 'Teamführung'] },
    { email: 'luis.moreira@clenaris.ch', firstName: 'Luis', lastName: 'Moreira', role: 'EMPLOYEE' as const, position: 'Reinigungsfachmann', hourlyRate: 31, color: '#E8590C', skills: ['Baureinigung', 'Hochdruckreiniger', 'Stapler'] },
    { email: 'elena.rossi@clenaris.ch', firstName: 'Elena', lastName: 'Rossi', role: 'EMPLOYEE' as const, position: 'Reinigungsfachfrau', hourlyRate: 30, color: '#2B8A3E', skills: ['Unterhaltsreinigung', 'Büroreinigung'] },
    { email: 'tomas.novak@clenaris.ch', firstName: 'Tomas', lastName: 'Novák', role: 'EMPLOYEE' as const, position: 'Reinigungsfachmann', hourlyRate: 30, color: '#1971C2', skills: ['Fensterreinigung', 'Hauswartung', 'Winterdienst'] },
    { email: 'fatima.haddad@clenaris.ch', firstName: 'Fatima', lastName: 'Haddad', role: 'EMPLOYEE' as const, position: 'Reinigungsfachfrau', hourlyRate: 29, color: '#C2255C', skills: ['Unterhaltsreinigung', 'Desinfektion'] },
  ];

  const employeeIds: Record<string, string> = {};
  let employeeCounter = 1;

  for (const member of teamMembers) {
    const user = await prisma.user.upsert({
      where: { email: member.email },
      update: { passwordHash: demoPassword, role: member.role, status: 'ACTIVE' },
      create: {
        organizationId: org.id,
        email: member.email,
        passwordHash: demoPassword,
        firstName: member.firstName,
        lastName: member.lastName,
        role: member.role,
        status: 'ACTIVE',
        emailVerified: new Date(),
        phone: `+4179${String(1000000 + employeeCounter * 137).slice(0, 7)}`,
      },
    });

    const employeeNumber = `MA-${year}-${String(employeeCounter).padStart(5, '0')}`;
    const employee = await prisma.employee.upsert({
      where: { userId: user.id },
      update: { position: member.position, hourlyRate: member.hourlyRate, color: member.color },
      create: {
        organizationId: org.id,
        userId: user.id,
        employeeNumber,
        employmentType: member.role === 'MANAGER' ? 'FULL_TIME' : 'FULL_TIME',
        position: member.position,
        department: member.role === 'MANAGER' ? 'Administration' : 'Reinigung',
        hiredAt: new Date(`${year - Math.min(4, employeeCounter)}-03-01`),
        hourlyRate: member.hourlyRate,
        workloadPct: 100,
        vacationDaysPerYear: 25,
        driverLicense: employeeCounter <= 4,
        languages: ['DE'],
        color: member.color,
        active: true,
      },
    });

    employeeIds[member.email] = employee.id;

    // Standardverfügbarkeit und Qualifikationen.
    for (const weekday of [1, 2, 3, 4, 5]) {
      await prisma.availability.upsert({
        where: {
          employeeId_weekday_startTime: {
            employeeId: employee.id,
            weekday,
            startTime: '07:00',
          },
        },
        update: {},
        create: { employeeId: employee.id, weekday, startTime: '07:00', endTime: '17:00' },
      });
    }

    for (const skill of member.skills) {
      await prisma.employeeSkill.upsert({
        where: { employeeId_name: { employeeId: employee.id, name: skill } },
        update: {},
        create: { employeeId: employee.id, name: skill, level: 4 },
      });
    }

    employeeCounter++;
  }

  // Auch die Administratorin erhält ein Mitarbeitendenprofil.
  await prisma.employee.upsert({
    where: { userId: admin.id },
    update: {},
    create: {
      organizationId: org.id,
      userId: admin.id,
      employeeNumber: `MA-${year}-00000`,
      employmentType: 'FULL_TIME',
      position: 'Geschäftsführerin',
      department: 'Geschäftsleitung',
      hiredAt: new Date(`${year - 6}-01-01`),
      monthlySalary: 9500,
      workloadPct: 100,
      vacationDaysPerYear: 25,
      driverLicense: true,
      color: '#0F172A',
    },
  });

  console.log(`✓ ${teamMembers.length + 1} Benutzerkonten und Mitarbeitendenprofile`);

  // =========================================================================
  //  10) Nummernkreise vorbereiten
  // =========================================================================
  for (const scope of ['customer', 'booking', 'job', 'invoice', 'quote', 'lead', 'employee']) {
    // Ohne Geschäftsdaten beginnt jeder Zähler bei null; nur die
    // Personalnummern sind schon vergeben. Der Demo-Seed hebt die übrigen
    // nach, wenn er Buchungen und Rechnungen anlegt.
    const current = scope === 'employee' ? teamMembers.length : 0;
    await prisma.numberSequence.upsert({
      where: { organizationId_scope_year: { organizationId: org.id, scope, year } },
      update: {},
      create: { organizationId: org.id, scope, year, current },
    });
  }

  // =========================================================================
  //  12) Ausgaben & Lieferanten
  // =========================================================================
  const supplier = await prisma.supplier.upsert({
    where: { id: 'seed-supplier-hygiene' },
    update: {},
    create: {
      id: 'seed-supplier-hygiene',
      organizationId: org.id,
      name: 'Hygiene Center Bern AG',
      contactName: 'Rolf Aebi',
      email: 'bestellung@hygienecenter.example.ch',
      phone: '+41319998877',
      street: 'Industriestrasse 4',
      postalCode: '3052',
      city: 'Zollikofen',
      vatNumber: 'CHE-456.789.123 MWST',
      paymentTermDays: 30,
    },
  });
  console.log('✓ 1 Lieferant');

  // =========================================================================
  //  13) Website-Inhalte
  // =========================================================================
  const faqs = [
    { category: 'Buchung', question: 'Wie schnell erhalte ich einen Termin?', answer: 'In der Regel innerhalb von 3 bis 5 Arbeitstagen. Für dringende Fälle bieten wir einen Express-Termin innert 48 Stunden gegen einen Zuschlag von CHF 60 an.' },
    { category: 'Buchung', question: 'Kann ich meinen Termin kostenlos verschieben?', answer: 'Ja. Bis 24 Stunden vor dem Termin können Sie über Ihr Kundenkonto kostenlos umbuchen oder stornieren. Danach verrechnen wir 50 % des vereinbarten Betrags.' },
    { category: 'Preise', question: 'Sind die angezeigten Preise verbindlich?', answer: 'Der online berechnete Preis ist verbindlich, solange die Angaben zum Objekt stimmen. Weicht die tatsächliche Situation stark ab, melden wir uns vor Arbeitsbeginn bei Ihnen.' },
    { category: 'Preise', question: 'Ist die Mehrwertsteuer inbegriffen?', answer: 'Alle Preise auf der Website verstehen wir exklusive Mehrwertsteuer; im Buchungsprozess und auf der Rechnung weisen wir die MWST von 8.1 % separat aus.' },
    { category: 'Preise', question: 'Wie kann ich bezahlen?', answer: 'Sie erhalten eine QR-Rechnung mit 30 Tagen Zahlungsfrist. Alternativ können Sie online per Kreditkarte oder TWINT bezahlen.' },
    { category: 'Leistungen', question: 'Bringen Sie Reinigungsmittel und Material mit?', answer: 'Ja, sämtliches Material und alle Reinigungsmittel sind im Preis inbegriffen. Wir arbeiten mit umweltschonenden Produkten mit Schweizer Öko-Zertifizierung.' },
    { category: 'Leistungen', question: 'Was bedeutet Abgabegarantie bei der Umzugsreinigung?', answer: 'Sollte die Verwaltung bei der Wohnungsübergabe etwas beanstanden, kommen wir innerhalb von 48 Stunden kostenlos zurück und beheben die Mängel.' },
    { category: 'Sicherheit', question: 'Sind Sie versichert?', answer: 'Ja. Wir verfügen über eine Betriebshaftpflichtversicherung mit einer Deckungssumme von CHF 5 Millionen. Sämtliche Mitarbeitenden sind bei uns fest angestellt und unfallversichert.' },
    { category: 'Sicherheit', question: 'Wie gehen Sie mit meinen Schlüsseln um?', answer: 'Schlüssel werden anonymisiert in einem gesicherten Schlüsseldepot aufbewahrt und in einem Übergabeprotokoll dokumentiert. Der Zugriff ist auf das zuständige Team beschränkt.' },
    { category: 'Sicherheit', question: 'Muss ich während der Reinigung zu Hause sein?', answer: 'Nein. Viele Kundinnen und Kunden hinterlegen einen Schlüssel bei uns. Nach jedem Einsatz erhalten Sie einen Bericht mit Vorher-/Nachher-Fotos.' },
  ];

  for (const [index, faq] of faqs.entries()) {
    const existing = await prisma.faq.findFirst({
      where: { organizationId: org.id, question: faq.question, locale: 'DE' },
    });
    if (existing) continue;
    await prisma.faq.create({
      data: { organizationId: org.id, locale: 'DE', position: index, ...faq },
    });
  }

  const jobPostings = [
    {
      slug: 'reinigungsfachkraft-80-100',
      title: 'Reinigungsfachkraft 80–100 %',
      description:
        'Wir suchen eine zuverlässige Person für Unterhalts- und Umzugsreinigungen im Raum Bern. Du arbeitest selbstständig in einem festen Team und hast direkten Kundenkontakt.',
      requirements: [
        'Erfahrung in der Gebäudereinigung von Vorteil',
        'Gute Deutschkenntnisse (mind. B1)',
        'Zuverlässig, pünktlich und sorgfältig',
        'Führerausweis Kategorie B von Vorteil',
        'Schweizer Bürgerrecht oder gültige Arbeitsbewilligung',
      ],
      benefits: [
        'Fester Anstellungsvertrag nach GAV',
        '5 Wochen Ferien ab dem ersten Jahr',
        'Bezahlte Weiterbildungen',
        'Moderne Arbeitsgeräte und Firmenfahrzeug',
        'Kein Wochenenddienst ausser nach Absprache',
      ],
      salaryFrom: 4400,
      salaryTo: 5200,
      workloadFrom: 80,
      workloadTo: 100,
    },
    {
      slug: 'teamleiter-objektbetreuung',
      title: 'Teamleiter/in Objektbetreuung 100 %',
      description:
        'Du führst ein Team von vier bis sechs Personen, planst Einsätze und bist Ansprechperson für unsere Geschäftskunden. Eine Rolle mit viel Gestaltungsspielraum.',
      requirements: [
        'Abgeschlossene Ausbildung als Gebäudereiniger/in EFZ oder gleichwertige Erfahrung',
        'Erste Führungserfahrung',
        'Sehr gute Deutschkenntnisse, Französisch von Vorteil',
        'Führerausweis Kategorie B',
        'Sicherer Umgang mit digitalen Werkzeugen',
      ],
      benefits: [
        'Überdurchschnittliche Entlöhnung',
        'Firmenfahrzeug auch zur privaten Nutzung',
        'Beteiligung am Betriebsergebnis',
        'Weiterbildung zum eidg. Fachausweis unterstützt',
      ],
      salaryFrom: 5800,
      salaryTo: 6800,
      workloadFrom: 100,
      workloadTo: 100,
    },
  ];

  for (const posting of jobPostings) {
    await prisma.jobPosting.upsert({
      where: { organizationId_slug: { organizationId: org.id, slug: posting.slug } },
      update: { title: posting.title, description: posting.description },
      create: {
        organizationId: org.id,
        ...posting,
        location: 'Bern',
        employmentType: 'FULL_TIME',
        status: 'PUBLISHED',
        publishedAt: new Date(),
      },
    });
  }
  console.log(`✓ Website-Inhalte: ${faqs.length} FAQ, ${jobPostings.length} Stellen`);

  // =========================================================================
  //  14) Gutscheine & Automationen
  // =========================================================================
  const coupons = [
    { code: 'WILLKOMMEN20', description: '20 % auf die erste Buchung', discountType: 'PERCENT' as const, discountValue: 20, maxDiscount: 100, firstOrderOnly: true },
    { code: 'FRUEHLING50', description: 'CHF 50 Rabatt ab CHF 400 Auftragswert', discountType: 'FIXED' as const, discountValue: 50, minOrderValue: 400 },
    { code: 'EMPFEHLUNG25', description: 'CHF 25 für Empfehlungen', discountType: 'FIXED' as const, discountValue: 25, minOrderValue: 150 },
  ];

  for (const coupon of coupons) {
    await prisma.coupon.upsert({
      where: { organizationId_code: { organizationId: org.id, code: coupon.code } },
      update: { description: coupon.description },
      create: {
        organizationId: org.id,
        code: coupon.code,
        description: coupon.description,
        discountType: coupon.discountType,
        discountValue: coupon.discountValue,
        minOrderValue: coupon.minOrderValue ?? 0,
        maxDiscount: coupon.maxDiscount ?? null,
        firstOrderOnly: coupon.firstOrderOnly ?? false,
        status: 'ACTIVE',
        validFrom: new Date(`${year}-01-01`),
        validUntil: new Date(`${year}-12-31`),
        usageLimit: 500,
        perCustomerLimit: 1,
      },
    });
  }

  const automations = [
    { name: 'Terminerinnerung 24 Stunden vorher', trigger: 'BOOKING_REMINDER_24H' as const, delayMinutes: 0, actions: [{ type: 'SEND_EMAIL' as const, config: { templateKey: 'booking_reminder' } }, { type: 'SEND_SMS' as const, config: { templateKey: 'booking_reminder' } }] },
    { name: 'Bewertungsanfrage nach dem Einsatz', trigger: 'BOOKING_COMPLETED' as const, delayMinutes: 1440, actions: [{ type: 'SEND_EMAIL' as const, config: { templateKey: 'review_request' } }] },
    { name: 'Zahlungserinnerung bei Fälligkeit', trigger: 'INVOICE_DUE_SOON' as const, delayMinutes: 0, actions: [{ type: 'SEND_EMAIL' as const, config: { templateKey: 'invoice_due_soon' } }] },
    { name: 'Geburtstagsgruss mit Gutschein', trigger: 'CUSTOMER_BIRTHDAY' as const, delayMinutes: 0, actions: [{ type: 'SEND_EMAIL' as const, config: { templateKey: 'birthday', couponCode: 'WILLKOMMEN20' } }] },
    { name: 'Nachfassen bei stillen Leads', trigger: 'LEAD_IDLE' as const, delayMinutes: 4320, actions: [{ type: 'CREATE_TASK' as const, config: { title: 'Lead nachfassen', priority: 'HIGH' } }] },
  ];

  for (const automation of automations) {
    const existing = await prisma.automation.findFirst({
      where: { organizationId: org.id, name: automation.name },
    });
    if (existing) continue;

    await prisma.automation.create({
      data: {
        organizationId: org.id,
        name: automation.name,
        trigger: automation.trigger,
        delayMinutes: automation.delayMinutes,
        active: true,
        actions: {
          create: automation.actions.map((action, index) => ({
            type: action.type,
            config: action.config as Prisma.InputJsonValue,
            position: index,
          })),
        },
      },
    });
  }
  console.log(`✓ ${coupons.length} Gutscheine, ${automations.length} Automationen`);

  // =========================================================================
  //  Handlungsaufrufe
  // =========================================================================
  //
  // Die Auslieferungsfassung. Sie ersetzt genau die Schaltflächen, die vorher
  // im Quelltext standen — damit die Website nach dem Umbau nicht nackt
  // dasteht. Ab hier sind sie in der Verwaltung änderbar.
  //
  // `upsert` auf dem Kurznamen: der Seed darf mehrfach laufen, ohne Dubletten
  // anzulegen, und darf eine bereits angepasste Schaltfläche nicht
  // zurücksetzen — deshalb wird beim Treffer nichts überschrieben.
  const callsToAction = [
    {
      key: 'termin-buchen',
      label: 'Termin buchen',
      note: 'Hauptschaltfläche der Kopfzeile.',
      href: '/buchen',
      icon: 'CalendarCheck',
      slot: 'HEADER' as const,
      style: 'PRIMARY' as const,
      pages: [] as string[],
      position: 0,
    },
    {
      key: 'offerte-anfordern',
      label: 'Offerte anfordern',
      note: 'Zweiter Weg für alle, die zuerst einen Preis wollen.',
      href: '/offerte',
      icon: 'FileText',
      slot: 'HERO_PRIMARY' as const,
      style: 'PRIMARY' as const,
      pages: ['/leistungen/*'],
      position: 0,
    },
    {
      key: 'preise-ansehen',
      label: 'Preise ansehen',
      note: 'Die ruhigere Alternative neben der Hauptschaltfläche.',
      href: '/preise',
      icon: 'Calculator',
      slot: 'HERO_SECONDARY' as const,
      style: 'OUTLINE' as const,
      pages: ['/leistungen/*'],
      position: 0,
    },
    {
      key: 'jetzt-anrufen',
      label: 'Jetzt anrufen',
      note: 'Direktwahl — der kürzeste Weg zum Abschluss.',
      href: `tel:${(org.phone ?? '+41311234567').replace(/\s/g, '')}`,
      icon: 'Phone',
      slot: 'FOOTER' as const,
      style: 'OUTLINE' as const,
      pages: [] as string[],
      position: 0,
    },
    {
      key: 'kostenlose-offerte',
      label: 'Kostenlose Offerte anfordern',
      note: 'Abschlussband am Ende der Seiten.',
      href: '/offerte',
      icon: 'ArrowRight',
      slot: 'SECTION_BANNER' as const,
      style: 'PRIMARY' as const,
      pages: [] as string[],
      position: 0,
    },
  ];

  for (const cta of callsToAction) {
    await prisma.callToAction.upsert({
      where: { organizationId_key: { organizationId: org.id, key: cta.key } },
      update: {},
      create: {
        organizationId: org.id,
        key: cta.key,
        label: cta.label,
        note: cta.note,
        href: cta.href,
        icon: cta.icon,
        slot: cta.slot,
        style: cta.style,
        pages: cta.pages,
        position: cta.position,
        active: true,
      },
    });
  }
  console.log(`✓ ${callsToAction.length} Handlungsaufrufe`);

  // =========================================================================
  //  Navigation
  // =========================================================================
  //
  // Die Auslieferungsfassung des Menüs. Sie bildet nach, was vorher im
  // Quelltext stand — ab hier ist es in der Verwaltung änderbar.
  //
  // Die Leistungen stehen bewusst *nicht* darin: sie kommen aus dem Katalog
  // und würden hier zu einer zweiten, veraltenden Liste.
  const navHeader = [
    { label: 'Leistungen', href: '/leistungen' },
    { label: 'Preise', href: '/preise' },
    { label: 'Einsatzgebiet', href: '/einsatzgebiet' },
    { label: 'Einblick', href: '/ueber-uns' },
    { label: 'Kontakt', href: '/kontakt' },
  ];

  const navPanel: Record<string, { label: string; href: string; description: string; icon: string }[]> =
    {
      Einblick: [
        { label: 'Über uns', href: '/ueber-uns', description: 'Wer wir sind und wie wir arbeiten', icon: 'Users' },
        { label: 'Vorher / Nachher', href: '/galerie', description: 'Ergebnisse aus echten Aufträgen', icon: 'Sparkles' },
        { label: 'Bewertungen', href: '/bewertungen', description: 'Was die Kundschaft sagt', icon: 'Star' },
        { label: 'Ratgeber', href: '/blog', description: 'Reinigungstipps aus der Praxis', icon: 'FileText' },
        { label: 'Häufige Fragen', href: '/faq', description: 'Antworten auf das, was oft gefragt wird', icon: 'MessageCircle' },
        { label: 'Offene Stellen', href: '/karriere', description: 'Arbeiten bei Clenaris', icon: 'Building2' },
      ],
    };

  const navFooter: { location: 'FOOTER_COMPANY' | 'FOOTER_LEGAL'; items: { label: string; href: string }[] }[] = [
    {
      location: 'FOOTER_COMPANY',
      items: [
        { label: 'Über uns', href: '/ueber-uns' },
        { label: 'Vorher / Nachher', href: '/galerie' },
        { label: 'Bewertungen', href: '/bewertungen' },
        { label: 'Offene Stellen', href: '/karriere' },
        { label: 'Ratgeber', href: '/blog' },
        { label: 'Häufige Fragen', href: '/faq' },
        { label: 'Kontakt', href: '/kontakt' },
      ],
    },
    {
      location: 'FOOTER_LEGAL',
      items: [
        { label: 'Impressum', href: '/legal/impressum' },
        { label: 'Datenschutz', href: '/legal/datenschutz' },
        { label: 'AGB', href: '/legal/agb' },
        { label: 'Cookies', href: '/legal/cookies' },
      ],
    },
  ];

  let navCount = 0;
  if ((await prisma.navigationItem.count({ where: { organizationId: org.id } })) === 0) {
    for (const [index, entry] of navHeader.entries()) {
      const parent = await prisma.navigationItem.create({
        data: {
          organizationId: org.id,
          location: 'HEADER',
          label: entry.label,
          href: entry.href,
          position: index,
        },
      });
      navCount++;

      for (const [childIndex, child] of (navPanel[entry.label] ?? []).entries()) {
        await prisma.navigationItem.create({
          data: {
            organizationId: org.id,
            location: 'HEADER_PANEL',
            parentId: parent.id,
            label: child.label,
            href: child.href,
            description: child.description,
            icon: child.icon,
            position: childIndex,
          },
        });
        navCount++;
      }
    }

    for (const group of navFooter) {
      for (const [index, item] of group.items.entries()) {
        await prisma.navigationItem.create({
          data: {
            organizationId: org.id,
            location: group.location,
            label: item.label,
            href: item.href,
            position: index,
          },
        });
        navCount++;
      }
    }
  }
  console.log(`✓ ${navCount} Menüpunkte`);

  // =========================================================================
  //  15) Kennzahlen der Unternehmensführung
  // =========================================================================
  /**
   * Konfiguration, kein Demodatensatz — deshalb hier und nicht in
   * `seed-demo.ts`. Die Zielwerte bleiben leer: sie sind betriebliche
   * Entscheidungen, und erfundene Vorgaben („Ziel: 30 % Marge") sähen in der
   * Oberfläche aus wie eine Absprache, die es nie gab. Das Cockpit fordert
   * einmal auf, Ziele zu setzen.
   *
   * Die Gewichte sind ein Vorschlag für den Gesundheitswert und lassen sich in
   * der Oberfläche ändern. `update` schreibt nur Beschriftung und Gruppe —
   * Gewicht, Ziel und Aktivität gehören dem Betrieb, sobald er sie angefasst
   * hat.
   */
  const kpiDefinitions: {
    key: string;
    label: string;
    description: string;
    group: string;
    unit: 'CURRENCY' | 'PERCENT' | 'COUNT' | 'DAYS' | 'HOURS' | 'RATIO';
    direction: 'UP_IS_GOOD' | 'DOWN_IS_GOOD';
    periods: ('MONTH' | 'QUARTER' | 'YEAR')[];
    healthWeight: number;
  }[] = [
    { key: 'revenue.net', label: 'Umsatz netto', description: 'Ausgestellte Rechnungen nach Ausstellungsdatum, abzüglich Gutschriften.', group: 'Finanzen', unit: 'CURRENCY', direction: 'UP_IS_GOOD', periods: ['MONTH', 'QUARTER', 'YEAR'], healthWeight: 0 },
    { key: 'revenue.growthYoY', label: 'Umsatzwachstum zum Vorjahr', description: 'Veränderung gegenüber derselben Periode des Vorjahres.', group: 'Finanzen', unit: 'PERCENT', direction: 'UP_IS_GOOD', periods: ['MONTH', 'QUARTER'], healthWeight: 8 },
    { key: 'revenue.recurringShare', label: 'Anteil wiederkehrender Umsatz', description: 'Umsatz aus Abonnements und Serien im Verhältnis zum Gesamtumsatz.', group: 'Finanzen', unit: 'PERCENT', direction: 'UP_IS_GOOD', periods: ['MONTH'], healthWeight: 7 },
    { key: 'margin.gross', label: 'Bruttomarge', description: 'Erlös abzüglich Lohn- und Materialkosten über abgeschlossene Einsätze mit Nachkalkulation.', group: 'Finanzen', unit: 'PERCENT', direction: 'UP_IS_GOOD', periods: ['MONTH', 'QUARTER'], healthWeight: 12 },
    { key: 'profit.operating', label: 'Betriebsergebnis', description: 'Umsatz netto abzüglich aller erfassten Ausgaben.', group: 'Finanzen', unit: 'CURRENCY', direction: 'UP_IS_GOOD', periods: ['MONTH', 'QUARTER', 'YEAR'], healthWeight: 8 },
    { key: 'invoice.outstanding', label: 'Offene Forderungen', description: 'Ausstehende Beträge versendeter, teilbezahlter und überfälliger Rechnungen.', group: 'Finanzen', unit: 'CURRENCY', direction: 'DOWN_IS_GOOD', periods: ['MONTH'], healthWeight: 0 },
    { key: 'invoice.overdue', label: 'Überfällige Forderungen', description: 'Ausstehende Beträge überfälliger Rechnungen zum Periodenende.', group: 'Finanzen', unit: 'CURRENCY', direction: 'DOWN_IS_GOOD', periods: ['MONTH'], healthWeight: 10 },
    { key: 'invoice.dso', label: 'Tage bis Zahlungseingang', description: 'Durchschnitt von Ausstellung bis Zahlung über die in der Periode bezahlten Rechnungen.', group: 'Finanzen', unit: 'DAYS', direction: 'DOWN_IS_GOOD', periods: ['MONTH'], healthWeight: 10 },
    { key: 'quote.conversion', label: 'Annahmequote Offerten', description: 'Anteil der in der Periode gesendeten Offerten, die angenommen wurden — reift einige Wochen nach.', group: 'Vertrieb', unit: 'PERCENT', direction: 'UP_IS_GOOD', periods: ['MONTH', 'QUARTER'], healthWeight: 8 },
    { key: 'lead.new', label: 'Neue Anfragen', description: 'Leads mit Erfassung in der Periode.', group: 'Vertrieb', unit: 'COUNT', direction: 'UP_IS_GOOD', periods: ['MONTH'], healthWeight: 0 },
    { key: 'lead.costPerLead', label: 'Kosten je Anfrage', description: 'Marketingausgaben der Periode geteilt durch neue Anfragen.', group: 'Marketing', unit: 'CURRENCY', direction: 'DOWN_IS_GOOD', periods: ['MONTH'], healthWeight: 0 },
    { key: 'booking.completed', label: 'Abgeschlossene Buchungen', description: 'Buchungen mit Abschluss in der Periode.', group: 'Auftragslage', unit: 'COUNT', direction: 'UP_IS_GOOD', periods: ['MONTH'], healthWeight: 0 },
    { key: 'booking.cancellationRate', label: 'Stornoquote', description: 'Stornierte und nicht erschienene Buchungen im Verhältnis zu allen abgeschlossenen und stornierten.', group: 'Auftragslage', unit: 'PERCENT', direction: 'DOWN_IS_GOOD', periods: ['MONTH'], healthWeight: 7 },
    { key: 'job.backlog', label: 'Auftragsbestand', description: 'Geplante Einsätze nach dem Periodenende, die noch nicht abgeschlossen sind.', group: 'Auftragslage', unit: 'COUNT', direction: 'UP_IS_GOOD', periods: ['MONTH'], healthWeight: 0 },
    { key: 'customer.active', label: 'Aktive Kundschaft', description: 'Kundschaft mit mindestens einer abgeschlossenen Buchung in den letzten zwölf Monaten.', group: 'Kundschaft', unit: 'COUNT', direction: 'UP_IS_GOOD', periods: ['MONTH'], healthWeight: 0 },
    { key: 'customer.growth', label: 'Wachstum aktive Kundschaft', description: 'Veränderung der aktiven Kundschaft zum Vorjahr.', group: 'Kundschaft', unit: 'PERCENT', direction: 'UP_IS_GOOD', periods: ['QUARTER'], healthWeight: 7 },
    { key: 'customer.repeatRate', label: 'Wiederkehrquote', description: 'Anteil der aktiven Kundschaft mit zwei oder mehr abgeschlossenen Buchungen in zwölf Monaten.', group: 'Kundschaft', unit: 'PERCENT', direction: 'UP_IS_GOOD', periods: ['QUARTER'], healthWeight: 8 },
    { key: 'customer.satisfaction', label: 'Kundenzufriedenheit', description: 'Durchschnitt veröffentlichter Bewertungen, auf 0–100 umgerechnet.', group: 'Kundschaft', unit: 'PERCENT', direction: 'UP_IS_GOOD', periods: ['MONTH', 'QUARTER'], healthWeight: 7 },
    { key: 'employee.utilization', label: 'Auslastung', description: 'Genehmigte Einsatzminuten im Verhältnis zu den Sollminuten aller aktiven Mitarbeitenden.', group: 'Personal', unit: 'PERCENT', direction: 'UP_IS_GOOD', periods: ['MONTH'], healthWeight: 8 },
    { key: 'employee.headcountFte', label: 'Vollzeitäquivalente', description: 'Summe der Pensen aktiver Mitarbeitender.', group: 'Personal', unit: 'RATIO', direction: 'UP_IS_GOOD', periods: ['MONTH'], healthWeight: 0 },
  ];
  for (const [index, definition] of kpiDefinitions.entries()) {
    await prisma.kpiDefinition.upsert({
      where: { organizationId_key: { organizationId: org.id, key: definition.key } },
      update: { label: definition.label, description: definition.description, group: definition.group },
      create: {
        organizationId: org.id,
        key: definition.key,
        label: definition.label,
        description: definition.description,
        group: definition.group,
        unit: definition.unit,
        direction: definition.direction,
        source: 'DERIVED',
        periods: definition.periods,
        healthWeight: definition.healthWeight,
        sortOrder: index,
      },
    });
  }
  console.log(`✓ ${kpiDefinitions.length} Kennzahlen (Zielwerte bleiben leer — betriebliche Entscheidung)`);

  // =========================================================================
  //  Abschluss
  // =========================================================================
  console.log('\n✅  Seed abgeschlossen.\n');
  console.log('   Zugangsdaten:');
  console.log(`   Admin      ${process.env.SEED_ADMIN_EMAIL ?? 'admin@clenaris.ch'} / ${process.env.SEED_ADMIN_PASSWORD ?? 'Admin#2026Clenaris'}`);
  console.log('   Manager    manager@clenaris.ch / Demo#2026Clenaris');
  console.log('   Mitarbeit. anna.keller@clenaris.ch / Demo#2026Clenaris\n');
  console.log('   Ohne Geschäftsdaten. Für Kundschaft, Buchungen und Rechnungen:');
  console.log('   npm run db:seed:demo\n');
}

main()
  .catch((error) => {
    console.error('❌  Seed fehlgeschlagen:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
