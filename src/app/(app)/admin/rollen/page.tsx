import type { Metadata } from 'next';
import { Check, Minus, User } from 'lucide-react';

import { requirePagePermission } from '@/lib/auth/session';
import {
  ACTOR_ROLES,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  can,
  permissionsByGroup,
  permissionMeta,
  type ActorRole,
} from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { getOrganizationId } from '@/server/services/organization.service';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/primitives';
import { ListCard, PageHeader, TableScroll } from '@/components/app/page-parts';

export const metadata: Metadata = {
  title: 'Rollen und Rechte',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Die vollständige Rechtematrix.
 *
 * Warum diese Seite existiert: die Zuordnung von Rollen zu Berechtigungen
 * steht im Code — gut für Geschwindigkeit und Nachvollziehbarkeit im Diff,
 * schlecht für jeden, der wissen will, was die Betriebsleitung eigentlich
 * darf. Diese Seite beantwortet genau das, aus derselben Quelle, aus der die
 * Prüfung zur Laufzeit liest. Sie kann deshalb nicht veralten.
 *
 * Gestaltungsentscheide:
 *
 *  • **Ein Häkchen ist nicht genug.** Neben jeder Berechtigung steht, was sie
 *    tatsächlich erlaubt. „Invoices.Delete" sagt nichts darüber, dass
 *    ausgestellte Rechnungen unantastbar bleiben — der Satz daneben schon.
 *
 *  • **Eigene Datensätze sind besonders gekennzeichnet.** Eine Kundschaft mit
 *    „Invoices.ViewOwn" hat kein Einblick in die Buchhaltung. Ohne diese
 *    Kennzeichnung liest sich die Zeile genau so.
 *
 *  • **Die Gastspalte bleibt sichtbar, obwohl sie leer ist.** Genau das ist
 *    ihre Aussage: ohne Anmeldung besteht kein einziges Recht.
 */
export default async function RolesPage() {
  await requirePagePermission('role:read');
  const organizationId = await getOrganizationId();

  const counts = await prisma.user.groupBy({
    by: ['role'],
    where: { organizationId, deletedAt: null },
    _count: { _all: true },
  });
  const byRole = new Map(counts.map((row) => [row.role as string, row._count._all]));

  const groups = permissionsByGroup();
  const totalPermissions = groups.reduce((sum, g) => sum + g.permissions.length, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Rollen und Rechte"
        description={`${totalPermissions} Berechtigungen in ${groups.length} Bereichen, verteilt auf ${ACTOR_ROLES.length} Rollen. Diese Ansicht liest aus derselben Quelle wie die Prüfung zur Laufzeit — sie kann nicht veralten.`}
      />

      <Alert variant="info">
        Rollen werden nicht hier vergeben, sondern beim jeweiligen Benutzerkonto. Nur die
        Systemverantwortung darf das, und auch sie nur bis zur eigenen Stufe — so kann sich niemand
        selbst höherstufen.
      </Alert>

      {/* Rollenübersicht */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {ACTOR_ROLES.map((role) => (
          <article
            key={role}
            className="space-y-2 rounded-2xl border border-border bg-card p-5 shadow-soft"
          >
            <div className="flex items-start justify-between gap-3">
              <h2 className="font-display text-base font-semibold tracking-tight">
                {ROLE_LABELS[role]}
              </h2>
              {role === 'GUEST' ? (
                <Badge variant="neutral" size="sm">
                  kein Konto
                </Badge>
              ) : (
                <span className="flex items-center gap-1.5 whitespace-nowrap text-meta text-muted-foreground">
                  <User className="size-3.5" aria-hidden />
                  {byRole.get(role) ?? 0}
                </span>
              )}
            </div>
            <p className="text-meta leading-relaxed text-muted-foreground">
              {ROLE_DESCRIPTIONS[role]}
            </p>
            <p className="text-2xs tabular-nums text-muted-foreground">
              {countFor(role)} von {totalPermissions} Berechtigungen
            </p>
          </article>
        ))}
      </div>

      {/* Matrix je Bereich */}
      {groups.map(({ group, permissions }) => (
        <ListCard key={group} title={`${group} (${permissions.length})`}>
          <TableScroll minWidth="58rem" label={`Rechtematrix ${group}, waagrecht scrollbar`}>
            <table className="data-table data-table--sticky">
              <caption className="sr-only">
                Welche Rolle welche Berechtigung im Bereich {group} hat.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Berechtigung</th>
                  {ACTOR_ROLES.map((role) => (
                    <th key={role} scope="col" className="text-center">
                      <span className="block whitespace-nowrap">{ROLE_LABELS[role]}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {permissions.map((permission) => {
                  const meta = permissionMeta(permission);
                  return (
                    <tr key={permission}>
                      <td className="cell-wide">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{meta.label}</span>
                          {meta.scoped ? (
                            <Badge variant="info" size="sm">
                              nur eigene
                            </Badge>
                          ) : null}
                        </span>
                        <span className="block text-xs leading-relaxed text-muted-foreground">
                          {meta.description}
                        </span>
                        <span className="block font-mono text-2xs text-muted-foreground">
                          {permission}
                        </span>
                      </td>
                      {ACTOR_ROLES.map((role) => (
                        <td key={role} className="text-center">
                          {can(role, permission) ? (
                            <>
                              <Check className="mx-auto size-4 text-success" aria-hidden />
                              <span className="sr-only">
                                {ROLE_LABELS[role]}: erlaubt
                              </span>
                            </>
                          ) : (
                            <>
                              <Minus
                                className="mx-auto size-4 text-muted-foreground/40"
                                aria-hidden
                              />
                              <span className="sr-only">{ROLE_LABELS[role]}: nicht erlaubt</span>
                            </>
                          )}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        </ListCard>
      ))}
    </div>
  );

  function countFor(role: ActorRole): number {
    return groups.reduce(
      (sum, g) => sum + g.permissions.filter((permission) => can(role, permission)).length,
      0,
    );
  }
}
