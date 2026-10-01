# Technische SEO der öffentlichen Website — Prüfung 2026-09-28

Umfang: alle Seiten unter `src/app/(public)/**`, das Wurzellayout
`src/app/layout.tsx`, `sitemap.ts`, `robots.ts`, `next.config.ts`
(Umleitungen, Kopfzeilen) und die Herkunft der kanonischen Adresse. Eine
Gruppe `(marketing)` gibt es nicht; die Website liegt in `(public)`.

Stand **vor** der Korrektur ist beschrieben, dann was geändert wurde. Jede
Korrektur hat eine Prüfung, die gegen den alten Stand rot gewesen wäre
(`tests/api/seo-rechenkern.test.ts`, `tests/pages/public-site.test.ts`,
`tests/api/cms.test.ts`).

## 1. Kanonische Adresse und Herkunft

| Frage | Befund | Bewertung |
|---|---|---|
| Woher kommt die Basis-URL? | `SEITEN_URL` in `src/lib/seiten-url.ts` aus `NEXT_PUBLIC_SITE_URL` (Rückfall `NEXT_PUBLIC_APP_URL`, dann `http://localhost:3000`), **zur Bauzeit**. `metadataBase` im Wurzellayout nutzt sie. | Richtig. Begründung (V2-1) in der Datei: statisch vorgerenderte Seiten, eine kanonische Domain für alle Umgebungen. |
| Kann ein `Host`- oder `X-Forwarded-Host`-Kopf die Canonical beeinflussen? | Nein. Keine öffentliche Seite liest `headers()`; `metadataBase`, Sitemap und JSON-LD lesen nur `SEITEN_URL`. | Richtig. Seit der Korrektur zusätzlich über `seitenHerkunft()` auf den Ursprung normalisiert (Pfad, Zugangsdaten fallen weg). Prüfung: „nimmt die kanonische Adresse nicht aus einem Host-Kopf". |
| Canonical auf jeder Seite korrekt? | **Nein.** Das Wurzellayout setzte `alternates.canonical: '/'`. Next ersetzt `alternates` nur, wenn eine Seite selbst welche setzt — alle anderen (Rechnung, Buchung, Offerte per Link, Anmeldung, Zahlungsrückkehr, sämtliche Applikationsseiten) erklärten die **Startseite** zu ihrer kanonischen Fassung. | **Behoben:** keine `alternates` mehr im Wurzellayout; jede öffentliche Seite setzt ihre Canonical selbst über `seitenMetadaten()`. |
| Canonical aus Redaktionsfeldern? | Nein, aus dem Seitenpfad. Neu zusätzlich geprüft (`kanonischerPfad`): nur Pfade mit genau einem führenden `/`, ohne Schema, `..`, Backslash, Leer- oder Steuerzeichen; Abfrage/Fragment/Schlussstrich fallen weg. Ungültig → Canonical und `og:url` entfallen. | Härtung. |

## 2. Metadaten je Seite (vor der Korrektur)

Legende: T = Titel, D = Beschreibung, C = Canonical, R = Robots, OG = OpenGraph, TW = Twitter.

| Seite | T / D | C | R | OG / TW | Befund |
|---|---|---|---|---|---|
| `/` | Redaktion (`pageMetadata`) | `/` | index | eigenes OG ohne `site_name`/`locale`/`type`; TW `summary_large_image` ohne Bild | OG unvollständig, TW-Karte falsch |
| `/leistungen`, `/preise`, `/einsatzgebiet`, `/galerie`, `/bewertungen`, `/ueber-uns`, `/faq`, `/karriere`, `/blog`, `/kontakt`, `/offerte`, `/buchen` | Redaktion | eigener Pfad | index (oder `noIndex` der Redaktion) | wie `/` | wie `/`; Titel/Beschreibung aus der Redaktion ungefiltert (Markup wäre wörtlich im Suchergebnis erschienen) |
| `/leistungen/[slug]` | Datensatz (`seoTitle ?? name`) | eigener Pfad | index | OG ohne `url`, `site_name`, `locale` | `??` liess einen leeren SEO-Titel als leeren Titel durch; Metadaten auch für deaktivierte Leistungen (Seite 404) |
| `/blog/[slug]` | Datensatz | eigener Pfad | index | OG `article` ohne `url` | Metadaten auch für Entwürfe (Seite 404) |
| `/karriere/[slug]` | Datensatz; Beschreibung = rohes Markdown, hart bei 155 Zeichen geschnitten | eigener Pfad | index | **kein** OG → erbte `og:url` der Startseite | `##`/`**` im Suchergebnis; falsches `og:url` |
| `/legal/*` (4) | fest im Code | eigener Pfad | index | **kein** OG → erbte `og:url` der Startseite | falsches `og:url` |
| Token-/Ergebnisseiten (`/offerte/[token]`, `/rechnung/[token]`, `/rechnung/[token]/danke`, `/buchung/[token]`, `/buchen/bestaetigt`, `/zahlung/*`, `/newsletter/*`) | fest | **`/` (geerbt)** | noindex | geerbt, `og:url` = Startseite | Canonical auf die Startseite (siehe 1.) |

**Behoben** über eine einzige Herstellung, `seitenMetadaten()` in
`src/lib/seo/metadaten.ts`, die jetzt alle öffentlichen Seiten verwenden
(`pageMetadata`, Detailseiten, Rechtstexte):

- Titel/Beschreibung als Klartext (`klartext`: Tags und Steuerzeichen weg,
  Entitäten bewusst nicht aufgelöst); Stellenbeschreibung ohne Markdown und
  an einer Wortgrenze gekürzt.
- Canonical und `og:url` absolut aus `SEITEN_URL` + geprüftem Pfad.
- `og:site_name`, `og:locale`, `og:type` auf jeder Seite (Next ersetzt
  `openGraph` statt es zu mischen).
- Twitter-Karte `summary_large_image` nur mit Bild, sonst `summary`.
- Vorschaubild nur als `https`, eigene Herkunft oder eigener Pfad
  (`sichereBildUrl`); `javascript:`, `data:`, fremdes `http` fallen weg.
  Zusätzlich lehnt `updateSeoSchema` solche Werte beim Speichern mit 422 ab
  (vorher `.url()`: nahm `javascript:` an, lehnte den eigenen Ablagepfad ab).
- Detailseiten liefern für deaktivierte/unveröffentlichte Datensätze nur
  „nicht gefunden" + `noindex`.
- `og:url` im Wurzellayout entfernt (wurde von Seiten ohne eigenes OG geerbt).

## 3. Sprache, hreflang

- `<html lang="de-CH">` im Wurzellayout — korrekt.
- **Befund:** Das Wurzellayout erklärte `hreflang` für `en-CH` (`/en`),
  `fr-CH` (`/fr`) und `it-CH` (`/it`). Diese Seiten gibt es nicht (404).
  **Behoben:** entfernt. Die Website ist einsprachig Deutsch; hreflang ist
  nicht nötig.

## 4. Überschriften, Landmarken, Bilder, Links

| Punkt | Befund |
|---|---|
| Genau eine `h1` | Alle öffentlichen Seiten haben genau eine `h1` (Rechtstexte: entweder die eingebaute oder die aus der Datenbank; `Markdown` stuft `#` zu `h2` herab). `/buchen`: die `h1` sitzt im Assistenten und wird serverseitig gerendert (`force-dynamic`). Neu geprüft für jede Seite in `public-site.test.ts`. |
| Landmarken | `header`, `nav aria-label="Hauptnavigation"` / „Mobile Navigation", `main id="inhalt"` mit Sprunglink im Wurzellayout, `footer`, Brotkrumen als `nav aria-label="Brotkrumen"`. In Ordnung. |
| Bilder | Einzige Bilder sind die Vorher-/Nachher-Vergleiche (`BeforeAfter`). Am 2026-09-28: `alt` = „Vorher"/„Nachher", Empfehlung: um den Galerietitel ergänzen. **Seit 2026-10-01 umgesetzt (SEO-06):** `alt` = „Vorher: <Beschreibung>" / „Nachher: <Beschreibung>", die Beschreibung aus Titel, Leistung und Ort des Datensatzes (`src/lib/seo/vergleichsbild.ts`) — nur vorhandene Teile, nichts doppelt (wortweise verglichen), höchstens 120 Zeichen, Klartext; ohne Angaben bleibt es bei „Vorher"/„Nachher". Auf Startseite und Galerie ist die Leistung die Art-Beschriftung, auf der Leistungsseite deren Name. Beschriftungen und `aria-valuetext` des Reglers unverändert. Prüfung: `seo-rechenkern.test.ts` Block „Vergleichsbilder — Alternativtext"; über HTTP `website-ops.test.ts` (Lauf steht aus) |
| Interne Links | Jede Übersichtsseite ist von der Startseite verlinkt (bestehende Prüfung). |

## 5. 404, Umleitungen, doppelte Inhalte

- `not-found.tsx`: eigene 404-Seite mit `noindex`, eine `h1`, drei Wege weiter. In Ordnung.
- `next.config.ts` leitet `/home`, englische Pfade und Kurzformen (`/impressum`, `/agb`, `/datenschutz`) dauerhaft (308) auf die deutschen Pfade um. In Ordnung.
- Schlussstrich: `trailingSlash` ist nicht gesetzt; Next leitet `/kontakt/` auf `/kontakt` um. Canonical ohne Schlussstrich. In Ordnung.
- Abfrageparameter (`/buchen?leistung=…`): Canonical ohne Abfrage. In Ordnung.
- **Befund: `FAQPage` doppelt** — Startseite (sechs Fragen) und `/faq` (alle). Google verlangt eine einzige Auszeichnung je Frage. **Behoben:** nur noch auf `/faq`.

## 6. Sitemap und robots.txt

| Punkt | Befund |
|---|---|
| Nur öffentliche Seiten | Ja — keine App-Bereiche, kein `/signieren`, kein `/api`. |
| Mandant | **Befund:** Leistungen, Beiträge und Stellen ohne `organizationId` abgefragt. **Behoben.** (Ebenso `generateStaticParams` der drei Detailseiten.) |
| `noindex`-Seiten | **Befund:** Eine in `/admin/seo` ausgeblendete Seite stand weiter in der Sitemap (Search Console: „Eingereichte URL als noindex markiert"). **Behoben:** Sitemap lässt `SeoMeta.noIndex` weg; `invalidateSeo` erneuert die Sitemap sofort. |
| Adressen | Einheitlich über `absoluteSeitenUrl()` — dieselbe Funktion wie Canonical und JSON-LD. |
| robots.txt | Sperrte App-Bereiche, `/api/`, `/auth/`, Token-Seiten, `/newsletter/`. **Ergänzt:** `/signieren`, `/abnahme/`, `/geraet-uebernehmen`, `/zahlung/`, `/buchen/bestaetigt`. Trainingscrawler (GPTBot usw.) bleiben ausgesperrt — geschäftliche Entscheidung, unverändert. |

## 7. Strukturierte Daten (JSON-LD)

**Vorher:** sieben handgeschriebene `<script>`-Blöcke. Befunde:

- Fester Firmenname „Clenaris Reinigungen GmbH" in Leistung, Bewertungen, Beitrag, Stelle — nach einer Änderung der Stammdaten still falsch.
- Erfundene `priceRange` „CHF 62–95 / Std." im Firmenknoten.
- `postalCode` an `City` (gibt es dort nicht); nur die ersten 30 Postleitzahlen, Orte mehrfach.
- Leistung: `offers.price = hourlyRate || minPrice` — bei Pauschalen ein anderer Preis als der sichtbare; `provider` mit fester Adresse „Bern"; `availability: InStock` ohne Bedeutung für eine Dienstleistung.
- Bewertungen als zweites, unverbundenes `LocalBusiness`.
- Stelle: Lehrstelle und Stundenlohn als `PART_TIME`; Beschreibung als rohes Markdown.
- `FAQPage` doppelt (siehe 5.).

**Jetzt:** reine Bauteile in `src/lib/seo/structured-data.ts`, ausgegeben
ausschliesslich über `src/components/marketing/json-ld.tsx` (maskiert `<`,
`>`, `&`, U+2028, U+2029 über `lib/json-ld.ts`). Leere Felder fallen weg
(`ohneLeere`), nichts wird erfunden.

| Seite | Typen | Quelle |
|---|---|---|
| jede öffentliche Seite (Layout) | `HousekeepingService` (`@id …/#organisation`: Name, rechtlicher Name, URL, Logo falls gepflegt, Telefon, E-Mail, Adresse, `areaServed` = Orte des Einsatzgebiets, `ContactPoint`, Öffnungszeiten, Leistungskatalog mit Links) + `WebSite` (ohne `SearchAction` — keine öffentliche Suche) | Stammdaten, Einsatzgebiet, aktive Leistungen — alles auch sichtbar in der Fusszeile |
| `/leistungen/[slug]` | `Service` (provider per `@id`, `areaServed`, `Offer` nur mit dem sichtbaren Preis, netto wie angezeigt „zzgl. MWST"; keine Bewertungsnote — die Seite zeigt keinen Schnitt) + `BreadcrumbList` (sichtbar) | Datensatz, `leistungsPreis()` — dieselbe Funktion wie die Preisbeschriftung |
| `/faq` | `FAQPage` | aktive Fragen |
| `/bewertungen` | `aggregateRating` + `review` am Firmenknoten (`@id`) — nur mit veröffentlichten Bewertungen, echte Werte, sichtbar | Bewertungen |
| `/blog/[slug]` | `Article` (Verlag = Firma) + `BreadcrumbList` | Datensatz |
| `/karriere/[slug]` | `JobPosting` (Arbeitgeber, Kanton, Land aus Stammdaten) + `BreadcrumbList` | Datensatz |

**Typwahl:** `HousekeepingService` ist der spezifischste schema.org-Typ für
Reinigung (LocalBusiness → HomeAndConstructionBusiness → HousekeepingService)
und steht auf Googles Liste unterstützter LocalBusiness-Typen. Da
`LocalBusiness` von `Organization` erbt, ist ein Knoten beides; ein zweiter
`Organization`-Knoten wäre eine zweite Firma.

Hinweis: Google zeigt für Bewertungen, die ein Geschäft über sich selbst auf
der eigenen Website auszeichnet, keine Sterne im Suchergebnis. Die Angaben
sind zulässig und bleiben, weil sie wahr und sichtbar sind.

## 8. Verwaltung: SEO-Status (`/admin/seo`)

Neue Übersicht unter dem Editor: je öffentlicher Seite (Übersichtsseiten,
Rechtstexte, aktive Leistungen, veröffentlichte Beiträge und Stellen) Titel-
und Beschreibungslänge gegen Richtwerte (Titel inkl. „| Clenaris" bis 60,
Beschreibung 70–160), Canonical, index/noindex, Vorschaubild, Typen der
strukturierten Daten, Befunde. Berechnet von `seoStatus()` aus **demselben**
`seitenMetadaten()` wie die Seiten; nichts wird automatisch geändert.

## 9. Offen / Empfehlungen (nachgeführt 2026-10-01)

| Punkt | Warum offen |
|---|---|
| ~~Kein Standard-Vorschaubild (`og:image`) für Seiten ohne gepflegtes Bild~~ | **Erledigt 2026-09-29** (SEO-06, `88a6950`): Standard-Vorschaubild aus der freigegebenen Bildmarke (`public/og-standard.png`, 1200 × 630); ein gepflegtes CMS-Bild geht vor. Geprüft in `seo-rechenkern.test.ts` und `cms.test.ts` (og:image mit Massen, PNG ausgeliefert). |
| ~~`alt` der Vorher-/Nachher-Bilder generisch~~ | **Erledigt 2026-10-01** (SEO-06, `dd13549`) — siehe 4. |
| ~~Kein Favicon/App-Icon und kein Web-Manifest in `src/app`~~ | **Erledigt:** Favicon `src/app/icon.svg` (`64e8edb`), Web-App-Manifest `src/app/manifest.ts` → `/manifest.webmanifest` (`88a6950`, geprüft in `cms.test.ts`). |
| Galerieänderung erneuerte die Leistungsseiten nicht | **Erledigt 2026-10-01** (`82f3922`): `revalidatePath` braucht unter einer Routengruppe den Pfad mit Gruppe (`/(public)/leistungen/[slug]`, ebenso `/(public)/karriere/[slug]`); ohne Gruppe war der Aufruf wirkungslos. `seo-rechenkern.test.ts` gleicht seither jede Angabe gegen `src/app` ab. Offen: derselbe wirkungslose Aufruf in `catalog.service.ts` (harmlos, `docs/PENDENZEN.md` P2H-66) und der CMS-Bildaustausch, der die Detailseiten nicht erneuert (P2H-67). |
| `robots.txt` sperrt `noindex`-Seiten zusätzlich | Bewusst beibehaltene Linie des Repos (Personendaten); Nebenwirkung: Google sieht das `noindex` einer gesperrten Seite nicht und kann eine extern verlinkte Adresse ohne Inhalt listen. |
| Rich-Result-Test mit echtem Google-Werkzeug | **EXTERNER NACHWEIS ERFORDERLICH:** Lauf von search.google.com/test/rich-results und validator.schema.org gegen die Produktionsdomain. |
