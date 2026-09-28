# Eigene Besuchsmessung (Traffic Analytics)

> Stand: 28. September 2026. Gilt für `TrafficEvent`, `POST /api/public/traffic`,
> `GET /api/traffic` und `/admin/auswertungen/website`.
>
> **Fachprüfung erforderlich.** Dieses Dokument beschreibt, was der Code tut.
> Es ist keine rechtliche Beurteilung und behauptet keine Konformität mit DSG
> oder DSGVO. Abschnitt 7 nennt, was die Betreiberin mit ihrer
> Datenschutzberatung klären und in ihre Erklärung übernehmen muss.

## 1. Zweck und Abgrenzung

Der Betrieb will wissen, **welche Seite und welche Kampagne Anfragen und
Buchungen bringt** — neben Umsatz und Auslastung, in der eigenen Datenbank.
Google Analytics, GTM und Meta-Pixel (`components/marketing/analytics.tsx`)
bleiben unverändert und optional; ihre Zahlen liegen beim Anbieter.

Nicht Teil der Messung:

- einzelne Besucherinnen und Besucher (kein Wiedererkennen, kein Profil),
- die Applikationsbereiche (`/admin`, `/portal`, `/konto`) — wer dort welche
  Seite öffnet, wäre Arbeitsüberwachung,
- Anmelde-, Signatur- und Übergabewege (`/auth`, `/signieren`, `/abnahme`,
  `/geraet-uebernehmen`) und die API.

## 2. Ablauf

```
Browser (nur mit Einwilligung „Statistik")
  components/marketing/traffic-messung.tsx   Seitenansicht je Pfadwechsel, tel:/mailto:-Klick
  lib/traffic/erfassen.ts                    Warteschlange 0.5 s, sendBeacon → fetch keepalive
        │  POST /api/public/traffic  { sitzung, ereignisse[≤20] }
        ▼
definePublicRoute   Herkunftsprüfung (fremder Origin → 403), Kontingent `traffic` 120/min je IP,
                    Zod `trafficBatchSchema` (.strict, 422)
        ▼
traffic.service.ts  trafficErfassen: Sec-GPC/DNT → verwerfen; Automat → verwerfen;
                    lib/traffic/bereinigen.ts je Ereignis; Sitzungshash; createMany
        ▼
traffic_events      (organizationId, day) / (organizationId, eventName, day)
        ▼
/admin/auswertungen/website (Server Component) und GET /api/traffic → trafficAuswertung
```

Die Antwort ist **immer 204** — auch wenn nichts gespeichert wurde. Ein Grund
für eine Verwerfung in der Antwort wäre eine Anleitung, die Bereinigung zu
umgehen; `sendBeacon` wertet die Antwort ohnehin nicht aus.

### Ereignisse (fester Wertevorrat, `TrafficEventName`)

| Wert | Ausgelöst in |
|---|---|
| `PAGE_VIEW` | `components/marketing/traffic-messung.tsx` — erstes Laden und jeder Pfadwechsel im öffentlichen Rahmen |
| `CONTACT_PHONE` / `CONTACT_EMAIL` | derselbe Baustein, Klick-Zuhörer am Dokument für jeden `tel:`- bzw. `mailto:`-Link (Kopf- und Fusszeile, Kontakt, FAQ, Buchungsbestätigung, Handlungsaufrufe) |
| `CONTACT_FORM` | `features/public/contact-form.tsx`, nach der Bestätigung des Servers |
| `QUOTE_REQUEST` | `features/public/quote-request-form.tsx`, nach der Bestätigung des Servers |
| `BOOKING_START` | `features/booking/booking-wizard.tsx`, sobald der erste Schritt verlassen ist (einmal je Aufruf) |
| `BOOKING_COMPLETE` | derselbe Assistent, nach erfolgreichem `POST /api/public/bookings` |
| `NEWSLETTER_SIGNUP` | `components/marketing/newsletter-form.tsx`, nach erfolgreicher Anmeldung (Double-Opt-in noch offen) |

## 3. Datenmodell

`TrafficEvent` (`traffic_events`), Domäne „Marketing und Inhalte" in
`docs/DATABASE.md`:

| Spalte | Inhalt |
|---|---|
| `organizationId` | Mandant; jede Abfrage filtert darauf |
| `occurredAt` | Serverzeit (die Uhr des Browsers zählt nicht) |
| `day` | Zürcher Kalendertag (`lib/zuerich.ts`) — Achse aller Auswertungen |
| `path` | bereinigter Pfad, höchstens 300 Zeichen, **nie mit `?`** (Prüfbedingung in der Datenbank) |
| `eventName` | siehe oben |
| `sessionHash` | HMAC-SHA256 hex, **genau 64 Hex-Zeichen** (Prüfbedingung) |
| `landing` | erste Seitenansicht der Tab-Sitzung |
| `referrerHost` | nur beim Einstieg, nur fremder Host, ohne `www.` |
| `utmSource`/`utmMedium`/`utmCampaign` | klein, höchstens 100 Zeichen, ohne `@` |
| `device` | `MOBILE` · `TABLET` · `DESKTOP` |
| `browser` | `CHROME` · `FIREFOX` · `SAFARI` · `EDGE` · `OTHER` |

Migration `prisma/migrations/20260928120000_traffic_analytics` — rein
additiv; die zwei Prüfbedingungen sind von Hand ergänzt und dort begründet.

## 4. Datenschutzentscheide

- **Einwilligung zuerst.** Der Browser sendet nur mit `hasConsent().analytics`;
  ohne Einwilligung entsteht auch keine Sitzungskennung. Wird die Einwilligung
  widerrufen, verwirft der Browser Kennung und Warteschlange. Der Server kann
  eine Einwilligung nicht sehen — das ist eine Grenze des Verfahrens, siehe 6.
- **Global Privacy Control und Do Not Track.** `Sec-GPC: 1` oder `DNT: 1`
  verwerfen jede Meldung auf dem Server; der Browser sendet dann gar nicht erst.
  Das Signal gilt auch dann, wenn im Hinweis „Alle akzeptieren" geklickt wurde:
  Es ist die dauerhafte Einstellung, der Klick eine einzelne Antwort.
- **Keine IP-Adresse.** Sie dient nur als Zählschlüssel des Kontingents im
  Zwischenspeicher (Redis bzw. Prozessspeicher, 60 Sekunden) und wird nie an
  den Dienst gereicht oder geschrieben.
- **Kein User-Agent.** Nur Geräte- und Browserfamilie werden abgeleitet;
  Version, Betriebssystem, Bildschirm, Sprache, Zeitzone werden weder gesendet
  noch gespeichert — zusammen wären sie ein Fingerabdruck.
- **Keine über den Tag hinaus verknüpfbare Kennung.** Der Browser erzeugt je Tab
  eine Zufallskennung (`sessionStorage`, Schlüssel `clenaris-besuch`, stirbt mit
  dem Tab). Gespeichert wird `HMAC(HKDF(JWT_SECRET, Zürcher Tag), Kennung)`:
  gleich innerhalb eines Tages, verschieden über Tage (`lib/traffic/sitzung.ts`).
  Restgrenze: Wer das Servergeheimnis **und** eine rohe Kennung besitzt, kann
  deren Hash für jeden Tag bilden. Rohe Kennungen gibt es nur im Tab.
  Verworfen: ein zufälliges, täglich gelöschtes Salz — stärker, braucht aber
  einen gemeinsamen Speicher, der ohne Redis die Datenbank wäre.
- **Keine Tokens.** `lib/traffic/bereinigen.ts` entfernt Abfrage und Fragment,
  maskiert das Segment nach `/offerte`, `/rechnung`, `/buchung` immer und jedes
  token-artige Segment sonst (über 32 Zeichen ausser sprechenden Slugs, UUID,
  cuid/Hex, Base64-artig, sechs Ziffern am Stück, `@`) als `:token`.
- **Keine Vorschau.** Im CMS-Vorschaumodus wird der Baustein nicht gerendert.

## 5. Aufbewahrung

13 Kalendermonate. `purgeTrafficEvents` läuft im Nachtlauf
(`/api/cron/daily`, Teilaufgabe `besuchsmessung`) und löscht jeden Tag vor
„heute vor 13 Monaten" (`aufbewahrungsgrenze`). Idempotent — ein zweiter Lauf
findet nichts mehr. Die Auswertung lässt höchstens 400 Tage auf einmal zu.

## 6. Grenzen — was die Zahlen nicht sind

- **Untererfassung ist sicher.** Gezählt wird nur, wer der Statistik zustimmt,
  kein GPC/DNT sendet und keinen Werbeblocker hat, der `/api/public/traffic`
  sperrt. Die Zahlen liegen deshalb unter der tatsächlichen Besucherzahl und
  taugen für Vergleiche über die Zeit, nicht als absolute Grösse. Die Seite
  sagt das sichtbar.
- **„Sitzungen" sind keine Personen.** Eine Sitzung ist ein Browser-Tab an
  einem Zürcher Tag. Zwei Tabs sind zwei Sitzungen, eine Sitzung über
  Mitternacht zählt doppelt, dieselbe Person an zwei Tagen ebenfalls.
- **Konversionsrate** = Sitzungen mit mindestens einer Konversion ÷ Sitzungen
  mit Seitenansicht, auf 100 % gekappt.
- Herkunft, UTM, Gerät und Browser werden an den **Einstiegen** gezählt (eine
  Zeile je Sitzung und Tag).
- Eine Navigation, die nur die Abfrage ändert, ist keine neue Seitenansicht.
- iPadOS meldet sich als Mac und zählt als Computer.
- `BOOKING_START` fällt auch in Konto und Portal an, wird dort aber als
  App-Bereich verworfen — die Rate „begonnen → abgeschlossen" gilt für die
  öffentliche Buchung.
- Eine Rolle nur mit `traffic:read` (ohne `report:read`) hätte heute keinen
  Eintrag in der Seitenleiste; alle bestehenden Rollen mit `traffic:read`
  haben beide Rechte.

## 7. Was die Betreiberin prüfen und ergänzen muss

**EXTERNER NACHWEIS ERFORDERLICH** — fachliche bzw. rechtliche Beurteilung
durch die Datenschutzberatung der Betreiberin:

1. Die eingebauten Fassungen von `/legal/datenschutz` und `/legal/cookies`
   beschreiben die Messung (Abschnitt „Beim Besuch der Website" bzw. Kategorie
   „Statistik", Eintrag `clenaris-besuch`). **Ist in `/admin` eine eigene
   Fassung gepflegt, ersetzt sie die eingebaute vollständig** — dann muss der
   Absatz dort von Hand übernommen werden.
2. Ob die Einwilligung für diese Messung erforderlich ist oder ein anderer
   Rechtsgrund trägt, ist eine Beurteilung, die der Code nicht trifft. Er holt
   die Einwilligung vorsorglich ein.
3. Aufbewahrungsfrist 13 Monate — in der Erklärung steht für „Analysedaten"
   14 Monate (Google Analytics); beide Angaben sind mit der tatsächlichen
   Konfiguration abzugleichen.
4. Ob `Sec-GPC` rechtlich als Widerspruch zu behandeln ist, ist offen; der
   Code behandelt es so.

## 8. Rechte und Oberfläche

- Recht `traffic:read` (Gruppe „Übersicht"): Systemverantwortung,
  Administration, Betriebsleitung — dieselben Rollen wie `report:read`.
- Seite `/admin/auswertungen/website`, erreichbar über den Reiter
  „Website-Besuche" auf `/admin/auswertungen` (`features/admin/auswertungen-reiter.tsx`).
  Zeiträume: Heute, 7 Tage, 30 Tage, Monat, Quartal, Jahr, benutzerdefiniert —
  Zürcher Tage (`lib/traffic/zeitraum.ts`).

## 9. Prüfungen

- `tests/api/traffic-rechenkern.test.ts` — Bereinigung, UTM, Referrer,
  Geräte/Browser, Signale, Sitzungshash, Zeiträume, Aufbewahrungsgrenze,
  Wertevorrat gegen `schema.prisma`. Läuft ohne Server.
- `tests/api/traffic.test.ts` — über HTTP, am Bestand der Testdatenbank.
- `tests/pages/smoke.test.ts` — drei Aufrufe der Seite.
