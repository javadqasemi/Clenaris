---
name: security
description: Sicherheitsprüfung für jede Clenaris-Änderung, die eine Route, einen Dienst, eine Abfrage, eine Datei, ein Token, einen Webhook, Geld oder Personendaten berührt. Vor dem Programmieren laden und vor dem Commit abhaken — Anmeldung, Rechte, Mandant, Eigentum/IDOR, Validierung, CSRF, XSS, SSRF, Injection, Rate-Limit, Geheimnisse, PII, Dateien, öffentliche Tokens, Webhooks, Replay, Nebenläufigkeit, Idempotenz, Finanzintegrität, Protokoll, Fehler, Abhängigkeiten, Invarianten, Prüfungen.
---

# Sicherheit — Prüfweg für jede Umsetzung

Zwei Sätze vorweg, weil fast jeder Befund der Audits 2026-09 auf sie
zurückging:

> **Verbergen in der Oberfläche ist keine Berechtigung.**
> **Eine geheime Kennung (cuid, UUID) ist keine Berechtigung.**

Was nicht im Server — in der Route **und** in der Prisma-Abfrage — entschieden
wird, ist nicht entschieden. Ein Knopf, der fehlt, und eine Kennung, die
niemand kennt, schützen nichts.

## Wann dieser Skill gilt

Bei jeder Änderung an: `src/app/api/**`, `src/server/services/**`,
`src/lib/auth/**`, `src/lib/storage/**`, `src/lib/validation/**`,
`src/middleware.ts`, Seiten, die Daten lesen, Migrationen, Cron- und
Webhook-Wegen, KI-Funktionen, Exporten. Im Zweifel: gilt.

## Vorgehen

1. Die betroffenen Wege auflisten (Route → Dienst → Abfrage → Antwort,
   plus Seite, Cron, Automation, PDF, E-Mail).
2. Jede Zeile der Tabelle unten beantworten — „nicht zutreffend" mit Grund.
3. Für jede zutreffende Zeile eine Prüfung in `tests/api/*` (nicht nur einen
   Statuscode: den Bestand in der Datenbank nachsehen).
4. Vor dem Commit: `npm run security:check:static`, `npm run security:secrets`,
   und die berührten Prüfdateien gegen den Testserver.

## Prüftabelle

| Klasse | Frage | Wie in Clenaris |
|---|---|---|
| Anmeldung | Ist die Route über `defineRoute`/`definePublicRoute`/`defineCronRoute` erklärt? Seiten: `requirePermission()`/`requirePagePermission()`? | Eine Route ohne erklärten Schutz gibt es nicht. Handgebaute Routen (z. B. `api/files/blob`) prüfen Sitzung **und** Gerätesperre selbst. |
| RBAC | Welche Rechte (`permissions`, `roles`) braucht sie? Stimmt `scripts/openapi-routes*.ts`? | Katalog `lib/auth/permissions.ts`, Rollen `lib/auth/rbac.ts`; `npm run openapi` prüft die Übereinstimmung. 403 für fehlendes Recht. |
| Mandant | Steht `organizationId` in **jedem** `where` — auch beim Ändern, Löschen, Zählen, in `include`-Unterabfragen? | Fremder Datensatz = 404. Falle: `{...sicht, ...(q ? {OR} : {})}` überschreibt die Sicht → immer `AND: [sicht, filter]`. |
| Eigentum / IDOR | Jede Kennung aus dem Körper (customerId, propertyId, bookingId, quoteId, jobId, fileId, employeeId, supplierId, kpiDefinitionId …) gegen Organisation **und** Elternteil geprüft? | Vorbilder: `buchungsbezuegePruefen`, `vertragsbezuegePruefen`, `organisationsbezugPruefen` (`bezug.service.ts`). Beim **Anlegen und Ändern**. Kundschaft: `*:read_own` in der Abfrage (`customerId` im `where`). |
| Validierung | Zod-Schema in `src/lib/validation/` (nie inline)? Zeichenkettenlängen, Zahlbereiche, Enums, Regex für Pfadsegmente? | 422 mit Feld; deutsche Meldungen (`fehlerkarte.ts`). `dateOnlySchema` nimmt seine eigene Ausgabe an. |
| CSRF | Schreibende Anfrage mit Cookie-Sitzung? | `assertTrustedOrigin` in der Routenfabrik; handgebaute Routen prüfen selbst. SameSite-Cookies sind kein Ersatz. |
| XSS | Freitext im HTML? `dangerouslySetInnerHTML`? JSON-LD? | Nie mit fremdem Inhalt. JSON-LD über `JSON.stringify` + `<`-Maskierung. CSP in `next.config.ts`. |
| SSRF | Holt der Server eine Adresse, die ein Mensch eingeben kann? | Nur über `lib/automation/webhook.ts` (Ziel **und** Verbindung geprüft, DNS-Rebinding, keine Weiterleitung). |
| Injection | `$queryRaw`/`$executeRaw`? Export nach CSV/XLSX? | Nur Platzhalter-Templates; Tabellen über `csvZeile`/`mappeSchreiben` (`formelsicher`). |
| Rate-Limit | Anmeldung, öffentliche Formulare, Links, Suche, Scanner, Uploads, KI? | Klasse aus `lib/rate-limit.ts` an der Route; Seiten, die einen Dienst direkt rufen, zählen mit `checkRateLimit`. |
| Geheimnisse | Neuer Schlüssel? Im Browser sichtbar? Im Protokoll? | Nur serverseitig; `NEXT_PUBLIC_` nie für Geheimnisse; `npm run security:secrets`. |
| PII | Personendaten in Protokoll, Fehler, KI-Nutzlast, Analyse? | Protokoll über `auditDaten`; KI über `ausgangsfilter`/`namenErsetzen`; keine rohe IP-Historie. Sensibel: `lib/sensitive-fields.ts` (Lohn, AHV, IBAN, Gesundheit, Zugangscodes). |
| Dateien | Upload, Bindung, Auslieferung? | Ticket → Bytes (einmal) → Abschluss → `dateienBinden`; Scan-Tor vor Auslieferung; Schlüssel nur aus Kennungszeichen; `binaerAntwort`. |
| Öffentliche Tokens | Link mit Zugriff ohne Sitzung? | Nur Hash in der DB, Zweck, Ablauf, Widerruf (`access-token.service.ts`); roher Token nur im Fragment/Tauschkörper. |
| Webhooks | Signatur, Zeitfenster, Ereignis-ID einmalig? | `ProviderWebhookEvent` in derselben Transaktion. |
| Replay | Einmalcode, Refresh-Token, Bestätigung? | Atomar verbrauchen: bedingtes `updateMany` + Zählung. |
| Nebenläufigkeit | Was darf nur einmal geschehen, wenn zwei Klicks gleichzeitig kommen? | Prüfen **und** Schreiben in einer Transaktion: `FOR UPDATE`, `pg_advisory_xact_lock`, bedingtes Update, Teilindex. Prüfung in `nebenlaeufigkeit.test.ts` mit `Promise.all`. |
| Idempotenz | Cron, Automation, Webhook, Wiederholung nach Zeitüberschreitung? | Eindeutiger Schlüssel je Lauf/Aktion/Ereignis; zweiter Lauf ändert nichts. |
| Finanzintegrität | Betrag, Nummer, Saldo? | `Decimal`, `lib/money.ts` (`geld`, `aufRappen`, `prozentVon`), nie `Math.round(x*100)/100`; Nummer im selben Commit wie der Beleg; Belege append-only; lückenlos (Art. 957a OR). |
| Protokoll | Muss es für diesen Vorgang einen Eintrag geben? | `audit.*`; für „nie ohne Eintrag": `recordAuditInTx`. Geschwärzt. |
| Logging | Landet ein Token, Passwort, Körper im Log? | `logger` mit `redact`; keine Anfragekörper loggen. |
| Fehler | Stacktrace, SQL, interne Kennung nach aussen? | Typisierte Fehler (`lib/errors.ts`), `toErrorResponse`; 404 statt 403, wo 403 die Existenz verriete. |
| Abhängigkeiten | Neues Paket? | Begründen; `npm audit` gegen `security/akzeptierte-befunde.json`; Aktionen auf Commit gepinnt. |
| Invarianten | Welche Geschäftsregel darf nie brechen? | Z. B. „Offerte ACCEPTED ⇔ abgeschlossene Annahme", „nie die letzte Systemverantwortung", Gutscheinlimit. In der DB, wo möglich. |
| Prüfungen | Gibt es für jede Zeile oben mit „trifft zu" eine Prüfung, die gegen den alten Stand scheitert? | 401/403/404/422, falscher Mandant, fremde Kundschaft, Gleichzeitigkeit, Idempotenz, Protokoll geschwärzt. |

## Häufige Fallen aus diesem Repository

- **Prüfbestand, der den Fehler voraussetzt.** Vier Prüfdateien nahmen „das
  erste Objekt überhaupt" als Objekt einer Kundschaft (die Liste liefert
  `customer.id`, nicht `customerId`) — sie setzten damit genau die IDOR-Lücke
  voraus. Fixtures prüfen, bevor man ihnen glaubt.
- **Prüfung nur beim Anlegen.** Das Ändern daneben wird vergessen. Immer
  beide Wege.
- **Prüfen vor, schreiben in der Transaktion.** Zwischen beiden liegt der
  Wettlauf (Gutscheinlimit, Ausstellen gegen Löschen). Die Prüfung gehört
  unter die Sperre.
- **`undefined` fällt beim Serialisieren weg.** „Entfernen" muss `null` sein;
  fehlend heisst „unverändert".

## Nicht behaupten

Keine Zertifizierung, keine Rechtskonformität, kein „vollständig sicher".
Was nur ausserhalb des Repositories belegbar ist, heisst
**EXTERNER NACHWEIS ERFORDERLICH** — mit dem fehlenden Beleg.
