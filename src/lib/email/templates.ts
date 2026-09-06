import { formatCurrency, formatDateLong, formatDateTime, formatTime } from '@/lib/utils';
import { button, callout, defaultBrand, escapeHtml, infoTable, renderEmail } from './layout';

/**
 * Transaktions-E-Mails.
 *
 * Jede Vorlage liefert `{ subject, html }`. Der Aufrufer entscheidet über den
 * Versandkanal — dadurch sind die Vorlagen auch für Vorschauen im Admin-Bereich
 * und für Tests ohne Netzwerkzugriff nutzbar.
 */

export interface EmailContent {
  subject: string;
  html: string;
}

const brand = defaultBrand;
const app = brand.appUrl;

// ---------------------------------------------------------------------------
//  Konto
// ---------------------------------------------------------------------------

export function welcomeEmail(params: { firstName: string; setPasswordUrl?: string }): EmailContent {
  const body = `
    <p>Herzlich willkommen bei ${escapeHtml(brand.companyName)}, ${escapeHtml(params.firstName)}.</p>
    <p>Ihr Kundenkonto ist eingerichtet. Dort sehen Sie jederzeit Ihre Termine, Offerten und Rechnungen — und buchen neue Einsätze in weniger als einer Minute.</p>
    ${params.setPasswordUrl ? button('Passwort festlegen', params.setPasswordUrl) : button('Zum Kundenbereich', `${app}/konto`)}
    <p style="color:#64748B;font-size:14px;">Fragen? Antworten Sie einfach auf diese E-Mail oder rufen Sie uns an unter ${escapeHtml(brand.phone)}.</p>`;

  return {
    subject: `Willkommen bei ${brand.companyName}`,
    html: renderEmail('Willkommen an Bord', body, {
      preheader: 'Ihr Kundenkonto ist bereit.',
    }),
  };
}

export function passwordResetEmail(params: { firstName: string; resetUrl: string }): EmailContent {
  const body = `
    <p>Guten Tag ${escapeHtml(params.firstName)}</p>
    <p>Sie haben ein neues Passwort angefordert. Der folgende Link ist <strong>60 Minuten</strong> gültig.</p>
    ${button('Neues Passwort festlegen', params.resetUrl)}
    ${callout('Falls Sie diese Anfrage nicht ausgelöst haben, können Sie diese E-Mail ignorieren. Ihr Passwort bleibt unverändert.', 'warning')}`;

  return {
    subject: 'Passwort zurücksetzen',
    html: renderEmail('Passwort zurücksetzen', body, {
      preheader: 'Der Link ist 60 Minuten gültig.',
    }),
  };
}

export function verifyEmailTemplate(params: { firstName: string; verifyUrl: string }): EmailContent {
  const body = `
    <p>Guten Tag ${escapeHtml(params.firstName)}</p>
    <p>Bitte bestätigen Sie Ihre E-Mail-Adresse, damit wir Ihnen Terminbestätigungen und Rechnungen zustellen können.</p>
    ${button('E-Mail-Adresse bestätigen', params.verifyUrl)}`;

  return {
    subject: 'Bitte bestätigen Sie Ihre E-Mail-Adresse',
    html: renderEmail('E-Mail bestätigen', body),
  };
}

export function staffInviteEmail(params: {
  firstName: string;
  inviteUrl: string;
  role: string;
}): EmailContent {
  const body = `
    <p>Guten Tag ${escapeHtml(params.firstName)}</p>
    <p>Für Sie wurde ein Zugang zu unserer Einsatzplattform erstellt (Rolle: <strong>${escapeHtml(params.role)}</strong>). Legen Sie jetzt Ihr Passwort fest.</p>
    ${button('Zugang aktivieren', params.inviteUrl)}
    <p style="color:#64748B;font-size:14px;">Der Link ist 7 Tage gültig.</p>`;

  return {
    subject: `Ihr Zugang zu ${brand.companyName}`,
    html: renderEmail('Ihr Zugang ist bereit', body),
  };
}

// ---------------------------------------------------------------------------
//  Buchungen
// ---------------------------------------------------------------------------

export interface BookingEmailData {
  firstName: string;
  bookingNumber: string;
  serviceName: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  address: string;
  grossTotal: number;
  manageUrl: string;
}

export function bookingReceivedEmail(data: BookingEmailData): EmailContent {
  const body = `
    <p>Guten Tag ${escapeHtml(data.firstName)}</p>
    <p>Vielen Dank für Ihre Buchung. Wir prüfen den Termin und bestätigen ihn in der Regel innerhalb von zwei Stunden.</p>
    ${infoTable([
      { label: 'Buchungsnummer', value: escapeHtml(data.bookingNumber) },
      { label: 'Leistung', value: escapeHtml(data.serviceName) },
      { label: 'Wunschtermin', value: formatDateLong(data.scheduledStart) },
      {
        label: 'Zeitfenster',
        value: `${formatTime(data.scheduledStart)} – ${formatTime(data.scheduledEnd)} Uhr`,
      },
      { label: 'Adresse', value: escapeHtml(data.address) },
      { label: 'Betrag inkl. MwSt.', value: formatCurrency(data.grossTotal) },
    ])}
    ${button('Buchung verwalten', data.manageUrl)}`;

  return {
    subject: `Buchung ${data.bookingNumber} eingegangen`,
    html: renderEmail('Wir haben Ihre Buchung erhalten', body, {
      preheader: `${data.serviceName} am ${formatDateLong(data.scheduledStart)}`,
    }),
  };
}

export function bookingConfirmedEmail(data: BookingEmailData): EmailContent {
  const body = `
    <p>Guten Tag ${escapeHtml(data.firstName)}</p>
    <p>Ihr Termin ist <strong>fix reserviert</strong>. Unser Team ist zum vereinbarten Zeitpunkt vor Ort.</p>
    ${infoTable([
      { label: 'Buchungsnummer', value: escapeHtml(data.bookingNumber) },
      { label: 'Leistung', value: escapeHtml(data.serviceName) },
      { label: 'Termin', value: formatDateLong(data.scheduledStart) },
      {
        label: 'Zeitfenster',
        value: `${formatTime(data.scheduledStart)} – ${formatTime(data.scheduledEnd)} Uhr`,
      },
      { label: 'Adresse', value: escapeHtml(data.address) },
      { label: 'Betrag inkl. MwSt.', value: formatCurrency(data.grossTotal) },
    ])}
    ${button('Termin ansehen', data.manageUrl)}
    ${callout('Kostenlose Umbuchung oder Stornierung bis 24 Stunden vor dem Termin.', 'info')}`;

  return {
    subject: `Termin bestätigt · ${formatDateLong(data.scheduledStart)}`,
    html: renderEmail('Ihr Termin ist bestätigt', body, {
      preheader: `${data.serviceName} am ${formatDateLong(data.scheduledStart)}`,
    }),
  };
}

export function bookingReminderEmail(
  data: BookingEmailData & { hoursBefore: number },
): EmailContent {
  const when = data.hoursBefore >= 24 ? 'morgen' : `in ca. ${data.hoursBefore} Stunden`;
  const body = `
    <p>Guten Tag ${escapeHtml(data.firstName)}</p>
    <p>Kleine Erinnerung: Ihr Reinigungstermin findet <strong>${when}</strong> statt.</p>
    ${infoTable([
      { label: 'Leistung', value: escapeHtml(data.serviceName) },
      { label: 'Termin', value: formatDateLong(data.scheduledStart) },
      {
        label: 'Zeitfenster',
        value: `${formatTime(data.scheduledStart)} – ${formatTime(data.scheduledEnd)} Uhr`,
      },
      { label: 'Adresse', value: escapeHtml(data.address) },
    ])}
    <p>Bitte stellen Sie sicher, dass unser Team Zugang zum Objekt hat.</p>
    ${button('Termin verwalten', data.manageUrl)}`;

  return {
    subject: `Erinnerung: Reinigungstermin ${when}`,
    html: renderEmail('Ihr Termin steht an', body, {
      preheader: `${data.serviceName} · ${formatDateTime(data.scheduledStart)}`,
    }),
  };
}

export function bookingCancelledEmail(
  data: Pick<BookingEmailData, 'firstName' | 'bookingNumber' | 'scheduledStart' | 'serviceName'> & {
    reason?: string;
  },
): EmailContent {
  const body = `
    <p>Guten Tag ${escapeHtml(data.firstName)}</p>
    <p>Ihre Buchung <strong>${escapeHtml(data.bookingNumber)}</strong> für ${escapeHtml(data.serviceName)} am ${formatDateLong(data.scheduledStart)} wurde storniert.</p>
    ${data.reason ? callout(`Grund: ${escapeHtml(data.reason)}`, 'warning') : ''}
    <p>Möchten Sie einen neuen Termin vereinbaren? Wir freuen uns auf Sie.</p>
    ${button('Neuen Termin buchen', `${app}/buchen`)}`;

  return {
    subject: `Buchung ${data.bookingNumber} storniert`,
    html: renderEmail('Buchung storniert', body),
  };
}

export function bookingRescheduledEmail(data: BookingEmailData): EmailContent {
  const body = `
    <p>Guten Tag ${escapeHtml(data.firstName)}</p>
    <p>Ihr Termin wurde erfolgreich verschoben. Hier die aktualisierten Angaben:</p>
    ${infoTable([
      { label: 'Buchungsnummer', value: escapeHtml(data.bookingNumber) },
      { label: 'Neuer Termin', value: formatDateLong(data.scheduledStart) },
      {
        label: 'Zeitfenster',
        value: `${formatTime(data.scheduledStart)} – ${formatTime(data.scheduledEnd)} Uhr`,
      },
      { label: 'Adresse', value: escapeHtml(data.address) },
    ])}
    ${button('Termin ansehen', data.manageUrl)}`;

  return {
    subject: `Neuer Termin: ${formatDateLong(data.scheduledStart)}`,
    html: renderEmail('Ihr Termin wurde verschoben', body),
  };
}

// ---------------------------------------------------------------------------
//  Offerten
// ---------------------------------------------------------------------------

export function quoteSentEmail(params: {
  firstName: string;
  quoteNumber: string;
  title: string;
  grossTotal: number;
  validUntil: Date;
  quoteUrl: string;
  message?: string;
}): EmailContent {
  const body = `
    <p>Guten Tag ${escapeHtml(params.firstName)}</p>
    ${params.message ? `<p>${escapeHtml(params.message).replace(/\n/g, '<br>')}</p>` : '<p>Gerne unterbreiten wir Ihnen unsere Offerte. Sie können sie online einsehen und direkt digital annehmen.</p>'}
    ${infoTable([
      { label: 'Offerte', value: escapeHtml(params.quoteNumber) },
      { label: 'Betreff', value: escapeHtml(params.title) },
      { label: 'Betrag inkl. MwSt.', value: formatCurrency(params.grossTotal) },
      { label: 'Gültig bis', value: formatDateLong(params.validUntil) },
    ])}
    ${button('Offerte ansehen & annehmen', params.quoteUrl)}
    <p style="color:#64748B;font-size:14px;">Die Offerte ist unverbindlich. Fragen beantworten wir gerne unter ${escapeHtml(brand.phone)}.</p>`;

  return {
    subject: `Offerte ${params.quoteNumber} · ${params.title}`,
    html: renderEmail('Ihre Offerte', body, {
      preheader: `${formatCurrency(params.grossTotal)} · gültig bis ${formatDateLong(params.validUntil)}`,
    }),
  };
}

export function quoteAcceptedInternalEmail(params: {
  quoteNumber: string;
  customerName: string;
  grossTotal: number;
  adminUrl: string;
}): EmailContent {
  const body = `
    <p><strong>${escapeHtml(params.customerName)}</strong> hat die Offerte ${escapeHtml(params.quoteNumber)} angenommen.</p>
    ${infoTable([
      { label: 'Offerte', value: escapeHtml(params.quoteNumber) },
      { label: 'Kunde', value: escapeHtml(params.customerName) },
      { label: 'Auftragswert', value: formatCurrency(params.grossTotal) },
    ])}
    ${button('Im Admin öffnen', params.adminUrl)}`;

  return {
    subject: `✅ Offerte ${params.quoteNumber} angenommen`,
    html: renderEmail('Offerte angenommen', body),
  };
}

export function quoteExpiringEmail(params: {
  firstName: string;
  quoteNumber: string;
  validUntil: Date;
  quoteUrl: string;
}): EmailContent {
  const body = `
    <p>Guten Tag ${escapeHtml(params.firstName)}</p>
    <p>Ihre Offerte <strong>${escapeHtml(params.quoteNumber)}</strong> läuft am ${formatDateLong(params.validUntil)} ab.</p>
    <p>Sichern Sie sich die offerierten Konditionen mit einem Klick.</p>
    ${button('Offerte jetzt annehmen', params.quoteUrl)}`;

  return {
    subject: `Ihre Offerte ${params.quoteNumber} läuft bald ab`,
    html: renderEmail('Offerte läuft bald ab', body),
  };
}

// ---------------------------------------------------------------------------
//  Rechnungen
// ---------------------------------------------------------------------------

export function invoiceIssuedEmail(params: {
  firstName: string;
  invoiceNumber: string;
  grossTotal: number;
  dueDate: Date;
  invoiceUrl: string;
  payUrl: string;
}): EmailContent {
  const body = `
    <p>Guten Tag ${escapeHtml(params.firstName)}</p>
    <p>Vielen Dank für Ihr Vertrauen. Anbei finden Sie die Rechnung für unsere Leistungen.</p>
    ${infoTable([
      { label: 'Rechnungsnummer', value: escapeHtml(params.invoiceNumber) },
      { label: 'Betrag inkl. MwSt.', value: formatCurrency(params.grossTotal) },
      { label: 'Zahlbar bis', value: formatDateLong(params.dueDate) },
    ])}
    ${button('Online bezahlen (Karte oder TWINT)', params.payUrl)}
    <p style="font-size:14px;color:#64748B;">Oder <a href="${params.invoiceUrl}" style="color:${brand.primaryColor};">Rechnung als PDF herunterladen</a> und per Banküberweisung begleichen.</p>`;

  return {
    subject: `Rechnung ${params.invoiceNumber}`,
    html: renderEmail('Ihre Rechnung', body, {
      preheader: `${formatCurrency(params.grossTotal)} · zahlbar bis ${formatDateLong(params.dueDate)}`,
    }),
  };
}

export function paymentReceivedEmail(params: {
  firstName: string;
  invoiceNumber: string;
  amount: number;
}): EmailContent {
  const body = `
    <p>Guten Tag ${escapeHtml(params.firstName)}</p>
    <p>Wir haben Ihre Zahlung erhalten — vielen Dank.</p>
    ${infoTable([
      { label: 'Rechnung', value: escapeHtml(params.invoiceNumber) },
      { label: 'Eingegangener Betrag', value: formatCurrency(params.amount) },
    ])}
    ${callout('Die Rechnung ist vollständig beglichen. Eine Quittung finden Sie in Ihrem Kundenbereich.', 'success')}
    ${button('Zum Kundenbereich', `${app}/konto/rechnungen`)}`;

  return {
    subject: `Zahlungseingang · Rechnung ${params.invoiceNumber}`,
    html: renderEmail('Zahlung erhalten', body),
  };
}

export function paymentReminderEmail(params: {
  firstName: string;
  invoiceNumber: string;
  grossTotal: number;
  balance: number;
  dueDate: Date;
  level: number;
  payUrl: string;
  fee?: number;
}): EmailContent {
  const titles: Record<number, string> = {
    1: 'Zahlungserinnerung',
    2: '1. Mahnung',
    3: '2. Mahnung',
  };
  const title = titles[params.level] ?? 'Zahlungserinnerung';

  const tone = params.level >= 2 ? 'warning' : 'info';
  const body = `
    <p>Guten Tag ${escapeHtml(params.firstName)}</p>
    <p>Zu unserer Rechnung <strong>${escapeHtml(params.invoiceNumber)}</strong> konnten wir bis heute keinen vollständigen Zahlungseingang feststellen.</p>
    ${infoTable([
      { label: 'Rechnungsbetrag', value: formatCurrency(params.grossTotal) },
      { label: 'Offener Betrag', value: formatCurrency(params.balance) },
      { label: 'Fällig seit', value: formatDateLong(params.dueDate) },
      ...(params.fee ? [{ label: 'Mahngebühr', value: formatCurrency(params.fee) }] : []),
    ])}
    ${button('Jetzt bezahlen', params.payUrl)}
    ${callout(
      params.level >= 3
        ? 'Sollte die Zahlung nicht innert 10 Tagen eingehen, übergeben wir die Forderung an unser Inkassobüro. Bitte kontaktieren Sie uns, falls es Unklarheiten gibt.'
        : 'Sollten Sie die Zahlung bereits veranlasst haben, betrachten Sie dieses Schreiben als gegenstandslos.',
      tone,
    )}`;

  return {
    subject: `${title} · Rechnung ${params.invoiceNumber}`,
    html: renderEmail(title, body),
  };
}

// ---------------------------------------------------------------------------
//  Einsätze & Bewertungen
// ---------------------------------------------------------------------------

export function jobAssignedEmail(params: {
  firstName: string;
  jobNumber: string;
  title: string;
  scheduledStart: Date;
  address: string;
  portalUrl: string;
}): EmailContent {
  const body = `
    <p>Hallo ${escapeHtml(params.firstName)}</p>
    <p>Dir wurde ein neuer Einsatz zugeteilt.</p>
    ${infoTable([
      { label: 'Auftrag', value: escapeHtml(params.jobNumber) },
      { label: 'Bezeichnung', value: escapeHtml(params.title) },
      { label: 'Termin', value: formatDateTime(params.scheduledStart) },
      { label: 'Adresse', value: escapeHtml(params.address) },
    ])}
    ${button('Einsatz im Portal öffnen', params.portalUrl)}`;

  return {
    subject: `Neuer Einsatz ${params.jobNumber} · ${formatDateTime(params.scheduledStart)}`,
    html: renderEmail('Neuer Einsatz für dich', body),
  };
}

export function reviewRequestEmail(params: {
  firstName: string;
  serviceName: string;
  reviewUrl: string;
}): EmailContent {
  const body = `
    <p>Guten Tag ${escapeHtml(params.firstName)}</p>
    <p>Wie zufrieden waren Sie mit unserer ${escapeHtml(params.serviceName)}? Ihre Rückmeldung dauert eine Minute und hilft uns, besser zu werden.</p>
    ${button('Jetzt bewerten', params.reviewUrl)}
    <p style="color:#64748B;font-size:14px;">Vielen Dank für Ihre Zeit.</p>`;

  return {
    subject: 'Wie war unsere Reinigung?',
    html: renderEmail('Ihre Meinung zählt', body),
  };
}

export function birthdayEmail(params: { firstName: string; couponCode?: string }): EmailContent {
  const body = `
    <p>Guten Tag ${escapeHtml(params.firstName)}</p>
    <p>Das ganze Team von ${escapeHtml(brand.companyName)} gratuliert Ihnen herzlich zum Geburtstag.</p>
    ${
      params.couponCode
        ? callout(
            `Als kleines Geschenk: <strong>10 % Rabatt</strong> auf Ihre nächste Buchung mit dem Code <strong>${escapeHtml(params.couponCode)}</strong> (gültig 60 Tage).`,
            'success',
          )
        : ''
    }
    ${button('Termin buchen', `${app}/buchen`)}`;

  return {
    subject: 'Alles Gute zum Geburtstag! 🎉',
    html: renderEmail('Herzlichen Glückwunsch', body),
  };
}

// ---------------------------------------------------------------------------
//  Interne Benachrichtigungen
// ---------------------------------------------------------------------------

export function newLeadInternalEmail(params: {
  name: string;
  email: string;
  phone?: string;
  serviceKind?: string;
  message: string;
  adminUrl: string;
}): EmailContent {
  const body = `
    <p>Über die Website ist eine neue Anfrage eingegangen.</p>
    ${infoTable([
      { label: 'Name', value: escapeHtml(params.name) },
      { label: 'E-Mail', value: `<a href="mailto:${params.email}">${escapeHtml(params.email)}</a>` },
      ...(params.phone
        ? [{ label: 'Telefon', value: `<a href="tel:${params.phone}">${escapeHtml(params.phone)}</a>` }]
        : []),
      ...(params.serviceKind ? [{ label: 'Leistung', value: escapeHtml(params.serviceKind) }] : []),
    ])}
    <p style="background:#F8FAFC;border-radius:12px;padding:16px;white-space:pre-wrap;">${escapeHtml(params.message)}</p>
    ${button('Lead im CRM öffnen', params.adminUrl)}`;

  return {
    subject: `🔔 Neue Anfrage von ${params.name}`,
    html: renderEmail('Neue Anfrage', body),
  };
}

export function newBookingInternalEmail(params: {
  bookingNumber: string;
  customerName: string;
  serviceName: string;
  scheduledStart: Date;
  grossTotal: number;
  adminUrl: string;
}): EmailContent {
  const body = `
    <p>Es ist eine neue Online-Buchung eingegangen.</p>
    ${infoTable([
      { label: 'Buchung', value: escapeHtml(params.bookingNumber) },
      { label: 'Kunde', value: escapeHtml(params.customerName) },
      { label: 'Leistung', value: escapeHtml(params.serviceName) },
      { label: 'Termin', value: formatDateTime(params.scheduledStart) },
      { label: 'Betrag', value: formatCurrency(params.grossTotal) },
    ])}
    ${button('Buchung bestätigen', params.adminUrl)}`;

  return {
    subject: `🗓️ Neue Buchung ${params.bookingNumber}`,
    html: renderEmail('Neue Buchung', body),
  };
}

export function contactAutoReplyEmail(params: { firstName: string }): EmailContent {
  const body = `
    <p>Guten Tag ${escapeHtml(params.firstName)}</p>
    <p>Vielen Dank für Ihre Nachricht. Wir haben sie erhalten und melden uns innerhalb eines Arbeitstages bei Ihnen.</p>
    <p>Dringend? Rufen Sie uns an: <a href="tel:${brand.phone.replace(/\s/g, '')}" style="color:${brand.primaryColor};">${escapeHtml(brand.phone)}</a></p>
    ${button('Sofort-Offerte berechnen', `${app}/offerte`)}`;

  return {
    subject: 'Wir haben Ihre Anfrage erhalten',
    html: renderEmail('Danke für Ihre Anfrage', body),
  };
}
