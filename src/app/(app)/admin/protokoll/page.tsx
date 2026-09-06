import type { Metadata } from 'next';
import type { AuditAction, Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import { requirePagePermission } from '@/lib/auth/session';
import { ROLE_LABELS } from '@/lib/auth/rbac';
import { formatDateTime, toQueryString } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/primitives';
import { FilterBar } from '@/components/app/filter-bar';
import {
  EmptyState,
  ListCard,
  PageHeader,
  Pagination,
  TableScroll,
} from '@/components/app/page-parts';
import { getOrganizationId } from '@/server/services/organization.service';

export const metadata: Metadata = {
  title: 'Prüfprotokoll',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Das Prüfprotokoll.
 *
 * Beantwortet drei Fragen: **wer** hat **was** **wann** geändert. Genau das
 * verlangen DSG und DSGVO für die Nachvollziehbarkeit von Änderungen an
 * Personendaten — und genau das braucht man, wenn ein Preis, eine Rechnung
 * oder eine Rolle unerwartet anders aussieht als gestern.
 *
 * Entscheide:
 *
 *  • **Nur die Systemverantwortung sieht diese Seite.** Wer überwacht wird,
 *    soll die Überwachung nicht einsehen — sonst liesse sich ablesen, welche
 *    eigene Handlung protokolliert wurde und welche nicht.
 *
 *  • **Die Änderungen stehen als Vorher/Nachher, nicht als JSON-Klumpen.**
 *    `{"status":{"from":"DRAFT","to":"ISSUED"}}` ist die gespeicherte Form;
 *    lesbar ist sie erst als Zeile mit zwei Werten.
 *
 *  • **Es gibt keine Löschfunktion.** Ein Protokoll, das sich aufräumen lässt,
 *    ist kein Protokoll. Alte Einträge verschwinden über die Aufbewahrungs-
 *    frist, nicht über eine Schaltfläche.
 */

const ACTION_LABELS: Record<AuditAction, string> = {
  CREATE: 'Angelegt',
  UPDATE: 'Geändert',
  DELETE: 'Gelöscht',
  LOGIN: 'Anmeldung',
  LOGIN_FAILED: 'Anmeldung fehlgeschlagen',
  LOGOUT: 'Abmeldung',
  PASSWORD_RESET: 'Passwort zurückgesetzt',
  PERMISSION_CHANGE: 'Rechte geändert',
  EXPORT: 'Exportiert',
  IMPORT: 'Importiert',
  PAYMENT: 'Zahlung',
  ACCESS_DENIED: 'Zugriff verweigert',
};

const ACTION_VARIANTS: Record<AuditAction, 'success' | 'info' | 'warning' | 'destructive' | 'neutral'> = {
  CREATE: 'success',
  UPDATE: 'info',
  DELETE: 'warning',
  LOGIN: 'neutral',
  LOGIN_FAILED: 'warning',
  LOGOUT: 'neutral',
  PASSWORD_RESET: 'warning',
  PERMISSION_CHANGE: 'destructive',
  EXPORT: 'neutral',
  IMPORT: 'neutral',
  PAYMENT: 'success',
  ACCESS_DENIED: 'destructive',
};

/** Deutsche Namen für die technischen Entitätsbezeichner. */
const ENTITY_LABELS: Record<string, string> = {
  Service: 'Leistung',
  ServiceCategory: 'Kategorie',
  ServiceExtra: 'Zusatzleistung',
  PriceRule: 'Preisregel',
  TaxRate: 'Steuersatz',
  Coupon: 'Gutschein',
  CallToAction: 'Handlungsaufruf',
  Customer: 'Kundschaft',
  Lead: 'Anfrage',
  Booking: 'Buchung',
  Quote: 'Offerte',
  Invoice: 'Rechnung',
  Job: 'Einsatz',
  Employee: 'Mitarbeitende',
  User: 'Benutzerkonto',
  ContentBlock: 'Website-Text',
  SeoMeta: 'Suchmaschinenangabe',
  Expense: 'Ausgabe',
  Payment: 'Zahlung',
  Review: 'Bewertung',
};

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePagePermission('audit:read');

  const params = await searchParams;
  const organizationId = await getOrganizationId();

  const page = Math.max(1, Number(params.seite) || 1);
  const pageSize = 50;

  const where: Prisma.AuditLogWhereInput = {
    organizationId,
    ...(params.aktion ? { action: params.aktion as AuditAction } : {}),
    ...(params.bereich ? { entity: params.bereich } : {}),
    ...(params.q
      ? {
          OR: [
            { summary: { contains: params.q, mode: 'insensitive' } },
            { entityId: { contains: params.q } },
            { user: { email: { contains: params.q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const [entries, total, entities] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        user: { select: { firstName: true, lastName: true, email: true, role: true } },
      },
    }),
    prisma.auditLog.count({ where }),
    prisma.auditLog.groupBy({
      by: ['entity'],
      where: { organizationId },
      _count: { _all: true },
      orderBy: { _count: { entity: 'desc' } },
      take: 25,
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const baseHref = `/admin/protokoll${toQueryString({
    q: params.q,
    aktion: params.aktion,
    bereich: params.bereich,
  })}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Prüfprotokoll"
        description="Wer hat was wann geändert. Lückenlos, unveränderlich und nur für die Systemverantwortung einsehbar."
      >
        <FilterBar
          searchPlaceholder="Zusammenfassung, ID oder E-Mail …"
          filters={[
            {
              param: 'aktion',
              label: 'Aktion',
              options: (Object.keys(ACTION_LABELS) as AuditAction[]).map((action) => ({
                value: action,
                label: ACTION_LABELS[action],
              })),
            },
            {
              param: 'bereich',
              label: 'Bereich',
              options: entities.map((row) => ({
                value: row.entity,
                label: `${ENTITY_LABELS[row.entity] ?? row.entity} (${row._count._all})`,
              })),
            },
          ]}
        />
      </PageHeader>

      <Alert variant="info">
        Einträge lassen sich nicht bearbeiten oder löschen — ein Protokoll, das sich aufräumen
        lässt, ist keines. Sensible Werte wie Passwörter, Token und AHV-Nummern sind bereits beim
        Schreiben redigiert.
      </Alert>

      {entries.length === 0 ? (
        <EmptyState
          title="Keine Einträge gefunden"
          description="Setzen Sie die Filter zurück. Protokolliert werden Anlegen, Ändern, Löschen, Anmeldungen, Rechtewechsel, Exporte und Zahlungen."
        />
      ) : (
        <ListCard
          footer={<Pagination page={page} totalPages={totalPages} total={total} baseHref={baseHref} />}
        >
          <TableScroll minWidth="58rem">
            <table className="data-table data-table--sticky">
              <caption className="sr-only">Prüfprotokoll. {total} Einträge.</caption>
              <thead>
                <tr>
                  <th scope="col">Zeitpunkt</th>
                  <th scope="col">Wer</th>
                  <th scope="col">Aktion</th>
                  <th scope="col">Was</th>
                  <th scope="col">Änderung</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="whitespace-nowrap tabular-nums text-muted-foreground">
                      {formatDateTime(entry.createdAt)}
                    </td>

                    <td>
                      {entry.user ? (
                        <>
                          <span className="block font-medium">
                            {entry.user.firstName} {entry.user.lastName}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {ROLE_LABELS[entry.user.role]}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">System</span>
                      )}
                      {entry.ip ? (
                        <span className="block font-mono text-2xs text-muted-foreground">
                          {entry.ip}
                        </span>
                      ) : null}
                    </td>

                    <td>
                      <Badge variant={ACTION_VARIANTS[entry.action]} size="sm">
                        {ACTION_LABELS[entry.action]}
                      </Badge>
                    </td>

                    <td className="cell-wide">
                      <span className="block font-medium">
                        {ENTITY_LABELS[entry.entity] ?? entry.entity}
                      </span>
                      {entry.summary ? (
                        <span className="block text-xs leading-relaxed text-muted-foreground">
                          {entry.summary}
                        </span>
                      ) : null}
                    </td>

                    <td className="cell-wide">
                      <ChangeList changes={entry.changes} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </ListCard>
      )}
    </div>
  );
}

/**
 * Geänderte Felder als Vorher/Nachher.
 *
 * Die gespeicherte Form ist `{ feld: { from, to } }`. Sie roh anzuzeigen wäre
 * ehrlich, aber unlesbar — und unlesbar heisst: niemand schaut hin.
 */
function ChangeList({ changes }: { changes: unknown }) {
  if (!changes || typeof changes !== 'object') {
    return <span className="text-muted-foreground">—</span>;
  }

  const entries = Object.entries(changes as Record<string, unknown>).slice(0, 6);
  if (entries.length === 0) return <span className="text-muted-foreground">—</span>;

  return (
    <dl className="space-y-1">
      {entries.map(([field, value]) => {
        const pair = value as { from?: unknown; to?: unknown } | null;
        const isPair = pair && typeof pair === 'object' && ('from' in pair || 'to' in pair);

        return (
          <div key={field} className="text-xs leading-relaxed">
            <dt className="inline font-mono text-muted-foreground">{field}</dt>
            <dd className="inline">
              {isPair ? (
                <>
                  {' '}
                  <span className="text-muted-foreground line-through">{render(pair.from)}</span>{' '}
                  <span aria-hidden>→</span>{' '}
                  <span className="font-medium">{render(pair.to)}</span>
                </>
              ) : (
                <> {render(value)}</>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function render(value: unknown): string {
  if (value === null || value === undefined) return 'leer';
  if (typeof value === 'boolean') return value ? 'ja' : 'nein';
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 60);
  const text = String(value);
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}
