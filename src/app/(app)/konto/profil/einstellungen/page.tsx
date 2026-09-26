import type { Metadata } from 'next';
import { ShieldCheck } from 'lucide-react';

import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/auth/session';
import { formatDate } from '@/lib/utils';
import { DetailRow, DetailSection, PageHeader } from '@/components/app/page-parts';
import { AppearanceSection } from '@/features/account/appearance-form';
import { NotificationSwitches } from '@/features/account/profile-details';
import { PasswordChangeForm } from '@/features/account/password-change-form';
import { ProfileTabs } from '@/features/account/profile-tabs';
import { TwoFactorSettings } from '@/features/account/two-factor-settings';
import { getTwoFactorStatus } from '@/server/services/two-factor.service';

export const metadata: Metadata = {
  title: 'Persönliche Einstellungen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Persönliche Einstellungen — für jede Rolle dieselben.
 *
 * Hier steht ausschliesslich, was das *eigene* Konto betrifft:
 * Benachrichtigungen, Darstellung, Passwort und zweiter Faktor. Firmen-,
 * Preis-, Rollen- oder Sicherheitsrichtlinien erreicht man von hier aus
 * nicht; sie liegen unter `/admin/einstellungen` und `/admin/sicherheit` und
 * sind dort eigens geschützt. Warum die Seite von „Mein Profil" getrennt ist,
 * steht in `src/features/account/profile-tabs.tsx`.
 *
 * Die Wächter sind dieselben wie vorher auf der Profilseite: `requireSession()`
 * genügt, weil alles, was die Seite anzeigt, aus der eigenen Sitzung stammt,
 * und jeder Schreibweg (`PATCH /api/account/profile`, `PATCH
 * /api/auth/password`, `/api/auth/2fa/*`) schreibt ausschliesslich auf
 * `session.id` — eine fremde Benutzer-ID nimmt keiner dieser Endpunkte an.
 *
 * Hierher führt auch die erzwungene Passwortänderung (`profileRouteFor`),
 * weil das Passwortformular hier steht.
 */
export default async function PersonalSettingsPage() {
  const session = await requireSession();

  const [twoFactor, user] = await Promise.all([
    getTwoFactorStatus(session.id),
    prisma.user.findUniqueOrThrow({
      where: { id: session.id },
      select: {
        firstName: true,
        lastName: true,
        theme: true,
        notifyByEmail: true,
        notifyBySms: true,
        marketingOptIn: true,
        passwordChangedAt: true,
        _count: { select: { refreshTokens: true } },
      },
    }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Persönliche Einstellungen"
        description="Benachrichtigungen, Darstellung und Sicherheit Ihres eigenen Kontos."
      />

      <ProfileTabs />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <div className="space-y-6">
          <DetailSection title="Benachrichtigungen">
            <NotificationSwitches
              values={{
                firstName: user.firstName,
                lastName: user.lastName,
                notifyByEmail: user.notifyByEmail,
                notifyBySms: user.notifyBySms,
                marketingOptIn: user.marketingOptIn,
              }}
            />
          </DetailSection>

          <DetailSection title="Darstellung">
            <AppearanceSection
              preference={user.theme}
              firstName={user.firstName}
              lastName={user.lastName}
            />
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
        </div>
      </div>
    </div>
  );
}
