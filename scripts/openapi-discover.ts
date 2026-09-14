import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { Guard } from './openapi-routes';

/**
 * Liest den Routenbaum unter `src/app/api` und leitet je Methode den *echten*
 * Schutz aus dem Quelltext ab.
 *
 * **Warum der Schutz aus der Quelle kommt und nicht aus der Liste.** Die
 * Routenliste (`openapi-routes.ts`) wird von Hand gepflegt. Über die Zeit
 * standen dort Berechtigungen wie `job:write` oder `lead:write`, die es im
 * Katalog nie gab — die Doku behauptete einen Schutz, den kein Endpunkt
 * prüfte. Der Abgleich hier macht das sichtbar: Was die Fabrik im Quelltext
 * deklariert (`permissions`, `anyPermission`, `roles`, `definePublicRoute`,
 * `defineCronRoute`), ist die Wahrheit; die Liste muss ihr folgen.
 *
 * Handgeschriebene Handler (Stripe-Webhook, Dateispeicher, Vorschau) tragen
 * keine Deklaration. Für sie bleibt `guard` leer und die Liste gilt ungeprüft.
 */

export interface DiscoveredMethod {
  method: string;
  /** `null`, wenn der Handler nicht über die Fabrik läuft. */
  guard: Guard | null;
}

export interface DiscoveredRoute {
  path: string;
  methods: DiscoveredMethod[];
}

const EXPORT_PATTERN = /export (?:const|(?:async )?function) (GET|POST|PATCH|PUT|DELETE)\b/g;

function quotedList(source: string, field: string): string[] | null {
  const match = source.match(new RegExp(`${field}:\\s*\\[([^\\]]*)\\]`));
  if (!match) return null;
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

function guardFromBlock(block: string): Guard | null {
  if (block.includes('definePublicRoute(')) return { kind: 'public' };
  if (block.includes('defineCronRoute(')) return { kind: 'cron' };
  if (!block.includes('defineRoute(')) return null;

  const roles = quotedList(block, 'roles');
  const permissions = quotedList(block, 'permissions');

  if (roles && roles.length > 0) return { kind: 'role', roles };
  if (permissions && permissions.length > 0) {
    return {
      kind: 'permissions',
      permissions,
      mode: /anyPermission:\s*true/.test(block) ? 'any' : 'all',
    };
  }
  return { kind: 'session' };
}

export function discoverRoutes(apiDir: string, dir = apiDir): DiscoveredRoute[] {
  const found: DiscoveredRoute[] = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...discoverRoutes(apiDir, full));
      continue;
    }
    if (entry !== 'route.ts') continue;

    const source = readFileSync(full, 'utf8');
    const matches = [...source.matchAll(EXPORT_PATTERN)];
    if (matches.length === 0) continue;

    const methods = matches.map((match, index) => {
      const start = match.index ?? 0;
      const end = matches[index + 1]?.index ?? source.length;
      return {
        method: match[1].toLowerCase(),
        guard: guardFromBlock(source.slice(start, end)),
      };
    });

    const segments = relative(apiDir, dir).split(sep).filter(Boolean);
    // `[id]` → `{id}`, damit die Schreibweise der OpenAPI-Konvention folgt.
    const path = `/api/${segments.map((s) => s.replace(/^\[(.+)\]$/, '{$1}')).join('/')}`;
    found.push({ path, methods });
  }

  return found;
}

/** Vergleichbare Kurzform eines Schutzes — Reihenfolge der Rechte egal. */
export function guardKey(guard: Guard): string {
  switch (guard.kind) {
    case 'permissions':
      return `${guard.mode}:${[...guard.permissions].sort().join(',')}`;
    case 'role':
      return `role:${[...guard.roles].sort().join(',')}`;
    default:
      return guard.kind;
  }
}

/** Der Schutz als Quelltext für die Routenliste. */
export function guardSource(guard: Guard): string {
  switch (guard.kind) {
    case 'permissions':
      return `perm('${guard.mode}', ${guard.permissions.map((p) => `'${p}'`).join(', ')})`;
    case 'role':
      return `{ kind: 'role', roles: [${guard.roles.map((r) => `'${r}'`).join(', ')}] }`;
    default:
      return `{ kind: '${guard.kind}' }`;
  }
}
