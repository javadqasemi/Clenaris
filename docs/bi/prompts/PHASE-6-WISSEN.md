# Phase 6 — Dokumente, Wissen, Markt, Sitzungen

Baue die Dokumentenablage, die interne Wissensdatenbank, die
Wettbewerbs- und Marktbeobachtung samt SWOT/PESTEL, und die
Sitzungsverwaltung.

**Unabhängig von den anderen Phasen.**

**Lies zuerst** `docs/bi/01-DATENMODELL.md` Abschnitt 6,
`docs/bi/02-BERECHTIGUNGEN.md` Abschnitt 6.2 (**zwingend**),
`docs/bi/05-MIGRATION-TESTS-BETRIEB.md` Abschnitt 4.

## Warnung vorab

Die Dokumentenablage ist die heikelste neue Fläche des ganzen Vorhabens. Sie
nimmt Verträge, Versicherungspolicen, Personaldokumente und Steuerunterlagen
auf. Ein Fehler in der Zugriffsprüfung ist hier sofort ein
Datenschutzvorfall, kein Anzeigefehler.

Wenn in dieser Phase ein Kompromiss nötig wird, geht er zulasten des
Funktionsumfangs, nie zulasten der Sichtbarkeitsprüfung.

## Umfang

### 1. Schema

`ManagedDocument`, `DocumentVersion`, `KnowledgeArticle`, `Competitor`,
`MarketInsight`, `AnalysisBoard`, `AnalysisEntry`, `Meeting`,
`MeetingParticipant` samt `DocumentCategory`, `DocumentVisibility`,
`ArticleStatus`, `InsightKind`, `AnalysisKind`, `AnalysisBucket` —
wörtlich aus `01-DATENMODELL.md` Abschnitt 6. Dazu aus Abschnitt 8:
Rückbeziehungen auf `Organization`, `User`, `Employee`, `Supplier`,
`Task.meetingId`, und die `FileScope`-Werte `DOCUMENT`, `ARTICLE`,
`MEETING`.

`ManagedDocument.currentVersionId` ↔ `DocumentVersion.documentId` ist ein
Zirkelbezug. Das Anlegen braucht drei Schritte in **einer** Transaktion:
Dokument, Fassung, Dokument aktualisieren.

### 2. Dokumentendienst

`src/server/services/document.service.ts`.

**Eine einzige Sichtbarkeitsfunktion** nach `02-BERECHTIGUNGEN.md`
Abschnitt 6.2, benutzt von Liste, Detailansicht **und Download**. Drei Punkte
dazu, jeder davon ein anderswo schon begangener Fehler:

1. `EMPLOYEE_PRIVATE` steht **nie** in der Stufenliste. Es kommt
   ausschliesslich über den Zweig mit `subjectEmployeeId` herein.
2. Der Download darf nicht `document:read` prüfen und dann `findUnique`
   machen. Das Recht sagt „darf Dokumente sehen", nicht „darf *dieses*
   Dokument sehen". Das ist der klassische horizontale Zugriffsfehler.
3. Der Download liefert eine kurzlebige signierte URL über
   `src/lib/storage/`, nie einen Speicherpfad.

Weiter:

- Bei `category = EMPLOYEE` setzt **der Dienst** `visibility` auf
  `EMPLOYEE_PRIVATE` und verlangt `subjectEmployeeId`. Nicht das Formular —
  ein Standardwert, den man im Formular übersehen kann, wird übersehen.
- Jeder Download schreibt in den `AuditLog` (`AuditAction.EXPORT`, Entität
  `ManagedDocument`). Wer eine Personalakte öffnet, ist nachvollziehbar.
- Eine neue Fassung erhöht `version` und setzt `currentVersionId` um. Alte
  Fassungen bleiben — ein Vertrag ohne Vorversion ist im Streitfall wertlos.
- Fristenwarnung über `expiresOn` und `reminderDaysBefore`. Das ist der
  Grund, warum eine Vertragsablage mehr wert ist als ein Ordner auf dem
  Laufwerk. **Automatisch gelöscht wird nichts** — die Frist meldet, ein
  Mensch entscheidet.

### 3. Wissen, Markt, Analysen, Sitzungen

`knowledge.service.ts` und `meeting.service.ts`.

**Wissensartikel** tragen `DocumentVisibility`; `STAFF` ist die Vorgabe, weil
Ablaufbeschreibungen und Schulungsunterlagen für die Mitarbeitenden
geschrieben sind. Volltextsuche über Titel, Zusammenfassung und Text sowie
Filter nach Kategorie und Schlagwort. Videos werden **verlinkt**, nicht
gespeichert.

**Analysetafeln** sind Fassungen, keine laufend überschriebene Liste. Eine
neue Tafel verkettet sich über `supersededById` mit der alten. Wer die SWOT
von 2026 mit der von 2028 vergleichen will, braucht beide — und eine
Analyse, die man unbemerkt umschreiben kann, hält keiner Besprechung stand.

Die Maske zeigt je nach `AnalysisKind` nur die passenden Felder: vier
Quadranten bei SWOT, sechs Spalten bei PESTEL.

**Sitzungen**: Pendenzen entstehen als echte `Task`-Zeilen mit `meetingId`.
Kein zweites Pendenzensystem — die Liste im Protokoll wird nach der Sitzung
nie wieder geöffnet.

### 4. Berechtigungen

`document:*` (fünf inkl. `read_own`), `knowledge:*` (vier), `market:*`
(zwei), `meeting:*` (vier).

- `MANAGER`: `knowledge:read`, `meeting:read`, `meeting:create`,
  `meeting:update`. **Kein Dokumentenzugriff.**
- `EMPLOYEE`: `knowledge:read`, `document:read_own`.

`PERMISSION_ROUTES`: `/admin/fuehrung/dokumente`, `/admin/fuehrung/markt`
— vor dem Präfix.

### 5. Endpunkte und Seiten

Die vierzehn Endpunkte aus `03-API-UND-SEITEN.md` Abschnitt 3, Phase 6.

```
/admin/fuehrung/dokumente          Ablage, Filter nach Kategorie, Fristenliste
/admin/fuehrung/dokumente/[id]     Fassungen, Vorschau, Download
/admin/fuehrung/wissen
/admin/fuehrung/wissen/[slug]
/admin/fuehrung/markt              Wettbewerb, Beobachtungen, Tafeln
/admin/fuehrung/markt/analyse/[id]
/admin/fuehrung/sitzungen
/admin/fuehrung/sitzungen/[id]
```

Die Dokumentenliste zeigt die Sichtbarkeitsstufe je Zeile deutlich. Wer eine
Personalakte hochlädt, soll vor dem Speichern sehen, wer sie lesen kann.

### 6. Navigation

`Dokumente` mit Zähler = Dokumente, die innerhalb ihrer Vorwarnfrist
ablaufen. `Wissen`, `Markt und Wettbewerb`, `Sitzungen` ohne Zähler.

### 7. Nachtlauf

Schritt 5 aus `05-MIGRATION-TESTS-BETRIEB.md` Abschnitt 3: ablaufende
Dokumente melden, gebündelt.

### 8. Tests

`tests/api/bi-documents.test.ts` **und** Fälle in
`tests/api/ownership.test.ts` — der wichtigste Testblock dieses Vorhabens:

| Fall | Erwartung |
| --- | --- |
| `EMPLOYEE` lädt fremdes Personaldokument | 404 |
| `EMPLOYEE` lädt das eigene Personaldokument | 200 |
| `EMPLOYEE` listet Dokumente | nur `STAFF` und die eigenen |
| `MANAGER` listet Dokumente | kein `MANAGEMENT`, kein `EMPLOYEE_PRIVATE` |
| `MANAGER` lädt `MANAGEMENT`-Dokument direkt über die ID | 404 |
| `CUSTOMER` auf `/api/bi/documents` | 403 |
| Neue Fassung | `version` +1, alte bleibt lesbar |
| Download | schreibt `AuditLog`-Eintrag |

Der fünfte Fall ist der entscheidende: er prüft, dass der Download-Endpunkt
denselben Filter benutzt wie die Liste.

## Fertig, wenn

- [ ] `npm run typecheck && npm run lint && npm run docs` sauber
- [ ] `npm test` grün, `ownership.test.ts` um alle Fälle oben erweitert
- [ ] Ein Personaldokument ist für niemanden ausser Geschäftsleitung und
      betroffener Person erreichbar — auch nicht über die direkte URL
- [ ] Downloads erscheinen im Prüfprotokoll unter `/admin/protokoll`
- [ ] Ablaufende Verträge erzeugen eine Meldung
- [ ] Eine zweite SWOT-Tafel verdrängt die erste nicht, sondern verkettet sich
- [ ] Sitzungspendenzen erscheinen unter `/admin/aufgaben`
- [ ] Deutsche Oberfläche, `ss` statt `ß`

## Nicht tun

- Sichtbarkeit **nie** im Rendering entscheiden, nur in der `where`-Klausel
- `EMPLOYEE_PRIVATE` nie über die Stufenliste erreichbar machen
- Kein Video-Hosting — verlinken
- Keine automatische Löschung abgelaufener Dokumente
- Wissensartikel nicht mit `BlogPost` oder `Faq` zusammenlegen — ein Fehler
  im Statusfeld würde internes Material veröffentlichen
