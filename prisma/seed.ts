/**
 * Datenbank-Seed.
 *
 * Erzeugt einen vollständig arbeitsfähigen Mandanten: Firma, Leistungskatalog
 * mit Preisregeln, Einsatzgebiet (PLZ des Kantons Bern), Öffnungszeiten,
 * Feiertage, Team, Kundschaft, Buchungen, Einsätze, Rechnungen sowie die
 * Website-Inhalte (Blog, FAQ, Bewertungen, Galerie, Stellen).
 *
 * Der Seed ist idempotent: mehrfaches Ausführen aktualisiert bestehende
 * Datensätze, statt Duplikate zu erzeugen.
 *
 *   npm run db:seed
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
  //  9) Kundschaft
  // =========================================================================
  const customersData = [
    {
      type: 'PRIVATE' as const,
      firstName: 'Nicole',
      lastName: 'Wyss',
      email: 'nicole.wyss@example.ch',
      phone: '+41791234567',
      address: { street: 'Länggassstrasse', streetNo: '42', postalCode: '3012', city: 'Bern' },
      createLogin: true,
      tags: ['Stammkunde', 'Abo-Vertrag'],
      property: { label: 'Wohnung Länggasse', kind: 'APARTMENT' as const, squareMeters: 88, rooms: 3.5, bathrooms: 1, windows: 9 },
    },
    {
      type: 'BUSINESS' as const,
      companyName: 'Aareblick Immobilien AG',
      firstName: 'Peter',
      lastName: 'Roth',
      email: 'p.roth@aareblick.example.ch',
      phone: '+41313334455',
      vatNumber: 'CHE-234.567.891 MWST',
      address: { street: 'Effingerstrasse', streetNo: '18', postalCode: '3008', city: 'Bern' },
      tags: ['Grosskunde', 'Liegenschaftsverwaltung'],
      discountPercent: 8,
      property: { label: 'Bürogeschoss 3. OG', kind: 'OFFICE' as const, squareMeters: 420, rooms: 14, bathrooms: 4, windows: 38 },
    },
    {
      type: 'PRIVATE' as const,
      firstName: 'Martin',
      lastName: 'Schneider',
      email: 'martin.schneider@example.ch',
      phone: '+41786543210',
      address: { street: 'Dorfstrasse', streetNo: '7', postalCode: '3072', city: 'Ostermundigen' },
      tags: ['Empfehlung'],
      property: { label: 'Reihenhaus', kind: 'HOUSE' as const, squareMeters: 145, rooms: 5.5, bathrooms: 2, windows: 18 },
    },
    {
      type: 'BUSINESS' as const,
      companyName: 'Praxis Dr. med. Lehmann',
      firstName: 'Katrin',
      lastName: 'Lehmann',
      email: 'praxis@lehmann.example.ch',
      phone: '+41312223344',
      vatNumber: 'CHE-345.678.912 MWST',
      address: { street: 'Monbijoustrasse', streetNo: '110', postalCode: '3007', city: 'Bern' },
      tags: ['Stammkunde'],
      property: { label: 'Arztpraxis', kind: 'PRACTICE' as const, squareMeters: 180, rooms: 8, bathrooms: 2, windows: 14 },
    },
    {
      type: 'PRIVATE' as const,
      firstName: 'Sofia',
      lastName: 'Bernasconi',
      email: 'sofia.b@example.ch',
      phone: '+41765554433',
      address: { street: 'Weissensteinstrasse', streetNo: '23', postalCode: '3007', city: 'Bern' },
      property: { label: 'Wohnung Mattenhof', kind: 'APARTMENT' as const, squareMeters: 64, rooms: 2.5, bathrooms: 1, windows: 6 },
    },
  ];

  const customerIds: Record<string, string> = {};
  let customerCounter = 1;

  for (const data of customersData) {
    const number = `K-${year}-${String(customerCounter).padStart(5, '0')}`;

    let userId: string | null = null;
    if (data.createLogin) {
      const customerUser = await prisma.user.upsert({
        where: { email: data.email },
        update: { passwordHash: demoPassword },
        create: {
          organizationId: org.id,
          email: data.email,
          passwordHash: demoPassword,
          firstName: data.firstName,
          lastName: data.lastName,
          phone: data.phone,
          role: 'CUSTOMER',
          status: 'ACTIVE',
          emailVerified: new Date(),
        },
      });
      userId = customerUser.id;
    }

    const customer = await prisma.customer.upsert({
      where: { organizationId_number: { organizationId: org.id, number } },
      update: { email: data.email, phone: data.phone },
      create: {
        organizationId: org.id,
        number,
        userId,
        type: data.type,
        companyName: data.companyName ?? null,
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
        phone: data.phone,
        vatNumber: data.vatNumber ?? null,
        discountPercent: data.discountPercent ?? 0,
        referralCode: randomCode(6),
        language: 'DE',
      },
    });

    customerIds[data.email] = customer.id;

    const address = await prisma.address.findFirst({ where: { customerId: customer.id } });
    const addressRecord =
      address ??
      (await prisma.address.create({
        data: {
          customerId: customer.id,
          label: 'Hauptadresse',
          street: data.address.street,
          streetNo: data.address.streetNo,
          postalCode: data.address.postalCode,
          city: data.address.city,
          canton: 'BE',
          country: 'CH',
          isDefault: true,
          isBilling: true,
        },
      }));

    const existingProperty = await prisma.property.findFirst({ where: { customerId: customer.id } });
    if (!existingProperty) {
      await prisma.property.create({
        data: {
          customerId: customer.id,
          addressId: addressRecord.id,
          label: data.property.label,
          kind: data.property.kind,
          squareMeters: data.property.squareMeters,
          rooms: data.property.rooms,
          bathrooms: data.property.bathrooms,
          windows: data.property.windows,
        },
      });
    }

    for (const tagName of data.tags ?? []) {
      const tag = await prisma.tag.findUnique({
        where: { organizationId_name: { organizationId: org.id, name: tagName } },
      });
      if (tag) {
        await prisma.customerTag.upsert({
          where: { customerId_tagId: { customerId: customer.id, tagId: tag.id } },
          update: {},
          create: { customerId: customer.id, tagId: tag.id },
        });
      }
    }

    customerCounter++;
  }
  console.log(`✓ ${customersData.length} Kundendatensätze inkl. Adressen und Objekten`);

  // =========================================================================
  //  10) Nummernkreise vorbereiten
  // =========================================================================
  for (const scope of ['customer', 'booking', 'job', 'invoice', 'quote', 'lead', 'employee']) {
    const current =
      scope === 'customer'
        ? customersData.length
        : scope === 'employee'
          ? teamMembers.length
          : 0;
    await prisma.numberSequence.upsert({
      where: { organizationId_scope_year: { organizationId: org.id, scope, year } },
      update: {},
      create: { organizationId: org.id, scope, year, current },
    });
  }

  // =========================================================================
  //  11) Buchungen, Einsätze und Rechnungen
  // =========================================================================
  const bookingSeeds = [
    {
      customerEmail: 'nicole.wyss@example.ch',
      serviceSlug: 'unterhaltsreinigung',
      status: 'CONFIRMED' as const,
      startInDays: 3,
      hour: 9,
      durationMin: 150,
      crewSize: 1,
      frequency: 'BIWEEKLY' as const,
      net: 132.6,
      employee: 'elena.rossi@clenaris.ch',
    },
    {
      customerEmail: 'p.roth@aareblick.example.ch',
      serviceSlug: 'bueroreinigung',
      status: 'CONFIRMED' as const,
      startInDays: 1,
      hour: 18,
      durationMin: 240,
      crewSize: 2,
      frequency: 'WEEKLY' as const,
      net: 415.8,
      employee: 'anna.keller@clenaris.ch',
    },
    {
      customerEmail: 'martin.schneider@example.ch',
      serviceSlug: 'umzugsreinigung',
      status: 'PENDING' as const,
      startInDays: 12,
      hour: 8,
      durationMin: 480,
      crewSize: 3,
      frequency: 'ONCE' as const,
      net: 1182.5,
      employee: 'luis.moreira@clenaris.ch',
    },
    {
      customerEmail: 'praxis@lehmann.example.ch',
      serviceSlug: 'bueroreinigung',
      status: 'COMPLETED' as const,
      startInDays: -6,
      hour: 19,
      durationMin: 180,
      crewSize: 2,
      frequency: 'WEEKLY' as const,
      net: 198,
      employee: 'fatima.haddad@clenaris.ch',
    },
    {
      customerEmail: 'sofia.b@example.ch',
      serviceSlug: 'fensterreinigung',
      status: 'COMPLETED' as const,
      startInDays: -14,
      hour: 10,
      durationMin: 120,
      crewSize: 1,
      frequency: 'ONCE' as const,
      net: 144,
      employee: 'tomas.novak@clenaris.ch',
    },
  ];

  let bookingCounter = 1;
  let jobCounter = 1;
  let invoiceCounter = 1;

  for (const seed of bookingSeeds) {
    const customerId = customerIds[seed.customerEmail];
    const serviceId = serviceIds[seed.serviceSlug];
    const address = await prisma.address.findFirst({ where: { customerId } });
    const property = await prisma.property.findFirst({ where: { customerId } });

    const start = daysFromNow(seed.startInDays, seed.hour);
    const end = new Date(start.getTime() + seed.durationMin * 60_000);
    const vat = Math.round(seed.net * 0.081 * 100) / 100;
    const gross = Math.round((seed.net + vat) * 100) / 100;
    const bookingNumber = `BK-${year}-${String(bookingCounter).padStart(5, '0')}`;

    const existingBooking = await prisma.booking.findUnique({
      where: { organizationId_number: { organizationId: org.id, number: bookingNumber } },
    });

    const booking =
      existingBooking ??
      (await prisma.booking.create({
        data: {
          organizationId: org.id,
          number: bookingNumber,
          customerId,
          addressId: address?.id ?? null,
          propertyId: property?.id ?? null,
          status: seed.status,
          scheduledStart: start,
          scheduledEnd: end,
          durationMin: seed.durationMin,
          crewSize: seed.crewSize,
          frequency: seed.frequency,
          propertyKind: property?.kind ?? 'APARTMENT',
          squareMeters: property?.squareMeters ?? null,
          rooms: property?.rooms ?? null,
          windows: property?.windows ?? null,
          subtotal: seed.net,
          netTotal: seed.net,
          vatRate: 8.1,
          vatAmount: vat,
          grossTotal: gross,
          source: 'WEBSITE',
          confirmedAt: seed.status !== 'PENDING' ? new Date() : null,
          completedAt: seed.status === 'COMPLETED' ? end : null,
          confirmationToken: randomCode(24).toLowerCase(),
          items: {
            create: {
              serviceId,
              name: services.find((s) => s.slug === seed.serviceSlug)!.name,
              quantity: Math.round((seed.durationMin / 60) * 100) / 100,
              unit: 'Std.',
              unitPrice: Math.round((seed.net / (seed.durationMin / 60)) * 100) / 100,
              vatRate: 8.1,
              lineTotal: seed.net,
              durationMin: seed.durationMin,
            },
          },
        },
      }));

    bookingCounter++;

    // Einsatz
    const jobNumber = `JB-${year}-${String(jobCounter).padStart(5, '0')}`;
    const existingJob = await prisma.job.findUnique({
      where: { organizationId_number: { organizationId: org.id, number: jobNumber } },
    });

    if (!existingJob && seed.status !== 'PENDING') {
      const service = services.find((s) => s.slug === seed.serviceSlug)!;
      const checklistLabels: Record<string, string[]> = {
        unterhaltsreinigung: ['Böden saugen und feucht aufnehmen', 'Bad und WC reinigen', 'Küche reinigen', 'Staub wischen', 'Abfall entsorgen'],
        bueroreinigung: ['Arbeitsplätze abstauben', 'Böden reinigen', 'Sanitäranlagen reinigen', 'Küche reinigen', 'Abfall entsorgen'],
        umzugsreinigung: ['Küche inkl. Backofen', 'Bad entkalken', 'Fenster innen und aussen', 'Böden grundreinigen', 'Abnahmebereitschaft prüfen'],
        fensterreinigung: ['Fenster innen', 'Fenster aussen', 'Rahmen und Falze', 'Fenstersimsen', 'Streifenfreiheit prüfen'],
      };

      const job = await prisma.job.create({
        data: {
          organizationId: org.id,
          number: jobNumber,
          bookingId: booking.id,
          customerId,
          addressId: address?.id ?? null,
          propertyId: property?.id ?? null,
          serviceId,
          title: `${service.name} · ${customersData.find((c) => c.email === seed.customerEmail)?.companyName ?? customersData.find((c) => c.email === seed.customerEmail)?.lastName}`,
          status: seed.status === 'COMPLETED' ? 'COMPLETED' : 'SCHEDULED',
          scheduledStart: start,
          scheduledEnd: end,
          actualStart: seed.status === 'COMPLETED' ? start : null,
          actualEnd: seed.status === 'COMPLETED' ? end : null,
          crewSize: seed.crewSize,
          estimatedMin: seed.durationMin,
          revenue: seed.net,
          completionNote:
            seed.status === 'COMPLETED'
              ? 'Auftrag vollständig ausgeführt. Kundschaft war vor Ort und hat die Arbeiten abgenommen.'
              : null,
          checklist: {
            create: (checklistLabels[seed.serviceSlug] ?? ['Auftrag ausführen']).map(
              (label, index) => ({
                label,
                position: index,
                required: true,
                done: seed.status === 'COMPLETED',
                doneAt: seed.status === 'COMPLETED' ? end : null,
              }),
            ),
          },
          assignments: {
            create: { employeeId: employeeIds[seed.employee], role: 'LEAD', acceptedAt: new Date() },
          },
        },
      });

      if (seed.status === 'COMPLETED') {
        await prisma.timeEntry.create({
          data: {
            jobId: job.id,
            employeeId: employeeIds[seed.employee],
            startedAt: start,
            endedAt: end,
            minutes: seed.durationMin,
            approved: true,
            hourlyRate: teamMembers.find((m) => m.email === seed.employee)?.hourlyRate ?? 30,
          },
        });
      }

      jobCounter++;
    }

    // Rechnung für abgeschlossene Einsätze.
    if (seed.status === 'COMPLETED') {
      const invoiceNumber = `RE-${year}-${String(invoiceCounter).padStart(5, '0')}`;
      const existingInvoice = await prisma.invoice.findUnique({
        where: { organizationId_number: { organizationId: org.id, number: invoiceNumber } },
      });

      if (!existingInvoice) {
        const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
        const paid = invoiceCounter === 1;

        await prisma.invoice.create({
          data: {
            organizationId: org.id,
            number: invoiceNumber,
            customerId,
            bookingId: booking.id,
            status: paid ? 'PAID' : 'SENT',
            issueDate: new Date(end.getTime() + 86_400_000),
            dueDate: new Date(end.getTime() + 31 * 86_400_000),
            billToName: `${customer.firstName} ${customer.lastName}`,
            billToCompany: customer.companyName,
            billToStreet: `${address?.street ?? ''} ${address?.streetNo ?? ''}`.trim(),
            billToZip: address?.postalCode ?? '',
            billToCity: address?.city ?? '',
            billToCountry: 'CH',
            billToEmail: customer.email,
            billToVat: customer.vatNumber,
            subtotal: seed.net,
            netTotal: seed.net,
            vatAmount: vat,
            grossTotal: gross,
            paidAmount: paid ? gross : 0,
            balance: paid ? 0 : gross,
            paidAt: paid ? new Date(end.getTime() + 5 * 86_400_000) : null,
            sentAt: new Date(end.getTime() + 86_400_000),
            qrReference: `21${String(invoiceCounter).padStart(24, '0')}9`,
            items: {
              create: {
                name: services.find((s) => s.slug === seed.serviceSlug)!.name,
                quantity: Math.round((seed.durationMin / 60) * 100) / 100,
                unit: 'Std.',
                unitPrice: Math.round((seed.net / (seed.durationMin / 60)) * 100) / 100,
                vatRate: 8.1,
                netAmount: seed.net,
                vatAmount: vat,
                lineTotal: gross,
              },
            },
            ...(paid
              ? {
                  payments: {
                    create: {
                      customerId,
                      amount: gross,
                      method: 'TWINT',
                      status: 'SUCCEEDED',
                      provider: 'stripe',
                      paidAt: new Date(end.getTime() + 5 * 86_400_000),
                    },
                  },
                }
              : {}),
          },
        });

        await prisma.customer.update({
          where: { id: customerId },
          data: {
            lifetimeValue: { increment: paid ? gross : 0 },
            totalBookings: { increment: 1 },
            lastBookingAt: start,
          },
        });

        invoiceCounter++;
      }
    }
  }

  /**
   * Belegzähler nachführen — aber **niemals zurücksetzen**.
   *
   * Der Seed gilt als beliebig oft ausführbar. Setzte er den Zähler hart auf
   * seinen eigenen Endstand, würde ein zweiter Lauf auf einer Datenbank, in
   * der inzwischen echte Belege entstanden sind, den Zähler *unter* die
   * höchste vergebene Nummer drücken — die nächste Rechnung liefe dann in
   * einen Nummernkonflikt, und die lückenlose Folge nach Art. 957a OR wäre
   * dahin.
   *
   * Deshalb wird der höhere der beiden Werte gesetzt: der Seed hebt den
   * Zähler an, senkt ihn aber nie.
   */
  const raiseSequence = async (scope: string, target: number) => {
    const existing = await prisma.numberSequence.findUnique({
      where: { organizationId_scope_year: { organizationId: org.id, scope, year } },
      select: { current: true },
    });
    if (existing && existing.current >= target) return;
    await prisma.numberSequence.update({
      where: { organizationId_scope_year: { organizationId: org.id, scope, year } },
      data: { current: target },
    });
  };

  await raiseSequence('booking', bookingCounter - 1);
  await raiseSequence('job', jobCounter - 1);
  await raiseSequence('invoice', invoiceCounter - 1);

  console.log(`✓ ${bookingSeeds.length} Buchungen, ${jobCounter - 1} Einsätze, ${invoiceCounter - 1} Rechnungen`);

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

  const expenses = [
    { category: 'MATERIAL' as const, description: 'Reinigungsmittel Grundsortiment', net: 640, days: -20, supplierId: supplier.id },
    { category: 'EQUIPMENT' as const, description: 'Nass-/Trockensauger Kärcher', net: 890, days: -45, supplierId: supplier.id },
    { category: 'VEHICLE' as const, description: 'Leasing Firmentransporter', net: 480, days: -10 },
    { category: 'FUEL' as const, description: 'Treibstoff Flotte', net: 320, days: -8 },
    { category: 'INSURANCE' as const, description: 'Betriebshaftpflicht Quartalsprämie', net: 410, days: -30 },
    { category: 'SOFTWARE' as const, description: 'Software-Abonnements', net: 180, days: -15 },
    { category: 'MARKETING' as const, description: 'Google Ads Kampagne Bern', net: 550, days: -12 },
  ];

  for (const expense of expenses) {
    const vat = Math.round(expense.net * 0.081 * 100) / 100;
    const existing = await prisma.expense.findFirst({
      where: { organizationId: org.id, description: expense.description },
    });
    if (existing) continue;

    await prisma.expense.create({
      data: {
        organizationId: org.id,
        supplierId: expense.supplierId ?? null,
        category: expense.category,
        description: expense.description,
        expenseDate: daysFromNow(expense.days),
        netAmount: expense.net,
        vatRate: 8.1,
        vatAmount: vat,
        grossAmount: Math.round((expense.net + vat) * 100) / 100,
        paid: true,
        paidAt: daysFromNow(expense.days + 3),
        vatDeductible: true,
      },
    });
  }
  console.log(`✓ ${expenses.length} Ausgaben und 1 Lieferant`);

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

  const reviews = [
    { authorName: 'Nicole W.', rating: 5, title: 'Endlich Zeit für anderes', body: 'Seit sechs Monaten kommt alle zwei Wochen dasselbe Team. Pünktlich, gründlich und immer freundlich. Die Buchung über die Website dauert keine zwei Minuten.', serviceKind: 'RESIDENTIAL_CLEANING' as const, featured: true },
    { authorName: 'Peter R., Aareblick Immobilien AG', rating: 5, title: 'Verlässlicher Partner', body: 'Wir lassen mehrere Liegenschaften betreuen. Die monatlichen Berichte und die klare Kommunikation sparen uns viel Aufwand. Preis-Leistung stimmt.', serviceKind: 'OFFICE_CLEANING' as const, featured: true },
    { authorName: 'Martin S.', rating: 5, title: 'Wohnungsabgabe ohne Diskussion', body: 'Die Verwaltung hatte keinen einzigen Beanstandungspunkt. Das Team hat sogar die Storen und den Keller gemacht. Kaution vollständig zurück.', serviceKind: 'MOVE_OUT_CLEANING' as const, featured: true },
    { authorName: 'Katrin L.', rating: 5, title: 'Perfekt für unsere Praxis', body: 'Reinigung nach Praxisschluss, Hygienestandards werden eingehalten und dokumentiert. Wir fühlen uns sehr gut betreut.', serviceKind: 'OFFICE_CLEANING' as const },
    { authorName: 'Sofia B.', rating: 4, title: 'Sehr saubere Fenster', body: 'Streifenfrei und schnell erledigt. Ein Stern Abzug, weil der Termin einmal kurzfristig verschoben werden musste — die Kommunikation war aber transparent.', serviceKind: 'WINDOW_CLEANING' as const },
    { authorName: 'Thomas H.', rating: 5, title: 'Baureinigung top', body: 'Nach dem Umbau war die Wohnung staubfrei und bezugsbereit. Auch die Zementschleier auf den Platten sind komplett weg.', serviceKind: 'CONSTRUCTION_CLEANING' as const },
  ];

  for (const review of reviews) {
    const existing = await prisma.review.findFirst({
      where: { organizationId: org.id, authorName: review.authorName, body: review.body },
    });
    if (existing) continue;
    await prisma.review.create({
      data: { organizationId: org.id, status: 'PUBLISHED', source: 'internal', ...review },
    });
  }

  const galleryItems = [
    { title: 'Umzugsreinigung Länggasse', description: 'Küche vor und nach der Endreinigung — Backofen, Dampfabzug und Fronten entfettet.', serviceKind: 'MOVE_OUT_CLEANING' as const, beforeUrl: '/gallery/umzug-kueche-vorher.jpg', afterUrl: '/gallery/umzug-kueche-nachher.jpg', location: 'Bern Länggasse', featured: true },
    { title: 'Badezimmer entkalkt', description: 'Hartnäckige Kalkablagerungen in Dusche und Armaturen vollständig entfernt.', serviceKind: 'MOVE_OUT_CLEANING' as const, beforeUrl: '/gallery/bad-vorher.jpg', afterUrl: '/gallery/bad-nachher.jpg', location: 'Ostermundigen', featured: true },
    { title: 'Baureinigung Neubau', description: 'Zementschleier auf Feinsteinzeug fachgerecht entfernt.', serviceKind: 'CONSTRUCTION_CLEANING' as const, beforeUrl: '/gallery/bau-vorher.jpg', afterUrl: '/gallery/bau-nachher.jpg', location: 'Köniz', featured: true },
    { title: 'Fensterfront Bürogebäude', description: '38 Fenster inklusive Rahmen und Storen, streifenfrei im Osmose-Verfahren.', serviceKind: 'WINDOW_CLEANING' as const, beforeUrl: '/gallery/fenster-vorher.jpg', afterUrl: '/gallery/fenster-nachher.jpg', location: 'Bern Effingerstrasse' },
  ];

  for (const [index, item] of galleryItems.entries()) {
    const existing = await prisma.galleryItem.findFirst({
      where: { organizationId: org.id, title: item.title },
    });
    if (existing) continue;
    await prisma.galleryItem.create({
      data: { organizationId: org.id, position: index, published: true, ...item },
    });
  }

  const blogCategory = await prisma.blogCategory.upsert({
    where: { organizationId_slug: { organizationId: org.id, slug: 'ratgeber' } },
    update: {},
    create: {
      organizationId: org.id,
      slug: 'ratgeber',
      name: 'Ratgeber',
      description: 'Praktische Tipps rund um Reinigung, Umzug und Haushalt.',
    },
  });

  const posts = [
    {
      slug: 'wohnungsuebergabe-checkliste',
      title: 'Wohnungsübergabe in der Schweiz: Die vollständige Checkliste',
      excerpt:
        'Damit die Kaution vollständig zurückkommt: Was Vermieter bei der Abgabe prüfen und wie Sie sich Schritt für Schritt vorbereiten.',
      content: `## Warum die Wohnungsübergabe so oft schiefgeht

Bei der Wohnungsabgabe prüft die Verwaltung nach einem festen Raster. Wer dieses Raster kennt, kann sich gezielt vorbereiten — und vermeidet Abzüge von der Kaution.

## Die Checkliste nach Räumen

### Küche
- Backofen innen inklusive Backblech und Rost entfettet
- Dampfabzug: Filter gereinigt oder ersetzt
- Kühlschrank abgetaut, innen und hinter dem Gerät gereinigt
- Alle Schränke innen und aussen, inklusive Griffe
- Spüle und Armatur entkalkt

### Badezimmer
- Dusche, Badewanne und Fugen vollständig entkalkt
- WC innen und aussen, inklusive Spülkasten
- Spiegel und Glasflächen streifenfrei
- Abläufe frei und geruchlos

### Alle Räume
- Fenster innen und aussen, Rahmen und Falze
- Storen und Rollläden abgestaubt
- Böden und Sockelleisten
- Türen, Rahmen und Lichtschalter
- Heizkörper inklusive Zwischenräume

### Nebenräume
- Keller und Estrich geleert und gereinigt
- Balkon oder Terrasse gewischt
- Waschküche im Zustand gemäss Hausordnung

## Häufige Beanstandungen

Die drei häufigsten Punkte im Abnahmeprotokoll sind Kalkränder in der Dusche, Fettrückstände am Dampfabzug und Staub in den Storenlamellen. Genau diese Stellen brauchen am meisten Zeit — planen Sie dafür einen halben Tag ein.

## Selbst reinigen oder beauftragen?

Für eine 3.5-Zimmer-Wohnung brauchen zwei geübte Personen etwa 8 bis 10 Stunden. Eine Firma mit Abgabegarantie kostet je nach Fläche zwischen CHF 600 und 1'200 — dafür haften wir für das Ergebnis und kommen bei Beanstandungen kostenlos zurück.

## Am Tag der Übergabe

Nehmen Sie das Übernahmeprotokoll vom Einzug mit. Damit lässt sich normale Abnützung von echten Schäden abgrenzen. Notieren Sie alle Zählerstände und lassen Sie sich die Rückgabe der Schlüssel schriftlich bestätigen.`,
      keywords: ['Wohnungsübergabe', 'Umzugsreinigung', 'Checkliste', 'Kaution'],
      readingMinutes: 6,
    },
    {
      slug: 'wie-oft-buero-reinigen',
      title: 'Wie oft sollte ein Büro gereinigt werden?',
      excerpt:
        'Von der täglichen Sanitärreinigung bis zur jährlichen Grundreinigung: ein praxisnaher Reinigungsplan für KMU.',
      content: `## Es gibt keinen Einheitsrhythmus

Der richtige Reinigungsrhythmus hängt von drei Faktoren ab: Anzahl Personen im Raum, Publikumsverkehr und Bodenbelag. Ein Grossraumbüro mit 30 Arbeitsplätzen braucht einen anderen Plan als ein Anwaltsbüro mit fünf Personen.

## Empfohlener Rhythmus

### Täglich
- Sanitäranlagen reinigen und desinfizieren
- Verbrauchsmaterial nachfüllen
- Abfall und Recycling entsorgen
- Küche und Pausenraum

### Zwei- bis dreimal pro Woche
- Böden saugen und feucht reinigen
- Arbeitsflächen abstauben
- Glastüren und Fingerabdrücke

### Wöchentlich
- Sitzungszimmer gründlich
- Eingangsbereich und Treppenhaus
- Türen und Lichtschalter desinfizieren

### Quartalsweise
- Fensterreinigung innen
- Polstermöbel absaugen
- Storen reinigen

### Jährlich
- Grundreinigung Böden mit Neuversiegelung
- Fenster aussen inklusive Rahmen
- Teppichshampoonierung

## Was kostet das?

Als Faustregel rechnen Sie mit CHF 1.00 bis 1.40 pro Quadratmeter und Reinigungsdurchgang. Bei einem 300-m²-Büro mit drei Durchgängen pro Woche ergibt das rund CHF 1'400 bis 1'800 pro Monat.

## Reinigung ausserhalb der Geschäftszeiten

Reinigung während der Arbeitszeit stört den Betrieb und ist ineffizient. Die meisten unserer Geschäftskunden lassen zwischen 18 und 22 Uhr oder vor 7 Uhr reinigen — mit hinterlegtem Schlüssel und protokolliertem Zugang.`,
      keywords: ['Büroreinigung', 'Reinigungsplan', 'KMU', 'Unterhaltsreinigung'],
      readingMinutes: 5,
    },
    {
      slug: 'kalk-entfernen-hausmittel',
      title: 'Kalk entfernen: Was wirklich funktioniert — und was nicht',
      excerpt:
        'Essig, Zitronensäure oder Spezialreiniger? Ein nüchterner Vergleich für Schweizer Haushalte mit hartem Wasser.',
      content: `## Warum Kalk in der Schweiz ein Dauerthema ist

Das Trinkwasser im Mittelland ist mittelhart bis hart (25 bis 35 französische Härtegrade). Kalk lagert sich dadurch schnell an Armaturen, Duschwänden und in Wasserkochern ab.

## Was funktioniert

**Zitronensäure (5–10 %)** löst Kalk zuverlässig und riecht angenehmer als Essig. Einwirkzeit 15 bis 30 Minuten. Nicht auf Naturstein verwenden.

**Essigessenz (verdünnt 1:4)** ist günstig und wirksam, greift aber Gummidichtungen an. Nach dem Einsatz gründlich nachspülen.

**Saure Spezialreiniger** aus dem Fachhandel enthalten zusätzlich Tenside, die Seifenreste lösen. Für hartnäckige Fälle die beste Wahl.

## Was nicht funktioniert

**Backpulver und Natron** sind basisch und wirken gegen Fett, nicht gegen Kalk. Der oft geteilte Tipp ist chemisch schlicht falsch.

**Cola** enthält Phosphorsäure in zu geringer Konzentration und hinterlässt Zuckerrückstände.

## Vorsicht bei diesen Oberflächen

Niemals Säure verwenden auf: Naturstein (Marmor, Granit), Emaille-Oberflächen mit Rissen, Aluminium und unbeschichtetem Chrom. Hier hilft nur mechanische Reinigung mit weichem Vlies.

## Vorbeugen ist günstiger

Ein Abzieher nach jedem Duschen reduziert die Kalkbildung um schätzungsweise 80 Prozent. Bei sehr hartem Wasser lohnt sich ein Duschkopf mit Antikalk-Noppen.`,
      keywords: ['Kalk entfernen', 'Hausmittel', 'Badreinigung', 'hartes Wasser'],
      readingMinutes: 4,
    },
  ];

  for (const post of posts) {
    await prisma.blogPost.upsert({
      where: {
        organizationId_slug_locale: { organizationId: org.id, slug: post.slug, locale: 'DE' },
      },
      update: { title: post.title, excerpt: post.excerpt, content: post.content },
      create: {
        organizationId: org.id,
        categoryId: blogCategory.id,
        authorId: admin.id,
        slug: post.slug,
        locale: 'DE',
        title: post.title,
        excerpt: post.excerpt,
        content: post.content,
        status: 'PUBLISHED',
        publishedAt: daysFromNow(-Math.floor(Math.random() * 40) - 5),
        readingMinutes: post.readingMinutes,
        keywords: post.keywords,
        seoTitle: `${post.title} | Clenaris Bern`,
        seoDescription: post.excerpt.slice(0, 155),
      },
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
  console.log(
    `✓ Website-Inhalte: ${faqs.length} FAQ, ${reviews.length} Bewertungen, ${posts.length} Blogartikel, ${galleryItems.length} Galerie-Einträge, ${jobPostings.length} Stellen`,
  );

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
  //  Abschluss
  // =========================================================================
  console.log('\n✅  Seed abgeschlossen.\n');
  console.log('   Zugangsdaten (Demo):');
  console.log(`   Admin      ${process.env.SEED_ADMIN_EMAIL ?? 'admin@clenaris.ch'} / ${process.env.SEED_ADMIN_PASSWORD ?? 'Admin#2026Clenaris'}`);
  console.log('   Manager    manager@clenaris.ch / Demo#2026Clenaris');
  console.log('   Mitarbeit. anna.keller@clenaris.ch / Demo#2026Clenaris');
  console.log('   Kundin     nicole.wyss@example.ch / Demo#2026Clenaris\n');
}

main()
  .catch((error) => {
    console.error('❌  Seed fehlgeschlagen:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
