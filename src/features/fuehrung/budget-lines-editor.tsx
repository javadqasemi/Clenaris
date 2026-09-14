'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, PenLine, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { formatCurrency } from '@/lib/utils';
import { EXPENSE_CATEGORY_LABELS, optionsOf } from '@/lib/bi/labels';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ListCard, TableScroll } from '@/components/app/page-parts';
import type { BudgetVarianceLine } from '@/server/services/budget.service';
import { FormDialog } from './resource-form';

/**
 * Budgetzeilen mit Abweichung.
 *
 * Im Entwurf sind Plan und Bezeichnung änderbar; nach der Genehmigung nur
 * noch der Nachtrag. Die Abweichung steht gegen den *anteiligen* Plan, nie
 * gegen den Jahresplan — sonst meldet der April überall eine gewaltige
 * Unterschreitung.
 */
export function BudgetLinesEditor({
  budgetId,
  status,
  lines,
  canEdit,
}: {
  budgetId: string;
  status: string;
  lines: BudgetVarianceLine[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<{ label: string; amount: string }>({ label: '', amount: '' });
  const [busy, setBusy] = React.useState(false);
  const approved = status === 'APPROVED';
  const closed = status === 'CLOSED';

  const startEdit = (line: BudgetVarianceLine) => {
    setEditing(line.id);
    setDraft({ label: line.label, amount: String(approved ? (line.revised ? line.plan : '') : line.plan) });
  };

  const save = async (line: BudgetVarianceLine) => {
    setBusy(true);
    try {
      const amount = draft.amount.trim() === '' ? null : Number(draft.amount.replace(',', '.'));
      await api.patch(`/api/bi/budget-lines/${line.id}`, approved ? { label: draft.label, revisedAmount: amount } : { label: draft.label, ...(amount !== null ? { plannedAmount: amount } : {}) });
      toast.success('Zeile gespeichert.');
      setEditing(null);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Speichern fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (line: BudgetVarianceLine) => {
    if (!window.confirm(`Budgetzeile „${line.label}" löschen?`)) return;
    try {
      await api.delete(`/api/bi/budget-lines/${line.id}`);
      toast.success('Zeile gelöscht.');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Löschen fehlgeschlagen.');
    }
  };

  return (
    <ListCard
      title="Budgetzeilen"
      action={
        canEdit && status === 'DRAFT' ? (
          <FormDialog
            title="Budgetzeile anlegen"
            description="Der Jahresbetrag wird gleichmässig auf zwölf Monate verteilt; die Verteilung lässt sich später anpassen."
            triggerLabel="Zeile"
            triggerVariant="outline"
            triggerSize="sm"
            endpoint={`/api/bi/budgets/${budgetId}/lines`}
            successMessage="Zeile angelegt."
            fields={[
              { name: 'category', label: 'Kategorie', type: 'select', options: optionsOf(EXPENSE_CATEGORY_LABELS), required: true, half: true, hint: 'Das Ist kommt aus den Ausgaben dieser Kategorie.' },
              { name: 'plannedAmount', label: 'Jahresplan', type: 'number', suffix: 'CHF', required: true, half: true },
              { name: 'label', label: 'Bezeichnung', required: true, placeholder: 'z. B. Fahrzeugflotte' },
              { name: 'note', label: 'Notiz', type: 'textarea', rows: 2 },
            ]}
          />
        ) : null
      }
    >
      <TableScroll minWidth="52rem">
        <table className="data-table">
          <caption className="sr-only">Budgetzeilen mit Abweichung</caption>
          <thead>
            <tr>
              <th scope="col">Zeile</th>
              <th scope="col">Kategorie</th>
              <th scope="col" className="text-right">Plan</th>
              <th scope="col" className="text-right">Plan anteilig</th>
              <th scope="col" className="text-right">Ist</th>
              <th scope="col" className="text-right">Abweichung</th>
              <th scope="col" className="text-right">Hochrechnung</th>
              {canEdit && !closed ? <th scope="col" className="w-20" /> : null}
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const isEditing = editing === line.id;
              const over = line.variance > 0;
              return (
                <tr key={line.id}>
                  <td>
                    {isEditing ? (
                      <Input className="h-9" value={draft.label} onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))} aria-label="Bezeichnung" />
                    ) : (
                      <span className="font-medium">
                        {line.label}
                        {line.revised ? <Badge variant="info" size="sm" className="ml-2">Nachtrag</Badge> : null}
                      </span>
                    )}
                  </td>
                  <td className="text-muted-foreground">{EXPENSE_CATEGORY_LABELS[line.category] ?? line.category}</td>
                  <td className="num">
                    {isEditing ? (
                      <Input className="h-9 w-32 text-right" inputMode="decimal" value={draft.amount} onChange={(e) => setDraft((d) => ({ ...d, amount: e.target.value }))} aria-label={approved ? 'Nachtrag' : 'Jahresplan'} placeholder={approved ? 'Nachtrag' : ''} />
                    ) : (
                      formatCurrency(line.plan)
                    )}
                  </td>
                  <td className="num text-muted-foreground">{formatCurrency(line.planToDate)}</td>
                  <td className="num">{formatCurrency(line.actual)}</td>
                  <td className={`num font-medium ${over ? 'text-destructive' : 'text-success'}`}>
                    {line.variance > 0 ? '+' : ''}
                    {formatCurrency(line.variance)}
                    {line.variancePct !== null ? <span className="ml-1 text-xs text-muted-foreground">({line.variancePct > 0 ? '+' : ''}{line.variancePct} %)</span> : null}
                  </td>
                  <td className="num text-muted-foreground">{line.forecast === null ? '—' : formatCurrency(line.forecast)}</td>
                  {canEdit && !closed ? (
                    <td>
                      <div className="flex justify-end gap-1">
                        {isEditing ? (
                          <>
                            <Button variant="ghost" size="icon-sm" aria-label="Speichern" loading={busy} onClick={() => save(line)}>
                              <Check aria-hidden />
                            </Button>
                            <Button variant="ghost" size="icon-sm" aria-label="Abbrechen" onClick={() => setEditing(null)}>
                              <X aria-hidden />
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button variant="ghost" size="icon-sm" aria-label="Bearbeiten" onClick={() => startEdit(line)}>
                              <PenLine aria-hidden />
                            </Button>
                            {status === 'DRAFT' ? (
                              <Button variant="ghost" size="icon-sm" aria-label="Löschen" onClick={() => remove(line)}>
                                <Trash2 aria-hidden />
                              </Button>
                            ) : null}
                          </>
                        )}
                      </div>
                    </td>
                  ) : null}
                </tr>
              );
            })}
            {lines.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-8 text-center text-muted-foreground">
                  Noch keine Zeilen. Legen Sie je Kostenart eine Zeile mit Jahresplan an.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </TableScroll>
    </ListCard>
  );
}
