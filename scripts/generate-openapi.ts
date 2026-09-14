import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROUTES, type Guard, type RouteDoc } from './openapi-routes';
import { discoverRoutes, guardKey, guardSource } from './openapi-discover';
import { zodToJsonSchema, zodToParameters, type JsonSchema } from './zod-to-json-schema';

/**
 * Erzeugt `docs/openapi.json` und `docs/openapi.yaml` aus der Routenliste.
 *
 * Zwei Dinge machen die Spezifikation vertrauenswürdig:
 *
 *  1. Die Schemas sind Verweise auf genau die Zod-Objekte, die zur Laufzeit
 *     validieren. Die Feldbeschreibung kann deshalb nicht abweichen.
 *  2. Der Abgleich unten liest den Routenbaum unter `src/app/api` und
 *     vergleicht ihn mit der Liste. Ein neuer Endpunkt, der nicht
 *     dokumentiert ist, lässt diesen Lauf fehlschlagen — und damit den Build,
 *     wenn `npm run openapi` in der Auslieferungskette steht.
 *
 * Aufruf: `npm run openapi`
 */

const ROOT = process.cwd();
const API_DIR = join(ROOT, 'src', 'app', 'api');
const OUT_DIR = join(ROOT, 'docs');

// ---------------------------------------------------------------------------
//  Abgleich mit dem Dateibaum
// ---------------------------------------------------------------------------

/**
 * Drei Prüfungen, alle gegen den Dateibaum:
 *
 *  1. Jeder Endpunkt im Baum steht in der Liste.
 *  2. Jeder Eintrag der Liste hat einen Endpunkt im Baum.
 *  3. Der dokumentierte Schutz entspricht dem deklarierten — Berechtigungen,
 *     Modus (`alle`/`eine`), Rollen, öffentlich, Cron. Ohne diese dritte
 *     Prüfung stand in der Doku jahrelang `job:write`, während der Endpunkt
 *     `job:update` verlangte: Wer die Doku las, suchte ein Recht, das es nie
 *     gab.
 */
function verifyCoverage(): void {
  const discovered = discoverRoutes(API_DIR);
  const documented = new Map(ROUTES.map((route) => [`${route.method} ${route.path}`, route]));

  const missing: string[] = [];
  const drifted: string[] = [];
  for (const route of discovered) {
    for (const { method, guard } of route.methods) {
      const key = `${method} ${route.path}`;
      const doc = documented.get(key);
      if (!doc) {
        missing.push(key);
        continue;
      }
      if (guard && guardKey(guard) !== guardKey(doc.guard)) {
        drifted.push(`${key}\n      Liste:  ${guardSource(doc.guard)}\n      Quelle: ${guardSource(guard)}`);
      }
    }
  }

  const discoveredKeys = new Set(
    discovered.flatMap((route) => route.methods.map(({ method }) => `${method} ${route.path}`)),
  );
  const stale = [...documented.keys()].filter((key) => !discoveredKeys.has(key));

  if (missing.length || stale.length || drifted.length) {
    const report = [
      missing.length ? `Nicht dokumentiert:\n  ${missing.join('\n  ')}` : '',
      stale.length ? `Dokumentiert, aber nicht vorhanden:\n  ${stale.join('\n  ')}` : '',
      drifted.length ? `Schutz weicht ab:\n  ${drifted.join('\n  ')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    throw new Error(
      `Die OpenAPI-Liste und der Routenbaum stimmen nicht überein.\n\n${report}\n\n` +
        'Bitte `scripts/openapi-routes.ts` ergänzen bzw. bereinigen.',
    );
  }

  console.log(`✓ ${documented.size} Endpunkte — Liste, Routenbaum und Schutz stimmen überein.`);
}

// ---------------------------------------------------------------------------
//  Spezifikation aufbauen
// ---------------------------------------------------------------------------

const ERROR_CODES: Record<number, string> = {
  400: 'VALIDATION_ERROR — die Eingabe ist ungültig. `error.details` nennt Feld und Grund.',
  401: 'UNAUTHORIZED — keine oder abgelaufene Sitzung.',
  403: 'FORBIDDEN — angemeldet, aber ohne die nötige Berechtigung.',
  404: 'NOT_FOUND — nicht vorhanden, oder für diese Sitzung nicht sichtbar.',
  409: 'CONFLICT — verstösst gegen eine Eindeutigkeitsregel.',
  422: 'BUSINESS_RULE — fachlich nicht zulässig, etwa eine bereits ausgestellte Rechnung ändern.',
  429: 'RATE_LIMITED — zu viele Anfragen. `Retry-After` nennt die Wartezeit in Sekunden.',
  500: 'INTERNAL_ERROR — unerwarteter Fehler. Die Meldung nennt keine internen Details.',
};

function guardText(guard: Guard): string {
  switch (guard.kind) {
    case 'public':
      return 'Öffentlich — keine Anmeldung nötig.';
    case 'cron':
      return 'Nur für den Scheduler: `Authorization: Bearer $CRON_SECRET`.';
    case 'session':
      return 'Erfordert eine angemeldete Sitzung.';
    case 'role':
      return `Erfordert die Rolle ${guard.roles.join(' oder ')}.`;
    case 'permissions':
      return guard.mode === 'any'
        ? `Erfordert eine der Berechtigungen: \`${guard.permissions.join('`, `')}\`.`
        : `Erfordert die Berechtigung${guard.permissions.length > 1 ? 'en' : ''}: \`${guard.permissions.join('`, `')}\`.`;
  }
}

/** Antwortcodes, die dieser Endpunkt tatsächlich erzeugen kann. */
function errorCodesFor(route: RouteDoc): number[] {
  const codes = new Set<number>([500]);
  if (route.body || route.query || route.params) codes.add(400);
  if (route.guard.kind !== 'public' && route.guard.kind !== 'cron') {
    codes.add(401);
    if (route.guard.kind !== 'session') codes.add(403);
  }
  if (route.guard.kind === 'cron') codes.add(401);
  if (route.params) codes.add(404);
  if (route.method !== 'get') codes.add(422);
  // 409 kann nur entstehen, wo etwas Neues angelegt wird.
  if (route.status === 201) codes.add(409);
  if (route.rateLimit) codes.add(429);
  for (const code of route.extraErrors ?? []) codes.add(code);
  return [...codes].sort((a, b) => a - b);
}

function successResponse(route: RouteDoc): Record<string, unknown> {
  if (route.produces === 'application/pdf') {
    return {
      description: 'PDF-Dokument',
      content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
    };
  }
  if (route.produces && route.produces !== 'application/json') {
    return {
      description: 'Datei',
      content: { [route.produces]: { schema: { type: 'string', format: 'binary' } } },
    };
  }
  return {
    description: 'Erfolg',
    content: {
      'application/json': { schema: { $ref: '#/components/schemas/SuccessEnvelope' } },
    },
  };
}

function buildSpec() {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of ROUTES) {
    const parameters = [
      ...(route.params ? zodToParameters(route.params, 'path') : []),
      ...(route.query ? zodToParameters(route.query, 'query') : []),
    ];

    const responses: Record<string, unknown> = {
      [String(route.status ?? 200)]: successResponse(route),
    };
    for (const code of errorCodesFor(route)) {
      responses[String(code)] = {
        description: ERROR_CODES[code],
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } },
        },
      };
    }

    const operation: Record<string, unknown> = {
      tags: [route.tag],
      summary: route.summary,
      description: [
        route.description,
        '',
        `**Zugriff:** ${guardText(route.guard)}`,
        route.rateLimit ? `**Rate-Limit-Klasse:** \`${route.rateLimit}\`` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      operationId: `${route.method}${route.path
        .replace(/^\/api\//, '')
        .replace(/\{(\w+)\}/g, 'By-$1')
        .split(/[/-]/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('')}`,
      security:
        route.guard.kind === 'public'
          ? []
          : route.guard.kind === 'cron'
            ? [{ cronSecret: [] }]
            : [{ sessionCookie: [] }],
      ...(parameters.length ? { parameters } : {}),
      ...(route.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: zodToJsonSchema(route.body) } },
            },
          }
        : {}),
      responses,
    };

    paths[route.path] ??= {};
    paths[route.path][route.method] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Clenaris API',
      version: '1.0.0',
      description: [
        'REST-Schnittstelle der Clenaris-Plattform für Reinigungsbetriebe.',
        '',
        '## Umschlag',
        '',
        'Jede JSON-Antwort trägt denselben Umschlag: bei Erfolg `{ "data": … }`,',
        'bei Listen zusätzlich `{ "meta": { … } }`, im Fehlerfall',
        '`{ "error": { "code", "message", "details" } }`. Die Meldung ist Deutsch',
        'und für die Anzeige gedacht; `code` ist die stabile, maschinenlesbare Kennung.',
        '',
        '## Authentifizierung',
        '',
        'Die Sitzung läuft über zwei httpOnly-Cookies: ein Access-Token (15 Minuten)',
        'und ein Refresh-Token (30 Tage). Sie sind für JavaScript nicht lesbar —',
        'ein XSS-Fund erlaubt damit keinen Token-Diebstahl. Läuft der Access-Token',
        'ab, erneuert `POST /api/auth/refresh` das Paar; die Rotation erkennt die',
        'Wiederverwendung eines verbrauchten Tokens und verwirft dann die ganze',
        'Familie.',
        '',
        '## Berechtigungen',
        '',
        'Autorisiert wird über flache `resource:action`-Berechtigungen, die pro Rolle',
        '(ADMIN, MANAGER, EMPLOYEE, CUSTOMER) statisch aufgelöst werden. Zusätzlich',
        'gilt immer Eigentümerschaft: `booking:read_own` liest ausschliesslich die',
        'eigenen Buchungen, und die Einschränkung greift in der Datenbankabfrage,',
        'nicht in der Darstellung.',
        '',
        '## Rate-Limits',
        '',
        'Feste Zeitfenster auf Redis, mit Rückfall auf einen prozesslokalen Speicher.',
        'Der Schlüssel ist die Benutzer-ID bei angemeldeten und die IP-Adresse bei',
        'öffentlichen Endpunkten. Bei Überschreitung antwortet die API mit 429 und',
        'einem `Retry-After`-Header.',
        '',
        '## Geld und Zeit',
        '',
        'Beträge sind Dezimalzahlen in Schweizer Franken mit zwei Nachkommastellen;',
        'sie werden ausschliesslich serverseitig berechnet. Zeitstempel sind',
        'ISO-8601 in UTC; die Anzeige erfolgt in Europe/Zurich.',
      ].join('\n'),
      contact: { name: 'Clenaris', url: 'https://clenaris.ch' },
      license: { name: 'Proprietär', identifier: 'LicenseRef-Proprietary' },
    },
    servers: [
      { url: 'https://clenaris.ch', description: 'Produktion' },
      { url: 'http://localhost:3000', description: 'Lokale Entwicklung' },
    ],
    tags: [
      { name: 'Authentifizierung', description: 'Anmeldung, Sitzungen, Passwörter, Profil' },
      { name: 'Öffentlich', description: 'Endpunkte der Website — ohne Anmeldung erreichbar' },
      { name: 'CRM', description: 'Anfragen, Kundschaft, Verlauf, Aufgaben' },
      { name: 'Nachrichten', description: 'Nachrichtenverläufe und Benachrichtigungen' },
      { name: 'Buchungen', description: 'Termine bestätigen, verschieben, absagen' },
      { name: 'Offerten', description: 'Erstellen, versenden, annehmen, überführen' },
      { name: 'Einsätze', description: 'Disposition, Durchführung, Zeiterfassung' },
      { name: 'Personal', description: 'Mitarbeitende, Abwesenheiten, Bewerbungen' },
      { name: 'Finanzen', description: 'Rechnungen, Zahlungen, Gutschriften, Ausgaben' },
      { name: 'Exporte', description: 'Buchhaltung und Auswertungen als CSV bzw. Excel' },
      { name: 'Inhalte', description: 'Blog und Bewertungen' },
      { name: 'Künstliche Intelligenz', description: 'Entwürfe und Vorschläge — nie Ausführung' },
      { name: 'Dateien', description: 'Signierte Uploads zu Supabase Storage' },
      { name: 'System', description: 'Scheduler und Webhooks' },
    ],
    paths,
    components: {
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'clenaris_access',
          description:
            'httpOnly-Cookie, gesetzt von `POST /api/auth/login`. Für JavaScript nicht lesbar.',
        },
        cronSecret: {
          type: 'http',
          scheme: 'bearer',
          description: 'Nur für den Scheduler: der Wert von `CRON_SECRET`.',
        },
      },
      schemas: {
        SuccessEnvelope: {
          type: 'object',
          required: ['data'],
          properties: {
            data: { description: 'Nutzdaten der Antwort.' },
            meta: {
              type: 'object',
              description: 'Nur bei Listen: Blätterung und Summen.',
              properties: {
                page: { type: 'integer', minimum: 1 },
                pageSize: { type: 'integer', minimum: 1 },
                total: { type: 'integer', minimum: 0 },
                totalPages: { type: 'integer', minimum: 0 },
                hasNext: { type: 'boolean' },
                hasPrev: { type: 'boolean' },
              },
            },
          },
        },
        ErrorEnvelope: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: {
                  type: 'string',
                  description: 'Stabile Kennung, etwa VALIDATION_ERROR oder BUSINESS_RULE.',
                },
                message: {
                  type: 'string',
                  description: 'Deutschsprachige Meldung, für die Anzeige geeignet.',
                },
                details: {
                  type: 'array',
                  description: 'Bei Validierungsfehlern: Feld, Meldung und Zod-Code je Problem.',
                  items: {
                    type: 'object',
                    properties: {
                      field: { type: 'string' },
                      message: { type: 'string' },
                      code: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
//  YAML-Ausgabe
// ---------------------------------------------------------------------------

/**
 * Minimaler YAML-Serialisierer für JSON-förmige Daten.
 *
 * Reicht für eine OpenAPI-Datei völlig aus und erspart eine Abhängigkeit.
 * Zeichenketten werden immer einfach zitiert (und innere Apostrophe
 * verdoppelt) — das ist in YAML immer gültig und braucht keine Escape-Regeln.
 */
function toYaml(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);

  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (typeof value === 'string') {
    if (value.includes('\n')) {
      // Blockliteral: erhält Zeilenumbrüche und braucht keine Zitate.
      const lines = value.split('\n').map((line) => `${pad}  ${line}`.trimEnd());
      return `|-\n${lines.join('\n')}`;
    }
    return `'${value.replace(/'/g, "''")}'`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value
      .map((item) => {
        const isScalar = typeof item !== 'object' || item === null;
        const rendered = toYaml(item, indent + 1);
        if (isScalar || rendered === '{}' || rendered === '[]') {
          return `\n${pad}- ${rendered}`;
        }
        // Ein verschachteltes Objekt beginnt mit "\n" + Einrückung; beides
        // entfällt, damit der erste Schlüssel direkt hinter dem Strich steht.
        return `\n${pad}- ${rendered.slice(1 + 2 * (indent + 1))}`;
      })
      .join('');
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== undefined,
  );
  if (entries.length === 0) return '{}';

  return entries
    .map(([key, item]) => {
      const safeKey = /^[A-Za-z_][\w.-]*$/.test(key) ? key : `'${key.replace(/'/g, "''")}'`;
      const isScalar = typeof item !== 'object' || item === null;
      const rendered = toYaml(item, indent + 1);

      if (isScalar || rendered === '{}' || rendered === '[]') {
        return `\n${pad}${safeKey}: ${rendered}`;
      }
      if (Array.isArray(item)) {
        return `\n${pad}${safeKey}:${rendered}`;
      }
      return `\n${pad}${safeKey}:${rendered}`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
//  Menschenlesbare Referenz
// ---------------------------------------------------------------------------

/** Ein Feld einer Anfrage als Tabellenzeile. */
function fieldRows(schema: JsonSchema, prefix = ''): string[] {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema.required ?? []) as string[]);
  const rows: string[] = [];

  for (const [name, field] of Object.entries(properties)) {
    const path = prefix ? `${prefix}.${name}` : name;

    const bits: string[] = [];
    if (field.enum) bits.push(`\`${(field.enum as string[]).join('` \\| `')}\``);
    if (field.format) bits.push(String(field.format));
    if (field.minLength !== undefined) bits.push(`min. ${field.minLength} Zeichen`);
    if (field.maxLength !== undefined) bits.push(`max. ${field.maxLength} Zeichen`);
    if (field.minimum !== undefined) bits.push(`≥ ${field.minimum}`);
    if (field.maximum !== undefined) bits.push(`≤ ${field.maximum}`);
    if (field.minItems !== undefined) bits.push(`min. ${field.minItems} Einträge`);
    if (field.maxItems !== undefined) bits.push(`max. ${field.maxItems} Einträge`);
    if (field.default !== undefined) bits.push(`Standard \`${JSON.stringify(field.default)}\``);

    const type =
      field.type === 'array'
        ? `${(field.items as JsonSchema | undefined)?.type ?? 'object'}[]`
        : (field.type ?? (field.anyOf ? 'union' : 'object'));

    rows.push(
      `| \`${path}\` | ${type} | ${required.has(name) ? 'ja' : '–'} | ${bits.join(', ') || '–'} |`,
    );

    // Eine Schachtelungsebene reicht: tiefer wird die Tabelle unlesbar, und
    // die Spezifikation nebenan zeigt ohnehin die vollständige Struktur.
    if (!prefix && field.type === 'object' && field.properties) {
      rows.push(...fieldRows(field, path));
    }
    if (!prefix && field.type === 'array') {
      const items = field.items as JsonSchema | undefined;
      if (items?.type === 'object' && items.properties) {
        rows.push(...fieldRows(items, `${path}[]`));
      }
    }
  }

  return rows;
}

function buildMarkdown(): string {
  const byTag = new Map<string, RouteDoc[]>();
  for (const route of ROUTES) {
    const bucket = byTag.get(route.tag) ?? [];
    bucket.push(route);
    byTag.set(route.tag, bucket);
  }

  const lines: string[] = [
    '# API-Referenz',
    '',
    '> Diese Datei wird von `npm run openapi` erzeugt. Änderungen bitte in',
    '> `scripts/openapi-routes.ts` und den Zod-Schemas vornehmen — dort steht die',
    '> Quelle, aus der sowohl diese Referenz als auch die Laufzeitvalidierung',
    '> stammen.',
    '',
    `Stand: ${ROUTES.length} Endpunkte. Die maschinenlesbare Fassung liegt in`,
    '[`openapi.yaml`](./openapi.yaml) bzw. [`openapi.json`](./openapi.json).',
    '',
    '## Grundlagen',
    '',
    '**Umschlag.** Jede JSON-Antwort trägt dieselbe Hülle: bei Erfolg `{ "data": … }`,',
    'bei Listen zusätzlich `{ "meta": { page, pageSize, total, totalPages, hasNext,',
    'hasPrev } }`, im Fehlerfall `{ "error": { "code", "message", "details" } }`.',
    '',
    '**Sitzung.** Zwei httpOnly-Cookies: `clenaris_access` (15 Minuten) und',
    '`clenaris_refresh` (30 Tage). Sie sind für JavaScript nicht lesbar. Läuft der',
    'Access-Token ab, erneuert `POST /api/auth/refresh` beide; die Rotation erkennt',
    'die Wiederverwendung eines verbrauchten Tokens und verwirft dann die ganze',
    'Familie.',
    '',
    '**Fehlercodes.**',
    '',
    '| Status | `code` | Bedeutung |',
    '| --- | --- | --- |',
    '| 400 | `VALIDATION_ERROR` | Eingabe ungültig; `details` nennt Feld und Grund |',
    '| 401 | `UNAUTHORIZED` | keine, abgelaufene oder ungültige Sitzung |',
    '| 403 | `FORBIDDEN` | angemeldet, aber ohne die nötige Berechtigung |',
    '| 404 | `NOT_FOUND` | nicht vorhanden oder für diese Sitzung nicht sichtbar |',
    '| 409 | `CONFLICT` | verstösst gegen eine Eindeutigkeitsregel |',
    '| 422 | `BUSINESS_RULE` | fachlich nicht zulässig |',
    '| 429 | `RATE_LIMITED` | zu viele Anfragen; `Retry-After` in Sekunden |',
    '| 500 | `INTERNAL_ERROR` | unerwarteter Fehler, ohne interne Details |',
    '',
    '## Inhalt',
    '',
    ...[...byTag.keys()].map(
      (tag) => `- [${tag}](#${tag.toLowerCase().replace(/[^a-zäöüß0-9]+/g, '-')})`,
    ),
    '',
  ];

  for (const [tag, routes] of byTag) {
    lines.push(`## ${tag}`, '');

    for (const route of routes) {
      lines.push(
        `### \`${route.method.toUpperCase()} ${route.path}\``,
        '',
        `**${route.summary}.** ${route.description}`,
        '',
        `- **Zugriff:** ${guardText(route.guard)}`,
      );
      if (route.rateLimit) lines.push(`- **Rate-Limit-Klasse:** \`${route.rateLimit}\``);
      lines.push(
        `- **Erfolg:** ${route.status ?? 200}${route.produces ? ` (\`${route.produces}\`)` : ''}`,
        `- **Mögliche Fehler:** ${errorCodesFor(route).join(', ')}`,
        '',
      );

      if (route.params) {
        const rows = fieldRows(zodToJsonSchema(route.params));
        lines.push(
          '**Pfadparameter**',
          '',
          '| Feld | Typ | Pflicht | Regeln |',
          '| --- | --- | --- | --- |',
          ...rows,
          '',
        );
      }

      if (route.query) {
        const rows = fieldRows(zodToJsonSchema(route.query));
        lines.push(
          '**Query-Parameter**',
          '',
          '| Feld | Typ | Pflicht | Regeln |',
          '| --- | --- | --- | --- |',
          ...rows,
          '',
        );
      }

      if (route.body) {
        const rows = fieldRows(zodToJsonSchema(route.body));
        lines.push(
          '**Anfragekörper**',
          '',
          '| Feld | Typ | Pflicht | Regeln |',
          '| --- | --- | --- | --- |',
          ...rows,
          '',
        );
      }
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
//  Lauf
// ---------------------------------------------------------------------------

verifyCoverage();

const spec = buildSpec();
mkdirSync(OUT_DIR, { recursive: true });

writeFileSync(join(OUT_DIR, 'openapi.json'), `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
writeFileSync(join(OUT_DIR, 'openapi.yaml'), `${toYaml(spec).trimStart()}\n`, 'utf8');
writeFileSync(join(OUT_DIR, 'API.md'), buildMarkdown(), 'utf8');

const operationCount = Object.values(spec.paths).reduce(
  (sum, methods) => sum + Object.keys(methods).length,
  0,
);

console.log(
  `✓ docs/openapi.json, docs/openapi.yaml und docs/API.md geschrieben — ` +
    `${Object.keys(spec.paths).length} Pfade, ${operationCount} Operationen.`,
);

// Der Konverter wirft bei unbekannten Zod-Typen; ein stiller Teilerfolg wäre
// schlimmer als ein Abbruch. Der Typ-Import hält das hier sichtbar.
export type { JsonSchema };
