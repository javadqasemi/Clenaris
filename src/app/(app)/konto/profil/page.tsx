import type { Metadata } from 'next';

import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/auth/session';
import { formatDate, formatPhone, formatRelative } from '@/lib/utils';
import { ROLE_LABELS } from '@/lib/auth/rbac';
import { Badge } from '@/components/ui/badge';
import { DetailRow, DetailSection, PageHeader } from '@/components/app/page-parts';
import { AvatarUploader } from '@/features/account/avatar-uploader';
import { ProfileContactRows } from '@/features/account/profile-details';
import { ProfileEditDialog } from '@/features/account/profile-edit-dialog';
import { ProfileTabs } from '@/features/account/profile-tabs';

export const metadata: Metadata = {
  title: 'Mein Profil',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Profilseite.
 *
 * Sie ist für alle Rollen identisch — die Person: Bild, Kontaktdaten, Konto
 * und Datenschutzrechte. Benachrichtigungen, Darstellung, Passwort und
 * zweiter Faktor stehen seit 2026-09-26 unter „Einstellungen"
 * (`…/profil/einstellungen`); warum, steht in
 * `src/features/account/profile-tabs.tsx`. Rollenabhängige Informationen
 * (Anstellung, Kundendaten) stehen in den jeweiligen Bereichen.
 */
export default async function ProfilePage() {
  const session = await requireSession();

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
      avatarUrl: true,
      lastLoginAt: true,
      createdAt: true,
      customer: { select: { number: true } },
      employee: { select: { employeeNumber: true, position: true } },
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Mein Profil"
        description="Profilbild, Kontaktdaten und Konto."
      />

      <ProfileTabs />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <div className="space-y-6">
          {/*
            Profilbild und Kontaktdaten in einer Karte: Das ist die Person —
            wie sie aussieht und wie man sie erreicht. Das Bild steht oben,
            weil es das Einzige auf dieser Seite ist, das andere sehen (in der
            Zuteilung, im Einsatzbericht, in der Nachrichtenspalte); darunter
            die Angaben in Tabellenform, Beschriftung links, Wert rechts.

            Ein Weg zum Ändern: der Knopf „Bearbeiten" in der Kopfzeile öffnet
            alle vier Angaben in einem Dialog. Die Stifte je Zeile sind hier
            bewusst aus — ein zweiter Weg für dieselben Angaben war nicht
            gewünscht.
          */}
          <DetailSection
            title="Profil"
            description="Profilbild und Kontaktdaten."
            action={
              <ProfileEditDialog
                values={{
                  firstName: user.firstName,
                  lastName: user.lastName,
                  phone: user.phone ?? '',
                  locale: user.locale,
                }}
              />
            }
          >
            <div className="border-b border-border/70">
              <AvatarUploader
                firstName={user.firstName}
                lastName={user.lastName}
                avatarUrl={user.avatarUrl}
              />
            </div>
            <ProfileContactRows
              columns
              readOnly
              values={{
                firstName: user.firstName,
                lastName: user.lastName,
                phone: user.phone ?? '',
                locale: user.locale,
              }}
            />
          </DetailSection>

        </div>

        <div className="space-y-6">
          {/*
            Konto steht in der Seitenspalte, so breit wie der Datenschutz
            darunter — die Karten, die man liest und nicht bearbeitet, gehören
            zusammen an den Rand. Die Sicherheitsübersicht (Passwortdatum,
            Sitzungen) steht bei den Einstellungen, neben dem Passwortformular,
            auf das sie sich bezieht.
          */}
          <DetailSection title="Konto">
            <dl className="protocol-list protocol-list--columns">
              {/*
                Die E-Mail-Adresse ist bewusst nicht hier änderbar: Ein Wechsel
                muss über einen Bestätigungslink an die *neue* Adresse laufen,
                sonst liesse sich ein Konto durch blosse Adressänderung
                übernehmen. Ein Stift an dieser Zeile würde etwas versprechen,
                das der Endpunkt zu Recht verweigert.
              */}
              <DetailRow
                label="E-Mail"
                action={
                  <span className="text-2xs text-muted-foreground">
                    Nur mit Bestätigung
                  </span>
                }
              >
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
