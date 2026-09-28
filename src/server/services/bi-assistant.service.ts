import 'server-only';

import { prisma, toNumber } from '@/lib/db';
import { audit } from '@/lib/audit';
import type { SessionUser } from '@/lib/auth/session';
import { ConfigurationError, NotFoundError } from '@/lib/errors';
import { hasIntegration } from '@/lib/env';
import { periodOf, zurichMidnight } from '@/lib/bi/periods';
import { tagPlus, zuercherTagesbeginn, zuercherTagText } from '@/lib/zuerich';
import type { BiAssistantInput } from '@/lib/validation/bi-ai';
import {
  draftAnalysisBoard,
  draftFeedbackAnalysis,
  draftMarketingIdeas,
  draftMeetingMinutes,
  draftPeriodSummary,
  draftQuarterlyReview,
  draftRiskSuggestions,
  draftVarianceExplanation,
} from '@/lib/ai/features-bi';
import { biDaten, biFreitext, type BiKennzahl, type BiTeil } from '@/lib/ai/nutzlast';
import { computeHealth } from './health.service';
import { getInsights } from './insight.service';
import { getBudgetVariance } from './budget.service';

/**
 * Der Führungsassistent — Datensammlung für die KI-Entwürfe.
 *
 * Dieser Dienst entscheidet, *was* das Modell sieht. Die Regel: aggregierte
 * Zahlen und Titel; Löhne und Adressen gehen nie hinaus.
 *
 * **Freitext ist nicht anonym, und hier stand bis 2026-09-27, er sei es.**
 * Bewertungstexte, Check-in-Kommentare und Sitzungsnotizen gingen roh hinaus,
 * während dieser Kopf und die Seite „anonymisiert" und „keine Personendaten"
 * versprachen — „Frau Keller war super" erreichte das Modell mit Namen. Jetzt
 * ersetzt `namenErsetzen` jeden Namen, den die Datenbank kennt (Konten,
 * Kundschaft, Verfasser der Bewertung), durch `[NAME]`, bevor der Text das
 * Haus verlässt; der Ausgangsfilter des Clients nimmt E-Mail, Telefon, IBAN
 * und AHV-Nummer. Ein Name, den niemand erfasst hat, bleibt stehen — die
 * Übermittlung ist sparsam, nicht anonym, und so steht es jetzt auch in der
 * Oberfläche.
 *
 * **Seit F-15 (zweiter Durchgang, 2026-09-27) baut dieser Dienst keine
 * Zeichenketten mehr.** Die Abfragen liefern Bausteine mit festen Feldern an
 * `biDaten` (`src/lib/ai/nutzlast.ts`), und erst dort entsteht der Text —
 * aus einer Erlaubnisliste. Anlass: Die Detailzeile der Auffälligkeit
 * „Klumpenrisiko" nannte die grösste Kundschaft beim Namen und ging mit jeder
 * Zeitraum-Zusammenfassung hinaus; als fertige Zeichenkette sah das niemand.
 * Freitext (Frage, Notizen, Kommentare, Marktbeobachtungen, Bewertungen) wird
 * dort geschwärzt wie in der Zusammenfassung — Codes, Lohnbeträge,
 * Gesundheitssätze, bekannte und vermutete Namen.
 */

/**
 * Die Namen, die diese Organisation kennt: Konten (Personal, Büro,
 * Kundschaft mit Konto) und Kundschaft samt Firmennamen. Für ein Assistenz-
 * Werkzeug, das auf Knopfdruck läuft, ist die Menge klein genug, um sie je
 * Aufruf frisch zu lesen — ein Zwischenspeicher wäre eine Liste, die einen
 * neuen Namen erst später kennt.
 */
async function bekannteNamen(organizationId: string): Promise<string[]> {
  const [konten, kundschaft] = await Promise.all([
    prisma.user.findMany({ where: { organizationId }, select: { firstName: true, lastName: true } }),
    prisma.customer.findMany({
      where: { organizationId },
      select: { firstName: true, lastName: true, companyName: true, contacts: { select: { firstName: true, lastName: true } } },
    }),
  ]);
  return [
    ...konten.flatMap((k) => [k.firstName, k.lastName]),
    // Kontaktpersonen einer Firmenkundschaft stehen in Notizen und Bewertungen
    // ebenso beim Namen wie die Kundschaft selbst (F-15).
    ...kundschaft.flatMap((k) => [k.firstName, k.lastName, k.companyName ?? '', ...k.contacts.flatMap((c) => [c.firstName, c.lastName])]),
  ];
}

function assertAi() {
  if (!hasIntegration('ai')) {
    throw new ConfigurationError('Anthropic', 'Der Führungsassistent braucht ANTHROPIC_API_KEY. Alle übrigen Funktionen laufen unabhängig davon.');
  }
}

/*
  Die Abfragen unten liefern **Bausteine** (`BiTeil`), keine Zeichenketten.
  Jedes Feld, das hinausgeht, steht einzeln im Baustein — was die Abfrage
  sonst noch liefert (Kennungen, Verfasser, Verweise), bleibt hier.
*/

async function kpiDigest(organizationId: string, from?: Date, to?: Date, groups?: string[]): Promise<BiTeil> {
  const definitions = await prisma.kpiDefinition.findMany({
    where: { organizationId, active: true, ...(groups ? { group: { in: groups } } : {}) },
    orderBy: [{ group: 'asc' }, { sortOrder: 'asc' }],
    include: {
      snapshots: {
        where: { period: 'MONTH', ...(from ? { periodStart: { gte: from } } : {}), ...(to ? { periodStart: { lte: to } } : {}) },
        orderBy: { periodStart: 'desc' },
        take: 12,
      },
    },
  });
  const liste: BiKennzahl[] = definitions.map((d) => ({
    gruppe: d.group,
    label: d.label,
    schluessel: d.key,
    einheit: d.unit,
    mehrIstBesser: d.direction === 'UP_IS_GOOD',
    ziel: d.targetValue === null ? null : toNumber(d.targetValue),
    verlauf: [...d.snapshots].reverse().map((s) => ({ periodeStart: s.periodStart, wert: toNumber(s.value), vorlaeufig: s.provisional })),
  }));
  return { art: 'kennzahlen', liste };
}

async function healthDigest(organizationId: string): Promise<BiTeil> {
  const h = await computeHealth(organizationId);
  return {
    art: 'gesundheit',
    wert: { wert: h.score, status: h.status, groessterHebel: h.topRisk, komponenten: h.components.map((c) => ({ label: c.label, wert: c.subScore })) },
  };
}

async function insightDigest(organizationId: string): Promise<BiTeil> {
  const insights = await getInsights(organizationId);
  // Ohne `href` (enthält die Kundenkennung) und — ausser für geprüfte Regeln —
  // ohne Detailzeile; die Auswahl trifft `biDaten`.
  return { art: 'hinweise', liste: insights.map((i) => ({ schluessel: i.key, schwere: i.severity, titel: i.title, detail: i.detail })) };
}

async function objectivesDigest(organizationId: string, fiscalYear?: number, quarter?: number): Promise<BiTeil> {
  const objectives = await prisma.objective.findMany({
    where: {
      organizationId,
      deletedAt: null,
      status: { not: 'CANCELLED' },
      ...(fiscalYear ? { OR: [{ fiscalYear, ...(quarter ? { quarter } : {}) }, { horizon: 'STRATEGY' }] } : {}),
    },
    include: { keyResults: { include: { checkins: { orderBy: { recordedAt: 'desc' }, take: 3 } } } },
    orderBy: { progressPct: 'asc' },
    take: 30,
  });
  return {
    art: 'ziele',
    liste: objectives.map((o) => ({
      horizont: o.horizon,
      ebene: o.level,
      titel: o.title,
      status: o.status,
      fortschritt: o.progressPct,
      bereich: o.department,
      ergebnisse: o.keyResults.map((kr) => ({
        titel: kr.title,
        start: toNumber(kr.startValue),
        stand: toNumber(kr.currentValue),
        ziel: toNumber(kr.targetValue),
        fortschritt: kr.progressPct,
        // Freitext von Mitarbeitenden — `biDaten` schwärzt ihn.
        kommentar: kr.checkins[0]?.comment ?? null,
      })),
    })),
  };
}

async function riskDigest(organizationId: string): Promise<BiTeil> {
  const risks = await prisma.riskEntry.findMany({
    where: { organizationId, deletedAt: null, status: { not: 'CLOSED' } },
    orderBy: { severity: 'desc' },
    select: { title: true, category: true, probability: true, impact: true, severity: true, status: true },
    take: 40,
  });
  return {
    art: 'risiken',
    liste: risks.map((r) => ({ titel: r.title, kategorie: r.category, wahrscheinlichkeit: r.probability, auswirkung: r.impact, schwere: r.severity, status: r.status })),
  };
}

async function marketDigest(organizationId: string): Promise<BiTeil> {
  const [competitors, insights] = await Promise.all([
    prisma.competitor.findMany({ where: { organizationId, deletedAt: null }, take: 20 }),
    prisma.marketInsight.findMany({ where: { organizationId, deletedAt: null }, orderBy: { observedOn: 'desc' }, take: 20 }),
  ]);
  return {
    art: 'markt',
    wettbewerber: competitors.map((x) => ({
      name: x.name,
      region: x.region,
      leistungen: x.services,
      preisVon: x.priceFrom ? toNumber(x.priceFrom) : null,
      preisBis: x.priceTo ? toNumber(x.priceTo) : null,
      staerken: x.strengths,
      schwaechen: x.weaknesses,
      position: x.marketPosition,
    })),
    beobachtungen: insights.map((x) => ({ art: x.kind, beobachtetAm: x.observedOn, titel: x.title, text: x.body, auswirkung: x.impactNote })),
  };
}

/** Bausteine zu Text — nur über die Erlaubnisliste in `biDaten`. */
const ueberschrift = (text: Extract<BiTeil, { art: 'ueberschrift' }>['text']): BiTeil => ({ art: 'ueberschrift', text });

export async function runAssistant(session: SessionUser, organizationId: string, input: BiAssistantInput) {
  assertAi();
  let result: unknown;
  // Für jede Fähigkeit, nicht nur für die mit Freitext: Auch Titel aus dem
  // Katalog (Zielname, Bereich) und Marktnotizen können einen Namen tragen.
  const namen = await bekannteNamen(organizationId);
  const daten = (teile: BiTeil[]) => biDaten(teile, { namen }).text;

  switch (input.kind) {
    case 'summarizePeriod': {
      const data = daten([
        { art: 'zeitraum', von: input.from, bis: input.to },
        await healthDigest(organizationId),
        ueberschrift('Kennzahlen:'),
        await kpiDigest(organizationId, input.from, input.to),
        ueberschrift('Auffälligkeiten (regelbasiert):'),
        await insightDigest(organizationId),
      ]);
      // Die Frage ist Freitext der Geschäftsleitung — derselbe Weg.
      const question = input.question ? biFreitext(input.question, namen, 1000).text : undefined;
      result = await draftPeriodSummary({ data, question });
      break;
    }
    case 'draftSwot': {
      const data = daten([await healthDigest(organizationId), ueberschrift('Kennzahlen:'), await kpiDigest(organizationId), await marketDigest(organizationId), ueberschrift('Offene Risiken:'), await riskDigest(organizationId)]);
      result = await draftAnalysisBoard({ kind: 'SWOT', data });
      break;
    }
    case 'draftPestel': {
      result = await draftAnalysisBoard({ kind: 'PESTEL', data: daten([await marketDigest(organizationId)]) });
      break;
    }
    case 'suggestRisks': {
      const openActions = await prisma.correctiveAction.count({ where: { organizationId, completedAt: null } });
      const data = daten([
        await healthDigest(organizationId),
        ueberschrift('Kennzahlen:'),
        await kpiDigest(organizationId),
        ueberschrift('Bereits erfasste Risiken (nicht wiederholen):'),
        await riskDigest(organizationId),
        { art: 'offeneMassnahmen', anzahl: openActions },
        await marketDigest(organizationId),
      ]);
      result = await draftRiskSuggestions({ data });
      break;
    }
    case 'explainVariance': {
      const variance = await getBudgetVariance(organizationId, input.budgetId);
      const data = daten([
        {
          art: 'budget',
          wert: {
            name: variance.period.name,
            geschaeftsjahr: variance.period.fiscalYear,
            verstricheneMonate: variance.elapsedMonths,
            monateTotal: variance.totalMonths,
            zeilen: variance.lines.map((l) => ({
              label: l.label,
              kategorie: l.category,
              plan: l.plan,
              planBisher: l.planToDate,
              ist: l.actual,
              abweichung: l.variance,
              abweichungProzent: l.variancePct,
              hochrechnung: l.forecast,
            })),
            total: { planBisher: variance.totals.planToDate, ist: variance.totals.actual, abweichung: variance.totals.variance },
            ohneBudget: variance.unbudgeted.map((u) => ({ kategorie: u.category, ist: u.actual })),
          },
        },
        ueberschrift('Kennzahlen Finanzen:'),
        await kpiDigest(organizationId, undefined, undefined, ['Finanzen']),
      ]);
      result = await draftVarianceExplanation({ data });
      break;
    }
    case 'meetingMinutes': {
      // Sitzungsnotizen nennen Personen beim Namen („Anna übernimmt …"). Das
      // Protokoll braucht die Rollen der Pendenzen, nicht die Namen — und
      // keinen Satz über die Krankschreibung, die in der Sitzung zur Sprache kam.
      result = await draftMeetingMinutes({
        notes: biFreitext(input.notes, namen).text,
        title: input.title === undefined ? undefined : biFreitext(input.title, namen, 200).text,
      });
      break;
    }
    case 'quarterlyReview': {
      const q = periodOf('QUARTER', zurichMidnight(input.fiscalYear, (input.quarter - 1) * 3, 1));
      const data = daten([
        { art: 'quartal', label: q.label },
        await healthDigest(organizationId),
        ueberschrift('Ziele und Schlüsselergebnisse:'),
        await objectivesDigest(organizationId, input.fiscalYear, input.quarter),
        ueberschrift('Kennzahlen im Quartal:'),
        await kpiDigest(organizationId, q.periodStart, q.periodEnd),
        ueberschrift('Offene Risiken:'),
        await riskDigest(organizationId),
      ]);
      result = await draftQuarterlyReview({ data });
      break;
    }
    case 'analyzeFeedback': {
      const reviews = await prisma.review.findMany({
        // `from`/`to` sind Kalendertage, `createdAt` ein Zeitpunkt (2026-09-27):
        // Mit `lte: to` (UTC-Mitternacht) fehlte der ganze letzte Tag.
        where: { organizationId, createdAt: { gte: zuercherTagesbeginn(input.from), lt: zuercherTagesbeginn(tagPlus(input.to, 1)) } },
        select: { rating: true, title: true, body: true, serviceKind: true, createdAt: true, authorName: true },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      if (reviews.length === 0) throw new NotFoundError('Bewertungen im Zeitraum');
      // Der Verfasser geht nicht als Feld hinaus; `biDaten` ersetzt ihn im
      // Text zusammen mit allen bekannten Namen und schwärzt den Rest.
      const data = daten([
        {
          art: 'bewertungen',
          liste: reviews.map((r) => ({
            datum: zuercherTagText(r.createdAt),
            sterne: r.rating,
            leistung: r.serviceKind,
            titel: r.title,
            text: r.body,
            verfasser: r.authorName,
          })),
        },
      ]);
      result = await draftFeedbackAnalysis({ data });
      break;
    }
    case 'marketingIdeas': {
      const leads = await prisma.lead.groupBy({ by: ['source', 'status'], where: { organizationId, deletedAt: null }, _count: { _all: true } });
      const data = daten([
        ueberschrift('Leads nach Quelle und Status:'),
        { art: 'leads', liste: leads.map((l) => ({ quelle: l.source, status: l.status, anzahl: l._count._all })) },
        ueberschrift('Kennzahlen Vertrieb und Marketing:'),
        await kpiDigest(organizationId, undefined, undefined, ['Vertrieb', 'Marketing', 'Kundschaft']),
        await marketDigest(organizationId),
      ]);
      result = await draftMarketingIdeas({ data });
      break;
    }
  }

  const bounds = periodOf('MONTH', new Date());
  await audit.created({ organizationId, userId: session.id, entity: 'AssistantDraft', summary: `Führungsassistent: ${input.kind} (${bounds.label})` });
  return { kind: input.kind, generatedAt: new Date().toISOString(), ...(result as object) };
}
