/**
 * Schweizer Sozialversicherungsbeiträge — reine Rechnung ohne Datenbank.
 *
 * ---------------------------------------------------------------------------
 *  Warum die Sätze nicht im Code stehen
 * ---------------------------------------------------------------------------
 *
 * Die Versuchung ist, `AHV = 5.3` als Konstante zu schreiben. Das wäre für
 * genau ein Jahr richtig und danach falsch — und zwar **still**: Eine
 * Lohnabrechnung mit dem Satz des Vorjahres sieht aus wie eine
 * Lohnabrechnung.
 *
 * Drei Dinge ändern sich unabhängig voneinander:
 *
 *  • **Jährlich** — AHV/IV/EO und die ALV-Grenze werden vom Bund festgelegt.
 *  • **Je Betrieb** — der UVG-Satz hängt von der Branche und der
 *    Schadenerfahrung ab und steht im Vertrag mit der Versicherung.
 *  • **Je Vorsorgeeinrichtung** — der BVG-Plan kann über dem Gesetzesminimum
 *    liegen, und viele tun das.
 *
 * Deshalb kommen alle Sätze von aussen (`PayrollSetting` je Organisation und
 * Jahr). Dieses Modul rechnet nur — und ist damit mit festen Zahlen prüfbar,
 * so wie `lib/bi/math.ts`. Keine Pfad-Aliasse, kein `server-only`: Die
 * Prüfungen laufen mit `tsx` ausserhalb des Next-Bundles.
 *
 * ---------------------------------------------------------------------------
 *  Was dieses Modul NICHT ist
 * ---------------------------------------------------------------------------
 *
 * **Keine Lohnbuchhaltung.** Quellensteuer, Kinderzulagen, 13. Monatslohn,
 * Ferienentschädigung, Naturalleistungen, Spesen und der Lohnausweis fehlen —
 * und sie fehlen absichtlich. Jedes davon ist eine eigene Regel mit eigenen
 * Ausnahmen, und eine halbe Umsetzung wäre gefährlicher als keine: Sie sieht
 * aus wie eine vollständige Abrechnung.
 *
 * Was hier entsteht, ist die **monatliche Beitragsrechnung** — genug für eine
 * nachvollziehbare Lohnabrechnung im Reinigungsgewerbe und die Grundlage für
 * die Abrechnung mit der Ausgleichskasse. Was darüber hinausgeht, gehört zur
 * Treuhand, und das steht auch so in `docs/PAYROLL.md`.
 */

/** Auf Rappen runden — kaufmännisch. */
export function rappen(betrag: number): number {
  return Math.round(betrag * 100) / 100;
}

/**
 * Die Sätze eines Jahres.
 *
 * Alle Prozentwerte als Zahl **in Prozent** (5.3 heisst 5,3 %), nicht als
 * Bruchteil. Das ist die Schreibweise, in der sie im Kreisschreiben, im
 * Versicherungsvertrag und im Kopf der Person stehen, die sie einträgt — und
 * die Umrechnung an einer Stelle ist besser als ein Feld, bei dem man raten
 * muss, ob 0.053 oder 5.3 gemeint ist.
 */
export interface BeitragsSaetze {
  /** AHV, IV und EO zusammen — der Arbeitnehmeranteil. 2026: 5,3 %. */
  ahvIvEo: number;
  /** ALV auf den Lohn bis zur Grenze. 2026: 1,1 %. */
  alv: number;
  /** Jahresgrenze für die ALV. 2026: 148 200 CHF. */
  alvGrenzeJahr: number;
  /**
   * ALV-Satz **über** der Grenze (Solidaritätsbeitrag).
   *
   * Seit 2023 aufgehoben und deshalb mit 0 vorbelegt. Das Feld bleibt, weil
   * ein aufgehobener Beitrag wieder eingeführt werden kann — und weil eine
   * Abrechnung für ein älteres Jahr ihn braucht.
   */
  alvUeberGrenze: number;
  /** Nichtberufsunfall — trägt die angestellte Person. */
  uvgNbu: number;
  /** Krankentaggeld, sofern der Betrieb eine Versicherung hat. */
  ktg: number;
  /** Eintrittsschwelle BVG, Jahreslohn. 2026: 22 680 CHF. */
  bvgEintrittsschwelle: number;
  /** Koordinationsabzug, Jahreslohn. 2026: 26 460 CHF. */
  bvgKoordinationsabzug: number;
  /** Untergrenze des koordinierten Lohns. 2026: 3 780 CHF. */
  bvgMindestKoordiniert: number;
  /** Obergrenze des versicherten Jahreslohns. 2026: 90 720 CHF. */
  bvgObergrenze: number;
  /**
   * Altersgutschriften in Prozent des koordinierten Lohns, nach Altersband.
   *
   * Der **gesamte** Satz, nicht der Arbeitnehmeranteil. Wie er sich aufteilt,
   * steht in `bvgAnteilArbeitnehmer` — gesetzlich trägt der Betrieb
   * mindestens die Hälfte.
   */
  bvgSaetze: { abAlter: number; satz: number }[];
  /** Anteil der angestellten Person an der Altersgutschrift, in Prozent. */
  bvgAnteilArbeitnehmer: number;
}

/**
 * Die Arbeitgebersätze — seit Wave 9 (2026-09-23) aus den versionierten
 * Satzversionen (`PayrollRate.employerPct`). Nicht Teil der Auszahlung, aber
 * der Lohnkosten und der Abrechnung mit den Kassen.
 *
 * Wie bei den Arbeitnehmersätzen: Prozent **in Prozent**, und kein Wert steht
 * hier im Code. Der Dienst reicht, was in der Datenbank steht.
 */
export interface ArbeitgeberSaetze {
  ahvIvEo: number;
  alv: number;
  alvUeberGrenze: number;
  /** Nichtberufsunfall — falls der Betrieb einen Teil trägt. */
  uvgNbu: number;
  /** Berufsunfall. */
  uvgBu: number;
  ktg: number;
  /** Familienausgleichskasse, in Prozent des AHV-Lohns. */
  fak: number;
  /** Verwaltungskosten der Ausgleichskasse, in Prozent der AHV/IV/EO-Beiträge (beider Seiten). */
  vk: number;
}

export interface ArbeitgeberBeitraege {
  ahvIvEo: number;
  alv: number;
  uvg: number;
  ktg: number;
  fak: number;
  vk: number;
  bvg: number;
  summe: number;
}

/**
 * Die Arbeitgeberbeiträge eines Monats — dieselben Grundlagen wie die
 * Arbeitnehmerseite, je Beitragsart gerundet.
 *
 * **VK ist ein Prozentsatz der Beiträge, nicht des Lohns.** Die
 * Verwaltungskosten der Ausgleichskasse bemessen sich an den AHV/IV/EO-
 * Beiträgen beider Seiten — der häufigste Fehler beim Nachbauen ist, sie auf
 * den Lohn zu rechnen.
 *
 * **BVG:** der Rest der Altersgutschrift nach dem Arbeitnehmeranteil. Der
 * koordinierte Lohn und der Satz kommen aus derselben Rechnung wie auf der
 * Arbeitnehmerseite (`beitraege.herleitung`), damit beide Seiten nie
 * auseinanderlaufen.
 */
export function berechneArbeitgeberbeitraege(
  grundlage: BeitragsGrundlage,
  saetze: BeitragsSaetze,
  arbeitgeber: ArbeitgeberSaetze,
  arbeitnehmer: Beitraege,
): ArbeitgeberBeitraege {
  const brutto = Math.max(0, grundlage.bruttoMonat);
  const ahvIvEo = rappen(brutto * (arbeitgeber.ahvIvEo / 100));
  const alv = rappen(
    arbeitnehmer.herleitung.alvPflichtigerMonatslohn * (arbeitgeber.alv / 100) +
      arbeitnehmer.herleitung.alvUeberGrenzeMonatslohn * (arbeitgeber.alvUeberGrenze / 100),
  );
  const uvg = rappen(brutto * ((arbeitgeber.uvgNbu + arbeitgeber.uvgBu) / 100));
  const ktg = rappen(brutto * (arbeitgeber.ktg / 100));
  const fak = rappen(brutto * (arbeitgeber.fak / 100));
  const vk = rappen((arbeitnehmer.ahvIv + ahvIvEo) * (arbeitgeber.vk / 100));
  const bvgJahrGesamt =
    arbeitnehmer.herleitung.bvgKoordinierterJahreslohn * (arbeitnehmer.herleitung.bvgSatzGesamt / 100);
  const bvg = arbeitnehmer.herleitung.bvgVersichert
    ? rappen((bvgJahrGesamt / 12) * ((100 - saetze.bvgAnteilArbeitnehmer) / 100))
    : 0;
  return { ahvIvEo, alv, uvg, ktg, fak, vk, bvg, summe: rappen(ahvIvEo + alv + uvg + ktg + fak + vk + bvg) };
}

/**
 * Die gesetzlichen Werte für 2026.
 *
 * **Eine Vorbelegung, keine Wahrheit.** Sie stehen hier, damit ein Betrieb
 * nicht bei null anfängt — nicht, damit sie ungeprüft übernommen werden. Die
 * betriebsabhängigen Sätze (`uvgNbu`, `ktg`, `bvgAnteilArbeitnehmer`) sind
 * ausdrücklich nur Annahmen: Der UVG-Satz steht im Vertrag mit der
 * Versicherung und unterscheidet sich je Branche und Schadenerfahrung.
 */
export const SAETZE_2026: BeitragsSaetze = {
  ahvIvEo: 5.3,
  alv: 1.1,
  alvGrenzeJahr: 148_200,
  alvUeberGrenze: 0,
  // Annahme für das Reinigungsgewerbe — gehört geprüft und ersetzt.
  uvgNbu: 1.6,
  ktg: 0,
  bvgEintrittsschwelle: 22_680,
  bvgKoordinationsabzug: 26_460,
  bvgMindestKoordiniert: 3_780,
  bvgObergrenze: 90_720,
  bvgSaetze: [
    { abAlter: 25, satz: 7 },
    { abAlter: 35, satz: 10 },
    { abAlter: 45, satz: 15 },
    { abAlter: 55, satz: 18 },
  ],
  bvgAnteilArbeitnehmer: 50,
};

export interface BeitragsGrundlage {
  /** Bruttolohn des Monats. */
  bruttoMonat: number;
  /**
   * Der auf das Jahr hochgerechnete Lohn — Grundlage für ALV-Grenze und BVG.
   *
   * **Warum nicht einfach `bruttoMonat × 12`.** Bei einer Person mit stark
   * schwankenden Stunden wäre das im Spitzenmonat zu hoch und im schwachen zu
   * tief, und die BVG-Berechnung spränge von Monat zu Monat. Der Aufrufer
   * bestimmt den Wert deshalb selbst: bei Monatslohn aus dem Vertrag, bei
   * Stundenlohn aus der vereinbarten Pensumsannahme.
   */
  bruttoJahr: number;
  /** Alter am 31. Dezember des Abrechnungsjahres. `null` = unbekannt. */
  alter: number | null;
}

export interface Beitraege {
  ahvIv: number;
  alv: number;
  bvg: number;
  uvg: number;
  ktg: number;
  /** Summe aller Abzüge. */
  summe: number;
  /**
   * Die Herleitung — nicht für die Rechnung, sondern für die Nachvollziehbarkeit.
   *
   * Eine Lohnabrechnung, bei der sich der BVG-Abzug nicht nachrechnen lässt,
   * erzeugt genau eine Rückfrage je Monat und je Person. Der koordinierte Lohn
   * und der angewandte Satz beantworten sie im Voraus.
   */
  herleitung: {
    alvPflichtigerMonatslohn: number;
    alvUeberGrenzeMonatslohn: number;
    bvgKoordinierterJahreslohn: number;
    bvgSatzGesamt: number;
    bvgVersichert: boolean;
    bvgGrund?: string;
  };
}

/**
 * Der koordinierte Jahreslohn nach BVG.
 *
 * Die Reihenfolge ist gesetzlich und nicht beliebig:
 *
 *  1. Unter der **Eintrittsschwelle** besteht keine Versicherungspflicht.
 *  2. Der Lohn wird bei der **Obergrenze** gekappt.
 *  3. Davon wird der **Koordinationsabzug** abgezogen (der Teil, den bereits
 *     die AHV deckt).
 *  4. Was übrig bleibt, wird auf den **Mindestbetrag** angehoben — sonst
 *     fiele jemand knapp über der Schwelle auf fast null.
 *
 * Schritt 4 wird beim Nachbauen am häufigsten vergessen, und der Fehler
 * trifft genau die Teilzeitstellen, die in diesem Gewerbe die Mehrheit sind.
 */
export function koordinierterLohn(
  bruttoJahr: number,
  saetze: BeitragsSaetze,
): { betrag: number; versichert: boolean; grund?: string } {
  if (bruttoJahr < saetze.bvgEintrittsschwelle) {
    return {
      betrag: 0,
      versichert: false,
      grund: `Jahreslohn unter der Eintrittsschwelle (${saetze.bvgEintrittsschwelle} CHF).`,
    };
  }

  const gekappt = Math.min(bruttoJahr, saetze.bvgObergrenze);
  const nachAbzug = gekappt - saetze.bvgKoordinationsabzug;

  if (nachAbzug <= 0) {
    return { betrag: saetze.bvgMindestKoordiniert, versichert: true };
  }

  return { betrag: Math.max(nachAbzug, saetze.bvgMindestKoordiniert), versichert: true };
}

/**
 * Der Altersgutschriftssatz für ein Alter.
 *
 * Unter dem ersten Band (in der Regel 25 Jahre) wird **kein** Altersguthaben
 * geäufnet — die Risikoversicherung beginnt früher, die Sparbeiträge nicht.
 * Ohne Altersangabe wird ebenfalls nichts abgezogen: Ein geratener Satz wäre
 * ein falscher Lohn, und ein fehlendes Geburtsdatum ist eine Lücke in der
 * Personalakte, die dort behoben gehört.
 */
export function bvgSatzFuerAlter(alter: number | null, saetze: BeitragsSaetze): number {
  if (alter === null) return 0;

  let gefunden = 0;
  for (const band of saetze.bvgSaetze) {
    if (alter >= band.abAlter) gefunden = band.satz;
  }
  return gefunden;
}

/**
 * Die Beiträge eines Monats.
 *
 * Gerundet wird **je Beitragsart** und nicht erst am Ende. Das ist die Praxis
 * der Lohnbuchhaltung und hat einen handfesten Grund: Der einzelne Abzug
 * erscheint auf der Abrechnung, und eine Summe, die sich aus den angezeigten
 * Zeilen nicht nachrechnen lässt, erzeugt eine Rückfrage je Monat.
 */
export function berechneBeitraege(
  grundlage: BeitragsGrundlage,
  saetze: BeitragsSaetze,
): Beitraege {
  const brutto = Math.max(0, grundlage.bruttoMonat);

  const ahvIv = rappen(brutto * (saetze.ahvIvEo / 100));

  /**
   * Die ALV-Grenze ist eine **Jahres**grenze. Auf den Monat heruntergebrochen
   * wird sie durch zwölf geteilt — das ist die übliche Handhabung und die
   * einzige, die ohne eine laufende Jahressumme auskommt.
   *
   * Der Unterschied zur Abrechnung über die Jahressumme zeigt sich nur bei
   * sehr hohen, stark schwankenden Löhnen; im Reinigungsgewerbe tritt der
   * Fall nicht auf. Dass er bestünde, gehört trotzdem gesagt.
   */
  const grenzeMonat = saetze.alvGrenzeJahr / 12;
  const alvPflichtig = Math.min(brutto, grenzeMonat);
  const alvDarueber = Math.max(0, brutto - grenzeMonat);
  const alv = rappen(
    alvPflichtig * (saetze.alv / 100) + alvDarueber * (saetze.alvUeberGrenze / 100),
  );

  const uvg = rappen(brutto * (saetze.uvgNbu / 100));
  const ktg = rappen(brutto * (saetze.ktg / 100));

  const koordiniert = koordinierterLohn(grundlage.bruttoJahr, saetze);
  const bvgSatz = koordiniert.versichert ? bvgSatzFuerAlter(grundlage.alter, saetze) : 0;

  /**
   * Der Monatsbeitrag ist ein Zwölftel des Jahresbeitrags, und der
   * Arbeitnehmeranteil davon.
   */
  const bvgJahrGesamt = koordiniert.betrag * (bvgSatz / 100);
  const bvg = rappen(
    (bvgJahrGesamt / 12) * (saetze.bvgAnteilArbeitnehmer / 100),
  );

  const summe = rappen(ahvIv + alv + bvg + uvg + ktg);

  return {
    ahvIv,
    alv,
    bvg,
    uvg,
    ktg,
    summe,
    herleitung: {
      alvPflichtigerMonatslohn: rappen(alvPflichtig),
      alvUeberGrenzeMonatslohn: rappen(alvDarueber),
      bvgKoordinierterJahreslohn: rappen(koordiniert.betrag),
      bvgSatzGesamt: bvgSatz,
      bvgVersichert: koordiniert.versichert,
      ...(koordiniert.grund ? { bvgGrund: koordiniert.grund } : {}),
      ...(koordiniert.versichert && bvgSatz === 0
        ? {
            bvgGrund:
              grundlage.alter === null
                ? 'Kein Geburtsdatum hinterlegt — ohne Alter wird keine Altersgutschrift gerechnet.'
                : `Alter ${grundlage.alter}: noch kein Sparbeitrag.`,
          }
        : {}),
    },
  };
}

/**
 * Das Alter am 31. Dezember des Abrechnungsjahres.
 *
 * **Warum nicht am Abrechnungsstichtag.** Die Altersbänder des BVG wechseln
 * auf den 1. Januar nach dem Geburtstag; die Bezugsgrösse ist damit das Alter,
 * das jemand im Laufe des Jahres erreicht. Am Stichtag zu rechnen liesse den
 * Satz mitten im Jahr springen.
 */
export function alterImJahr(geburtstag: Date | null, jahr: number): number | null {
  if (!geburtstag) return null;
  return jahr - geburtstag.getUTCFullYear();
}
