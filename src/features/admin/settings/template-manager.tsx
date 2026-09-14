'use client';

import { Mail, MessageSquare, PenLine } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { FormDialog, type FieldSpec } from '@/components/app/resource-form';
import { EmptyState } from '@/components/app/page-parts';

/**
 * E-Mail- und SMS-Vorlagen bearbeiten.
 *
 * Anlegen und Löschen gibt es bewusst nicht — der Schlüssel steht im Code,
 * dort wird die Vorlage nachgeschlagen (siehe `GET /api/templates`). Was die
 * Redaktion ändern darf, ist der Text, und dafür gab es bis hierher keine
 * Maske: Die Einstellungsseite nannte nur die Zahl der Vorlagen.
 *
 * Platzhalter (`{{customer.firstName}}`) dürfen wegfallen, aber keine neuen
 * dazukommen — der Endpunkt prüft das und nennt in der Fehlermeldung die
 * verfügbaren. Deshalb steht hier keine zweite Prüfung: Sie liefe der
 * serverseitigen nur hinterher.
 */
export interface EmailTemplateRow {
  id: string;
  key: string;
  locale: string;
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
  active: boolean;
}

export interface SmsTemplateRow {
  id: string;
  key: string;
  locale: string;
  body: string;
  active: boolean;
}

const EMAIL_FIELDS: FieldSpec[] = [
  { name: 'subject', label: 'Betreff', required: true },
  {
    name: 'bodyHtml',
    label: 'Text (HTML)',
    type: 'textarea',
    rows: 12,
    required: true,
    hint: 'Platzhalter wie {{customer.firstName}} bleiben erhalten; neue lassen sich nicht erfinden.',
  },
  {
    name: 'bodyText',
    label: 'Nur-Text-Fassung',
    type: 'textarea',
    rows: 6,
    emptyAsString: true,
    hint: 'Für Mailprogramme ohne HTML. Leer = wird aus dem HTML abgeleitet.',
  },
  { name: 'active', label: 'Aktiv — überschreibt die eingebaute Vorlage', type: 'checkbox' },
];

const SMS_FIELDS: FieldSpec[] = [
  {
    name: 'body',
    label: 'Text',
    type: 'textarea',
    rows: 4,
    required: true,
    hint: 'Höchstens 480 Zeichen — darüber kostet der Versand mehr als drei SMS je Empfänger.',
  },
  { name: 'active', label: 'Aktiv — überschreibt die eingebaute Vorlage', type: 'checkbox' },
];

export function TemplateList({
  email,
  sms,
  canEdit,
}: {
  email: EmailTemplateRow[];
  sms: SmsTemplateRow[];
  canEdit: boolean;
}) {
  if (email.length === 0 && sms.length === 0) {
    return (
      <EmptyState
        title="Keine Datenbankvorlagen"
        description="Die Transaktions-E-Mails laufen über die eingebauten Vorlagen. Eine Datenbankvorlage entsteht mit dem Seed und überschreibt sie je Sprache."
      />
    );
  }

  return (
    <dl className="protocol-list">
      {email.map((template) => (
        <div key={template.id} className="protocol-row">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <dt className="protocol-label">
                <span className="flex items-center gap-2">
                  <Mail className="size-3.5 text-primary" aria-hidden />
                  <code className="text-xs">{template.key}</code>
                  <Badge variant="outline" size="sm">
                    {template.locale}
                  </Badge>
                </span>
              </dt>
              <dd className="protocol-value flex flex-wrap items-center gap-2 font-normal">
                <Badge variant={template.active ? 'success' : 'neutral'} size="sm">
                  {template.active ? 'Aktiv' : 'Inaktiv'}
                </Badge>
                <span className="truncate text-sm text-muted-foreground">{template.subject}</span>
              </dd>
            </div>
            {canEdit ? (
              <FormDialog
                title={`E-Mail-Vorlage „${template.key}" (${template.locale})`}
                triggerLabel="Bearbeiten"
                triggerVariant="ghost"
                triggerSize="icon"
                triggerIcon={<PenLine aria-hidden />}
                size="xl"
                endpoint={`/api/templates/email/${template.id}`}
                method="PATCH"
                fields={EMAIL_FIELDS}
                values={{
                  subject: template.subject,
                  bodyHtml: template.bodyHtml,
                  bodyText: template.bodyText ?? '',
                  active: template.active,
                }}
                successMessage="Vorlage gespeichert."
              />
            ) : null}
          </div>
        </div>
      ))}

      {sms.map((template) => (
        <div key={template.id} className="protocol-row">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <dt className="protocol-label">
                <span className="flex items-center gap-2">
                  <MessageSquare className="size-3.5 text-primary" aria-hidden />
                  <code className="text-xs">{template.key}</code>
                  <Badge variant="outline" size="sm">
                    {template.locale}
                  </Badge>
                </span>
              </dt>
              <dd className="protocol-value flex flex-wrap items-center gap-2 font-normal">
                <Badge variant={template.active ? 'success' : 'neutral'} size="sm">
                  {template.active ? 'Aktiv' : 'Inaktiv'}
                </Badge>
                <span className="truncate text-sm text-muted-foreground">{template.body}</span>
              </dd>
            </div>
            {canEdit ? (
              <FormDialog
                title={`SMS-Vorlage „${template.key}" (${template.locale})`}
                triggerLabel="Bearbeiten"
                triggerVariant="ghost"
                triggerSize="icon"
                triggerIcon={<PenLine aria-hidden />}
                size="md"
                endpoint={`/api/templates/sms/${template.id}`}
                method="PATCH"
                fields={SMS_FIELDS}
                values={{ body: template.body, active: template.active }}
                successMessage="Vorlage gespeichert."
              />
            ) : null}
          </div>
        </div>
      ))}
    </dl>
  );
}
