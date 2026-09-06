'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import interactionPlugin from '@fullcalendar/interaction';
import deLocale from '@fullcalendar/core/locales/de';
import type { EventClickArg, EventDropArg } from '@fullcalendar/core';
import type { EventResizeDoneArg } from '@fullcalendar/interaction';
import { toast } from 'sonner';

import { cn, formatDateTime } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/badge';
import { PersonAvatar } from '@/components/ui/primitives';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/overlays';
import { Checkbox } from '@/components/ui/controls';

/**
 * Einsatzkalender mit Drag & Drop.
 *
 * Architekturentscheide:
 *  • Verschieben wird *optimistisch* dargestellt und bei einem Fehler
 *    zurückgesetzt (`info.revert()`). Disposition ist Fliessarbeit — auf jede
 *    Serverantwort zu warten würde die Arbeit spürbar verlangsamen.
 *  • Der Server prüft jede Verschiebung erneut (Kapazität, Doppelbelegung).
 *    Die Oberfläche ist bequem, nicht autoritativ.
 *  • Ein Klick öffnet ein Seitenpanel statt einer neuen Seite: die
 *    Tagesübersicht bleibt sichtbar, während man einen Einsatz zuteilt.
 */

export interface CalendarEmployee {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  color: string;
  avatarUrl: string | null;
}

interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  backgroundColor: string;
  borderColor: string;
  resourceIds: string[];
  extendedProps: {
    number: string;
    status: string;
    serviceName: string | null;
    customerName: string;
    address: string | null;
    crew: string[];
    crewSize: number;
  };
}

export function DispatchCalendar({ employees }: { employees: CalendarEmployee[] }) {
  const router = useRouter();
  const calendarRef = React.useRef<FullCalendar>(null);

  const [events, setEvents] = React.useState<CalendarEvent[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [selected, setSelected] = React.useState<CalendarEvent | null>(null);
  const [assignees, setAssignees] = React.useState<string[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [hiddenEmployees, setHiddenEmployees] = React.useState<Set<string>>(new Set());

  const load = React.useCallback(async (from: Date, to: Date) => {
    setLoading(true);
    try {
      const data = await api.get<CalendarEvent[]>('/api/jobs/calendar', {
        from: from.toISOString(),
        to: to.toISOString(),
      });
      setEvents(data);
    } catch {
      toast.error('Der Kalender konnte nicht geladen werden.');
    } finally {
      setLoading(false);
    }
  }, []);

  const visibleEvents = React.useMemo(() => {
    if (hiddenEmployees.size === 0) return events;
    return events.filter((event) => {
      if (event.resourceIds.length === 0) return true; // nicht zugeteilt: immer zeigen
      return event.resourceIds.some((id) => !hiddenEmployees.has(id));
    });
  }, [events, hiddenEmployees]);

  const move = async (
    jobId: string,
    start: Date,
    end: Date,
    revert: () => void,
  ) => {
    try {
      await api.post(`/api/jobs/${jobId}/move`, {
        scheduledStart: start.toISOString(),
        scheduledEnd: end.toISOString(),
      });
      toast.success('Einsatz verschoben.');
      router.refresh();
    } catch (error) {
      revert();
      toast.error(
        error instanceof ApiError ? error.message : 'Der Einsatz konnte nicht verschoben werden.',
      );
    }
  };

  const openJob = (arg: EventClickArg) => {
    const event = events.find((item) => item.id === arg.event.id);
    if (!event) return;
    setSelected(event);
    // Vorbelegung: aktuell zugeteilte Personen.
    setAssignees(event.resourceIds);
  };

  const saveAssignment = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await api.post(`/api/jobs/${selected.id}/assign`, {
        employeeIds: assignees,
        notify: true,
      });
      toast.success('Zuteilung gespeichert. Das Team wurde benachrichtigt.');
      setSelected(null);

      const view = calendarRef.current?.getApi().view;
      if (view) await load(view.activeStart, view.activeEnd);
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'Die Zuteilung konnte nicht gespeichert werden.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Team-Filter */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-card p-3">
        <span className="px-2 text-sm text-muted-foreground">Team</span>
        {employees.map((employee) => {
          const hidden = hiddenEmployees.has(employee.id);
          return (
            <button
              key={employee.id}
              type="button"
              aria-pressed={!hidden}
              onClick={() =>
                setHiddenEmployees((current) => {
                  const next = new Set(current);
                  if (next.has(employee.id)) next.delete(employee.id);
                  else next.add(employee.id);
                  return next;
                })
              }
              className={cn(
                'inline-flex items-center gap-2 rounded-full border px-2 py-1 pr-3 text-sm transition-opacity',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                hidden ? 'border-border opacity-45' : 'border-transparent bg-muted',
              )}
            >
              <PersonAvatar
                firstName={employee.firstName}
                lastName={employee.lastName}
                src={employee.avatarUrl}
                color={employee.color}
                size="sm"
              />
              {employee.name}
            </button>
          );
        })}
        {hiddenEmployees.size > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => setHiddenEmployees(new Set())}>
            Alle anzeigen
          </Button>
        ) : null}
      </div>

      <div
        className={cn(
          'rounded-2xl border border-border bg-card p-4 transition-opacity sm:p-5',
          loading && 'opacity-70',
        )}
      >
        <FullCalendar
          ref={calendarRef}
          plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
          initialView="timeGridWeek"
          locale={deLocale}
          firstDay={1}
          height="auto"
          headerToolbar={{
            left: 'prev,next today',
            center: 'title',
            right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek',
          }}
          buttonText={{
            today: 'Heute',
            month: 'Monat',
            week: 'Woche',
            day: 'Tag',
            list: 'Liste',
          }}
          slotMinTime="06:00:00"
          slotMaxTime="21:00:00"
          slotDuration="00:30:00"
          nowIndicator
          weekNumbers
          weekNumberFormat={{ week: 'short' }}
          allDaySlot={false}
          editable
          eventDurationEditable
          eventResizableFromStart
          events={visibleEvents}
          datesSet={(arg) => void load(arg.start, arg.end)}
          eventClick={openJob}
          eventDrop={(info: EventDropArg) =>
            void move(info.event.id, info.event.start!, info.event.end!, info.revert)
          }
          eventResize={(info: EventResizeDoneArg) =>
            void move(info.event.id, info.event.start!, info.event.end!, info.revert)
          }
          eventContent={(arg) => {
            const props = arg.event.extendedProps as CalendarEvent['extendedProps'];
            return (
              <div className="overflow-hidden px-0.5">
                <p className="truncate font-semibold">{arg.timeText}</p>
                <p className="truncate">{props.customerName}</p>
                {props.crew.length === 0 ? (
                  <p className="truncate opacity-90">Nicht zugeteilt</p>
                ) : null}
              </div>
            );
          }}
        />
      </div>

      {/* Detailpanel */}
      <Sheet open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent side="right">
          {selected ? (
            <>
              <SheetHeader>
                <SheetTitle>
                  {selected.extendedProps.number} · {selected.extendedProps.customerName}
                </SheetTitle>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <StatusBadge status={selected.extendedProps.status} />
                  <span className="text-sm text-muted-foreground">
                    {formatDateTime(selected.start)}
                  </span>
                </div>
              </SheetHeader>

              <SheetBody className="space-y-6 py-6">
                <dl className="protocol-list">
                  <div className="protocol-row">
                    <dt className="protocol-label">Leistung</dt>
                    <dd className="protocol-value">
                      {selected.extendedProps.serviceName ?? '—'}
                    </dd>
                  </div>
                  <div className="protocol-row">
                    <dt className="protocol-label">Adresse</dt>
                    <dd className="protocol-value">{selected.extendedProps.address ?? '—'}</dd>
                  </div>
                  <div className="protocol-row">
                    <dt className="protocol-label">Benötigt</dt>
                    <dd className="protocol-value">
                      {selected.extendedProps.crewSize}{' '}
                      {selected.extendedProps.crewSize === 1 ? 'Person' : 'Personen'}
                    </dd>
                  </div>
                </dl>

                <fieldset className="space-y-3">
                  <legend className="mb-2 font-display text-sm font-semibold">
                    Team zuteilen
                  </legend>
                  {employees.map((employee) => (
                    <label
                      key={employee.id}
                      className="flex cursor-pointer items-center gap-3 rounded-xl border border-border p-3 transition-colors hover:bg-muted/50"
                    >
                      <Checkbox
                        checked={assignees.includes(employee.id)}
                        onCheckedChange={(checked) =>
                          setAssignees((current) =>
                            checked === true
                              ? [...current, employee.id]
                              : current.filter((id) => id !== employee.id),
                          )
                        }
                      />
                      <PersonAvatar
                        firstName={employee.firstName}
                        lastName={employee.lastName}
                        src={employee.avatarUrl}
                        color={employee.color}
                        size="sm"
                      />
                      <span className="text-sm font-medium">{employee.name}</span>
                    </label>
                  ))}

                  {assignees.length > 0 && assignees.length < selected.extendedProps.crewSize ? (
                    <p className="text-sm text-warning">
                      Für diesen Einsatz sind {selected.extendedProps.crewSize} Personen
                      vorgesehen — aktuell sind {assignees.length} gewählt.
                    </p>
                  ) : null}
                </fieldset>
              </SheetBody>

              <SheetFooter>
                <Button variant="outline" asChild>
                  <a href={`/admin/einsaetze/${selected.id}`}>Einsatz öffnen</a>
                </Button>
                <Button onClick={saveAssignment} loading={saving} disabled={assignees.length === 0}>
                  Zuteilung speichern
                </Button>
              </SheetFooter>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
