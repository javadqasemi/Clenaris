/**
 * Demodaten — Kundschaft, Buchungen, Rechnungen und Website-Beispiele.
 *
 * Alles hier ist **erfunden**: Nicole Wyss existiert nicht, die Bewertungen
 * hat niemand geschrieben, und die Galerie zeigt Bilder, die es nicht gibt.
 * Genau deshalb steht es in einer eigenen Datei und nicht im
 * Konfigurations-Seed: Ein Betrieb, der loslegt, bekommt eine leere
 * Bewertungsliste und füllt sie mit echten Stimmen. Erfundene Kundenstimmen
 * auf einer öffentlichen Website sind nicht bloss unsauber, sondern
 * wettbewerbsrechtlich heikel.
 *
 * Wozu es trotzdem gebraucht wird:
 *
 *  • **Zum Entwickeln.** Eine leere Liste zeigt nicht, ob eine Tabelle
 *    umbricht oder eine Sortierung greift.
 *  • **Für die Prüfsuite.** Die 453 Prüfungen fahren Kundenakten,
 *    Rechnungen und Nachrichtenverläufe an; ohne Bestand prüfen sie nichts.
 *  • **Zum Vorführen.**
 *
 * Setzt den Konfigurations-Seed voraus und läuft ihn deshalb zuerst — Firma,
 * Leistungen und Team müssen stehen, bevor eine Buchung darauf zeigen kann.
 *
 *   npm run db:seed:demo
 */

import { PrismaClient, type Prisma } from '@prisma/client';
import { hash } from '@node-rs/argon2';

// Derselbe Rechenkern wie in der Anwendung — der Seed erfindet kein Ergebnis.
import { computeScenario, type ScenarioDriverKey } from '../src/lib/bi/math';

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
  console.log('🌱  Demodaten …\n');

  /**
   * Was der Konfigurations-Seed angelegt hat, wird hier nachgeschlagen statt
   * weitergereicht. Zwei getrennte Läufe können sich keine Variablen teilen —
   * und ein Nachschlagen hat den Vorteil, dass es auch dann stimmt, wenn
   * jemand die Firma zwischendurch von Hand geändert hat.
   */
  const org = await prisma.organization.findUnique({ where: { slug: ORG_SLUG } });
  if (!org) {
    console.error('❌  Keine Organisation gefunden. Zuerst „npm run db:seed" ausführen.');
    process.exit(1);
  }

  const admin = await prisma.user.findFirst({
    where: { organizationId: org.id, role: { in: ['SUPER_ADMIN', 'ADMIN'] } },
    orderBy: { createdAt: 'asc' },
  });
  if (!admin) {
    console.error('❌  Kein Verwaltungskonto gefunden. Zuerst „npm run db:seed" ausführen.');
    process.exit(1);
  }

  const supplier = await prisma.supplier.findFirst({ where: { organizationId: org.id } });
  if (!supplier) {
    console.error('❌  Kein Lieferant gefunden. Zuerst „npm run db:seed" ausführen.');
    process.exit(1);
  }

  const year = new Date().getFullYear();
  const demoPassword = await hash('Demo#2026Clenaris', ARGON_OPTIONS);

  /**
   * Leistungen und Team ebenfalls aus der Datenbank, nicht aus einer zweiten
   * Liste im Quelltext. Eine Kopie hier hiesse, dass eine umbenannte Leistung
   * an zwei Stellen nachgezogen werden müsste — und die zweite vergisst man.
   */
  const services = await prisma.service.findMany({
    where: { organizationId: org.id },
    select: { id: true, slug: true, name: true },
  });
  const serviceIds: Record<string, string> = Object.fromEntries(
    services.map((service) => [service.slug, service.id]),
  );

  const employees = await prisma.employee.findMany({
    where: { organizationId: org.id },
    select: { id: true, hourlyRate: true, user: { select: { email: true } } },
  });
  const employeeIds: Record<string, string> = Object.fromEntries(
    employees.flatMap((employee) => (employee.user ? [[employee.user.email, employee.id]] : [])),
  );

  if (services.length === 0 || employees.length === 0) {
    console.error('❌  Leistungskatalog oder Team fehlen. Zuerst „npm run db:seed" ausführen.');
    process.exit(1);
  }

  // ---- Kundschaft ----
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
      // Auch Zustand zurücksetzen, nicht nur das Passwort: Prüfungen des
      // Papierkorbs und der Anonymisierung lassen das Demokonto bei einem
      // abgebrochenen Lauf deaktiviert zurück — und der nächste Lauf meldete
      // dann eine Anmeldung, die „falsch" wäre, obwohl nur der Seed alt war.
      const customerUser = await prisma.user.upsert({
        where: { email: data.email },
        update: { passwordHash: demoPassword, status: 'ACTIVE', deletedAt: null, lockedUntil: null, failedLoginCount: 0 },
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


  // ---- Buchungen, Einsätze und Rechnungen ----
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
            hourlyRate: Number(
              employees.find((entry) => entry.user?.email === seed.employee)?.hourlyRate ?? 30,
            ),
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
  const raiseSequence = async (scope: 'booking' | 'job' | 'invoice', seeded: number) => {
    // Nicht nur der eigene Endstand zählt, sondern die höchste Nummer, die
    // tatsächlich in der Tabelle steht — Prüfläufe und Handeingaben vergeben
    // Nummern, die der Seed nicht kennt. Ein Zähler unter der höchsten
    // vergebenen Nummer liesse den nächsten Beleg in einen Konflikt laufen.
    const table = scope === 'booking' ? prisma.booking : scope === 'job' ? prisma.job : prisma.invoice;
    const rows = await (table as typeof prisma.booking).findMany({
      where: { organizationId: org.id, number: { contains: `-${year}-` } },
      select: { number: true },
    });
    const highest = rows.reduce((max, row) => Math.max(max, Number(row.number.split('-').pop()) || 0), 0);
    const target = Math.max(seeded, highest);
    const existing = await prisma.numberSequence.findUnique({
      where: { organizationId_scope_year: { organizationId: org.id, scope, year } },
      select: { current: true },
    });
    if (existing && existing.current >= target) return;
    await prisma.numberSequence.upsert({
      where: { organizationId_scope_year: { organizationId: org.id, scope, year } },
      update: { current: target },
      create: { organizationId: org.id, scope, year, current: target },
    });
  };

  await raiseSequence('booking', bookingCounter - 1);
  await raiseSequence('job', jobCounter - 1);
  await raiseSequence('invoice', invoiceCounter - 1);

  console.log(`✓ ${bookingSeeds.length} Buchungen, ${jobCounter - 1} Einsätze, ${invoiceCounter - 1} Rechnungen`);


  // ---- Ausgaben ----
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
  console.log(`✓ ${expenses.length} Ausgaben`);

  // ---- Bewertungen ----
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


  // ---- Galerie ----
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


  // ---- Blog ----
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

  console.log(
    `✓ Website-Beispiele: ${reviews.length} Bewertungen, ${galleryItems.length} Galeriebilder, ${posts.length} Blogartikel`,
  );

  // =========================================================================
  //  Unternehmensführung — Beispiele für Ziele, Budget, Risiken, Markt
  // =========================================================================
  /**
   * Erfundene Führungsdaten, die nichts Öffentliches berühren. Sie zeigen, wie
   * das Modul aussieht, wenn es lebt: ein Strategiebaum mit Quartalszielen und
   * Schlüsselergebnissen, ein genehmigtes Budget, ein Anlagenverzeichnis, ein
   * Risikoregister mit Massnahme, Standards mit Prüfzyklus, Wissen, Markt und
   * eine Sitzung mit Pendenzen. Idempotent über den Titel.
   */
  const manager = await prisma.user.findFirst({ where: { organizationId: org.id, email: 'manager@clenaris.ch' } });
  const anna = await prisma.user.findFirst({ where: { organizationId: org.id, email: 'anna.keller@clenaris.ch' } });
  const kpiByKey = Object.fromEntries(
    (await prisma.kpiDefinition.findMany({ where: { organizationId: org.id }, select: { id: true, key: true } })).map((k) => [k.key, k.id]),
  );
  const dateOnly = (offsetDays: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offsetDays);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  };
  const quarter = Math.floor(new Date().getMonth() / 3) + 1;

  const ensureObjective = async (data: {
    title: string;
    horizon: 'STRATEGY' | 'OBJECTIVE' | 'INITIATIVE';
    level: 'COMPANY' | 'DEPARTMENT' | 'PERSONAL';
    status: 'DRAFT' | 'ACTIVE' | 'AT_RISK' | 'ACHIEVED';
    description: string;
    ownerId: string | null;
    parentId?: string | null;
    department?: string;
    fiscalYear?: number;
    quarter?: number;
    startsOn?: Date;
    endsOn?: Date;
    budgetAmount?: number;
  }) => {
    const existing = await prisma.objective.findFirst({ where: { organizationId: org.id, title: data.title } });
    if (existing) return existing;
    return prisma.objective.create({
      data: {
        organizationId: org.id,
        title: data.title,
        horizon: data.horizon,
        level: data.level,
        status: data.status,
        description: data.description,
        ownerId: data.ownerId,
        parentId: data.parentId ?? null,
        department: data.department ?? null,
        fiscalYear: data.fiscalYear ?? null,
        quarter: data.quarter ?? null,
        startsOn: data.startsOn ?? null,
        endsOn: data.endsOn ?? null,
        budgetAmount: data.budgetAmount ?? null,
        reviewIntervalDays: 30,
        nextReviewAt: dateOnly(14),
        createdById: admin.id,
      },
    });
  };

  const strategy = await ensureObjective({
    title: 'Wiederkehrende Umsätze auf 60 % ausbauen',
    horizon: 'STRATEGY',
    level: 'COMPANY',
    status: 'ACTIVE',
    description: 'Vom Einmalgeschäft zum Vertragsgeschäft: Büro- und Unterhaltsreinigung mit Abonnement, weniger Abhängigkeit von Umzugsspitzen im Frühling und Herbst.',
    ownerId: admin.id,
    startsOn: dateOnly(-200),
    endsOn: dateOnly(530),
  });
  const q1 = await ensureObjective({
    title: 'Zehn neue Unterhaltsverträge mit KMU abschliessen',
    horizon: 'OBJECTIVE',
    level: 'COMPANY',
    status: 'ACTIVE',
    description: 'Fokus auf Praxen, Treuhandbüros und Ladengeschäfte im Raum Bern-West.',
    ownerId: manager?.id ?? admin.id,
    parentId: strategy.id,
    department: 'Vertrieb',
    fiscalYear: year,
    quarter,
  });
  const q2 = await ensureObjective({
    title: 'Annahmequote der Offerten auf 45 % heben',
    horizon: 'OBJECTIVE',
    level: 'DEPARTMENT',
    status: 'AT_RISK',
    description: 'Schnellere Rückmeldung, Besichtigung innerhalb von drei Werktagen, Offerte am Folgetag.',
    ownerId: manager?.id ?? admin.id,
    parentId: strategy.id,
    department: 'Vertrieb',
    fiscalYear: year,
    quarter,
  });
  const initiative = await ensureObjective({
    title: 'Abo-Angebot für Büroreinigung auf der Website',
    horizon: 'INITIATIVE',
    level: 'COMPANY',
    status: 'ACTIVE',
    description: 'Eigene Leistungsseite mit Preisrechner für wöchentliche und zweiwöchentliche Reinigung.',
    ownerId: admin.id,
    parentId: q1.id,
    startsOn: dateOnly(-20),
    endsOn: dateOnly(70),
    budgetAmount: 4500,
  });
  const personal = await ensureObjective({
    title: 'Qualitätskontrolle bei jedem dritten Einsatz dokumentieren',
    horizon: 'OBJECTIVE',
    level: 'PERSONAL',
    status: 'ACTIVE',
    description: 'Fotoprotokoll und Checkliste — Grundlage für die Zufriedenheitsmessung.',
    ownerId: anna?.id ?? admin.id,
    department: 'Betrieb',
    fiscalYear: year,
    quarter,
  });

  const ensureKeyResult = async (objectiveId: string, data: { title: string; kpiKey?: string; unit: 'CURRENCY' | 'PERCENT' | 'COUNT'; direction?: 'UP_IS_GOOD' | 'DOWN_IS_GOOD'; startValue: number; targetValue: number; currentValue: number }) => {
    const existing = await prisma.keyResult.findFirst({ where: { objectiveId, title: data.title } });
    if (existing) return existing;
    const span = data.targetValue - data.startValue;
    const progress = span === 0 ? 100 : Math.max(0, Math.min(100, Math.round(((data.currentValue - data.startValue) / span) * 100)));
    const kr = await prisma.keyResult.create({
      data: {
        objectiveId,
        title: data.title,
        kpiDefinitionId: data.kpiKey ? (kpiByKey[data.kpiKey] ?? null) : null,
        kpiPeriod: data.kpiKey ? 'MONTH' : null,
        unit: data.unit,
        direction: data.direction ?? 'UP_IS_GOOD',
        startValue: data.startValue,
        targetValue: data.targetValue,
        currentValue: data.currentValue,
        progressPct: progress,
        lastCheckinAt: new Date(),
      },
    });
    if (!data.kpiKey) {
      await prisma.keyResultCheckin.create({ data: { keyResultId: kr.id, value: data.currentValue, comment: 'Stand aus dem Demo-Seed.', authorId: admin.id } });
    }
    return kr;
  };
  await ensureKeyResult(q1.id, { title: 'Unterzeichnete Unterhaltsverträge', unit: 'COUNT', startValue: 0, targetValue: 10, currentValue: 4 });
  await ensureKeyResult(q1.id, { title: 'Besichtigungstermine je Woche', unit: 'COUNT', startValue: 1, targetValue: 4, currentValue: 3 });
  await ensureKeyResult(q2.id, { title: 'Annahmequote', kpiKey: 'quote.conversion', unit: 'PERCENT', startValue: 28, targetValue: 45, currentValue: 28 });
  await ensureKeyResult(q2.id, { title: 'Offerten innerhalb eines Werktags', unit: 'PERCENT', startValue: 40, targetValue: 90, currentValue: 65 });
  await ensureKeyResult(initiative.id, { title: 'Leistungsseite veröffentlicht', unit: 'PERCENT', startValue: 0, targetValue: 100, currentValue: 60 });
  await ensureKeyResult(personal.id, { title: 'Dokumentierte Kontrollen', unit: 'COUNT', startValue: 0, targetValue: 30, currentValue: 11 });
  for (const objective of [strategy, q1, q2, initiative, personal]) {
    const krs = await prisma.keyResult.findMany({ where: { objectiveId: objective.id }, select: { progressPct: true } });
    const children = await prisma.objective.findMany({ where: { parentId: objective.id }, select: { progressPct: true } });
    const source = krs.length ? krs : children;
    if (source.length) {
      await prisma.objective.update({ where: { id: objective.id }, data: { progressPct: Math.round(source.reduce((s, x) => s + x.progressPct, 0) / source.length) } });
    }
  }

  // Budget des laufenden Jahres, genehmigt, mit Zeilen je Kostenart.
  const budget = await prisma.budgetPeriod.upsert({
    where: { organizationId_fiscalYear_name: { organizationId: org.id, fiscalYear: year, name: `Budget ${year}` } },
    update: {},
    create: {
      organizationId: org.id,
      name: `Budget ${year}`,
      fiscalYear: year,
      startsOn: new Date(Date.UTC(year, 0, 1)),
      endsOn: new Date(Date.UTC(year, 11, 31)),
      status: 'APPROVED',
      approvedAt: new Date(Date.UTC(year - 1, 11, 15)),
      approvedById: admin.id,
      note: 'Genehmigt in der Geschäftsleitungssitzung vom Dezember.',
    },
  });
  const budgetLines: { category: 'MATERIAL' | 'EQUIPMENT' | 'VEHICLE' | 'FUEL' | 'INSURANCE' | 'RENT' | 'SALARY' | 'SOCIAL_SECURITY' | 'MARKETING' | 'SOFTWARE' | 'TRAINING'; label: string; planned: number }[] = [
    { category: 'SALARY', label: 'Löhne Reinigungsteam und Büro', planned: 312000 },
    { category: 'SOCIAL_SECURITY', label: 'AHV, ALV, BVG, UVG', planned: 52000 },
    { category: 'MATERIAL', label: 'Reinigungsmittel und Verbrauchsmaterial', planned: 18000 },
    { category: 'VEHICLE', label: 'Fahrzeuge: Leasing, Service, Versicherung', planned: 21600 },
    { category: 'FUEL', label: 'Treibstoff', planned: 7200 },
    { category: 'INSURANCE', label: 'Betriebshaftpflicht und Sachversicherungen', planned: 4800 },
    { category: 'RENT', label: 'Lager und Büro', planned: 14400 },
    { category: 'MARKETING', label: 'Google Ads, Flyer, Website', planned: 9600 },
    { category: 'SOFTWARE', label: 'Clenaris, Buchhaltung, Telefonie', planned: 3600 },
    { category: 'EQUIPMENT', label: 'Geräte und Ersatz', planned: 6000 },
    { category: 'TRAINING', label: 'Weiterbildung', planned: 2400 },
  ];
  for (const [index, line] of budgetLines.entries()) {
    const existing = await prisma.budgetLine.findFirst({ where: { periodId: budget.id, category: line.category } });
    if (existing) continue;
    const monthly = Math.floor((line.planned / 12) * 100) / 100;
    const plan = Array.from({ length: 12 }, () => monthly);
    plan[11] = Math.round((line.planned - monthly * 11) * 100) / 100;
    await prisma.budgetLine.create({ data: { periodId: budget.id, category: line.category, label: line.label, plannedAmount: line.planned, monthlyPlan: plan, sortOrder: index } });
  }

  // Anlagenverzeichnis.
  const investments = [
    { name: 'Lieferwagen VW Caddy Cargo', category: 'VEHICLE' as const, status: 'ACTIVE' as const, purchaseAmount: 34500, method: 'STRAIGHT_LINE' as const, usefulLifeYears: 6, residualValue: 4500, commissionedOn: dateOnly(-540), assetTag: 'FZ-001', location: 'Lager Bern-Bümpliz', expectedAnnualBenefit: 9000 },
    { name: 'Scheuersaugmaschine Kärcher B 40', category: 'EQUIPMENT' as const, status: 'ACTIVE' as const, purchaseAmount: 6800, method: 'DECLINING' as const, usefulLifeYears: 5, residualValue: 700, commissionedOn: dateOnly(-300), assetTag: 'GR-014', location: 'Lager Bern-Bümpliz', expectedAnnualBenefit: 3200 },
    { name: 'Zweiter Lieferwagen für das Abo-Geschäft', category: 'VEHICLE' as const, status: 'PLANNED' as const, purchaseAmount: 36000, method: 'STRAIGHT_LINE' as const, usefulLifeYears: 6, residualValue: 5000, plannedOn: dateOnly(120), expectedAnnualBenefit: 12000 },
  ];
  for (const investment of investments) {
    const existing = await prisma.investment.findFirst({ where: { organizationId: org.id, name: investment.name } });
    if (existing) continue;
    await prisma.investment.create({ data: { organizationId: org.id, supplierId: investment.category === 'EQUIPMENT' ? supplier.id : null, ownerId: manager?.id ?? admin.id, ...investment } });
  }

  // Ein erwartetes Szenario fürs nächste Jahr — gerechnet mit demselben
  // Rechenkern wie in der Anwendung, damit der Seed kein zweites Ergebnis
  // erfindet.
  const scenarioName = `Erwarteter Fall ${year + 1}`;
  if (!(await prisma.scenario.findFirst({ where: { organizationId: org.id, name: scenarioName } }))) {
    const assumptions: { key: ScenarioDriverKey; label: string; value: number; unit: 'COUNT' | 'CURRENCY' | 'PERCENT' | 'DAYS' | 'HOURS'; monthlyChangePct: number }[] = [
      { key: 'jobsPerMonth', label: 'Aufträge je Monat', value: 95, unit: 'COUNT', monthlyChangePct: 1.5 },
      { key: 'averageTicket', label: 'Ø Erlös je Auftrag', value: 340, unit: 'CURRENCY', monthlyChangePct: 0 },
      { key: 'laborCostPct', label: 'Lohnkosten', value: 52, unit: 'PERCENT', monthlyChangePct: 0 },
      { key: 'materialCostPct', label: 'Materialkosten', value: 6, unit: 'PERCENT', monthlyChangePct: 0 },
      { key: 'overheadPerMonth', label: 'Fixkosten je Monat', value: 9800, unit: 'CURRENCY', monthlyChangePct: 0 },
      { key: 'investmentPerMonth', label: 'Investitionen je Monat', value: 500, unit: 'CURRENCY', monthlyChangePct: 0 },
      { key: 'churnPct', label: 'Kundenverlust je Monat', value: 1, unit: 'PERCENT', monthlyChangePct: 0 },
      { key: 'paymentDelayDays', label: 'Zahlungsverzug', value: 32, unit: 'DAYS', monthlyChangePct: 0 },
      { key: 'hoursPerJob', label: 'Stunden je Auftrag', value: 3.2, unit: 'HOURS', monthlyChangePct: 0 },
      { key: 'targetUtilizationPct', label: 'Zielauslastung', value: 80, unit: 'PERCENT', monthlyChangePct: 0 },
    ];
    const result = computeScenario({
      horizonMonths: 12,
      openingCash: 42000,
      drivers: Object.fromEntries(assumptions.map((a) => [a.key, { value: a.value, monthlyChangePct: a.monthlyChangePct }])),
      jobsPerCustomerMonth: 0.6,
      hoursPerFteMonth: 182,
    });
    await prisma.scenario.create({
      data: {
        organizationId: org.id,
        name: scenarioName,
        kind: 'EXPECTED',
        fiscalYear: year + 1,
        horizonMonths: 12,
        openingCash: 42000,
        description: 'Fortschreibung des laufenden Jahres mit leichtem Wachstum im Vertragsgeschäft.',
        result: result as unknown as Prisma.InputJsonValue,
        computedAt: new Date(),
        createdById: admin.id,
        assumptions: { create: assumptions.map((a, index) => ({ ...a, sortOrder: index })) },
      },
    });
  }

  // Zwei Akten ohne Datei — Fristen sind der Nutzen, nicht die Datei.
  const documents = [
    { title: 'Betriebshaftpflicht-Police', category: 'INSURANCE' as const, visibility: 'MANAGEMENT' as const, description: 'Deckungssumme CHF 5 Mio., Schlüsselverlust eingeschlossen.', tags: ['Versicherung', 'Mobiliar'], validFrom: dateOnly(-300), expiresOn: dateOnly(65), reminderDaysBefore: 60 },
    { title: 'Reinigungsstandards Handbuch', category: 'POLICY' as const, visibility: 'STAFF' as const, description: 'Für alle Mitarbeitenden: Abläufe je Raumtyp, Dosierung, Sicherheitsdatenblätter.', tags: ['Ablauf', 'Schulung'], validFrom: dateOnly(-100), expiresOn: null, reminderDaysBefore: 30 },
  ];
  for (const document of documents) {
    const existing = await prisma.managedDocument.findFirst({ where: { organizationId: org.id, title: document.title } });
    if (existing) continue;
    await prisma.managedDocument.create({ data: { organizationId: org.id, ...document, createdById: admin.id } });
  }

  // Risiken mit einer Massnahme.
  const risks = [
    { title: 'Ausfall des einzigen Lieferwagens in der Umzugssaison', category: 'OPERATIONAL' as const, probability: 3, impact: 4, mitigationPlan: 'Mietvertrag mit Garage Wankdorf für Ersatzfahrzeug innerhalb von 24 Stunden; zweiter Wagen im Budget.', ownerId: manager?.id ?? admin.id, residualProbability: 3, residualImpact: 2 },
    { title: 'Klumpenrisiko Aareblick Immobilien', category: 'FINANCIAL' as const, probability: 2, impact: 5, mitigationPlan: 'Zehn neue KMU-Verträge (Quartalsziel), keine Kundschaft über 20 % Umsatzanteil.', ownerId: admin.id, residualProbability: 2, residualImpact: 3 },
    { title: 'Schlüsselverlust bei Objekten mit Alarmanlage', category: 'DATA_PROTECTION' as const, probability: 2, impact: 4, mitigationPlan: 'Schlüsseldepot mit Ausgabeprotokoll, Zugangshinweise nur in der Anwendung, nie auf Papier.', ownerId: manager?.id ?? admin.id, residualProbability: 1, residualImpact: 4 },
    { title: 'Lohndruck durch Gesamtarbeitsvertrag Reinigung', category: 'PERSONNEL' as const, probability: 4, impact: 3, mitigationPlan: 'Stundensätze jährlich prüfen, Preisklausel in Unterhaltsverträgen.', ownerId: admin.id, residualProbability: 4, residualImpact: 2 },
  ];
  for (const risk of risks) {
    const existing = await prisma.riskEntry.findFirst({ where: { organizationId: org.id, title: risk.title } });
    if (existing) continue;
    await prisma.riskEntry.create({
      data: {
        organizationId: org.id,
        ...risk,
        status: 'MITIGATING',
        severity: risk.probability * risk.impact,
        residualSeverity: risk.residualProbability * risk.residualImpact,
        reviewIntervalDays: 90,
        nextReviewAt: dateOnly(risk.category === 'OPERATIONAL' ? -5 : 60),
        lastReviewedAt: dateOnly(-30),
        createdById: admin.id,
      },
    });
  }
  const vehicleRisk = await prisma.riskEntry.findFirst({ where: { organizationId: org.id, title: risks[0].title } });
  if (vehicleRisk && !(await prisma.correctiveAction.findFirst({ where: { riskId: vehicleRisk.id } }))) {
    const task = await prisma.task.create({
      data: { title: 'Massnahme: Mietvertrag für Ersatzfahrzeug abschliessen', priority: 'HIGH', dueAt: daysFromNow(21, 17), assigneeId: manager?.id ?? admin.id, creatorId: admin.id },
    });
    await prisma.correctiveAction.create({
      data: { organizationId: org.id, kind: 'PREVENTIVE', title: 'Mietvertrag für Ersatzfahrzeug abschliessen', rootCause: 'Nur ein Fahrzeug für alle Einsätze.', riskId: vehicleRisk.id, taskId: task.id, dueOn: dateOnly(21), createdById: admin.id },
    });
  }

  // Kontrollen: Standard, Compliance, Notfall.
  const controls = [
    { kind: 'SOP' as const, title: 'Reinigungsstandard Sanitärräume', reference: 'QS-01', description: '1. Abfall leeren, 2. Spiegel und Armaturen, 3. WC und Urinale mit Sanitärreiniger, 4. Boden nass wischen, 5. Verbrauchsmaterial auffüllen, 6. Sichtkontrolle mit Foto.', evidenceNote: 'Foto nach Abschluss in der Einsatz-Checkliste.', reviewIntervalDays: 180 },
    { kind: 'COMPLIANCE' as const, title: 'Datenschutz: Zugangshinweise und Schlüsselverwaltung', reference: 'nDSG Art. 7', description: 'Zugangshinweise und Alarmcodes stehen ausschliesslich in der Anwendung. Schlüsselausgabe nur gegen Unterschrift im Depotprotokoll.', evidenceNote: 'Depotprotokoll, Stichprobe je Quartal.', reviewIntervalDays: 90 },
    { kind: 'COMPLIANCE' as const, title: 'Arbeitszeiterfassung nach ArG', reference: 'ArG Art. 46', description: 'Jeder Einsatz wird ein- und ausgestempelt; Pausen werden erfasst. Freigabe durch die Betriebsleitung wöchentlich.', evidenceNote: 'Genehmigte Zeiteinträge in der Anwendung.', reviewIntervalDays: 90 },
    { kind: 'CONTINUITY' as const, title: 'Notfallplan Ausfall der Anwendung', reference: 'NF-01', description: 'Einsatzplan der Woche wird jeden Freitag als PDF exportiert und liegt im Büro. Telefonnummern der Kundschaft mit Einsatz in der laufenden Woche ebenfalls.', evidenceNote: 'Ausdruck mit Datum im Ordner Notfall.', reviewIntervalDays: 180 },
  ];
  for (const control of controls) {
    const existing = await prisma.controlEntry.findFirst({ where: { organizationId: org.id, title: control.title } });
    if (existing) continue;
    await prisma.controlEntry.create({ data: { organizationId: org.id, ...control, status: 'ACTIVE', ownerId: manager?.id ?? admin.id, nextReviewAt: dateOnly(control.kind === 'CONTINUITY' ? -10 : 45), lastReviewedAt: dateOnly(-60) } });
  }

  // Wissen.
  const articles = [
    { slug: 'erster-tag-im-team', title: 'Der erste Tag im Team', category: 'Einstieg', summary: 'Schlüssel, Fahrzeug, Zeiterfassung, Ansprechpersonen.', body: '## Willkommen\n\nAm ersten Tag holen Sie den Fahrzeugschlüssel und die Zugangskarte im Büro ab.\n\n## Zeiterfassung\n\nJeder Einsatz wird in der Anwendung ein- und ausgestempelt — auch die Fahrt.\n\n## Fragen\n\nBei allem, was unklar ist: zuerst die Betriebsleitung, dann das Büro.' },
    { slug: 'reinigungsmittel-richtig-dosieren', title: 'Reinigungsmittel richtig dosieren', category: 'Abläufe', summary: 'Weniger ist mehr — und günstiger.', body: '## Grundregel\n\nDie Dosierung steht auf der Flasche. Mehr Mittel reinigt nicht besser, hinterlässt aber Schlieren.\n\n## Sanitär\n\n5 ml auf 5 l Wasser. Nie mit Chlor mischen.\n\n## Böden\n\nMikrofasermopp, zwei Eimer: einer sauber, einer zum Auswaschen.' },
    { slug: 'umgang-mit-reklamationen', title: 'Umgang mit Reklamationen', category: 'Kundschaft', summary: 'Zuhören, festhalten, nachbessern — innerhalb von 24 Stunden.', body: '1. Zuhören und nicht rechtfertigen.\n2. In der Anwendung festhalten (Bewertung oder Nachricht).\n3. Nachbesserung innerhalb von 24 Stunden anbieten.\n4. Betriebsleitung informieren, wenn ein Schaden im Spiel ist.' },
  ];
  for (const article of articles) {
    await prisma.knowledgeArticle.upsert({
      where: { organizationId_slug: { organizationId: org.id, slug: article.slug } },
      update: {},
      create: { organizationId: org.id, ...article, status: 'PUBLISHED', visibility: 'STAFF', publishedAt: daysFromNow(-40), authorId: admin.id, reviewIntervalDays: 365, nextReviewAt: dateOnly(325) },
    });
  }

  // Markt.
  const competitors = [
    { name: 'Blitzblank Reinigungen GmbH', region: 'Bern und Umgebung', services: ['Büroreinigung', 'Unterhaltsreinigung', 'Fensterreinigung'], priceFrom: 38, priceTo: 48, priceNote: 'je Stunde', strengths: 'Grosse Flotte, Nachtarbeit möglich.', weaknesses: 'Wechselndes Personal, keine Online-Buchung.', marketPosition: 'Volumenanbieter', reviewScore: 4.1, reviewCount: 62 },
    { name: 'Sauber & Fein', region: 'Thun', services: ['Umzugsreinigung', 'Wohnungsreinigung'], priceFrom: 42, priceTo: 55, priceNote: 'je Stunde, Abnahmegarantie', strengths: 'Sehr gute Bewertungen bei Umzugsreinigungen.', weaknesses: 'Keine Verträge, nur Einmalgeschäft.', marketPosition: 'Premium im Umzugssegment', reviewScore: 4.8, reviewCount: 141 },
  ];
  for (const competitor of competitors) {
    const existing = await prisma.competitor.findFirst({ where: { organizationId: org.id, name: competitor.name } });
    if (existing) continue;
    await prisma.competitor.create({ data: { organizationId: org.id, ...competitor, reviewIntervalDays: 180, nextReviewAt: dateOnly(120), lastReviewedAt: dateOnly(-60) } });
  }
  const insights = [
    { kind: 'LEGAL' as const, title: 'GAV Reinigung: Mindestlöhne steigen per Januar', body: 'Der allgemeinverbindliche Gesamtarbeitsvertrag für die Reinigungsbranche in der Deutschschweiz sieht eine Erhöhung der Mindestlöhne vor.', sourceName: 'Allpura', observedOn: dateOnly(-90), impactNote: 'Stundensätze in Unterhaltsverträgen mit Preisklausel anpassen.', reviewIntervalDays: 365 },
    { kind: 'CUSTOMER' as const, title: 'Nachfrage nach wöchentlicher Büroreinigung in Coworking-Flächen', body: 'Drei Anfragen aus Coworking-Spaces in Bern innerhalb eines Monats; alle mit Wunsch nach Abendreinigung.', sourceName: 'Eigene Anfragen', observedOn: dateOnly(-30), impactNote: 'Abo-Angebot mit Abendfenster prüfen.', reviewIntervalDays: 180 },
    { kind: 'TECHNOLOGY' as const, title: 'Online-Buchung wird zum Standard', body: 'Mitbewerber ohne Online-Buchung verlieren bei Privatkundschaft unter 40 sichtbar an Anfragen.', sourceName: 'Branchenbeobachtung', observedOn: dateOnly(-400), impactNote: 'Unser Vorsprung — halten und ausbauen.', reviewIntervalDays: 365 },
  ];
  for (const insight of insights) {
    const existing = await prisma.marketInsight.findFirst({ where: { organizationId: org.id, title: insight.title } });
    if (existing) continue;
    await prisma.marketInsight.create({ data: { organizationId: org.id, ...insight, nextReviewAt: new Date(insight.observedOn.getTime() + insight.reviewIntervalDays * 86_400_000), createdById: admin.id } });
  }
  if (!(await prisma.analysisBoard.findFirst({ where: { organizationId: org.id, kind: 'SWOT' } }))) {
    await prisma.analysisBoard.create({
      data: {
        organizationId: org.id,
        kind: 'SWOT',
        title: `SWOT ${year}`,
        preparedOn: dateOnly(-45),
        summary: 'Das Vertragsgeschäft ist der Hebel: die Stärke bei Online-Buchung und Bewertungen in wiederkehrende Umsätze übersetzen.',
        reviewIntervalDays: 365,
        nextReviewAt: dateOnly(320),
        createdById: admin.id,
        entries: {
          create: [
            { bucket: 'STRENGTH', title: 'Online-Buchung mit Sofortpreis', detail: 'Kein Mitbewerber in Bern bietet das.', weight: 5, sortOrder: 0 },
            { bucket: 'STRENGTH', title: 'Bewertungsschnitt 4.8', detail: 'Über 60 öffentliche Bewertungen.', weight: 4, sortOrder: 1 },
            { bucket: 'WEAKNESS', title: 'Nur ein Fahrzeug', detail: 'Jeder Ausfall trifft alle Einsätze.', weight: 4, sortOrder: 0 },
            { bucket: 'WEAKNESS', title: 'Abhängigkeit von Umzugssaison', detail: 'Frühling und Herbst tragen die Hälfte des Umsatzes.', weight: 4, sortOrder: 1 },
            { bucket: 'OPPORTUNITY', title: 'Coworking und Praxen', detail: 'Wachsende Nachfrage nach Abendreinigung im Abonnement.', weight: 5, sortOrder: 0 },
            { bucket: 'THREAT', title: 'Lohndruck durch GAV', detail: 'Marge sinkt ohne Preisanpassung um zwei Punkte.', weight: 3, sortOrder: 0 },
          ],
        },
      },
    });
  }

  // Eine Sitzung mit Pendenzen.
  if (!(await prisma.meeting.findFirst({ where: { organizationId: org.id, title: 'Geschäftsleitung: Quartalsstart' } }))) {
    const meeting = await prisma.meeting.create({
      data: {
        organizationId: org.id,
        title: 'Geschäftsleitung: Quartalsstart',
        heldAt: daysFromNow(-12, 9, 0),
        location: 'Büro Bern',
        agenda: '1. Zahlen des Vorquartals\n2. Stand Unterhaltsverträge\n3. Zweiter Lieferwagen\n4. Pendenzen',
        minutes: 'Umsatz im Plan, Marge leicht unter Vorjahr wegen Materialpreisen. Vier Unterhaltsverträge unterzeichnet, sechs in Verhandlung. Zweiter Lieferwagen wird budgetiert, Entscheid im nächsten Quartal.',
        decisions: '1. Preisklausel in allen neuen Unterhaltsverträgen.\n2. Mietvertrag für Ersatzfahrzeug bis Ende Monat.\n3. Abo-Seite auf der Website bis Quartalsende.',
        objectiveId: strategy.id,
        createdById: admin.id,
        participants: { create: [{ userId: admin.id }, ...(manager ? [{ userId: manager.id }] : [])] },
      },
    });
    await prisma.task.create({ data: { title: 'Preisklausel mit Treuhand abstimmen', priority: 'NORMAL', dueAt: daysFromNow(10, 17), assigneeId: admin.id, creatorId: admin.id, meetingId: meeting.id, description: `Pendenz aus der Sitzung „${meeting.title}"` } });
  }

  // Ein Berichtszeitplan, ohne Empfänger — Versand erst nach ausdrücklicher Einrichtung.
  if (!(await prisma.reportSchedule.findFirst({ where: { organizationId: org.id, name: 'Monatsbericht Geschäftsleitung' } }))) {
    const next = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1, 5, 0, 0));
    await prisma.reportSchedule.create({ data: { organizationId: org.id, name: 'Monatsbericht Geschäftsleitung', kind: 'BUSINESS_PERFORMANCE', cadence: 'MONTHLY', format: 'PDF', runOnDay: 1, recipients: [], active: true, nextRunAt: next } });
  }

  console.log('✓ Unternehmensführung: Ziele, Budget, Anlagen, Risiken, Kontrollen, Wissen, Markt, Sitzung');

  console.log('\n✅  Demodaten angelegt.\n');
  console.log('   Kundin     nicole.wyss@example.ch / Demo#2026Clenaris\n');
  console.log('   Achtung: Bewertungen und Galerie sind erfunden und öffentlich sichtbar.');
  console.log('   Vor dem Livegang entfernen oder durch echte ersetzen.\n');
}

main()
  .catch((error) => {
    console.error('❌  Demodaten fehlgeschlagen:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
