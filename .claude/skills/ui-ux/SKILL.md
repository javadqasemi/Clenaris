---
name: ui-ux
description: Prüfweg für jede Änderung an der Clenaris-Oberfläche (Seite, Formular, Dialog, Liste, Navigation, Website-Abschnitt). Zuerst das bestehende Designsystem wiederverwenden, dann Navigationsebene, Rollen, Desktop/Tablet/Telefon, Browser (Chromium, Firefox, WebKit), Lade-/Leer-/Fehler-/Erfolgs- und Berechtigungszustand, Tastatur, Fokus, Barrierefreiheit, Kontrast, Leistung und Einheitlichkeit prüfen. Erfindet kein neues Design.
---

# Oberfläche — Prüfweg für jede Änderung

**Kein neues Design erfinden.** Clenaris hat eine Formensprache
(`src/app/globals.css`, Kopfkommentar; `tailwind.config.ts`). Eine Änderung
fügt sich ein; eine zweite Lösung für dieselbe Aufgabe ist ein Fehler, auch
wenn sie hübscher aussieht.

## 1. Zuerst wiederverwenden

| Aufgabe | Baustein |
|---|---|
| Seitenkopf | `PageHeader` (`components/app/page-parts.tsx`) |
| Kennzahl | `KpiTile` |
| Abschnitt, Detail | `DetailSection` (`body="list" \| "form" \| "flush"`), `DetailRow`, Protokollzeile `.protocol-list`/`.protocol-row` |
| Status | `StatusBadge` — Farben einmal in `STATUS_MAP` (`components/ui/badge.tsx`) |
| Person | `PersonAvatar` |
| Formular / Dialog | `ResourceForm` / `FormDialog` mit `FieldSpec[]` (`components/app/resource-form.tsx`); Bearbeiten nutzt das Anlegeformular (`…/[id]/bearbeiten`) |
| Aktion mit Bestätigung | `ActionButton` (`components/app/action-button.tsx`) |
| Liste, Tabelle | `data-list`, `TableScroll`, Sortierung `lib/sort.ts` |
| Filter | `FilterBar` |
| Leer | `EmptyState` mit Handlungsvorschlag |
| Auswahl, Menü, Dialog | `components/ui/controls.tsx`, `overlays.tsx` (Radix) |
| Symbole | lucide-react, nie Emoji |

Typografie `text-2xs`/`text-meta`/`text-body`/`text-title`, Schatten
`shadow-soft`/`shadow-card`, `tabular-nums` für Zahlen. Deutsch, `ss` statt `ß`.

## 2. Richtige Ebene

- **Seitenleiste** = Hauptgruppen (Layout, gefiltert mit `filterNavigation`).
- **Seiten-/Unternavigation** = Unterbereiche einer Gruppe.
- **Kopfzeile** = globale Suche, Scanner, Benachrichtigungen, Profil.
- Profileinstellungen (eigene Person) ≠ Firmeneinstellungen.
- Keine doppelten Einträge, keine toten Links, kein Link in einen Bereich, den
  die Rolle nicht betreten darf. Vier Ebenen müssen übereinstimmen:
  `middleware.ts` → `PERMISSION_ROUTES` → Layout-Navigation → `requirePermission()`/`can()` auf der Seite.

## 3. Rollen

SUPER_ADMIN, ADMIN, MANAGER, EMPLOYEE, CUSTOMER: Für jede Rolle entscheidet
`can()` **auf dem Server**, welche Knöpfe entstehen. Keine Aktion anzeigen, die
die Rolle nicht ausführen kann — der Endpunkt prüft trotzdem (siehe Skill
`security`).

## 4. Zustände

Jede Seite, jede Liste, jedes Formular: **Laden** (`NavigationProgress`, keine
`loading.tsx` — Hydration, `docs/HYDRATION.md`), **Leer**, **Fehler** (deutsche
Servermeldung am Feld), **Erfolg** (Toast oder Weiterleitung), **keine
Berechtigung** (404 für reine Bearbeitungsmasken, sonst Fehlergrenze).

## 5. Fenstergrössen und Browser

- 375×667, 390×844, 768×1024, 1024×768, 1280×800, 1440×900, 1920×1080.
- Kein waagrechtes Scrollen der Seite; Tabellen in `TableScroll`.
- Chromium, **Firefox**, **WebKit**: Bausteine, die sich je Engine
  unterscheiden können (Bilder, Auswahlfelder, Scrollsperre, Datumsfelder,
  `position: sticky`), gehören in eine `tests/e2e/*.browser.spec.ts` — die läuft
  in allen drei Projekten (`playwright.config.ts`).
- Falle `overflow` am `<html>`: verhindert, dass die Scrollsperre von Radix am
  Fenster ankommt; klebende Leisten verschwinden. Das Sicherheitsnetz steht am
  `<body>` (`globals.css`).

## 6. Tastatur, Fokus, Barrierefreiheit

- Jede Aktion ohne Maus erreichbar; Reihenfolge folgt dem Lesefluss.
- Fokus sichtbar; nach Dialogen zurück an den Auslöser; Fokusfalle im Dialog.
- Sichtbare Beschriftung an jedem Feld (Platzhalter nur als Formathinweis);
  Fehler mit dem Feld verbunden (`FormMessage`).
- Überschriftenhierarchie, Landmarken, Sprunglink.
- `prefers-reduced-motion` respektieren.
- Kontrast mindestens AA; die Kalenderfarben haben eine eigene Regression.
- Messung: axe in `tests/e2e/phase21-oberflaeche.spec.ts` (jeder Eintrag der
  Seitenleiste je Rolle) und `wave18-barrierefreiheit.spec.ts` — kritisch und
  schwer: 0. Keine WCAG-Zertifizierung behaupten.

## 7. Leistung

- Server Components lesen; nur interaktive Teile `'use client'`.
- Keine unbegrenzte Liste: Seitenweise laden.
- Schwere Bibliotheken (Diagramme, PDF) erst dort laden, wo sie gebraucht
  werden.
- Bilder mit Abmessungen oder Seitenverhältnis (kein Layoutsprung).

## 8. Nachweis vor „fertig"

- Browserfall für den geänderten Ablauf (`tests/e2e`), ohne Wiederholungen.
- `tests/pages/smoke.test.ts`: neue Seiten eintragen.
- Checkliste E aus `docs/ENGINEERING_DEFINITION_OF_DONE.md` im Commit
  beantwortet.
