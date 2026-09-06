import { definePublicRoute } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { absoluteUrl } from '@/lib/utils';
import { sendEmail } from '@/lib/email/client';
import { button, renderEmail } from '@/lib/email/layout';
import { publicApplicationSchema } from '@/lib/validation/content';
import { getOrganizationId } from '@/server/services/organization.service';
import { notifyStaff } from '@/server/services/notification.service';

export const runtime = 'nodejs';

/**
 * POST /api/public/applications
 *
 * Bewerbung auf eine ausgeschriebene Stelle. Bewerbungsunterlagen sind
 * besonders schützenswerte Personendaten: sie landen nur in der Datenbank und
 * im internen Bereich, nie in einer E-Mail an eine Sammeladresse.
 */
export const POST = definePublicRoute({
  body: publicApplicationSchema,
  rateLimit: 'contactForm',
  handler: async ({ body }) => {
    const organizationId = await getOrganizationId();

    const posting = await prisma.jobPosting.findFirst({
      where: { id: body.postingId, organizationId, status: 'PUBLISHED' },
      select: { id: true, title: true },
    });
    if (!posting) throw new NotFoundError('Stelleninserat');

    const application = await prisma.jobApplication.create({
      data: {
        postingId: posting.id,
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email,
        phone: body.phone,
        message: body.message ?? null,
        cvUrl: body.cvUrl ?? null,
        availableFrom: body.availableFrom ?? null,
      },
    });

    // Eingangsbestätigung an die bewerbende Person.
    await sendEmail({
      to: body.email,
      subject: `Ihre Bewerbung als ${posting.title}`,
      html: renderEmail(
        'Bewerbung erhalten',
        `<p>Guten Tag ${body.firstName}</p>
         <p>Vielen Dank für Ihre Bewerbung als <strong>${posting.title}</strong>. Wir sichten Ihre Unterlagen und melden uns innerhalb von fünf Arbeitstagen — auch dann, wenn es diesmal nicht passt.</p>
         <p>Falls Sie in der Zwischenzeit Fragen haben, antworten Sie einfach auf diese E-Mail.</p>`,
        { preheader: 'Wir melden uns innerhalb von fünf Arbeitstagen.' },
      ),
      templateKey: 'application_received',
      entity: 'JobApplication',
      entityId: application.id,
    });

    await notifyStaff({
      organizationId,
      title: 'Neue Bewerbung',
      body: `${body.firstName} ${body.lastName} · ${posting.title}`,
      link: '/admin/personal/bewerbungen',
      emailContent: {
        subject: `Neue Bewerbung: ${posting.title}`,
        html: renderEmail(
          'Neue Bewerbung',
          `<p><strong>${body.firstName} ${body.lastName}</strong> hat sich als ${posting.title} beworben.</p>
           <p>E-Mail: ${body.email}<br>Telefon: ${body.phone}</p>
           ${body.message ? `<p style="background:#F8FAFC;border-radius:12px;padding:16px;white-space:pre-wrap;">${body.message}</p>` : ''}
           ${button('Bewerbung öffnen', absoluteUrl('/admin/personal/bewerbungen'))}`,
        ),
      },
    });

    return created({ id: application.id, status: 'received' });
  },
});
