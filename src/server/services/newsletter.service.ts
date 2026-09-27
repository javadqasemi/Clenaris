import 'server-only';

import { audit } from '@/lib/audit';
import { randomToken } from '@/lib/auth/jwt';
import { prisma } from '@/lib/db';
import { sendEmail } from '@/lib/email/client';
import { button, renderEmail } from '@/lib/email/layout';
import { NotFoundError } from '@/lib/errors';
import { absoluteUrl } from '@/lib/utils';
import type { NewsletterInput } from '@/lib/validation/crm';

/**
 * Newsletter: Anmeldung, Bestätigung, Abmeldung über die Website.
 *
 * Vorher an drei Stellen geschrieben (bis 2026-09-27): die Anmeldung im
 * Endpunkt, Bestätigung und Abmeldung **in den Seiten selbst** — ein
 * Server Component, das beim Aufruf schrieb, ohne Organisation im `where`
 * und ohne Protokollzeile. Zwei Folgen davon waren schlimmer als die
 * Schichtregel:
 *
 *  • **Ein GET schrieb.** Sicherheitsfilter der Mailanbieter rufen Links in
 *    E-Mails vorab auf. Sie bestätigten damit Anmeldungen, die die Person nie
 *    bestätigt hatte — das Double-Opt-in bewies nichts mehr — und trugen
 *    Abonnenten aus, die nie abbestellen wollten. Jetzt zeigt die Seite nur
 *    an, und erst der Klick auf die Schaltfläche schickt ein POST.
 *  • **Kein Nachweis.** Die Einwilligung (DSGVO Art. 7 Abs. 1) und ihr
 *    Widerruf standen in keinem Protokoll.
 *
 * Der Token wird mit der Organisation dieser Installation gesucht; ein
 * fremder ist schlicht unbekannt, wie jeder öffentliche Link.
 */

export async function newsletterAnmelden(params: {
  organizationId: string;
  input: NewsletterInput;
  ip?: string | null;
}): Promise<void> {
  const { organizationId, input } = params;
  const email = input.email.toLowerCase();

  const existing = await prisma.newsletterSubscriber.findUnique({
    where: { organizationId_email: { organizationId, email } },
  });

  // Bereits bestätigt: nichts tun, aber gleich antworten (der Aufrufer
  // antwortet immer gleich — das Formular verrät nicht, wer eingetragen ist).
  if (existing?.confirmed && !existing.unsubscribedAt) return;

  const confirmToken = randomToken(24);

  const subscriber = await prisma.newsletterSubscriber.upsert({
    where: { organizationId_email: { organizationId, email } },
    update: {
      firstName: input.firstName ?? existing?.firstName ?? null,
      confirmToken,
      confirmed: false,
      unsubscribedAt: null,
      source: input.source ?? existing?.source ?? null,
    },
    create: {
      organizationId,
      email,
      firstName: input.firstName ?? null,
      locale: input.locale,
      confirmToken,
      source: input.source ?? null,
    },
  });

  /*
    Eine Protokollzeile je Anmeldung — der erste Schritt der Einwilligung.
    Ohne handelnde Person, mit der Adresse der Anfrage; die E-Mail-Adresse
    und der Token stehen nicht in der Zeile. Keine Zeile für eine bereits
    bestätigte Adresse (oben): Dort wird nichts geschrieben.
  */
  await (existing ? audit.updated : audit.created)({
    organizationId,
    entity: 'NewsletterSubscriber',
    entityId: subscriber.id,
    summary: existing
      ? 'Newsletter-Anmeldung über die Website erneuert — Bestätigung ausstehend'
      : 'Newsletter-Anmeldung über die Website eingegangen — Bestätigung ausstehend',
    ip: params.ip ?? undefined,
  });

  const confirmUrl = absoluteUrl(`/newsletter/bestaetigen?token=${confirmToken}`);
  const greeting = input.firstName ? `Guten Tag ${input.firstName}` : 'Guten Tag';

  await sendEmail({
    to: email,
    subject: 'Bitte bestätigen Sie Ihre Newsletter-Anmeldung',
    html: renderEmail(
      'Noch ein Klick',
      `<p>${greeting}</p>
       <p>Bitte bestätigen Sie, dass Sie unseren Newsletter erhalten möchten. Wir schreiben rund einmal im Monat — mit praktischen Reinigungstipps und gelegentlich einem Aktionscode.</p>
       ${button('Anmeldung bestätigen', confirmUrl)}
       <p style="color:#64748B;font-size:14px;">Haben Sie sich nicht angemeldet? Dann ignorieren Sie diese E-Mail einfach — ohne Bestätigung senden wir Ihnen nichts.</p>`,
      {
        preheader: 'Ein Klick, dann sind Sie dabei.',
        unsubscribeUrl: absoluteUrl(`/newsletter/abmelden?token=${subscriber.unsubscribeToken}`),
      },
    ),
    templateKey: 'newsletter_confirm',
    entity: 'NewsletterSubscriber',
    entityId: subscriber.id,
  });
}

/**
 * Was die Seite vor dem Klick anzeigen darf — nur lesen.
 *
 * `offen`: Der Link gilt, die Schaltfläche wird angeboten. `erledigt`: schon
 * bestätigt bzw. schon abgemeldet. `unbekannt`: kein solcher Link.
 */
export async function newsletterLinkStand(
  organizationId: string,
  art: 'bestaetigen' | 'abmelden',
  token: string | undefined,
): Promise<'offen' | 'erledigt' | 'unbekannt'> {
  if (!token) return 'unbekannt';
  const eintrag = await prisma.newsletterSubscriber.findFirst({
    where: art === 'bestaetigen' ? { organizationId, confirmToken: token } : { organizationId, unsubscribeToken: token },
    select: { confirmed: true, unsubscribedAt: true },
  });
  if (!eintrag) return 'unbekannt';
  if (art === 'bestaetigen') return eintrag.confirmed ? 'erledigt' : 'offen';
  return eintrag.unsubscribedAt ? 'erledigt' : 'offen';
}

/**
 * Die Anmeldung bestätigen. Der Bestätigungstoken wird dabei entwertet; ein
 * zweiter Klick findet ihn nicht mehr und ist „unbekannt" (404). Bedingter
 * Übergang: Zwei gleichzeitige Klicks bestätigen und protokollieren einmal.
 */
export async function newsletterBestaetigen(params: { organizationId: string; token: string; ip?: string | null }): Promise<void> {
  const eintrag = await prisma.newsletterSubscriber.findFirst({
    where: { organizationId: params.organizationId, confirmToken: params.token },
    select: { id: true },
  });
  if (!eintrag) throw new NotFoundError('Bestätigungslink');

  const bestaetigt = await prisma.newsletterSubscriber.updateMany({
    where: { id: eintrag.id, confirmToken: params.token },
    data: { confirmed: true, confirmToken: null, unsubscribedAt: null },
  });
  if (bestaetigt.count === 0) throw new NotFoundError('Bestätigungslink');

  await audit.updated({
    organizationId: params.organizationId,
    entity: 'NewsletterSubscriber',
    entityId: eintrag.id,
    summary: 'Newsletter-Anmeldung bestätigt (Double Opt-in)',
    changes: { confirmed: true },
    ip: params.ip ?? undefined,
  });
}

/**
 * Abmelden mit einem Klick. Der Abmeldetoken bleibt gültig — wer nach einer
 * erneuten Anmeldung wieder abbestellt, braucht keinen neuen Link. Eine
 * zweite Abmeldung ändert nichts und schreibt nichts.
 */
export async function newsletterAbmelden(params: { organizationId: string; token: string; ip?: string | null }): Promise<{ email: string }> {
  const eintrag = await prisma.newsletterSubscriber.findFirst({
    where: { organizationId: params.organizationId, unsubscribeToken: params.token },
    select: { id: true, email: true },
  });
  if (!eintrag) throw new NotFoundError('Abmeldelink');

  const abgemeldet = await prisma.newsletterSubscriber.updateMany({
    where: { id: eintrag.id, unsubscribedAt: null },
    data: { unsubscribedAt: new Date(), confirmed: false },
  });
  if (abgemeldet.count > 0) {
    await audit.deleted({
      organizationId: params.organizationId,
      entity: 'NewsletterSubscriber',
      entityId: eintrag.id,
      summary: 'Newsletter über den Abmeldelink abbestellt',
      ip: params.ip ?? undefined,
    });
  }
  return { email: eintrag.email };
}
