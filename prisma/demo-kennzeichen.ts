/**
 * Die unverwechselbaren Zeichenketten des Demobestands — eine Quelle für zwei
 * Verbraucher (2026-09-30).
 *
 *  1. **`prisma/seed-demo.ts`** legt mit genau diesen Werten Kundschaft,
 *     Anfragen, Bewertungen, Galerie und Blog an.
 *  2. **`scripts/release-artefakt.ts`** sucht dieselben Werte im Bau, bevor es
 *     packt, und verweigert das Artefakt bei einem Treffer
 *     (`scripts/release/artefakt-regeln.ts`, `demodatenSuchen`).
 *
 * ---------------------------------------------------------------------------
 *  Warum eine eigene Datei
 * ---------------------------------------------------------------------------
 *
 * Die Website ist statisch vorgerendert (`revalidate`, `generateStaticParams`):
 * Bewertungen, Blogbeiträge und die Sitemap stehen nach `next build` als HTML,
 * RSC und `.body` in `.next/server` — mit dem Inhalt der Datenbank, gegen die
 * gebaut wurde. Die Pipeline spielt vor dem Bau `db:seed:demo` ein, weil die
 * Prüfreihen den Demobestand brauchen. Ein so gebautes Artefakt trüge
 * erfundene Kundenstimmen („Nicole W.") und Beispielartikel auf die echte
 * Website, bis die erste Neuvalidierung sie ersetzt — und erfundene
 * Bewertungen auf einer öffentlichen Seite sind wettbewerbsrechtlich heikel
 * (siehe Kopf von `seed-demo.ts`).
 *
 * Die naheliegende Alternative war eine Liste der Kennzeichen *im* Packskript.
 * Sie wäre beim ersten umbenannten Demobeitrag veraltet, ohne dass es jemand
 * merkt: Der Seed schriebe den neuen Titel, das Packskript suchte den alten,
 * und die Stolperfalle schwiege genau dann, wenn sie anschlagen soll. Steht
 * der Wert nur hier und liest der Seed ihn von hier, gibt es keine zweite
 * Fassung, die veralten kann.
 *
 * ---------------------------------------------------------------------------
 *  Was hier hineingehört und was nicht
 * ---------------------------------------------------------------------------
 *
 * **Nur Unverwechselbares.** Ein Kennzeichen, das auch in echter Konfiguration
 * vorkommt, meldete jeden sauberen Bau als verseucht — und eine Falle, die
 * immer anschlägt, wird abgeschaltet. Deshalb stehen hier weder Leistungen
 * noch Firmenname, weder Teammitglieder (Anna Keller, Marco Zbinden …) noch
 * die allgemeine Domain `example.ch` (der Konfigurations-Seed legt einen
 * Lieferanten unter `hygienecenter.example.ch` an). Die Maildomain der
 * Demokundschaft steht darum mit `@` davor — das trifft `nicole.wyss@example.ch`,
 * aber nicht `bestellung@hygienecenter.example.ch`. Die Prüfung
 * „die Demokennzeichen treffen keine Konfigurationsdaten" in
 * `tests/api/release-artefakt.test.ts` hält das fest.
 *
 * **Keine Nebenwirkung.** Diese Datei öffnet keine Verbindung, liest keine
 * Umgebung und ruft keinen Schutzschalter: Das Packskript importiert sie auf
 * einem CI-Rechner ohne Datenbank, und `seed-demo.ts` bleibt die einzige Stelle
 * mit `assertDemoSeedErlaubt()`.
 *
 * **Die Werte selbst sind unverändert** gegenüber dem Stand vor der
 * Auslagerung — der Demobestand in bestehenden Datenbanken passt weiter, und
 * die Prüfreihen, die „Nicole Wyss" oder den Blogbeitrag zur Wohnungsübergabe
 * erwarten, merken nichts.
 */

/** Die fünf Demokundschaften mit Konto bzw. Datensatz aus `seed-demo.ts`. */
export const DEMO_KUNDSCHAFT = {
  wyss: { vorname: 'Nicole', nachname: 'Wyss', email: 'nicole.wyss@example.ch' },
  roth: { vorname: 'Peter', nachname: 'Roth', email: 'p.roth@aareblick.example.ch', firma: 'Aareblick Immobilien AG' },
  schneider: { vorname: 'Martin', nachname: 'Schneider', email: 'martin.schneider@example.ch' },
  lehmann: { vorname: 'Katrin', nachname: 'Lehmann', email: 'praxis@lehmann.example.ch', firma: 'Praxis Dr. med. Lehmann' },
  bernasconi: { vorname: 'Sofia', nachname: 'Bernasconi', email: 'sofia.b@example.ch' },
} as const;

/** Die fünf Demo-Anfragen (Trichter: neu, kontaktiert, Offerte, gewonnen, verloren). */
export const DEMO_ANFRAGEN = {
  aebischer: { vorname: 'Beat', nachname: 'Aebischer', email: 'beat.aebischer@example.ch', firma: null },
  zuercher: { vorname: 'Carmen', nachname: 'Zürcher', email: 'c.zuercher@example.ch', firma: 'Zürcher Physiotherapie' },
  hofmann: { vorname: 'Ruedi', nachname: 'Hofmann', email: 'ruedi.hofmann@example.ch', firma: 'Hofmann Bau GmbH' },
  marti: { vorname: 'Silvia', nachname: 'Marti', email: 'silvia.marti@example.ch', firma: null },
  frei: { vorname: 'Jonas', nachname: 'Frei', email: 'jonas.frei@example.ch', firma: 'Frei Treuhand' },
} as const;

/**
 * Die erfundenen Bewertungen: Autorin bzw. Autor und Titel. Genau diese
 * beiden Felder stehen auf `/bewertungen`, auf der Startseite und im
 * JSON-LD (`bewertungsKnoten`) — der Text darunter auch, aber Name und Titel
 * reichen, um die Seite zu erkennen.
 */
export const DEMO_BEWERTUNGEN = {
  wyss: { autor: 'Nicole W.', titel: 'Endlich Zeit für anderes' },
  roth: { autor: 'Peter R., Aareblick Immobilien AG', titel: 'Verlässlicher Partner' },
  schneider: { autor: 'Martin S.', titel: 'Wohnungsabgabe ohne Diskussion' },
  lehmann: { autor: 'Katrin L.', titel: 'Perfekt für unsere Praxis' },
  bernasconi: { autor: 'Sofia B.', titel: 'Sehr saubere Fenster' },
  baureinigung: { autor: 'Thomas H.', titel: 'Baureinigung top' },
} as const;

/**
 * Die Titel der Galerieeinträge. Sie bleiben unveröffentlicht (Bilder, die es
 * nie gab — siehe `seed-demo.ts`), stehen aber hier, damit ein versehentlich
 * freigegebener Eintrag im Bau genauso auffällt wie eine Bewertung.
 */
export const DEMO_GALERIE = {
  umzugKueche: 'Umzugsreinigung Länggasse',
  bad: 'Badezimmer entkalkt',
  neubau: 'Baureinigung Neubau',
  fensterfront: 'Fensterfront Bürogebäude',
} as const;

/**
 * Die Beispielartikel des Blogs. Der Slug steht in Pfad, Sitemap und
 * `prerender-manifest.json`, der Titel in `<title>`, Überschrift und JSON-LD.
 */
export const DEMO_BLOGBEITRAEGE = {
  uebergabe: {
    slug: 'wohnungsuebergabe-checkliste',
    titel: 'Wohnungsübergabe in der Schweiz: Die vollständige Checkliste',
  },
  buero: { slug: 'wie-oft-buero-reinigen', titel: 'Wie oft sollte ein Büro gereinigt werden?' },
  kalk: { slug: 'kalk-entfernen-hausmittel', titel: 'Kalk entfernen: Was wirklich funktioniert — und was nicht' },
} as const;

/**
 * Die Maildomain der Demokundschaft und der Demo-Anfragen, mit `@` davor —
 * ohne `@` träfe sie auch den Lieferanten des Konfigurations-Seeds
 * (`bestellung@hygienecenter.example.ch`).
 */
export const DEMO_MAILDOMAIN = '@example.ch';

export interface Demokennzeichen {
  /** Wofür das Kennzeichen steht — wird im Befund genannt, der Wert selbst nicht. */
  readonly art: string;
  readonly text: string;
}

/**
 * Alle Kennzeichen als flache Liste, abgeleitet aus den Werten oben — nie von
 * Hand gepflegt, damit ein neuer Demowert nicht vergessen werden kann, sobald
 * der Seed ihn von hier liest.
 *
 * Personennamen stehen als „Vorname Nachname": So rendert sie jede Liste der
 * Anwendung, und die Suche entfernt vorher Reacts Textknoten-Trenner
 * (`<!-- -->`), die zwischen zwei Ausdrücken stehen.
 */
export const DEMO_KENNZEICHEN: readonly Demokennzeichen[] = Object.freeze([
  ...Object.values(DEMO_KUNDSCHAFT).flatMap((p) => [
    { art: 'Demokundschaft', text: `${p.vorname} ${p.nachname}` },
    { art: 'Demokundschaft', text: p.email },
    ...('firma' in p ? [{ art: 'Demokundschaft', text: p.firma }] : []),
  ]),
  ...Object.values(DEMO_ANFRAGEN).flatMap((a) => [
    { art: 'Demo-Anfrage', text: `${a.vorname} ${a.nachname}` },
    { art: 'Demo-Anfrage', text: a.email },
    ...(a.firma ? [{ art: 'Demo-Anfrage', text: a.firma }] : []),
  ]),
  ...Object.values(DEMO_BEWERTUNGEN).flatMap((b) => [
    { art: 'Demo-Bewertung', text: b.autor },
    { art: 'Demo-Bewertung', text: b.titel },
  ]),
  ...Object.values(DEMO_GALERIE).map((titel) => ({ art: 'Demo-Galerie', text: titel })),
  ...Object.values(DEMO_BLOGBEITRAEGE).flatMap((b) => [
    { art: 'Demo-Blogbeitrag', text: b.slug },
    { art: 'Demo-Blogbeitrag', text: b.titel },
  ]),
  { art: 'Demo-Maildomain', text: DEMO_MAILDOMAIN },
]);
