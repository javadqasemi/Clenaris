'use client';

import { UserRoundMinus } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { ActionButton } from '@/components/app/action-button';
import { EmptyState } from '@/components/app/page-parts';

/**
 * Abonnentenliste mit Austragen.
 *
 * Bearbeiten gibt es bewusst nicht (siehe `newsletterListQuery`): Die
 * Adresse ist der Identifikator, der Bestätigungsstatus ein Nachweis nach
 * DSG. Austragen ist die einzige Handlung, um die eine Kundschaft je bittet —
 * und bis hierher ging sie nur über den Endpunkt.
 */
export interface SubscriberRow {
  id: string;
  email: string;
  firstName: string | null;
  locale: string;
  confirmed: boolean;
  source: string | null;
  createdAt: string;
}

export function NewsletterList({
  subscribers,
  canDelete,
}: {
  subscribers: SubscriberRow[];
  canDelete: boolean;
}) {
  if (subscribers.length === 0) {
    return (
      <EmptyState
        title="Noch keine Abonnenten"
        description="Anmeldungen kommen über das Formular in der Fusszeile der Website und laufen über eine Bestätigung per E-Mail."
      />
    );
  }

  return (
    <dl className="protocol-list">
      {subscribers.map((subscriber) => (
        <div key={subscriber.id} className="protocol-row">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              <dt className="protocol-label truncate">{subscriber.email}</dt>
              <dd className="protocol-value flex flex-wrap items-center gap-2 font-normal">
                <Badge variant={subscriber.confirmed ? 'success' : 'warning'} size="sm">
                  {subscriber.confirmed ? 'Bestätigt' : 'Unbestätigt'}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  {[
                    subscriber.firstName,
                    subscriber.locale,
                    subscriber.source,
                    new Date(subscriber.createdAt).toLocaleDateString('de-CH'),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </dd>
            </div>
            {canDelete ? (
              <ActionButton
                endpoint={`/api/newsletter/${subscriber.id}`}
                method="DELETE"
                label="Austragen"
                aria-label={`${subscriber.email} austragen`}
                variant="ghost"
                size="icon"
                confirmTitle="Abonnement austragen?"
                confirm={`${subscriber.email} erhält keinen Newsletter mehr. Die Zeile bleibt als Nachweis des Widerspruchs bestehen.`}
                successMessage="Abonnement ausgetragen."
              >
                <UserRoundMinus aria-hidden />
              </ActionButton>
            ) : null}
          </div>
        </div>
      ))}
    </dl>
  );
}
