'use client';

import { PenLine, Trash2, Zap } from 'lucide-react';

import {
  AUTOMATION_ACTION_LABELS,
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_TRIGGER_LABELS,
  AUTOMATION_TRIGGERS,
} from '@/lib/validation/operations-admin';
import { Badge } from '@/components/ui/badge';
import { ActionButton } from '@/components/app/action-button';
import { FormDialog, type FieldSpec, type FieldValues } from '@/components/app/resource-form';
import { EmptyState } from '@/components/app/page-parts';

/**
 * Automatisierungen pflegen.
 *
 * Die Endpunkte gab es längst; die Einstellungsseite zeigte die Regeln aber
 * nur an. Eine Regel abzuschalten — die häufigste Handlung, etwa „keine
 * Bewertungsanfragen während der Betriebsferien" — verlangte den Umweg über
 * die API-Dokumentation.
 *
 * Das Anlegen ist bewusst auf *eine* Aktion je Regel beschränkt. Regeln mit
 * mehreren Aktionen und Bedingungen sind selten und kommen aus dem Seed; die
 * Maske für den Alltag braucht Auslöser, Verzögerung und eine Aktion. Wer
 * mehr will, ändert die Regel über den Endpunkt — der nimmt die volle Form.
 */
export interface AutomationRow {
  id: string;
  name: string;
  description: string | null;
  trigger: string;
  delayMinutes: number;
  active: boolean;
  runs: number;
  actions: { type: string; config: Record<string, unknown> }[];
}

const TRIGGER_OPTIONS = AUTOMATION_TRIGGERS.map((value) => ({
  value,
  label: AUTOMATION_TRIGGER_LABELS[value],
}));

const ACTION_OPTIONS = AUTOMATION_ACTION_TYPES.map((value) => ({
  value,
  label: AUTOMATION_ACTION_LABELS[value],
}));

const BASE_FIELDS: FieldSpec[] = [
  { name: 'name', label: 'Name', required: true, placeholder: 'z. B. Bewertung nach Abschluss anfragen' },
  { name: 'description', label: 'Beschreibung', type: 'textarea', rows: 2, nullable: true },
  { name: 'trigger', label: 'Auslöser', type: 'select', required: true, options: TRIGGER_OPTIONS, half: true },
  {
    name: 'delayMinutes',
    label: 'Verzögerung',
    type: 'number',
    suffix: 'Min.',
    half: true,
    hint: 'Negativ = davor; nur bei terminbezogenen Auslösern sinnvoll.',
  },
  { name: 'active', label: 'Aktiv', type: 'checkbox' },
];

const CREATE_FIELDS: FieldSpec[] = [
  ...BASE_FIELDS.filter((f) => f.name !== 'active'),
  {
    name: 'actionType',
    label: 'Aktion',
    type: 'select',
    required: true,
    options: ACTION_OPTIONS,
    half: true,
  },
  {
    name: 'templateKey',
    label: 'Vorlagenschlüssel',
    half: true,
    placeholder: 'z. B. review_request',
    hint: 'Nur für E-Mail und SMS: der Schlüssel der Vorlage.',
  },
];

/** Aus den flachen Feldern die verschachtelte Form des Endpunkts bauen. */
function toCreateBody(payload: FieldValues): FieldValues {
  const { actionType, templateKey, ...rest } = payload;
  return {
    ...rest,
    active: true,
    actions: [
      {
        type: actionType,
        config: templateKey ? { templateKey } : {},
        position: 0,
      },
    ],
  };
}

export function AutomationCreateButton() {
  return (
    <FormDialog
      title="Automatisierung anlegen"
      description="Ein Auslöser, eine Aktion. Die Regel ist sofort aktiv und lässt sich in der Liste pausieren."
      triggerLabel="Automatisierung anlegen"
      triggerVariant="outline"
      triggerSize="sm"
      endpoint="/api/automations"
      fields={CREATE_FIELDS}
      values={{ delayMinutes: 0 }}
      transform={toCreateBody}
      successMessage="Automatisierung angelegt."
    />
  );
}

export function AutomationList({
  automations,
  canEdit,
}: {
  automations: AutomationRow[];
  canEdit: boolean;
}) {
  if (automations.length === 0) {
    return (
      <EmptyState
        title="Keine Automatisierungen"
        description="Erinnerungen, Bewertungsanfragen und Nachfassaufgaben laufen erst, wenn hier eine Regel steht."
      />
    );
  }

  return (
    <dl className="protocol-list">
      {automations.map((automation) => (
        <div key={automation.id} className="protocol-row">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <dt className="protocol-label">
                <span className="flex items-center gap-2">
                  <Zap className="size-3.5 text-primary" aria-hidden />
                  {automation.name}
                </span>
              </dt>
              <dd className="protocol-value flex flex-wrap items-center gap-2 font-normal">
                <Badge variant={automation.active ? 'success' : 'neutral'} size="sm">
                  {automation.active ? 'Aktiv' : 'Pausiert'}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  {AUTOMATION_TRIGGER_LABELS[automation.trigger as keyof typeof AUTOMATION_TRIGGER_LABELS] ??
                    automation.trigger}
                  {automation.delayMinutes !== 0
                    ? ` · ${Math.abs(Math.round(automation.delayMinutes / 60))} Std. ${automation.delayMinutes < 0 ? 'davor' : 'danach'}`
                    : ''}
                  {' · '}
                  {automation.actions
                    .map(
                      (action) =>
                        AUTOMATION_ACTION_LABELS[action.type as keyof typeof AUTOMATION_ACTION_LABELS] ??
                        action.type,
                    )
                    .join(', ')}
                  {' · '}
                  {automation.runs} {automation.runs === 1 ? 'Lauf' : 'Läufe'}
                </span>
                {automation.description ? (
                  <span className="basis-full text-sm text-muted-foreground">
                    {automation.description}
                  </span>
                ) : null}
              </dd>
            </div>

            {canEdit ? (
              <div className="flex shrink-0 items-center gap-1">
                <ActionButton
                  endpoint={`/api/automations/${automation.id}`}
                  method="PATCH"
                  body={{ active: !automation.active }}
                  label={automation.active ? 'Pausieren' : 'Aktivieren'}
                  variant="outline"
                  size="sm"
                  successMessage={automation.active ? 'Regel pausiert.' : 'Regel aktiviert.'}
                />
                <FormDialog
                  title="Automatisierung bearbeiten"
                  triggerLabel="Bearbeiten"
                  triggerVariant="ghost"
                  triggerSize="icon"
                  triggerIcon={<PenLine aria-hidden />}
                  endpoint={`/api/automations/${automation.id}`}
                  method="PATCH"
                  fields={BASE_FIELDS}
                  values={{
                    name: automation.name,
                    description: automation.description ?? '',
                    trigger: automation.trigger,
                    delayMinutes: automation.delayMinutes,
                    active: automation.active,
                  }}
                  successMessage="Automatisierung geändert."
                />
                <ActionButton
                  endpoint={`/api/automations/${automation.id}`}
                  method="DELETE"
                  label="Löschen"
                  aria-label={`${automation.name} löschen`}
                  variant="ghost"
                  size="icon"
                  disabled={automation.runs > 0}
                  confirmTitle="Automatisierung löschen?"
                  confirm={`„${automation.name}" wird entfernt. Eine Regel mit Laufhistorie lässt sich nur pausieren — die Läufe belegen, warum welche Nachricht verschickt wurde.`}
                  successMessage="Automatisierung gelöscht."
                >
                  <Trash2 aria-hidden />
                </ActionButton>
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </dl>
  );
}
