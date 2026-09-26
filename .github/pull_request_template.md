## Was und warum

<!-- Kurz: was ändert sich, welches Problem löst es, welcher verworfene Weg. -->

## Sicherheit — Durchsicht nach `docs/SECURITY_STANDARD.md`

Diese Liste erzwingt nichts. Sie erinnert an die Fragen, die eine Durchsicht
stellen muss; erzwungen wird nur, was das Qualitätstor prüft (`npm run
security:check`, `npm test`, `npm run e2e`). Nicht Zutreffendes streichen,
nicht einfach ankreuzen.

- [ ] **C1 Anmeldung** — Sitzung auf dem Server geprüft; Gerätesperre (`allowDuringHandoff`) beachtet
- [ ] **C2 Rechte** — `permissions` am Endpunkt, Registry `scripts/openapi-routes*.ts` gleich, Seite/Knopf/Endpunkt einig
- [ ] **C3 Mandant** — `organizationId` im `where`; fremde ID = unbekannt; Fall gegen `fremdeOrganisation()`
- [ ] **C4 Eingaben** — Zod-Schema aus `src/lib/validation/`, Obergrenzen
- [ ] **C5 Injection** — kein Unsafe-SQL mit Werten, kein Prozess, kein Pfad aus der Anfrage
- [ ] **C6 XSS** — fremder Text nur als React-Text; keine fremde Adresse als Link/Weiterleitung
- [ ] **C7 CSRF** — kein schreibender GET; Origin-Prüfung über die Routenfactory
- [ ] **C8 SSRF** — ausgehende Verbindungen an konfigurierbare Ziele nur über `pruefeZiel`
- [ ] **C9 Rate-Limit** — Kontingent passend zum Rateproblem
- [ ] **C10 Geheimnisse** — nichts im Code, Log, Protokoll, `NEXT_PUBLIC_`
- [ ] **C11 Personendaten** — geschwärzt im Protokoll; keine in Codes, Links, Dateinamen
- [ ] **C12 Dateien** — Ticket, Abschluss, Typ/Signatur, Malware-Prüfung
- [ ] **C13 Öffentliche Tokens** — nur `PublicAccessToken`; neuer öffentlicher Endpunkt in `security/oeffentliche-endpunkte.json` begründet
- [ ] **C14 Geld** — Decimal, Preis vom Server, Belege unveränderlich
- [ ] **C15 Invarianten** — in der Datenbank (Index, Sperre); Gleichzeitigkeitsfall; neue Schranke in `security/datenbank-schranken.json`
- [ ] **C16 Protokoll** — fachliche Änderungen protokolliert, ohne Geheimnis
- [ ] **C17 Webhooks** — Signatur, Zeitfenster, idempotent
- [ ] **C18 Abhängigkeiten** — neue Laufzeitabhängigkeit in `docs/LIEFERKETTE.md`; Advisory bewertet und befristet
- [ ] **C19 Fehler** — über `toErrorResponse`, nichts Internes nach aussen
- [ ] **C20 Prüfungen** — Pflichtfälle aus C20 vorhanden

## Nachweis

- [ ] `npm run typecheck`, `npm run lint`, `npm run docs` (keine Abweichung)
- [ ] `npm test` gegen `npm run test:server`, **ohne** zusätzliche Wiederholungen, Überspringen oder entfernte Zusicherungen
- [ ] `npm run e2e` (bei Oberflächenänderungen im Rahmen zusätzlich `npm run e2e:stress`)
- [ ] `npm run security:check` ohne blockierenden Befund; neue Unterdrückung begründet
- [ ] Migration: additiv, SQL gelesen, handgeschriebene Regeln mit Begründung
