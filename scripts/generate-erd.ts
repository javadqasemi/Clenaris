import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Erzeugt `docs/DATABASE.md` aus `prisma/schema.prisma`.
 *
 * Architekturentscheid: Das ER-Diagramm wird aus dem Schema abgeleitet, nicht
 * daneben gepflegt. Ein von Hand gezeichnetes Diagramm ist am Tag nach der
 * ersten Migration falsch — und ein falsches Diagramm ist schlimmer als
 * keines, weil man ihm glaubt.
 *
 * Ein einziges Diagramm über rund fünfzig Modelle wäre unlesbar. Die Modelle
 * sind deshalb auf fachliche Bereiche verteilt; Beziehungen über
 * Bereichsgrenzen hinweg erscheinen im Diagramm des Bereichs, in dem der
 * Fremdschlüssel steht.
 *
 * Aufruf: `npm run erd`
 */

const ROOT = process.cwd();
const SCHEMA = join(ROOT, 'prisma', 'schema.prisma');
const OUT = join(ROOT, 'docs', 'DATABASE.md');

// ---------------------------------------------------------------------------
//  Schema einlesen
// ---------------------------------------------------------------------------

interface Field {
  name: string;
  type: string;
  isList: boolean;
  isOptional: boolean;
  isId: boolean;
  isUnique: boolean;
  attributes: string;
  comment: string;
}

interface Model {
  name: string;
  table: string;
  fields: Field[];
}

interface EnumDef {
  name: string;
  values: string[];
}

function parseSchema(source: string): { models: Model[]; enums: EnumDef[] } {
  const models: Model[] = [];
  const enums: EnumDef[] = [];

  const blockPattern = /^(model|enum)\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  for (const match of source.matchAll(blockPattern)) {
    const [, kind, name, body] = match;

    if (kind === 'enum') {
      enums.push({
        name,
        values: body
          .split('\n')
          .map((line) => line.replace(/\/\/.*$/, '').trim())
          .filter((line) => /^\w+$/.test(line)),
      });
      continue;
    }

    const fields: Field[] = [];
    let table = name;

    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('//') || line.startsWith('///')) continue;

      const mapMatch = line.match(/^@@map\("([^"]+)"\)/);
      if (mapMatch) {
        table = mapMatch[1];
        continue;
      }
      if (line.startsWith('@@')) continue;

      const fieldMatch = line.match(/^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/);
      if (!fieldMatch) continue;

      const [, fieldName, type, list, optional, rest] = fieldMatch;
      const commentSplit = rest.split('//');
      const attributes = commentSplit[0].trim();

      fields.push({
        name: fieldName,
        type,
        isList: Boolean(list),
        isOptional: Boolean(optional),
        isId: attributes.includes('@id'),
        isUnique: attributes.includes('@unique'),
        attributes,
        comment: (commentSplit[1] ?? '').trim(),
      });
    }

    models.push({ name, table, fields });
  }

  return { models, enums };
}

// ---------------------------------------------------------------------------
//  Fachliche Bereiche
// ---------------------------------------------------------------------------

interface Domain {
  key: string;
  title: string;
  purpose: string;
  models: string[];
}

const DOMAINS: Domain[] = [
  {
    key: 'stammdaten',
    title: 'Mandant und Stammdaten',
    purpose:
      'Die `Organization` ist die Wurzel des Mandanten: nahezu jede Tabelle hängt über ' +
      '`organizationId` daran. Die Plattform ist heute einmandantig betrieben, das Schema ' +
      'aber bereits mehrmandantenfähig — eine nachträgliche Einführung dieser Spalte über ' +
      'fünfzig Tabellen wäre eine Migration, die man nicht zweimal machen will. ' +
      '`NumberSequence` erzeugt die lückenlosen Belegnummern innerhalb der jeweiligen ' +
      'Geschäftstransaktion.',
    models: ['Organization', 'NumberSequence', 'OpeningHours', 'Holiday', 'ServiceArea', 'TaxRate'],
  },
  {
    key: 'identitaet',
    title: 'Identität und Zugriff',
    purpose:
      '`User` trägt Anmeldung und Rolle; `Customer` und `Employee` sind die fachlichen ' +
      'Profile daneben. Diese Trennung erlaubt Gastbuchungen ohne Konto und Kundendatensätze, ' +
      'die erst später ein Login erhalten. `RefreshToken` speichert nur den SHA-256-Hash und ' +
      'eine Familien-ID — daran erkennt die Rotation die Wiederverwendung eines bereits ' +
      'verbrauchten Tokens. `AuditLog` und `Consent` sind die Nachweisschicht für das ' +
      'Schweizer DSG und die DSGVO.',
    models: ['User', 'RefreshToken', 'VerificationToken', 'Consent', 'AuditLog'],
  },
  {
    key: 'crm',
    title: 'CRM',
    purpose:
      'Der Weg einer Anfrage: `Lead` → `Customer` → `Property`. Adressen und Objekte sind ' +
      'eigene Tabellen, weil ein Geschäftskunde mehrere Liegenschaften hat und eine ' +
      'Rechnungsadresse selten die Einsatzadresse ist. `Activity` ist die gemeinsame ' +
      'Zeitachse über Kundschaft, Anfragen, Einsätze und Belege.',
    models: [
      'Lead',
      'Customer',
      'Contact',
      'Address',
      'Building',
      'Property',
      'PipelineStage',
      'Tag',
      'LeadTag',
      'CustomerTag',
      'Activity',
      'Task',
      'PaymentMethodRef',
    ],
  },
  {
    key: 'katalog',
    title: 'Leistungskatalog und Preislogik',
    purpose:
      'Der Katalog bestimmt, was angeboten wird und was es kostet. `PriceRule` trägt die ' +
      'Bedingung als JSON und wird von `lib/pricing/engine.ts` ausgewertet — so lassen sich ' +
      'Wochenend- und Flächenzuschläge ohne Codeänderung ergänzen. Preise gelten immer ' +
      'serverseitig; der Browser rechnet nur mit, um sofort etwas anzeigen zu können.',
    models: [
      'ServiceCategory',
      'Service',
      'ServiceExtra',
      'ServiceExtraOnService',
      'PriceRule',
      'RecurrenceRule',
    ],
  },
  {
    key: 'auftrag',
    title: 'Buchung, Offerte, Einsatz',
    purpose:
      'Die drei Formen eines Auftrags. `Booking` ist die Vereinbarung mit der Kundschaft, ' +
      '`Job` die Ausführung durch das Team — getrennt, weil eine wöchentliche Buchung ' +
      'zweiundfünfzig Einsätze erzeugt. Preise werden in der Buchung als Momentaufnahme ' +
      'festgehalten: ändert sich der Katalog, bleibt der vereinbarte Preis gültig.',
    models: [
      'Booking',
      'BookingItem',
      'BookingExtra',
      'Quote',
      'QuoteItem',
      'Job',
      'JobAssignment',
      'JobChecklistItem',
      'JobPhoto',
      'MaterialUsage',
    ],
  },
  {
    key: 'personal',
    title: 'Personal und Zeit',
    purpose:
      '`TimeEntry` ist die Grundlage der Lohnabrechnung, `GpsEvent` belegt An- und Abfahrt ' +
      'bei Objekten ohne Ansprechperson. `Availability` und `Absence` speisen die ' +
      'Disposition: wer abwesend ist, erscheint gar nicht erst als Vorschlag.',
    models: [
      'Employee',
      'EmployeeSkill',
      'Availability',
      'Absence',
      'Payslip',
      'TimeEntry',
      'GpsEvent',
    ],
  },
  {
    key: 'finanzen',
    title: 'Finanzen',
    purpose:
      'Finanzbelege sind fortschreibend, nie überschreibend: eine ausgestellte `Invoice` ' +
      'wird nicht mehr geändert, Korrekturen laufen über `CreditNote`. Das verlangt die ' +
      'Aufbewahrungspflicht nach Art. 957a OR. `Payment.providerPaymentId` ist eindeutig — ' +
      'daran erkennt der Stripe-Webhook eine bereits gebuchte Zahlung und bleibt idempotent.',
    models: [
      'Invoice',
      'InvoiceItem',
      'Payment',
      'PaymentReminder',
      'CreditNote',
      'Supplier',
      'Expense',
      'AccountingExport',
    ],
  },
  {
    key: 'kommunikation',
    title: 'Kommunikation und Automatisierung',
    purpose:
      'Jeder ausgehende Versand wird protokolliert (`EmailLog`, `SmsLog`) — bei einer ' +
      'Reklamation muss belegbar sein, was wann an wen ging. `Automation` beschreibt ' +
      'Auslöser und Aktionen als Daten, damit sich Abläufe ohne Codeänderung anpassen lassen.',
    models: [
      'MessageThread',
      'Message',
      'Notification',
      'EmailTemplate',
      'SmsTemplate',
      'EmailLog',
      'SmsLog',
      'Automation',
      'AutomationAction',
      'AutomationRun',
    ],
  },
  {
    key: 'marketing',
    title: 'Marketing und Inhalte',
    purpose:
      'Website-Inhalte und Vertriebsinstrumente. Bewertungen durchlaufen immer die ' +
      'Moderation, bevor sie öffentlich werden — veröffentlicht wird auch die kritische, ' +
      'aber erst nachdem der Betrieb sie gesehen und beantwortet hat.',
    models: [
      'Coupon',
      'GiftCard',
      'NewsletterSubscriber',
      'BlogCategory',
      'BlogPost',
      'LandingPage',
      'Review',
      'Faq',
      'GalleryItem',
      'JobPosting',
      'JobApplication',
      'FileAsset',
    ],
  },
  {
    key: 'redaktion',
    title: 'Redaktion',
    purpose:
      'Die Texte der öffentlichen Website. `ContentBlock` ist ein Schlüssel-Wert-Speicher; ' +
      'welche Schlüssel gültig sind und welcher Text gilt, solange nichts gepflegt wurde, ' +
      'steht als Register im Code (`lib/cms/registry.ts`). Daraus folgt, dass eine fehlende ' +
      'Zeile die Website nicht zerlegt — sie zeigt dann den Auslieferungstext. `SeoMeta` hängt ' +
      'bewusst an einer *Route* und nicht an einem Baustein: `noIndex` ist eine technische ' +
      'Schaltung, die eine Seite aus dem Suchindex wirft.',
    models: ['ContentBlock', 'SeoMeta', 'CallToAction'],
  },
];

// ---------------------------------------------------------------------------
//  Mermaid
// ---------------------------------------------------------------------------

/**
 * Kardinalität in Mermaid-Schreibweise für die Kante `Ziel …… Quelle`.
 *
 * Gezeichnet wird immer von der Seite ohne Fremdschlüssel (links, „eins") zur
 * Seite mit Fremdschlüssel (rechts, „viele"). Ist die Fremdschlüsselspalte
 * `@unique`, ist es in Wahrheit eine Eins-zu-eins-Beziehung.
 */
function relationSymbol(field: Field, owner: Model): string {
  const left = field.isOptional ? '|o' : '||';

  // `@relation(fields: [customerId])` → die Spalte, die den Schlüssel trägt.
  const scalarName = field.attributes.match(/fields:\s*\[(\w+)\]/)?.[1];
  const scalar = scalarName ? owner.fields.find((f) => f.name === scalarName) : undefined;
  const right = scalar?.isUnique ? '||' : 'o{';

  return `${left}--${right}`;
}

function buildDiagram(models: Model[], scope: Set<string>): string {
  const known = new Map(models.map((model) => [model.name, model]));
  const lines: string[] = ['erDiagram'];
  const seen = new Set<string>();

  for (const model of models) {
    if (!scope.has(model.name)) continue;

    // Nur Skalarfelder in die Box — Beziehungsfelder stehen als Kanten daneben.
    const columns = model.fields
      .filter((field) => !known.has(field.type))
      .slice(0, 8)
      .map((field) => {
        const marker = field.isId ? ' PK' : field.isUnique ? ' UK' : '';
        const type = field.isList ? `${field.type}_list` : field.type;
        return `    ${type} ${field.name}${marker}`;
      });

    lines.push(`  ${model.name} {`, ...columns, '  }');
  }

  for (const model of models) {
    if (!scope.has(model.name)) continue;

    for (const field of model.fields) {
      const target = known.get(field.type);
      if (!target) continue;

      // Kanten über Bereichsgrenzen hinweg nur, wenn beide Seiten sichtbar sind.
      if (!scope.has(target.name)) continue;

      // Prisma beschreibt jede Beziehung von beiden Seiten. Gezeichnet wird
      // ausschliesslich die Seite, die den Fremdschlüssel trägt — die
      // Listenseite ist dieselbe Kante von hinten.
      if (field.isList) continue;

      // Mehrere Fremdschlüssel auf dasselbe Ziel (etwa `Booking` → `Address`
      // als Einsatz- und als Rechnungsadresse) bleiben getrennte Kanten; der
      // Feldname macht sie unterscheidbar.
      const key = `${model.name}.${field.name}->${target.name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      lines.push(
        `  ${target.name} ${relationSymbol(field, model)} ${model.name} : "${field.name}"`,
      );
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
//  Dokument
// ---------------------------------------------------------------------------

const source = readFileSync(SCHEMA, 'utf8');
const { models, enums } = parseSchema(source);
const byName = new Map(models.map((model) => [model.name, model]));

const assigned = new Set(DOMAINS.flatMap((domain) => domain.models));
const unassigned = models.filter((model) => !assigned.has(model.name));
const missing = [...assigned].filter((name) => !byName.has(name));

if (missing.length) {
  throw new Error(
    `In DOMAINS stehen Modelle, die es im Schema nicht (mehr) gibt: ${missing.join(', ')}`,
  );
}
if (unassigned.length) {
  throw new Error(
    `Diese Modelle sind keinem Bereich zugeordnet: ${unassigned.map((m) => m.name).join(', ')}. ` +
      'Bitte in `scripts/generate-erd.ts` unter DOMAINS ergänzen.',
  );
}

const totalFields = models.reduce((sum, model) => sum + model.fields.length, 0);

const doc: string[] = [
  '# Datenmodell',
  '',
  '> Diese Datei wird von `npm run erd` aus `prisma/schema.prisma` erzeugt. Die',
  '> Diagramme sind damit nie älter als das Schema. Prosa und Bereichseinteilung',
  '> stehen in `scripts/generate-erd.ts`.',
  '',
  `**${models.length} Modelle, ${enums.length} Aufzählungstypen, ${totalFields} Felder.**`,
  'PostgreSQL 16+; alle Zeitstempel als `timestamptz` in UTC, Anzeige in Europe/Zurich.',
  '',
  '## Vier Entscheidungen, die das ganze Schema prägen',
  '',
  '**1. `Organization` als Mandantenwurzel.** Fast jede Tabelle trägt eine',
  '`organizationId`. Die Plattform läuft heute einmandantig, aber diese Spalte',
  'nachträglich über fünfzig Tabellen einzuziehen wäre eine Migration, die man',
  'nicht zweimal machen will.',
  '',
  '**2. Selektive Soft-Deletes.** `deletedAt` tragen nur die Tabellen, deren',
  'Einträge man später noch braucht: Kundschaft, Buchungen, Offerten, Einsätze,',
  'Rechnungen, Objekte. Eine gelöschte Benachrichtigung ist dagegen einfach weg.',
  'Überall Soft-Deletes bedeutet, überall daran denken zu müssen — und irgendwo',
  'vergisst man es.',
  '',
  '**3. Finanzbelege sind fortschreibend.** Eine ausgestellte Rechnung wird nie',
  'geändert oder gelöscht; Korrekturen entstehen als Gutschrift. Die',
  'Belegnummern kommen aus `NumberSequence` und werden innerhalb derselben',
  'Transaktion vergeben wie der Beleg — nur so bleibt die Folge lückenlos, wie',
  'es Art. 957a OR verlangt.',
  '',
  '**4. Momentaufnahmen statt Verweise bei Preisen und Adressen.** Buchungen,',
  'Offerten und Rechnungen speichern Bezeichnung, Ansatz und Empfängeranschrift',
  'als Kopie. Ändert sich der Katalog oder zieht die Kundschaft um, bleibt der',
  'Beleg so lesbar, wie er ausgestellt wurde.',
  '',
  '## Bereichsübersicht',
  '',
  '```mermaid',
  'flowchart LR',
  ...DOMAINS.map(
    (domain) =>
      `  ${domain.key}["${domain.title}<br/><small>${domain.models.length} Modelle</small>"]`,
  ),
  '  stammdaten --> identitaet',
  '  identitaet --> crm',
  '  crm --> auftrag',
  '  katalog --> auftrag',
  '  auftrag --> personal',
  '  auftrag --> finanzen',
  '  crm --> kommunikation',
  '  crm --> marketing',
  '  stammdaten --> redaktion',
  '```',
  '',
];

for (const domain of DOMAINS) {
  const scope = new Set(domain.models);

  doc.push(
    `## ${domain.title}`,
    '',
    domain.purpose,
    '',
    '```mermaid',
    buildDiagram(models, scope),
    '```',
    '',
    '| Modell | Tabelle | Felder | Zweck |',
    '| --- | --- | --- | --- |',
  );

  for (const name of domain.models) {
    const model = byName.get(name)!;
    // Der Zweck steht als Dreifach-Slash-Kommentar direkt über dem Modell im
    // Schema; fehlt er, bleibt die Zelle leer statt erfunden zu werden.
    const docComment = source.match(
      new RegExp(`^///\\s*(.+)\\n(?:///.*\\n)*model\\s+${name}\\s*\\{`, 'm'),
    );
    doc.push(
      `| \`${model.name}\` | \`${model.table}\` | ${model.fields.length} | ${docComment?.[1] ?? '–'} |`,
    );
  }

  doc.push('');
}

doc.push(
  '## Aufzählungstypen',
  '',
  'PostgreSQL-`ENUM`-Typen statt Textspalten mit Prüfbedingung: die Datenbank',
  'weist einen unbekannten Wert von sich aus zurück, und Prisma erzeugt daraus',
  'exakte TypeScript-Typen.',
  '',
  '| Typ | Werte |',
  '| --- | --- |',
  ...enums.map((e) => `| \`${e.name}\` | ${e.values.map((v) => `\`${v}\``).join(', ')} |`),
  '',
  '## Migrationen',
  '',
  '```bash',
  'npm run db:migrate     # Entwicklung: Migration erzeugen und anwenden',
  'npm run db:deploy      # Produktion: vorhandene Migrationen anwenden',
  'npm run db:seed        # Schweizer Demodaten (idempotent)',
  'npm run db:studio      # Prisma Studio',
  'npm run erd            # diese Datei neu erzeugen',
  '```',
  '',
  'Die Erstmigration liegt in `prisma/migrations/`. Sie legt alle Aufzählungs-',
  'typen, Tabellen, Indizes und Fremdschlüssel an; `npm run db:seed` füllt sie',
  'anschliessend mit einem vollständigen Betrieb im Kanton Bern.',
  '',
);

mkdirSync(join(ROOT, 'docs'), { recursive: true });
writeFileSync(OUT, `${doc.join('\n').trimEnd()}\n`, 'utf8');

console.log(
  `✓ docs/DATABASE.md geschrieben — ${models.length} Modelle in ${DOMAINS.length} Bereichen, ` +
    `${enums.length} Aufzählungstypen.`,
);
