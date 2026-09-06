'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Building2, Mail, Phone, Sparkles, UserCheck } from 'lucide-react';
import { toast } from 'sonner';

import { cn, formatCurrency, formatRelative } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { Badge } from '@/components/ui/badge';

/**
 * Verkaufspipeline als Kanban.
 *
 * Architekturentscheid: Verschieben läuft über die native HTML5-Drag-and-Drop-
 * API statt über eine Bibliothek. Der Anwendungsfall ist eine Karte in eine
 * Spalte ziehen — dafür lohnt keine zusätzliche Abhängigkeit. Für Tastatur und
 * Touch gibt es zusätzlich ein Auswahlmenü pro Karte, damit die Funktion nicht
 * an der Zeigergeste hängt.
 */

export interface PipelineStageDto {
  id: string;
  name: string;
  key: string;
  color: string;
  isWon: boolean;
  isLost: boolean;
}

export interface PipelineLeadDto {
  id: string;
  number: string;
  firstName: string;
  lastName: string;
  company: string | null;
  email: string;
  phone: string | null;
  city: string | null;
  serviceKind: string | null;
  estimatedValue: number | null;
  score: number;
  status: string;
  stageId: string | null;
  createdAt: string;
  ownerName: string | null;
  tags: { id: string; name: string; color: string }[];
}

export interface PipelineColumn {
  stage: PipelineStageDto;
  leads: PipelineLeadDto[];
  count: number;
  value: number;
}

const SERVICE_LABELS: Record<string, string> = {
  RESIDENTIAL_CLEANING: 'Unterhalt',
  MOVE_OUT_CLEANING: 'Umzug',
  OFFICE_CLEANING: 'Büro',
  WINDOW_CLEANING: 'Fenster',
  CONSTRUCTION_CLEANING: 'Bau',
  BUILDING_MAINTENANCE: 'Hauswartung',
  SPECIAL: 'Spezial',
};

export function LeadPipeline({ columns }: { columns: PipelineColumn[] }) {
  const router = useRouter();
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [overStage, setOverStage] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<string | null>(null);

  const moveLead = async (leadId: string, stageId: string, stageKey: string) => {
    setPending(leadId);
    try {
      await api.patch(`/api/leads/${leadId}`, {
        stageId,
        // Die Stufe bestimmt den Status — sonst laufen Kanban und Liste auseinander.
        status: stageKeyToStatus(stageKey),
      });
      toast.success('Lead verschoben.');
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'Der Lead konnte nicht verschoben werden.',
      );
    } finally {
      setPending(null);
      setDragging(null);
      setOverStage(null);
    }
  };

  return (
    <div className="no-scrollbar -mx-1 flex gap-4 overflow-x-auto px-1 pb-4">
      {columns.map((column) => (
        <section
          key={column.stage.id}
          onDragOver={(event) => {
            event.preventDefault();
            setOverStage(column.stage.id);
          }}
          onDragLeave={() => setOverStage(null)}
          onDrop={(event) => {
            event.preventDefault();
            const leadId = event.dataTransfer.getData('text/plain');
            if (leadId) void moveLead(leadId, column.stage.id, column.stage.key);
          }}
          className={cn(
            'flex w-[19rem] shrink-0 flex-col rounded-2xl border bg-surface transition-colors',
            overStage === column.stage.id ? 'border-primary bg-primary/[0.04]' : 'border-border',
          )}
          aria-label={`${column.stage.name}: ${column.count} Leads`}
        >
          <header className="flex items-center justify-between gap-2 border-b border-border p-4">
            <div className="flex items-center gap-2">
              <span
                className="size-2.5 rounded-full"
                style={{ backgroundColor: column.stage.color }}
                aria-hidden
              />
              <h2 className="font-display text-sm font-semibold">{column.stage.name}</h2>
              <span className="text-sm tabular-nums text-muted-foreground">{column.count}</span>
            </div>
            {column.value > 0 ? (
              <span className="text-xs tabular-nums text-muted-foreground">
                {formatCurrency(column.value)}
              </span>
            ) : null}
          </header>

          <ul className="flex-1 space-y-2 p-2">
            {column.leads.length === 0 ? (
              <li className="px-2 py-8 text-center text-sm text-muted-foreground">
                Keine Leads in dieser Stufe.
              </li>
            ) : null}

            {column.leads.map((lead) => (
              <li
                key={lead.id}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData('text/plain', lead.id);
                  setDragging(lead.id);
                }}
                onDragEnd={() => setDragging(null)}
                className={cn(
                  'cursor-grab rounded-xl border border-border bg-card p-3.5 shadow-soft transition-opacity active:cursor-grabbing',
                  dragging === lead.id && 'opacity-40',
                  pending === lead.id && 'opacity-60',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <Link
                    href={`/admin/leads/${lead.id}`}
                    className="min-w-0 font-medium leading-snug underline-offset-4 hover:underline"
                  >
                    {lead.company ?? `${lead.firstName} ${lead.lastName}`}
                  </Link>
                  <ScoreBadge score={lead.score} />
                </div>

                {lead.company ? (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {lead.firstName} {lead.lastName}
                  </p>
                ) : null}

                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  {lead.serviceKind ? (
                    <Badge variant="neutral" size="sm">
                      {SERVICE_LABELS[lead.serviceKind] ?? lead.serviceKind}
                    </Badge>
                  ) : null}
                  {lead.city ? (
                    <Badge variant="outline" size="sm">
                      {lead.city}
                    </Badge>
                  ) : null}
                  {lead.tags.slice(0, 1).map((tag) => (
                    <Badge
                      key={tag.id}
                      size="sm"
                      variant="outline"
                      style={{ borderColor: `${tag.color}55`, color: tag.color }}
                    >
                      {tag.name}
                    </Badge>
                  ))}
                </div>

                <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-2.5">
                  <span className="text-xs text-muted-foreground">
                    {formatRelative(lead.createdAt)}
                  </span>
                  {lead.estimatedValue ? (
                    <span className="text-xs font-medium tabular-nums">
                      {formatCurrency(lead.estimatedValue)}
                    </span>
                  ) : null}
                </div>

                <div className="mt-2 flex items-center gap-1">
                  <a
                    href={`mailto:${lead.email}`}
                    className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label={`E-Mail an ${lead.firstName} ${lead.lastName}`}
                  >
                    <Mail className="size-3.5" aria-hidden />
                  </a>
                  {lead.phone ? (
                    <a
                      href={`tel:${lead.phone}`}
                      className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      aria-label={`${lead.firstName} ${lead.lastName} anrufen`}
                    >
                      <Phone className="size-3.5" aria-hidden />
                    </a>
                  ) : null}

                  {/* Tastatur-/Touch-Alternative zum Ziehen */}
                  <label className="ml-auto">
                    <span className="sr-only">Stufe für {lead.number} ändern</span>
                    <select
                      value={lead.stageId ?? ''}
                      onChange={(event) => {
                        const stage = columns.find((c) => c.stage.id === event.target.value);
                        if (stage) void moveLead(lead.id, stage.stage.id, stage.stage.key);
                      }}
                      className="h-7 rounded-lg border border-border bg-card px-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {columns.map((c) => (
                        <option key={c.stage.id} value={c.stage.id}>
                          {c.stage.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Die KI-Bewertung als Zahl mit Farbcodierung *und* Titel — nie nur Farbe. */
function ScoreBadge({ score }: { score: number }) {
  if (score === 0) return null;

  const tone =
    score >= 70 ? 'text-success' : score >= 40 ? 'text-warning' : 'text-muted-foreground';

  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-1 text-xs font-semibold tabular-nums', tone)}
      title={`KI-Bewertung: ${score} von 100`}
    >
      <Sparkles className="size-3" aria-hidden />
      {score}
    </span>
  );
}

function stageKeyToStatus(key: string): string {
  const map: Record<string, string> = {
    new: 'NEW',
    contacted: 'CONTACTED',
    qualified: 'QUALIFIED',
    proposal: 'PROPOSAL',
    won: 'WON',
    lost: 'LOST',
  };
  return map[key] ?? 'NEW';
}

export { Building2, UserCheck };
