# Barrierefreiheit (Wave 18)

Stand 2026-09-23. Status: **PARTIAL** — die maschinell messbaren Regeln sind
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
| Öffentlich | `/`, `/auth/anmelden`, `/kontakt`, `/offerte` |
| Verwaltung | `/admin`, `/admin/rechnungen`, `/admin/lohn`, `/admin/suche?q=Reinigung`, `/admin/reklamationen`, `/admin/besichtigungen` |
| Portal / Konto | `/portal`, `/portal/lohn`, `/konto`, `/konto/reklamationen` |

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

## Was nicht geprüft ist

- **Tastaturbedienung im Ablauf** (Dialoge öffnen/schliessen, Fokusrückgabe,
  Kalender, Datei-Upload). Die Radix-Bausteine bringen das mit; bewiesen ist es
  nur für die PDF-Werkzeugleiste (`gate3-pdf-viewer.spec.ts`).
- **Screenreader** (NVDA, VoiceOver) — keine Sitzung durchgeführt.
- **Dunkles Farbschema** — die Reihe misst nur das helle.
- Seiten ausserhalb der Liste, insbesondere Führung, Kalender, Signatur- und
  Abnahmeseiten.
- Verständlichkeit, Leichte Sprache, Zoom auf 400 %.

**EXTERNAL VERIFICATION REQUIRED** für jede Aussage über Konformität: eine
manuelle Prüfung mit Screenreader und Tastatur durch eine Fachperson.
