import 'server-only';

import type { Prisma } from '@prisma/client';

import { prisma, type Tx } from '@/lib/db';
import { BusinessRuleError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import type { PurgeAreaKey } from '@/lib/validation/system';
import type { SequenceScope } from './numbering.service';

const log = logger('purge');

/**
 * Datenbereinigung: ganze Datenbereiche endgültig löschen.
 *
 * Wofür das da ist: Demodaten vor dem Livegang entfernen, eine Testphase
 * abschliessen, einen Mandanten leerräumen. Wofür es *nicht* da ist: den
 * einzelnen falschen Datensatz — dafür gibt es den Papierkorb, und der ist
 * umkehrbar. Diese Funktion ist es nicht.
 *
 * Entscheide:
 *
 *  • **Bereiche, nicht Tabellen.** Die Systemverantwortung wählt «Finanzen»
 *    oder «Kundschaft», nicht `invoice_items`. Welche Tabellen ein Bereich
 *    umfasst und in welcher Reihenfolge sie geleert werden, steht einmal
 *    hier — mit dem Fremdschlüssel als Grund für die Reihenfolge.
 *
 *  • **Feste Reihenfolge der Bereiche.** Rechnungen und Gutschriften halten
 *    ihre Kundschaft mit `Restrict` fest. Finanzen werden deshalb vor der
 *    Kundschaft geleert, und wer die Kundschaft ohne die Finanzen löschen
 *    will, bekommt eine Erklärung statt eines Fremdschlüsselfehlers.
 *
 *  • **Ein Lauf, eine Transaktion, ein Protokolleintrag je Bereich — und
 *    der Eintrag entsteht *innerhalb* der Transaktion.** Das übliche
 *    `recordAudit` schluckt Fehler, damit die Geschäftstransaktion nie am
 *    Protokoll scheitert. Hier ist es umgekehrt: Ein Löschen, das nicht
 *    protokolliert werden kann, findet nicht statt.
 *
 *  • **Nie gelöscht:** Organisation und Einstellungen, Leistungskatalog und
 *    Preise, Website-Texte, das Prüfprotokoll, die Systemverantwortung und
 *    das eigene Konto.
 *
 *  • **Dateien:** Anhänge, die an gelöschten Datensätzen hängen, verschwinden
 *    mit ihnen (Kaskade auf `FileAsset`). Die Ablage selbst wird nicht
 *    bereinigt — verwaiste Blobs kosten Speicher, keine Korrektheit.
 */

/**
 * Zugriff auf ein Prisma-Modell über seinen Namen.
 *
 * Die Schritte unten sind Daten, keine Funktionen — sonst stünde hier
 * vierzigmal derselbe Dreizeiler. Der Preis ist ein Cast, weil der Prisma-
 * Client seine Modelle nicht als indexierbaren Typ anbietet. Ein Tippfehler
 * im Modellnamen fällt beim ersten Aufruf der Vorschau auf, nicht erst beim
 * Löschen: `delegate()` wirft, wenn es das Modell nicht gibt.
 */
interface Delegate {
  count(args: { where: unknown }): Promise<number>;
  deleteMany(args: { where: unknown }): Promise<{ count: number }>;
}

function delegate(client: Tx | typeof prisma, model: string): Delegate {
  const found = (client as unknown as Record<string, Delegate | undefined>)[model];
  if (!found || typeof found.deleteMany !== 'function') {
    throw new Error(`Datenbereinigung: unbekanntes Modell „${model}"`);
  }
  return found;
}

interface StepContext {
  organizationId: string;
  /** Wer löscht — bleibt bei «Personal» ausgenommen. */
  actorId: string;
}

interface Step {
  /** Prisma-Modellname in Client-Schreibweise (`creditNote`, nicht `CreditNote`). */
  model: string;
  /** Deutsche Mehrzahl für Vorschau und Protokoll. */
  label: string;
  /**
   * Mandantenfilter. Modelle ohne `organizationId` (Zahlungen, Aufgaben,
   * Nachrichtenverläufe, Versandprotokolle) werden über ihre Beziehung
   * gefiltert oder — wo es keine gibt — ohne Filter geleert; die Anwendung
   * ist ein Mandant, und die Kommentare an den Stellen sagen es.
   */
  where: (ctx: StepContext) => unknown;
}

export interface PurgeArea {
  key: PurgeAreaKey;
  label: string;
  description: string;
  /** Warnung, die das Formular hervorhebt. */
  warning?: string;
  steps: Step[];
  /** Nummernkreise, die dieser Bereich verbraucht. */
  sequences: SequenceScope[];
}

const byOrganization = ({ organizationId }: StepContext) => ({ organizationId });

/**
 * Die Bereiche in Ausführungsreihenfolge. Sie ist nicht beliebig:
 * Finanzen vor Kundschaft (Restrict), Aufträge vor Kundschaft (damit die
 * Kaskade nicht die Arbeit macht, die die Vorschau gezählt hat), Personal
 * zuletzt (Zeiteinträge und Einsatzzuteilungen hängen an beidem).
 */
export const PURGE_AREAS: PurgeArea[] = [
  {
    key: 'finanzen',
    label: 'Finanzen',
    description: 'Rechnungen mit Positionen und Mahnungen, Gutschriften, Zahlungen, Ausgaben, Buchhaltungsexporte, Geschenkkarten.',
    warning:
      'Ausgestellte Rechnungen sind nach Art. 957a OR aufzubewahren. Löschen Sie diesen Bereich nur, wenn es sich um Demo- oder Testdaten handelt.',
    steps: [
      {
        model: 'payment',
        label: 'Zahlungen',
        // Zahlungen tragen keine Organisation; sie hängen an Rechnung oder
        // Kundschaft. Verwaiste (beides leer) gehören ebenfalls weg.
        where: ({ organizationId }) => ({
          OR: [
            { invoice: { organizationId } },
            { customer: { organizationId } },
            { invoiceId: null, customerId: null },
          ],
        }),
      },
      { model: 'creditNote', label: 'Gutschriften', where: byOrganization },
      { model: 'invoice', label: 'Rechnungen', where: byOrganization },
      { model: 'expense', label: 'Ausgaben', where: byOrganization },
      { model: 'accountingExport', label: 'Buchhaltungsexporte', where: byOrganization },
      { model: 'giftCard', label: 'Geschenkkarten', where: byOrganization },
    ],
    sequences: ['invoice', 'credit_note'],
  },
  {
    key: 'auftraege',
    label: 'Buchungen, Einsätze und Offerten',
    description: 'Buchungen samt Serien, Einsätze mit Zuteilungen, Checklisten, Fotos und Material, Offerten mit Positionen.',
    steps: [
      { model: 'job', label: 'Einsätze', where: byOrganization },
      { model: 'booking', label: 'Buchungen', where: byOrganization },
      {
        model: 'recurrenceRule',
        label: 'Serienregeln',
        // Keine Organisation am Modell; nach den Buchungen sind alle Regeln
        // ohne Buchung verwaist.
        where: () => ({ bookings: { none: {} } }),
      },
      { model: 'quote', label: 'Offerten', where: byOrganization },
    ],
    sequences: ['booking', 'job', 'quote'],
  },
  {
    key: 'crm',
    label: 'Anfragen und Kundschaft',
    description: 'Anfragen, Kundschaft mit Kontakten, Adressen, Objekten und Gebäuden, dazu die Kundenkonten (Anmeldungen).',
    warning: 'Setzt voraus, dass Finanzen bereits geleert sind oder mitgewählt werden — Rechnungen halten ihre Kundschaft fest.',
    steps: [
      { model: 'lead', label: 'Anfragen', where: byOrganization },
      { model: 'customer', label: 'Kundschaft', where: byOrganization },
      {
        model: 'building',
        label: 'Gebäude',
        // Gebäude kennen keine Organisation und keine Kundschaft direkt —
        // nach dem Löschen der Objekte sind alle ohne Objekt verwaist.
        where: () => ({ properties: { none: {} } }),
      },
      {
        model: 'user',
        label: 'Kundenkonten',
        where: ({ organizationId }) => ({ organizationId, role: 'CUSTOMER' }),
      },
    ],
    sequences: ['customer', 'lead'],
  },
  {
    key: 'kommunikation',
    label: 'Kommunikation und Aufgaben',
    description: 'Nachrichtenverläufe, Aufgaben, Aktivitäten, Benachrichtigungen, E-Mail- und SMS-Versandprotokolle, Automationsläufe.',
    steps: [
      // Die vier Modelle ohne Organisation: die Anwendung ist ein Mandant.
      { model: 'messageThread', label: 'Nachrichtenverläufe', where: () => ({}) },
      { model: 'task', label: 'Aufgaben', where: () => ({}) },
      { model: 'activity', label: 'Aktivitäten', where: () => ({}) },
      { model: 'emailLog', label: 'E-Mail-Protokolle', where: () => ({}) },
      { model: 'smsLog', label: 'SMS-Protokolle', where: () => ({}) },
      {
        model: 'notification',
        label: 'Benachrichtigungen',
        where: ({ organizationId }) => ({ user: { organizationId } }),
      },
      {
        model: 'automationRun',
        label: 'Automationsläufe',
        where: ({ organizationId }) => ({ automation: { organizationId } }),
      },
    ],
    sequences: [],
  },
  {
    key: 'website',
    label: 'Website-Einträge',
    description: 'Bewertungen, Galerie, Blogbeiträge, Newsletter-Anmeldungen, Bewerbungen. Texte, Fragen, Menü und Rechtstexte bleiben.',
    steps: [
      { model: 'review', label: 'Bewertungen', where: byOrganization },
      { model: 'galleryItem', label: 'Galeriebilder', where: byOrganization },
      { model: 'blogPost', label: 'Blogbeiträge', where: byOrganization },
      { model: 'newsletterSubscriber', label: 'Newsletter-Anmeldungen', where: byOrganization },
      {
        model: 'jobApplication',
        label: 'Bewerbungen',
        where: ({ organizationId }) => ({ posting: { organizationId } }),
      },
    ],
    sequences: [],
  },
  {
    key: 'fuehrung',
    label: 'Unternehmensführung',
    description: 'Ziele, Budgets, Investitionen, Szenarien, Risiken, Kontrollen, Massnahmen, Dokumente, Wissen, Markt, Sitzungen, Berichte und die gespeicherte Kennzahlen-Historie. Kennzahlen-Definitionen bleiben.',
    steps: [
      { model: 'reportRun', label: 'Berichtsläufe', where: byOrganization },
      { model: 'reportSchedule', label: 'Berichtspläne', where: byOrganization },
      { model: 'meeting', label: 'Sitzungen', where: byOrganization },
      { model: 'analysisBoard', label: 'Analysetafeln', where: byOrganization },
      { model: 'marketInsight', label: 'Markteinblicke', where: byOrganization },
      { model: 'competitor', label: 'Mitbewerber', where: byOrganization },
      { model: 'knowledgeArticle', label: 'Wissensartikel', where: byOrganization },
      { model: 'managedDocument', label: 'Dokumente', where: byOrganization },
      { model: 'correctiveAction', label: 'Massnahmen', where: byOrganization },
      { model: 'controlEntry', label: 'Kontrollen', where: byOrganization },
      { model: 'riskEntry', label: 'Risiken', where: byOrganization },
      { model: 'scenario', label: 'Szenarien', where: byOrganization },
      { model: 'investment', label: 'Investitionen', where: byOrganization },
      { model: 'budgetPeriod', label: 'Budgetperioden', where: byOrganization },
      { model: 'objective', label: 'Ziele', where: byOrganization },
      {
        model: 'kpiTarget',
        label: 'Kennzahlen-Zielwerte',
        where: ({ organizationId }) => ({ definition: { organizationId } }),
      },
      { model: 'kpiSnapshot', label: 'Kennzahlen-Historie', where: byOrganization },
      { model: 'healthSnapshot', label: 'Gesundheitswerte', where: byOrganization },
    ],
    sequences: [],
  },
  {
    key: 'personal',
    label: 'Personal',
    description: 'Mitarbeitende mit Lohnhistorie, Fähigkeiten, Verfügbarkeiten, Abwesenheiten, Lohnabrechnungen, Zeiteinträgen und Einsatzzuteilungen — samt ihren Benutzerkonten.',
    warning: 'Ausgenommen sind die Systemverantwortung und das eigene Konto. Wer sich selbst löschen könnte, könnte auch die Spur verwischen.',
    steps: [
      {
        model: 'user',
        label: 'Mitarbeitende',
        // Die Personalakte hängt am Benutzerkonto (Kaskade), nicht umgekehrt.
        // Deshalb werden die Konten gelöscht, und die Akten folgen.
        where: ({ organizationId, actorId }) => ({
          organizationId,
          employee: { isNot: null },
          role: { not: 'SUPER_ADMIN' },
          id: { not: actorId },
        }),
      },
    ],
    sequences: ['employee'],
  },
];

const AREA_BY_KEY = new Map(PURGE_AREAS.map((area) => [area.key, area]));

// ---------------------------------------------------------------------------
//  Vorschau
// ---------------------------------------------------------------------------

export interface PurgePreviewArea {
  key: PurgeAreaKey;
  label: string;
  description: string;
  warning?: string;
  sequences: SequenceScope[];
  counts: { model: string; label: string; count: number }[];
  total: number;
}

/**
 * Was ein Lauf löschen würde — je Bereich die Zahl der Hauptdatensätze.
 * Untergeordnete Zeilen (Positionen, Zuteilungen, Fotos) folgen per Kaskade
 * und werden nicht gezählt; die Zahl soll die Frage «wie viel steht da?»
 * beantworten, nicht die Tabellen aufzählen.
 */
export async function previewPurge(ctx: StepContext): Promise<PurgePreviewArea[]> {
  return Promise.all(
    PURGE_AREAS.map(async (area) => {
      const counts = await Promise.all(
        area.steps.map(async (step) => ({
          model: step.model,
          label: step.label,
          count: await delegate(prisma, step.model).count({ where: step.where(ctx) }),
        })),
      );
      return {
        key: area.key,
        label: area.label,
        description: area.description,
        warning: area.warning,
        sequences: area.sequences,
        counts,
        total: counts.reduce((sum, entry) => sum + entry.count, 0),
      };
    }),
  );
}

// ---------------------------------------------------------------------------
//  Lauf
// ---------------------------------------------------------------------------

export interface PurgeResultArea {
  key: PurgeAreaKey;
  label: string;
  deleted: { model: string; label: string; count: number }[];
  total: number;
  sequencesReset: SequenceScope[];
}

/**
 * Auslöser des Rücksprungs im Probelauf.
 *
 * Eine Transaktion rollt nur zurück, wenn sie mit einem Fehler endet. Dieses
 * Merkmal ist der gewollte Fehler — es wird aussen abgefangen und nicht
 * weitergereicht.
 */
const ROLLBACK = Symbol('purge-rollback');

export async function runPurge(params: {
  organizationId: string;
  actorId: string;
  areas: PurgeAreaKey[];
  resetSequences: boolean;
  ip?: string | null;
  userAgent?: string | null;
  /**
   * Probelauf: alles ausführen, am Ende zurückrollen.
   *
   * Der einzige Weg, den Löschpfad zu prüfen, ohne den Bestand zu leeren —
   * und damit der einzige Weg, ihn überhaupt zu prüfen. Geprüft wird das
   * Echte: dieselben `deleteMany` in derselben Reihenfolge, derselbe
   * Protokolleintrag, dasselbe Zurücksetzen der Nummernkreise. Ein
   * Fremdschlüssel, der erst beim tatsächlichen Löschen zuschlägt, fällt
   * hier auf und nicht im Betrieb.
   *
   * Nicht über die Schnittstelle erreichbar: `scripts/purge-dry-run.ts` ruft
   * die Funktion direkt auf. Der Endpunkt hat für die Vorschau `GET`.
   */
  dryRun?: boolean;
}): Promise<PurgeResultArea[]> {
  const { organizationId, actorId } = params;
  const ctx: StepContext = { organizationId, actorId };

  // In der festen Reihenfolge der Definition, nicht in der der Anfrage.
  const selected = PURGE_AREAS.filter((area) => params.areas.includes(area.key));
  if (selected.length === 0) {
    throw new BusinessRuleError('Es wurde kein Bereich ausgewählt.');
  }

  // Die eine Fremdschlüsselsperre, die sich nicht durch Reihenfolge lösen
  // lässt: Rechnungen und Gutschriften halten ihre Kundschaft fest.
  if (params.areas.includes('crm') && !params.areas.includes('finanzen')) {
    const [invoices, creditNotes] = await Promise.all([
      prisma.invoice.count({ where: { organizationId } }),
      prisma.creditNote.count({ where: { organizationId } }),
    ]);
    if (invoices + creditNotes > 0) {
      throw new BusinessRuleError(
        `Die Kundschaft lässt sich nicht löschen, solange ${invoices} Rechnungen und ${creditNotes} Gutschriften auf sie verweisen. Wählen Sie den Bereich «Finanzen» mit.`,
      );
    }
  }

  const actor = await prisma.user.findUnique({
    where: { id: actorId },
    select: { email: true, firstName: true, lastName: true },
  });
  const actorLabel = actor ? `${actor.firstName} ${actor.lastName} (${actor.email})` : actorId;

  // Ausserhalb der Transaktion, damit der Probelauf sein Ergebnis behält:
  // was die Transaktion zurückgibt, geht mit dem Rücksprung verloren.
  const out: PurgeResultArea[] = [];

  await prisma
    .$transaction(
    async (tx) => {
      for (const area of selected) {
        const deleted: PurgeResultArea['deleted'] = [];
        for (const step of area.steps) {
          const { count } = await delegate(tx, step.model).deleteMany({ where: step.where(ctx) });
          deleted.push({ model: step.model, label: step.label, count });
        }

        const sequencesReset = params.resetSequences ? area.sequences : [];
        if (sequencesReset.length > 0) {
          await tx.numberSequence.deleteMany({
            where: { organizationId, scope: { in: sequencesReset } },
          });
        }

        const total = deleted.reduce((sum, entry) => sum + entry.count, 0);
        const summary =
          `Datenbereinigung durch ${actorLabel}: Bereich «${area.label}» geleert — ` +
          deleted
            .filter((entry) => entry.count > 0)
            .map((entry) => `${entry.count} ${entry.label}`)
            .join(', ') +
          (total === 0 ? 'nichts zu löschen' : '') +
          (sequencesReset.length > 0 ? ` · Nummernkreise zurückgesetzt: ${sequencesReset.join(', ')}` : '');

        // Im selben Commit wie das Löschen. Scheitert das Protokoll, rollt
        // alles zurück — ein unprotokolliertes Löschen gibt es nicht.
        await tx.auditLog.create({
          data: {
            organizationId,
            userId: actorId,
            action: 'DELETE',
            entity: 'Datenbereinigung',
            entityId: area.key,
            summary: summary.slice(0, 500),
            changes: {
              bereich: area.key,
              geloescht: Object.fromEntries(deleted.map((entry) => [entry.label, entry.count])),
              nummernkreiseZurueckgesetzt: sequencesReset,
            } as Prisma.InputJsonValue,
            ip: params.ip ?? null,
            userAgent: params.userAgent?.slice(0, 300) ?? null,
          },
        });

        out.push({ key: area.key, label: area.label, deleted, total, sequencesReset });
      }

      if (params.dryRun) throw ROLLBACK;
    },
    // Grosse Demodatenbestände brauchen länger als die fünf Sekunden
    // Standard — und ein Abbruch mitten im Lauf hinterliesse einen halb
    // geleerten Bestand, auch wenn die Transaktion zurückrollt: die Vorschau
    // stimmte dann nicht mehr mit der Erwartung überein.
    { timeout: 180_000, maxWait: 15_000 },
    )
    .catch((error) => {
      if (error !== ROLLBACK) throw error;
    });

  log.warn(params.dryRun ? 'Datenbereinigung zur Probe' : 'Datenbereinigung ausgeführt', {
    actorId,
    areas: out.map((area) => `${area.key}:${area.total}`),
    resetSequences: params.resetSequences,
  });

  return out;
}

/** Bereichsdefinition für Anzeige-Zwecke (Beschriftung, Warnung). */
export function purgeAreaLabel(key: PurgeAreaKey): string {
  return AREA_BY_KEY.get(key)?.label ?? key;
}
