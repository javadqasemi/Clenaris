# API-Referenz

> Diese Datei wird von `npm run openapi` erzeugt. Änderungen bitte in
> `scripts/openapi-routes.ts` und den Zod-Schemas vornehmen — dort steht die
> Quelle, aus der sowohl diese Referenz als auch die Laufzeitvalidierung
> stammen.

Stand: 183 Endpunkte. Die maschinenlesbare Fassung liegt in
[`openapi.yaml`](./openapi.yaml) bzw. [`openapi.json`](./openapi.json).

## Grundlagen

**Umschlag.** Jede JSON-Antwort trägt dieselbe Hülle: bei Erfolg `{ "data": … }`,
bei Listen zusätzlich `{ "meta": { page, pageSize, total, totalPages, hasNext,
hasPrev } }`, im Fehlerfall `{ "error": { "code", "message", "details" } }`.

**Sitzung.** Zwei httpOnly-Cookies: `clenaris_access` (15 Minuten) und
`clenaris_refresh` (30 Tage). Sie sind für JavaScript nicht lesbar. Läuft der
Access-Token ab, erneuert `POST /api/auth/refresh` beide; die Rotation erkennt
die Wiederverwendung eines verbrauchten Tokens und verwirft dann die ganze
Familie.

**Fehlercodes.**

| Status | `code` | Bedeutung |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Eingabe ungültig; `details` nennt Feld und Grund |
| 401 | `UNAUTHORIZED` | keine, abgelaufene oder ungültige Sitzung |
| 403 | `FORBIDDEN` | angemeldet, aber ohne die nötige Berechtigung |
| 404 | `NOT_FOUND` | nicht vorhanden oder für diese Sitzung nicht sichtbar |
| 409 | `CONFLICT` | verstösst gegen eine Eindeutigkeitsregel |
| 422 | `BUSINESS_RULE` | fachlich nicht zulässig |
| 429 | `RATE_LIMITED` | zu viele Anfragen; `Retry-After` in Sekunden |
| 500 | `INTERNAL_ERROR` | unerwarteter Fehler, ohne interne Details |

## Inhalt

- [Authentifizierung](#authentifizierung)
- [Öffentlich](#öffentlich)
- [Dateien](#dateien)
- [CRM](#crm)
- [Nachrichten](#nachrichten)
- [Buchungen](#buchungen)
- [Offerten](#offerten)
- [Einsätze](#einsätze)
- [Künstliche Intelligenz](#künstliche-intelligenz)
- [Personal](#personal)
- [Finanzen](#finanzen)
- [Exporte](#exporte)
- [Inhalte](#inhalte)
- [Katalog](#katalog)
- [Website](#website)
- [System](#system)

## Authentifizierung

### `POST /api/auth/login`

**Anmelden.** Prüft E-Mail und Passwort und setzt Access- und Refresh-Token als httpOnly-Cookies. Die Antwort enthält keine Token — sie stehen ausschliesslich in den Cookies, damit JavaScript im Browser sie nicht auslesen kann.

- **Zugriff:** Öffentlich — keine Anmeldung nötig.
- **Rate-Limit-Klasse:** `login`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `email` | string | ja | email, min. 1 Zeichen, max. 255 Zeichen |
| `password` | string | ja | min. 1 Zeichen |
| `rememberMe` | boolean | – | Standard `false` |

### `POST /api/auth/register`

**Kundenkonto eröffnen.** Legt Benutzerkonto und Kundendatensatz an und meldet direkt an. Die Rolle ist immer CUSTOMER; Mitarbeitendenkonten entstehen ausschliesslich über eine Einladung.

- **Zugriff:** Öffentlich — keine Anmeldung nötig.
- **Rate-Limit-Klasse:** `register`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `firstName` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `lastName` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `email` | string | ja | email, min. 1 Zeichen, max. 255 Zeichen |
| `phone` | union | – | – |
| `password` | string | ja | min. 10 Zeichen, max. 128 Zeichen |
| `confirmPassword` | string | ja | – |
| `locale` | string | – | `DE` \| `EN` \| `FR` \| `IT`, Standard `"DE"` |
| `acceptTerms` | object | ja | – |
| `marketingOptIn` | boolean | – | Standard `false` |
| `website` | union | ja | – |

### `POST /api/auth/logout`

**Abmelden.** Widerruft den Refresh-Token in der Datenbank und löscht beide Cookies. Ein blosses Löschen im Browser würde einen gestohlenen Token weiterleben lassen.

- **Zugriff:** Öffentlich — keine Anmeldung nötig.
- **Erfolg:** 200
- **Mögliche Fehler:** 422, 500

### `POST /api/auth/refresh`

**Sitzung erneuern.** Tauscht den Refresh-Token gegen ein neues Paar. Rotation mit Wiederverwendungs-erkennung: Wird ein bereits verbrauchter Token erneut vorgelegt, gilt die ganze Token-Familie als kompromittiert und wird verworfen.

- **Zugriff:** Öffentlich — keine Anmeldung nötig.
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 422, 500

### `GET /api/auth/session`

**Sitzungsstatus.** Beantwortet „bin ich angemeldet, und wohin gehöre ich?". Existiert, damit die öffentliche Website die Sitzung nicht im Layout lesen muss — ein Cookie-Zugriff dort würde jede Marketingseite dynamisch machen und jeden Besuch zu einer Datenbankabfrage. Die Antwort ist absichtlich mager und wird nicht zwischengespeichert.

- **Zugriff:** Öffentlich — keine Anmeldung nötig.
- **Erfolg:** 200
- **Mögliche Fehler:** 500

### `POST /api/auth/password`

**Passwort zurücksetzen oder Einladung annehmen.** Ein Endpunkt für drei Vorgänge, unterschieden über `action`. `forgot` und `reset` antworten immer erfolgreich — die Antwort darf nicht verraten, ob eine Adresse registriert ist.

- **Zugriff:** Öffentlich — keine Anmeldung nötig.
- **Rate-Limit-Klasse:** `passwordReset`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `action` | string | ja | `forgot` \| `reset` \| `invite` |
| `email` | string | – | – |
| `token` | string | – | – |
| `password` | string | – | – |
| `confirmPassword` | string | – | – |
| `website` | string | – | – |

### `PATCH /api/auth/password`

**Passwort ändern.** Ändert das eigene Passwort. Verlangt das bisherige und widerruft anschliessend alle übrigen Sitzungen — wer sein Passwort ändert, will fremde Geräte ausgesperrt wissen.

- **Zugriff:** Erfordert eine angemeldete Sitzung.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `currentPassword` | string | ja | min. 1 Zeichen |
| `password` | string | ja | min. 10 Zeichen, max. 128 Zeichen |
| `confirmPassword` | string | ja | – |

### `PATCH /api/account/profile`

**Eigene Stammdaten ändern.** Name, Telefon, Sprache, Erscheinungsbild und Benachrichtigungseinstellungen. Die E-Mail-Adresse ist bewusst nicht dabei: ein Wechsel muss über einen Bestätigungslink an die neue Adresse laufen.

- **Zugriff:** Erfordert eine angemeldete Sitzung.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `firstName` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `lastName` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `phone` | union | – | – |
| `locale` | string | – | `DE` \| `EN` \| `FR` \| `IT`, Standard `"DE"` |
| `avatarUrl` | union | ja | – |
| `theme` | string | – | `system` \| `light` \| `dark` |
| `notifyByEmail` | boolean | – | – |
| `notifyBySms` | boolean | – | – |
| `marketingOptIn` | boolean | – | – |

## Öffentlich

### `POST /api/public/pricing/estimate`

**Preis berechnen.** Sofortpreis ohne Anmeldung. Die Berechnung läuft vollständig auf dem Server; die Antwort enthält die vollständige Herleitung, damit die Website jeden Posten benennen kann.

- **Zugriff:** Öffentlich — keine Anmeldung nötig.
- **Rate-Limit-Klasse:** `priceEstimate`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `squareMeters` | integer | – | ≥ 5, ≤ 5000 |
| `rooms` | number | – | ≥ 0.5, ≤ 40 |
| `bathrooms` | integer | – | ≥ 0, ≤ 20 |
| `windows` | integer | – | ≥ 0, ≤ 500 |
| `propertyKind` | string | – | `APARTMENT` \| `HOUSE` \| `OFFICE` \| `COMMERCIAL` \| `INDUSTRIAL` \| `CONSTRUCTION_SITE` \| `PRACTICE` \| `RESTAURANT` \| `SCHOOL` \| `OTHER`, Standard `"APARTMENT"` |
| `frequency` | string | – | `ONCE` \| `WEEKLY` \| `BIWEEKLY` \| `MONTHLY` \| `QUARTERLY` \| `SEMIANNUAL` \| `ANNUAL` \| `CUSTOM`, Standard `"ONCE"` |
| `extras` | object[] | – | max. 20 Einträge, Standard `[]` |
| `extras[].extraId` | string | ja | min. 1 Zeichen |
| `extras[].quantity` | integer | – | ≥ 1, ≤ 50, Standard `1` |
| `scheduledStart` | union | – | – |
| `postalCode` | string | – | – |
| `hasPets` | boolean | – | Standard `false` |
| `manualHours` | number | – | ≥ 0.5, ≤ 80 |
| `couponCode` | string | – | max. 40 Zeichen |
| `urgent` | boolean | – | Standard `false` |
| `serviceId` | string | – | min. 1 Zeichen |
| `serviceSlug` | string | – | min. 1 Zeichen |

### `GET /api/public/availability`

**Freie Zeitfenster eines Tages.** Berücksichtigt Öffnungszeiten, Feiertage, bestehende Einsätze, Abwesenheiten und die benötigte Teamgrösse. Ein Fenster erscheint nur, wenn genügend Personal frei ist.

- **Zugriff:** Öffentlich — keine Anmeldung nötig.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 429, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `serviceId` | string | ja | min. 1 Zeichen |
| `date` | string | ja | – |
| `durationMin` | integer | – | ≥ 30, ≤ 1440 |
| `crewSize` | integer | – | ≥ 1, ≤ 20 |
| `squareMeters` | integer | – | ≥ 5, ≤ 5000 |

### `GET /api/public/service-areas/check`

**Postleitzahl im Einsatzgebiet?.** Antwortet mit Ort, Anfahrtspauschale und Fahrzeit — oder mit der Auskunft, dass wir dort (noch) nicht arbeiten.

- **Zugriff:** Öffentlich — keine Anmeldung nötig.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 429, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `postalCode` | string | ja | – |

### `POST /api/public/bookings`

**Termin buchen.** Erstellt Buchung, Einsatz und — falls nötig — Kundendatensatz in einer Transaktion. Der Preis wird serverseitig neu berechnet; ein mitgeschickter Betrag wird ignoriert.

- **Zugriff:** Öffentlich — keine Anmeldung nötig.
- **Rate-Limit-Klasse:** `bookingCreate`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `serviceId` | string | ja | min. 1 Zeichen |
| `extras` | object[] | – | max. 20 Einträge, Standard `[]` |
| `extras[].extraId` | string | ja | min. 1 Zeichen |
| `extras[].quantity` | integer | – | ≥ 1, ≤ 50, Standard `1` |
| `frequency` | string | – | `ONCE` \| `WEEKLY` \| `BIWEEKLY` \| `MONTHLY` \| `QUARTERLY` \| `SEMIANNUAL` \| `ANNUAL` \| `CUSTOM`, Standard `"ONCE"` |
| `scheduledStart` | union | ja | – |
| `manualHours` | number | – | ≥ 0.5, ≤ 80 |
| `urgent` | boolean | – | Standard `false` |
| `propertyKind` | string | – | `APARTMENT` \| `HOUSE` \| `OFFICE` \| `COMMERCIAL` \| `INDUSTRIAL` \| `CONSTRUCTION_SITE` \| `PRACTICE` \| `RESTAURANT` \| `SCHOOL` \| `OTHER`, Standard `"APARTMENT"` |
| `squareMeters` | integer | – | ≥ 5, ≤ 5000 |
| `rooms` | number | – | ≥ 0.5, ≤ 40 |
| `bathrooms` | integer | – | ≥ 0, ≤ 20 |
| `windows` | integer | – | ≥ 0, ≤ 500 |
| `hasPets` | boolean | – | Standard `false` |
| `propertyId` | string | – | min. 1 Zeichen |
| `firstName` | string | – | min. 2 Zeichen, max. 80 Zeichen |
| `lastName` | string | – | min. 2 Zeichen, max. 80 Zeichen |
| `email` | string | – | email, min. 1 Zeichen, max. 255 Zeichen |
| `phone` | string | – | – |
| `companyName` | string | – | max. 120 Zeichen |
| `addressId` | string | – | min. 1 Zeichen |
| `address` | object | – | – |
| `address.label` | string | – | max. 60 Zeichen |
| `address.street` | string | ja | min. 2 Zeichen, max. 120 Zeichen |
| `address.streetNo` | string | – | max. 20 Zeichen |
| `address.addition` | string | – | max. 120 Zeichen |
| `address.postalCode` | string | ja | – |
| `address.city` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `address.canton` | string | – | Standard `"BE"` |
| `address.country` | string | – | Standard `"CH"` |
| `address.lat` | number | – | ≥ -90, ≤ 90 |
| `address.lng` | number | – | ≥ -180, ≤ 180 |
| `address.placeId` | string | – | max. 200 Zeichen |
| `address.accessNote` | string | – | max. 500 Zeichen |
| `customerNote` | string | – | max. 2000 Zeichen |
| `accessNote` | string | – | max. 500 Zeichen |
| `couponCode` | string | – | max. 40 Zeichen |
| `fileIds` | string[] | – | max. 10 Einträge, Standard `[]` |
| `recurrence` | object | – | – |
| `recurrence.interval` | integer | – | ≥ 1, ≤ 12, Standard `1` |
| `recurrence.weekdays` | integer[] | – | max. 7 Einträge, Standard `[]` |
| `recurrence.endDate` | union | – | – |
| `recurrence.count` | integer | – | ≥ 2, ≤ 104 |
| `acceptTerms` | object | ja | – |
| `website` | union | ja | – |

### `POST /api/public/contact`

**Kontakt- oder Offertanfrage.** Legt einen Lead an und benachrichtigt das Büro. Statt eines CAPTCHAs schützen ein Honeypot-Feld und ein striktes Rate-Limit — beides ohne Hürde für die Anfragenden.

- **Zugriff:** Öffentlich — keine Anmeldung nötig.
- **Rate-Limit-Klasse:** `contactForm`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `firstName` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `lastName` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `email` | string | ja | email, min. 1 Zeichen, max. 255 Zeichen |
| `phone` | union | – | – |
| `company` | string | – | max. 120 Zeichen |
| `postalCode` | string | – | – |
| `city` | string | – | max. 80 Zeichen |
| `serviceKind` | string | – | `OFFICE_CLEANING` \| `MOVE_OUT_CLEANING` \| `RESIDENTIAL_CLEANING` \| `WINDOW_CLEANING` \| `CONSTRUCTION_CLEANING` \| `BUILDING_MAINTENANCE` \| `SPECIAL` |
| `message` | string | ja | min. 10 Zeichen, max. 4000 Zeichen |
| `acceptPrivacy` | object | ja | – |
| `utmSource` | string | – | max. 80 Zeichen |
| `utmMedium` | string | – | max. 80 Zeichen |
| `utmCampaign` | string | – | max. 120 Zeichen |
| `referrerUrl` | string | – | max. 500 Zeichen |
| `landingPath` | string | – | max. 300 Zeichen |
| `website` | union | ja | – |

### `POST /api/public/newsletter`

**Newsletter abonnieren.** Double-Opt-in: die Anmeldung gilt erst mit Bestätigung des Links in der E-Mail. Die Einwilligung wird mit Zeitpunkt und IP protokolliert (DSGVO Art. 7 Abs. 1).

- **Zugriff:** Öffentlich — keine Anmeldung nötig.
- **Rate-Limit-Klasse:** `newsletter`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `email` | string | ja | email, min. 1 Zeichen, max. 255 Zeichen |
| `firstName` | string | – | max. 80 Zeichen |
| `locale` | string | – | `DE` \| `EN` \| `FR` \| `IT`, Standard `"DE"` |
| `source` | string | – | max. 80 Zeichen |
| `website` | union | ja | – |

### `POST /api/public/applications`

**Auf eine Stelle bewerben.** Der Lebenslauf wird vorab direkt zu Supabase Storage geladen; hier kommt nur seine Adresse an.

- **Zugriff:** Öffentlich — keine Anmeldung nötig.
- **Rate-Limit-Klasse:** `contactForm`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `postingId` | string | ja | min. 1 Zeichen |
| `firstName` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `lastName` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `email` | string | ja | email, min. 1 Zeichen, max. 255 Zeichen |
| `phone` | string | ja | – |
| `message` | string | – | max. 4000 Zeichen |
| `cvFileId` | string | – | min. 1 Zeichen |
| `availableFrom` | string | – | – |
| `acceptPrivacy` | object | ja | – |
| `website` | union | ja | – |
| `cvUrl` | string | – | uri |

### `POST /api/public/ai/chat`

**Chat-Assistent.** Beantwortet Fragen zu Leistungen, Preisen und Gebiet. Die Antwort wird als Server-Sent-Events gestreamt. Der Assistent nennt nur Preise aus dem Katalog und bucht nichts — gebucht wird über das Formular.

- **Zugriff:** Öffentlich — keine Anmeldung nötig.
- **Rate-Limit-Klasse:** `aiChat`
- **Erfolg:** 200 (`text/event-stream`)
- **Mögliche Fehler:** 400, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `message` | string | ja | min. 1 Zeichen, max. 500 Zeichen |
| `history` | object[] | – | max. 8 Einträge, Standard `[]` |
| `history[].role` | string | ja | `user` \| `assistant` |
| `history[].content` | string | ja | max. 4000 Zeichen |

### `GET /api/public/quotes/{token}/pdf`

**Offerte als PDF.** Zugriff über den Magic-Link-Token aus der Offerten-E-Mail, ohne Anmeldung.

- **Zugriff:** Öffentlich — keine Anmeldung nötig.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200 (`application/pdf`)
- **Mögliche Fehler:** 400, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `token` | string | ja | min. 10 Zeichen |

### `POST /api/public/quotes/{token}/respond`

**Offerte annehmen oder ablehnen.** Bei Annahme werden Unterschrift, Name, IP und Zeitpunkt festgehalten — das ist der Nachweis des Vertragsschlusses.

- **Zugriff:** Öffentlich — keine Anmeldung nötig.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `token` | string | ja | min. 10 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `decision` | string | ja | `ACCEPT` \| `REJECT` |
| `signatureDataUrl` | string | – | max. 500000 Zeichen |
| `signatureName` | string | – | max. 120 Zeichen |
| `reason` | string | – | max. 1000 Zeichen |

### `GET /api/public/invoices/{token}/pdf`

**Rechnung als PDF.** Enthält den Schweizer QR-Einzahlungsschein nach SIX-Norm v2.3.

- **Zugriff:** Öffentlich — keine Anmeldung nötig.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200 (`application/pdf`)
- **Mögliche Fehler:** 400, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `token` | string | ja | min. 10 Zeichen |

### `POST /api/public/invoices/{token}/pay`

**Online-Zahlung starten.** Erstellt eine Stripe-Checkout-Session für Karte oder TWINT und liefert die Adresse zur Weiterleitung. Der Betrag stammt aus der Datenbank, nie vom Client. Gebucht wird der Eingang über den Webhook, nicht über die Rückkehr-URL.

- **Zugriff:** Öffentlich — keine Anmeldung nötig.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `token` | string | ja | min. 10 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `method` | string | – | `CARD` \| `TWINT`, Standard `"CARD"` |

## Dateien

### `POST /api/files/upload-url`

**Signierte Upload-Adresse anfordern.** Dateien laufen nicht durch die Applikation, sondern direkt zu Supabase Storage. Das umgeht das 4.5-MB-Limit für Function-Bodies. Ohne Anmeldung sind nur die Profile `bookingPhoto` und `cv` erlaubt.

- **Zugriff:** Öffentlich — keine Anmeldung nötig.
- **Rate-Limit-Klasse:** `fileUpload`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `profile` | string | ja | `jobPhoto` \| `bookingPhoto` \| `avatar` \| `document` \| `receipt` \| `cv` \| `gallery` \| `invoice` \| `quote` |
| `filename` | string | ja | min. 1 Zeichen, max. 255 Zeichen |
| `mimeType` | string | ja | min. 3 Zeichen, max. 120 Zeichen |
| `sizeBytes` | integer | ja | ≥ 1, ≤ 52428800 |
| `scopeId` | string | – | max. 60 Zeichen |

## CRM

### `GET /api/leads`

**Anfragen auflisten.** Sortiert nach Bewertung und Eingang, mit Filter nach Status und Zuständigkeit.

- **Zugriff:** Erfordert die Berechtigung: `lead:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 429, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `page` | integer | – | ≥ 1, Standard `1` |
| `pageSize` | integer | – | ≥ 1, ≤ 100, Standard `20` |
| `q` | string | – | max. 120 Zeichen |
| `sort` | string | – | max. 60 Zeichen |
| `order` | string | – | `asc` \| `desc`, Standard `"desc"` |
| `status` | string | – | `NEW` \| `CONTACTED` \| `QUALIFIED` \| `PROPOSAL` \| `WON` \| `LOST` |
| `ownerId` | string | – | min. 1 Zeichen |

### `POST /api/leads`

**Anfrage erfassen.** Für Anrufe und Laufkundschaft. Anfragen über die Website laufen über `/api/public/contact` und durchlaufen dort Honeypot und strengeres Rate-Limiting.

- **Zugriff:** Erfordert die Berechtigung: `lead:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `firstName` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `lastName` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `email` | string | ja | email, min. 1 Zeichen, max. 255 Zeichen |
| `phone` | union | – | – |
| `company` | string | – | max. 120 Zeichen |
| `street` | string | – | max. 120 Zeichen |
| `postalCode` | string | – | – |
| `city` | string | – | max. 80 Zeichen |
| `serviceKind` | string | – | `OFFICE_CLEANING` \| `MOVE_OUT_CLEANING` \| `RESIDENTIAL_CLEANING` \| `WINDOW_CLEANING` \| `CONSTRUCTION_CLEANING` \| `BUILDING_MAINTENANCE` \| `SPECIAL` |
| `message` | string | – | max. 4000 Zeichen |
| `estimatedValue` | number | – | ≥ 0, ≤ 1000000 |
| `source` | string | – | `WEBSITE` \| `PHONE` \| `EMAIL` \| `REFERRAL` \| `GOOGLE_ADS` \| `META_ADS` \| `SEO` \| `WALK_IN` \| `PARTNER` \| `OTHER`, Standard `"WEBSITE"` |
| `stageId` | string | – | min. 1 Zeichen |
| `ownerId` | string | – | min. 1 Zeichen |
| `nextFollowUpAt` | string | – | date-time |
| `tagIds` | string[] | – | max. 20 Einträge, Standard `[]` |

### `PATCH /api/leads/{id}`

**Anfrage ändern.** Status, Zuständigkeit, Pipeline-Stufe, Bewertung, Nachfassdatum, Etiketten.

- **Zugriff:** Erfordert die Berechtigung: `lead:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `firstName` | string | – | min. 2 Zeichen, max. 80 Zeichen |
| `lastName` | string | – | min. 2 Zeichen, max. 80 Zeichen |
| `email` | string | – | email, min. 1 Zeichen, max. 255 Zeichen |
| `phone` | union | – | – |
| `company` | string | – | max. 120 Zeichen |
| `street` | string | – | max. 120 Zeichen |
| `postalCode` | string | – | – |
| `city` | string | – | max. 80 Zeichen |
| `serviceKind` | string | – | `OFFICE_CLEANING` \| `MOVE_OUT_CLEANING` \| `RESIDENTIAL_CLEANING` \| `WINDOW_CLEANING` \| `CONSTRUCTION_CLEANING` \| `BUILDING_MAINTENANCE` \| `SPECIAL` |
| `message` | string | – | max. 4000 Zeichen |
| `estimatedValue` | number | – | ≥ 0, ≤ 1000000 |
| `source` | string | – | `WEBSITE` \| `PHONE` \| `EMAIL` \| `REFERRAL` \| `GOOGLE_ADS` \| `META_ADS` \| `SEO` \| `WALK_IN` \| `PARTNER` \| `OTHER`, Standard `"WEBSITE"` |
| `stageId` | string | – | min. 1 Zeichen |
| `ownerId` | string | – | min. 1 Zeichen |
| `nextFollowUpAt` | string | – | date-time |
| `tagIds` | string[] | – | max. 20 Einträge, Standard `[]` |
| `status` | string | – | `NEW` \| `CONTACTED` \| `QUALIFIED` \| `PROPOSAL` \| `WON` \| `LOST` |
| `lostReason` | string | – | max. 500 Zeichen |
| `score` | integer | – | ≥ 0, ≤ 100 |

### `POST /api/leads/{id}/convert`

**Anfrage in Kundschaft überführen.** Übernimmt Stammdaten und Verlauf und markiert den Lead als gewonnen. Bestehende Offerten werden mit übertragen.

- **Zugriff:** Erfordert die Berechtigung: `customer:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 404, 409, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/customers`

**Kundschaft auflisten.** Volltextsuche über Nummer, Name, Firma, E-Mail und Telefon.

- **Zugriff:** Erfordert die Berechtigung: `customer:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 429, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `page` | integer | – | ≥ 1, Standard `1` |
| `pageSize` | integer | – | ≥ 1, ≤ 100, Standard `20` |
| `q` | string | – | max. 120 Zeichen |
| `sort` | string | – | max. 60 Zeichen |
| `order` | string | – | `asc` \| `desc`, Standard `"desc"` |
| `type` | string | – | `PRIVATE` \| `BUSINESS` |

### `POST /api/customers`

**Kundendatensatz anlegen.** Legt auf Wunsch gleich das Kundenkonto an und versendet die Einladung. Doppelte E-Mail-Adressen werden mit 409 abgewiesen.

- **Zugriff:** Erfordert die Berechtigung: `customer:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `type` | string | – | `PRIVATE` \| `BUSINESS`, Standard `"PRIVATE"` |
| `companyName` | string | – | max. 140 Zeichen |
| `firstName` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `lastName` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `email` | string | ja | email, min. 1 Zeichen, max. 255 Zeichen |
| `phone` | union | – | – |
| `mobile` | union | – | – |
| `vatNumber` | string | – | max. 40 Zeichen |
| `language` | string | – | `DE` \| `EN` \| `FR` \| `IT`, Standard `"DE"` |
| `birthday` | string | – | – |
| `notes` | string | – | max. 4000 Zeichen |
| `internalNotes` | string | – | max. 4000 Zeichen |
| `paymentTermDays` | integer | – | ≥ 0, ≤ 180, Standard `30` |
| `discountPercent` | number | – | ≥ 0, ≤ 100, Standard `0` |
| `creditLimit` | number | – | ≥ 0, ≤ 1000000 |
| `taxExempt` | boolean | – | Standard `false` |
| `tagIds` | string[] | – | max. 20 Einträge, Standard `[]` |
| `address` | object | – | – |
| `address.label` | string | – | max. 60 Zeichen |
| `address.street` | string | ja | min. 2 Zeichen, max. 120 Zeichen |
| `address.streetNo` | string | – | max. 20 Zeichen |
| `address.addition` | string | – | max. 120 Zeichen |
| `address.postalCode` | string | ja | – |
| `address.city` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `address.canton` | string | – | Standard `"BE"` |
| `address.country` | string | – | Standard `"CH"` |
| `address.lat` | number | – | ≥ -90, ≤ 90 |
| `address.lng` | number | – | ≥ -180, ≤ 180 |
| `address.placeId` | string | – | max. 200 Zeichen |
| `address.accessNote` | string | – | max. 500 Zeichen |
| `createLogin` | boolean | – | Standard `false` |

### `POST /api/activities`

**Verlaufseintrag erfassen.** Notiz, Telefonat, E-Mail, Termin oder SMS an Kundschaft, Lead oder Einsatz.

- **Zugriff:** Erfordert die Berechtigung: `activity:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `type` | string | – | `NOTE` \| `CALL` \| `EMAIL` \| `SMS` \| `MEETING` \| `TASK` \| `FILE_UPLOAD`, Standard `"NOTE"` |
| `subject` | string | ja | min. 2 Zeichen, max. 200 Zeichen |
| `body` | string | – | max. 8000 Zeichen |
| `durationMinutes` | integer | – | ≥ 0, ≤ 1440 |
| `occurredAt` | string | – | date-time |
| `customerId` | string | – | min. 1 Zeichen |
| `leadId` | string | – | min. 1 Zeichen |
| `jobId` | string | – | min. 1 Zeichen |
| `bookingId` | string | – | min. 1 Zeichen |
| `quoteId` | string | – | min. 1 Zeichen |
| `invoiceId` | string | – | min. 1 Zeichen |

### `GET /api/tasks`

**Offene Aufgaben.** Mitarbeitende sehen ausschliesslich die eigenen — die Einschränkung greift in der Abfrage, nicht im Frontend.

- **Zugriff:** Erfordert die Berechtigung: `task:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 429, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `page` | integer | – | ≥ 1, Standard `1` |
| `pageSize` | integer | – | ≥ 1, ≤ 100, Standard `20` |
| `q` | string | – | max. 120 Zeichen |
| `sort` | string | – | max. 60 Zeichen |
| `order` | string | – | `asc` \| `desc`, Standard `"desc"` |

### `POST /api/tasks`

**Aufgabe anlegen.** Wer eine Aufgabe zugewiesen bekommt, wird sofort benachrichtigt.

- **Zugriff:** Erfordert die Berechtigung: `task:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `title` | string | ja | min. 3 Zeichen, max. 200 Zeichen |
| `description` | string | – | max. 4000 Zeichen |
| `priority` | string | – | `LOW` \| `NORMAL` \| `HIGH` \| `URGENT`, Standard `"NORMAL"` |
| `dueAt` | string | – | date-time |
| `reminderAt` | string | – | date-time |
| `assigneeId` | string | – | min. 1 Zeichen |
| `customerId` | string | – | min. 1 Zeichen |
| `leadId` | string | – | min. 1 Zeichen |
| `jobId` | string | – | min. 1 Zeichen |

### `PATCH /api/tasks/{id}`

**Aufgabe ändern.** Status, Fälligkeit, Zuständigkeit und Beschreibung.

- **Zugriff:** Erfordert die Berechtigung: `task:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `title` | string | – | min. 3 Zeichen, max. 200 Zeichen |
| `description` | string | – | max. 4000 Zeichen |
| `priority` | string | – | `LOW` \| `NORMAL` \| `HIGH` \| `URGENT`, Standard `"NORMAL"` |
| `dueAt` | string | – | date-time |
| `reminderAt` | string | – | date-time |
| `assigneeId` | string | – | min. 1 Zeichen |
| `customerId` | string | – | min. 1 Zeichen |
| `leadId` | string | – | min. 1 Zeichen |
| `jobId` | string | – | min. 1 Zeichen |
| `status` | string | – | `OPEN` \| `IN_PROGRESS` \| `DONE` \| `CANCELLED` |

### `DELETE /api/customers/{id}`

**Kundschaft in den Papierkorb legen.** Offene Rechnungen und geplante Termine verhindern das Löschen — die Antwort nennt die Zahl. Weich gelöscht: der Datensatz verschwindet aus allen Listen, bleibt aber wiederherstellbar. Verknüpfte Datensätze werden nicht mitgelöscht.

- **Zugriff:** Erfordert die Berechtigung: `customer:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/customers/{id}/restore`

**Kundschaft wiederherstellen.** Holt den Datensatz aus dem Papierkorb zurück.

- **Zugriff:** Erfordert die Berechtigung: `customer:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `DELETE /api/leads/{id}`

**Anfrage in den Papierkorb legen.** Eine in eine Kundschaft überführte Anfrage bleibt als Herkunftsnachweis erhalten. Weich gelöscht: der Datensatz verschwindet aus allen Listen, bleibt aber wiederherstellbar. Verknüpfte Datensätze werden nicht mitgelöscht.

- **Zugriff:** Erfordert die Berechtigung: `lead:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/leads/{id}/restore`

**Anfrage wiederherstellen.** Holt den Datensatz aus dem Papierkorb zurück.

- **Zugriff:** Erfordert die Berechtigung: `lead:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `DELETE /api/properties/{id}`

**Objekt in den Papierkorb legen.** Objekte mit geplanten Einsätzen bleiben erhalten. Weich gelöscht: der Datensatz verschwindet aus allen Listen, bleibt aber wiederherstellbar. Verknüpfte Datensätze werden nicht mitgelöscht.

- **Zugriff:** Erfordert die Berechtigung: `property:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/properties/{id}/restore`

**Objekt wiederherstellen.** Holt den Datensatz aus dem Papierkorb zurück.

- **Zugriff:** Erfordert die Berechtigung: `property:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/customers/{id}`

**Kundenakte abrufen.** Stammdaten, Adressen, Objekte, Buchungen, Rechnungen und Zeitachse.

- **Zugriff:** Erfordert die Berechtigung: `customer:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `PATCH /api/customers/{id}`

**Kundenakte ändern.** Stammdaten, Konditionen und interne Notizen.

- **Zugriff:** Erfordert die Berechtigung: `customer:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `type` | string | – | `PRIVATE` \| `BUSINESS` |
| `companyName` | string | – | max. 140 Zeichen |
| `firstName` | string | – | min. 2 Zeichen, max. 80 Zeichen |
| `lastName` | string | – | min. 2 Zeichen, max. 80 Zeichen |
| `email` | string | – | email, min. 1 Zeichen, max. 255 Zeichen |
| `phone` | union | – | – |
| `mobile` | union | – | – |
| `vatNumber` | string | – | max. 40 Zeichen |
| `language` | string | – | `DE` \| `EN` \| `FR` \| `IT`, Standard `"DE"` |
| `birthday` | string | – | – |
| `notes` | string | – | max. 4000 Zeichen |
| `internalNotes` | string | – | max. 4000 Zeichen |
| `paymentTermDays` | integer | – | ≥ 0, ≤ 180 |
| `discountPercent` | number | – | ≥ 0, ≤ 100 |
| `creditLimit` | number | – | ≥ 0, ≤ 1000000 |
| `taxExempt` | boolean | – | – |
| `blocked` | boolean | – | – |
| `blockedReason` | string | – | max. 500 Zeichen |
| `tagIds` | string[] | – | max. 20 Einträge |

## Nachrichten

### `GET /api/messages`

**Verläufe auflisten.** Kundschaft sieht nur die eigenen Verläufe, das Büro alle. Die Einschränkung ergibt sich aus der Rolle, nicht aus einem Query-Parameter.

- **Zugriff:** Erfordert eine der Berechtigungen: `message:read`, `message:read_own`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 429, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `status` | string | – | `open` \| `closed` \| `all`, Standard `"open"` |

### `POST /api/messages`

**Verlauf eröffnen.** Der Verlauf wird immer an einen Kundendatensatz gebunden.

- **Zugriff:** Erfordert eine der Berechtigungen: `message:write`, `message:write_own`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `subject` | string | ja | min. 3 Zeichen, max. 160 Zeichen |
| `body` | string | ja | min. 5 Zeichen, max. 5000 Zeichen |
| `bookingId` | string | – | min. 1 Zeichen |
| `jobId` | string | – | min. 1 Zeichen |

### `GET /api/messages/{id}`

**Verlauf lesen.** Markiert beim Lesen die Nachrichten der Gegenseite als gelesen — nie die eigenen.

- **Zugriff:** Erfordert eine der Berechtigungen: `message:read`, `message:read_own`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/messages/{id}`

**Antworten.** Ein abgeschlossener Verlauf nimmt keine Antworten mehr an. Nur Mitarbeitende dürfen mit `close` abschliessen.

- **Zugriff:** Erfordert eine der Berechtigungen: `message:write`, `message:write_own`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 404, 409, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `body` | string | ja | min. 1 Zeichen, max. 5000 Zeichen |
| `fileIds` | string[] | – | max. 5 Einträge |
| `close` | boolean | – | – |

### `GET /api/notifications`

**Eigene Benachrichtigungen.** Die letzten 50 In-App-Meldungen, neueste zuerst.

- **Zugriff:** Erfordert die Berechtigung: `notification:read_own`.
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 500

### `GET /api/notifications/count`

**Anzahl ungelesener Meldungen.** Speist die Glocke im Kopfbereich; bewusst schlank gehalten.

- **Zugriff:** Erfordert die Berechtigung: `notification:read_own`.
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 500

### `POST /api/notifications/{id}/read`

**Meldung als gelesen markieren.** Wirkt nur auf eigene Meldungen.

- **Zugriff:** Erfordert die Berechtigung: `notification:read_own`.
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/notifications/read-all`

**Alle Meldungen als gelesen markieren.** Setzt den Zähler auf null.

- **Zugriff:** Erfordert die Berechtigung: `notification:read_own`.
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 422, 500

## Buchungen

### `POST /api/bookings/{id}/confirm`

**Buchung bestätigen.** Bestätigt den Termin, erzeugt den Einsatz und versendet die Bestätigung an die Kundschaft.

- **Zugriff:** Erfordert die Berechtigung: `booking:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/bookings/{id}/reschedule`

**Termin verschieben.** Prüft die Verfügbarkeit erneut und verschiebt den zugehörigen Einsatz mit.

- **Zugriff:** Erfordert die Berechtigung: `booking:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `scheduledStart` | union | ja | – |
| `reason` | string | – | max. 500 Zeichen |

### `POST /api/bookings/{id}/cancel`

**Buchung stornieren.** Storniert Buchung und Einsatz. Ab 24 Stunden vor Beginn fällt gemäss AGB eine Ausfallentschädigung an; der Endpunkt berechnet sie, verrechnet sie aber nicht selbst.

- **Zugriff:** Erfordert die Berechtigung: `booking:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `reason` | string | ja | min. 3 Zeichen, max. 500 Zeichen |

### `POST /api/bookings/{id}/invoice`

**Rechnung zur Buchung erstellen.** Übernimmt die Positionen der Buchung als Rechnungsentwurf.

- **Zugriff:** Erfordert die Berechtigung: `invoice:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 404, 409, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/account/bookings/{id}/reschedule`

**Eigenen Termin verschieben.** Für die Kundschaft. Bis 24 Stunden vor Beginn kostenlos; danach verweist die Antwort auf den telefonischen Weg.

- **Zugriff:** Erfordert die Berechtigung: `booking:write_own`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `scheduledStart` | union | ja | – |
| `reason` | string | – | max. 500 Zeichen |

### `POST /api/account/bookings/{id}/cancel`

**Eigenen Termin absagen.** Für die Kundschaft, mit denselben Fristen wie beim Verschieben.

- **Zugriff:** Erfordert die Berechtigung: `booking:write_own`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `reason` | string | ja | min. 3 Zeichen, max. 500 Zeichen |

### `DELETE /api/bookings/{id}`

**Buchung in den Papierkorb legen.** Eine bereits verrechnete Buchung bleibt erhalten. Weich gelöscht: der Datensatz verschwindet aus allen Listen, bleibt aber wiederherstellbar. Verknüpfte Datensätze werden nicht mitgelöscht.

- **Zugriff:** Erfordert die Berechtigung: `booking:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/bookings/{id}/restore`

**Buchung wiederherstellen.** Holt den Datensatz aus dem Papierkorb zurück.

- **Zugriff:** Erfordert die Berechtigung: `booking:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

## Offerten

### `GET /api/quotes`

**Offerten auflisten.** Mit Suche über Nummer, Titel und Empfänger.

- **Zugriff:** Erfordert die Berechtigung: `quote:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 429, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `page` | integer | – | ≥ 1, Standard `1` |
| `pageSize` | integer | – | ≥ 1, ≤ 100, Standard `20` |
| `q` | string | – | max. 120 Zeichen |
| `sort` | string | – | max. 60 Zeichen |
| `order` | string | – | `asc` \| `desc`, Standard `"desc"` |

### `POST /api/quotes`

**Offerte erstellen.** Die Summen werden serverseitig berechnet; optionale Positionen zählen nicht ins Total.

- **Zugriff:** Erfordert die Berechtigung: `quote:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `customerId` | string | – | min. 1 Zeichen |
| `leadId` | string | – | min. 1 Zeichen |
| `propertyId` | string | – | min. 1 Zeichen |
| `title` | string | ja | min. 3 Zeichen, max. 200 Zeichen |
| `validUntil` | string | ja | – |
| `introText` | string | – | max. 4000 Zeichen |
| `outroText` | string | – | max. 4000 Zeichen |
| `terms` | string | – | max. 8000 Zeichen |
| `internalNote` | string | – | max. 4000 Zeichen |
| `discountType` | string | – | `PERCENT` \| `FIXED` |
| `discountValue` | number | – | ≥ 0, ≤ 1000000, Standard `0` |
| `items` | object[] | ja | min. 1 Einträge, max. 100 Einträge |
| `items[].id` | string | – | min. 1 Zeichen |
| `items[].serviceId` | string | – | min. 1 Zeichen |
| `items[].name` | string | ja | min. 2 Zeichen, max. 200 Zeichen |
| `items[].description` | string | – | max. 2000 Zeichen |
| `items[].quantity` | number | ja | ≥ 0.01, ≤ 10000 |
| `items[].unit` | string | – | max. 20 Zeichen, Standard `"Std."` |
| `items[].unitPrice` | number | ja | ≥ 0, ≤ 9999999 |
| `items[].discount` | number | – | ≥ 0, ≤ 100, Standard `0` |
| `items[].vatRate` | number | – | ≥ 0, ≤ 30, Standard `8.1` |
| `items[].optional` | boolean | – | Standard `false` |

### `GET /api/quotes/{id}`

**Offerte lesen.** Mit Positionen, Empfänger, Objekt, Dateien und Verlauf.

- **Zugriff:** Erfordert die Berechtigung: `quote:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `PATCH /api/quotes/{id}`

**Offerte ändern.** Nur Entwürfe und versendete Offerten. Eine angenommene Offerte ist Vertragsgrundlage und wird nicht mehr verändert, sondern dupliziert.

- **Zugriff:** Erfordert die Berechtigung: `quote:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `customerId` | string | – | min. 1 Zeichen |
| `leadId` | string | – | min. 1 Zeichen |
| `propertyId` | string | – | min. 1 Zeichen |
| `title` | string | – | min. 3 Zeichen, max. 200 Zeichen |
| `validUntil` | string | – | – |
| `introText` | string | – | max. 4000 Zeichen |
| `outroText` | string | – | max. 4000 Zeichen |
| `terms` | string | – | max. 8000 Zeichen |
| `internalNote` | string | – | max. 4000 Zeichen |
| `discountType` | string | – | `PERCENT` \| `FIXED` |
| `discountValue` | number | – | ≥ 0, ≤ 1000000, Standard `0` |
| `items` | object[] | – | min. 1 Einträge, max. 100 Einträge |
| `items[].id` | string | – | min. 1 Zeichen |
| `items[].serviceId` | string | – | min. 1 Zeichen |
| `items[].name` | string | ja | min. 2 Zeichen, max. 200 Zeichen |
| `items[].description` | string | – | max. 2000 Zeichen |
| `items[].quantity` | number | ja | ≥ 0.01, ≤ 10000 |
| `items[].unit` | string | – | max. 20 Zeichen, Standard `"Std."` |
| `items[].unitPrice` | number | ja | ≥ 0, ≤ 9999999 |
| `items[].discount` | number | – | ≥ 0, ≤ 100, Standard `0` |
| `items[].vatRate` | number | – | ≥ 0, ≤ 30, Standard `8.1` |
| `items[].optional` | boolean | – | Standard `false` |

### `POST /api/quotes/{id}/send`

**Offerte versenden.** Versendet die Offerte als PDF mit Magic Link zur Online-Annahme und setzt den Status auf SENT.

- **Zugriff:** Erfordert die Berechtigung: `quote:send`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `email` | string | – | email |
| `subject` | string | – | max. 200 Zeichen |
| `message` | string | – | max. 4000 Zeichen |
| `attachPdf` | boolean | – | Standard `true` |

### `POST /api/quotes/{id}/duplicate`

**Offerte duplizieren.** Der übliche Weg, eine bereits beantwortete Offerte anzupassen: die alte bleibt als Beleg bestehen.

- **Zugriff:** Erfordert die Berechtigung: `quote:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 404, 409, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/quotes/{id}/convert`

**Offerte in Buchung oder Rechnung überführen.** Setzt den Status auf CONVERTED und verknüpft das Ergebnis mit der Offerte.

- **Zugriff:** Erfordert die Berechtigung: `quote:convert`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 404, 409, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `target` | string | ja | `BOOKING` \| `INVOICE` |
| `scheduledStart` | string | – | date-time |
| `addressId` | string | – | min. 1 Zeichen |

### `GET /api/quotes/{id}/pdf`

**Offerte als PDF.** Kundschaft erhält nur die eigenen Offerten.

- **Zugriff:** Erfordert eine der Berechtigungen: `quote:read`, `quote:read_own`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200 (`application/pdf`)
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `DELETE /api/quotes/{id}`

**Offerte in den Papierkorb legen.** Eine angenommene Offerte ist eine vertragliche Zusage und bleibt erhalten. Weich gelöscht: der Datensatz verschwindet aus allen Listen, bleibt aber wiederherstellbar. Verknüpfte Datensätze werden nicht mitgelöscht.

- **Zugriff:** Erfordert die Berechtigung: `quote:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/quotes/{id}/restore`

**Offerte wiederherstellen.** Holt den Datensatz aus dem Papierkorb zurück.

- **Zugriff:** Erfordert die Berechtigung: `quote:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

## Einsätze

### `GET /api/jobs/calendar`

**Einsätze im Zeitraum.** Speist Dispositions- und Mitarbeiterkalender. Mitarbeitende erhalten ausschliesslich die eigenen Einsätze.

- **Zugriff:** Erfordert eine der Berechtigungen: `job:read`, `job:read_assigned`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 429, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `from` | string | ja | date-time |
| `to` | string | ja | date-time |
| `employeeId` | string | – | min. 1 Zeichen |

### `GET /api/jobs/{id}`

**Einsatz lesen.** Mit Checkliste, Fotos, Zeiten, Material und Zuteilung.

- **Zugriff:** Erfordert eine der Berechtigungen: `job:read`, `job:read_assigned`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `PATCH /api/jobs/{id}`

**Einsatz ändern.** Titel, Beschreibung, Notizen, Status und geplante Dauer.

- **Zugriff:** Erfordert die Berechtigung: `job:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `title` | string | – | min. 3 Zeichen, max. 200 Zeichen |
| `status` | string | – | `UNASSIGNED` \| `SCHEDULED` \| `DISPATCHED` \| `EN_ROUTE` \| `IN_PROGRESS` \| `ON_HOLD` \| `COMPLETED` \| `VERIFIED` \| `CANCELLED` |
| `scheduledStart` | string | – | date-time |
| `scheduledEnd` | string | – | date-time |
| `crewSize` | integer | – | ≥ 1, ≤ 20 |
| `estimatedMin` | integer | – | ≥ 15, ≤ 1440 |
| `travelMin` | integer | – | ≥ 0, ≤ 480 |
| `description` | string | – | max. 4000 Zeichen |
| `internalNote` | string | – | max. 4000 Zeichen |
| `customerNote` | string | – | max. 4000 Zeichen |
| `color` | string | – | – |

### `POST /api/jobs/{id}/assign`

**Personal zuteilen.** Prüft Überschneidungen und Abwesenheiten und benachrichtigt die zugeteilten Personen.

- **Zugriff:** Erfordert die Berechtigung: `job:assign`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `employeeIds` | string[] | ja | min. 1 Einträge, max. 20 Einträge |
| `role` | string | – | `LEAD` \| `MEMBER` \| `TRAINEE` \| `SUPERVISOR`, Standard `"MEMBER"` |
| `notify` | boolean | – | Standard `true` |

### `POST /api/jobs/{id}/move`

**Einsatz verschieben.** Gegenstück zum Ziehen im Dispositionskalender.

- **Zugriff:** Erfordert die Berechtigung: `job:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `scheduledStart` | string | ja | date-time |
| `scheduledEnd` | string | ja | date-time |
| `employeeId` | string | – | min. 1 Zeichen |

### `POST /api/jobs/{id}/complete`

**Einsatz abschliessen.** Erfasst Abschlussbericht, Materialverbrauch und die Unterschrift der Kundschaft und stoppt laufende Zeiterfassungen.

- **Zugriff:** Erfordert eine der Berechtigungen: `job:complete_assigned`, `job:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `completionNote` | string | – | max. 4000 Zeichen |
| `signatureDataUrl` | string | – | max. 500000 Zeichen |
| `signatureName` | string | – | max. 120 Zeichen |
| `materials` | object[] | – | max. 50 Einträge, Standard `[]` |
| `materials[].name` | string | ja | min. 2 Zeichen, max. 120 Zeichen |
| `materials[].sku` | string | – | max. 60 Zeichen |
| `materials[].quantity` | number | ja | ≥ 0.01, ≤ 10000 |
| `materials[].unit` | string | – | max. 20 Zeichen, Standard `"Stk."` |
| `materials[].unitCost` | number | – | ≥ 0, ≤ 9999999, Standard `0` |
| `materials[].billable` | boolean | – | Standard `false` |

### `POST /api/jobs/{id}/photos`

**Foto verknüpfen.** Registriert ein bereits zu Supabase geladenes Bild als Vorher-, Nachher- oder Schadensfoto.

- **Zugriff:** Erfordert eine der Berechtigungen: `job:complete_assigned`, `job:write`.
- **Rate-Limit-Klasse:** `fileUpload`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 404, 409, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `type` | string | – | `BEFORE` \| `AFTER` \| `DAMAGE` \| `DOCUMENT` \| `OTHER`, Standard `"BEFORE"` |
| `url` | string | ja | uri |
| `thumbnailUrl` | string | – | uri |
| `caption` | string | – | max. 300 Zeichen |
| `room` | string | – | max. 80 Zeichen |
| `lat` | number | – | ≥ -90, ≤ 90 |
| `lng` | number | – | ≥ -180, ≤ 180 |

### `POST /api/jobs/checklist/{id}`

**Checklistenpunkt abhaken.** Hält fest, wer wann abgehakt hat.

- **Zugriff:** Erfordert eine der Berechtigungen: `job:complete_assigned`, `job:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `done` | boolean | ja | – |
| `note` | string | – | max. 500 Zeichen |

### `GET /api/jobs/{id}/report`

**Einsatzbericht als PDF.** Mit Checkliste, Vorher-Nachher-Fotos und Unterschrift.

- **Zugriff:** Erfordert die Berechtigung: `job:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200 (`application/pdf`)
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/time/clock-in`

**Einstempeln.** Erfasst Beginn und — sofern erlaubt — den Standort. Eine zweite laufende Erfassung wird abgewiesen.

- **Zugriff:** Erfordert die Berechtigung: `timetracking:own`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `jobId` | string | ja | min. 1 Zeichen |
| `lat` | number | ja | ≥ -90, ≤ 90 |
| `lng` | number | ja | ≥ -180, ≤ 180 |
| `accuracy` | number | – | ≥ 0, ≤ 10000 |
| `note` | string | – | max. 500 Zeichen |

### `POST /api/time/clock-out`

**Ausstempeln.** Schliesst die laufende Erfassung und rechnet die Dauer auf die Minute genau ab.

- **Zugriff:** Erfordert die Berechtigung: `timetracking:own`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `jobId` | string | ja | min. 1 Zeichen |
| `lat` | number | ja | ≥ -90, ≤ 90 |
| `lng` | number | ja | ≥ -180, ≤ 180 |
| `accuracy` | number | – | ≥ 0, ≤ 10000 |
| `note` | string | – | max. 500 Zeichen |

### `DELETE /api/jobs/{id}`

**Einsatz in den Papierkorb legen.** Abgeschlossene Einsätze und solche mit gestempelter Zeit bleiben erhalten. Weich gelöscht: der Datensatz verschwindet aus allen Listen, bleibt aber wiederherstellbar. Verknüpfte Datensätze werden nicht mitgelöscht.

- **Zugriff:** Erfordert die Berechtigung: `job:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/jobs/{id}/restore`

**Einsatz wiederherstellen.** Holt den Datensatz aus dem Papierkorb zurück.

- **Zugriff:** Erfordert die Berechtigung: `job:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

## Künstliche Intelligenz

### `POST /api/jobs/{id}/report/draft`

**Berichtstext entwerfen.** Formuliert aus Checkliste, Zeiten und Notizen einen Berichtstext. Der Entwurf wird nicht gespeichert — er landet im Formular und wird vor dem Abschluss geprüft.

- **Zugriff:** Erfordert die Berechtigungen: `ai:use`, `job:write`.
- **Rate-Limit-Klasse:** `aiGenerate`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/reviews/{id}/reply-draft`

**Antwort auf Bewertung entwerfen.** Formuliert einen Antwortvorschlag im Ton des Betriebs. Veröffentlicht wird er erst nach Freigabe über die Moderation.

- **Zugriff:** Erfordert die Berechtigungen: `ai:use`, `review:moderate`.
- **Rate-Limit-Klasse:** `aiGenerate`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/ai/quote-draft`

**Offertentwurf aus einer Anfrage.** Der Stundenansatz kommt aus dem Leistungskatalog, nicht aus dem Modell: es verteilt den Aufwand auf Positionen, es erfindet keine Tarife.

- **Zugriff:** Erfordert die Berechtigungen: `ai:use`, `quote:write`.
- **Rate-Limit-Klasse:** `aiGenerate`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `message` | string | ja | min. 10 Zeichen, max. 4000 Zeichen |
| `customerId` | string | – | min. 1 Zeichen |
| `leadId` | string | – | min. 1 Zeichen |
| `serviceKind` | string | – | `OFFICE_CLEANING` \| `MOVE_OUT_CLEANING` \| `RESIDENTIAL_CLEANING` \| `WINDOW_CLEANING` \| `CONSTRUCTION_CLEANING` \| `BUILDING_MAINTENANCE` \| `SPECIAL` |
| `propertyKind` | string | – | max. 40 Zeichen |
| `squareMeters` | integer | – | ≥ 5, ≤ 20000 |
| `rooms` | number | – | ≥ 0.5, ≤ 200 |
| `windows` | integer | – | ≥ 0, ≤ 2000 |
| `frequency` | string | – | max. 20 Zeichen |

### `POST /api/ai/email`

**E-Mail entwerfen.** Der Endpunkt versendet bewusst nichts — der Entwurf geht ins Formular.

- **Zugriff:** Erfordert die Berechtigung: `ai:use`.
- **Rate-Limit-Klasse:** `aiGenerate`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `purpose` | string | ja | min. 3 Zeichen, max. 200 Zeichen |
| `recipientName` | string | – | max. 120 Zeichen, Standard `"Kundin/Kunde"` |
| `context` | string | ja | min. 10 Zeichen, max. 4000 Zeichen |
| `tone` | string | – | `freundlich` \| `sachlich` \| `entschuldigend` \| `bestimmt` \| `werblich`, Standard `"freundlich"` |

### `POST /api/ai/summarize`

**Text zusammenfassen.** Für lange Kundenverläufe und Berichte.

- **Zugriff:** Erfordert die Berechtigung: `ai:use`.
- **Rate-Limit-Klasse:** `aiGenerate`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `text` | string | ja | min. 40 Zeichen, max. 40000 Zeichen |
| `focus` | string | – | max. 200 Zeichen |
| `maxSentences` | integer | – | ≥ 2, ≤ 15, Standard `6` |

### `POST /api/ai/translate`

**Text übersetzen.** Deutsch, Französisch, Italienisch, Englisch — die vier Sprachen der Schweizer Kundschaft.

- **Zugriff:** Erfordert die Berechtigung: `ai:use`.
- **Rate-Limit-Klasse:** `aiGenerate`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `text` | string | ja | min. 3 Zeichen, max. 20000 Zeichen |
| `targetLocale` | string | ja | `DE` \| `EN` \| `FR` \| `IT` |
| `preserveFormatting` | boolean | – | Standard `true` |

### `POST /api/ai/blog-draft`

**Blogbeitrag entwerfen.** Liefert Titel, Anriss, Fliesstext und SEO-Angaben als Entwurf.

- **Zugriff:** Erfordert die Berechtigungen: `ai:use`, `blog:write`.
- **Rate-Limit-Klasse:** `aiGenerate`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `topic` | string | ja | min. 5 Zeichen, max. 200 Zeichen |
| `keywords` | string[] | – | max. 10 Einträge, Standard `[]` |
| `wordCount` | integer | – | ≥ 300, ≤ 2000, Standard `900` |

### `POST /api/ai/dispatch`

**Tourenvorschlag für einen Tag.** Schlägt eine Zuteilung vor, die Fahrwege verkürzt. Der Vorschlag wird nicht ausgeführt — die Disposition entscheidet.

- **Zugriff:** Erfordert die Berechtigungen: `ai:use`, `job:dispatch`.
- **Rate-Limit-Klasse:** `aiGenerate`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `date` | string | ja | – |

## Personal

### `GET /api/employees`

**Mitarbeitende auflisten.** Ohne Blätterung — Disposition und Zuteilung brauchen die vollständige Liste in einem Zug.

- **Zugriff:** Erfordert die Berechtigung: `employee:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 429, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `q` | string | – | max. 120 Zeichen |
| `includeInactive` | boolean | – | Standard `false` |

### `POST /api/employees`

**Mitarbeitende/n anlegen.** Legt zugleich das Portalkonto an und versendet die Einladung. Ausschliesslich für die Rolle ADMIN: mit dem Datensatz entstehen Lohnfelder, AHV-Nummer und IBAN.

- **Zugriff:** Erfordert die Rolle ADMIN.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `firstName` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `lastName` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `email` | string | ja | email |
| `phone` | string | – | max. 30 Zeichen |
| `role` | string | – | `ADMIN` \| `MANAGER` \| `EMPLOYEE`, Standard `"EMPLOYEE"` |
| `employmentType` | string | – | `FULL_TIME` \| `PART_TIME` \| `HOURLY` \| `TEMPORARY` \| `APPRENTICE` \| `CONTRACTOR`, Standard `"FULL_TIME"` |
| `position` | string | – | max. 80 Zeichen, Standard `"Reinigungskraft"` |
| `department` | string | – | max. 80 Zeichen |
| `hiredAt` | string | ja | – |
| `hourlyRate` | number | – | ≥ 0, ≤ 9999999 |
| `monthlySalary` | number | – | ≥ 0, ≤ 9999999 |
| `workloadPct` | integer | – | ≥ 10, ≤ 100, Standard `100` |
| `vacationDaysPerYear` | number | – | ≥ 0, ≤ 60, Standard `20` |
| `ahvNumber` | string | – | – |
| `iban` | string | – | max. 40 Zeichen |
| `nationality` | string | – | max. 60 Zeichen |
| `permitType` | string | – | `CH` \| `B` \| `C` \| `G` \| `L` \| `F` \| `N` |
| `permitValidUntil` | string | – | – |
| `emergencyContact` | string | – | max. 120 Zeichen |
| `emergencyPhone` | string | – | max. 30 Zeichen |
| `driverLicense` | boolean | – | Standard `false` |
| `vehiclePlate` | string | – | max. 20 Zeichen |
| `languages` | string[] | – | Standard `["DE"]` |
| `color` | string | – | Standard `"#0B7285"` |
| `sendInvite` | boolean | – | Standard `true` |

### `POST /api/absences`

**Abwesenheit beantragen.** Zählt Wochenenden und Feiertage nicht mit und prüft das Ferienguthaben, bevor der Antrag entsteht.

- **Zugriff:** Erfordert die Berechtigung: `absence:request`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `type` | string | – | `VACATION` \| `SICK` \| `ACCIDENT` \| `MILITARY` \| `MATERNITY` \| `PATERNITY` \| `UNPAID` \| `TRAINING` \| `OTHER`, Standard `"VACATION"` |
| `startDate` | string | ja | – |
| `endDate` | string | ja | – |
| `halfDay` | boolean | – | Standard `false` |
| `reason` | string | – | max. 1000 Zeichen |

### `POST /api/absences/{id}/decide`

**Abwesenheit bewilligen oder ablehnen.** Bei Bewilligung wird die Person für den Zeitraum aus der Disposition genommen.

- **Zugriff:** Erfordert die Berechtigung: `absence:approve`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `status` | string | ja | `APPROVED` \| `REJECTED` |
| `decisionNote` | string | – | max. 1000 Zeichen |

### `PATCH /api/applications/{id}`

**Bewerbung weiterbewegen.** Status, Bewertung und interne Notiz. Bewusst ohne automatische Absage-E-Mail — eine Absage schreibt man selbst.

- **Zugriff:** Erfordert die Berechtigung: `career:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `status` | string | – | `RECEIVED` \| `SCREENING` \| `INTERVIEW` \| `OFFER` \| `HIRED` \| `REJECTED` \| `WITHDRAWN` |
| `rating` | integer | – | ≥ 1, ≤ 5 |
| `internalNote` | string | – | max. 4000 Zeichen |

### `GET /api/job-postings`

**Stellenangebote auflisten.** Mit der Zahl der eingegangenen Bewerbungen je Angebot.

- **Zugriff:** Erfordert die Berechtigung: `jobPosting:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `POST /api/job-postings`

**Stellenangebot anlegen.** Das Veröffentlichungsdatum entsteht beim Veröffentlichen, nicht beim Anlegen — ein Entwurf hat keines.

- **Zugriff:** Erfordert die Berechtigung: `jobPosting:create`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `title` | string | ja | min. 5 Zeichen, max. 120 Zeichen |
| `slug` | string | ja | min. 3 Zeichen, max. 120 Zeichen |
| `location` | string | – | min. 2 Zeichen, max. 80 Zeichen, Standard `"Bern"` |
| `employmentType` | string | – | `FULL_TIME` \| `PART_TIME` \| `HOURLY` \| `TEMPORARY` \| `APPRENTICE` \| `CONTRACTOR`, Standard `"FULL_TIME"` |
| `workloadFrom` | integer | – | ≥ 10, ≤ 100, Standard `80` |
| `workloadTo` | integer | – | ≥ 10, ≤ 100, Standard `100` |
| `description` | string | ja | min. 80 Zeichen, max. 8000 Zeichen |
| `requirements` | string[] | – | max. 20 Einträge, Standard `[]` |
| `benefits` | string[] | – | max. 20 Einträge, Standard `[]` |
| `salaryFrom` | number | – | ≥ 0, ≤ 9999999 |
| `salaryTo` | number | – | ≥ 0, ≤ 9999999 |
| `status` | string | – | `DRAFT` \| `SCHEDULED` \| `PUBLISHED` \| `ARCHIVED`, Standard `"DRAFT"` |
| `closesAt` | union | – | – |

### `PATCH /api/job-postings/{id}`

**Stellenangebot ändern.** Das Veröffentlichungsdatum wird beim ersten Veröffentlichen gesetzt und danach nicht mehr geändert — sonst rutschte die Anzeige bei jeder Korrektur in Stellenportalen nach oben, als wäre sie neu.

- **Zugriff:** Erfordert die Berechtigung: `jobPosting:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 409, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `title` | string | – | min. 5 Zeichen, max. 120 Zeichen |
| `slug` | string | – | min. 3 Zeichen, max. 120 Zeichen |
| `location` | string | – | min. 2 Zeichen, max. 80 Zeichen, Standard `"Bern"` |
| `employmentType` | string | – | `FULL_TIME` \| `PART_TIME` \| `HOURLY` \| `TEMPORARY` \| `APPRENTICE` \| `CONTRACTOR`, Standard `"FULL_TIME"` |
| `workloadFrom` | integer | – | ≥ 10, ≤ 100, Standard `80` |
| `workloadTo` | integer | – | ≥ 10, ≤ 100, Standard `100` |
| `description` | string | – | min. 80 Zeichen, max. 8000 Zeichen |
| `requirements` | string[] | – | max. 20 Einträge, Standard `[]` |
| `benefits` | string[] | – | max. 20 Einträge, Standard `[]` |
| `salaryFrom` | number | – | ≥ 0, ≤ 9999999 |
| `salaryTo` | number | – | ≥ 0, ≤ 9999999 |
| `status` | string | – | `DRAFT` \| `SCHEDULED` \| `PUBLISHED` \| `ARCHIVED`, Standard `"DRAFT"` |
| `closesAt` | union | – | – |

### `DELETE /api/job-postings/{id}`

**Stellenangebot löschen.** Nur ohne Bewerbungen. Bewerbungen sind Personendaten mit Auskunftsanspruch; ohne die zugehörige Stelle liessen sie sich nicht mehr erklären. Archivieren Sie stattdessen.

- **Zugriff:** Erfordert die Berechtigung: `jobPosting:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/employees/{id}`

**Personalakte abrufen.** Lohn, AHV-Nummer und Bankverbindung erscheinen nur mit payslip:create. Die Schwelle ist bewusst nicht das Lesen der Akte: wer Einsätze plant und Ferien bewilligt, braucht die Zahlen nicht. Es sind besonders schützenswerte Personendaten nach DSG.

- **Zugriff:** Erfordert die Berechtigung: `employee:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `PATCH /api/employees/{id}`

**Personalakte ändern.** Stammdaten, Pensum, Qualifikationen und Lohnangaben.

- **Zugriff:** Erfordert die Berechtigung: `employee:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `firstName` | string | – | min. 2 Zeichen, max. 80 Zeichen |
| `lastName` | string | – | min. 2 Zeichen, max. 80 Zeichen |
| `email` | string | – | email |
| `phone` | string | – | max. 30 Zeichen |
| `role` | string | – | `ADMIN` \| `MANAGER` \| `EMPLOYEE`, Standard `"EMPLOYEE"` |
| `employmentType` | string | – | `FULL_TIME` \| `PART_TIME` \| `HOURLY` \| `TEMPORARY` \| `APPRENTICE` \| `CONTRACTOR`, Standard `"FULL_TIME"` |
| `position` | string | – | max. 80 Zeichen, Standard `"Reinigungskraft"` |
| `department` | string | – | max. 80 Zeichen |
| `hiredAt` | string | – | – |
| `hourlyRate` | number | – | ≥ 0, ≤ 9999999 |
| `monthlySalary` | number | – | ≥ 0, ≤ 9999999 |
| `workloadPct` | integer | – | ≥ 10, ≤ 100, Standard `100` |
| `vacationDaysPerYear` | number | – | ≥ 0, ≤ 60, Standard `20` |
| `ahvNumber` | string | – | – |
| `iban` | string | – | max. 40 Zeichen |
| `nationality` | string | – | max. 60 Zeichen |
| `permitType` | string | – | `CH` \| `B` \| `C` \| `G` \| `L` \| `F` \| `N` |
| `permitValidUntil` | string | – | – |
| `emergencyContact` | string | – | max. 120 Zeichen |
| `emergencyPhone` | string | – | max. 30 Zeichen |
| `driverLicense` | boolean | – | Standard `false` |
| `vehiclePlate` | string | – | max. 20 Zeichen |
| `languages` | string[] | – | Standard `["DE"]` |
| `color` | string | – | Standard `"#0B7285"` |
| `sendInvite` | boolean | – | Standard `true` |
| `active` | boolean | – | – |
| `terminatedAt` | string | – | – |

## Finanzen

### `GET /api/invoices`

**Rechnungen auflisten.** Die Summen für offen, überfällig und bezahlt reisen im Meta-Teil der Antwort mit.

- **Zugriff:** Erfordert die Berechtigung: `invoice:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 429, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `page` | integer | – | ≥ 1, Standard `1` |
| `pageSize` | integer | – | ≥ 1, ≤ 100, Standard `20` |
| `q` | string | – | max. 120 Zeichen |
| `sort` | string | – | max. 60 Zeichen |
| `order` | string | – | `asc` \| `desc`, Standard `"desc"` |
| `status` | string | – | `DRAFT` \| `ISSUED` \| `SENT` \| `PARTIALLY_PAID` \| `PAID` \| `OVERDUE` \| `CANCELLED` \| `WRITTEN_OFF` |
| `customerId` | string | – | min. 1 Zeichen |
| `from` | string | – | date-time |
| `to` | string | – | date-time |

### `POST /api/invoices`

**Rechnung erstellen.** Standardmässig als Entwurf. Erst das Ausstellen vergibt die Nummer — eine vergebene, nie benutzte Nummer reisst eine Lücke in die Folge (Art. 957a OR).

- **Zugriff:** Erfordert die Berechtigung: `invoice:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `customerId` | string | ja | min. 1 Zeichen |
| `bookingId` | string | – | min. 1 Zeichen |
| `quoteId` | string | – | min. 1 Zeichen |
| `issueDate` | string | – | – |
| `dueDate` | string | – | – |
| `periodFrom` | string | – | – |
| `periodTo` | string | – | – |
| `introText` | string | – | max. 4000 Zeichen |
| `outroText` | string | – | max. 4000 Zeichen |
| `notes` | string | – | max. 4000 Zeichen |
| `discountAmount` | number | – | ≥ 0, ≤ 9999999, Standard `0` |
| `items` | object[] | ja | min. 1 Einträge, max. 200 Einträge |
| `items[].id` | string | – | min. 1 Zeichen |
| `items[].jobId` | string | – | min. 1 Zeichen |
| `items[].name` | string | ja | min. 2 Zeichen, max. 200 Zeichen |
| `items[].description` | string | – | max. 2000 Zeichen |
| `items[].quantity` | number | ja | ≥ 0.01, ≤ 10000 |
| `items[].unit` | string | – | max. 20 Zeichen, Standard `"Std."` |
| `items[].unitPrice` | number | ja | ≥ 0, ≤ 9999999 |
| `items[].discount` | number | – | ≥ 0, ≤ 100, Standard `0` |
| `items[].vatRate` | number | – | ≥ 0, ≤ 30, Standard `8.1` |
| `issueImmediately` | boolean | – | Standard `false` |

### `POST /api/invoices/{id}/issue`

**Rechnung ausstellen.** Vergibt die lückenlose Rechnungsnummer und die QR-Referenz innerhalb der Transaktion. Ab hier ist die Rechnung unveränderlich; Korrekturen laufen über eine Gutschrift.

- **Zugriff:** Erfordert die Berechtigung: `invoice:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/invoices/{id}/send`

**Rechnung versenden.** Versendet das PDF mit QR-Einzahlungsschein und Zahllink.

- **Zugriff:** Erfordert die Berechtigung: `invoice:send`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `email` | string | – | email |

### `POST /api/invoices/{id}/payments`

**Zahlungseingang erfassen.** Für Banküberweisungen und Bargeld. Aktualisiert Saldo und Status; eine Überzahlung wird abgewiesen statt still verbucht.

- **Zugriff:** Erfordert die Berechtigung: `invoice:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 404, 409, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `amount` | number | ja | ≥ 0, ≤ 9999999 |
| `method` | string | – | `CARD` \| `TWINT` \| `BANK_TRANSFER` \| `CASH` \| `SEPA` \| `GIFT_CARD` \| `CREDIT_NOTE` \| `OTHER`, Standard `"BANK_TRANSFER"` |
| `paidAt` | string | – | date-time |
| `reference` | string | – | max. 120 Zeichen |
| `note` | string | – | max. 1000 Zeichen |

### `POST /api/invoices/{id}/cancel`

**Rechnung stornieren.** Erzeugt eine Gutschrift über den vollen Betrag. Die Rechnung selbst wird nicht gelöscht — die Buchführung muss den Vorgang später erklären können.

- **Zugriff:** Erfordert die Berechtigung: `invoice:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 404, 409, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `reason` | string | ja | min. 3 Zeichen, max. 500 Zeichen |

### `GET /api/invoices/{id}/pdf`

**Rechnung als PDF.** Mit Schweizer QR-Einzahlungsschein (SIX v2.3). Kundschaft erhält nur die eigenen.

- **Zugriff:** Erfordert eine der Berechtigungen: `invoice:read`, `invoice:read_own`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200 (`application/pdf`)
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/expenses`

**Ausgaben auflisten.** Mit Kategorie, Lieferant und Belegdatei.

- **Zugriff:** Erfordert die Berechtigung: `expense:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 429, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `page` | integer | – | ≥ 1, Standard `1` |
| `pageSize` | integer | – | ≥ 1, ≤ 100, Standard `20` |
| `q` | string | – | max. 120 Zeichen |
| `sort` | string | – | max. 60 Zeichen |
| `order` | string | – | `asc` \| `desc`, Standard `"desc"` |

### `POST /api/expenses`

**Ausgabe erfassen.** Eingegeben wird netto; MWST und Brutto rechnet der Server.

- **Zugriff:** Erfordert die Berechtigung: `expense:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `supplierId` | string | – | min. 1 Zeichen |
| `category` | string | – | `MATERIAL` \| `EQUIPMENT` \| `VEHICLE` \| `FUEL` \| `INSURANCE` \| `RENT` \| `SALARY` \| `SOCIAL_SECURITY` \| `MARKETING` \| `SOFTWARE` \| `TRAINING` \| `TAXES` \| `OTHER`, Standard `"MATERIAL"` |
| `description` | string | ja | min. 3 Zeichen, max. 300 Zeichen |
| `reference` | string | – | max. 120 Zeichen |
| `expenseDate` | string | ja | – |
| `netAmount` | number | ja | ≥ 0, ≤ 9999999 |
| `vatRate` | number | – | ≥ 0, ≤ 30, Standard `8.1` |
| `paid` | boolean | – | Standard `false` |
| `paidAt` | string | – | date-time |
| `vatDeductible` | boolean | – | Standard `true` |
| `notes` | string | – | max. 2000 Zeichen |
| `fileIds` | string[] | – | max. 10 Einträge, Standard `[]` |

### `DELETE /api/invoices/{id}`

**Rechnung in den Papierkorb legen.** Nur Entwürfe. Ausgestellte Rechnungen bleiben unantastbar: nach Art. 957a OR muss die Nummerierung lückenlos sein. Weich gelöscht: der Datensatz verschwindet aus allen Listen, bleibt aber wiederherstellbar. Verknüpfte Datensätze werden nicht mitgelöscht.

- **Zugriff:** Erfordert die Berechtigung: `invoice:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/invoices/{id}/restore`

**Rechnung wiederherstellen.** Holt den Datensatz aus dem Papierkorb zurück.

- **Zugriff:** Erfordert die Berechtigung: `invoice:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/suppliers`

**Lieferanten auflisten.** Mit der Zahl der darauf gebuchten Ausgaben.

- **Zugriff:** Erfordert die Berechtigung: `supplier:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `POST /api/suppliers`

**Lieferant erfassen.** Ein neu erfasster Lieferant ist aktiv.

- **Zugriff:** Erfordert die Berechtigung: `supplier:create`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `name` | string | ja | min. 2 Zeichen, max. 140 Zeichen |
| `contactName` | string | – | max. 120 Zeichen |
| `email` | union | ja | – |
| `phone` | string | – | max. 30 Zeichen |
| `street` | string | – | max. 120 Zeichen |
| `postalCode` | string | – | max. 10 Zeichen |
| `city` | string | – | max. 80 Zeichen |
| `country` | string | – | Standard `"CH"` |
| `vatNumber` | string | – | max. 40 Zeichen |
| `iban` | string | – | max. 40 Zeichen |
| `paymentTermDays` | integer | – | ≥ 0, ≤ 180, Standard `30` |
| `notes` | string | – | max. 2000 Zeichen |

### `PATCH /api/suppliers/{id}`

**Lieferant ändern.** Teil-Update. Mit active=false wird der Lieferant stillgelegt, ohne Belege zu verlieren.

- **Zugriff:** Erfordert die Berechtigung: `supplier:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `DELETE /api/suppliers/{id}`

**Lieferant löschen.** Nur ohne gebuchte Ausgaben. Eine Ausgabe ohne ihren Lieferanten liesse sich in der Buchhaltung nicht mehr zuordnen — setzen Sie ihn stattdessen auf inaktiv.

- **Zugriff:** Erfordert die Berechtigung: `supplier:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/payments`

**Zahlungseingänge auflisten.** Sortiert nach Erfassung, nicht nach Zahlungsdatum — erfasst wird auch, was noch nicht bezahlt ist. Enthält Zahlungen mit und ohne Rechnungsbezug.

- **Zugriff:** Erfordert die Berechtigung: `payment:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

## Exporte

### `POST /api/exports/buchhaltung`

**Buchhaltungsexport.** CSV im Format der gängigen Schweizer Treuhandsoftware, mit Sollkonto, Habenkonto und MWST-Code je Buchung.

- **Zugriff:** Erfordert die Berechtigung: `accounting:export`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200 (`text/csv`)
- **Mögliche Fehler:** 400, 401, 403, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `format` | string | – | `csv` \| `bexio` \| `abacus` \| `banana` \| `datev`, Standard `"csv"` |
| `periodFrom` | string | ja | – |
| `periodTo` | string | ja | – |
| `include` | string[] | – | min. 1 Einträge, Standard `["invoices","payments","expenses"]` |

### `GET /api/exports/rechnungen`

**Rechnungen als Excel.** Mit Summenzeile und formatierten Beträgen.

- **Zugriff:** Erfordert die Berechtigung: `report:export`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200 (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`)
- **Mögliche Fehler:** 400, 401, 403, 429, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `from` | string | – | date-time |
| `to` | string | – | date-time |

### `GET /api/exports/kunden`

**Kundschaft als Excel.** Stammdaten, Umsatz und Anzahl Aufträge je Datensatz.

- **Zugriff:** Erfordert die Berechtigungen: `report:export`, `customer:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200 (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`)
- **Mögliche Fehler:** 401, 403, 429, 500

### `GET /api/exports/zeiterfassung`

**Zeiterfassung als Excel.** Grundlage für die Lohnverarbeitung, je Person und Tag.

- **Zugriff:** Erfordert die Berechtigung: `timetracking:read_all`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200 (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`)
- **Mögliche Fehler:** 400, 401, 403, 429, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `from` | string | – | date-time |
| `to` | string | – | date-time |

## Inhalte

### `POST /api/blog`

**Blogbeitrag anlegen.** Erstellt einen Entwurf; der Slug wird aus dem Titel abgeleitet.

- **Zugriff:** Erfordert die Berechtigung: `blog:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `title` | string | ja | min. 5 Zeichen, max. 200 Zeichen |
| `excerpt` | string | ja | min. 10 Zeichen, max. 500 Zeichen |
| `content` | string | ja | min. 100 Zeichen, max. 60000 Zeichen |
| `seoTitle` | string | – | max. 120 Zeichen |
| `seoDescription` | string | – | max. 300 Zeichen |
| `keywords` | string[] | – | max. 15 Einträge, Standard `[]` |
| `categorySlug` | string | – | max. 80 Zeichen |

### `GET /api/reviews`

**Eigene Bewertungen.** Für die Kundschaft — mit dem Moderationsstand und unserer Antwort.

- **Zugriff:** Erfordert eine der Berechtigungen: `review:write_own`, `review:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `POST /api/reviews`

**Bewertung abgeben.** Nur zu abgeschlossenen eigenen Terminen und je Termin genau einmal. Jede Bewertung geht in die Moderation — veröffentlicht wird auch die schlechte, aber erst nachdem der Betrieb sie gesehen hat.

- **Zugriff:** Erfordert die Berechtigung: `review:write_own`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `bookingId` | string | – | min. 1 Zeichen |
| `rating` | integer | ja | ≥ 1, ≤ 5 |
| `title` | string | – | max. 120 Zeichen |
| `body` | string | ja | min. 10 Zeichen, max. 2000 Zeichen |
| `authorName` | string | – | min. 2 Zeichen, max. 80 Zeichen |

### `PATCH /api/reviews/{id}`

**Bewertung moderieren.** Veröffentlichen, ablehnen, hervorheben, öffentlich antworten. Leert den Bewertungs-Cache, damit die Website nicht bis zu 30 Minuten den alten Schnitt zeigt.

- **Zugriff:** Erfordert die Berechtigung: `review:moderate`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `status` | string | – | `PENDING` \| `PUBLISHED` \| `REJECTED` |
| `featured` | boolean | – | – |
| `reply` | string | – | min. 10 Zeichen, max. 2000 Zeichen |

### `PATCH /api/content`

**Website-Texte pflegen.** Sammelübergabe aller Änderungen eines Formulars — die Redaktion ändert selten ein einzelnes Feld. Ein geleertes Feld löscht die Zeile; die Website zeigt dann wieder den Auslieferungstext aus dem Register. Leert anschliessend Inhalts- und Seitencache, damit die Änderung sofort sichtbar wird.

- **Zugriff:** Erfordert die Berechtigung: `content:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `entries` | object[] | ja | min. 1 Einträge, max. 80 Einträge |
| `entries[].key` | string | ja | min. 1 Zeichen |
| `entries[].value` | union | ja | – |

### `PATCH /api/seo`

**Suchmaschinenangaben pflegen.** Titel, Beschreibung, Schlüsselwörter und Vorschaubild einer Seite. Leere Felder setzen auf den Registerwert zurück. `noIndex` nimmt die Seite aus dem Index und wird im Prüfprotokoll gesondert vermerkt.

- **Zugriff:** Erfordert die Berechtigung: `seo:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `path` | string | ja | `/` \| `/leistungen` \| `/preise` \| `/einsatzgebiet` \| `/ueber-uns` \| `/kontakt` \| `/galerie` \| `/bewertungen` \| `/faq` \| `/karriere` \| `/blog` \| `/offerte` \| `/buchen` |
| `title` | string | – | max. 120 Zeichen |
| `description` | string | – | max. 320 Zeichen |
| `keywords` | string[] | – | max. 15 Einträge, Standard `[]` |
| `ogImageUrl` | union | ja | – |
| `noIndex` | boolean | – | Standard `false` |

## Katalog

### `GET /api/services`

**Leistungen auflisten.** Vollständiger Katalog, auch inaktive Einträge. Bewusst ohne Blätterung: der Katalog umfasst eine zweistellige Zahl von Einträgen, und die Verwaltung sortiert sie um — blättern hiesse, über Seitengrenzen zu sortieren.

- **Zugriff:** Erfordert die Berechtigung: `service:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `POST /api/services`

**Leistung anlegen.** Der Kurzname wird zur öffentlichen Adresse `/leistungen/{slug}` und muss eindeutig sein. Das Preismodell bestimmt, welcher Ansatz verlangt wird: PER_HOUR braucht `hourlyRate`, PER_SQM braucht `pricePerSqm`, FLAT braucht `basePrice`.

- **Zugriff:** Erfordert die Berechtigung: `service:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `name` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `slug` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `kind` | string | ja | `OFFICE_CLEANING` \| `MOVE_OUT_CLEANING` \| `RESIDENTIAL_CLEANING` \| `WINDOW_CLEANING` \| `CONSTRUCTION_CLEANING` \| `BUILDING_MAINTENANCE` \| `SPECIAL` |
| `categoryId` | string | – | min. 1 Zeichen |
| `shortDesc` | string | ja | min. 10 Zeichen, max. 200 Zeichen |
| `description` | string | ja | min. 30 Zeichen, max. 4000 Zeichen |
| `icon` | string | – | min. 1 Zeichen, max. 40 Zeichen, Standard `"Sparkles"` |
| `heroImage` | union | – | – |
| `active` | boolean | – | Standard `true` |
| `featured` | boolean | – | Standard `false` |
| `position` | integer | – | ≥ 0, ≤ 999, Standard `0` |
| `pricingModel` | string | – | `PER_HOUR` \| `PER_SQM` \| `FLAT` \| `PER_UNIT` \| `ON_REQUEST`, Standard `"PER_HOUR"` |
| `basePrice` | number | – | ≥ 0, ≤ 9999999, Standard `0` |
| `hourlyRate` | number | – | ≥ 0, ≤ 9999999 |
| `pricePerSqm` | number | – | ≥ 0, ≤ 9999 |
| `minPrice` | number | – | ≥ 0, ≤ 9999999, Standard `0` |
| `minHours` | number | – | ≥ 0, ≤ 99, Standard `2` |
| `vatRate` | number | – | ≥ 0, ≤ 100, Standard `8.1` |
| `defaultDurationMin` | integer | – | ≥ 15, ≤ 1440, Standard `120` |
| `minutesPerSqm` | number | – | ≥ 0, ≤ 60, Standard `1.2` |
| `defaultCrewSize` | integer | – | ≥ 1, ≤ 20, Standard `1` |
| `bufferMinutes` | integer | – | ≥ 0, ≤ 240, Standard `30` |
| `bulletPoints` | string[] | – | max. 12 Einträge, Standard `[]` |
| `includes` | string[] | – | max. 30 Einträge, Standard `[]` |
| `excludes` | string[] | – | max. 30 Einträge, Standard `[]` |
| `seoTitle` | string | – | max. 70 Zeichen |
| `seoDescription` | string | – | max. 180 Zeichen |
| `keywords` | string[] | – | max. 20 Einträge, Standard `[]` |

### `GET /api/services/{id}`

**Leistung abrufen.** Eine Leistung samt zugehörigen Preisregeln und Zusatzzuordnung.

- **Zugriff:** Erfordert die Berechtigung: `service:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `PATCH /api/services/{id}`

**Leistung ändern.** Teil-Update. Querbedingungen werden gegen den gespeicherten Stand geprüft: ein Wechsel des Preismodells ohne passenden Ansatz wird mit 422 abgelehnt, weil die Preis-Engine sonst still mit 0 rechnen würde. Bestehende Buchungen und Rechnungen bleiben unberührt — sie tragen Preis und Steuersatz als eigene Werte.

- **Zugriff:** Erfordert die Berechtigung: `service:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `name` | string | – | min. 2 Zeichen, max. 80 Zeichen |
| `slug` | string | – | min. 2 Zeichen, max. 80 Zeichen |
| `kind` | string | – | `OFFICE_CLEANING` \| `MOVE_OUT_CLEANING` \| `RESIDENTIAL_CLEANING` \| `WINDOW_CLEANING` \| `CONSTRUCTION_CLEANING` \| `BUILDING_MAINTENANCE` \| `SPECIAL` |
| `categoryId` | string | – | min. 1 Zeichen |
| `shortDesc` | string | – | min. 10 Zeichen, max. 200 Zeichen |
| `description` | string | – | min. 30 Zeichen, max. 4000 Zeichen |
| `icon` | string | – | min. 1 Zeichen, max. 40 Zeichen, Standard `"Sparkles"` |
| `heroImage` | union | – | – |
| `active` | boolean | – | Standard `true` |
| `featured` | boolean | – | Standard `false` |
| `position` | integer | – | ≥ 0, ≤ 999, Standard `0` |
| `pricingModel` | string | – | `PER_HOUR` \| `PER_SQM` \| `FLAT` \| `PER_UNIT` \| `ON_REQUEST`, Standard `"PER_HOUR"` |
| `basePrice` | number | – | ≥ 0, ≤ 9999999, Standard `0` |
| `hourlyRate` | number | – | ≥ 0, ≤ 9999999 |
| `pricePerSqm` | number | – | ≥ 0, ≤ 9999 |
| `minPrice` | number | – | ≥ 0, ≤ 9999999, Standard `0` |
| `minHours` | number | – | ≥ 0, ≤ 99, Standard `2` |
| `vatRate` | number | – | ≥ 0, ≤ 100, Standard `8.1` |
| `defaultDurationMin` | integer | – | ≥ 15, ≤ 1440, Standard `120` |
| `minutesPerSqm` | number | – | ≥ 0, ≤ 60, Standard `1.2` |
| `defaultCrewSize` | integer | – | ≥ 1, ≤ 20, Standard `1` |
| `bufferMinutes` | integer | – | ≥ 0, ≤ 240, Standard `30` |
| `bulletPoints` | string[] | – | max. 12 Einträge, Standard `[]` |
| `includes` | string[] | – | max. 30 Einträge, Standard `[]` |
| `excludes` | string[] | – | max. 30 Einträge, Standard `[]` |
| `seoTitle` | string | – | max. 70 Zeichen |
| `seoDescription` | string | – | max. 180 Zeichen |
| `keywords` | string[] | – | max. 20 Einträge, Standard `[]` |

### `DELETE /api/services/{id}`

**Leistung löschen.** Nur möglich, solange die Leistung in keiner Buchung, Offerte oder keinem Einsatz vorkommt. Andernfalls 422 mit der Zahl der Vorgänge und dem Hinweis, sie stattdessen auf inaktiv zu setzen.

- **Zugriff:** Erfordert die Berechtigung: `service:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/service-categories`

**Kategorien auflisten.** Gruppen, nach denen die Leistungen auf der Website sortiert erscheinen.

- **Zugriff:** Erfordert die Berechtigung: `service:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `POST /api/service-categories`

**Kategorie anlegen.** Der Kurzname muss innerhalb der Organisation eindeutig sein.

- **Zugriff:** Erfordert die Berechtigung: `service:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `name` | string | ja | min. 2 Zeichen, max. 60 Zeichen |
| `slug` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `description` | string | – | max. 300 Zeichen |
| `icon` | string | – | min. 1 Zeichen, max. 40 Zeichen, Standard `"Sparkles"` |
| `position` | integer | – | ≥ 0, ≤ 999, Standard `0` |
| `active` | boolean | – | Standard `true` |

### `PATCH /api/service-categories/{id}`

**Kategorie ändern.** Teil-Update der Gruppenangaben.

- **Zugriff:** Erfordert die Berechtigung: `service:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `name` | string | – | min. 2 Zeichen, max. 60 Zeichen |
| `slug` | string | – | min. 2 Zeichen, max. 80 Zeichen |
| `description` | string | – | max. 300 Zeichen |
| `icon` | string | – | min. 1 Zeichen, max. 40 Zeichen, Standard `"Sparkles"` |
| `position` | integer | – | ≥ 0, ≤ 999, Standard `0` |
| `active` | boolean | – | Standard `true` |

### `DELETE /api/service-categories/{id}`

**Kategorie löschen.** Die Leistungen darin bleiben bestehen und stehen anschliessend ohne Kategorie da. Die Antwort nennt unter `unassigned`, wie viele das betrifft.

- **Zugriff:** Erfordert die Berechtigung: `service:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/service-extras`

**Zusatzleistungen auflisten.** Buchbare Optionen samt der Leistungen, bei denen sie angeboten werden.

- **Zugriff:** Erfordert die Berechtigung: `service:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `POST /api/service-extras`

**Zusatzleistung anlegen.** Eine leere `serviceIds`-Liste bedeutet: bei allen Leistungen anbieten. Fremde IDs werden verworfen.

- **Zugriff:** Erfordert die Berechtigung: `service:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `name` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `slug` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `description` | string | – | max. 300 Zeichen |
| `icon` | string | – | min. 1 Zeichen, max. 40 Zeichen, Standard `"Plus"` |
| `price` | number | ja | ≥ 0, ≤ 9999999 |
| `pricingModel` | string | – | `PER_HOUR` \| `PER_SQM` \| `FLAT` \| `PER_UNIT` \| `ON_REQUEST`, Standard `"FLAT"` |
| `durationMin` | integer | – | ≥ 0, ≤ 480, Standard `15` |
| `vatRate` | number | – | ≥ 0, ≤ 100, Standard `8.1` |
| `active` | boolean | – | Standard `true` |
| `position` | integer | – | ≥ 0, ≤ 999, Standard `0` |
| `serviceIds` | string[] | – | max. 50 Einträge, Standard `[]` |

### `PATCH /api/service-extras/{id}`

**Zusatzleistung ändern.** `serviceIds` ist der gewünschte Endzustand der Zuordnung, kein Zuwachs. Fehlt das Feld, bleibt die Zuordnung unangetastet.

- **Zugriff:** Erfordert die Berechtigung: `service:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `name` | string | – | min. 2 Zeichen, max. 80 Zeichen |
| `slug` | string | – | min. 2 Zeichen, max. 80 Zeichen |
| `description` | string | – | max. 300 Zeichen |
| `icon` | string | – | min. 1 Zeichen, max. 40 Zeichen, Standard `"Plus"` |
| `price` | number | – | ≥ 0, ≤ 9999999 |
| `pricingModel` | string | – | `PER_HOUR` \| `PER_SQM` \| `FLAT` \| `PER_UNIT` \| `ON_REQUEST`, Standard `"FLAT"` |
| `durationMin` | integer | – | ≥ 0, ≤ 480, Standard `15` |
| `vatRate` | number | – | ≥ 0, ≤ 100, Standard `8.1` |
| `active` | boolean | – | Standard `true` |
| `position` | integer | – | ≥ 0, ≤ 999, Standard `0` |
| `serviceIds` | string[] | – | max. 50 Einträge, Standard `[]` |

### `DELETE /api/service-extras/{id}`

**Zusatzleistung löschen.** Nur möglich, solange keine Buchung sie enthält; andernfalls 422.

- **Zugriff:** Erfordert die Berechtigung: `service:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/price-rules`

**Preisregeln auflisten.** Aufsteigend nach `priority` — dieselbe Reihenfolge, in der die Preis-Engine sie anwendet.

- **Zugriff:** Erfordert die Berechtigung: `service:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `POST /api/price-rules`

**Preisregel anlegen.** Die Bedingung ist streng validiert: ein unbekannter Schlüssel wird abgelehnt, statt stillschweigend zu einer leeren Bedingung zu werden — die auf jeden Auftrag passt. Eine Regel ohne Wirkung (Faktor 1 und Betrag 0) wird ebenfalls abgelehnt.

- **Zugriff:** Erfordert die Berechtigung: `service:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `name` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `serviceId` | string | – | min. 1 Zeichen |
| `condition` | object | ja | – |
| `condition.frequency` | string[] | – | min. 1 Einträge |
| `condition.propertyKind` | string[] | – | min. 1 Einträge |
| `condition.weekday` | integer[] | – | min. 1 Einträge, max. 7 Einträge |
| `condition.hourFrom` | integer | – | ≥ 0, ≤ 23 |
| `condition.hourTo` | integer | – | ≥ 0, ≤ 23 |
| `condition.minSqm` | number | – | ≥ 0, ≤ 100000 |
| `condition.maxSqm` | number | – | ≥ 0, ≤ 100000 |
| `condition.hasPets` | boolean | – | – |
| `condition.urgent` | boolean | – | – |
| `condition.postalCode` | string[] | – | min. 1 Einträge |
| `multiplier` | number | – | ≥ 0, ≤ 10, Standard `1` |
| `surcharge` | number | – | ≥ -9999999, ≤ 9999999, Standard `0` |
| `priority` | integer | – | ≥ 0, ≤ 999, Standard `0` |
| `active` | boolean | – | Standard `true` |

### `PATCH /api/price-rules/{id}`

**Preisregel ändern.** Teil-Update. Die Bedingung wird als Ganzes ersetzt, nicht zusammengeführt.

- **Zugriff:** Erfordert die Berechtigung: `service:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `name` | string | – | min. 2 Zeichen, max. 80 Zeichen |
| `serviceId` | string | – | min. 1 Zeichen |
| `condition` | object | – | – |
| `condition.frequency` | string[] | – | min. 1 Einträge |
| `condition.propertyKind` | string[] | – | min. 1 Einträge |
| `condition.weekday` | integer[] | – | min. 1 Einträge, max. 7 Einträge |
| `condition.hourFrom` | integer | – | ≥ 0, ≤ 23 |
| `condition.hourTo` | integer | – | ≥ 0, ≤ 23 |
| `condition.minSqm` | number | – | ≥ 0, ≤ 100000 |
| `condition.maxSqm` | number | – | ≥ 0, ≤ 100000 |
| `condition.hasPets` | boolean | – | – |
| `condition.urgent` | boolean | – | – |
| `condition.postalCode` | string[] | – | min. 1 Einträge |
| `multiplier` | number | – | ≥ 0, ≤ 10, Standard `1` |
| `surcharge` | number | – | ≥ -9999999, ≤ 9999999, Standard `0` |
| `priority` | integer | – | ≥ 0, ≤ 999, Standard `0` |
| `active` | boolean | – | Standard `true` |

### `DELETE /api/price-rules/{id}`

**Preisregel löschen.** Ohne Rückfrage möglich: bestehende Belege führen den Zuschlag als eigene Position mit eigenem Betrag und verlieren nichts.

- **Zugriff:** Erfordert die Berechtigung: `service:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/catalog/reorder`

**Reihenfolge setzen.** Übergeben wird die vollständige Reihenfolge als Liste von IDs; die Positionen vergibt der Server aus dem Index. So kann kein Zustand entstehen, in dem zwei Einträge dieselbe Position tragen. Alles läuft in einer Transaktion.

- **Zugriff:** Erfordert die Berechtigung: `service:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `entity` | string | ja | `service` \| `extra` \| `category` |
| `ids` | string[] | ja | min. 1 Einträge, max. 200 Einträge |

### `GET /api/tax-rates`

**Steuersätze auflisten.** Hinterlegte Mehrwertsteuersätze, absteigend nach Satz.

- **Zugriff:** Erfordert die Berechtigung: `service:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `POST /api/tax-rates`

**Steuersatz anlegen.** Wird der neue Satz als Standard markiert, verliert der bisherige diese Markierung in derselben Transaktion — zwei Standardsätze wären ein Zustand, in dem die Sortierung entscheidet.

- **Zugriff:** Erfordert die Berechtigung: `settings:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `name` | string | ja | min. 2 Zeichen, max. 60 Zeichen |
| `rate` | number | ja | ≥ 0, ≤ 100 |
| `isDefault` | boolean | – | Standard `false` |
| `active` | boolean | – | Standard `true` |

### `PATCH /api/tax-rates/{id}`

**Steuersatz ändern.** Teil-Update.

- **Zugriff:** Erfordert die Berechtigung: `settings:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `name` | string | – | min. 2 Zeichen, max. 60 Zeichen |
| `rate` | number | – | ≥ 0, ≤ 100 |
| `isDefault` | boolean | – | Standard `false` |
| `active` | boolean | – | Standard `true` |

### `DELETE /api/tax-rates/{id}`

**Steuersatz löschen.** Der Standardsatz ist geschützt: bestimmen Sie zuerst einen anderen als Standard. Bestehende Rechnungen behalten ihren Satz — er steht als eigene Spalte auf jeder Position.

- **Zugriff:** Erfordert die Berechtigung: `settings:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/coupons`

**Gutscheine auflisten.** Codes samt Einlösestand.

- **Zugriff:** Erfordert die Berechtigung: `coupon:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `POST /api/coupons`

**Gutschein ausgeben.** Der Code wird in Grossbuchstaben normalisiert und muss eindeutig sein.

- **Zugriff:** Erfordert die Berechtigung: `coupon:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `code` | string | ja | min. 3 Zeichen, max. 24 Zeichen |
| `description` | string | – | max. 200 Zeichen |
| `discountType` | string | – | `PERCENT` \| `FIXED`, Standard `"PERCENT"` |
| `discountValue` | number | ja | ≥ 0.01, ≤ 9999999 |
| `minOrderValue` | number | – | ≥ 0, ≤ 9999999, Standard `0` |
| `maxDiscount` | number | – | ≥ 0, ≤ 9999999 |
| `status` | string | – | `ACTIVE` \| `PAUSED` \| `EXPIRED` \| `DEPLETED`, Standard `"ACTIVE"` |
| `validFrom` | string | ja | – |
| `validUntil` | union | – | – |
| `usageLimit` | integer | – | ≥ 1, ≤ 1000000 |
| `perCustomerLimit` | integer | – | ≥ 1, ≤ 1000, Standard `1` |
| `firstOrderOnly` | boolean | – | Standard `false` |
| `serviceKinds` | string[] | – | max. 7 Einträge, Standard `[]` |

### `PATCH /api/coupons/{id}`

**Gutschein ändern.** Der Einlösezähler lässt sich nicht setzen: er hält eine Tatsache fest, keine Absicht. Wäre er beschreibbar, liesse sich jedes Nutzungslimit beliebig oft aufheben.

- **Zugriff:** Erfordert die Berechtigung: `coupon:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `code` | string | – | min. 3 Zeichen, max. 24 Zeichen |
| `description` | string | – | max. 200 Zeichen |
| `discountType` | string | – | `PERCENT` \| `FIXED`, Standard `"PERCENT"` |
| `discountValue` | number | – | ≥ 0.01, ≤ 9999999 |
| `minOrderValue` | number | – | ≥ 0, ≤ 9999999, Standard `0` |
| `maxDiscount` | number | – | ≥ 0, ≤ 9999999 |
| `status` | string | – | `ACTIVE` \| `PAUSED` \| `EXPIRED` \| `DEPLETED`, Standard `"ACTIVE"` |
| `validFrom` | string | – | – |
| `validUntil` | union | – | – |
| `usageLimit` | integer | – | ≥ 1, ≤ 1000000 |
| `perCustomerLimit` | integer | – | ≥ 1, ≤ 1000, Standard `1` |
| `firstOrderOnly` | boolean | – | Standard `false` |
| `serviceKinds` | string[] | – | max. 7 Einträge, Standard `[]` |

### `DELETE /api/coupons/{id}`

**Gutschein löschen.** Nur möglich, solange der Code nie eingelöst wurde; andernfalls 422 mit dem Hinweis, ihn auf „pausiert" zu setzen.

- **Zugriff:** Erfordert die Berechtigung: `coupon:write`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

## Website

### `GET /api/cta`

**Handlungsaufrufe auflisten.** Alle Aufrufe, auch abgeschaltete. `?papierkorb=1` zeigt zusätzlich die gelöschten.

- **Zugriff:** Erfordert die Berechtigung: `cta:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `POST /api/cta`

**Handlungsaufruf anlegen.** Das Ziel wird gegen eine Positivliste geprüft: interner Pfad, https, tel oder mailto. Ein freies Adressfeld wäre der direkte Weg zu einem javascript:-Ziel auf der öffentlichen Website.

- **Zugriff:** Erfordert die Berechtigung: `cta:create`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `key` | string | ja | min. 2 Zeichen, max. 48 Zeichen |
| `label` | string | ja | min. 2 Zeichen, max. 48 Zeichen |
| `note` | string | – | max. 200 Zeichen |
| `href` | string | ja | min. 1 Zeichen, max. 500 Zeichen |
| `newTab` | boolean | – | Standard `false` |
| `icon` | string | – | max. 40 Zeichen |
| `slot` | string | ja | `HEADER` \| `HERO_PRIMARY` \| `HERO_SECONDARY` \| `SECTION_BANNER` \| `FOOTER` \| `MOBILE_BAR` |
| `style` | string | – | `PRIMARY` \| `SECONDARY` \| `OUTLINE` \| `GHOST` \| `ACCENT` \| `SUCCESS` \| `CUSTOM`, Standard `"PRIMARY"` |
| `bgColor` | union | – | – |
| `fgColor` | union | – | – |
| `pages` | string[] | – | max. 30 Einträge, Standard `[]` |
| `active` | boolean | – | Standard `true` |
| `position` | integer | – | ≥ 0, ≤ 999, Standard `0` |
| `publishFrom` | union | – | – |
| `publishUntil` | union | – | – |

### `GET /api/cta/{id}`

**Handlungsaufruf abrufen.** Ein einzelner Aufruf mit allen Feldern.

- **Zugriff:** Erfordert die Berechtigung: `cta:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `PATCH /api/cta/{id}`

**Handlungsaufruf ändern.** Teil-Update von Text, Farbe, Symbol, Ziel, Platz, Seiten und Laufzeit.

- **Zugriff:** Erfordert die Berechtigung: `cta:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `key` | string | – | min. 2 Zeichen, max. 48 Zeichen |
| `label` | string | – | min. 2 Zeichen, max. 48 Zeichen |
| `note` | string | – | max. 200 Zeichen |
| `href` | string | – | min. 1 Zeichen, max. 500 Zeichen |
| `newTab` | boolean | – | Standard `false` |
| `icon` | string | – | max. 40 Zeichen |
| `slot` | string | – | `HEADER` \| `HERO_PRIMARY` \| `HERO_SECONDARY` \| `SECTION_BANNER` \| `FOOTER` \| `MOBILE_BAR` |
| `style` | string | – | `PRIMARY` \| `SECONDARY` \| `OUTLINE` \| `GHOST` \| `ACCENT` \| `SUCCESS` \| `CUSTOM`, Standard `"PRIMARY"` |
| `bgColor` | union | – | – |
| `fgColor` | union | – | – |
| `pages` | string[] | – | max. 30 Einträge, Standard `[]` |
| `active` | boolean | – | Standard `true` |
| `position` | integer | – | ≥ 0, ≤ 999, Standard `0` |
| `publishFrom` | union | – | – |
| `publishUntil` | union | – | – |

### `DELETE /api/cta/{id}`

**Handlungsaufruf löschen.** Standard ist der Papierkorb. `?endgueltig=1` entfernt ihn wirklich, aber nur wenn er bereits im Papierkorb liegt.

- **Zugriff:** Erfordert die Berechtigung: `cta:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/cta/{id}/publish`

**Handlungsaufruf ein- oder ausschalten.** Eigene Berechtigung, weil dies die einzige Handlung ist, die etwas auf der öffentlichen Website erscheinen lässt. Wer Texte vorbereiten darf, muss nicht veröffentlichen dürfen.

- **Zugriff:** Erfordert die Berechtigung: `cta:publish`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/cta/{id}/restore`

**Handlungsaufruf wiederherstellen.** Kommt bewusst abgeschaltet zurück — erst ansehen, dann veröffentlichen.

- **Zugriff:** Erfordert die Berechtigung: `cta:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/cta/reorder`

**Reihenfolge der Handlungsaufrufe setzen.** Übergeben wird die Reihenfolge als Liste von IDs; die Positionen vergibt der Server aus dem Index.

- **Zugriff:** Erfordert die Berechtigung: `cta:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `slot` | string | ja | `HEADER` \| `HERO_PRIMARY` \| `HERO_SECONDARY` \| `SECTION_BANNER` \| `FOOTER` \| `MOBILE_BAR` |
| `ids` | string[] | ja | min. 1 Einträge, max. 50 Einträge |

### `GET /api/media`

**Mediathek durchsuchen.** Alle hochgeladenen Dateien mit Blätterung, Filter nach Bereich und Dateityp.

- **Zugriff:** Erfordert die Berechtigung: `media:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `POST /api/media`

**Hochgeladene Datei registrieren.** Der Upload selbst läuft direkt zu Supabase (/api/files/upload-url). Dieser Endpunkt hält nur fest, was dort gelandet ist — sonst gäbe es Dateien, die in keiner Liste erscheinen.

- **Zugriff:** Erfordert die Berechtigung: `media:upload`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 401, 403, 409, 422, 429, 500

### `PATCH /api/media/{id}`

**Datei umbenennen oder zuordnen.** Ändert Anzeigename und Bereich. Die Adresse der Datei bleibt bestehen.

- **Zugriff:** Erfordert die Berechtigung: `media:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `DELETE /api/media/{id}`

**Datei endgültig löschen.** Kein Papierkorb — die Datei liegt im Objektspeicher und kostet dort Geld. Hängt sie an einem Beleg, antwortet der Endpunkt mit 422 und nennt woran; `?trotzdem=1` setzt sich darüber hinweg.

- **Zugriff:** Erfordert die Berechtigung: `media:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/faq`

**Häufige Fragen auflisten.** Alle Fragen, auch abgeschaltete, gruppiert nach Kategorie.

- **Zugriff:** Erfordert die Berechtigung: `faq:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `POST /api/faq`

**Frage anlegen.** Erscheint nach dem Speichern auf /faq und auf der Startseite.

- **Zugriff:** Erfordert die Berechtigung: `faq:create`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `question` | string | ja | min. 8 Zeichen, max. 200 Zeichen |
| `answer` | string | ja | min. 20 Zeichen, max. 2000 Zeichen |
| `category` | string | – | min. 2 Zeichen, max. 60 Zeichen, Standard `"Allgemein"` |
| `locale` | string | – | `DE` \| `FR` \| `IT` \| `EN`, Standard `"DE"` |
| `position` | integer | – | ≥ 0, ≤ 999, Standard `0` |
| `active` | boolean | – | Standard `true` |

### `PATCH /api/faq/{id}`

**Frage ändern.** Teil-Update von Frage, Antwort, Kategorie und Sichtbarkeit.

- **Zugriff:** Erfordert die Berechtigung: `faq:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `question` | string | – | min. 8 Zeichen, max. 200 Zeichen |
| `answer` | string | – | min. 20 Zeichen, max. 2000 Zeichen |
| `category` | string | – | min. 2 Zeichen, max. 60 Zeichen, Standard `"Allgemein"` |
| `locale` | string | – | `DE` \| `FR` \| `IT` \| `EN`, Standard `"DE"` |
| `position` | integer | – | ≥ 0, ≤ 999, Standard `0` |
| `active` | boolean | – | Standard `true` |

### `DELETE /api/faq/{id}`

**Frage löschen.** Endgültig — eine Frage ist schnell neu erfasst.

- **Zugriff:** Erfordert die Berechtigung: `faq:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/gallery`

**Galerie auflisten.** Alle Vorher-/Nachher-Einträge, auch unveröffentlichte.

- **Zugriff:** Erfordert die Berechtigung: `gallery:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `POST /api/gallery`

**Galerieeintrag anlegen.** Vorher und Nachher müssen verschiedene Bilder sein — sonst zeigt der Schieberegler auf der Startseite nichts. Beide Adressen müssen über https ausgeliefert werden.

- **Zugriff:** Erfordert die Berechtigung: `gallery:create`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `title` | string | ja | min. 3 Zeichen, max. 120 Zeichen |
| `description` | string | – | max. 500 Zeichen |
| `serviceKind` | string | – | `OFFICE_CLEANING` \| `MOVE_OUT_CLEANING` \| `RESIDENTIAL_CLEANING` \| `WINDOW_CLEANING` \| `CONSTRUCTION_CLEANING` \| `BUILDING_MAINTENANCE` \| `SPECIAL` |
| `beforeUrl` | string | ja | uri, max. 500 Zeichen |
| `afterUrl` | string | ja | uri, max. 500 Zeichen |
| `location` | string | – | max. 120 Zeichen |
| `featured` | boolean | – | Standard `false` |
| `position` | integer | – | ≥ 0, ≤ 999, Standard `0` |
| `published` | boolean | – | Standard `true` |

### `PATCH /api/gallery/{id}`

**Galerieeintrag ändern.** Teil-Update. Die Bildgleichheit wird gegen den gespeicherten Stand geprüft, damit sich nicht ein Bild auf das andere setzen lässt.

- **Zugriff:** Erfordert die Berechtigung: `gallery:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `title` | string | – | min. 3 Zeichen, max. 120 Zeichen |
| `description` | string | – | max. 500 Zeichen |
| `serviceKind` | string | – | `OFFICE_CLEANING` \| `MOVE_OUT_CLEANING` \| `RESIDENTIAL_CLEANING` \| `WINDOW_CLEANING` \| `CONSTRUCTION_CLEANING` \| `BUILDING_MAINTENANCE` \| `SPECIAL` |
| `beforeUrl` | string | – | uri, max. 500 Zeichen |
| `afterUrl` | string | – | uri, max. 500 Zeichen |
| `location` | string | – | max. 120 Zeichen |
| `featured` | boolean | – | Standard `false` |
| `position` | integer | – | ≥ 0, ≤ 999, Standard `0` |
| `published` | boolean | – | Standard `true` |

### `DELETE /api/gallery/{id}`

**Galerieeintrag löschen.** Endgültig. Die Bilddateien liegen in der Mediathek und bleiben bestehen.

- **Zugriff:** Erfordert die Berechtigung: `gallery:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/website/reorder`

**Reihenfolge von Fragen oder Galeriebildern setzen.** Übergeben wird die Reihenfolge als Liste von IDs; die Positionen vergibt der Server aus dem Index.

- **Zugriff:** Erfordert eine der Berechtigungen: `faq:update`, `gallery:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `entity` | string | ja | `faq` \| `gallery` |
| `ids` | string[] | ja | min. 1 Einträge, max. 200 Einträge |

## System

### `GET /api/users`

**Benutzerkonten auflisten.** Filter nach Rolle, Status und Suchbegriff. `?papierkorb=1` zeigt gelöschte mit.

- **Zugriff:** Erfordert die Berechtigung: `user:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `POST /api/users`

**Person einladen.** Kein Passwortfeld: die Person vergibt es selbst über einen einmaligen Link. Die Rolle wird zusätzlich gegen die eigene Stufe geprüft — sonst könnte jemand mit user:create, aber ohne role:assign, über den Umweg einer Einladung eine Systemverantwortung erzeugen.

- **Zugriff:** Erfordert die Berechtigung: `user:create`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `email` | string | ja | email, min. 1 Zeichen, max. 255 Zeichen |
| `firstName` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `lastName` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `phone` | union | – | – |
| `role` | string | ja | `CUSTOMER` \| `EMPLOYEE` \| `MANAGER` \| `ADMIN` \| `SUPER_ADMIN` |
| `locale` | string | – | `DE` \| `FR` \| `IT` \| `EN`, Standard `"DE"` |

### `PATCH /api/users/{id}`

**Konto ändern.** Stammdaten, Sprache und Sperrung. Eine Sperre beendet alle laufenden Sitzungen sofort. Die Rolle lässt sich hier nicht ändern.

- **Zugriff:** Erfordert die Berechtigung: `user:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 409, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `firstName` | string | – | min. 2 Zeichen, max. 80 Zeichen |
| `lastName` | string | – | min. 2 Zeichen, max. 80 Zeichen |
| `phone` | union | – | – |
| `email` | string | – | email, min. 1 Zeichen, max. 255 Zeichen |
| `locale` | string | – | `DE` \| `FR` \| `IT` \| `EN` |
| `status` | string | – | `ACTIVE` \| `SUSPENDED` \| `DISABLED` |
| `notifyByEmail` | boolean | – | – |
| `notifyBySms` | boolean | – | – |

### `PATCH /api/users/{id}/role`

**Rolle zuweisen.** Drei Sperren: nur bis zur eigenen Stufe, nicht die eigene Rolle, und nie die letzte aktive Systemverantwortung. Alle Sitzungen des Kontos werden beendet, weil die Rolle im Zugangstoken steckt.

- **Zugriff:** Erfordert die Berechtigung: `role:assign`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `role` | string | ja | `CUSTOMER` \| `EMPLOYEE` \| `MANAGER` \| `ADMIN` \| `SUPER_ADMIN` |

### `DELETE /api/users/{id}`

**Konto in den Papierkorb legen.** Weich: ein Konto hängt an Aktivitäten, Nachrichten, Bewertungen und Protokolleinträgen. Ein hartes Löschen risse dort überall Lücken.

- **Zugriff:** Erfordert die Berechtigung: `user:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/users/{id}/restore`

**Konto wiederherstellen.** Kommt gesperrt zurück — der Zugang wird bewusst in einem zweiten Schritt frei.

- **Zugriff:** Erfordert die Berechtigung: `user:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/company`

**Firmendaten abrufen.** Stammdaten samt Öffnungszeiten.

- **Zugriff:** Erfordert die Berechtigung: `company:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `PATCH /api/company`

**Firmendaten ändern.** IBAN und QR-IBAN werden gegen die Prüfziffer nach ISO 13616 geprüft. Eine falsche Nummer fiele sonst erst auf, wenn eine Kundschaft die erste Rechnung nicht bezahlen kann — und stünde dann bereits auf ausgestellten, unveränderlichen Belegen.

- **Zugriff:** Erfordert die Berechtigung: `company:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `name` | string | ja | min. 2 Zeichen, max. 140 Zeichen |
| `legalName` | union | ja | – |
| `email` | string | ja | email, max. 200 Zeichen |
| `phone` | union | ja | – |
| `whatsapp` | union | ja | – |
| `website` | union | ja | – |
| `street` | string | ja | min. 2 Zeichen, max. 140 Zeichen |
| `streetNo` | union | ja | – |
| `postalCode` | string | ja | – |
| `city` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `vatNumber` | union | ja | – |
| `iban` | union | ja | – |
| `qrIban` | union | ja | – |
| `bankName` | union | ja | – |
| `logoUrl` | union | ja | – |
| `logoDarkUrl` | union | ja | – |
| `faviconUrl` | union | ja | – |
| `mapsUrl` | union | ja | – |
| `facebookUrl` | union | ja | – |
| `instagramUrl` | union | ja | – |
| `linkedinUrl` | union | ja | – |
| `tiktokUrl` | union | ja | – |
| `youtubeUrl` | union | ja | – |

### `GET /api/opening-hours`

**Öffnungszeiten abrufen.** Sieben Zeilen, Sonntag bis Samstag.

- **Zugriff:** Erfordert die Berechtigung: `company:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `PUT /api/opening-hours`

**Öffnungszeiten setzen.** PUT statt PATCH: der Körper beschreibt den vollständigen gewünschten Wochenplan. Einzelne Tage zu pflegen wären sieben Anfragen, von denen jede für sich fehlschlagen könnte.

- **Zugriff:** Erfordert die Berechtigung: `company:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 422, 429, 500

### `GET /api/cron/hourly`

**Stündliche Aufgaben.** Terminerinnerungen 24 h und 2 h vorher, fällige Aufgabenerinnerungen. Authentifiziert über `Authorization: Bearer $CRON_SECRET`.

- **Zugriff:** Nur für den Scheduler: `Authorization: Bearer $CRON_SECRET`.
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 500

### `GET /api/cron/daily`

**Tägliche Aufgaben.** Mahnläufe, ablaufende Offerten, Wiederholungsbuchungen, Bewertungsanfragen, Geburtstagsgrüsse, Automatisierungen.

- **Zugriff:** Nur für den Scheduler: `Authorization: Bearer $CRON_SECRET`.
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 500

### `POST /api/webhooks/stripe`

**Stripe-Webhook.** Bucht Zahlungseingänge, Rückerstattungen und Fehlschläge. Prüft die Signatur gegen den Rohkörper und arbeitet idempotent. Bei einem Fehler antwortet der Endpunkt mit 500, damit Stripe erneut zustellt — eine stille 200 würde die Zahlung verlieren.

- **Zugriff:** Öffentlich — keine Anmeldung nötig.
- **Erfolg:** 200
- **Mögliche Fehler:** 422, 500
