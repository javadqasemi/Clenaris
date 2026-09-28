import 'server-only';

import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { zuercherTag, zuercherTagText } from '@/lib/zuerich';
import {
  pfadBereinigen,
  referrerHost,
  umgebungAusUserAgent,
  verfolgungAbgelehnt,
} from '@/lib/traffic/bereinigen';
import { sitzungsHash } from '@/lib/traffic/sitzung';
import { aufbewahrungsgrenze, type AufgeloesterZeitraum } from '@/lib/traffic/zeitraum';
import {
  KONVERSIONEN,
  TRAFFIC_BROWSER,
  TRAFFIC_GERAETE,
  type TrafficBrowserFamilie,
  type TrafficEreignisName,
  type TrafficGeraet,
} from '@/lib/traffic/ereignisse';
import type { TrafficBatchInput } from '@/lib/validation/traffic';

const log = logger('traffic');

/**
 * Eigene Besuchsmessung der Website (2026-09-28).
 *
 * ---------------------------------------------------------------------------
 *  Warum eine eigene Messung neben Google Analytics
 * ---------------------------------------------------------------------------
 *
 * Die externen Skripte (`components/marketing/analytics.tsx`) laufen erst nach
 * Einwilligung und nur, wenn eine Kennung eingerichtet ist — und ihre Zahlen
 * liegen beim Anbieter, nicht im Betrieb. Die Frage, die der Betrieb
 * tatsächlich stellt, lautet: „Welche Seite und welche Kampagne bringt
 * Anfragen und Buchungen?" Dafür genügt eine schmale Tabelle in der eigenen
 * Datenbank, und die lässt sich neben die Umsatzauswertung stellen.
 *
 * ---------------------------------------------------------------------------
 *  Was diese Datei zusichert
 * ---------------------------------------------------------------------------
 *
 *  • **Nichts ohne Einwilligung.** Das entscheidet der Browser
 *    (`lib/traffic/erfassen.ts` sendet nur mit `analytics: true`); der Server
 *    kann eine Einwilligung nicht sehen. Er verwirft aber jede Meldung mit
 *    `Sec-GPC: 1` oder `DNT: 1` (`verfolgungAbgelehnt`).
 *  • **Keine Personendaten.** Keine IP (nur Zählschlüssel des Rate-Limits),
 *    kein User-Agent (nur Geräte- und Browserfamilie), keine über den Tag
 *    hinaus verknüpfbare Kennung (`lib/traffic/sitzung.ts`).
 *  • **Kein Token.** Pfade laufen durch `pfadBereinigen`; die Datenbank
 *    verweigert zusätzlich jeden Pfad mit `?` (Migration
 *    `20260928120000_traffic_analytics`).
 *  • **Jede Abfrage je Organisation** und jede Rangliste begrenzt.
 */

// ---------------------------------------------------------------------------
//  Erfassen
// ---------------------------------------------------------------------------

export interface TrafficKontext {
  organizationId: string;
  /** Kopfzeilen der Anfrage — gelesen werden nur `user-agent`, `sec-gpc`, `dnt`. */
  kopf: (name: string) => string | null;
  /** Hosts, die als „eigene Website" gelten (Referrer innerhalb der Website fällt weg). */
  eigeneHosts: string[];
  jetzt?: Date;
}

/**
 * Einen Stapel Ereignisse bereinigen und speichern.
 *
 * Gibt die Zahl der gespeicherten Zeilen zurück — nur für Protokoll und
 * Prüfung; der Endpunkt antwortet unabhängig davon immer gleich (204). Eine
 * Antwort, die verriete, *warum* etwas verworfen wurde, wäre eine Anleitung,
 * die Bereinigung zu umgehen.
 *
 * `createMany` in einem Zug: Ein Stapel ist höchstens zwanzig Zeilen, und es
 * gibt keine Invariante zwischen ihnen, die eine Transaktion bräuchte.
 */
export async function trafficErfassen(input: TrafficBatchInput, kontext: TrafficKontext): Promise<number> {
  if (verfolgungAbgelehnt(kontext.kopf)) return 0;

  const umgebung = umgebungAusUserAgent(kontext.kopf('user-agent'));
  if (!umgebung) return 0;

  const geheimnis = process.env.JWT_SECRET ?? '';
  if (!geheimnis) {
    // Ohne Geheimnis läuft die Anwendung ohnehin nicht an; hier nur, damit
    // eine Fehlkonfiguration keine ungehashte Sitzung erzeugen kann.
    log.warn('Besuchsmessung ohne JWT_SECRET — Ereignisse verworfen');
    return 0;
  }

  const jetzt = kontext.jetzt ?? new Date();
  const tag = zuercherTag(jetzt);
  const hash = sitzungsHash(input.sitzung, zuercherTagText(jetzt), geheimnis);

  const zeilen = input.ereignisse.flatMap((ereignis) => {
    const bereinigt = pfadBereinigen(ereignis.pfad);
    if (!bereinigt) return [];
    const einstieg = ereignis.name === 'PAGE_VIEW' && ereignis.einstieg === true;
    return [
      {
        organizationId: kontext.organizationId,
        occurredAt: jetzt,
        day: tag,
        path: bereinigt.pfad,
        eventName: ereignis.name,
        sessionHash: hash,
        landing: einstieg,
        // Herkunft nur beim Einstieg: Danach ist der Referrer die eigene
        // Website, und eine Herkunft, die man bei jeder Seite wiederholt,
        // zählte dieselbe Suchanfrage fünfmal.
        referrerHost: einstieg ? referrerHost(ereignis.referrer, kontext.eigeneHosts) : null,
        utmSource: bereinigt.utmSource,
        utmMedium: bereinigt.utmMedium,
        utmCampaign: bereinigt.utmCampaign,
        device: umgebung.geraet,
        browser: umgebung.browser,
      },
    ];
  });

  if (zeilen.length === 0) return 0;
  const { count } = await prisma.trafficEvent.createMany({ data: zeilen });
  return count;
}

// ---------------------------------------------------------------------------
//  Aufbewahrung
// ---------------------------------------------------------------------------

/**
 * Ereignisse löschen, die älter als 13 Monate sind — Teil des Nachtlaufs.
 *
 * Idempotent: Ein zweiter Lauf am selben Tag findet nichts mehr. Gelöscht
 * wird über den Tag, nicht über den Zeitpunkt, damit die Grenze dieselbe
 * Zürcher Kalenderlogik hat wie die Auswertung — ein Tag verschwindet ganz
 * oder gar nicht, nie halb.
 */
export async function purgeTrafficEvents(organizationId: string, jetzt: Date = new Date()) {
  const grenze = aufbewahrungsgrenze(jetzt);
  const { count } = await prisma.trafficEvent.deleteMany({
    where: { organizationId, day: { lt: grenze } },
  });
  return { geloescht: count, grenze: zuercherTagText(grenze) };
}

// ---------------------------------------------------------------------------
//  Auswerten
// ---------------------------------------------------------------------------

/** Wie viele Zeilen jede Rangliste höchstens zeigt. */
const RANGLISTE = 10;

export interface Rangzeile {
  schluessel: string;
  anzahl: number;
}

export interface KonversionsZeile {
  name: Exclude<TrafficEreignisName, 'PAGE_VIEW'>;
  ereignisse: number;
  sitzungen: number;
  /** Anteil der Sitzungen mit diesem Ereignis, in Prozent (0–100). */
  rate: number;
}

export interface TrafficAuswertung {
  von: string;
  bis: string;
  seitenansichten: number;
  sitzungen: number;
  seitenJeSitzung: number;
  /** Sitzungen mit mindestens einer Konversion. */
  konvertierteSitzungen: number;
  konversionsrate: number;
  vorher: { seitenansichten: number; sitzungen: number; konvertierteSitzungen: number };
  einstiegsseiten: Rangzeile[];
  topSeiten: Rangzeile[];
  herkunft: Rangzeile[];
  utmQuelle: Rangzeile[];
  utmMedium: Rangzeile[];
  utmKampagne: Rangzeile[];
  geraete: { geraet: TrafficGeraet; anzahl: number }[];
  browser: { browser: TrafficBrowserFamilie; anzahl: number }[];
  konversionen: KonversionsZeile[];
}

interface Kennzahlen {
  seitenansichten: number;
  sitzungen: number;
  konvertierteSitzungen: number;
}

/**
 * Die drei Grundzahlen eines Zeitraums in einer Abfrage.
 *
 * `COUNT(DISTINCT …)` lässt sich mit Prismas `groupBy` nicht ausdrücken;
 * deshalb `$queryRaw` mit Platzhaltern. Die Tage gehen als Text `JJJJ-MM-TT`
 * mit `::date` hinein, **nicht** als `Date`: Ein `Date` käme als
 * `timestamptz` an, und dessen Umwandlung in ein Datum rechnet in der Zone
 * der Datenbanksitzung — auf einem Server in UTC−5 wäre das der Vortag.
 *
 * Eine Sitzung zählt, wenn sie mindestens eine Seitenansicht hat; eine
 * Konversion ohne Seitenansicht (ein Klick, bevor die erste Meldung ankam)
 * zählt als konvertierte Sitzung trotzdem — deshalb die Obergrenze in der
 * Rate weiter unten.
 */
async function kennzahlen(organizationId: string, vonTag: Date, bisTag: Date): Promise<Kennzahlen> {
  const von = zuercherTagText(vonTag);
  const bis = zuercherTagText(bisTag);
  const [zeile] = await prisma.$queryRaw<
    { seitenansichten: bigint; sitzungen: bigint; konvertiert: bigint }[]
  >`
    SELECT
      COUNT(*) FILTER (WHERE "eventName" = 'PAGE_VIEW')                          AS seitenansichten,
      COUNT(DISTINCT "sessionHash") FILTER (WHERE "eventName" = 'PAGE_VIEW')     AS sitzungen,
      COUNT(DISTINCT "sessionHash") FILTER (WHERE "eventName" <> 'PAGE_VIEW')    AS konvertiert
    FROM traffic_events
    WHERE "organizationId" = ${organizationId}
      AND "day" >= ${von}::date
      AND "day" <= ${bis}::date
  `;
  return {
    seitenansichten: Number(zeile?.seitenansichten ?? 0),
    sitzungen: Number(zeile?.sitzungen ?? 0),
    konvertierteSitzungen: Number(zeile?.konvertiert ?? 0),
  };
}

function prozent(teil: number, ganzes: number): number {
  if (ganzes <= 0) return 0;
  return Math.min(100, Math.round((teil / ganzes) * 1000) / 10);
}

/**
 * Die ganze Auswertung eines Zeitraums.
 *
 * Alle Abfragen laufen nebeneinander und tragen `organizationId` sowie die
 * Tagesgrenzen im `where` — der Index `(organizationId, day)` bzw.
 * `(organizationId, eventName, day)` trägt jede davon. Ranglisten sind auf
 * zehn Zeilen begrenzt (`take`), damit eine Seite mit tausend verschiedenen
 * Kampagnenwerten nicht tausend Zeilen lädt.
 *
 * Herkunft, UTM, Gerät und Browser werden an den **Einstiegen** gezählt: Das
 * ist eine Zeile je Sitzung und Tag, und die Frage lautet „woher kamen die
 * Besuche", nicht „wie viele Seiten sahen Leute von dort".
 */
export async function trafficAuswertung(
  organizationId: string,
  zeitraum: AufgeloesterZeitraum,
): Promise<TrafficAuswertung> {
  const basis: Prisma.TrafficEventWhereInput = {
    organizationId,
    day: { gte: zeitraum.vonTag, lte: zeitraum.bisTag },
  };
  const einstiege: Prisma.TrafficEventWhereInput = { ...basis, eventName: 'PAGE_VIEW', landing: true };

  /**
   * Eine Rangliste über ein Feld. `not: null` nur bei den Feldern, die leer
   * sein können — `path` ist Pflicht, und Prisma lehnt einen Nullfilter auf
   * einer Pflichtspalte schon bei der Validierung ab. Der Typ von `groupBy`
   * mit einem Feld aus einer Variablen lässt sich nicht ableiten; die
   * Umwandlung am Ende ist deshalb bewusst eng auf die zwei gelesenen Felder.
   */
  const rangliste = async (
    feld: 'path' | 'referrerHost' | 'utmSource' | 'utmMedium' | 'utmCampaign',
    where: Prisma.TrafficEventWhereInput,
  ): Promise<Rangzeile[]> => {
    const bedingung: Prisma.TrafficEventWhereInput =
      feld === 'path' ? where : { AND: [where, { [feld]: { not: null } }] };
    const gruppen = (await prisma.trafficEvent.groupBy({
      by: [feld],
      where: bedingung,
      _count: { [feld]: true },
      orderBy: { _count: { [feld]: 'desc' } },
      take: RANGLISTE,
    })) as unknown as ({ _count: Record<string, number> } & Record<string, unknown>)[];
    return gruppen.map((g) => ({
      schluessel: String(g[feld]),
      anzahl: g._count[feld] ?? 0,
    }));
  };

  const [
    jetzt,
    vorher,
    einstiegsseiten,
    topSeiten,
    herkunft,
    utmQuelle,
    utmMedium,
    utmKampagne,
    geraeteGruppen,
    browserGruppen,
    konversionsGruppen,
  ] = await Promise.all([
    kennzahlen(organizationId, zeitraum.vonTag, zeitraum.bisTag),
    kennzahlen(organizationId, zeitraum.vorher.vonTag, zeitraum.vorher.bisTag),
    rangliste('path', einstiege),
    rangliste('path', { ...basis, eventName: 'PAGE_VIEW' }),
    rangliste('referrerHost', einstiege),
    rangliste('utmSource', einstiege),
    rangliste('utmMedium', einstiege),
    rangliste('utmCampaign', einstiege),
    prisma.trafficEvent.groupBy({ by: ['device'], where: einstiege, _count: { _all: true } }),
    prisma.trafficEvent.groupBy({ by: ['browser'], where: einstiege, _count: { _all: true } }),
    prisma.$queryRaw<{ name: string; ereignisse: bigint; sitzungen: bigint }[]>`
      SELECT "eventName"::text AS name,
             COUNT(*) AS ereignisse,
             COUNT(DISTINCT "sessionHash") AS sitzungen
      FROM traffic_events
      WHERE "organizationId" = ${organizationId}
        AND "day" >= ${zuercherTagText(zeitraum.vonTag)}::date
        AND "day" <= ${zuercherTagText(zeitraum.bisTag)}::date
        AND "eventName" <> 'PAGE_VIEW'
      GROUP BY "eventName"
    `,
  ]);

  const geraete = TRAFFIC_GERAETE.map((geraet) => ({
    geraet,
    anzahl: geraeteGruppen.find((g) => g.device === geraet)?._count._all ?? 0,
  }));
  const browser = TRAFFIC_BROWSER.map((b) => ({
    browser: b,
    anzahl: browserGruppen.find((g) => g.browser === b)?._count._all ?? 0,
  }));

  // Jede Konversionsart erscheint, auch mit null — eine fehlende Zeile liest
  // sich wie „wird nicht gemessen", eine Null wie „kam nicht vor".
  const konversionen: KonversionsZeile[] = KONVERSIONEN.map((name) => {
    const zeile = konversionsGruppen.find((g) => g.name === name);
    const sitzungen = Number(zeile?.sitzungen ?? 0);
    return {
      name,
      ereignisse: Number(zeile?.ereignisse ?? 0),
      sitzungen,
      rate: prozent(sitzungen, jetzt.sitzungen),
    };
  });

  return {
    von: zuercherTagText(zeitraum.vonTag),
    bis: zuercherTagText(zeitraum.bisTag),
    seitenansichten: jetzt.seitenansichten,
    sitzungen: jetzt.sitzungen,
    seitenJeSitzung:
      jetzt.sitzungen > 0 ? Math.round((jetzt.seitenansichten / jetzt.sitzungen) * 10) / 10 : 0,
    konvertierteSitzungen: jetzt.konvertierteSitzungen,
    konversionsrate: prozent(jetzt.konvertierteSitzungen, jetzt.sitzungen),
    vorher,
    einstiegsseiten,
    topSeiten,
    herkunft,
    utmQuelle,
    utmMedium,
    utmKampagne,
    geraete,
    browser,
    konversionen,
  };
}
