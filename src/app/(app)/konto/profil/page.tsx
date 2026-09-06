import type { Metadata } from 'next';
import { ShieldCheck } from 'lucide-react';

import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/auth/session';
import { formatDate, formatPhone, formatRelative } from '@/lib/utils';
import { ROLE_LABELS } from '@/lib/auth/rbac';
import { Badge } from '@/components/ui/badge';
import { DetailRow, DetailSection, PageHeader } from '@/components/app/page-parts';
import { ProfileForm } from '@/features/account/profile-form';
import { PasswordChangeForm } from '@/features/account/password-change-form';
import { TwoFactorSettings } from '@/features/account/two-factor-settings';
import { getTwoFactorStatus } from '@/server/services/two-factor.service';

export const metadata: Metadata = {
  title: 'Mein Profil',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Profilseite.
 *
 * Sie ist für alle Rollen identisch — Kontaktdaten, Benachrichtigungen,
 * Passwort und Datenschutzrechte. Rollenabhängige Informationen (Anstellung,
 * Kundendaten) stehen in den jeweiligen Bereichen.
 */
export default async function ProfilePage() {
  const session = await requireSession();

  const twoFactor = await getTwoFactorStatus(session.id);

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: session.id },
    select: {
      id: true,
      email: true,
      emailVerified: true,
      firstName: true,
      lastName: true,
      phone: true,
      locale: true,
      role: true,
      theme: true,
      notifyByEmail: true,
      notifyBySms: true,
      marketingOptIn: true,
      lastLoginAt: true,
      createdAt: true,
      passwordChangedAt: true,
      customer: { select: { number: true } },
      employee: { select: { employeeNumber: true, position: true } },
      _count: { select: { refreshTokens: true } },
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Mein Profil"
        description="Kontaktdaten, Benachrichtigungen und Sicherheit Ihres Kontos."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <div className="space-y-6">
          <DetailSection title="Kontaktdaten">
            <div className="py-4">
              <ProfileForm
                defaults={{
                  firstName: user.firstName,
                  lastName: user.lastName,
                  phone: user.phone ?? '',
                  locale: user.locale,
                  notifyByEmail: user.notifyByEmail,
                  notifyBySms: user.notifyBySms,
                  marketingOptIn: user.marketingOptIn,
                }}
              />
            </div>
          </DetailSection>

          <DetailSection title="Passwort ändern">
            <div className="py-4">
              <PasswordChangeForm />
            </div>
          </DetailSection>

          <TwoFactorSettings
            status={{
              enabled: twoFactor.enabled,
              // Über die Grenze zur Client-Komponente geht eine Zeichenkette,
              // nicht das Date-Objekt: die Formatierung braucht ohnehin die
              // Zeitzone Europe/Zurich und nicht die des Servers.
              confirmedAt: twoFactor.confirmedAt?.toISOString() ?? null,
              remainingRecoveryCodes: twoFactor.remainingRecoveryCodes,
            }}
          />
        </div>

        <div className="space-y-6">
          <DetailSection title="Konto">
            <dl className="protocol-list">
              <DetailRow label="E-Mail">
                <span className="flex flex-wrap items-center gap-2">
                  {user.email}
                  {user.emailVerified ? (
                    <Badge variant="success" size="sm">
                      Bestätigt
                    </Badge>
                  ) : (
                    <Badge variant="warning" size="sm">
                      Nicht bestätigt
                    </Badge>
                  )}
                </span>
              </DetailRow>
              {user.phone ? (
                <DetailRow label="Telefon">{formatPhone(user.phone)}</DetailRow>
              ) : null}
              <DetailRow label="Rolle">{ROLE_LABELS[user.role]}</DetailRow>
              {user.customer ? (
                <DetailRow label="Kundennummer">{user.customer.number}</DetailRow>
              ) : null}
              {user.employee ? (
                <DetailRow label="Personalnummer">
                  {user.employee.employeeNumber} · {user.employee.position}
                </DetailRow>
              ) : null}
              <DetailRow label="Konto seit">{formatDate(user.createdAt)}</DetailRow>
              {user.lastLoginAt ? (
                <DetailRow label="Letzte Anmeldung">
                  {formatRelative(user.lastLoginAt)}
                </DetailRow>
              ) : null}
            </dl>
          </DetailSection>

          <DetailSection title="Sicherheit">
            <dl className="protocol-list">
              <DetailRow label="Passwort geändert">
                {formatDate(user.passwordChangedAt)}
              </DetailRow>
              <DetailRow label="Aktive Sitzungen">
                <span className="flex items-center gap-2">
                  <ShieldCheck className="size-3.5 text-primary" aria-hidden />
                  {user._count.refreshTokens} Gerät(e)
                </span>
              </DetailRow>
            </dl>
            <p className="py-4 text-sm leading-relaxed text-muted-foreground">
              Bei einer Passwortänderung werden alle anderen Sitzungen automatisch beendet.
            </p>
          </DetailSection>

          <DetailSection title="Ihre Datenschutzrechte">
            <p className="py-4 text-sm leading-relaxed text-muted-foreground">
              Sie können jederzeit Auskunft über Ihre Daten verlangen, sie berichtigen oder löschen
              lassen. Eine E-Mail genügt — wir antworten innerhalb von 30 Tagen und kostenlos.
              Details in der{' '}
              <a
                href="/legal/datenschutz"
                className="text-primary underline underline-offset-4"
              >
                Datenschutzerklärung
              </a>
              .
            </p>
          </DetailSection>
        </div>
      </div>
    </div>
  );
}
