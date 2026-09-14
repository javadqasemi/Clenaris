'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Save, UserMinus, UserPlus } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Alert, PersonAvatar } from '@/components/ui/primitives';
import { Checkbox } from '@/components/ui/controls';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/controls';

/**
 * Team eines Einsatzes zusammenstellen.
 *
 * Gestaltungsentscheide:
 *
 *  • **Rolle je Person, nicht „die erste ist die Leitung".** Im Kalender ist
 *    die schnelle Geste richtig; hier steht die Aufstellung, und eine lernende
 *    Person ist etwas anderes als eine Aufsicht — für die Nachkalkulation wie
 *    für die Verantwortung vor Ort.
 *
 *  • **Benachrichtigt werden nur die Neuen.** Das entscheidet der Server. Wer
 *    schon eingeteilt war, bekommt keine zweite „Neuer Einsatz"-Meldung, nur
 *    weil jemand dazukam.
 *
 *  • **Der Zusagestand steht neben dem Namen.** Eine Zuteilung ohne Zusage ist
 *    keine Planung, sondern eine Hoffnung — das muss man sehen, ohne zu
 *    klicken.
 */

export interface TeamEmployee {
  id: string;
  firstName: string;
  lastName: string;
  color: string;
  avatarUrl: string | null;
}

export interface TeamMember {
  employeeId: string;
  role: string;
  state: 'accepted' | 'declined' | 'open';
}

const ROLES = [
  { value: 'LEAD', label: 'Leitung' },
  { value: 'MEMBER', label: 'Team' },
  { value: 'TRAINEE', label: 'Lernende' },
  { value: 'SUPERVISOR', label: 'Aufsicht' },
] as const;

const STATE_LABEL: Record<TeamMember['state'], string> = {
  accepted: 'zugesagt',
  declined: 'abgesagt',
  open: 'noch offen',
};

export function JobTeamEditor({
  jobId,
  employees,
  members: initial,
  crewSize,
  readOnly = false,
}: {
  jobId: string;
  employees: TeamEmployee[];
  members: TeamMember[];
  crewSize: number;
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [members, setMembers] = React.useState<TeamMember[]>(initial);
  const [notify, setNotify] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const byId = React.useMemo(
    () => new Map(employees.map((employee) => [employee.id, employee])),
    [employees],
  );

  const available = employees.filter(
    (employee) => !members.some((member) => member.employeeId === employee.id),
  );

  const dirty = React.useMemo(
    () =>
      JSON.stringify(members.map((m) => [m.employeeId, m.role])) !==
      JSON.stringify(initial.map((m) => [m.employeeId, m.role])),
    [members, initial],
  );

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.put(`/api/jobs/${jobId}/team`, {
        notify,
        members: members.map((member) => ({ employeeId: member.employeeId, role: member.role })),
      });
      toast.success(
        members.length === 0 ? 'Zuteilung aufgehoben.' : 'Team gespeichert.',
      );
      router.refresh();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Das Team konnte nicht gespeichert werden.';
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  if (readOnly) {
    return members.length === 0 ? (
      <p className="py-6 text-sm text-muted-foreground">Niemand zugeteilt.</p>
    ) : (
      <ul className="protocol-list">
        {members.map((member) => {
          const employee = byId.get(member.employeeId);
          if (!employee) return null;
          return (
            <li key={member.employeeId} className="flex items-center gap-3 py-3">
              <PersonAvatar
                firstName={employee.firstName}
                lastName={employee.lastName}
                src={employee.avatarUrl}
                color={employee.color}
                size="sm"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {employee.firstName} {employee.lastName}
                </p>
                <p className="text-xs text-muted-foreground">
                  {ROLES.find((role) => role.value === member.role)?.label ?? member.role} ·{' '}
                  {STATE_LABEL[member.state]}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="space-y-4 py-4">
      {error ? <Alert variant="destructive">{error}</Alert> : null}

      {members.length === 0 ? (
        <p className="text-sm text-warning">
          Noch niemand zugeteilt. Ohne Team bleibt der Einsatz auf &bdquo;nicht zugeteilt&ldquo;
          und erscheint in der Disposition als offen.
        </p>
      ) : (
        <ul className="space-y-2">
          {members.map((member, index) => {
            const employee = byId.get(member.employeeId);
            if (!employee) return null;

            return (
              <li
                key={member.employeeId}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3"
              >
                <PersonAvatar
                  firstName={employee.firstName}
                  lastName={employee.lastName}
                  src={employee.avatarUrl}
                  color={employee.color}
                  size="sm"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {employee.firstName} {employee.lastName}
                  </p>
                  <p className="text-xs text-muted-foreground">{STATE_LABEL[member.state]}</p>
                </div>

                <Select
                  value={member.role}
                  onValueChange={(role) =>
                    setMembers((current) =>
                      current.map((entry, i) => (i === index ? { ...entry, role } : entry)),
                    )
                  }
                >
                  <SelectTrigger
                    className="w-36"
                    aria-label={`Rolle von ${employee.firstName} ${employee.lastName}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.map((role) => (
                      <SelectItem key={role.value} value={role.value}>
                        {role.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setMembers((current) => current.filter((_, i) => i !== index))}
                  aria-label={`${employee.firstName} ${employee.lastName} entfernen`}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <UserMinus aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {members.length > 0 && members.length < crewSize ? (
        <p className="text-sm text-warning">
          Für diesen Einsatz sind {crewSize} Personen vorgesehen — aktuell sind {members.length}{' '}
          eingeteilt.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {available.length > 0 ? (
          <Select
            value=""
            onValueChange={(employeeId) =>
              setMembers((current) => [
                ...current,
                // Die erste Person eines leeren Teams ist die Leitung — jeder
                // Einsatz braucht genau eine verantwortliche Person.
                { employeeId, role: current.length === 0 ? 'LEAD' : 'MEMBER', state: 'open' },
              ])
            }
          >
            <SelectTrigger className="w-60" aria-label="Person hinzufügen">
              <span className="flex items-center gap-2">
                <UserPlus className="size-4" aria-hidden />
                <SelectValue placeholder="Person hinzufügen …" />
              </span>
            </SelectTrigger>
            <SelectContent>
              {available.map((employee) => (
                <SelectItem key={employee.id} value={employee.id}>
                  {employee.firstName} {employee.lastName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        <label className="ml-auto flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <Checkbox checked={notify} onCheckedChange={(checked) => setNotify(checked === true)} />
          Neu zugeteilte Personen benachrichtigen
        </label>

        <Button type="button" size="sm" onClick={save} loading={saving} disabled={!dirty}>
          <Save aria-hidden />
          Team speichern
        </Button>
      </div>
    </div>
  );
}
