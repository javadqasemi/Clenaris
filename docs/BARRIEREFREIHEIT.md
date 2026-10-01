# Barrierefreiheit (Wave 18)

Stand 2026-09-23, nachgeführt 2026-10-01 (Seitenmatrix seit dem
Release-Kandidaten 2026-09-29, Oberflächenprüfung Phase 21).
Status: **PARTIAL** — die maschinell messbaren Regeln sind
auf den geprüften Seiten ohne schweren Verstoss und werden in der
Browser-Reihe gehalten; eine manuelle Prüfung (Tastatur, Screenreader,
Verständlichkeit) hat nicht stattgefunden. Nichts in diesem Dokument ist eine
Konformitätserklärung nach WCAG 2.1 AA oder eCH-0059.

## Wie gemessen wird

`tests/e2e/wave18-barrierefreiheit.spec.ts` lädt axe-core in den echten
Browser (Chromium, gegen den Testserver) und prüft die Regeln mit den Tags
`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`:

| Bereich | Seiten |
|---|---|
| Öffentlich | `/`, `/auth/anmelden`, `/kontakt`, `/offerte`, `/buchen` |
| Verwaltung | `/admin`, `/admin/kunden`, `/admin/offerten`, `/admin/vertraege`, `/admin/buchungen`, `/admin/einsaetze`, `/admin/rechnungen`, `/admin/personal`, `/admin/lohn`, `/admin/einstellungen`, `/admin/auswertungen/website`, `/admin/suche?q=Reinigung`, `/admin/reklamationen`, `/admin/besichtigungen` |
| Portal / Konto | `/portal`, `/portal/lohn`, `/portal/zeiterfassung`, `/konto`, `/konto/reklamationen`, `/konto/nachrichten`, `/konto/rechnungen` |

**26 Seiten** seit dem Release-Kandidaten vom 2026-09-29 (vorher 14): Erweitert
um die meistbenutzten Listen, die bis dahin ausserhalb der Messung lagen
(Buchung, Kunden, Offerten, Verträge, Buchungen, Einsätze, Personal,
Einstellungen, Website-Besuche, Nachrichten). Im abschliessenden Lauf des
Release-Kandidaten meldete axe dort **keinen Befund jeder Stufe**, auch nicht
moderate oder minor (`docs/PENDENZEN.md` RC-07) — die Schwelle des Falls bleibt
trotzdem „schwer", siehe unten.

Gemessen wird erst, wenn die Seite ruhig ist: auf den Seiten des
`(public)`-Rahmens nach dem Erscheinen des Cookie-Banners (800 ms nach dem
Laden, 500 ms Einblenden — es wird damit immer mitgeprüft), überall nach dem
Ende aller endlichen Animationen. Ohne das mass axe in 2 von 10 vollen Läufen
das halb eingeblendete Banner (2.5 : 1) — ein Messfehler, kein Seitenfehler.

Verstösse der Stufe `critical` oder `serious` lassen den Fall scheitern;
`moderate`/`minor` liegen als JSON-Anhang im Playwright-Bericht. Die Schwelle
ist bewusst so gezogen: Eine Reihe, die bei jedem Hinweis rot wird, wird
abgeschaltet; eine, die nur Schweres misst, bleibt an.

## Was die Messung gefunden hat

Die erste Messung ergab auf **jeder** der vierzehn Seiten mindestens einen
schweren Verstoss. Behoben:

| Befund | Ursache | Behebung |
|---|---|---|
| Primärschaltflächen: dunkle Schrift auf Blaugrün, 2.9 : 1 — auf jeder Seite mit einer kleinen oder grossen Primärschaltfläche | **Produktfehler, kein Farbwert:** `tailwind-merge` kannte die eigenen Schriftgrössen (`text-meta`, `text-body`, …) nicht, hielt sie für Textfarben und warf `text-primary-foreground` weg | `cn()` in `src/lib/utils.ts` mit `extendTailwindMerge` um die Schriftgrössen aus `tailwind.config.ts` ergänzt — die Liste muss dort mitwachsen |
| Passwortfeld: fokussierbare Schaltfläche in `aria-hidden` | Die Hülle des rechten Icons in `Input` war pauschal `aria-hidden`, obwohl dort die Schaltfläche „Passwort anzeigen" sitzt | `aria-hidden` von der rechten Hülle entfernt; schmückende lucide-Icons sind selbst `aria-hidden` |
| Sternbewertung: `aria-label` auf rollenlosem Element | ARIA verbietet einen Namen ohne Rolle; Screenreader verschlucken ihn | `role="img"` (Marketing und Kundenbereich) |
| Kontaktseite: `dt`/`dd` in verschachtelten `div` | Icon und Paar lagen in zwei Ebenen unter der `dl` | eine Ebene; Icon im `dt`, absolut im Einzug — gleiches Bild |
| Warntext 3.4–4.2 : 1 | `--warning` mit 35 % Helligkeit | 28 % — trägt auch `text-warning/90` |
| Initialen im Personenavatar 3–3.8 : 1 | Schrift in voller Personalfarbe auf deren eigener Tönung | Schrift auf 55 % abgedunkelt; gilt auch für frei gewählte Farben |
| Platzhalter der Auswahl 3.7 : 1 | `text-muted-foreground/80` | volle Deckkraft; Eingabefeld und Textfeld ebenso (axe misst dort nicht, WCAG 1.4.3 gilt trotzdem) |

## Oberflächenprüfung (seit 2026-09-27, `tests/e2e/phase21-oberflaeche.spec.ts`)

Zusätzlich zur Seitenmatrix, im echten Browser:

- **Navigation je Rolle:** jeder Eintrag der Seitenleiste in fünf Rollen
  erreichbar, aktiv markiert, axe ohne schwere Befunde.
- **Sprunglink:** erster Tabstopp, springt zum Inhalt — öffentlich, im Konto
  und beim Unterschreiben.
- **Umbruch:** kein seitliches Scrollen in sieben Fenstergrössen und bei
  200 % Zoom.
- **Mobile Navigation:** dieselben Einträge wie die Seitenleiste, Escape
  schliesst, der Fokus kehrt zurück.
- **Dialog und Suche:** Fokus hinein, Escape hinaus, Fokus zurück; Pfeiltasten
  bis „Alle Treffer".
- **Reduzierte Bewegung:** keine laufenden Übergänge über 10 ms auf der
  Startseite.
- **Telefon:** öffentliche Seiten ohne schwere Befunde.

Seit 2026-09-30 laufen axe und die Oberflächenprüfung in einer Seite **ohne
`'unsafe-eval'`** in der Inhaltsrichtlinie (`docs/SECURITY_STANDARD.md` C6).
Nach Durchsicht von axe-core 4.13 steht `new Function` nur auf Wegen
(Sprachdateien, eigene Regeln), die die Prüfhilfe nicht benutzt. Belegt ist
das erst mit dem Browserlauf auf dem Härtungskandidaten.

## Was nicht geprüft ist

- **Tastaturbedienung im ganzen Ablauf** — Fokusführung ist für
  Navigation, Sprunglink, mobile Navigation, einen Dialog, die Suche und die
  PDF-Werkzeugleiste (`gate3-pdf-viewer.spec.ts`) bewiesen; nicht für Kalender,
  Datei-Upload und die übrigen Dialoge. Die Radix-Bausteine bringen das mit.
- **Screenreader** (NVDA, VoiceOver) — keine Sitzung durchgeführt.
- **Dunkles Farbschema** — die Reihe misst nur das helle.
- Seiten ausserhalb der Liste, insbesondere Führung, Kalender, Signatur- und
  Abnahmeseiten (die Führung nur über die Navigationsprüfung je Rolle).
- Verständlichkeit, Leichte Sprache, Zoom auf 400 %.

**EXTERNAL VERIFICATION REQUIRED** für jede Aussage über Konformität: eine
manuelle Prüfung mit Screenreader und Tastatur durch eine Fachperson.
