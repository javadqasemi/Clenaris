import 'server-only';

import type { Booking, Frequency, Prisma } from '@prisma/client';

import { prisma, toNumber, type Tx } from '@/lib/db';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '@/lib/errors';
import { calculateBookingPrice } from '@/lib/pricing/engine';
import type { LeistungInput, PriceBreakdown } from '@/lib/pricing/types';
import { leistungsnamen } from '@/lib/booking/leistungen';
import { absoluteUrl, formatDate, formatDateTime, round2 } from '@/lib/utils';
import { produkt, prozentVon, summeZahl } from '@/lib/money';
import { orderByFor, resolveSort, type SortOrder } from '@/lib/sort';
import { randomToken } from '@/lib/auth/jwt';
import { can, type ActorRole } from '@/lib/auth/rbac';
import type { SessionUser } from '@/lib/auth/session';
import type { BookingCoreInput, UpdateBookingInput } from '@/lib/validation/booking';
import {
  bookingCancelledEmail,
  bookingConfirmedEmail,
  bookingReceivedEmail,
  bookingRescheduledEmail,
  newBookingInternalEmail,
} from '@/lib/email/templates';
import { smsTemplates } from '@/lib/sms/client';
import { audit } from '@/lib/audit';
import { automationEreignisseAbarbeiten, automationEreignisVormerken } from './automation-engine.service';
import { logger } from '@/lib/logger';
import { renderBookingConfirmationPdf } from '@/lib/pdf/render';

import { kundenakteSperren } from './kundenakte-sperre';
import { nextNumber } from './numbering.service';
import { invalidateAvailability, isSlotBookable, leistungsbedarf } from './availability.service';
import { assertAssignable } from './assignment.service';
import { notify, notifyStaff } from './notification.service';
import { createJobsForBooking } from './job.service';
import { dateienBinden } from './file.service';
import { issuePublicToken, resolvePublicToken, revokeTokensFor, tokenRejectionError } from './access-token.service';

/**
 * Buchungslogik.
 *
 * Architekturentscheide:
 *  1. Der Preis wird beim Anlegen serverseitig neu berechnet und als Snapshot
 *     an der Buchung gespeichert. Katalogänderungen dürfen bestehende Buchungen
 *     nie nachträglich verteuern.
 *  2. Buchung und daraus abgeleiteter Job entstehen in *einer* Transaktion.
 *     Eine bestätigte Buchung ohne Einsatz wäre ein Dispositionsloch.
 *  3. Serien werden rollierend materialisiert (12 Wochen im Voraus, per Cron
 *     nachgeführt) statt komplett — sonst entstehen bei „wöchentlich, unbefristet"
 *     unbegrenzt viele Datensätze.
 *  4. Stornofrist: 24 Stunden. Danach entscheidet das Büro manuell.
 */

const CANCELLATION_WINDOW_HOURS = 24;
const RECURRENCE_HORIZON_DAYS = 84; // 12 Wochen

export interface CreateBookingResult {
  booking: Booking;
  /**
   * Der Verwaltungslink — `null`, wenn ihn die anfragende Person nicht sehen
   * darf: bei einer Gastbuchung auf eine bestehende Kundenakte (siehe
   * `AufgeloesteKundschaft.nachgewiesen`). Der Link geht dann nur per E-Mail
   * an die Adresse der Akte.
   */
  confirmationUrl: string | null;
  isNewCustomer: boolean;
}

/**
 * Zusatzangaben, wenn die Buchung im Büro entsteht statt auf der Website.
 *
 * Gemeinsamer Dienst, zwei Wege hinein: Preisberechnung, Serienanlage,
 * Adresslogik, Gutscheinzähler und Kundenstatistik sind in beiden Fällen
 * dieselben, und ein zweiter Buchungsweg wäre ein zweiter Ort, an dem der
 * Preis entstehen kann. Was sich unterscheidet, steht hier — und nur hier.
 */
export interface OfficeBookingContext {
  /** Für wen gebucht wird. Im Büro bekannt, wird nicht aus der Adresse erraten. */
  customerId: string;
  source: Booking['source'];
  internalNote?: string;
  /**
   * Kapazitätsprüfung übergehen.
   *
   * Keine eigene Berechtigung: Wer im Büro buchen darf, darf auch entscheiden,
   * dass ein dringender Auftrag trotz voller Tagesplanung angenommen wird —
   * das ist dieselbe Entscheidung, nicht eine weiterreichende. Der
   * Protokolleintrag hält sie fest.
   */
  overrideCapacity: boolean;
}

/**
 * Legt eine Buchung an — für eingeloggte Kunden, Gäste und das Büro.
 */
export async function createBooking(params: {
  organizationId: string;
  input: BookingCoreInput;
  session: SessionUser | null;
  ip?: string;
  /** Gesetzt = Erfassung im Büro über `POST /api/bookings`. */
  office?: OfficeBookingContext;
}): Promise<CreateBookingResult> {
  const { organizationId, input, session, office } = params;

  // --- 1) Kunde auflösen — anlegen erst in der Transaktion unten -----------
  /**
   * Eine neue Gastkundschaft entsteht erst zusammen mit der Buchung
   * (Befund A2, 2026-09-26). Vorher legte `resolveCustomer` sie in einer
   * eigenen Transaktion an, *bevor* Preis und Termin geprüft waren: Eine
   * abgewiesene Buchung — Termin voll, Gutschein ungültig, Postleitzahl
   * ausserhalb — hinterliess eine Kundenakte ohne Buchung, mit Nummer, im
   * CRM. Wer abgewiesen wird, ist keine Kundschaft geworden; eine Anfrage
   * daraus zu machen wäre eine eigene, ausdrückliche Entscheidung.
   */
  const kunde = office
    ? await resolveOfficeCustomer({ organizationId, customerId: office.customerId })
    : await resolveCustomer({ organizationId, input, session });
  const { isNewCustomer, customerEmail, customerName, userId } = kunde;

  // --- 2) Preis serverseitig berechnen -------------------------------------
  // Eine neue Kundschaft hat weder Rabatt noch Buchungen noch eine Sperre.
  const customer = kunde.customerId
    ? await prisma.customer.findUniqueOrThrow({
        where: { id: kunde.customerId },
        select: { discountPercent: true, blocked: true, blockedReason: true, totalBookings: true },
      })
    : { discountPercent: 0, blocked: false, blockedReason: null, totalBookings: 0 };

  if (customer.blocked) {
    // Der Sperrgrund ist eine Notiz des Büros über diese Kundschaft. Wer nur
    // ihre E-Mail-Adresse eingetippt hat, bekommt die allgemeine Meldung —
    // sonst liesse sich die Notiz mit einer einzigen Anfrage auslesen.
    throw new BusinessRuleError(
      (kunde.nachgewiesen ? customer.blockedReason : null) ??
        'Für dieses Kundenkonto sind zurzeit keine Online-Buchungen möglich. Bitte kontaktieren Sie uns.',
    );
  }

  /**
   * Der Dauerrabatt gilt nur, wo die Identität nachgewiesen ist (F-03,
   * 2026-09-27).
   *
   * Er ist eine Vereinbarung mit **dieser** Kundschaft. Vorher bekam ihn jede
   * Gastbuchung mit der passenden E-Mail-Adresse: Wer die Adresse eines
   * Grosskunden kannte, buchte zu dessen Konditionen — und las den Satz am
   * Gesamtbetrag der Antwort ab, verglichen mit der Sofortschätzung. Ohne
   * Nachweis rechnet der Server den Listenpreis; das Büro kann nach
   * Rücksprache korrigieren, und angemeldet gilt der Rabatt wie bisher.
   * Gutscheinregeln (Erstbuchung, Einlösungen je Kundschaft) laufen dagegen
   * weiter gegen die Akte: Dort ist die strengere Auslegung die sichere, eine
   * anonyme Buchung darf eine bereits genutzte Einlösung nicht erneuern.
   */
  const rabattProzent = kunde.nachgewiesen ? toNumber(customer.discountPercent) : 0;

  /**
   * Adresse und Objekt nur aus dem Bestand einer **nachgewiesenen**
   * Kundschaft (F-03). Eine per E-Mail-Adresse zugeordnete Gastbuchung
   * hat keinen Bestand, auf den sie verweisen darf — sonst wäre die
   * E-Mail-Adresse der Schlüssel zu fremden Adressen samt Zugangsnotiz.
   */
  const bezuege = await buchungsbezuegePruefen({
    organizationId,
    customerId: kunde.nachgewiesen ? kunde.customerId : null,
    addressId: input.addressId ?? null,
    propertyId: input.propertyId ?? null,
    fileIds: input.fileIds,
    uploaderId: session?.id ?? null,
  });
  const postalCode = input.address?.postalCode ?? bezuege.postalCode ?? undefined;

  const leistungen = leistungenAusEingabe(input);
  const breakdown = await calculateBookingPrice(
    {
      leistungen,
      propertyKind: input.propertyKind,
      frequency: input.frequency,
      scheduledStart: input.scheduledStart,
      postalCode: postalCode ?? null,
      hasPets: input.hasPets,
      couponCode: input.couponCode ?? null,
      // Für eine neue Kundschaft eine Kennung, die keine Buchung trifft: Die
      // Gutscheinprüfung zählt Einlösungen je Kundschaft, und es gibt keine.
      customer: { id: kunde.customerId ?? '__neue_kundschaft__', totalBookings: customer.totalBookings },
      customerDiscountPercent: rabattProzent,
      urgent: input.urgent,
    },
    organizationId,
  );

  if (breakdown.onRequest) {
    throw new BusinessRuleError(
      leistungen.length > 1
        ? 'Mindestens eine der gewählten Leistungen offerieren wir individuell. Bitte nutzen Sie das Offertformular oder buchen Sie sie getrennt.'
        : 'Für diese Dienstleistung erstellen wir eine individuelle Offerte. Bitte nutzen Sie das Offertformular.',
    );
  }

  // Ein eingegebener, aber nicht anwendbarer Gutschein ist ein Abbruchgrund,
  // kein Schönheitsfehler: Früher wurde still zum vollen Preis gebucht, und
  // die Kundschaft erfuhr erst auf der Rechnung, dass der Code nicht griff.
  // 422 mit der Begründung — die Kundschaft korrigiert oder leert das Feld.
  if (breakdown.coupon && breakdown.coupon.status !== 'APPLIED') {
    throw new BusinessRuleError(breakdown.coupon.message);
  }

  // --- 3) + 4) Kapazität prüfen und Buchung schreiben, in einem Zug -------
  const scheduledEnd = new Date(
    input.scheduledStart.getTime() + breakdown.durationMinutes * 60_000,
  );

  const { booking, offenlegen, wiederholt } = await prisma.$transaction(async (tx) => {
    /**
     * Die Kapazitätsprüfung hält den öffentlichen Buchungstrichter davon ab,
     * mehr zuzusagen, als das Team schafft. Im Büro ist sie eine Empfehlung:
     * Wer anruft, weil es brennt, bekommt einen Termin, und die Disposition
     * löst es. Deshalb übergehbar — aber nur ausdrücklich, und der
     * Protokolleintrag unten hält fest, dass es geschehen ist.
     *
     * **Warum innerhalb der Transaktion und hinter einer Sperre**
     * (2026-09-26): Vorher lief die Prüfung vor der Transaktion. Zwei
     * Anfragen für den letzten freien Platz lasen beide „frei" und schrieben
     * beide — der Kalender hatte den Platz beiden angeboten, und beide bekamen
     * ihn. Jetzt nimmt jede Buchung zuerst eine Transaktionssperre je
     * Organisation (`pg_advisory_xact_lock`), prüft dann mit den Daten *in*
     * der Transaktion und schreibt. Die zweite Anfrage wartet, bis die erste
     * festgeschrieben ist, und sieht deren Buchung als Belegung — seit diesem
     * Sprint zählen auch unbestätigte Buchungen (siehe `availability.service`).
     * Die Sperre gilt je Organisation und nur für die Dauer einer Buchung;
     * bei den Buchungszahlen eines Reinigungsbetriebs ist das kein Engpass.
     */
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`buchung:${organizationId}`}))`;

    /**
     * Dasselbe Absenden ein zweites Mal (B-23, 2026-09-28): die erste Buchung
     * zurückgeben, nichts Neues anlegen.
     *
     * Unter der Buchungssperre gelesen — zwei gleichzeitige Versuche mit
     * derselben Kennung reihen sich an ihr auf, der zweite sieht die Buchung
     * des ersten. Der eindeutige Index `(organizationId, idempotencyKey)` hält
     * zusätzlich, falls je ein Weg an der Sperre vorbeiführte.
     *
     * Zurück kommt die Buchung **ohne** Verwaltungslink (`offenlegen: false`):
     * Der Link ist ein Einmalwert, der nur als Hash gespeichert ist, und eine
     * Wiederholung stellt keinen zweiten aus. Der Assistent zeigt dann die
     * knappe Bestätigung — dieselbe wie bei einer Gastbuchung auf eine
     * bestehende Akte. Die Kennung selbst ist ein Zufallswert, den nur der
     * absendende Browser kennt; wer sie hat, hat die Buchung angelegt.
     */
    if (input.idempotencyKey) {
      const schon = await tx.booking.findFirst({
        where: { organizationId, idempotencyKey: input.idempotencyKey },
        include: { customer: true, address: true },
      });
      if (schon) return { booking: schon, offenlegen: false, wiederholt: true };
    }

    if (!office?.overrideCapacity) {
      const bedarf = await leistungsbedarf(tx, organizationId, leistungen.map((l) => l.serviceId));
      const slotCheck = await isSlotBookable({
        organizationId,
        start: input.scheduledStart,
        durationMin: breakdown.durationMinutes,
        crewSize: breakdown.crewSize,
        bufferMin: breakdown.bufferMinutes,
        qualifikationen: bedarf.qualifikationen,
        kanal: office ? 'buero' : 'oeffentlich',
        db: tx,
      });
      if (!slotCheck.ok) throw new BusinessRuleError(slotCheck.reason!);
    }

    // Erst jetzt, nach allen Prüfungen und in derselben Transaktion wie die
    // Buchung: Scheitert danach noch etwas, rollt die Kundschaft mit zurück.
    /**
     * `offenlegen`: Darf die anfragende Person sehen, was an der Akte steht?
     * Ja bei einer nachgewiesenen Kundschaft und bei einer Akte, die diese
     * Anfrage gerade selbst angelegt hat. Nein, wenn die Gastbuchung auf eine
     * bestehende Akte fällt — auch dann, wenn diese erst zwischen Auflösen und
     * hier entstanden ist (`gastkundschaftAnlegen` findet sie dann vor): Eine
     * Akte, die jemand anderes angelegt hat, gehört nicht deshalb der
     * anfragenden Person, weil beide dieselbe Adresse eingetippt haben.
     */
    let customerId: string;
    let offenlegen: boolean;
    if (kunde.customerId) {
      customerId = kunde.customerId;
      offenlegen = kunde.nachgewiesen;
    } else {
      const akte = await gastkundschaftAnlegen(tx, organizationId, kunde.neu!);
      customerId = akte.id;
      offenlegen = akte.angelegt;
    }

    const { number } = await nextNumber(tx, organizationId, 'booking');

    // Adresse übernehmen oder neu anlegen. Die Kennung ist oben geprüft und
    // kommt nur bei einer nachgewiesenen Kundschaft durch.
    const addressId = input.addressId ?? (await createAddress(tx, customerId, input, { bestandSchonen: !offenlegen }));

    // Wiederholungsregel.
    let recurrenceRuleId: string | null = null;
    if (input.frequency !== 'ONCE' && input.recurrence) {
      const rule = await tx.recurrenceRule.create({
        data: {
          frequency: input.frequency,
          interval: input.recurrence.interval,
          weekdays: input.recurrence.weekdays,
          startDate: input.scheduledStart,
          endDate: input.recurrence.endDate ?? null,
          count: input.recurrence.count ?? null,
          generatedUntil: input.scheduledStart,
        },
      });
      recurrenceRuleId = rule.id;
    }

    const created = await tx.booking.create({
      data: {
        organizationId,
        number,
        customerId,
        addressId,
        propertyId: input.propertyId ?? null,
        status: 'PENDING',
        scheduledStart: input.scheduledStart,
        scheduledEnd,
        durationMin: breakdown.durationMinutes,
        crewSize: breakdown.crewSize,
        recurrenceRuleId,
        frequency: input.frequency,
        propertyKind: input.propertyKind,
        // Die Objektangaben an der Buchung bleiben, was sie waren: das
        // Objekt. Bei mehreren Leistungen die grösste angegebene Fläche und
        // Zimmerzahl — die Angaben je Leistung stehen an den Positionen.
        squareMeters: objektwert(input.squareMeters, leistungen.map((l) => l.squareMeters)),
        rooms: objektwert(input.rooms, leistungen.map((l) => l.rooms)),
        windows: objektwert(input.windows, leistungen.map((l) => l.windows)),
        customerNote: input.customerNote ?? null,
        internalNote: office?.internalNote ?? null,
        accessNote: input.accessNote ?? null,
        subtotal: breakdown.subtotal,
        extrasTotal: breakdown.extrasTotal,
        travelFee: breakdown.travelFee,
        discountAmount: Math.abs(breakdown.discountTotal),
        // In der Schreibweise des Gutscheins (2026-09-28). Gespeichert wurde
        // vorher, was getippt war; die Grenze je Kundschaft zählte aber die
        // Grossschreibung — „sommer10" zählte nie gegen „SOMMER10".
        couponCode: input.couponCode ? input.couponCode.toUpperCase().trim() : null,
        netTotal: breakdown.netTotal,
        vatRate: breakdown.vatRate,
        vatAmount: breakdown.vatAmount,
        grossTotal: breakdown.grossTotal,
        priceBreakdown: breakdown as unknown as Prisma.InputJsonValue,
        // Eine telefonische Buchung als „Website" zu verbuchen, verfälscht
        // jede Auswertung darüber, woher die Aufträge kommen.
        source: office?.source ?? 'WEBSITE',
        bookedByIp: params.ip ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        items: { create: positionenAusHerleitung(breakdown, leistungen) },
        extras: { create: zusatzleistungenAusHerleitung(breakdown) },
      },
      include: { customer: true, address: true },
    });

    /**
     * Hochgeladene Fotos der Buchung zuordnen — nur die eigenen, nur einmal.
     *
     * Bis 2026-09-27 standen hier nur Organisation und Prüfsumme als
     * Bedingung, und die Zuordnung **überschrieb den Zweck** (`scope`). Wer
     * die Kennung irgendeiner Datei kannte — Lohnabrechnung, Bewerbung,
     * Dokument einer anderen Kundschaft —, hängte sie an die eigene Buchung,
     * machte sie damit zu einem Buchungsfoto und las sie über die eigene
     * Buchungsansicht aus. Die Kennung war der Schlüssel; eine Kennung ist
     * keine Berechtigung.
     *
     * Jetzt ist die Zuordnung ein einziger bedingter Übergang: Die Datei muss
     * von **dieser** angemeldeten Person hochgeladen sein, als Buchungsfoto,
     * noch an keiner Buchung hängen, fertig geprüft und sauber sein. Trifft
     * das nicht auf jede genannte Kennung zu, scheitert die ganze Buchung —
     * eine stillschweigend übergangene Kennung verdeckte genau den Versuch,
     * der hier abgewiesen wird. Die Vorprüfung (`buchungsbezuegePruefen`)
     * meldet den Fehler früh; dieser Übergang entscheidet, auch wenn eine
     * zweite Buchung dieselbe Datei gleichzeitig beansprucht.
     */
    if (input.fileIds.length > 0) {
      await dateienBinden(tx, { organizationId, fileIds: input.fileIds, uploadedById: session!.id, scope: 'BOOKING', ziel: 'bookingId', zielId: created.id });
    }

    /**
     * Gutschein einlösen — **bedingt**, unter der Buchungssperre (2026-09-28).
     *
     * Die Grenzen prüfte bis dahin nur `calculateBookingPrice`, also *vor* der
     * Transaktion, und hier wurde ohne Bedingung hochgezählt. Zwei Buchungen
     * beim Stand `usageLimit − 1` lasen beide „noch frei" und lösten beide ein;
     * ebenso zwei Buchungen derselben Kundschaft mit `perCustomerLimit` 1.
     * Die Sperre oben reiht die Buchungen der Organisation zwar hintereinander
     * — geholfen hat das nicht, weil die Prüfung ausserhalb lag.
     *
     * Jetzt entscheidet die Datenbank: Hochgezählt wird nur, solange das Limit
     * nicht erreicht ist, und die Zahl der Einlösungen dieser Kundschaft wird
     * in derselben Transaktion gezählt, in der die eigene Buchung schon
     * steht. Scheitert eins davon, rollt die ganze Buchung zurück — mit
     * derselben Meldung, die die Preisberechnung gegeben hätte.
     */
    if (input.couponCode && breakdown.lines.some((l) => l.key === 'coupon')) {
      const code = input.couponCode.toUpperCase().trim();
      const eingeloest = await tx.$executeRaw`
        UPDATE "coupons" SET "usageCount" = "usageCount" + 1
        WHERE "organizationId" = ${organizationId} AND "code" = ${code}
          AND ("usageLimit" IS NULL OR "usageCount" < "usageLimit")`;
      if (eingeloest === 0) {
        throw new BusinessRuleError('Dieser Gutscheincode wurde bereits vollständig eingelöst.');
      }
      const gutschein = await tx.coupon.findUniqueOrThrow({
        where: { organizationId_code: { organizationId, code } },
        select: { perCustomerLimit: true },
      });
      const jeKundschaft = await tx.booking.count({
        where: { organizationId, customerId, couponCode: { equals: code, mode: 'insensitive' }, status: { not: 'CANCELLED' } },
      });
      if (jeKundschaft > gutschein.perCustomerLimit) {
        throw new BusinessRuleError(
          gutschein.perCustomerLimit === 1
            ? 'Sie haben diesen Gutschein bereits eingelöst.'
            : `Dieser Gutschein lässt sich höchstens ${gutschein.perCustomerLimit}× pro Kundschaft einlösen.`,
        );
      }
    }

    // Kundenstatistik nachführen.
    await tx.customer.update({
      where: { id: customerId },
      data: { totalBookings: { increment: 1 }, lastBookingAt: new Date() },
    });

    await automationEreignisVormerken(tx, { organizationId, trigger: 'BOOKING_CREATED', entityId: created.id });
    return { booking: created, offenlegen, wiederholt: false };
  });

  // Eine Wiederholung löst nichts noch einmal aus: keine zweite E-Mail, kein
  // zweiter Link, kein zweiter Protokolleintrag (B-23).
  if (wiederholt) return { booking, confirmationUrl: null, isNewCustomer: false };

  // --- 5) Folgeaktionen ausserhalb der Transaktion -------------------------
  await invalidateAvailability(organizationId, input.scheduledStart);

  // Für Mitteilungen: alle Leistungen beim Namen, nicht nur die erste.
  const service = { name: breakdown.positionen.map((p) => p.name).join(' + ') };

  const addressLabel = await formatBookingAddress(booking.addressId);
  const confirmationUrl = await buchungslinkAusstellen({
    organizationId,
    bookingId: booking.id,
    scheduledEnd: booking.scheduledEnd,
    createdById: session?.id ?? null,
  });
  const confirmationPdf = await bookingPdfAttachment(booking.id, confirmationUrl);

  await notify({
    userId,
    email: customerEmail,
    channels: ['IN_APP', 'EMAIL'],
    title: 'Buchung eingegangen',
    body: `Ihre Buchung ${booking.number} wurde erfasst und wird geprüft.`,
    link: `/konto/buchungen/${booking.id}`,
    emailContent: bookingReceivedEmail({
      firstName: customerName.split(' ')[0],
      bookingNumber: booking.number,
      serviceName: service?.name ?? 'Reinigung',
      scheduledStart: booking.scheduledStart,
      scheduledEnd: booking.scheduledEnd,
      address: addressLabel,
      grossTotal: toNumber(booking.grossTotal),
      manageUrl: confirmationUrl,
      pdfAttached: Boolean(confirmationPdf),
    }),
    emailAttachments: confirmationPdf,
    entity: 'Booking',
    entityId: booking.id,
  });

  /**
   * Die Meldung ans Büro entfällt bei einer Erfassung im Büro.
   *
   * „Neue Online-Buchung" an alle mit `booking:read` zu schicken, während eine
   * dieser Personen sie gerade selbst eingetippt hat, ist kein Hinweis,
   * sondern Lärm — und Lärm ist der Grund, warum Abzeichen und Meldungen nach
   * zwei Tagen ignoriert werden. Die Bestätigung an die Kundschaft geht
   * dagegen weiter hinaus: Sie hat die Buchung nicht selbst erfasst und
   * braucht den Beleg samt Verwaltungslink.
   */
  if (!office) {
    await notifyStaff({
      organizationId,
      title: 'Neue Online-Buchung',
      body: `${customerName} · ${service?.name ?? 'Reinigung'} · ${booking.number}`,
      link: `/admin/buchungen/${booking.id}`,
      permission: 'booking:read',
      emailContent: newBookingInternalEmail({
        bookingNumber: booking.number,
        customerName,
        serviceName: service?.name ?? 'Reinigung',
        scheduledStart: booking.scheduledStart,
        grossTotal: toNumber(booking.grossTotal),
        adminUrl: absoluteUrl(`/admin/buchungen/${booking.id}`),
      }),
    });
  }

  await audit.created({
    organizationId,
    userId: session?.id ?? null,
    entity: 'Booking',
    entityId: booking.id,
    summary: office
      ? `Buchung ${booking.number} im Büro erfasst (${office.source})` +
        (office.overrideCapacity ? ' — Kapazitätsprüfung übergangen' : '')
      : `Buchung ${booking.number} über die Website erstellt` +
        // Das Büro soll sehen, dass hier niemand angemeldet war und die
        // Zuordnung allein an der eingetippten E-Mail-Adresse hängt — bevor
        // es bestätigt, ist eine Rückfrage bei der Kundschaft angebracht.
        (offenlegen ? '' : ' — Gastbuchung auf eine bestehende Kundenakte, Identität nicht nachgewiesen'),
    ip: params.ip,
  });

  /**
   * Der Auslöser: **vermerkt** in der Transaktion der Buchung (oben),
   * **abgearbeitet** hier — nach allem, was fachlich zur Buchung gehört
   * (Outbox, 2026-09-27).
   *
   * Abgearbeitet wird nach dem Commit, weil die Maschine den Datensatz neu
   * lädt und ihn innerhalb der Transaktion nicht sähe, und weil eine Regel
   * die Buchung nicht scheitern lassen darf (`automationEreignisseAbarbeiten`
   * wirft nie). Vermerkt wird davor, damit ein Absturz dazwischen das
   * Ereignis nicht verliert — der stündliche Lauf holt es nach.
   */
  await automationEreignisseAbarbeiten({ organizationId });

  /**
   * Der Link geht an die anfragende Person nur, wenn sie die Akte sehen darf
   * (F-03, 2026-09-27).
   *
   * Der Verwaltungslink öffnet Name, E-Mail-Adresse und Einsatzort der
   * Kundschaft (`/buchung/…`, `/buchen/bestaetigt?t=…`). Vorher kam er in
   * jeder Antwort zurück — auch bei einer anonymen Buchung, die über die
   * eingetippte E-Mail-Adresse einer fremden Akte zugeordnet worden war. Wer
   * eine Adresse kannte, las so die Stammdaten dazu aus. Ausgestellt wird er
   * trotzdem: Er steht in der Bestätigung an die Adresse der Akte, und wer
   * dieses Postfach hat, ist die Kundschaft.
   *
   * Dass der Link fehlt, verrät, dass es zur Adresse eine Akte gibt. Das ist
   * hingenommen: Eine solche Probe kostet eine echte Buchung, läuft durch das
   * Buchungslimit und landet als Bestätigung im Postfach der Kundschaft —
   * sie bleibt nicht unbemerkt. Den Link auch neuen Gästen vorzuenthalten,
   * nähme allen die vollständige Bestätigungsseite, um eine Auskunft zu
   * verbergen, die die Registrierung für Adressen mit Konto ohnehin gibt
   * („Für diese E-Mail-Adresse besteht bereits ein Konto").
   */
  return {
    booking,
    confirmationUrl: offenlegen ? confirmationUrl : null,
    isNewCustomer: isNewCustomer && offenlegen,
  };
}

// ---------------------------------------------------------------------------
//  Mehrere Leistungen (Produktsprint 2026-09-26)
// ---------------------------------------------------------------------------

/**
 * Die Leistungen einer Buchungseingabe — aus der neuen Liste oder aus der
 * alten Einzelform.
 *
 * Die Einzelform (`serviceId` plus Angaben auf oberster Ebene) bleibt gültig:
 * Offertformular, Büroerfassung und ältere Aufrufer schicken sie, und sie ist
 * nichts anderes als eine Liste mit einem Eintrag. Fläche, Zimmer, Bäder und
 * Fenster auf oberster Ebene beschreiben das Objekt; eine Leistung ohne eigene
 * Angabe übernimmt sie von dort.
 */
export function leistungenAusEingabe(input: BookingCoreInput): LeistungInput[] {
  if (input.leistungen?.length) {
    return input.leistungen.map((l) => ({
      serviceId: l.serviceId,
      squareMeters: l.squareMeters ?? input.squareMeters ?? null,
      rooms: l.rooms ?? input.rooms ?? null,
      bathrooms: l.bathrooms ?? input.bathrooms ?? null,
      windows: l.windows ?? input.windows ?? null,
      manualHours: l.manualHours ?? null,
      extras: l.extras,
    }));
  }
  if (!input.serviceId) throw new BusinessRuleError('Bitte wählen Sie mindestens eine Dienstleistung.');
  return [
    {
      serviceId: input.serviceId,
      squareMeters: input.squareMeters ?? null,
      rooms: input.rooms ?? null,
      bathrooms: input.bathrooms ?? null,
      windows: input.windows ?? null,
      manualHours: input.manualHours ?? null,
      extras: input.extras,
    },
  ];
}

/** Objektangabe der Buchung: die ausdrückliche, sonst die grösste der Leistungen. */
function objektwert(oben: number | null | undefined, jeLeistung: (number | null | undefined)[]): number | null {
  if (oben !== null && oben !== undefined) return oben;
  const werte = jeLeistung.filter((w): w is number => typeof w === 'number');
  return werte.length ? Math.max(...werte) : null;
}

/**
 * Buchungspositionen aus der Herleitung der Preis-Engine.
 *
 * Eine Position je Grundzeile, wie bisher — mit der Leistung, zu der die
 * Zeile gehört (`meta.serviceId`), statt immer der einen `input.serviceId`.
 * Die erste Zeile einer Leistung trägt deren Dauer und ihre Angaben
 * (`details`); so bleibt für Disposition, Einsatz und Rechnung ablesbar,
 * welche Leistung wie lange dauert und womit sie gebucht wurde.
 */
export function positionenAusHerleitung(breakdown: PriceBreakdown, leistungen: LeistungInput[]) {
  const gesehen = new Set<string>();
  return breakdown.lines
    .filter((line) => line.kind === 'base')
    .map((line, index) => {
      const serviceId = (line.meta?.serviceId as string | undefined) ?? breakdown.service.id;
      const erste = !gesehen.has(serviceId);
      gesehen.add(serviceId);
      const position = breakdown.positionen.find((p) => p.serviceId === serviceId);
      const eingabe = leistungen.find((l) => l.serviceId === serviceId);
      return {
        serviceId,
        name: line.label,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
        vatRate: breakdown.vatRate,
        lineTotal: line.amount,
        durationMin: erste ? (position?.durationMinutes ?? 0) : 0,
        position: index,
        ...(erste && eingabe ? { details: eingabe as unknown as Prisma.InputJsonValue } : {}),
      };
    });
}

/**
 * Zusatzleistungen der Buchung — je Zusatzleistung eine Zeile.
 *
 * Wählen zwei Leistungen dieselbe Zusatzleistung, wird sie zusammengezählt:
 * `@@unique([bookingId, extraId])` erlaubt nur eine Zeile, und fachlich ist
 * es eine Menge. Es entstehen nur Zeilen für Zusatzleistungen, die die Engine
 * gefunden und bepreist hat — eine unbekannte ID aus dem Browser erzeugte
 * früher eine Zeile zum Preis null.
 */
export function zusatzleistungenAusHerleitung(breakdown: PriceBreakdown) {
  const karte = new Map<string, { extraId: string; name: string; quantity: number; unitPrice: number; lineTotal: number }>();
  for (const line of breakdown.lines) {
    if (line.kind !== 'extra') continue;
    const extraId = line.meta?.extraId as string | undefined;
    if (!extraId) continue;
    const bestehend = karte.get(extraId);
    if (bestehend) {
      bestehend.quantity += line.quantity;
      bestehend.lineTotal = summeZahl(bestehend.lineTotal, line.amount);
    } else {
      karte.set(extraId, { extraId, name: line.label, quantity: line.quantity, unitPrice: line.unitPrice, lineTotal: line.amount });
    }
  }
  return [...karte.values()];
}

// ---------------------------------------------------------------------------
//  Statusübergänge
// ---------------------------------------------------------------------------

export async function confirmBooking(params: {
  organizationId: string;
  bookingId: string;
  actorId?: string | null;
}): Promise<Booking> {
  const booking = await prisma.booking.findFirst({
    where: { id: params.bookingId, organizationId: params.organizationId, deletedAt: null },
    include: {
      customer: { include: { user: { select: { id: true } } } },
      address: true,
      items: { include: { service: { select: { id: true, name: true } } } },
    },
  });
  if (!booking) throw new NotFoundError('Buchung');

  if (booking.status === 'CONFIRMED') return booking;
  if (['CANCELLED', 'COMPLETED'].includes(booking.status)) {
    throw new BusinessRuleError('Diese Buchung kann nicht mehr bestätigt werden.');
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.booking.update({
      where: { id: booking.id },
      data: { status: 'CONFIRMED', confirmedAt: new Date() },
    });

    // Einsatz (Job) für die Disposition anlegen.
    await createJobsForBooking(tx, booking.id);

    await automationEreignisVormerken(tx, { organizationId: params.organizationId, trigger: 'BOOKING_CONFIRMED', entityId: booking.id });
    return result;
  });

  const serviceName = leistungsnamen(booking.items);
  const addressLabel = await formatBookingAddress(booking.addressId);
  // Nach dem Statuswechsel rendern — das Dokument soll „Terminbestätigung"
  // heissen, nicht „Buchungsbestätigung (wird geprüft)".
  const confirmationPdf = await bookingPdfAttachment(booking.id);

  await notify({
    userId: booking.customer.user?.id ?? null,
    email: booking.customer.email,
    phone: booking.customer.mobile ?? booking.customer.phone,
    channels: ['IN_APP', 'EMAIL', 'SMS'],
    title: 'Termin bestätigt',
    body: `Ihr Termin am ${formatDate(booking.scheduledStart)} ist bestätigt.`,
    link: `/konto/buchungen/${booking.id}`,
    emailAttachments: confirmationPdf,
    emailContent: bookingConfirmedEmail({
      pdfAttached: Boolean(confirmationPdf),
      firstName: booking.customer.firstName,
      bookingNumber: booking.number,
      serviceName,
      scheduledStart: booking.scheduledStart,
      scheduledEnd: booking.scheduledEnd,
      address: addressLabel,
      grossTotal: toNumber(booking.grossTotal),
      manageUrl: absoluteUrl(`/konto/buchungen/${booking.id}`),
    }),
    smsBody: smsTemplates.bookingConfirmed({
      date: formatDate(booking.scheduledStart),
      time: booking.scheduledStart.toLocaleTimeString('de-CH', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Zurich',
      }),
      company: 'Clenaris',
    }),
    entity: 'Booking',
    entityId: booking.id,
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Booking',
    entityId: booking.id,
    summary: `Buchung ${booking.number} bestätigt`,
  });

  await automationEreignisseAbarbeiten({ organizationId: params.organizationId });

  return updated;
}

export async function cancelBooking(params: {
  organizationId: string;
  bookingId: string;
  reason: string;
  actorId?: string | null;
  /** true = Storno durch das Büro, Frist wird nicht geprüft. */
  byStaff?: boolean;
}): Promise<Booking> {
  const booking = await prisma.booking.findFirst({
    where: { id: params.bookingId, organizationId: params.organizationId, deletedAt: null },
    include: { customer: { include: { user: { select: { id: true } } } }, items: true },
  });
  if (!booking) throw new NotFoundError('Buchung');

  if (booking.status === 'CANCELLED') return booking;
  if (booking.status === 'COMPLETED') {
    throw new BusinessRuleError('Ein abgeschlossener Einsatz kann nicht storniert werden.');
  }

  const hoursUntilStart = (booking.scheduledStart.getTime() - Date.now()) / 3_600_000;
  if (!params.byStaff && hoursUntilStart < CANCELLATION_WINDOW_HOURS) {
    throw new BusinessRuleError(
      `Eine kostenlose Stornierung ist bis ${CANCELLATION_WINDOW_HOURS} Stunden vor dem Termin möglich. Bitte kontaktieren Sie uns telefonisch.`,
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.booking.update({
      where: { id: booking.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: params.reason },
    });

    // Zugehörige Einsätze absagen.
    await tx.job.updateMany({
      where: { bookingId: booking.id, status: { notIn: ['COMPLETED', 'VERIFIED'] } },
      data: { status: 'CANCELLED' },
    });

    await tx.customer.update({
      where: { id: booking.customerId },
      data: { totalBookings: { decrement: 1 } },
    });

    /**
     * Verwaltungslinks mit dem Storno entwerten (N-04, 2026-09-27).
     *
     * Bis hierher lebte ein Buchungslink bis zu seinem Ablauf — 90 Tage nach
     * dem Termin, auch für eine längst stornierte Buchung. Er zeigt Name,
     * E-Mail-Adresse und Einsatzort; nach dem Storno braucht ihn niemand mehr
     * zum Verwalten, und jeder weitergeleitete oder mitgelesene Link bliebe
     * ein offener Zugang zu diesen Daten. Offerten und Rechnungen verfahren
     * genauso (`revokeTokensFor` vor dem Neuversand). In derselben
     * Transaktion wie der Statuswechsel: Ein Storno, dessen Widerruf
     * scheitert, soll nicht als erledigt dastehen. Die Stornobestätigung per
     * E-Mail unten trägt keinen Verwaltungslink, es entsteht also kein neuer.
     */
    await revokeTokensFor({
      tx,
      purpose: 'BOOKING_MANAGE',
      resourceId: booking.id,
      revokedById: params.actorId ?? null,
    });

    await automationEreignisVormerken(tx, { organizationId: params.organizationId, trigger: 'BOOKING_CANCELLED', entityId: booking.id });
    return result;
  });

  await invalidateAvailability(params.organizationId, booking.scheduledStart);

  await notify({
    userId: booking.customer.user?.id ?? null,
    email: booking.customer.email,
    channels: ['IN_APP', 'EMAIL'],
    title: 'Buchung storniert',
    body: `Ihre Buchung ${booking.number} wurde storniert.`,
    emailContent: bookingCancelledEmail({
      firstName: booking.customer.firstName,
      bookingNumber: booking.number,
      serviceName: leistungsnamen(booking.items),
      scheduledStart: booking.scheduledStart,
      reason: params.reason,
    }),
    entity: 'Booking',
    entityId: booking.id,
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Booking',
    entityId: booking.id,
    summary: `Buchung ${booking.number} storniert: ${params.reason}`,
  });

  await automationEreignisseAbarbeiten({ organizationId: params.organizationId });

  return updated;
}

export async function rescheduleBooking(params: {
  organizationId: string;
  bookingId: string;
  newStart: Date;
  actorId?: string | null;
  byStaff?: boolean;
}): Promise<Booking> {
  const booking = await prisma.booking.findFirst({
    where: { id: params.bookingId, organizationId: params.organizationId, deletedAt: null },
    include: { customer: { include: { user: { select: { id: true } } } }, items: true },
  });
  if (!booking) throw new NotFoundError('Buchung');

  if (['CANCELLED', 'COMPLETED', 'IN_PROGRESS', 'NO_SHOW'].includes(booking.status)) {
    throw new BusinessRuleError('Diese Buchung kann nicht mehr verschoben werden.');
  }

  const hoursUntilStart = (booking.scheduledStart.getTime() - Date.now()) / 3_600_000;
  if (!params.byStaff && hoursUntilStart < CANCELLATION_WINDOW_HOURS) {
    throw new BusinessRuleError(
      `Eine Umbuchung ist bis ${CANCELLATION_WINDOW_HOURS} Stunden vor dem Termin möglich. Bitte kontaktieren Sie uns telefonisch.`,
    );
  }

  const newEnd = new Date(params.newStart.getTime() + booking.durationMin * 60_000);

  const updated = await prisma.$transaction(async (tx) => {
    /**
     * Dieselbe Sperre und dieselbe Prüfung wie beim Anlegen (siehe
     * `createBooking`). `ohneBuchungId`: Die Buchung selbst und ihr Einsatz
     * belegen den alten Termin — beim Verschieben um eine halbe Stunde zählte
     * sie sonst gegen sich selbst, und ein voller Tag liess sich nicht einmal
     * innerhalb seiner eigenen Belegung umstellen.
     */
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`buchung:${params.organizationId}`}))`;
    /*
      Puffer und Qualifikationen der Leistungen gehören zur Prüfung wie beim
      Anlegen. Bis 2026-09-27 fehlten beide: Die Umbuchung prüfte ohne
      Puffer, und ein Termin direkt hinter einem anderen Einsatz ging durch,
      den die Buchung selbst nie angeboten hätte.
    */
    const bedarf = await leistungsbedarf(tx, params.organizationId, booking.items.map((i) => i.serviceId));
    const check = await isSlotBookable({
      organizationId: params.organizationId,
      start: params.newStart,
      durationMin: booking.durationMin,
      crewSize: booking.crewSize,
      bufferMin: bedarf.pufferMin,
      qualifikationen: bedarf.qualifikationen,
      kanal: params.byStaff ? 'buero' : 'oeffentlich',
      ohneBuchungId: booking.id,
      db: tx,
    });
    if (!check.ok) throw new BusinessRuleError(check.reason!);

    const result = await tx.booking.update({
      where: { id: booking.id },
      data: {
        scheduledStart: params.newStart,
        scheduledEnd: newEnd,
        rescheduledFrom: booking.scheduledStart,
        reminder24hSentAt: null,
        reminder2hSentAt: null,
      },
    });

    await einsaetzeNachfuehren(tx, {
      organizationId: params.organizationId,
      bookingId: booking.id,
      daten: { scheduledStart: params.newStart, scheduledEnd: newEnd },
      zuteilungPruefen: true,
      zeitOderOrt: true,
    });

    return result;
  });

  await Promise.all([
    invalidateAvailability(params.organizationId, booking.scheduledStart),
    invalidateAvailability(params.organizationId, params.newStart),
  ]);

  await notify({
    userId: booking.customer.user?.id ?? null,
    email: booking.customer.email,
    channels: ['IN_APP', 'EMAIL'],
    title: 'Termin verschoben',
    body: `Ihr Termin wurde auf den ${formatDate(params.newStart)} verschoben.`,
    link: `/konto/buchungen/${booking.id}`,
    emailContent: bookingRescheduledEmail({
      firstName: booking.customer.firstName,
      bookingNumber: booking.number,
      serviceName: leistungsnamen(booking.items),
      scheduledStart: params.newStart,
      scheduledEnd: newEnd,
      address: await formatBookingAddress(booking.addressId),
      grossTotal: toNumber(booking.grossTotal),
      manageUrl: absoluteUrl(`/konto/buchungen/${booking.id}`),
    }),
    entity: 'Booking',
    entityId: booking.id,
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Booking',
    entityId: booking.id,
    summary: `Buchung ${booking.number} verschoben`,
    changes: { scheduledStart: { from: booking.scheduledStart, to: params.newStart } },
  });

  return updated;
}

/**
 * Einsatzstatus, in denen ein Einsatz der Buchung noch folgt.
 *
 * Bis 2026-09-27 folgten alle nicht abgeschlossenen — auch `EN_ROUTE` und
 * `IN_PROGRESS`. Eine Umbuchung auf morgen, während das Team schon vor der
 * Tür steht, verschob dessen laufenden Einsatz mit: Zeiterfassung und
 * Rapport hingen danach an einem Termin, der noch nicht war. Was begonnen
 * hat, ist Geschehen und wird nicht umgeplant; die Buchung selbst lässt
 * sich dann nicht mehr verschieben.
 */
const EINSATZ_FOLGT = ['UNASSIGNED', 'SCHEDULED', 'DISPATCHED'] as const;
const EINSATZ_ABGESCHLOSSEN = ['COMPLETED', 'VERIFIED', 'CANCELLED'] as const;

/**
 * Die offenen Einsätze einer Buchung nachführen — eine Stelle für
 * Verschieben und Bearbeiten (2026-09-27).
 *
 * Vorher führte jede der beiden Funktionen die Einsätze mit einem eigenen
 * `updateMany` nach, und beide vergassen dasselbe: Die eingeteilten Personen
 * wurden am neuen Termin nicht geprüft. Wer um 14 Uhr frei war, war es um
 * 9 Uhr vielleicht nicht — Ferien, ein anderer Einsatz, eine abgelaufene
 * Qualifikation —, und die Umbuchung setzte ihn trotzdem dort ein. Jetzt
 * läuft für jeden besetzten Einsatz dieselbe Prüfung wie bei der Zuteilung
 * (`assertAssignable`), in derselben Transaktion; scheitert sie, scheitert
 * die Änderung mit der Begründung, und die Disposition entscheidet.
 *
 * Ein Einsatz, der schon begonnen hat, wird nicht angefasst — und wenn die
 * Änderung ihn beträfe (Termin, Adresse), wird sie abgewiesen, statt ihn
 * stillschweigend zurückzulassen.
 */
async function einsaetzeNachfuehren(
  tx: Tx,
  params: {
    organizationId: string;
    bookingId: string;
    daten: Prisma.JobUncheckedUpdateInput;
    /** Termin, Team oder Qualifikationen geändert — dann Personen neu prüfen. */
    zuteilungPruefen: boolean;
    /**
     * Betrifft die Änderung Zeit oder Ort? Dann darf kein Einsatz begonnen
     * haben. Eine blosse Notiz dagegen erreicht die begonnenen nicht und
     * hält die übrigen nicht auf.
     */
    zeitOderOrt: boolean;
  },
): Promise<void> {
  /*
    Die Einsatzzeilen sperren, bevor sie gelesen und geprüft werden
    (2026-09-27, F-06). Dieselbe Sperre wie `einsatzSperren` in
    `job.service.ts`: Ohne sie prüfte eine Terminänderung über die Buchung das
    alte Team, während gleichzeitig ein Teamwechsel am Einsatz die neuen
    Personen zur alten Zeit prüfte — beide gingen durch, und das Ergebnis war
    ein nie geprüftes Paar aus neuem Team und neuer Zeit. Nach Kennung
    sortiert, damit zwei Wege die Sperren in derselben Reihenfolge nehmen.
  */
  await tx.$queryRaw`SELECT id FROM jobs WHERE "bookingId" = ${params.bookingId} AND "organizationId" = ${params.organizationId} AND "deletedAt" IS NULL ORDER BY id FOR UPDATE`;
  const einsaetze = await tx.job.findMany({
    where: { bookingId: params.bookingId, deletedAt: null, status: { notIn: [...EINSATZ_ABGESCHLOSSEN] } },
    select: {
      id: true,
      number: true,
      status: true,
      scheduledStart: true,
      scheduledEnd: true,
      requiredSkills: true,
      assignments: { select: { employeeId: true } },
    },
  });
  if (einsaetze.length === 0) return;

  const folgt = (e: { status: string }) => (EINSATZ_FOLGT as readonly string[]).includes(e.status);
  const begonnen = einsaetze.filter((e) => !folgt(e));
  if (begonnen.length > 0 && params.zeitOderOrt) {
    throw new BusinessRuleError(
      `Der Einsatz ${begonnen.map((e) => e.number).join(', ')} hat bereits begonnen; Termin und Einsatzort lassen sich deshalb nicht mehr ändern. ` +
        'Schliessen Sie ihn ab oder brechen Sie ihn in der Disposition ab.',
    );
  }

  for (const einsatz of einsaetze.filter(folgt)) {
    const neu = await tx.job.update({ where: { id: einsatz.id }, data: params.daten });
    if (params.zuteilungPruefen && einsatz.assignments.length > 0) {
      await assertAssignable(tx, {
        organizationId: params.organizationId,
        employeeIds: einsatz.assignments.map((a) => a.employeeId),
        scheduledStart: neu.scheduledStart,
        scheduledEnd: neu.scheduledEnd,
        ignoreJobId: einsatz.id,
        requiredSkills: neu.requiredSkills,
      });
    }
  }
}

/**
 * Preisfelder — sie tragen eine kaufmännische, keine betriebliche Entscheidung.
 *
 * Die Betriebsleitung (MANAGER) führt das Tagesgeschäft und darf jeden Auftrag
 * umplanen, umbuchen und ergänzen. Was der Auftrag *kostet*, bleibt der
 * Verwaltung vorbehalten — dieselbe Trennlinie, die im Katalog zwischen
 * `pricing:read` und `pricing:update` verläuft. Ein Rabatt auf einen einzelnen
 * Auftrag ist nichts anderes als eine Preisentscheidung mit kleinerem
 * Geltungsbereich.
 */
const PRICE_FIELDS = ['items', 'extras', 'travelFee', 'discountAmount', 'vatRate'] as const;

/** Feldweise Berechtigungen für die Auftragsbearbeitung. */
function assertFieldPermissions(input: UpdateBookingInput, role: ActorRole): void {
  const touchesPrice = PRICE_FIELDS.some((field) => input[field] !== undefined);
  if (touchesPrice && !can(role, 'pricing:update')) {
    throw new ForbiddenError(
      'Positionen und Preise eines Auftrags ändert die Verwaltung. Termin, Team, Adresse und Notizen können Sie bearbeiten.',
    );
  }

  // Einen Auftrag einer anderen Kundschaft zuordnen heisst, einen Kundendatensatz
  // zu verändern — wer das nicht darf, darf es auch nicht auf diesem Umweg.
  if (input.customerId !== undefined && !can(role, 'customer:update')) {
    throw new ForbiddenError('Für den Wechsel der Kundschaft fehlt die Berechtigung.');
  }
}

/**
 * Auftrag bearbeiten.
 *
 * Architekturentscheide:
 *
 *  1. **Statuswechsel laufen durch dieselben Wege wie die Schaltflächen.**
 *     `CONFIRMED` erzeugt die Einsätze, `CANCELLED` sagt sie ab und
 *     benachrichtigt die Kundschaft. Würde die Maske den Status einfach
 *     schreiben, entstünde eine bestätigte Buchung ohne Einsatz — genau das
 *     Dispositionsloch, das `confirmBooking` verhindert.
 *
 *  2. **Preise werden nachgerechnet, nicht übernommen.** Die Maske schickt
 *     Positionen und Zuschläge; Zwischentotal, MWST und Gesamtbetrag entstehen
 *     hier. Eine Oberfläche, die Totale mitliefert, ist eine Oberfläche, die
 *     sie fälschen kann.
 *
 *  3. **Jede Änderung hinterlässt eine Spur.** Neben dem Prüfprotokoll wird
 *     eine Aktivität am Auftrag angelegt: Das Protokoll liest die
 *     Systemverantwortung, die Aktivität liest das Büro beim nächsten Anruf
 *     der Kundschaft.
 */
export async function updateBooking(params: {
  organizationId: string;
  bookingId: string;
  input: UpdateBookingInput;
  actorId: string;
  actorRole: ActorRole;
}): Promise<Booking> {
  const booking = await prisma.booking.findFirst({
    where: { id: params.bookingId, organizationId: params.organizationId, deletedAt: null },
    include: { items: true, extras: true },
  });
  if (!booking) throw new NotFoundError('Buchung');

  const { input } = params;
  assertFieldPermissions(input, params.actorRole);

  /**
   * Was an einer erledigten Buchung noch geändert werden darf (2026-09-27).
   *
   * Bis hierher nahm die Maske jede Änderung an, auch an einer stornierten
   * oder abgeschlossenen Buchung: Termin, Adresse, Kundschaft, Status. Eine
   * abgeschlossene Buchung, deren Termin nachträglich verschoben wird,
   * erzählt danach eine andere Geschichte als ihr Rapport und ihre
   * Zeiterfassung; eine stornierte liess sich per Statusfeld wieder auf
   * „offen" stellen, ohne dass ihre abgesagten Einsätze zurückkamen.
   *
   * Notizen, Objektangaben und — mit Preisrecht — Positionen bleiben
   * änderbar: Eine Korrektur vor der Rechnung ist ein normaler Vorgang.
   */
  const erledigt = ['CANCELLED', 'COMPLETED', 'NO_SHOW'].includes(booking.status);
  if (erledigt) {
    const gesperrt = (
      [
        ['scheduledStart', 'Termin'],
        ['durationMin', 'Dauer'],
        ['crewSize', 'Teamgrösse'],
        ['addressId', 'Adresse'],
        ['address', 'Adresse'],
        ['propertyId', 'Objekt'],
        ['customerId', 'Kundschaft'],
        ['frequency', 'Rhythmus'],
      ] as const
    ).filter(([feld]) => {
      const wert = input[feld];
      if (wert === undefined) return false;
      if (feld === 'scheduledStart') return (wert as Date).getTime() !== booking.scheduledStart.getTime();
      if (feld === 'address') return true;
      return String(wert ?? '') !== String((booking as Record<string, unknown>)[feld] ?? '');
    });
    const statusWechsel = input.status !== undefined && input.status !== booking.status;
    if (gesperrt.length > 0 || statusWechsel) {
      const was = [...new Set(gesperrt.map(([, name]) => name)), ...(statusWechsel ? ['Status'] : [])];
      throw new BusinessRuleError(
        `Diese Buchung ist ${booking.status === 'CANCELLED' ? 'storniert' : 'erledigt'}; ${was.join(', ')} lassen sich nicht mehr ändern. ` +
          'Für einen neuen Termin legen Sie eine neue Buchung an.',
      );
    }
  }

  /**
   * Statuswechsel mit Nebenwirkungen: erst prüfen, **nach** allem anderen
   * ausführen (2026-09-27).
   *
   * Vorher lief Storno bzw. Bestätigung als Erstes — mit eigener Transaktion,
   * eigener Mitteilung an die Kundschaft und eigenem Prüfprotokoll. Scheiterte
   * danach die übrige Änderung (Kapazität, fremde Adresse, fehlende
   * Berechtigung), antwortete die Maske mit einem Fehler, die Kundschaft hatte
   * aber schon die Stornomitteilung. Jetzt werden die Voraussetzungen vorab
   * geprüft, die Felder in einer Transaktion geschrieben, und erst danach
   * folgt der Wechsel — auf die dann schon aktualisierte Buchung, sodass eine
   * Bestätigung die Einsätze mit dem neuen Termin anlegt.
   */
  const statusWechsel = input.status && input.status !== booking.status ? input.status : null;
  if (statusWechsel === 'CANCELLED' && (!input.changeReason || input.changeReason.trim().length < 3)) {
    throw new BusinessRuleError('Bitte begründen Sie den Storno — die Begründung geht an die Kundschaft.');
  }

  const data: Prisma.BookingUpdateInput = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  const track = (field: string, from: unknown, to: unknown) => {
    if (String(from ?? '') !== String(to ?? '')) changes[field] = { from, to };
  };

  // --- Einfache Felder -------------------------------------------------------
  if (input.status && !['CANCELLED', 'CONFIRMED'].includes(input.status)) {
    track('status', booking.status, input.status);
    data.status = input.status;
    // Abgeschlossen ohne Zeitstempel wäre in jeder Auswertung ein Loch.
    if (input.status === 'COMPLETED' && !booking.completedAt) data.completedAt = new Date();
  }

  if (input.crewSize !== undefined) {
    track('crewSize', booking.crewSize, input.crewSize);
    data.crewSize = input.crewSize;
  }
  if (input.internalNote !== undefined) {
    track('internalNote', booking.internalNote, input.internalNote);
    data.internalNote = input.internalNote ?? null;
  }
  if (input.customerNote !== undefined) {
    track('customerNote', booking.customerNote, input.customerNote);
    data.customerNote = input.customerNote ?? null;
  }
  if (input.accessNote !== undefined) {
    track('accessNote', booking.accessNote, input.accessNote);
    data.accessNote = input.accessNote ?? null;
  }
  if (input.propertyKind !== undefined) {
    track('propertyKind', booking.propertyKind, input.propertyKind);
    data.propertyKind = input.propertyKind;
  }
  if (input.squareMeters !== undefined) {
    track('squareMeters', booking.squareMeters, input.squareMeters);
    data.squareMeters = input.squareMeters ?? null;
  }
  if (input.rooms !== undefined) {
    track('rooms', toNumber(booking.rooms), input.rooms);
    data.rooms = input.rooms ?? null;
  }
  if (input.windows !== undefined) {
    track('windows', booking.windows, input.windows);
    data.windows = input.windows ?? null;
  }
  if (input.frequency !== undefined) {
    track('frequency', booking.frequency, input.frequency);
    data.frequency = input.frequency;
  }

  // --- Kundschaft, Adresse, Objekt ------------------------------------------
  if (input.customerId && input.customerId !== booking.customerId) {
    const target = await prisma.customer.findFirst({
      where: { id: input.customerId, organizationId: params.organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!target) throw new NotFoundError('Kunde');
    track('customerId', booking.customerId, input.customerId);
    data.customer = { connect: { id: input.customerId } };
  }

  const customerIdAfter = input.customerId ?? booking.customerId;

  if (input.addressId && input.addressId !== booking.addressId) {
    // Eine Adresse eines *anderen* Kunden anzuhängen wäre ein Datenleck über
    // die Auftragsansicht — deshalb hier und nicht erst im Formular geprüft.
    const address = await prisma.address.findFirst({
      where: { id: input.addressId, customerId: customerIdAfter },
      select: { id: true },
    });
    if (!address) throw new NotFoundError('Adresse');
    track('addressId', booking.addressId, input.addressId);
    data.address = { connect: { id: input.addressId } };
  }
  /*
    Eine neu erfasste Adresse entsteht in der Transaktion unten, nicht hier
    (2026-09-27). Vorher wurde sie vor allen weiteren Prüfungen angelegt;
    scheiterte danach die Kapazität oder ein fremder Objektbezug, blieb eine
    Adresse ohne Auftrag in der Akte der Kundschaft zurück — bei jedem
    erneuten Versuch eine weitere.
  */
  const neueAdresse = !input.addressId || input.addressId === booking.addressId ? input.address : undefined;

  if (input.propertyId !== undefined) {
    // Dieselbe Regel wie für die Adresse zwei Absätze weiter oben — und bis
    // 2026-09-27 fehlte sie hier: Ein fremdes Objekt (samt Schlüsselort und
    // Zugangsnotiz) liess sich an einen Auftrag hängen.
    if (input.propertyId && input.propertyId !== booking.propertyId) {
      const objekt = await prisma.property.findFirst({
        where: { id: input.propertyId, customerId: customerIdAfter, customer: { organizationId: params.organizationId } },
        select: { id: true },
      });
      if (!objekt) throw new NotFoundError('Objekt');
    }
    track('propertyId', booking.propertyId, input.propertyId);
    data.property = input.propertyId
      ? { connect: { id: input.propertyId } }
      : { disconnect: true };
  }

  // --- Termin ---------------------------------------------------------------
  if (input.scheduledStart || input.durationMin) {
    const start = input.scheduledStart ?? booking.scheduledStart;
    const duration = input.durationMin ?? booking.durationMin;
    track('scheduledStart', booking.scheduledStart, start);
    track('durationMin', booking.durationMin, duration);
    data.scheduledStart = start;
    data.durationMin = duration;
    data.scheduledEnd = new Date(start.getTime() + duration * 60_000);
    // Der Erinnerungsversand hängt am Termin — nach einer Verschiebung muss er
    // erneut greifen, sonst erinnert niemand an den neuen Zeitpunkt.
    if (input.scheduledStart) {
      data.rescheduledFrom = booking.scheduledStart;
      data.reminder24hSentAt = null;
      data.reminder2hSentAt = null;
    }
  }

  // --- Positionen, Zuschläge, Totale ----------------------------------------
  /**
   * Katalogbezüge gegen die eigene Organisation prüfen.
   *
   * Die IDs kommen aus dem Formular und damit vom Client. Ohne diese Prüfung
   * liesse sich über eine fremde `serviceId` eine Leistung an den Auftrag
   * hängen, die im eigenen Katalog gar nicht existiert — und der `Restrict`-
   * Fremdschlüssel würde das erst als 500 melden, nicht als Fehleingabe.
   */
  if (input.items) {
    await assertCatalogOwnership(
      params.organizationId,
      'service',
      input.items.map((item) => item.serviceId),
    );
  }
  if (input.extras && input.extras.length > 0) {
    await assertCatalogOwnership(
      params.organizationId,
      'serviceExtra',
      input.extras.map((extra) => extra.extraId),
    );
  }

  const pricing = recalculateBookingTotals({
    items: input.items ?? booking.items.map(bookingItemToInput),
    extras: input.extras ?? booking.extras.map(bookingExtraToInput),
    travelFee: input.travelFee ?? toNumber(booking.travelFee),
    discountAmount: input.discountAmount ?? toNumber(booking.discountAmount),
    vatRate: input.vatRate ?? toNumber(booking.vatRate),
  });

  const touchesPricing = PRICE_FIELDS.some((field) => input[field] !== undefined);
  if (touchesPricing) {
    track('grossTotal', toNumber(booking.grossTotal), pricing.grossTotal);
    Object.assign(data, {
      subtotal: pricing.subtotal,
      extrasTotal: pricing.extrasTotal,
      travelFee: pricing.travelFee,
      discountAmount: pricing.discountAmount,
      netTotal: pricing.netTotal,
      vatRate: pricing.vatRate,
      vatAmount: pricing.vatAmount,
      grossTotal: pricing.grossTotal,
      /**
       * Die Herleitung der Preis-Engine gilt nach einer Bearbeitung von Hand
       * nicht mehr. Sie stehen zu lassen wäre schlimmer als sie zu ersetzen:
       * Die Detailansicht zeigt sie als „so kam der Preis zustande", und das
       * wäre dann nachweislich falsch.
       */
      priceBreakdown: {
        lines: pricing.lines,
        manual: true,
        editedAt: new Date().toISOString(),
      } as unknown as Prisma.InputJsonValue,
    });
  }

  /**
   * Termin, Dauer, Team oder Leistungen geändert? Dann dieselbe Prüfung wie
   * beim Anlegen (Befund A3, 2026-09-26).
   *
   * Vorher schrieb die Bearbeitungsmaske einen neuen Termin oder eine längere
   * Dauer ohne jede Verfügbarkeitsprüfung — ein Einsatz liess sich auf
   * 21:00–01:00 in ein Fenster bis 22:00 schieben oder auf einen Termin, an
   * dem niemand frei ist. Geprüft wird nur, was noch Kapazität bindet
   * (Entwurf, offen, bestätigt); die eigene Belegung zählt nicht mit. Das Büro
   * ist wie beim Anlegen an Vorlauf und Horizont nicht gebunden und kann die
   * Kapazitätsprüfung ausdrücklich übergehen — das steht dann im Protokoll.
   */
  // Nach dem Wechsel gemeint — ein Storno bindet keine Kapazität mehr, eine
  // Bestätigung schon (bis 2026-09-27 zählte hier der alte Status).
  const statusDanach = input.status ?? booking.status;
  const verfuegbarkeitBetroffen =
    Boolean(data.scheduledStart || data.durationMin || data.crewSize || input.items) &&
    ['DRAFT', 'PENDING', 'CONFIRMED'].includes(statusDanach);
  const bedarf = await leistungsbedarf(
    prisma,
    params.organizationId,
    (input.items ?? booking.items).map((i) => i.serviceId),
  );

  if (statusWechsel === 'CONFIRMED' && ['CANCELLED', 'COMPLETED'].includes(booking.status)) {
    throw new BusinessRuleError('Diese Buchung kann nicht mehr bestätigt werden.');
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (neueAdresse) {
      const created = await tx.address.create({
        data: {
          customerId: customerIdAfter,
          label: neueAdresse.label ?? 'Einsatzadresse',
          street: neueAdresse.street,
          streetNo: neueAdresse.streetNo ?? null,
          addition: neueAdresse.addition ?? null,
          postalCode: neueAdresse.postalCode,
          city: neueAdresse.city,
          canton: neueAdresse.canton,
          country: neueAdresse.country,
          lat: neueAdresse.lat ?? null,
          lng: neueAdresse.lng ?? null,
          placeId: neueAdresse.placeId ?? null,
        },
      });
      track('addressId', booking.addressId, created.id);
      data.address = { connect: { id: created.id } };
    }

    if (verfuegbarkeitBetroffen && !input.overrideCapacity) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`buchung:${params.organizationId}`}))`;
      const start = (data.scheduledStart as Date | undefined) ?? booking.scheduledStart;
      const pruefung = await isSlotBookable({
        organizationId: params.organizationId,
        start,
        durationMin: (data.durationMin as number | undefined) ?? booking.durationMin,
        crewSize: (data.crewSize as number | undefined) ?? booking.crewSize,
        bufferMin: bedarf.pufferMin,
        qualifikationen: bedarf.qualifikationen,
        kanal: 'buero',
        ohneBuchungId: booking.id,
        db: tx,
      });
      if (!pruefung.ok) {
        throw new BusinessRuleError(
          `${pruefung.reason} Wer den Termin trotzdem so setzen will, übergeht die Kapazitätsprüfung ausdrücklich.`,
        );
      }
    }

    if (input.items) {
      await tx.bookingItem.deleteMany({ where: { bookingId: booking.id } });
      await tx.bookingItem.createMany({
        data: input.items.map((item, index) => ({
          bookingId: booking.id,
          serviceId: item.serviceId,
          name: item.name,
          description: item.description ?? null,
          quantity: item.quantity,
          unit: item.unit,
          unitPrice: item.unitPrice,
          vatRate: pricing.vatRate,
          lineTotal: produkt(item.quantity, item.unitPrice),
          durationMin: item.durationMin,
          position: index,
        })),
      });
    }

    if (input.extras) {
      await tx.bookingExtra.deleteMany({ where: { bookingId: booking.id } });
      if (input.extras.length > 0) {
        await tx.bookingExtra.createMany({
          data: input.extras.map((extra) => ({
            bookingId: booking.id,
            extraId: extra.extraId,
            name: extra.name,
            quantity: extra.quantity,
            unitPrice: extra.unitPrice,
            lineTotal: produkt(extra.quantity, extra.unitPrice),
          })),
        });
      }
    }

    const result =
      Object.keys(data).length > 0
        ? await tx.booking.update({ where: { id: booking.id }, data })
        : await tx.booking.findUniqueOrThrow({ where: { id: booking.id } });

    /*
      Wechselt die Kundschaft, verlieren die bisherigen Verwaltungslinks ihre
      Gültigkeit (N-04). Der Link zeigt die Stammdaten der *aktuellen*
      Kundschaft der Buchung — nach einer Umbuchung auf eine andere Akte
      läse die bisherige Empfängerin sonst Name und E-Mail-Adresse der neuen.
      Einen neuen stellt erst die nächste Mitteilung aus, die einen trägt
      (die Terminerinnerung an Kundschaft ohne Konto).
    */
    if (data.customer) {
      await revokeTokensFor({ tx, purpose: 'BOOKING_MANAGE', resourceId: booking.id, revokedById: params.actorId ?? null });
    }

    /**
     * Was die offenen Einsätze wissen müssen, an sie weiterreichen.
     *
     * Bis 2026-09-27 nur bei Termin- oder Teamänderung — und die Adresse
     * ritt nur mit, wenn gleichzeitig der Termin geändert wurde. Eine
     * reine Adresskorrektur liess den Einsatz auf die alte Tür zeigen; ein
     * Wechsel von Kundschaft, Objekt oder Leistungen erreichte ihn nie, und
     * die Qualifikationen des Einsatzes blieben die der alten Leistungen.
     */
    const terminNeu = Boolean(data.scheduledStart || data.durationMin);
    const einsatzDaten = {
      ...(terminNeu
        ? { scheduledStart: result.scheduledStart, scheduledEnd: result.scheduledEnd, estimatedMin: result.durationMin }
        : {}),
      ...(data.crewSize ? { crewSize: result.crewSize } : {}),
      ...(data.address ? { addressId: result.addressId } : {}),
      ...(data.property ? { propertyId: result.propertyId } : {}),
      ...(data.customer ? { customerId: result.customerId } : {}),
      ...(input.customerNote !== undefined ? { customerNote: result.customerNote } : {}),
      ...(input.items
        ? { requiredSkills: bedarf.qualifikationen, serviceId: input.items[0]?.serviceId ?? null }
        : {}),
    };
    if (Object.keys(einsatzDaten).length > 0) {
      await einsaetzeNachfuehren(tx, {
        organizationId: params.organizationId,
        bookingId: booking.id,
        daten: einsatzDaten,
        zuteilungPruefen: terminNeu || Boolean(input.items),
        zeitOderOrt: terminNeu || Boolean(data.address || data.property || data.customer),
      });
    }

    /*
      Der Zugangshinweis wurde beim Anlegen des Einsatzes in dessen interne
      Notiz übernommen. Nachgeführt wird er nur, wo die Disposition diese
      Notiz seither nicht selbst geändert hat — sonst überschriebe die
      Buchungsmaske eine Anweisung ans Team.
    */
    if (input.accessNote !== undefined && (input.accessNote ?? null) !== booking.accessNote) {
      await tx.job.updateMany({
        where: { bookingId: booking.id, deletedAt: null, status: { in: [...EINSATZ_FOLGT] }, internalNote: booking.accessNote },
        data: { internalNote: input.accessNote ?? null },
      });
    }

    return result;
  });

  const changedFields = Object.keys(changes);
  if (changedFields.length > 0 || input.changeReason) {
    await prisma.activity.create({
      data: {
        bookingId: booking.id,
        customerId: updated.customerId,
        authorId: params.actorId,
        type: 'STATUS_CHANGE',
        subject: `Auftrag ${booking.number} bearbeitet`,
        body: [
          changedFields.length > 0
            ? changedFields.map((field) => `${field}: ${format(changes[field]!.from)} → ${format(changes[field]!.to)}`).join('\n')
            : null,
          input.changeReason ? `Grund: ${input.changeReason}` : null,
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    });
  }

  await invalidateAvailability(params.organizationId, booking.scheduledStart);
  if (data.scheduledStart) {
    await invalidateAvailability(params.organizationId, updated.scheduledStart);
  }

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Booking',
    entityId: booking.id,
    summary:
      `Buchung ${booking.number} bearbeitet` +
      (verfuegbarkeitBetroffen && input.overrideCapacity ? ' — Kapazitätsprüfung übergangen' : ''),
    changes,
  });

  // Der Wechsel zuletzt — siehe den Abschnitt „Statuswechsel" oben.
  if (statusWechsel === 'CANCELLED') {
    return cancelBooking({
      organizationId: params.organizationId,
      bookingId: booking.id,
      reason: input.changeReason!,
      actorId: params.actorId,
      byStaff: true,
    });
  }
  if (statusWechsel === 'CONFIRMED') {
    return confirmBooking({ organizationId: params.organizationId, bookingId: booking.id, actorId: params.actorId });
  }

  return updated;
}

/** Prüft, dass alle genannten Katalogeinträge zur eigenen Organisation gehören. */
async function assertCatalogOwnership(
  organizationId: string,
  model: 'service' | 'serviceExtra',
  ids: string[],
): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;

  const found =
    model === 'service'
      ? await prisma.service.count({ where: { id: { in: unique }, organizationId } })
      : await prisma.serviceExtra.count({ where: { id: { in: unique }, organizationId } });

  if (found !== unique.length) {
    throw new NotFoundError(model === 'service' ? 'Leistung' : 'Zusatzleistung');
  }
}

function format(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  // Zürcher Zeit — in der Änderungsspur stand sonst die Uhrzeit des Servers.
  if (value instanceof Date) return formatDateTime(value);
  return String(value);
}

function bookingItemToInput(item: {
  serviceId: string | null;
  name: string;
  description: string | null;
  quantity: Prisma.Decimal;
  unit: string;
  unitPrice: Prisma.Decimal;
  durationMin: number;
}) {
  return {
    serviceId: item.serviceId,
    name: item.name,
    description: item.description,
    quantity: toNumber(item.quantity),
    unit: item.unit,
    unitPrice: toNumber(item.unitPrice),
    durationMin: item.durationMin,
  };
}

function bookingExtraToInput(extra: {
  extraId: string | null;
  name: string;
  quantity: number;
  unitPrice: Prisma.Decimal;
}) {
  return {
    extraId: extra.extraId,
    name: extra.name,
    quantity: extra.quantity,
    unitPrice: toNumber(extra.unitPrice),
  };
}

/**
 * Totale eines von Hand bearbeiteten Auftrags.
 *
 * Bewusst eine eigene, sehr kurze Rechnung statt eines erneuten Laufs durch die
 * Preis-Engine: Die Engine leitet den Preis aus Fläche, Turnus und Regeln ab.
 * Wer die Positionen von Hand angefasst hat, hat genau diese Ableitung
 * verworfen — sie erneut anzuwenden würde die Eingabe stillschweigend
 * überschreiben.
 *
 * Die MWST liegt auf dem Nettobetrag *nach* Rabatt: In der Schweiz ist ein
 * gewährter Rabatt eine Entgeltminderung, die Steuer bemisst sich am
 * tatsächlich vereinnahmten Entgelt.
 */
export function recalculateBookingTotals(input: {
  items: { quantity: number; unitPrice: number }[];
  extras: { quantity: number; unitPrice: number }[];
  travelFee: number;
  discountAmount: number;
  vatRate: number;
}) {
  /*
    Dezimal, und die Summen aus den gerundeten Zeilen (Phase 25, 2026-09-27).
    Vorher: jede Zeile binär multipliziert (1.5 × 30.15 ergab 45.22), und das
    Zwischentotal aus den *ungerundeten* Produkten — Zeilen und Total konnten
    um einen Rappen auseinanderliegen. Die Rechnung rundet je Position
    (`rechnungsbetraege.ts`); der Auftrag jetzt ebenso.
  */
  const artikel = input.items.map((item) => produkt(item.quantity, item.unitPrice));
  const zusatz = input.extras.map((extra) => produkt(extra.quantity, extra.unitPrice));
  const lines = [
    ...artikel.map((amount) => ({ key: 'item', kind: 'base' as const, amount })),
    ...zusatz.map((amount) => ({ key: 'extra', kind: 'extra' as const, amount })),
  ];

  const subtotal = summeZahl(...artikel);
  const extrasTotal = summeZahl(...zusatz);
  const travelFee = summeZahl(input.travelFee);

  // Der Rabatt kann den Auftrag höchstens auf null bringen, nie darunter.
  const beforeDiscount = summeZahl(subtotal, extrasTotal, travelFee);
  const discountAmount = summeZahl(Math.min(input.discountAmount, beforeDiscount));

  const netTotal = summeZahl(beforeDiscount, -discountAmount);
  const vatRate = input.vatRate;
  const vatAmount = prozentVon(netTotal, vatRate);

  return {
    lines,
    subtotal,
    extrasTotal,
    travelFee,
    discountAmount,
    netTotal,
    vatRate,
    vatAmount,
    grossTotal: summeZahl(netTotal, vatAmount),
  };
}

// ---------------------------------------------------------------------------
//  Serien
// ---------------------------------------------------------------------------

const FREQUENCY_DAYS: Record<Frequency, number> = {
  ONCE: 0,
  WEEKLY: 7,
  BIWEEKLY: 14,
  MONTHLY: 30,
  QUARTERLY: 91,
  SEMIANNUAL: 182,
  ANNUAL: 365,
  CUSTOM: 0,
};

/**
 * Materialisiert die nächsten Instanzen wiederkehrender Buchungen.
 * Wird vom Cron-Job `/api/cron/recurring` täglich aufgerufen.
 */
export async function generateRecurringBookings(organizationId: string): Promise<number> {
  const horizon = new Date(Date.now() + RECURRENCE_HORIZON_DAYS * 86_400_000);

  const templates = await prisma.booking.findMany({
    where: {
      organizationId,
      deletedAt: null,
      parentBookingId: null,
      recurrenceRuleId: { not: null },
      status: { in: ['CONFIRMED', 'COMPLETED'] },
      recurrenceRule: { active: true },
    },
    include: {
      recurrenceRule: true,
      items: true,
      extras: true,
      childBookings: { orderBy: { scheduledStart: 'desc' }, take: 1 },
    },
  });

  let created = 0;

  for (const template of templates) {
    const rule = template.recurrenceRule!;
    const stepDays = FREQUENCY_DAYS[rule.frequency] * rule.interval;
    if (stepDays <= 0) continue;

    const last = template.childBookings[0]?.scheduledStart ?? template.scheduledStart;
    let cursor = new Date(last.getTime() + stepDays * 86_400_000);

    const existingCount = await prisma.booking.count({
      where: { parentBookingId: template.id },
    });
    let generated = existingCount;

    while (cursor <= horizon) {
      if (rule.endDate && cursor > rule.endDate) break;
      if (rule.count && generated + 1 >= rule.count) break;

      const end = new Date(cursor.getTime() + template.durationMin * 60_000);
      const instanceStart = new Date(cursor);

      await prisma.$transaction(async (tx) => {
        const { number } = await nextNumber(tx, organizationId, 'booking');

        const instance = await tx.booking.create({
          data: {
            organizationId,
            number,
            customerId: template.customerId,
            addressId: template.addressId,
            propertyId: template.propertyId,
            parentBookingId: template.id,
            recurrenceRuleId: rule.id,
            frequency: template.frequency,
            status: 'CONFIRMED',
            scheduledStart: instanceStart,
            scheduledEnd: end,
            durationMin: template.durationMin,
            crewSize: template.crewSize,
            propertyKind: template.propertyKind,
            squareMeters: template.squareMeters,
            rooms: template.rooms,
            windows: template.windows,
            customerNote: template.customerNote,
            accessNote: template.accessNote,
            subtotal: template.subtotal,
            extrasTotal: template.extrasTotal,
            travelFee: template.travelFee,
            discountAmount: template.discountAmount,
            netTotal: template.netTotal,
            vatRate: template.vatRate,
            vatAmount: template.vatAmount,
            grossTotal: template.grossTotal,
            priceBreakdown: template.priceBreakdown ?? undefined,
            source: template.source,
            confirmedAt: new Date(),
            items: {
              create: template.items.map((item) => ({
                serviceId: item.serviceId,
                name: item.name,
                description: item.description,
                quantity: item.quantity,
                unit: item.unit,
                unitPrice: item.unitPrice,
                vatRate: item.vatRate,
                lineTotal: item.lineTotal,
                durationMin: item.durationMin,
                position: item.position,
              })),
            },
            extras: {
              create: template.extras.map((extra) => ({
                extraId: extra.extraId,
                name: extra.name,
                quantity: extra.quantity,
                unitPrice: extra.unitPrice,
                lineTotal: extra.lineTotal,
                durationMin: extra.durationMin,
              })),
            },
          },
        });

        await createJobsForBooking(tx, instance.id);
        await tx.recurrenceRule.update({
          where: { id: rule.id },
          data: { generatedUntil: instanceStart },
        });
        await automationEreignisVormerken(tx, { organizationId, trigger: 'RECURRING_BOOKING_GENERATE', entityId: instance.id });
        return instance.id;
      });

      /**
       * `RECURRING_BOOKING_GENERATE` — bis 2026-09-23 wählbar und nie gemeldet
       * (RB-012). Vermerkt in der Transaktion der Instanz (Outbox,
       * 2026-09-27), abgearbeitet nach dem Commit, damit eine Regel nie eine
       * Buchung sieht, die noch zurückrollen könnte; wirft nie.
       */
      await automationEreignisseAbarbeiten({ organizationId });

      created++;
      generated++;
      cursor = new Date(cursor.getTime() + stepDays * 86_400_000);
    }
  }

  return created;
}

// ---------------------------------------------------------------------------
//  Abfragen
// ---------------------------------------------------------------------------

export interface BookingListFilter {
  organizationId: string;
  customerId?: string;
  status?: Booking['status'];
  from?: Date;
  to?: Date;
  q?: string;
  page: number;
  pageSize: number;
  sort?: string;
  order?: SortOrder;
}

/** Spalten, nach denen die Buchungsliste sortiert werden darf. */
export const BOOKING_SORT_FIELDS = [
  'number',
  'scheduledStart',
  'createdAt',
  'grossTotal',
  'status',
] as const;

export async function listBookings(filter: BookingListFilter) {
  const where: Prisma.BookingWhereInput = {
    organizationId: filter.organizationId,
    deletedAt: null,
    ...(filter.customerId ? { customerId: filter.customerId } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.from || filter.to
      ? {
          scheduledStart: {
            ...(filter.from ? { gte: filter.from } : {}),
            ...(filter.to ? { lte: filter.to } : {}),
          },
        }
      : {}),
    ...(filter.q
      ? {
          OR: [
            { number: { contains: filter.q, mode: 'insensitive' } },
            { customer: { lastName: { contains: filter.q, mode: 'insensitive' } } },
            { customer: { companyName: { contains: filter.q, mode: 'insensitive' } } },
            { customer: { email: { contains: filter.q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const sorting = resolveSort({ sort: filter.sort, order: filter.order }, BOOKING_SORT_FIELDS, {
    sort: 'scheduledStart',
    order: 'desc',
  });

  const [items, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      orderBy: orderByFor(sorting, 'number'),
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
      include: {
        customer: {
          select: { id: true, firstName: true, lastName: true, companyName: true, email: true },
        },
        address: { select: { street: true, streetNo: true, postalCode: true, city: true } },
        // Alle Positionen, nicht nur die erste — die Liste nennt jede Leistung.
        items: { select: { name: true, serviceId: true, position: true, service: { select: { name: true } } } },
        jobs: { select: { id: true, number: true, status: true } },
      },
    }),
    prisma.booking.count({ where }),
  ]);

  return { items, total };
}

export async function getBookingDetail(params: {
  organizationId: string;
  bookingId: string;
  /** Bei Kundenzugriff: erzwingt die Eigentümerprüfung. */
  customerId?: string;
}) {
  const booking = await prisma.booking.findFirst({
    where: {
      id: params.bookingId,
      organizationId: params.organizationId,
      deletedAt: null,
      ...(params.customerId ? { customerId: params.customerId } : {}),
    },
    include: {
      customer: true,
      address: true,
      property: true,
      items: { include: { service: true } },
      extras: { include: { extra: true } },
      jobs: {
        include: {
          assignments: {
            include: {
              employee: {
                include: { user: { select: { firstName: true, lastName: true, avatarUrl: true } } },
              },
            },
          },
          photos: true,
        },
      },
      // Im Kundenzugriff nur die eigenen Rechnungen (2026-09-28): Hing eine
      // Rechnung an eine fremde Kundschaft an dieser Buchung (vor der Prüfung
      // in `createInvoice` möglich), zeigte das Kundenkonto sie mit Betrag
      // und Saldo. Die Eigentümerprüfung gilt auch für Altbestand.
      invoices: {
        ...(params.customerId ? { where: { customerId: params.customerId } } : {}),
        select: { id: true, number: true, status: true, grossTotal: true, balance: true },
      },
      files: true,
      reviews: true,
      /**
       * Die Änderungsspur. Sie beantwortet die Frage, die im Büro am
       * häufigsten gestellt wird, wenn die Kundschaft anruft: „Wer hat das
       * wann geändert — und warum?"
       */
      activities: {
        orderBy: { occurredAt: 'desc' },
        take: 30,
        include: { author: { select: { firstName: true, lastName: true } } },
      },
    },
  });

  if (!booking) throw new NotFoundError('Buchung');
  return booking;
}

/**
 * Frist eines Verwaltungslinks: 90 Tage nach Terminende, mindestens 90 Tage
 * ab heute. Der Link dient vor dem Termin der Verwaltung und danach als Beleg;
 * länger braucht ihn niemand, und ein Link ohne Ende ist ein Zugang ohne Ende —
 * genau der Mangel der alten Klartextspalte.
 */
const BUCHUNGSLINK_TAGE = 90;

/**
 * Einen Verwaltungslink ausstellen und die URL zurückgeben.
 *
 * Bis 2026-09-27 hatte jede Buchung *einen* Link, im Klartext an der Buchung
 * gespeichert und von jeder Stelle wiederverwendet, die ihn brauchte —
 * Bestätigung, PDF, Erinnerung. Mit Hash-Speicherung gibt es den rohen Wert
 * nach der Ausstellung nicht mehr; wer später einen Link verschickt, stellt
 * einen neuen aus. Das ist kein Umweg, sondern der Sinn: Jeder versendete Link
 * steht im Prüfprotokoll (`issuePublicToken`), und ein widerrufener Link
 * lässt sich nicht aus der Datenbank wiederbeleben.
 */
export async function buchungslinkAusstellen(params: {
  organizationId: string;
  bookingId: string;
  scheduledEnd: Date;
  createdById?: string | null;
}): Promise<string> {
  const tag = 86_400_000;
  const expiresAt = new Date(
    Math.max(params.scheduledEnd.getTime(), Date.now()) + BUCHUNGSLINK_TAGE * tag,
  );
  /**
   * Vor jeder Ausstellung die bisherigen Links derselben Buchung widerrufen
   * (N-04, 2026-09-27) — dieselbe Regel wie beim Neuversand einer Offerte.
   *
   * Vorher legte jede Erinnerung einen weiteren gültigen Link daneben; eine
   * Buchung sammelte so mehrere Schlüssel in mehreren E-Mails, jeder bis 90
   * Tage nach dem Termin gültig, und keiner liess sich einzeln zuordnen.
   * Gültig ist jetzt immer der zuletzt versendete. Widerruf und Ausstellung
   * in einer Transaktion: Scheitert die Ausstellung, bleibt der alte Link
   * gültig, statt dass die Buchung gar keinen mehr hat. Die Kehrseite ist
   * gewollt: Der Link aus der ersten Bestätigung erlischt mit der Erinnerung,
   * die einen neuen trägt.
   */
  const { raw } = await prisma.$transaction(async (tx) => {
    await revokeTokensFor({
      tx,
      purpose: 'BOOKING_MANAGE',
      resourceId: params.bookingId,
      revokedById: params.createdById ?? null,
    });
    return issuePublicToken({
      tx,
      organizationId: params.organizationId,
      purpose: 'BOOKING_MANAGE',
      resourceId: params.bookingId,
      createdById: params.createdById ?? null,
      expiresAt,
    });
  });
  return absoluteUrl(`/buchung/${raw}`);
}

/**
 * Zugriff über den Verwaltungslink (Gastbuchung ohne Konto).
 *
 * Aufgelöst über `resolvePublicToken`: Zweck, Ablauf und Widerruf werden dort
 * geprüft, und die Buchungs-ID kommt aus dem Token, nicht aus der Anfrage. Ein
 * abgelaufener oder widerrufener Link bekommt eine Meldung, die das sagt; ein
 * geratener dieselbe wie eine fehlende Buchung.
 */
export async function getBookingByToken(token: string) {
  const aufgeloest = await resolvePublicToken({ raw: token, purpose: 'BOOKING_MANAGE' });
  if (!aufgeloest.ok) throw tokenRejectionError(aufgeloest.reason, 'Buchung');

  const booking = await prisma.booking.findFirst({
    where: { id: aufgeloest.token.resourceId, organizationId: aufgeloest.token.organizationId },
    include: {
      customer: { select: { firstName: true, lastName: true, email: true } },
      address: true,
      items: { include: { service: { select: { name: true, slug: true } } } },
      extras: true,
    },
  });
  if (!booking || booking.deletedAt) throw new NotFoundError('Buchung');
  return booking;
}

// ---------------------------------------------------------------------------
//  Hilfsfunktionen
// ---------------------------------------------------------------------------

const log = logger('booking');

/**
 * Die Buchungsbestätigung als Mail-Anhang — oder nichts.
 *
 * Ein Fehler beim Rendern darf die Buchung nicht zu Fall bringen: Die Buchung
 * ist zu diesem Zeitpunkt längst gespeichert, und eine E-Mail ohne Anhang ist
 * besser als gar keine. Die Vorlage sagt dann auch nicht „liegt bei", sondern
 * verweist auf den Download im Verwaltungslink.
 */
async function bookingPdfAttachment(
  bookingId: string,
  manageUrl?: string,
): Promise<{ filename: string; content: Buffer }[] | undefined> {
  try {
    const pdf = await renderBookingConfirmationPdf(bookingId, { manageUrl });
    return [{ filename: pdf.filename, content: pdf.buffer }];
  } catch (error) {
    log.error('Buchungsbestätigung konnte nicht gerendert werden', { bookingId, error });
    return undefined;
  }
}

/**
 * Kundschaft für eine Erfassung im Büro — aus der ID, nicht aus der Adresse.
 *
 * Der Mandantenfilter steht in der `where`-Klausel, nicht in einer Prüfung
 * danach: Eine fremde Kundennummer wird schlicht nicht gefunden und ist von
 * einer erfundenen nicht zu unterscheiden. Eine gesperrte Kundschaft läuft
 * weiter unten in dieselbe Regel wie im öffentlichen Weg.
 */
/**
 * Wer bucht. `customerId: null` heisst: eine neue Gastkundschaft, die erst
 * mit der Buchung angelegt wird (`neu` trägt ihre Angaben).
 */
interface AufgeloesteKundschaft {
  customerId: string | null;
  neu?: NeueGastkundschaft;
  /**
   * Ist belegt, dass die anfragende Person diese Kundschaft *ist* oder für
   * sie handeln darf? Ja bei angemeldeter Kundschaft (ihr eigenes Profil)
   * und im Büro (`booking:create`, Kundschaft ausdrücklich gewählt). Nein,
   * wenn eine Gastbuchung über die eingetippte E-Mail-Adresse einer
   * bestehenden Akte zugeordnet wird: Eine E-Mail-Adresse ist kein Nachweis,
   * jede Kundenliste und jede Visitenkarte nennt sie (F-03, 2026-09-27).
   * Ohne Nachweis: kein Verweis auf Bestand, kein Rabatt, kein
   * Verwaltungslink und kein Sperrgrund in der Antwort.
   */
  nachgewiesen: boolean;
  isNewCustomer: boolean;
  customerEmail: string;
  customerName: string;
  userId: string | null;
}

async function resolveOfficeCustomer(params: {
  organizationId: string;
  customerId: string;
}): Promise<AufgeloesteKundschaft> {
  const customer = await prisma.customer.findFirst({
    where: { id: params.customerId, organizationId: params.organizationId, deletedAt: null },
    select: { id: true, email: true, firstName: true, lastName: true, companyName: true, userId: true },
  });
  if (!customer) throw new NotFoundError('Kundschaft');

  return {
    customerId: customer.id,
    nachgewiesen: true,
    isNewCustomer: false,
    customerEmail: customer.email,
    customerName: customer.companyName ?? `${customer.firstName} ${customer.lastName}`,
    userId: customer.userId,
  };
}

/**
 * Was eine Datei erfüllen muss, um an eine Buchung zu kommen — neben der
 * Organisation und der hochladenden Person, die der Aufrufer ergänzt.
 * Dieselben Bedingungen wie `dateienBinden` (die Bindung selbst); hier nur
 * für die frühe, verständliche Antwort vor Preis und Transaktion.
 */
const ANHAENGBAR = {
  scope: 'BOOKING',
  bookingId: null,
  isPublic: false,
  scanStatus: { notIn: ['INFECTED', 'QUARANTINED', 'ERROR'] },
  checksum: { not: null },
} satisfies Prisma.FileAssetWhereInput;

/**
 * Die Verweise einer Buchung prüfen, **bevor** gerechnet oder geschrieben
 * wird (2026-09-27).
 *
 * Die öffentliche Buchung nahm `addressId`, `propertyId` und `fileIds`
 * entgegen und schrieb sie ungeprüft an die Buchung. `Address` und `Property`
 * tragen keine Organisation, und niemand verglich die Kundschaft: Wer eine
 * Kennung kannte, buchte auf die Adresse einer fremden Kundschaft — und bekam
 * sie in Bestätigung, PDF und Buchungsansicht zurück, beim Objekt samt
 * Schlüsselort und Zugangsnotiz. Eine Kennung ist kein Beweis von Besitz.
 *
 * Die Regeln, ausdrücklich:
 *
 *  • Adresse und Objekt nur aus dem Bestand **dieser** Kundschaft, in dieser
 *    Organisation. Eine Gastbuchung hat keinen Bestand — auch dann nicht,
 *    wenn ihre E-Mail-Adresse zu einer bestehenden Akte passt: Der Aufrufer
 *    übergibt `customerId` nur bei nachgewiesener Kundschaft (F-03). Ein
 *    Gast gibt eine neue Adresse an, keine Kennung.
 *  • Dateien nur von der **angemeldeten** Person selbst hochgeladen, als
 *    Buchungsfoto, noch ungebunden, geprüft und sauber. Ein Gast hat keine
 *    Identität, an die sich eine Datei binden liesse; das Buchungsformular
 *    hat heute ohnehin keinen Bildupload.
 *
 * Unbekannt, fremd und nicht erlaubt ergeben dieselbe Antwort (404): Die
 * Antwort soll nicht verraten, ob es eine Kennung anderswo gibt.
 */
async function buchungsbezuegePruefen(params: {
  organizationId: string;
  customerId: string | null;
  addressId: string | null;
  propertyId: string | null;
  fileIds: string[];
  uploaderId: string | null;
}): Promise<{ postalCode: string | null }> {
  const { organizationId, customerId } = params;
  const eigene = customerId ? { customerId, customer: { organizationId, deletedAt: null } } : null;

  let postalCode: string | null = null;
  if (params.addressId) {
    const adresse = eigene ? await prisma.address.findFirst({ where: { id: params.addressId, ...eigene }, select: { postalCode: true } }) : null;
    if (!adresse) throw new NotFoundError('Adresse');
    postalCode = adresse.postalCode;
  }
  if (params.propertyId) {
    const objekt = eigene ? await prisma.property.findFirst({ where: { id: params.propertyId, ...eigene }, select: { id: true } }) : null;
    if (!objekt) throw new NotFoundError('Objekt');
  }
  if (params.fileIds.length > 0) {
    if (!params.uploaderId) {
      throw new BusinessRuleError('Fotos lassen sich nur mit Anmeldung an eine Buchung anhängen.');
    }
    const passend = await prisma.fileAsset.count({
      where: { id: { in: params.fileIds }, ...ANHAENGBAR, organizationId, uploadedById: params.uploaderId },
    });
    if (passend !== new Set(params.fileIds).size) throw new NotFoundError('Datei');
  }
  return { postalCode };
}

async function resolveCustomer(params: {
  organizationId: string;
  input: BookingCoreInput;
  session: SessionUser | null;
}): Promise<AufgeloesteKundschaft> {
  const { organizationId, input, session } = params;

  // Fall 1: eingeloggter Kunde
  if (session?.role === 'CUSTOMER' && session.profileId) {
    const customer = await prisma.customer.findUniqueOrThrow({
      where: { id: session.profileId },
      select: { id: true, email: true, firstName: true, lastName: true, userId: true },
    });
    return {
      customerId: customer.id,
      nachgewiesen: true,
      isNewCustomer: false,
      customerEmail: customer.email,
      customerName: `${customer.firstName} ${customer.lastName}`,
      userId: customer.userId,
    };
  }

  /*
    Einen Fall 2 gibt es nicht mehr (F-03, 2026-09-27).

    Hier stand: Jede angemeldete Person, die nicht Kundschaft ist, bucht über
    eine bestehende `addressId` auf deren Kundschaft. Geprüft wurde nur die
    Organisation, keine Berechtigung — die öffentliche Route verlangt keine.
    Eine Reinigungskraft ohne `booking:create` konnte so auf jede Adresse der
    Organisation buchen und bekam den Verwaltungslink samt Stammdaten zurück.

    Eine Berechtigungsprüfung an dieser Stelle nachzuziehen wäre der falsche
    Weg: Für die Erfassung im Büro gibt es `POST /api/bookings`, mit
    `booking:create`, ausdrücklicher Kundschaft, Herkunft und Protokoll. Ein
    zweiter Büroweg durch die öffentliche Route wäre eine zweite
    Sicherheitsstufe für dieselbe Handlung. Wer angemeldet, aber nicht
    Kundschaft ist, bucht hier deshalb wie ein Gast — mit Kontaktangaben und
    neuer Adresse, ohne Zugriff auf Bestand.
  */

  // Gastbuchung — Kontaktangaben sind Pflicht.
  if (!input.email || !input.firstName || !input.lastName || !input.phone) {
    throw new BusinessRuleError(
      'Bitte geben Sie Vorname, Nachname, E-Mail und Telefonnummer an oder melden Sie sich an.',
    );
  }

  const existing = await prisma.customer.findFirst({
    where: { organizationId, email: input.email, deletedAt: null },
    select: { id: true, email: true, firstName: true, lastName: true, userId: true },
  });

  /**
   * Eine bestehende Akte mit dieser E-Mail-Adresse: Die Buchung kommt dorthin,
   * aber **ohne Nachweis** (F-03, 2026-09-27).
   *
   * Eine zweite Akte anzulegen, wäre die scheinbar sichere Alternative und
   * ist verworfen: Die Adresse ist je Organisation die Identität einer
   * Kundschaft (`kundenakte-sperre.ts` serialisiert jeden Anlageweg genau
   * darauf), Registrierung und Büro fänden danach zwei Akten, und die
   * Kundschaft, die ohne Anmeldung ein zweites Mal bucht, sähe ihre
   * Buchungen verstreut. Die Zuordnung bleibt also — nur verschafft sie der
   * anfragenden Person nichts: keinen Verweis auf Adressen und Objekte der
   * Akte, keinen Rabatt, keinen Verwaltungslink, keinen Sperrgrund. Die
   * Bestätigung geht an die Adresse der Akte; dort liest sie, wem sie gehört.
   */
  if (existing) {
    return {
      customerId: existing.id,
      nachgewiesen: false,
      isNewCustomer: false,
      customerEmail: existing.email,
      customerName: `${existing.firstName} ${existing.lastName}`,
      userId: existing.userId,
    };
  }

  // Neue Kundschaft: noch nichts schreiben — `createBooking` legt sie in der
  // Transaktion der Buchung an (Begründung dort).
  return {
    customerId: null,
    neu: {
      companyName: input.companyName ?? null,
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone,
    },
    // Die Akte entsteht erst mit dieser Buchung; ob die anfragende Person sie
    // sehen darf, entscheidet `gastkundschaftAnlegen` (hat sie sie angelegt?).
    nachgewiesen: false,
    isNewCustomer: true,
    customerEmail: input.email,
    customerName: `${input.firstName} ${input.lastName}`,
    userId: null,
  };
}

interface NeueGastkundschaft {
  companyName: string | null;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

/**
 * Die Gastkundschaft einer Buchung anlegen — innerhalb der Buchungstransaktion.
 *
 * Zuerst noch einmal nach der Adresse suchen: Zwischen dem Auflösen vor der
 * Preisberechnung und diesem Punkt kann eine zweite Buchung derselben Person
 * die Akte angelegt haben. Die Transaktionssperre der Buchung serialisiert
 * beide; die zweite findet hier die Akte der ersten, statt eine Doppelakte
 * anzulegen.
 */
async function gastkundschaftAnlegen(
  tx: Tx,
  organizationId: string,
  neu: NeueGastkundschaft,
): Promise<{ id: string; angelegt: boolean }> {
  // Dieselbe Sperre wie jeder andere Anlageweg (`kundenakte-sperre.ts`): Die
  // Buchungssperre serialisiert nur Buchungen untereinander, nicht die
  // Buchung gegen das Büro oder die Registrierung.
  await kundenakteSperren(tx, organizationId, neu.email);
  const vorhanden = await tx.customer.findFirst({
    where: { organizationId, email: neu.email, deletedAt: null },
    select: { id: true },
  });
  // `angelegt: false` — die Akte stammt nicht aus dieser Anfrage und wird
  // behandelt wie jede bestehende: ohne Nachweis (siehe `createBooking`).
  if (vorhanden) return { id: vorhanden.id, angelegt: false };
  const { number } = await nextNumber(tx, organizationId, 'customer');
  const customer = await tx.customer.create({
    data: {
      organizationId,
      number,
      type: neu.companyName ? 'BUSINESS' : 'PRIVATE',
      companyName: neu.companyName,
      firstName: neu.firstName,
      lastName: neu.lastName,
      email: neu.email,
      phone: neu.phone,
      referralCode: randomToken(4).toUpperCase(),
    },
    select: { id: true },
  });
  return { id: customer.id, angelegt: true };
}

/**
 * Eine bei der Buchung eingegebene Adresse anlegen.
 *
 * ---------------------------------------------------------------------------
 *  Der Fehler, den diese Funktion hatte
 * ---------------------------------------------------------------------------
 *
 * Sie setzte `isDefault: true` und `isBilling: true` **bedingungslos**. Wer
 * dreimal mit einer neuen Adresse buchte, hatte danach drei Standard- und drei
 * Rechnungsadressen — während die Adressverwaltung genau eine erzwingt und
 * `addresses.test.ts` das auch prüft. Die Buchung ging an dieser Regel vorbei.
 *
 * Das ist nicht nur Unordnung. `invoice.service.ts` holt die Rechnungsadresse
 * mit `where: { isBilling: true }, take: 1` — **ohne Sortierung**. Bei mehreren
 * Treffern entscheidet die Datenbank, welcher zurückkommt, und der
 * Rechnungsempfänger wäre damit von Lauf zu Lauf ein anderer.
 *
 * Gefunden hat den Fehler die Prüfreihe aus Wave 6: Sie erfasst Buchungen mit
 * Adresse, und `addresses.test.ts` fand danach drei Standardadressen. Der
 * Fehlschlag stand in einer anderen Datei als seine Ursache — und die Ursache
 * war diesmal nicht die Prüfreihe, sondern das Produkt.
 *
 * ---------------------------------------------------------------------------
 *  Was jetzt gilt
 * ---------------------------------------------------------------------------
 *
 * **Standard:** Die neue Adresse wird es, und die bisherige verliert die
 * Markierung. Das entspricht der Absicht — wer eine neue Adresse eingibt,
 * bucht dort — und hält die Regel „genau eine" ein.
 *
 * **Rechnung:** Nur, wenn es noch keine gibt. Eine Einsatzadresse ist nicht
 * zwangsläufig die Rechnungsadresse; die Rechnung einer Firma still an die
 * Wohnung der Hauswartin umzuleiten, weil dort zuletzt geputzt wurde, wäre
 * die schlechtere Vorgabe. Wer die Rechnungsadresse ändern will, tut das in
 * der Kundenakte.
 *
 * **Ohne Nachweis** (`bestandSchonen`, F-03, 2026-09-27): Fällt eine
 * Gastbuchung über die E-Mail-Adresse auf eine bestehende Akte, entsteht die
 * Adresse dort, aber sie verdrängt nichts. Sonst hätte jede anonyme Anfrage
 * mit einer bekannten E-Mail-Adresse die Standardadresse einer fremden
 * Kundschaft umgestellt — und die nächste Buchung der Kundschaft selbst,
 * die ihre Standardadresse vorbelegt, führte das Team an den Ort, den die
 * fremde Anfrage eingetragen hat. Ebenso wenig wird sie Rechnungsadresse,
 * auch bei einer Akte ohne eine: Die Rechnungen der Kundschaft gingen sonst
 * an einen Ort, den eine unbelegte Anfrage bestimmt hat. Beide Markierungen
 * setzt in diesem Fall das Büro oder die angemeldete Kundschaft selbst.
 */
async function createAddress(
  tx: Tx,
  customerId: string,
  input: BookingCoreInput,
  optionen: { bestandSchonen: boolean },
): Promise<string> {
  const address = input.address!;

  let wirdRechnungsadresse = false;
  if (!optionen.bestandSchonen) {
    const [, hatRechnungsadresse] = await Promise.all([
      tx.address.updateMany({
        where: { customerId, isDefault: true },
        data: { isDefault: false },
      }),
      tx.address.count({ where: { customerId, isBilling: true } }),
    ]);
    wirdRechnungsadresse = hatRechnungsadresse === 0;
  }

  const created = await tx.address.create({
    data: {
      customerId,
      label: address.label ?? 'Einsatzadresse',
      street: address.street,
      streetNo: address.streetNo ?? null,
      addition: address.addition ?? null,
      postalCode: address.postalCode,
      city: address.city,
      canton: address.canton,
      country: address.country,
      lat: address.lat ?? null,
      lng: address.lng ?? null,
      placeId: address.placeId ?? null,
      accessNote: input.accessNote ?? address.accessNote ?? null,
      isDefault: !optionen.bestandSchonen,
      isBilling: wirdRechnungsadresse,
    },
  });
  return created.id;
}

async function formatBookingAddress(addressId: string | null): Promise<string> {
  if (!addressId) return '—';
  const address = await prisma.address.findUnique({ where: { id: addressId } });
  if (!address) return '—';
  return `${address.street} ${address.streetNo ?? ''}, ${address.postalCode} ${address.city}`.replace(
    /\s+/g,
    ' ',
  );
}

/** Prüft, ob eine Kundin/ein Kunde auf eine Buchung zugreifen darf. */
export async function assertBookingOwnership(bookingId: string, customerId: string) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { customerId: true },
  });
  if (!booking) throw new NotFoundError('Buchung');
  if (booking.customerId !== customerId) {
    throw new ForbiddenError('Diese Buchung gehört nicht zu Ihrem Konto.');
  }
}

export { round2 };

