import { definePublicRoute } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { randomToken } from '@/lib/auth/jwt';
import { absoluteUrl } from '@/lib/utils';
import { sendEmail } from '@/lib/email/client';
import { renderEmail, button } from '@/lib/email/layout';
import { newsletterSchema } from '@/lib/validation/crm';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/public/newsletter
 *
 * Double-Opt-in-Anmeldung. Die Antwort ist immer identisch — auch bei einer
 * bereits eingetragenen Adresse. So lässt sich über das Formular nicht
 * herausfinden, wer Kunde ist.
 */
export const POST = definePublicRoute({
  body: newsletterSchema,
  rateLimit: 'newsletter',
  handler: async ({ body }) => {
    const organizationId = await getOrganizationId();
    const email = body.email.toLowerCase();

    const existing = await prisma.newsletterSubscriber.findUnique({
      where: { organizationId_email: { organizationId, email } },
    });

    // Bereits bestätigt: nichts tun, aber gleich antworten.
    if (existing?.confirmed && !existing.unsubscribedAt) {
      return created({ status: 'pending' });
    }

    const confirmToken = randomToken(24);

    const subscriber = await prisma.newsletterSubscriber.upsert({
      where: { organizationId_email: { organizationId, email } },
      update: {
        firstName: body.firstName ?? existing?.firstName ?? null,
        confirmToken,
        confirmed: false,
        unsubscribedAt: null,
        source: body.source ?? existing?.source ?? null,
      },
      create: {
        organizationId,
        email,
        firstName: body.firstName ?? null,
        locale: body.locale,
        confirmToken,
        source: body.source ?? null,
      },
    });

    const confirmUrl = absoluteUrl(`/newsletter/bestaetigen?token=${confirmToken}`);
    const greeting = body.firstName ? `Guten Tag ${body.firstName}` : 'Guten Tag';

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

    return created({ status: 'pending' });
  },
});
