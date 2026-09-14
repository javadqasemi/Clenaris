'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import deLocale from '@fullcalendar/core/locales/de';
import type { EventClickArg } from '@fullcalendar/core';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { api } from '@/lib/api/client';

/**
 * Persönlicher Kalender.
 *
 * Bewusst ohne Drag & Drop: Mitarbeitende verschieben ihre Einsätze nicht
 * selbst — das macht die Disposition. Die Ansicht ist reine Information, ein
 * Klick öffnet den Einsatz.
 *
 * Voreingestellt ist die Listenansicht: auf dem Mobiltelefon ist eine
 * Wochenspalte unlesbar, eine Liste nicht.
 */
interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  backgroundColor: string;
  borderColor: string;
  extendedProps: {
    number: string;
    status: string;
    customerName: string;
    address: string | null;
  };
}

/**
 * Ansichten mit Stundenachse. Sie zeigen 24 Zeilen und brauchen deshalb eine
 * feste Höhe mit eigenem Bildlauf; Liste und Monat wachsen dagegen mit ihrem
 * Inhalt und sehen mit einer festen Höhe leer aus.
 */
const TIME_GRID_VIEWS = new Set(['timeGridWeek', 'timeGridDay']);

export function PersonalCalendar() {
  const router = useRouter();
  const [events, setEvents] = React.useState<CalendarEvent[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [view, setView] = React.useState('listWeek');

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

  const openJob = (arg: EventClickArg) => {
    router.push(`/portal/einsaetze/${arg.event.id}`);
  };

  return (
    <div
      className={cn(
        'rounded-2xl border border-border bg-card p-4 transition-opacity sm:p-5',
        loading && 'opacity-70',
      )}
    >
      <FullCalendar
        plugins={[dayGridPlugin, timeGridPlugin, listPlugin]}
        initialView="listWeek"
        locale={deLocale}
        firstDay={1}
        height={TIME_GRID_VIEWS.has(view) ? 'min(72vh, 46rem)' : 'auto'}
        stickyHeaderDates
        expandRows
        headerToolbar={{
          left: 'prev,next today',
          center: 'title',
          right: 'listWeek,timeGridDay,timeGridWeek,dayGridMonth',
        }}
        buttonText={{
          today: 'Heute',
          month: 'Monat',
          week: 'Woche',
          day: 'Tag',
          list: 'Liste',
        }}
        noEventsText="In diesem Zeitraum sind keine Einsätze geplant."
        // Der ganze Tag — Frühschichten vor sechs und Büroreinigungen nach
        // achtzehn Uhr fielen mit dem alten Fenster unsichtbar heraus.
        slotMinTime="00:00:00"
        slotMaxTime="24:00:00"
        slotDuration="00:30:00"
        slotLabelInterval="01:00:00"
        scrollTime="07:00:00"
        scrollTimeReset={false}
        slotEventOverlap={false}
        allDaySlot={false}
        nowIndicator
        events={events}
        datesSet={(arg) => {
          setView(arg.view.type);
          void load(arg.start, arg.end);
        }}
        eventClick={openJob}
        eventContent={(arg) => {
          const props = arg.event.extendedProps as CalendarEvent['extendedProps'];
          return (
            <div className="overflow-hidden px-0.5">
              <p className="truncate font-semibold">{arg.timeText}</p>
              <p className="truncate">{props.customerName}</p>
              {props.address ? (
                <p className="truncate text-2xs opacity-90">{props.address}</p>
              ) : null}
            </div>
          );
        }}
      />
    </div>
  );
}
