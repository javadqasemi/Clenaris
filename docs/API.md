# API-Referenz

> Diese Datei wird von `npm run openapi` erzeugt. Änderungen bitte in
> `scripts/openapi-routes.ts` und den Zod-Schemas vornehmen — dort steht die
> Quelle, aus der sowohl diese Referenz als auch die Laufzeitvalidierung
> stammen.

Stand: 368 Endpunkte. Die maschinenlesbare Fassung liegt in
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
- [Benutzer & Rollen](#benutzer-rollen)
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
- [Betrieb](#betrieb)
- [Kommunikation](#kommunikation)
- [Führung: Kennzahlen](#führung-kennzahlen)
- [Führung: Ziele](#führung-ziele)
- [Führung: Finanzplanung](#führung-finanzplanung)
- [Führung: Risiko und Qualität](#führung-risiko-und-qualität)
- [Führung: Wissen und Markt](#führung-wissen-und-markt)
- [Führung: Berichte](#führung-berichte)

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
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 422, 429, 500

### `GET /api/auth/refresh`

**Sitzung erneuern und weiterleiten.** Der Weg für Seitenaufrufe mit abgelaufenem Zugangstoken: Die Middleware schickt den Browser hierher, die Route rotiert den Refresh-Token, setzt die Cookies und leitet mit 303 an `weiter` zurück. Scheitert die Erneuerung — auch nach 15 Minuten ohne Aktivität —, geht es zur Anmeldung mit demselben Rücksprungziel.

- **Zugriff:** Öffentlich — keine Anmeldung nötig.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200 (`text/html`)
- **Mögliche Fehler:** 400, 429, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `weiter` | string | – | max. 512 Zeichen |

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

### `GET /api/auth/2fa`

**Zustand des zweiten Faktors.** Ob die Zwei-Faktor-Anmeldung eingeschaltet ist, seit wann, und wie viele Wiederherstellungscodes noch übrig sind. Weder Geheimnis noch Codes werden je zurückgegeben — die Codes existieren nach der Einrichtung nur noch als Hash.

- **Zugriff:** Erfordert eine angemeldete Sitzung.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 429, 500

### `POST /api/auth/2fa/setup`

**Einrichtung beginnen.** Erzeugt ein TOTP-Geheimnis und liefert es als QR-Code und als Text zum Abtippen. Der Schutz wird dabei **nicht** eingeschaltet: erst der bestätigte Code unter `/api/auth/2fa/confirm` stellt ihn scharf. Ohne diesen zweiten Schritt sperrt sich aus, wer den QR-Code scannt und dann das Telefon zurücksetzt. Ein bereits eingeschalteter Faktor wird nicht überschrieben.

- **Zugriff:** Erfordert eine angemeldete Sitzung.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 422, 429, 500

### `POST /api/auth/2fa/confirm`

**Einrichtung bestätigen.** Prüft den ersten Code und schaltet die Zwei-Faktor-Anmeldung ein. Die Antwort enthält die zehn Wiederherstellungscodes — **einmalig**. Danach existieren sie nur noch als Hash; wer sie nicht notiert, braucht die Systemverantwortung.

- **Zugriff:** Erfordert eine angemeldete Sitzung.
- **Rate-Limit-Klasse:** `login`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `token` | string | ja | – |

### `POST /api/auth/2fa/disable`

**Zweiten Faktor ausschalten.** Verlangt Passwort **und** einen gültigen Code — ein Wiederherstellungscode zählt ebenfalls. Nur das Passwort würde genügen, wenn jemand eine offene Sitzung übernimmt, und dann wäre der zweite Faktor genau in dem Moment weg, in dem er gebraucht wird.

- **Zugriff:** Erfordert eine angemeldete Sitzung.
- **Rate-Limit-Klasse:** `login`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `token` | string | ja | min. 6 Zeichen, max. 20 Zeichen |
| `password` | string | ja | min. 1 Zeichen |

### `POST /api/auth/2fa/verify`

**Zweiter Schritt der Anmeldung.** Öffentlich, weil hier noch keine Sitzung besteht: Der Aufrufer weist sich über den kurzlebigen Zwischenschein aus, den `/api/auth/login` gesetzt hat. Dieser Endpunkt erzeugt das Zugangstoken. Sechs Ziffern sind eine Million Möglichkeiten — ohne das Anmelde-Limit wären sie in Minuten durchprobiert.

- **Zugriff:** Öffentlich — keine Anmeldung nötig.
- **Rate-Limit-Klasse:** `login`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `token` | string | ja | min. 6 Zeichen, max. 20 Zeichen |

## Benutzer & Rollen

### `DELETE /api/users/{id}/2fa`

**Zweiten Faktor eines Kontos zurücksetzen.** Der Notausgang, wenn jemand Telefon *und* Wiederherstellungscodes verloren hat. Nur die Systemverantwortung darf das — es ist die einzige Handlung, die einen Schutz von aussen entfernt. Alle Sitzungen der Person werden dabei beendet: Ist das Konto tatsächlich übernommen worden, endet der Zugriff in diesem Moment.

- **Zugriff:** Erfordert die Berechtigungen: `user:update`, `role:assign`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

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
| `cvUrl` | string | – | max. 2000 Zeichen |

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

### `POST /api/public/quotes`

**Offertanfrage.** Legt einen Lead an (oder ergänzt einen bestehenden derselben Person) und erzeugt einen Offertentwurf mit Position, Menge in der Einheit der Leistung und Katalogansatz. Scheitert der Entwurf, bleibt der Lead trotzdem stehen.

- **Zugriff:** Öffentlich — keine Anmeldung nötig.
- **Rate-Limit-Klasse:** `quoteRequest`
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
| `serviceKind` | string | ja | `OFFICE_CLEANING` \| `MOVE_OUT_CLEANING` \| `RESIDENTIAL_CLEANING` \| `WINDOW_CLEANING` \| `CONSTRUCTION_CLEANING` \| `BUILDING_MAINTENANCE` \| `SPECIAL` |
| `message` | string | ja | min. 10 Zeichen, max. 4000 Zeichen |
| `acceptPrivacy` | object | ja | – |
| `utmSource` | string | – | max. 80 Zeichen |
| `utmMedium` | string | – | max. 80 Zeichen |
| `utmCampaign` | string | – | max. 120 Zeichen |
| `referrerUrl` | string | – | max. 500 Zeichen |
| `landingPath` | string | – | max. 300 Zeichen |
| `website` | union | ja | – |
| `street` | string | – | max. 120 Zeichen |
| `squareMeters` | integer | – | ≥ 5, ≤ 20000 |
| `rooms` | number | – | ≥ 0.5, ≤ 100 |
| `frequency` | string | – | `ONCE` \| `WEEKLY` \| `BIWEEKLY` \| `MONTHLY` \| `QUARTERLY` \| `SEMIANNUAL` \| `ANNUAL` \| `CUSTOM`, Standard `"ONCE"` |
| `preferredDate` | string | – | – |
| `fileIds` | string[] | – | max. 10 Einträge, Standard `[]` |

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

### `PUT /api/files/blob/{id}`

**Datei an die Upload-Adresse schreiben.** Gegenstück zur signierten Adresse von Supabase, wenn kein externer Speicher eingerichtet ist. Der Körper sind die rohen Bytes; die Adresse ist die Berechtigung — sie entsteht in `/api/files/upload-url`, ist nicht erratbar, genau einmal und nur zwei Stunden lang beschreibbar. Höchstens 5 MB.

- **Zugriff:** Öffentlich — keine Anmeldung nötig.
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 404, 422, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/files/blob/{id}`

**Datei ausliefern.** Öffentlich lesbar wie ein öffentlicher Bucket: Profilbilder und Einsatzfotos erscheinen in E-Mails und PDF-Berichten ohne Sitzung. Der Schutz ist die nicht erratbare Adresse.

- **Zugriff:** Öffentlich — keine Anmeldung nötig.
- **Erfolg:** 200 (`application/octet-stream`)
- **Mögliche Fehler:** 400, 404, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

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

- **Zugriff:** Erfordert die Berechtigung: `lead:create`.
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

- **Zugriff:** Erfordert die Berechtigung: `lead:update`.
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

- **Zugriff:** Erfordert die Berechtigung: `customer:create`.
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

- **Zugriff:** Erfordert die Berechtigung: `customer:create`.
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

- **Zugriff:** Erfordert die Berechtigung: `activity:create`.
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

- **Zugriff:** Erfordert die Berechtigung: `task:create`.
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

- **Zugriff:** Erfordert die Berechtigung: `task:update`.
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

### `GET /api/customers/{id}/addresses`

**Adressen einer Kundschaft.** Eine Kundschaft hat mehrere Adressen — Wohnung, Buero, die Treuhand fuer die Rechnungen. Genau eine ist die Standardadresse, hoechstens eine die Rechnungsanschrift. Die Antwort nennt zu jeder, wie viele Objekte, Buchungen und Einsaetze darauf verweisen. Erreichbar fuer das Buero und fuer die Kundschaft im eigenen Konto; wer nur das eigene Recht hat, kommt ausschliesslich an die eigene Akte.

- **Zugriff:** Erfordert eine der Berechtigungen: `customer:read`, `customer:read_own`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/customers/{id}/addresses`

**Adresse erfassen.** Die erste Adresse einer Kundschaft wird zwangslaeufig Standard- und Rechnungsanschrift: Eine Kundschaft mit einer Adresse, die fuer nichts gilt, koennte keinen Termin buchen. Wird eine weitere zur Standardadresse erklaert, verliert die bisherige die Markierung — in derselben Transaktion, damit nie zwei gleichzeitig gelten.

- **Zugriff:** Erfordert eine der Berechtigungen: `customer:update`, `customer:update_own`.
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
| `label` | string | – | max. 60 Zeichen |
| `street` | string | ja | min. 2 Zeichen, max. 120 Zeichen |
| `streetNo` | string | – | max. 20 Zeichen |
| `addition` | string | – | max. 120 Zeichen |
| `postalCode` | string | ja | – |
| `city` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `canton` | string | – | Standard `"BE"` |
| `country` | string | – | Standard `"CH"` |
| `lat` | number | – | ≥ -90, ≤ 90 |
| `lng` | number | – | ≥ -180, ≤ 180 |
| `placeId` | string | – | max. 200 Zeichen |
| `accessNote` | string | – | max. 500 Zeichen |
| `firstName` | string | – | max. 80 Zeichen |
| `lastName` | string | – | max. 80 Zeichen |
| `company` | string | – | max. 140 Zeichen |
| `isBilling` | boolean | – | Standard `false` |
| `isDefault` | boolean | – | Standard `false` |

### `PATCH /api/customers/{id}/addresses/{addressId}`

**Adresse aendern.** Die Standardmarkierung laesst sich nicht abwaehlen, nur weitergeben — sonst stuende eine Kundschaft ohne Standardadresse da und kaeme im Buchungsformular nicht weiter. Wer eine andere zur Standardadresse macht, nimmt sie dieser automatisch weg.

- **Zugriff:** Erfordert eine der Berechtigungen: `customer:update`, `customer:update_own`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |
| `addressId` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `label` | string | – | max. 60 Zeichen |
| `street` | string | – | min. 2 Zeichen, max. 120 Zeichen |
| `streetNo` | string | – | max. 20 Zeichen |
| `addition` | string | – | max. 120 Zeichen |
| `postalCode` | string | – | – |
| `city` | string | – | min. 2 Zeichen, max. 80 Zeichen |
| `canton` | string | – | Standard `"BE"` |
| `country` | string | – | Standard `"CH"` |
| `lat` | number | – | ≥ -90, ≤ 90 |
| `lng` | number | – | ≥ -180, ≤ 180 |
| `placeId` | string | – | max. 200 Zeichen |
| `accessNote` | string | – | max. 500 Zeichen |
| `firstName` | string | – | max. 80 Zeichen |
| `lastName` | string | – | max. 80 Zeichen |
| `company` | string | – | max. 140 Zeichen |
| `isBilling` | boolean | – | Standard `false` |
| `isDefault` | boolean | – | Standard `false` |

### `DELETE /api/customers/{id}/addresses/{addressId}`

**Adresse entfernen.** Endgueltig, nicht in den Papierkorb: `Address` traegt kein `deletedAt`. Deshalb bleibt jede Adresse stehen, an der Objekte, Buchungen oder Einsaetze haengen — sie belegt, wohin damals gefahren wurde. Und die letzte Adresse bleibt ohnehin, weil ohne sie keine Buchung mehr zustande kaeme. Faellt die Standardadresse weg, rueckt die aelteste verbleibende nach.

- **Zugriff:** Erfordert eine der Berechtigungen: `customer:update`, `customer:update_own`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |
| `addressId` | string | ja | min. 1 Zeichen |

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

### `DELETE /api/tasks/{id}`

**Aufgabe löschen.** Ohne fachliche Sperre — eine Aufgabe ist eine Notiz, kein Beleg. Mitarbeitende dürfen nur eigene löschen.

- **Zugriff:** Erfordert die Berechtigung: `task:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/properties`

**Objekte auflisten.** Property trägt kein organizationId — die Zugehörigkeit erbt es von der Kundschaft; der Mandantenfilter läuft über die Beziehung. Der Alarmcode erscheint nicht in der Liste: er gehört auf den Einsatzrapport der zugewiesenen Person.

- **Zugriff:** Erfordert die Berechtigung: `property:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `POST /api/properties`

**Objekt erfassen.** Eine bestehende Adresse wird gegen die Kundschaft geprüft — ohne das liesse sich ein Objekt an eine fremde Adresse hängen, und der Einsatzrapport führte das Team dorthin.

- **Zugriff:** Erfordert die Berechtigung: `property:create`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 401, 403, 409, 422, 429, 500

### `GET /api/properties/{id}`

**Objektakte abrufen.** Objektangaben, Adresse, Kundschaft und die letzten Einsätze.

- **Zugriff:** Erfordert die Berechtigung: `property:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `PATCH /api/properties/{id}`

**Objekt ändern.** Die Kundschaft lässt sich nicht wechseln: das würde Einsatzhistorie und daran hängende Rechnungen an die falsche Akte binden. Bei einem Eigentümerwechsel wird ein neues Objekt erfasst und das alte stillgelegt.

- **Zugriff:** Erfordert die Berechtigung: `property:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/customers/{id}/merge`

**Doppelerfassungen vorschlagen.** Gleiche E-Mail, gleiche Telefonnummer oder gleicher Name in derselben Firma. Bewusst ein Vorschlag — zusammenführen entscheidet eine Person.

- **Zugriff:** Erfordert die Berechtigung: `customer:update`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/customers/{id}/merge`

**Kundendatensatz eingliedern.** `{id}` bleibt bestehen und übernimmt alles Bewegliche; `sourceId` wird geleert und weich gelöscht. Nicht umkehrbar — deshalb `customer:delete` zusätzlich.

- **Zugriff:** Erfordert die Berechtigungen: `customer:update`, `customer:delete`.
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
| `sourceId` | string | ja | min. 1 Zeichen |

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

- **Zugriff:** Erfordert eine der Berechtigungen: `message:create`, `message:write_own`.
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

- **Zugriff:** Erfordert eine der Berechtigungen: `message:create`, `message:write_own`.
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

- **Zugriff:** Erfordert die Berechtigung: `booking:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/bookings/{id}/reschedule`

**Termin verschieben.** Prüft die Verfügbarkeit erneut und verschiebt den zugehörigen Einsatz mit.

- **Zugriff:** Erfordert die Berechtigung: `booking:update`.
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

- **Zugriff:** Erfordert die Berechtigung: `booking:update`.
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

- **Zugriff:** Erfordert die Berechtigung: `invoice:create`.
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

### `GET /api/bookings`

**Buchungen auflisten.** Die Kundensicht auf einen Auftrag. Die Betriebssicht steht unter /api/jobs: eine Buchung kann mehrere Einsätze erzeugen, und ein Einsatz kann ohne Buchung bestehen.

- **Zugriff:** Erfordert die Berechtigung: `booking:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `GET /api/bookings/{id}`

**Auftrag abrufen.** Kundschaft erhält nur den eigenen Auftrag; die Einschränkung setzt der Dienst über den `customerId`-Filter, nicht der Handler.

- **Zugriff:** Erfordert eine der Berechtigungen: `booking:read`, `booking:read_own`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `PATCH /api/bookings/{id}`

**Auftrag bearbeiten.** Termin, Kundschaft, Adresse, Positionen, Preis, Turnus, Notizen und Status in einem Endpunkt. Preisfelder ändert nur, wer `pricing:update` besitzt; Statuswechsel laufen durch dieselben Wege wie die Schaltflächen (bestätigen erzeugt Einsätze, stornieren benachrichtigt die Kundschaft).

- **Zugriff:** Erfordert die Berechtigung: `booking:update`.
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
| `status` | string | – | `DRAFT` \| `PENDING` \| `CONFIRMED` \| `IN_PROGRESS` \| `COMPLETED` \| `CANCELLED` \| `NO_SHOW` |
| `scheduledStart` | union | – | – |
| `durationMin` | integer | – | ≥ 30, ≤ 1440 |
| `crewSize` | integer | – | ≥ 1, ≤ 20 |
| `customerId` | string | – | min. 1 Zeichen |
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
| `propertyId` | string | – | min. 1 Zeichen |
| `propertyKind` | string | – | `APARTMENT` \| `HOUSE` \| `OFFICE` \| `COMMERCIAL` \| `INDUSTRIAL` \| `CONSTRUCTION_SITE` \| `PRACTICE` \| `RESTAURANT` \| `SCHOOL` \| `OTHER` |
| `squareMeters` | integer | – | ≥ 5, ≤ 5000 |
| `rooms` | number | – | ≥ 0.5, ≤ 40 |
| `windows` | integer | – | ≥ 0, ≤ 500 |
| `frequency` | string | – | `ONCE` \| `WEEKLY` \| `BIWEEKLY` \| `MONTHLY` \| `QUARTERLY` \| `SEMIANNUAL` \| `ANNUAL` \| `CUSTOM` |
| `recurrence` | object | – | – |
| `recurrence.interval` | integer | – | ≥ 1, ≤ 12, Standard `1` |
| `recurrence.weekdays` | integer[] | – | max. 7 Einträge, Standard `[]` |
| `recurrence.endDate` | union | – | – |
| `recurrence.count` | integer | – | ≥ 2, ≤ 104 |
| `items` | object[] | – | min. 1 Einträge, max. 30 Einträge |
| `items[].serviceId` | string | ja | min. 1 Zeichen |
| `items[].name` | string | ja | min. 2 Zeichen, max. 160 Zeichen |
| `items[].description` | string | – | max. 500 Zeichen |
| `items[].quantity` | number | ja | ≥ 0, ≤ 100000 |
| `items[].unit` | string | ja | min. 1 Zeichen, max. 20 Zeichen |
| `items[].unitPrice` | number | ja | ≥ 0, ≤ 1000000 |
| `items[].durationMin` | integer | – | ≥ 0, ≤ 10080, Standard `0` |
| `extras` | object[] | – | max. 20 Einträge |
| `extras[].extraId` | string | ja | min. 1 Zeichen |
| `extras[].name` | string | ja | min. 2 Zeichen, max. 160 Zeichen |
| `extras[].quantity` | integer | – | ≥ 1, ≤ 200, Standard `1` |
| `extras[].unitPrice` | number | ja | ≥ 0, ≤ 100000 |
| `travelFee` | number | – | ≥ 0, ≤ 10000 |
| `discountAmount` | number | – | ≥ 0, ≤ 1000000 |
| `vatRate` | number | – | ≥ 0, ≤ 100 |
| `internalNote` | string | – | max. 2000 Zeichen |
| `customerNote` | string | – | max. 2000 Zeichen |
| `accessNote` | string | – | max. 500 Zeichen |
| `changeReason` | string | – | max. 500 Zeichen |

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

- **Zugriff:** Erfordert die Berechtigung: `quote:create`.
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

- **Zugriff:** Erfordert die Berechtigung: `quote:update`.
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

- **Zugriff:** Erfordert die Berechtigung: `quote:create`.
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

- **Zugriff:** Erfordert die Berechtigung: `job:update`.
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

- **Zugriff:** Erfordert die Berechtigung: `job:update`.
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

- **Zugriff:** Erfordert eine der Berechtigungen: `job:complete_assigned`, `job:update`.
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

- **Zugriff:** Erfordert eine der Berechtigungen: `job:complete_assigned`, `job:update`.
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
| `url` | string | ja | max. 2000 Zeichen |
| `thumbnailUrl` | string | – | max. 2000 Zeichen |
| `caption` | string | – | max. 300 Zeichen |
| `room` | string | – | max. 80 Zeichen |
| `lat` | number | – | ≥ -90, ≤ 90 |
| `lng` | number | – | ≥ -180, ≤ 180 |

### `POST /api/jobs/checklist/{id}`

**Checklistenpunkt abhaken.** Hält fest, wer wann abgehakt hat.

- **Zugriff:** Erfordert eine der Berechtigungen: `job:complete_assigned`, `job:update`.
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
| `lat` | number | – | ≥ -90, ≤ 90 |
| `lng` | number | – | ≥ -180, ≤ 180 |
| `accuracy` | number | – | ≥ 0, ≤ 100000 |
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
| `lat` | number | – | ≥ -90, ≤ 90 |
| `lng` | number | – | ≥ -180, ≤ 180 |
| `accuracy` | number | – | ≥ 0, ≤ 100000 |
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

### `PUT /api/jobs/{id}/checklist`

**Checkliste setzen.** Ersetzt die Liste als Ganzes. Punkte mit `id` behalten ihren Erledigt-Haken, sofern `keepProgress` nicht ausgeschaltet ist; nicht genannte Punkte werden entfernt.

- **Zugriff:** Erfordert die Berechtigung: `job:update`.
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
| `items` | object[] | ja | max. 200 Einträge |
| `items[].id` | string | – | min. 1 Zeichen |
| `items[].label` | string | ja | min. 2 Zeichen, max. 200 Zeichen |
| `items[].room` | string | – | max. 80 Zeichen |
| `items[].required` | boolean | – | Standard `true` |
| `keepProgress` | boolean | – | Standard `true` |

### `POST /api/jobs/{id}/checklist`

**Standardcheckliste übernehmen.** Hängt die Vorlage der Leistungsart an oder ersetzt die bestehende Liste.

- **Zugriff:** Erfordert die Berechtigung: `job:update`.
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
| `kind` | string | ja | `RESIDENTIAL_CLEANING` \| `MOVE_OUT_CLEANING` \| `OFFICE_CLEANING` \| `WINDOW_CLEANING` \| `CONSTRUCTION_CLEANING` \| `BUILDING_MAINTENANCE` \| `SPECIAL` |
| `replace` | boolean | – | Standard `false` |

### `PUT /api/jobs/{id}/team`

**Team mit Rollen setzen.** Anders als `/assign` trägt hier jede Person ihre Rolle (Leitung, Mitglied, Lernende, Aufsicht). Ein leeres Team setzt den Einsatz auf „nicht zugeteilt" zurück. Nur neu hinzugekommene Personen werden benachrichtigt.

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
| `members` | object[] | ja | max. 20 Einträge |
| `members[].employeeId` | string | ja | min. 1 Zeichen |
| `members[].role` | string | – | `LEAD` \| `MEMBER` \| `TRAINEE` \| `SUPERVISOR`, Standard `"MEMBER"` |
| `notify` | boolean | – | Standard `true` |

### `PATCH /api/jobs/{id}/costing`

**Nachkalkulation bearbeiten oder abnehmen.** Umsatz, Lohn- und Materialkosten von Hand setzen oder aus Zeiterfassung, Verbrauch und Auftragswert neu herleiten. Hinter `dashboard:financials`, nicht `job:update`: Deckungsbeitrag je Auftrag gehört zu den Finanzen.

- **Zugriff:** Erfordert die Berechtigung: `dashboard:financials`.
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
| `revenue` | number | – | ≥ 0, ≤ 9999999 |
| `laborCost` | number | – | ≥ 0, ≤ 9999999 |
| `materialCost` | number | – | ≥ 0, ≤ 9999999 |
| `recalculate` | boolean | – | Standard `false` |
| `approve` | boolean | – | Standard `false` |
| `note` | string | – | max. 2000 Zeichen |

### `PUT /api/jobs/{id}/costing`

**Materialverbrauch setzen.** Material erfasst das Team, nicht die Buchhaltung. Der Materialaufwand fliesst automatisch in die Nachkalkulation.

- **Zugriff:** Erfordert die Berechtigung: `job:update`.
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
| `materials` | object[] | ja | max. 50 Einträge |
| `materials[].name` | string | ja | min. 2 Zeichen, max. 120 Zeichen |
| `materials[].sku` | string | – | max. 60 Zeichen |
| `materials[].quantity` | number | ja | ≥ 0.01, ≤ 10000 |
| `materials[].unit` | string | – | max. 20 Zeichen, Standard `"Stk."` |
| `materials[].unitCost` | number | – | ≥ 0, ≤ 9999999, Standard `0` |
| `materials[].billable` | boolean | – | Standard `false` |

### `PATCH /api/jobs/{id}/photos/{photoId}`

**Foto einordnen.** Art, Raum und Bildlegende nachträglich setzen. Mitarbeitende nur an eigenen, noch laufenden Einsätzen — nach dem Abschluss gehören die Bilder zum Rapport.

- **Zugriff:** Erfordert eine der Berechtigungen: `job:complete_assigned`, `job:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |
| `photoId` | string | ja | min. 1 Zeichen |

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `type` | string | – | `BEFORE` \| `AFTER` \| `DAMAGE` \| `DOCUMENT` \| `OTHER` |
| `caption` | string | – | max. 300 Zeichen |
| `room` | string | – | max. 80 Zeichen |

### `DELETE /api/jobs/{id}/photos/{photoId}`

**Foto löschen.** Hart, nicht in den Papierkorb: Ein Foto ist oft genau deshalb zu entfernen, weil es etwas zeigt, das nicht aufbewahrt werden darf. Der Vorgang steht im Prüfprotokoll.

- **Zugriff:** Erfordert eine der Berechtigungen: `job:complete_assigned`, `job:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |
| `photoId` | string | ja | min. 1 Zeichen |

## Künstliche Intelligenz

### `POST /api/jobs/{id}/report/draft`

**Berichtstext entwerfen.** Formuliert aus Checkliste, Zeiten und Notizen einen Berichtstext. Der Entwurf wird nicht gespeichert — er landet im Formular und wird vor dem Abschluss geprüft.

- **Zugriff:** Erfordert die Berechtigungen: `ai:use`, `job:update`.
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

- **Zugriff:** Erfordert die Berechtigungen: `ai:use`, `quote:create`.
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

- **Zugriff:** Erfordert die Berechtigungen: `ai:use`, `blog:create`.
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

### `POST /api/absences/{id}/withdraw`

**Eigenen Abwesenheitsantrag zurückziehen.** Nur solange der Antrag noch nicht entschieden ist. Der Antrag wird nicht gelöscht, sondern auf CANCELLED gesetzt — die Zeile belegt, dass beantragt und zurückgezogen wurde. Welchen Antrag jemand zurückziehen darf, entscheidet die Abfrage über die eigene Personalnummer.

- **Zugriff:** Erfordert die Berechtigung: `absence:request`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

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

- **Zugriff:** Erfordert die Rolle ADMIN oder SUPER_ADMIN.
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

- **Zugriff:** Erfordert die Berechtigung: `application:update`.
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
| `active` | boolean | – | – |
| `terminatedAt` | string | – | – |

### `GET /api/absences`

**Abwesenheiten auflisten.** Mitarbeitende sehen ausschliesslich die eigenen. Das ist keine Bequemlichkeit: wer wann in den Ferien war, ist eine Personalangabe und geht die Kolleginnen und Kollegen nichts an.

- **Zugriff:** Erfordert eine der Berechtigungen: `absence:read_all`, `absence:request`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `DELETE /api/applications/{id}`

**Bewerbung löschen.** Bewerbungsunterlagen sind Personendaten. Nach DSG dürfen sie nur so lange aufbewahrt werden, wie es der Zweck erfordert — nach einer Absage sind das wenige Monate. Das Löschen ist deshalb ausdrücklich vorgesehen und nicht durch eine Aufbewahrungsregel gesperrt. Angehängte Dateien gehen über die Kaskade mit.

- **Zugriff:** Erfordert die Berechtigung: `application:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `DELETE /api/employees/{id}`

**Mitarbeitende stilllegen.** Kein Löschen, sondern inaktiv setzen mit Austrittsdatum; der Zugang wird gesperrt. Eine Personalakte hängt an Zeiterfassung, Lohnabrechnungen und Einsatzrapporten — sie zu entfernen risse dort Lücken, die man Jahre später bei einer Lohnprüfung wiederfindet. Geplante Einsätze müssen vorher umgeteilt werden.

- **Zugriff:** Erfordert die Berechtigung: `employee:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/applications/{id}`

**Bewerbung abrufen.** Angaben zur bewerbenden Person samt hochgeladenen Unterlagen.

- **Zugriff:** Erfordert die Berechtigung: `application:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

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

- **Zugriff:** Erfordert die Berechtigung: `invoice:create`.
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

- **Zugriff:** Erfordert die Berechtigung: `invoice:send`.
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

- **Zugriff:** Erfordert die Berechtigung: `payment:create`.
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

- **Zugriff:** Erfordert die Berechtigung: `invoice:update`.
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

- **Zugriff:** Erfordert die Berechtigung: `expense:create`.
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

### `PATCH /api/expenses/{id}`

**Ausgabe korrigieren.** Betrag, Satz und Summe hängen zusammen und werden immer gemeinsam neu gerechnet, damit keine Ausgabe mit unstimmiger MWST entsteht.

- **Zugriff:** Erfordert die Berechtigung: `expense:update`.
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
| `supplierId` | string | – | min. 1 Zeichen |
| `category` | string | – | `MATERIAL` \| `EQUIPMENT` \| `VEHICLE` \| `FUEL` \| `INSURANCE` \| `RENT` \| `SALARY` \| `SOCIAL_SECURITY` \| `MARKETING` \| `SOFTWARE` \| `TRAINING` \| `TAXES` \| `OTHER`, Standard `"MATERIAL"` |
| `description` | string | – | min. 3 Zeichen, max. 300 Zeichen |
| `reference` | string | – | max. 120 Zeichen |
| `expenseDate` | string | – | – |
| `netAmount` | number | – | ≥ 0, ≤ 9999999 |
| `vatRate` | number | – | ≥ 0, ≤ 30, Standard `8.1` |
| `paid` | boolean | – | Standard `false` |
| `paidAt` | string | – | date-time |
| `vatDeductible` | boolean | – | Standard `true` |
| `notes` | string | – | max. 2000 Zeichen |
| `fileIds` | string[] | – | max. 10 Einträge, Standard `[]` |

### `DELETE /api/expenses/{id}`

**Ausgabe löschen.** Nicht möglich, sobald die Ausgabe in einem Buchhaltungsexport enthalten war: die Treuhandstelle hat den Beleg dann bereits verbucht, und ein Loch in der exportierten Reihe fällt erst beim Abschluss auf.

- **Zugriff:** Erfordert die Berechtigung: `expense:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `PATCH /api/invoices/{id}`

**Rechnungsentwurf ändern.** Nur Entwürfe. Eine ausgestellte Rechnung ist ein Beleg: Betrag, Datum und Nummer sind ab dem Ausstellen unveränderlich, weil die Buchhaltung darauf aufbaut und die Kundschaft sie erhalten hat. Korrigiert wird über eine Gutschrift.

- **Zugriff:** Erfordert die Berechtigung: `invoice:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `PATCH /api/payments/{id}`

**Zahlung korrigieren.** Beleg, Notiz und Zahlungsdatum. Der Betrag ist nicht änderbar: er stammt vom Zahlungsanbieter oder wurde beim Verbuchen gegen den offenen Posten gerechnet. Ihn nachträglich zu verstellen liesse Rechnungssaldo und Zahlungssumme auseinanderlaufen — und das fiele erst beim Jahresabschluss auf. Ein falscher Betrag wird storniert und neu verbucht.

- **Zugriff:** Erfordert die Berechtigung: `payment:create`.
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
| `reference` | string | – | max. 120 Zeichen |
| `note` | string | – | max. 1000 Zeichen |
| `paidAt` | string | – | date-time |

### `DELETE /api/payments/{id}`

**Zahlung stornieren.** Nur von Hand erfasste Zahlungen. Was über Stripe oder Datatrans hereinkam, ist beim Zahlungsanbieter eine Tatsache; die Zeile zu entfernen hiesse, die eigene Buchhaltung gegen den Kontoauszug laufen zu lassen. Der offene Posten der Rechnung wird in derselben Transaktion zurückgesetzt — sonst bliebe sie als bezahlt stehen, obwohl kein Geld da ist.

- **Zugriff:** Erfordert die Berechtigung: `payment:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

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

- **Zugriff:** Erfordert die Berechtigung: `blog:create`.
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

- **Zugriff:** Erfordert die Berechtigung: `content:update`.
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

- **Zugriff:** Erfordert die Berechtigung: `seo:update`.
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

### `POST /api/content`

**Entwürfe freigeben, verwerfen oder zurückziehen.** Die Handlung steht im Körper (`publish`, `discard`, `unpublish`). Veröffentlichen sichert die abgelöste Fassung in der Historie und leert Inhalts- und Seitencache.

- **Zugriff:** Erfordert die Berechtigung: `content:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |

### `GET /api/content/revisions`

**Fassungsverlauf eines Bausteins.** Nur Stände, die tatsächlich einmal öffentlich waren — Zwischenstände eines Entwurfs werden nicht archiviert.

- **Zugriff:** Erfordert eine der Berechtigungen: `content:read`, `content:update`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 429, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `key` | string | ja | min. 1 Zeichen, max. 120 Zeichen |

### `POST /api/content/revisions`

**Frühere Fassung zurückholen.** Landet als Entwurf, nicht auf der Website — erst prüfen, dann freigeben.

- **Zugriff:** Erfordert die Berechtigung: `content:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `revisionId` | string | ja | min. 1 Zeichen |

### `PATCH /api/content/asset`

**Bild an einem Datensatz austauschen.** Aus der Website-Vorschau heraus. Wohin geschrieben wird, entscheidet die Erlaubnisliste in `lib/cms/assets.ts`; ein nicht gelistetes Feld antwortet mit 404. Wirkt sofort, ohne Entwurfsstand — Bilder gehören Datensätzen, nicht der Redaktion.

- **Zugriff:** Erfordert die Berechtigung: `content:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `entity` | string | ja | min. 1 Zeichen, max. 40 Zeichen |
| `id` | string | ja | min. 1 Zeichen, max. 60 Zeichen |
| `field` | string | ja | min. 1 Zeichen, max. 40 Zeichen |
| `url` | string | – | max. 2000 Zeichen |

### `GET /api/content/preview`

**Vorschaumodus schalten.** Setzt das Draft-Mode-Cookie von Next.js. Mit `nur=1` antwortet der Endpunkt mit 204 statt weiterzuleiten (nötig im `iframe` der Redaktionsmaske), mit `aus=1` schaltet er den Modus ab. `pfad` ist ein geprüftes Rücksprungziel auf dieser Domain.

- **Zugriff:** Erfordert die Berechtigung: `content:update`.
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `pfad` | string | – | max. 512 Zeichen |
| `aus` | string | – | `1` |
| `nur` | string | – | `1` |

## Katalog

### `GET /api/services`

**Leistungen auflisten.** Vollständiger Katalog, auch inaktive Einträge. Bewusst ohne Blätterung: der Katalog umfasst eine zweistellige Zahl von Einträgen, und die Verwaltung sortiert sie um — blättern hiesse, über Seitengrenzen zu sortieren.

- **Zugriff:** Erfordert die Berechtigung: `service:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `POST /api/services`

**Leistung anlegen.** Der Kurzname wird zur öffentlichen Adresse `/leistungen/{slug}` und muss eindeutig sein. Das Preismodell bestimmt, welcher Ansatz verlangt wird: PER_HOUR braucht `hourlyRate`, PER_SQM braucht `pricePerSqm`, FLAT braucht `basePrice`.

- **Zugriff:** Erfordert die Berechtigung: `service:create`.
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

- **Zugriff:** Erfordert die Berechtigung: `service:update`.
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

- **Zugriff:** Erfordert die Berechtigung: `service:delete`.
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

- **Zugriff:** Erfordert die Berechtigung: `service:create`.
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

- **Zugriff:** Erfordert die Berechtigung: `service:update`.
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

- **Zugriff:** Erfordert die Berechtigung: `service:delete`.
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

- **Zugriff:** Erfordert die Berechtigung: `service:create`.
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

- **Zugriff:** Erfordert die Berechtigung: `service:update`.
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

- **Zugriff:** Erfordert die Berechtigung: `service:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/price-rules`

**Preisregeln auflisten.** Aufsteigend nach `priority` — dieselbe Reihenfolge, in der die Preis-Engine sie anwendet.

- **Zugriff:** Erfordert die Berechtigung: `pricing:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `POST /api/price-rules`

**Preisregel anlegen.** Die Bedingung ist streng validiert: ein unbekannter Schlüssel wird abgelehnt, statt stillschweigend zu einer leeren Bedingung zu werden — die auf jeden Auftrag passt. Eine Regel ohne Wirkung (Faktor 1 und Betrag 0) wird ebenfalls abgelehnt.

- **Zugriff:** Erfordert die Berechtigung: `pricing:update`.
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

- **Zugriff:** Erfordert die Berechtigung: `pricing:update`.
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

- **Zugriff:** Erfordert die Berechtigung: `pricing:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/catalog/reorder`

**Reihenfolge setzen.** Übergeben wird die vollständige Reihenfolge als Liste von IDs; die Positionen vergibt der Server aus dem Index. So kann kein Zustand entstehen, in dem zwei Einträge dieselbe Position tragen. Alles läuft in einer Transaktion.

- **Zugriff:** Erfordert die Berechtigung: `service:update`.
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

- **Zugriff:** Erfordert die Berechtigung: `pricing:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `POST /api/tax-rates`

**Steuersatz anlegen.** Wird der neue Satz als Standard markiert, verliert der bisherige diese Markierung in derselben Transaktion — zwei Standardsätze wären ein Zustand, in dem die Sortierung entscheidet.

- **Zugriff:** Erfordert die Berechtigung: `pricing:update`.
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

- **Zugriff:** Erfordert die Berechtigung: `pricing:update`.
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

- **Zugriff:** Erfordert die Berechtigung: `pricing:update`.
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

- **Zugriff:** Erfordert die Berechtigung: `coupon:create`.
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

- **Zugriff:** Erfordert die Berechtigung: `coupon:update`.
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

- **Zugriff:** Erfordert die Berechtigung: `coupon:delete`.
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
| `beforeUrl` | string | ja | max. 2000 Zeichen |
| `afterUrl` | string | ja | max. 2000 Zeichen |
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
| `beforeUrl` | string | – | max. 2000 Zeichen |
| `afterUrl` | string | – | max. 2000 Zeichen |
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

### `GET /api/navigation`

**Menüpunkte auflisten.** Alle Punkte aller Orte, auch abgeschaltete.

- **Zugriff:** Erfordert die Berechtigung: `navigation:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `POST /api/navigation`

**Menüpunkt anlegen.** Das Ziel wird gegen dieselbe Positivliste geprüft wie bei einem Handlungsaufruf. Ein Menüpunkt mit javascript:-Ziel stünde auf jeder Seite der Website, nicht nur auf einer.

- **Zugriff:** Erfordert die Berechtigung: `navigation:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `location` | string | ja | `HEADER` \| `HEADER_PANEL` \| `FOOTER_SERVICES` \| `FOOTER_COMPANY` \| `FOOTER_LEGAL` |
| `label` | string | ja | min. 2 Zeichen, max. 40 Zeichen |
| `href` | string | ja | min. 1 Zeichen, max. 500 Zeichen |
| `description` | string | – | max. 120 Zeichen |
| `icon` | string | – | max. 40 Zeichen |
| `newTab` | boolean | – | Standard `false` |
| `parentId` | string | – | min. 1 Zeichen |
| `position` | integer | – | ≥ 0, ≤ 999, Standard `0` |
| `active` | boolean | – | Standard `true` |

### `PATCH /api/navigation/{id}`

**Menüpunkt ändern.** Teil-Update von Beschriftung, Ziel, Ort und Sichtbarkeit.

- **Zugriff:** Erfordert die Berechtigung: `navigation:update`.
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
| `location` | string | – | `HEADER` \| `HEADER_PANEL` \| `FOOTER_SERVICES` \| `FOOTER_COMPANY` \| `FOOTER_LEGAL` |
| `label` | string | – | min. 2 Zeichen, max. 40 Zeichen |
| `href` | string | – | min. 1 Zeichen, max. 500 Zeichen |
| `description` | string | – | max. 120 Zeichen |
| `icon` | string | – | max. 40 Zeichen |
| `newTab` | boolean | – | Standard `false` |
| `parentId` | string | – | min. 1 Zeichen |
| `position` | integer | – | ≥ 0, ≤ 999, Standard `0` |
| `active` | boolean | – | Standard `true` |

### `DELETE /api/navigation/{id}`

**Menüpunkt löschen.** Unterpunkte gehen mit — ein Punkt im Aufklappbereich ohne seinen Aufklapper wäre nirgends erreichbar. Die Antwort nennt unter removedChildren, wie viele das betraf.

- **Zugriff:** Erfordert die Berechtigung: `navigation:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/navigation/reorder`

**Reihenfolge im Menü setzen.** Je Ort und je Aufklappbereich getrennt: die Positionen zweier verschiedener Menüs haben nichts miteinander zu tun.

- **Zugriff:** Erfordert die Berechtigung: `navigation:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `location` | string | ja | `HEADER` \| `HEADER_PANEL` \| `FOOTER_SERVICES` \| `FOOTER_COMPANY` \| `FOOTER_LEGAL` |
| `parentId` | string | – | min. 1 Zeichen |
| `ids` | string[] | ja | min. 1 Einträge, max. 100 Einträge |

### `GET /api/legal`

**Rechtstexte auflisten.** Noch nicht erfasste erscheinen als leere Platzhalter mit version 0. Sonst sähe die Redaktion eine kurze Liste und wüsste nicht, dass die Datenschutzerklärung fehlt — und genau deren Fehlen ist ein Rechtsmangel.

- **Zugriff:** Erfordert die Berechtigung: `legal:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `GET /api/legal/{slug}`

**Rechtstext abrufen.** Einer von: impressum, datenschutz, agb, cookies.

- **Zugriff:** Erfordert die Berechtigung: `legal:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `PUT /api/legal/{slug}`

**Rechtstext setzen.** PUT, weil der Körper den vollständigen Text beschreibt. Ob eine Änderung eine neue Fassung ist, entscheidet die Redaktion über newVersion und nicht ein Zähler: eine korrigierte Kommasetzung ist keine, eine geänderte Aufbewahrungsfrist schon. Die Fassungsnummer ist der Bezugspunkt, wenn jemand fragt, welchen AGB er zugestimmt hat. Löschen gibt es nicht — die vier Adressen sind aus Fusszeile, Cookie-Hinweis und E-Mails verlinkt.

- **Zugriff:** Erfordert die Berechtigung: `legal:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `title` | string | ja | min. 3 Zeichen, max. 140 Zeichen |
| `body` | string | ja | min. 100 Zeichen, max. 100000 Zeichen |
| `effectiveFrom` | string | ja | – |
| `newVersion` | boolean | – | Standard `false` |

### `DELETE /api/reviews/{id}`

**Bewertung löschen.** Eine veröffentlichte Bewertung lässt sich nicht löschen, nur verbergen. Eine Kundschaft hat sie geschrieben und darauf vertraut, dass sie steht; sie spurlos verschwinden zu lassen, wäre unredlich — und die Lesenden bekämen nur noch die guten zu sehen. Verbergen ist im Prüfprotokoll nachvollziehbar.

- **Zugriff:** Erfordert die Berechtigung: `review:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/blog`

**Beiträge auflisten.** Alle Beiträge, auch Entwürfe. Ohne Blätterung — ein Reinigungsbetrieb schreibt keine tausend Artikel.

- **Zugriff:** Erfordert die Berechtigung: `blog:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `GET /api/blog/{id}`

**Beitrag abrufen.** Ein Beitrag samt Entwurfsfassung, Kategorie und Autorin.

- **Zugriff:** Erfordert die Berechtigung: `blog:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `PATCH /api/blog/{id}`

**Beitrag ändern.** Der Statuswechsel verlangt zusätzlich blog:publish — wer Texte redigiert, muss nicht auch veröffentlichen dürfen. Das Veröffentlichungsdatum entsteht beim ersten Veröffentlichen und ändert sich danach nicht: sonst rutschte ein Beitrag bei jeder Korrektur im Feed und in Suchmaschinen nach oben, als wäre er neu.

- **Zugriff:** Erfordert die Berechtigung: `blog:update`.
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
| `title` | string | – | min. 5 Zeichen, max. 200 Zeichen |
| `excerpt` | string | – | min. 10 Zeichen, max. 500 Zeichen |
| `content` | string | – | min. 100 Zeichen, max. 60000 Zeichen |
| `seoTitle` | string | – | max. 120 Zeichen |
| `seoDescription` | string | – | max. 300 Zeichen |
| `keywords` | string[] | – | max. 15 Einträge, Standard `[]` |
| `categorySlug` | string | – | max. 80 Zeichen |
| `status` | string | – | `DRAFT` \| `SCHEDULED` \| `PUBLISHED` \| `ARCHIVED` |

### `DELETE /api/blog/{id}`

**Beitrag löschen.** Ein veröffentlichter Beitrag wird archiviert, nicht gelöscht: seine Adresse ist verlinkt und möglicherweise indexiert. Entwürfe lassen sich entfernen.

- **Zugriff:** Erfordert die Berechtigung: `blog:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

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
| `legalName` | union | – | – |
| `email` | string | ja | email, max. 200 Zeichen |
| `phone` | union | – | – |
| `whatsapp` | union | – | – |
| `website` | union | – | – |
| `street` | string | ja | min. 2 Zeichen, max. 140 Zeichen |
| `streetNo` | union | – | – |
| `postalCode` | string | ja | – |
| `city` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `vatNumber` | union | – | – |
| `iban` | union | – | – |
| `qrIban` | union | – | – |
| `bankName` | union | – | – |
| `logoUrl` | union | – | – |
| `logoDarkUrl` | union | – | – |
| `faviconUrl` | union | – | – |
| `mapsUrl` | union | – | – |
| `facebookUrl` | union | – | – |
| `instagramUrl` | union | – | – |
| `linkedinUrl` | union | – | – |
| `tiktokUrl` | union | – | – |
| `youtubeUrl` | union | – | – |

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

### `GET /api/holidays`

**Feiertage auflisten.** Feiertage und Betriebsferien. Dieselbe Berechtigung wie die Öffnungszeiten: beides beschreibt, wann der Betrieb arbeitet.

- **Zugriff:** Erfordert die Berechtigung: `company:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `POST /api/holidays`

**Feiertag erfassen.** Der Tag wird im Buchungsassistenten gesperrt und zählt bei Abwesenheiten nicht als Ferientag. Das Datum ist ein Kalendertag (JJJJ-MM-TT), kein Zeitstempel.

- **Zugriff:** Erfordert die Berechtigung: `company:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `name` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `date` | string | ja | – |
| `recurring` | boolean | – | Standard `false` |
| `canton` | string | – | – |

### `PATCH /api/holidays/{id}`

**Feiertag ändern.** Name, Datum, Kanton oder jährliche Wiederholung.

- **Zugriff:** Erfordert die Berechtigung: `company:update`.
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
| `name` | string | – | min. 2 Zeichen, max. 80 Zeichen |
| `date` | string | – | – |
| `recurring` | boolean | – | Standard `false` |
| `canton` | string | – | – |

### `DELETE /api/holidays/{id}`

**Feiertag entfernen.** Nur künftige Tage. Ein vergangener Feiertag ist Grundlage der Ferienabrechnung des Jahres und bleibt stehen.

- **Zugriff:** Erfordert die Berechtigung: `company:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/automations`

**Automatisierungen auflisten.** Regeln samt Aktionen und Zahl der bisherigen Läufe.

- **Zugriff:** Erfordert die Berechtigung: `automation:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `POST /api/automations`

**Automatisierung anlegen.** Mindestens eine Aktion ist Pflicht: eine Regel ohne Aktion löst aus und tut nichts — sie stünde in der Liste und wäre nicht als wirkungslos erkennbar.

- **Zugriff:** Erfordert die Berechtigung: `automation:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `name` | string | ja | min. 3 Zeichen, max. 120 Zeichen |
| `description` | string | – | max. 500 Zeichen |
| `trigger` | string | ja | `BOOKING_CREATED` \| `BOOKING_CONFIRMED` \| `BOOKING_REMINDER_24H` \| `BOOKING_REMINDER_2H` \| `BOOKING_COMPLETED` \| `BOOKING_CANCELLED` \| `QUOTE_SENT` \| `QUOTE_ACCEPTED` \| `QUOTE_EXPIRING` \| `INVOICE_ISSUED` \| `INVOICE_DUE_SOON` \| `INVOICE_OVERDUE` \| `JOB_ASSIGNED` \| `JOB_COMPLETED` \| `CUSTOMER_BIRTHDAY` \| `REVIEW_REQUEST` \| `LEAD_CREATED` \| `LEAD_IDLE` \| `TASK_DUE` \| `RECURRING_BOOKING_GENERATE` |
| `conditions` | object | – | Standard `{}` |
| `delayMinutes` | integer | – | ≥ -43200, ≤ 129600, Standard `0` |
| `active` | boolean | – | Standard `true` |
| `actions` | object[] | ja | min. 1 Einträge, max. 10 Einträge |
| `actions[].type` | string | ja | `SEND_EMAIL` \| `SEND_SMS` \| `CREATE_TASK` \| `CREATE_NOTIFICATION` \| `UPDATE_STATUS` \| `WEBHOOK` \| `AI_GENERATE` |
| `actions[].config` | object | – | Standard `{}` |
| `actions[].position` | integer | – | ≥ 0, ≤ 99, Standard `0` |

### `PATCH /api/automations/{id}`

**Automatisierung ändern.** Die Aktionsliste ist der gewünschte Endzustand, kein Zuwachs.

- **Zugriff:** Erfordert die Berechtigung: `automation:update`.
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
| `name` | string | – | min. 3 Zeichen, max. 120 Zeichen |
| `description` | string | – | max. 500 Zeichen |
| `trigger` | string | – | `BOOKING_CREATED` \| `BOOKING_CONFIRMED` \| `BOOKING_REMINDER_24H` \| `BOOKING_REMINDER_2H` \| `BOOKING_COMPLETED` \| `BOOKING_CANCELLED` \| `QUOTE_SENT` \| `QUOTE_ACCEPTED` \| `QUOTE_EXPIRING` \| `INVOICE_ISSUED` \| `INVOICE_DUE_SOON` \| `INVOICE_OVERDUE` \| `JOB_ASSIGNED` \| `JOB_COMPLETED` \| `CUSTOMER_BIRTHDAY` \| `REVIEW_REQUEST` \| `LEAD_CREATED` \| `LEAD_IDLE` \| `TASK_DUE` \| `RECURRING_BOOKING_GENERATE` |
| `conditions` | object | – | Standard `{}` |
| `delayMinutes` | integer | – | ≥ -43200, ≤ 129600, Standard `0` |
| `active` | boolean | – | Standard `true` |
| `actions` | object[] | – | min. 1 Einträge, max. 10 Einträge |
| `actions[].type` | string | ja | `SEND_EMAIL` \| `SEND_SMS` \| `CREATE_TASK` \| `CREATE_NOTIFICATION` \| `UPDATE_STATUS` \| `WEBHOOK` \| `AI_GENERATE` |
| `actions[].config` | object | – | Standard `{}` |
| `actions[].position` | integer | – | ≥ 0, ≤ 99, Standard `0` |

### `DELETE /api/automations/{id}`

**Automatisierung löschen.** Nur ohne Laufhistorie. Die Läufe belegen, warum welche Nachricht verschickt wurde; ohne die zugehörige Regel wären sie nicht mehr lesbar. Schalten Sie die Regel stattdessen ab.

- **Zugriff:** Erfordert die Berechtigung: `automation:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/settings`

**Betriebseinstellungen.** Vorlaufzeiten, Stornofristen, Mahnwesen, Bewertungsanfragen. Fehlende Schlüssel liefern den Auslieferungswert.

- **Zugriff:** Erfordert die Berechtigung: `settings:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `PATCH /api/settings`

**Betriebseinstellungen ändern.** Teil-Update: gesendet wird nur, was sich ändert. Ein vollständiges Überschreiben würde bei zwei gleichzeitig geöffneten Masken die Änderung der jeweils anderen still verwerfen. Das Schema ist streng — ein freies JSON-Feld wäre die Stelle, an der ein Tippfehler im Schlüssel eine Einstellung wirkungslos macht, ohne dass es jemand bemerkt.

- **Zugriff:** Erfordert die Berechtigung: `settings:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `bookingLeadDays` | integer | – | ≥ 0, ≤ 365 |
| `bookingMinNoticeHours` | integer | – | ≥ 0, ≤ 720 |
| `cancellationDeadlineHours` | integer | – | ≥ 0, ≤ 720 |
| `smsRemindersEnabled` | boolean | – | – |
| `autoDunningEnabled` | boolean | – | – |
| `firstReminderAfterDays` | integer | – | ≥ 1, ≤ 90 |
| `reviewRequestAfterDays` | integer | – | ≥ 0, ≤ 90 |
| `moderateReviews` | boolean | – | – |

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

## Betrieb

### `GET /api/service-areas`

**Einsatzgebiet auflisten.** Postleitzahlen, Anfahrtszeiten und Pauschalen.

- **Zugriff:** Erfordert die Berechtigung: `serviceArea:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `POST /api/service-areas`

**Postleitzahl aufnehmen.** Die Anfahrtspauschale fliesst in jeden künftigen Preis; die Änderung wird protokolliert und der Preis-Zwischenspeicher geleert.

- **Zugriff:** Erfordert die Berechtigung: `serviceArea:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `postalCode` | string | ja | – |
| `city` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `canton` | string | – | Standard `"BE"` |
| `travelFee` | number | – | ≥ 0, ≤ 9999999, Standard `0` |
| `travelMinutes` | integer | – | ≥ 0, ≤ 240, Standard `0` |
| `active` | boolean | – | Standard `true` |
| `lat` | number | – | ≥ -90, ≤ 90 |
| `lng` | number | – | ≥ -180, ≤ 180 |

### `PATCH /api/service-areas/{id}`

**Einsatzgebiet ändern.** Teil-Update von Ort, Pauschale, Anfahrtszeit und Sichtbarkeit.

- **Zugriff:** Erfordert die Berechtigung: `serviceArea:update`.
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
| `postalCode` | string | – | – |
| `city` | string | – | min. 2 Zeichen, max. 80 Zeichen |
| `canton` | string | – | Standard `"BE"` |
| `travelFee` | number | – | ≥ 0, ≤ 9999999, Standard `0` |
| `travelMinutes` | integer | – | ≥ 0, ≤ 240, Standard `0` |
| `active` | boolean | – | Standard `true` |
| `lat` | number | – | ≥ -90, ≤ 90 |
| `lng` | number | – | ≥ -180, ≤ 180 |

### `DELETE /api/service-areas/{id}`

**Postleitzahl entfernen.** Nicht möglich, solange dort Einsätze geplant sind — die Preisberechnung für eine Verschiebung schlüge fehl. Setzen Sie das Gebiet stattdessen inaktiv.

- **Zugriff:** Erfordert die Berechtigung: `serviceArea:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/service-areas/bulk`

**Mehrere Postleitzahlen auf einmal.** Ohne overwrite bleiben bestehende Einträge unangetastet — der Normalfall beim Nachtragen einer Region. Die Antwort nennt, wie viele angelegt, überschrieben und übersprungen wurden.

- **Zugriff:** Erfordert die Berechtigung: `serviceArea:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `areas` | object[] | ja | min. 1 Einträge, max. 500 Einträge |
| `areas[].postalCode` | string | ja | – |
| `areas[].city` | string | ja | min. 2 Zeichen, max. 80 Zeichen |
| `areas[].canton` | string | – | Standard `"BE"` |
| `areas[].travelFee` | number | – | ≥ 0, ≤ 9999999, Standard `0` |
| `areas[].travelMinutes` | integer | – | ≥ 0, ≤ 240, Standard `0` |
| `areas[].active` | boolean | – | Standard `true` |
| `areas[].lat` | number | – | ≥ -90, ≤ 90 |
| `areas[].lng` | number | – | ≥ -180, ≤ 180 |
| `overwrite` | boolean | – | Standard `false` |

## Kommunikation

### `GET /api/newsletter`

**Abonnentenliste.** Ausgetragene erscheinen nicht: sie haben widersprochen, und eine Liste, aus der man sie versehentlich wieder anschreibt, ist genau der Fehler, den das Austragen verhindern soll.

- **Zugriff:** Erfordert die Berechtigung: `newsletter:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `DELETE /api/newsletter/{id}`

**Abonnement austragen.** Die Zeile bleibt bestehen und wird als ausgetragen markiert — sie ist der Nachweis, dass widersprochen wurde. Ändern gibt es bewusst nicht: die E-Mail-Adresse ist der Identifikator, und sie zu ändern hiesse, jemand anderen anzuschreiben.

- **Zugriff:** Erfordert die Berechtigung: `newsletter:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/templates`

**E-Mail- und SMS-Vorlagen.** Anlegen und Löschen gibt es bewusst nicht: der Schlüssel steht im Code, dort wird die Vorlage nachgeschlagen. Eine frei angelegte riefe niemand auf; eine gelöschte liesse eine Bestätigungsmail ausfallen.

- **Zugriff:** Erfordert die Berechtigung: `template:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `PATCH /api/templates/email/{id}`

**E-Mail-Vorlage ändern.** Platzhalter dürfen wegfallen, aber keine neuen dazukommen: ein Platzhalter, den der Versand nicht füllt, erscheint wörtlich in der E-Mail an die Kundschaft. Die Fehlermeldung nennt die verfügbaren.

- **Zugriff:** Erfordert die Berechtigung: `template:update`.
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
| `subject` | string | ja | min. 3 Zeichen, max. 200 Zeichen |
| `bodyHtml` | string | ja | min. 20 Zeichen, max. 50000 Zeichen |
| `bodyText` | string | – | max. 20000 Zeichen |
| `active` | boolean | – | – |

### `PATCH /api/templates/sms/{id}`

**SMS-Vorlage ändern.** Höchstens 480 Zeichen — darüber kostet der Versand mehr als drei SMS je Empfänger.

- **Zugriff:** Erfordert die Berechtigung: `template:update`.
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
| `body` | string | ja | min. 10 Zeichen, max. 480 Zeichen |
| `active` | boolean | – | – |

## Führung: Kennzahlen

### `GET /api/bi/kpis`

**Kennzahlen mit jüngstem Wert.** Alle Definitionen mit aktuellem und vorangehendem Monatswert, Vorjahresvergleich und Zielwert.

- **Zugriff:** Erfordert die Berechtigung: `kpi:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 429, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `group` | string | – | max. 60 Zeichen |
| `active` | string | – | `0` \| `1` |
| `q` | string | – | max. 120 Zeichen |

### `POST /api/bi/kpis`

**Kennzahl anlegen.** Berechnete Kennzahlen brauchen einen Rechner im Code (422 sonst); manuelle werden von Hand nachgeführt.

- **Zugriff:** Erfordert die Berechtigung: `kpi:manage`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `key` | string | ja | max. 80 Zeichen |
| `label` | string | ja | min. 2 Zeichen, max. 120 Zeichen |
| `description` | string | – | max. 1000 Zeichen |
| `group` | string | – | min. 2 Zeichen, max. 60 Zeichen, Standard `"Finanzen"` |
| `unit` | string | – | `CURRENCY` \| `PERCENT` \| `COUNT` \| `DAYS` \| `HOURS` \| `RATIO`, Standard `"CURRENCY"` |
| `direction` | string | – | `UP_IS_GOOD` \| `DOWN_IS_GOOD`, Standard `"UP_IS_GOOD"` |
| `source` | string | – | `DERIVED` \| `MANUAL`, Standard `"MANUAL"` |
| `periods` | string[] | – | min. 1 Einträge, max. 5 Einträge, Standard `["MONTH"]` |
| `targetValue` | number | – | ≥ -1000000000000, ≤ 1000000000000 |
| `warnValue` | number | – | ≥ -1000000000000, ≤ 1000000000000 |
| `healthWeight` | integer | – | ≥ 0, ≤ 100, Standard `0` |
| `active` | boolean | – | Standard `true` |
| `sortOrder` | integer | – | ≥ 0, ≤ 10000, Standard `0` |

### `GET /api/bi/kpis/{id}`

**Kennzahl mit Zielwerten.** Definition samt periodenbezogenen Zielwerten.

- **Zugriff:** Erfordert die Berechtigung: `kpi:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `PATCH /api/bi/kpis/{id}`

**Kennzahl ändern.** Zielwert, Warnschwelle, Gewicht und Anzeige. Der Schlüssel bleibt — er hängt an Snapshots. Warnschwelle und Ziel müssen zur Richtung passen (422).

- **Zugriff:** Erfordert die Berechtigung: `kpi:manage`.
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
| `label` | string | – | min. 2 Zeichen, max. 120 Zeichen |
| `description` | string | – | max. 1000 Zeichen |
| `group` | string | – | min. 2 Zeichen, max. 60 Zeichen, Standard `"Finanzen"` |
| `unit` | string | – | `CURRENCY` \| `PERCENT` \| `COUNT` \| `DAYS` \| `HOURS` \| `RATIO`, Standard `"CURRENCY"` |
| `direction` | string | – | `UP_IS_GOOD` \| `DOWN_IS_GOOD`, Standard `"UP_IS_GOOD"` |
| `periods` | string[] | – | min. 1 Einträge, max. 5 Einträge, Standard `["MONTH"]` |
| `targetValue` | number | – | ≥ -1000000000000, ≤ 1000000000000 |
| `warnValue` | number | – | ≥ -1000000000000, ≤ 1000000000000 |
| `healthWeight` | integer | – | ≥ 0, ≤ 100, Standard `0` |
| `active` | boolean | – | Standard `true` |
| `sortOrder` | integer | – | ≥ 0, ≤ 10000, Standard `0` |

### `DELETE /api/bi/kpis/{id}`

**Kennzahl löschen.** Nicht möglich, solange Schlüsselergebnisse daran messen (422).

- **Zugriff:** Erfordert die Berechtigung: `kpi:manage`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/bi/kpis/{id}/series`

**Verlauf einer Kennzahl.** Festgeschriebene Snapshots einer Periodenart, älteste zuerst, mit Ziel- und Vorjahreswert.

- **Zugriff:** Erfordert die Berechtigung: `kpi:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `period` | string | – | `DAY` \| `WEEK` \| `MONTH` \| `QUARTER` \| `YEAR`, Standard `"MONTH"` |
| `from` | string | – | date-time |
| `to` | string | – | date-time |
| `limit` | integer | – | ≥ 1, ≤ 120, Standard `24` |

### `POST /api/bi/kpis/{id}/value`

**Manuellen Wert eintragen.** Nur für Kennzahlen mit Herkunft MANUAL — ein Handwert an einer berechneten würde vom Nachtlauf überschrieben (422).

- **Zugriff:** Erfordert die Berechtigung: `kpi:manage`.
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
| `period` | string | – | `DAY` \| `WEEK` \| `MONTH` \| `QUARTER` \| `YEAR`, Standard `"MONTH"` |
| `periodStart` | string | ja | – |
| `value` | number | ja | ≥ -1000000000000, ≤ 1000000000000 |
| `note` | string | – | max. 500 Zeichen |

### `POST /api/bi/kpis/{id}/targets`

**Zielwert für eine Periode.** Die Ausnahme vom Dauerwert, etwa ein höheres Ziel im Saisonquartal.

- **Zugriff:** Erfordert die Berechtigung: `kpi:manage`.
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
| `period` | string | – | `DAY` \| `WEEK` \| `MONTH` \| `QUARTER` \| `YEAR`, Standard `"MONTH"` |
| `periodStart` | string | ja | – |
| `targetValue` | number | ja | ≥ -1000000000000, ≤ 1000000000000 |
| `note` | string | – | max. 500 Zeichen |

### `PATCH /api/bi/kpis/weights`

**Gewichte im Gesundheitswert.** Mehrere Gewichte in einem Aufruf; mindestens eines muss über null liegen (422).

- **Zugriff:** Erfordert die Berechtigung: `kpi:manage`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `weights` | object[] | ja | min. 1 Einträge, max. 100 Einträge |
| `weights[].key` | string | ja | max. 80 Zeichen |
| `weights[].healthWeight` | integer | ja | ≥ 0, ≤ 100 |

### `GET /api/bi/cockpit`

**Führungscockpit.** Gesundheitswert mit Herleitung, Kennzahlgruppen, Auffälligkeiten, Ziele, Risikomatrix, Fälliges. Finanzgruppen nur mit `cockpit:financials`.

- **Zugriff:** Erfordert die Berechtigung: `cockpit:view`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 429, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `period` | string | – | `MONTH` \| `QUARTER` \| `YEAR`, Standard `"MONTH"` |

### `GET /api/bi/cockpit/health`

**Gesundheitswert.** Aktueller Wert mit Komponenten, Teilnoten und Verlauf der letzten zwölf Monate.

- **Zugriff:** Erfordert die Berechtigung: `cockpit:view`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `POST /api/bi/cockpit/health`

**Gesundheitswert festschreiben.** Schreibt den heutigen Wert samt Herleitung — sonst macht das der Nachtlauf.

- **Zugriff:** Erfordert die Berechtigung: `kpi:manage`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 422, 429, 500

### `GET /api/bi/cockpit/insights`

**Auffälligkeiten.** Regelbasierte Hinweise mit Verweis auf die Stelle, wo man etwas tun kann.

- **Zugriff:** Erfordert die Berechtigung: `cockpit:view`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

## Führung: Ziele

### `GET /api/bi/objectives`

**Ziele auflisten.** Strategien, Ziele und Initiativen. Mitarbeitende sehen die eigenen und die freigegebenen Firmenziele — die Grenze zieht der Dienst.

- **Zugriff:** Erfordert eine der Berechtigungen: `objective:read`, `objective:read_own`.
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
| `horizon` | string | – | `STRATEGY` \| `OBJECTIVE` \| `INITIATIVE` |
| `level` | string | – | `COMPANY` \| `DEPARTMENT` \| `PERSONAL` |
| `status` | string | – | `DRAFT` \| `ACTIVE` \| `AT_RISK` \| `ACHIEVED` \| `MISSED` \| `CANCELLED` |
| `fiscalYear` | integer | – | ≥ 2000, ≤ 2100 |
| `quarter` | integer | – | ≥ 1, ≤ 4 |
| `ownerId` | string | – | min. 1 Zeichen |
| `parentId` | string | – | min. 1 Zeichen |
| `archiv` | string | – | `0` \| `1`, Standard `"0"` |

### `POST /api/bi/objectives`

**Ziel anlegen.** Mit Flughöhe, Ebene, Zeitraum und Prüfzyklus. Die verantwortliche Person wird benachrichtigt.

- **Zugriff:** Erfordert die Berechtigung: `objective:create`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `horizon` | string | – | `STRATEGY` \| `OBJECTIVE` \| `INITIATIVE`, Standard `"OBJECTIVE"` |
| `level` | string | – | `COMPANY` \| `DEPARTMENT` \| `PERSONAL`, Standard `"COMPANY"` |
| `status` | string | – | `DRAFT` \| `ACTIVE` \| `AT_RISK` \| `ACHIEVED` \| `MISSED` \| `CANCELLED`, Standard `"DRAFT"` |
| `title` | string | ja | min. 3 Zeichen, max. 200 Zeichen |
| `description` | string | – | max. 6000 Zeichen |
| `department` | string | – | max. 80 Zeichen |
| `priority` | string | – | `LOW` \| `NORMAL` \| `HIGH` \| `URGENT`, Standard `"NORMAL"` |
| `parentId` | string | – | min. 1 Zeichen |
| `ownerId` | string | – | min. 1 Zeichen |
| `fiscalYear` | integer | – | ≥ 2000, ≤ 2100 |
| `quarter` | integer | – | ≥ 1, ≤ 4 |
| `startsOn` | string | – | – |
| `endsOn` | string | – | – |
| `reviewIntervalDays` | integer | – | ≥ 7, ≤ 730 |
| `budgetAmount` | number | – | ≥ 0, ≤ 1000000000 |
| `expectedRoiPct` | number | – | ≥ -100, ≤ 10000 |

### `GET /api/bi/objectives/timeline`

**Roadmap.** Ziele mit Zeitraum für die Zeitachse.

- **Zugriff:** Erfordert eine der Berechtigungen: `objective:read`, `objective:read_own`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 429, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `from` | string | – | date-time |
| `to` | string | – | date-time |
| `horizon` | string | – | `STRATEGY` \| `OBJECTIVE` \| `INITIATIVE` |
| `status` | string | – | `DRAFT` \| `ACTIVE` \| `AT_RISK` \| `ACHIEVED` \| `MISSED` \| `CANCELLED` |

### `GET /api/bi/objectives/{id}`

**Ziel mit Schlüsselergebnissen.** Samt Check-ins, Massnahmen, Unterzielen und Sitzungen.

- **Zugriff:** Erfordert eine der Berechtigungen: `objective:read`, `objective:read_own`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `PATCH /api/bi/objectives/{id}`

**Ziel ändern.** Ein Ziel kann nicht sein eigenes übergeordnetes Ziel sein (422).

- **Zugriff:** Erfordert die Berechtigung: `objective:update`.
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
| `horizon` | string | – | `STRATEGY` \| `OBJECTIVE` \| `INITIATIVE`, Standard `"OBJECTIVE"` |
| `level` | string | – | `COMPANY` \| `DEPARTMENT` \| `PERSONAL`, Standard `"COMPANY"` |
| `status` | string | – | `DRAFT` \| `ACTIVE` \| `AT_RISK` \| `ACHIEVED` \| `MISSED` \| `CANCELLED`, Standard `"DRAFT"` |
| `title` | string | – | min. 3 Zeichen, max. 200 Zeichen |
| `description` | string | – | max. 6000 Zeichen |
| `department` | string | – | max. 80 Zeichen |
| `priority` | string | – | `LOW` \| `NORMAL` \| `HIGH` \| `URGENT`, Standard `"NORMAL"` |
| `parentId` | string | – | min. 1 Zeichen |
| `ownerId` | string | – | min. 1 Zeichen |
| `fiscalYear` | integer | – | ≥ 2000, ≤ 2100 |
| `quarter` | integer | – | ≥ 1, ≤ 4 |
| `startsOn` | string | – | – |
| `endsOn` | string | – | – |
| `reviewIntervalDays` | integer | – | ≥ 7, ≤ 730 |
| `budgetAmount` | number | – | ≥ 0, ≤ 1000000000 |
| `expectedRoiPct` | number | – | ≥ -100, ≤ 10000 |

### `DELETE /api/bi/objectives/{id}`

**Ziel löschen.** Papierkorb — Check-ins und Aufgaben bleiben.

- **Zugriff:** Erfordert die Berechtigung: `objective:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/bi/objectives/{id}/key-results`

**Schlüsselergebnis anlegen.** Mit Kennzahl automatisch aus dem Nachtlauf; ohne manuell.

- **Zugriff:** Erfordert die Berechtigung: `objective:update`.
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
| `title` | string | ja | min. 3 Zeichen, max. 200 Zeichen |
| `kpiDefinitionId` | string | – | min. 1 Zeichen |
| `kpiPeriod` | string | – | `DAY` \| `WEEK` \| `MONTH` \| `QUARTER` \| `YEAR` |
| `unit` | string | – | `CURRENCY` \| `PERCENT` \| `COUNT` \| `DAYS` \| `HOURS` \| `RATIO`, Standard `"COUNT"` |
| `direction` | string | – | `UP_IS_GOOD` \| `DOWN_IS_GOOD`, Standard `"UP_IS_GOOD"` |
| `startValue` | number | – | ≥ -1000000000000, ≤ 1000000000000, Standard `0` |
| `targetValue` | number | ja | ≥ -1000000000000, ≤ 1000000000000 |
| `currentValue` | number | – | ≥ -1000000000000, ≤ 1000000000000 |
| `sortOrder` | integer | – | ≥ 0, ≤ 1000, Standard `0` |

### `POST /api/bi/objectives/{id}/tasks`

**Massnahme als Aufgabe.** Eine gewöhnliche Aufgabe mit Bezug zum Ziel.

- **Zugriff:** Erfordert die Berechtigung: `objective:update`.
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
| `title` | string | ja | min. 3 Zeichen, max. 200 Zeichen |
| `description` | string | – | max. 4000 Zeichen |
| `priority` | string | – | `LOW` \| `NORMAL` \| `HIGH` \| `URGENT`, Standard `"NORMAL"` |
| `dueAt` | string | – | date-time |
| `assigneeId` | string | – | min. 1 Zeichen |

### `POST /api/bi/objectives/{id}/duplicate`

**Ziel duplizieren.** Kopie als Entwurf mit Schlüsselergebnissen, ohne Verlauf.

- **Zugriff:** Erfordert die Berechtigung: `objective:create`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 404, 409, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/bi/objectives/{id}/review`

**Prüfung abschliessen.** Setzt den nächsten Prüftermin um den Zyklus nach hinten.

- **Zugriff:** Erfordert die Berechtigung: `objective:update`.
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
| `note` | string | – | max. 2000 Zeichen |

### `PATCH /api/bi/key-results/{id}`

**Schlüsselergebnis ändern.** Start-, Ziel- und aktueller Wert; der Fortschritt wird neu gerechnet.

- **Zugriff:** Erfordert die Berechtigung: `objective:update`.
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
| `kpiDefinitionId` | string | – | min. 1 Zeichen |
| `kpiPeriod` | string | – | `DAY` \| `WEEK` \| `MONTH` \| `QUARTER` \| `YEAR` |
| `unit` | string | – | `CURRENCY` \| `PERCENT` \| `COUNT` \| `DAYS` \| `HOURS` \| `RATIO`, Standard `"COUNT"` |
| `direction` | string | – | `UP_IS_GOOD` \| `DOWN_IS_GOOD`, Standard `"UP_IS_GOOD"` |
| `startValue` | number | – | ≥ -1000000000000, ≤ 1000000000000, Standard `0` |
| `targetValue` | number | – | ≥ -1000000000000, ≤ 1000000000000 |
| `currentValue` | number | – | ≥ -1000000000000, ≤ 1000000000000 |
| `sortOrder` | integer | – | ≥ 0, ≤ 1000, Standard `0` |

### `DELETE /api/bi/key-results/{id}`

**Schlüsselergebnis löschen.** Mit Check-ins.

- **Zugriff:** Erfordert die Berechtigung: `objective:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/bi/key-results/{id}/checkin`

**Check-in.** Neuer Wert mit Kommentar. Automatische Schlüsselergebnisse weisen ab (422); Mitarbeitende nur an eigenen Zielen (404).

- **Zugriff:** Erfordert die Berechtigung: `objective:checkin`.
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
| `value` | number | ja | ≥ -1000000000000, ≤ 1000000000000 |
| `comment` | string | – | max. 2000 Zeichen |

## Führung: Finanzplanung

### `GET /api/bi/budgets`

**Budgetperioden.** Mit Plansumme und Zeilenzahl.

- **Zugriff:** Erfordert die Berechtigung: `budget:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 429, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `fiscalYear` | integer | – | ≥ 2000, ≤ 2100 |
| `status` | string | – | `DRAFT` \| `APPROVED` \| `CLOSED` |

### `POST /api/bi/budgets`

**Budgetperiode anlegen.** In der Regel ein Geschäftsjahr.

- **Zugriff:** Erfordert die Berechtigung: `budget:create`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `name` | string | ja | min. 2 Zeichen, max. 120 Zeichen |
| `fiscalYear` | integer | ja | ≥ 2000, ≤ 2100 |
| `startsOn` | string | ja | – |
| `endsOn` | string | ja | – |
| `note` | string | – | max. 2000 Zeichen |

### `GET /api/bi/budgets/{id}`

**Budget mit Zeilen.** Periode samt Zeilen und Monatsverteilung.

- **Zugriff:** Erfordert die Berechtigung: `budget:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `PATCH /api/bi/budgets/{id}`

**Budget ändern.** Nicht mehr nach Abschluss (422).

- **Zugriff:** Erfordert die Berechtigung: `budget:update`.
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
| `name` | string | – | min. 2 Zeichen, max. 120 Zeichen |
| `fiscalYear` | integer | – | ≥ 2000, ≤ 2100 |
| `startsOn` | string | – | – |
| `endsOn` | string | – | – |
| `note` | string | – | max. 2000 Zeichen |

### `DELETE /api/bi/budgets/{id}`

**Budget löschen.** Nur Entwürfe (422).

- **Zugriff:** Erfordert die Berechtigung: `budget:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/bi/budgets/{id}/variance`

**Budgetabweichung.** Plan, anteiliger Plan, Ist aus den Ausgaben, Abweichung und Hochrechnung je Zeile.

- **Zugriff:** Erfordert die Berechtigung: `budget:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `asOf` | string | – | date-time |

### `POST /api/bi/budgets/{id}/approve`

**Budget genehmigen.** Friert die Planwerte ein; Korrekturen laufen danach als Nachtrag (422 ohne Zeilen oder bereits genehmigt).

- **Zugriff:** Erfordert die Berechtigung: `budget:approve`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/bi/budgets/{id}/close`

**Budget abschliessen.** Danach ist nichts mehr änderbar.

- **Zugriff:** Erfordert die Berechtigung: `budget:approve`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/bi/budgets/{id}/lines`

**Budgetzeile anlegen.** Nur im Entwurf (422). Ohne Monatsverteilung wird gleichmässig verteilt.

- **Zugriff:** Erfordert die Berechtigung: `budget:update`.
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
| `category` | string | ja | `MATERIAL` \| `EQUIPMENT` \| `VEHICLE` \| `FUEL` \| `INSURANCE` \| `RENT` \| `SALARY` \| `SOCIAL_SECURITY` \| `MARKETING` \| `SOFTWARE` \| `TRAINING` \| `TAXES` \| `OTHER` |
| `label` | string | ja | min. 2 Zeichen, max. 120 Zeichen |
| `plannedAmount` | number | ja | ≥ 0, ≤ 9999999 |
| `monthlyPlan` | number[] | – | – |
| `note` | string | – | max. 1000 Zeichen |
| `sortOrder` | integer | – | ≥ 0, ≤ 1000, Standard `0` |

### `PATCH /api/bi/budget-lines/{id}`

**Budgetzeile ändern.** Nach Genehmigung nur Nachtrag, Bezeichnung und Notiz (422 sonst).

- **Zugriff:** Erfordert die Berechtigung: `budget:update`.
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
| `category` | string | – | `MATERIAL` \| `EQUIPMENT` \| `VEHICLE` \| `FUEL` \| `INSURANCE` \| `RENT` \| `SALARY` \| `SOCIAL_SECURITY` \| `MARKETING` \| `SOFTWARE` \| `TRAINING` \| `TAXES` \| `OTHER` |
| `label` | string | – | min. 2 Zeichen, max. 120 Zeichen |
| `plannedAmount` | number | – | ≥ 0, ≤ 9999999 |
| `monthlyPlan` | number[] | – | – |
| `note` | string | – | max. 1000 Zeichen |
| `sortOrder` | integer | – | ≥ 0, ≤ 1000, Standard `0` |
| `revisedAmount` | number | – | ≥ 0, ≤ 9999999 |

### `DELETE /api/bi/budget-lines/{id}`

**Budgetzeile löschen.** Nur im Entwurf (422).

- **Zugriff:** Erfordert die Berechtigung: `budget:update`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/bi/investments`

**Investitionen.** Mit Restwert zum heutigen Tag.

- **Zugriff:** Erfordert die Berechtigung: `investment:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 429, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `status` | string | – | `PLANNED` \| `APPROVED` \| `ORDERED` \| `ACTIVE` \| `DISPOSED` \| `CANCELLED` |
| `category` | string | – | `MATERIAL` \| `EQUIPMENT` \| `VEHICLE` \| `FUEL` \| `INSURANCE` \| `RENT` \| `SALARY` \| `SOCIAL_SECURITY` \| `MARKETING` \| `SOFTWARE` \| `TRAINING` \| `TAXES` \| `OTHER` |
| `q` | string | – | max. 120 Zeichen |

### `POST /api/bi/investments`

**Investition erfassen.** Lineare oder degressive Abschreibung braucht die Nutzungsdauer; degressiv zudem einen Restwert über null (422).

- **Zugriff:** Erfordert die Berechtigung: `investment:create`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `name` | string | ja | min. 2 Zeichen, max. 160 Zeichen |
| `category` | string | – | `MATERIAL` \| `EQUIPMENT` \| `VEHICLE` \| `FUEL` \| `INSURANCE` \| `RENT` \| `SALARY` \| `SOCIAL_SECURITY` \| `MARKETING` \| `SOFTWARE` \| `TRAINING` \| `TAXES` \| `OTHER`, Standard `"EQUIPMENT"` |
| `status` | string | – | `PLANNED` \| `APPROVED` \| `ORDERED` \| `ACTIVE` \| `DISPOSED` \| `CANCELLED`, Standard `"PLANNED"` |
| `description` | string | – | max. 4000 Zeichen |
| `supplierId` | string | – | min. 1 Zeichen |
| `purchaseAmount` | number | ja | ≥ 0, ≤ 9999999 |
| `plannedOn` | string | – | – |
| `purchasedOn` | string | – | – |
| `commissionedOn` | string | – | – |
| `disposedOn` | string | – | – |
| `disposalProceeds` | number | – | ≥ 0, ≤ 9999999 |
| `method` | string | – | `NONE` \| `STRAIGHT_LINE` \| `DECLINING`, Standard `"STRAIGHT_LINE"` |
| `usefulLifeYears` | integer | – | ≥ 1, ≤ 50 |
| `residualValue` | number | – | ≥ 0, ≤ 9999999, Standard `0` |
| `expectedAnnualBenefit` | number | – | ≥ 0, ≤ 9999999 |
| `assetTag` | string | – | max. 40 Zeichen |
| `location` | string | – | max. 120 Zeichen |
| `ownerId` | string | – | min. 1 Zeichen |

### `GET /api/bi/investments/register`

**Anlagenverzeichnis.** Anlagen in Betrieb mit Anschaffungswert, kumulierter Abschreibung und Restwert zum Stichtag.

- **Zugriff:** Erfordert die Berechtigung: `investment:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 429, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `asOf` | string | – | date-time |

### `GET /api/bi/investments/{id}`

**Investition.** Mit Bewertung, ROI und Dateien.

- **Zugriff:** Erfordert die Berechtigung: `investment:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `PATCH /api/bi/investments/{id}`

**Investition ändern.** Statuswechsel auf „in Betrieb" setzt ohne Angabe das heutige Datum als Inbetriebnahme.

- **Zugriff:** Erfordert die Berechtigung: `investment:update`.
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
| `name` | string | – | min. 2 Zeichen, max. 160 Zeichen |
| `category` | string | – | `MATERIAL` \| `EQUIPMENT` \| `VEHICLE` \| `FUEL` \| `INSURANCE` \| `RENT` \| `SALARY` \| `SOCIAL_SECURITY` \| `MARKETING` \| `SOFTWARE` \| `TRAINING` \| `TAXES` \| `OTHER`, Standard `"EQUIPMENT"` |
| `status` | string | – | `PLANNED` \| `APPROVED` \| `ORDERED` \| `ACTIVE` \| `DISPOSED` \| `CANCELLED`, Standard `"PLANNED"` |
| `description` | string | – | max. 4000 Zeichen |
| `supplierId` | string | – | min. 1 Zeichen |
| `purchaseAmount` | number | – | ≥ 0, ≤ 9999999 |
| `plannedOn` | string | – | – |
| `purchasedOn` | string | – | – |
| `commissionedOn` | string | – | – |
| `disposedOn` | string | – | – |
| `disposalProceeds` | number | – | ≥ 0, ≤ 9999999 |
| `method` | string | – | `NONE` \| `STRAIGHT_LINE` \| `DECLINING`, Standard `"STRAIGHT_LINE"` |
| `usefulLifeYears` | integer | – | ≥ 1, ≤ 50 |
| `residualValue` | number | – | ≥ 0, ≤ 9999999, Standard `0` |
| `expectedAnnualBenefit` | number | – | ≥ 0, ≤ 9999999 |
| `assetTag` | string | – | max. 40 Zeichen |
| `location` | string | – | max. 120 Zeichen |
| `ownerId` | string | – | min. 1 Zeichen |

### `DELETE /api/bi/investments/{id}`

**Investition löschen.** Papierkorb.

- **Zugriff:** Erfordert die Berechtigung: `investment:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/bi/investments/{id}/depreciation`

**Abschreibungsplan.** Restwert zum Stichtag und Plan je Nutzungsjahr — gerechnet, nicht gespeichert.

- **Zugriff:** Erfordert die Berechtigung: `investment:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `asOf` | string | – | date-time |

### `GET /api/bi/scenarios`

**Szenarien.** Nach Jahr und Art.

- **Zugriff:** Erfordert die Berechtigung: `scenario:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 429, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `fiscalYear` | integer | – | ≥ 2000, ≤ 2100 |
| `kind` | string | – | `BEST` \| `EXPECTED` \| `WORST` |

### `POST /api/bi/scenarios`

**Szenario anlegen.** Ohne Annahmen aus den letzten zwölf Monaten vorbelegt; wird sofort gerechnet.

- **Zugriff:** Erfordert die Berechtigung: `scenario:manage`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `name` | string | ja | min. 2 Zeichen, max. 120 Zeichen |
| `kind` | string | – | `BEST` \| `EXPECTED` \| `WORST`, Standard `"EXPECTED"` |
| `fiscalYear` | integer | ja | ≥ 2000, ≤ 2100 |
| `horizonMonths` | integer | – | ≥ 3, ≤ 60, Standard `12` |
| `description` | string | – | max. 2000 Zeichen |
| `openingCash` | number | – | ≥ -1000000000, ≤ 1000000000, Standard `0` |
| `assumptions` | object[] | – | max. 20 Einträge |
| `assumptions[].key` | string | ja | `jobsPerMonth` \| `averageTicket` \| `laborCostPct` \| `materialCostPct` \| `overheadPerMonth` \| `investmentPerMonth` \| `churnPct` \| `paymentDelayDays` \| `hoursPerJob` \| `targetUtilizationPct` |
| `assumptions[].label` | string | ja | min. 2 Zeichen, max. 120 Zeichen |
| `assumptions[].value` | number | ja | ≥ -1000000000, ≤ 1000000000 |
| `assumptions[].unit` | string | – | `CURRENCY` \| `PERCENT` \| `COUNT` \| `DAYS` \| `HOURS` \| `RATIO`, Standard `"COUNT"` |
| `assumptions[].monthlyChangePct` | number | – | ≥ -50, ≤ 50, Standard `0` |
| `assumptions[].note` | string | – | max. 500 Zeichen |
| `assumptions[].sortOrder` | integer | – | ≥ 0, ≤ 100, Standard `0` |

### `GET /api/bi/scenarios/suggest`

**Treiber aus dem Ist.** Vorschlag für die Annahmen aus Buchungen, Einsätzen, Ausgaben und Zahlungen der letzten zwölf Monate.

- **Zugriff:** Erfordert die Berechtigung: `scenario:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `GET /api/bi/scenarios/compare`

**Szenarien vergleichen.** Alle Szenarien eines Jahres oder ausdrücklich genannte nebeneinander.

- **Zugriff:** Erfordert die Berechtigung: `scenario:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 429, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `fiscalYear` | integer | – | ≥ 2000, ≤ 2100 |
| `ids` | string | – | max. 400 Zeichen |

### `GET /api/bi/scenarios/{id}`

**Szenario.** Mit Annahmen und gespeichertem Ergebnis.

- **Zugriff:** Erfordert die Berechtigung: `scenario:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `PATCH /api/bi/scenarios/{id}`

**Szenario ändern.** Annahmen werden als Ganzes ersetzt; danach wird neu gerechnet und das Ergebnis zurückgegeben.

- **Zugriff:** Erfordert die Berechtigung: `scenario:manage`.
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
| `name` | string | – | min. 2 Zeichen, max. 120 Zeichen |
| `kind` | string | – | `BEST` \| `EXPECTED` \| `WORST`, Standard `"EXPECTED"` |
| `fiscalYear` | integer | – | ≥ 2000, ≤ 2100 |
| `horizonMonths` | integer | – | ≥ 3, ≤ 60, Standard `12` |
| `description` | string | – | max. 2000 Zeichen |
| `openingCash` | number | – | ≥ -1000000000, ≤ 1000000000, Standard `0` |
| `assumptions` | object[] | – | max. 20 Einträge |
| `assumptions[].key` | string | ja | `jobsPerMonth` \| `averageTicket` \| `laborCostPct` \| `materialCostPct` \| `overheadPerMonth` \| `investmentPerMonth` \| `churnPct` \| `paymentDelayDays` \| `hoursPerJob` \| `targetUtilizationPct` |
| `assumptions[].label` | string | ja | min. 2 Zeichen, max. 120 Zeichen |
| `assumptions[].value` | number | ja | ≥ -1000000000, ≤ 1000000000 |
| `assumptions[].unit` | string | – | `CURRENCY` \| `PERCENT` \| `COUNT` \| `DAYS` \| `HOURS` \| `RATIO`, Standard `"COUNT"` |
| `assumptions[].monthlyChangePct` | number | – | ≥ -50, ≤ 50, Standard `0` |
| `assumptions[].note` | string | – | max. 500 Zeichen |
| `assumptions[].sortOrder` | integer | – | ≥ 0, ≤ 100, Standard `0` |

### `DELETE /api/bi/scenarios/{id}`

**Szenario löschen.** Papierkorb.

- **Zugriff:** Erfordert die Berechtigung: `scenario:manage`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/bi/scenarios/{id}/compute`

**Szenario rechnen.** Neu rechnen und Ergebnis speichern (422 ohne Annahmen).

- **Zugriff:** Erfordert die Berechtigung: `scenario:manage`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

## Führung: Risiko und Qualität

### `GET /api/bi/risks`

**Risikoregister.** Nach Schwere, mit Stufe (gering bis kritisch).

- **Zugriff:** Erfordert die Berechtigung: `risk:read`.
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
| `category` | string | – | `FINANCIAL` \| `OPERATIONAL` \| `PERSONNEL` \| `LEGAL` \| `DATA_PROTECTION` \| `IT_SECURITY` \| `REPUTATION` \| `MARKET` \| `ENVIRONMENT` |
| `status` | string | – | `IDENTIFIED` \| `ASSESSED` \| `MITIGATING` \| `ACCEPTED` \| `CLOSED` |
| `ownerId` | string | – | min. 1 Zeichen |
| `faellig` | string | – | `0` \| `1`, Standard `"0"` |

### `POST /api/bi/risks`

**Risiko erfassen.** Die Schwere setzt der Dienst aus Wahrscheinlichkeit × Auswirkung.

- **Zugriff:** Erfordert die Berechtigung: `risk:create`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `title` | string | ja | min. 3 Zeichen, max. 200 Zeichen |
| `description` | string | – | max. 6000 Zeichen |
| `category` | string | – | `FINANCIAL` \| `OPERATIONAL` \| `PERSONNEL` \| `LEGAL` \| `DATA_PROTECTION` \| `IT_SECURITY` \| `REPUTATION` \| `MARKET` \| `ENVIRONMENT`, Standard `"OPERATIONAL"` |
| `status` | string | – | `IDENTIFIED` \| `ASSESSED` \| `MITIGATING` \| `ACCEPTED` \| `CLOSED`, Standard `"IDENTIFIED"` |
| `probability` | integer | – | ≥ 1, ≤ 5, Standard `3` |
| `impact` | integer | – | ≥ 1, ≤ 5, Standard `3` |
| `residualProbability` | integer | – | ≥ 1, ≤ 5 |
| `residualImpact` | integer | – | ≥ 1, ≤ 5 |
| `potentialLoss` | number | – | ≥ 0, ≤ 9999999 |
| `mitigationPlan` | string | – | max. 6000 Zeichen |
| `ownerId` | string | – | min. 1 Zeichen |
| `reviewIntervalDays` | integer | – | ≥ 7, ≤ 730, Standard `90` |

### `GET /api/bi/risks/matrix`

**Risikomatrix.** 5×5-Matrix offener Risiken mit Stufenzählung und den fünf schwersten.

- **Zugriff:** Erfordert die Berechtigung: `risk:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `GET /api/bi/risks/{id}`

**Risiko.** Mit Massnahmen, Dateien und Prüfverlauf.

- **Zugriff:** Erfordert die Berechtigung: `risk:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `PATCH /api/bi/risks/{id}`

**Risiko ändern.** Bewertung, Status, Verantwortung, Zyklus.

- **Zugriff:** Erfordert die Berechtigung: `risk:update`.
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
| `description` | string | – | max. 6000 Zeichen |
| `category` | string | – | `FINANCIAL` \| `OPERATIONAL` \| `PERSONNEL` \| `LEGAL` \| `DATA_PROTECTION` \| `IT_SECURITY` \| `REPUTATION` \| `MARKET` \| `ENVIRONMENT`, Standard `"OPERATIONAL"` |
| `status` | string | – | `IDENTIFIED` \| `ASSESSED` \| `MITIGATING` \| `ACCEPTED` \| `CLOSED`, Standard `"IDENTIFIED"` |
| `probability` | integer | – | ≥ 1, ≤ 5, Standard `3` |
| `impact` | integer | – | ≥ 1, ≤ 5, Standard `3` |
| `residualProbability` | integer | – | ≥ 1, ≤ 5 |
| `residualImpact` | integer | – | ≥ 1, ≤ 5 |
| `potentialLoss` | number | – | ≥ 0, ≤ 9999999 |
| `mitigationPlan` | string | – | max. 6000 Zeichen |
| `ownerId` | string | – | min. 1 Zeichen |
| `reviewIntervalDays` | integer | – | ≥ 7, ≤ 730, Standard `90` |

### `DELETE /api/bi/risks/{id}`

**Risiko löschen.** Papierkorb.

- **Zugriff:** Erfordert die Berechtigung: `risk:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/bi/risks/{id}/review`

**Risiko prüfen.** Prüfung abschliessen, wahlweise neu bewerten; die Notiz landet im Verlauf.

- **Zugriff:** Erfordert die Berechtigung: `risk:update`.
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
| `note` | string | – | max. 2000 Zeichen |
| `probability` | integer | – | ≥ 1, ≤ 5 |
| `impact` | integer | – | ≥ 1, ≤ 5 |
| `residualProbability` | integer | – | ≥ 1, ≤ 5 |
| `residualImpact` | integer | – | ≥ 1, ≤ 5 |
| `status` | string | – | `IDENTIFIED` \| `ASSESSED` \| `MITIGATING` \| `ACCEPTED` \| `CLOSED` |

### `GET /api/bi/controls`

**Kontrollen.** Abläufe, Qualitätsnormen, Compliance-Pflichten und Notfallpläne.

- **Zugriff:** Erfordert die Berechtigung: `control:read`.
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
| `kind` | string | – | `SOP` \| `QUALITY_STANDARD` \| `COMPLIANCE` \| `CONTINUITY` |
| `status` | string | – | `DRAFT` \| `ACTIVE` \| `DUE` \| `NON_COMPLIANT` \| `RETIRED` |
| `faellig` | string | – | `0` \| `1`, Standard `"0"` |

### `POST /api/bi/controls`

**Kontrolle anlegen.** Mit Prüfzyklus und Nachweisbeschreibung.

- **Zugriff:** Erfordert die Berechtigung: `control:create`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `kind` | string | – | `SOP` \| `QUALITY_STANDARD` \| `COMPLIANCE` \| `CONTINUITY`, Standard `"SOP"` |
| `status` | string | – | `DRAFT` \| `ACTIVE` \| `DUE` \| `NON_COMPLIANT` \| `RETIRED`, Standard `"DRAFT"` |
| `reference` | string | – | max. 80 Zeichen |
| `title` | string | ja | min. 3 Zeichen, max. 200 Zeichen |
| `description` | string | – | max. 10000 Zeichen |
| `evidenceNote` | string | – | max. 2000 Zeichen |
| `ownerId` | string | – | min. 1 Zeichen |
| `reviewIntervalDays` | integer | – | ≥ 7, ≤ 1095, Standard `180` |

### `GET /api/bi/controls/{id}`

**Kontrolle.** Mit Massnahmen, Dateien und Prüfverlauf.

- **Zugriff:** Erfordert die Berechtigung: `control:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `PATCH /api/bi/controls/{id}`

**Kontrolle ändern.** Angaben, Status, Zyklus.

- **Zugriff:** Erfordert die Berechtigung: `control:update`.
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
| `kind` | string | – | `SOP` \| `QUALITY_STANDARD` \| `COMPLIANCE` \| `CONTINUITY`, Standard `"SOP"` |
| `status` | string | – | `DRAFT` \| `ACTIVE` \| `DUE` \| `NON_COMPLIANT` \| `RETIRED`, Standard `"DRAFT"` |
| `reference` | string | – | max. 80 Zeichen |
| `title` | string | – | min. 3 Zeichen, max. 200 Zeichen |
| `description` | string | – | max. 10000 Zeichen |
| `evidenceNote` | string | – | max. 2000 Zeichen |
| `ownerId` | string | – | min. 1 Zeichen |
| `reviewIntervalDays` | integer | – | ≥ 7, ≤ 1095, Standard `180` |

### `DELETE /api/bi/controls/{id}`

**Kontrolle löschen.** Papierkorb.

- **Zugriff:** Erfordert die Berechtigung: `control:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/bi/controls/{id}/review`

**Kontrolle prüfen.** Ergebnis „in Ordnung" oder „Abweichung"; Abweichung setzt den Status.

- **Zugriff:** Erfordert die Berechtigung: `control:update`.
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
| `note` | string | – | max. 2000 Zeichen |
| `outcome` | string | – | `COMPLIANT` \| `NON_COMPLIANT`, Standard `"COMPLIANT"` |

### `GET /api/bi/actions`

**Massnahmen.** Korrektur-, Vorbeugungs- und Verbesserungsmassnahmen, offen zuerst.

- **Zugriff:** Erfordert die Berechtigung: `action:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 429, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `riskId` | string | – | min. 1 Zeichen |
| `controlId` | string | – | min. 1 Zeichen |
| `reviewId` | string | – | min. 1 Zeichen |
| `status` | string | – | `offen` \| `alle`, Standard `"offen"` |

### `POST /api/bi/actions`

**Massnahme eröffnen.** Zu einem Risiko, einer Kontrolle oder einer Bewertung. Mit Zuständigkeit entsteht eine Aufgabe.

- **Zugriff:** Erfordert die Berechtigung: `action:create`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `kind` | string | – | `CORRECTIVE` \| `PREVENTIVE` \| `IMPROVEMENT`, Standard `"CORRECTIVE"` |
| `title` | string | ja | min. 3 Zeichen, max. 200 Zeichen |
| `rootCause` | string | – | max. 4000 Zeichen |
| `description` | string | – | max. 6000 Zeichen |
| `riskId` | string | – | min. 1 Zeichen |
| `controlId` | string | – | min. 1 Zeichen |
| `reviewId` | string | – | min. 1 Zeichen |
| `dueOn` | string | – | – |
| `assigneeId` | string | – | min. 1 Zeichen |
| `priority` | string | – | `LOW` \| `NORMAL` \| `HIGH` \| `URGENT`, Standard `"NORMAL"` |

### `PATCH /api/bi/actions/{id}`

**Massnahme ändern.** Abschliessen und Wirksamkeit bestätigen — letzteres erst nach Abschluss (422).

- **Zugriff:** Erfordert die Berechtigung: `action:update`.
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
| `kind` | string | – | `CORRECTIVE` \| `PREVENTIVE` \| `IMPROVEMENT` |
| `title` | string | – | min. 3 Zeichen, max. 200 Zeichen |
| `rootCause` | string | – | max. 4000 Zeichen |
| `description` | string | – | max. 6000 Zeichen |
| `dueOn` | string | – | – |
| `completed` | boolean | – | – |
| `effectivenessChecked` | boolean | – | – |
| `effectivenessNote` | string | – | max. 2000 Zeichen |

## Führung: Wissen und Markt

### `GET /api/bi/documents`

**Dokumente.** Im Rahmen der Sichtbarkeit: Mitarbeitende sehen STAFF-Dokumente und die eigene Personalakte.

- **Zugriff:** Erfordert eine der Berechtigungen: `document:read`, `document:read_own`.
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
| `category` | string | – | `BUSINESS_PLAN` \| `CONTRACT` \| `INSURANCE` \| `EMPLOYEE` \| `CERTIFICATE` \| `LICENSE` \| `SUPPLIER` \| `TAX` \| `LEGAL` \| `POLICY` \| `OTHER` |
| `visibility` | string | – | `MANAGEMENT` \| `OPERATIONS` \| `STAFF` \| `EMPLOYEE_PRIVATE` |
| `tag` | string | – | max. 40 Zeichen |
| `ablaufTage` | integer | – | ≥ 1, ≤ 365 |

### `POST /api/bi/documents`

**Dokument ablegen.** Akte mit optionaler erster Fassung. Personaldokumente werden ohne Angabe EMPLOYEE_PRIVATE und brauchen die betroffene Person (422).

- **Zugriff:** Erfordert die Berechtigung: `document:create`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `title` | string | ja | min. 2 Zeichen, max. 200 Zeichen |
| `category` | string | – | `BUSINESS_PLAN` \| `CONTRACT` \| `INSURANCE` \| `EMPLOYEE` \| `CERTIFICATE` \| `LICENSE` \| `SUPPLIER` \| `TAX` \| `LEGAL` \| `POLICY` \| `OTHER`, Standard `"OTHER"` |
| `visibility` | string | – | `MANAGEMENT` \| `OPERATIONS` \| `STAFF` \| `EMPLOYEE_PRIVATE` |
| `description` | string | – | max. 2000 Zeichen |
| `tags` | string[] | – | max. 20 Einträge, Standard `[]` |
| `subjectEmployeeId` | string | – | min. 1 Zeichen |
| `supplierId` | string | – | min. 1 Zeichen |
| `validFrom` | string | – | – |
| `expiresOn` | string | – | – |
| `reminderDaysBefore` | integer | – | ≥ 0, ≤ 365, Standard `30` |
| `file` | object | – | – |
| `file.path` | string | ja | min. 1 Zeichen, max. 500 Zeichen |
| `file.url` | string | ja | max. 2000 Zeichen |
| `file.filename` | string | ja | min. 1 Zeichen, max. 255 Zeichen |
| `file.mimeType` | string | ja | min. 1 Zeichen, max. 120 Zeichen |
| `file.sizeBytes` | integer | ja | ≥ 0, ≤ 52428800 |
| `changeNote` | string | – | max. 500 Zeichen |

### `GET /api/bi/documents/{id}`

**Dokument.** Akte mit allen Fassungen.

- **Zugriff:** Erfordert eine der Berechtigungen: `document:read`, `document:read_own`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `PATCH /api/bi/documents/{id}`

**Dokument ändern.** Angaben, Fristen, Sichtbarkeit.

- **Zugriff:** Erfordert die Berechtigung: `document:update`.
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
| `title` | string | – | min. 2 Zeichen, max. 200 Zeichen |
| `category` | string | – | `BUSINESS_PLAN` \| `CONTRACT` \| `INSURANCE` \| `EMPLOYEE` \| `CERTIFICATE` \| `LICENSE` \| `SUPPLIER` \| `TAX` \| `LEGAL` \| `POLICY` \| `OTHER`, Standard `"OTHER"` |
| `visibility` | string | – | `MANAGEMENT` \| `OPERATIONS` \| `STAFF` \| `EMPLOYEE_PRIVATE` |
| `description` | string | – | max. 2000 Zeichen |
| `tags` | string[] | – | max. 20 Einträge, Standard `[]` |
| `subjectEmployeeId` | string | – | min. 1 Zeichen |
| `supplierId` | string | – | min. 1 Zeichen |
| `validFrom` | string | – | – |
| `expiresOn` | string | – | – |
| `reminderDaysBefore` | integer | – | ≥ 0, ≤ 365, Standard `30` |

### `DELETE /api/bi/documents/{id}`

**Dokument löschen.** Papierkorb; Fassungen bleiben im Speicher.

- **Zugriff:** Erfordert die Berechtigung: `document:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/bi/documents/{id}/versions`

**Neue Fassung.** Die neue Datei wird die geltende Fassung.

- **Zugriff:** Erfordert die Berechtigung: `document:create`.
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
| `file` | object | ja | – |
| `file.path` | string | ja | min. 1 Zeichen, max. 500 Zeichen |
| `file.url` | string | ja | max. 2000 Zeichen |
| `file.filename` | string | ja | min. 1 Zeichen, max. 255 Zeichen |
| `file.mimeType` | string | ja | min. 1 Zeichen, max. 120 Zeichen |
| `file.sizeBytes` | integer | ja | ≥ 0, ≤ 52428800 |
| `changeNote` | string | – | max. 500 Zeichen |

### `GET /api/bi/documents/{id}/download`

**Dokument herunterladen.** Protokollierte Weiterleitung auf einen befristeten Verweis; ohne `version` die geltende Fassung.

- **Zugriff:** Erfordert eine der Berechtigungen: `document:read`, `document:read_own`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200 (`application/octet-stream`)
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `version` | integer | – | ≥ 1, ≤ 10000 |

### `GET /api/bi/knowledge`

**Wissensartikel.** Nach Sichtbarkeit; Entwürfe nur für Schreibende.

- **Zugriff:** Erfordert die Berechtigung: `knowledge:read`.
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
| `category` | string | – | max. 60 Zeichen |
| `status` | string | – | `DRAFT` \| `PUBLISHED` \| `ARCHIVED` |
| `tag` | string | – | max. 40 Zeichen |

### `POST /api/bi/knowledge`

**Artikel verfassen.** Der Slug entsteht aus dem Titel.

- **Zugriff:** Erfordert die Berechtigung: `knowledge:create`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `title` | string | ja | min. 3 Zeichen, max. 200 Zeichen |
| `summary` | string | – | max. 500 Zeichen |
| `body` | string | ja | min. 10 Zeichen, max. 60000 Zeichen |
| `category` | string | – | min. 2 Zeichen, max. 60 Zeichen, Standard `"Allgemein"` |
| `tags` | string[] | – | max. 20 Einträge, Standard `[]` |
| `status` | string | – | `DRAFT` \| `PUBLISHED` \| `ARCHIVED`, Standard `"DRAFT"` |
| `visibility` | string | – | `MANAGEMENT` \| `OPERATIONS` \| `STAFF`, Standard `"STAFF"` |
| `videoUrl` | string | – | uri, max. 500 Zeichen |
| `reviewIntervalDays` | integer | – | ≥ 30, ≤ 1095 |

### `GET /api/bi/knowledge/{id}`

**Artikel.** Ein Artikel im Rahmen der Sichtbarkeit.

- **Zugriff:** Erfordert die Berechtigung: `knowledge:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `PATCH /api/bi/knowledge/{id}`

**Artikel ändern.** Inhalt, Status, Sichtbarkeit; ein neuer Titel ergibt einen neuen Slug.

- **Zugriff:** Erfordert die Berechtigung: `knowledge:update`.
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
| `summary` | string | – | max. 500 Zeichen |
| `body` | string | – | min. 10 Zeichen, max. 60000 Zeichen |
| `category` | string | – | min. 2 Zeichen, max. 60 Zeichen, Standard `"Allgemein"` |
| `tags` | string[] | – | max. 20 Einträge, Standard `[]` |
| `status` | string | – | `DRAFT` \| `PUBLISHED` \| `ARCHIVED`, Standard `"DRAFT"` |
| `visibility` | string | – | `MANAGEMENT` \| `OPERATIONS` \| `STAFF`, Standard `"STAFF"` |
| `videoUrl` | string | – | uri, max. 500 Zeichen |
| `reviewIntervalDays` | integer | – | ≥ 30, ≤ 1095 |

### `DELETE /api/bi/knowledge/{id}`

**Artikel löschen.** Papierkorb.

- **Zugriff:** Erfordert die Berechtigung: `knowledge:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/bi/competitors`

**Wettbewerber.** Alle erfassten Wettbewerber.

- **Zugriff:** Erfordert die Berechtigung: `market:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `POST /api/bi/competitors`

**Wettbewerber erfassen.** Mit Preisspanne, Stärken, Schwächen und Prüfzyklus.

- **Zugriff:** Erfordert die Berechtigung: `market:manage`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `name` | string | ja | min. 2 Zeichen, max. 160 Zeichen |
| `website` | string | – | uri, max. 300 Zeichen |
| `region` | string | – | max. 120 Zeichen |
| `services` | string[] | – | max. 30 Einträge, Standard `[]` |
| `priceFrom` | number | – | ≥ 0, ≤ 9999999 |
| `priceTo` | number | – | ≥ 0, ≤ 9999999 |
| `priceNote` | string | – | max. 500 Zeichen |
| `strengths` | string | – | max. 4000 Zeichen |
| `weaknesses` | string | – | max. 4000 Zeichen |
| `marketPosition` | string | – | max. 500 Zeichen |
| `reviewScore` | number | – | ≥ 0, ≤ 5 |
| `reviewCount` | integer | – | ≥ 0, ≤ 1000000 |
| `notes` | string | – | max. 6000 Zeichen |
| `reviewIntervalDays` | integer | – | ≥ 30, ≤ 1095, Standard `180` |

### `PATCH /api/bi/competitors/{id}`

**Wettbewerber ändern.** Jede Änderung gilt als Überprüfung.

- **Zugriff:** Erfordert die Berechtigung: `market:manage`.
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
| `name` | string | – | min. 2 Zeichen, max. 160 Zeichen |
| `website` | string | – | uri, max. 300 Zeichen |
| `region` | string | – | max. 120 Zeichen |
| `services` | string[] | – | max. 30 Einträge, Standard `[]` |
| `priceFrom` | number | – | ≥ 0, ≤ 9999999 |
| `priceTo` | number | – | ≥ 0, ≤ 9999999 |
| `priceNote` | string | – | max. 500 Zeichen |
| `strengths` | string | – | max. 4000 Zeichen |
| `weaknesses` | string | – | max. 4000 Zeichen |
| `marketPosition` | string | – | max. 500 Zeichen |
| `reviewScore` | number | – | ≥ 0, ≤ 5 |
| `reviewCount` | integer | – | ≥ 0, ≤ 1000000 |
| `notes` | string | – | max. 6000 Zeichen |
| `reviewIntervalDays` | integer | – | ≥ 30, ≤ 1095, Standard `180` |

### `DELETE /api/bi/competitors/{id}`

**Wettbewerber löschen.** Papierkorb.

- **Zugriff:** Erfordert die Berechtigung: `market:manage`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/bi/market-insights`

**Marktbeobachtungen.** Mit Kennzeichnung veralteter Einträge.

- **Zugriff:** Erfordert die Berechtigung: `market:read`.
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
| `kind` | string | – | `INDUSTRY` \| `CUSTOMER` \| `COMPETITOR` \| `TECHNOLOGY` \| `ECONOMY` \| `LEGAL` \| `ENVIRONMENT` |
| `faellig` | string | – | `0` \| `1`, Standard `"0"` |

### `POST /api/bi/market-insights`

**Beobachtung erfassen.** Mit Quelle, Datum und Geltungsdauer.

- **Zugriff:** Erfordert die Berechtigung: `market:manage`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `kind` | string | – | `INDUSTRY` \| `CUSTOMER` \| `COMPETITOR` \| `TECHNOLOGY` \| `ECONOMY` \| `LEGAL` \| `ENVIRONMENT`, Standard `"INDUSTRY"` |
| `title` | string | ja | min. 3 Zeichen, max. 200 Zeichen |
| `body` | string | ja | min. 10 Zeichen, max. 10000 Zeichen |
| `sourceUrl` | string | – | uri, max. 500 Zeichen |
| `sourceName` | string | – | max. 160 Zeichen |
| `observedOn` | string | ja | – |
| `impactNote` | string | – | max. 2000 Zeichen |
| `reviewIntervalDays` | integer | – | ≥ 30, ≤ 1095, Standard `365` |

### `PATCH /api/bi/market-insights/{id}`

**Beobachtung ändern.** Aktualisieren gilt als Bestätigung ab heute.

- **Zugriff:** Erfordert die Berechtigung: `market:manage`.
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
| `kind` | string | – | `INDUSTRY` \| `CUSTOMER` \| `COMPETITOR` \| `TECHNOLOGY` \| `ECONOMY` \| `LEGAL` \| `ENVIRONMENT`, Standard `"INDUSTRY"` |
| `title` | string | – | min. 3 Zeichen, max. 200 Zeichen |
| `body` | string | – | min. 10 Zeichen, max. 10000 Zeichen |
| `sourceUrl` | string | – | uri, max. 500 Zeichen |
| `sourceName` | string | – | max. 160 Zeichen |
| `observedOn` | string | – | – |
| `impactNote` | string | – | max. 2000 Zeichen |
| `reviewIntervalDays` | integer | – | ≥ 30, ≤ 1095, Standard `365` |

### `DELETE /api/bi/market-insights/{id}`

**Beobachtung löschen.** Papierkorb.

- **Zugriff:** Erfordert die Berechtigung: `market:manage`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/bi/analysis`

**Analysetafeln.** SWOT- und PESTEL-Tafeln, alle Fassungen.

- **Zugriff:** Erfordert die Berechtigung: `market:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 429, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `kind` | string | – | `SWOT` \| `PESTEL` |

### `POST /api/bi/analysis`

**Tafel anlegen.** Wahlweise als Nachfolgerin einer bestehenden Tafel derselben Art (422 bei falscher Art oder bereits abgelöst).

- **Zugriff:** Erfordert die Berechtigung: `market:manage`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `kind` | string | ja | `SWOT` \| `PESTEL` |
| `title` | string | ja | min. 3 Zeichen, max. 200 Zeichen |
| `preparedOn` | string | ja | – |
| `summary` | string | – | max. 6000 Zeichen |
| `reviewIntervalDays` | integer | – | ≥ 30, ≤ 1095, Standard `365` |
| `entries` | object[] | – | max. 80 Einträge, Standard `[]` |
| `entries[].bucket` | string | ja | `STRENGTH` \| `WEAKNESS` \| `OPPORTUNITY` \| `THREAT` \| `POLITICAL` \| `ECONOMIC` \| `SOCIAL` \| `TECHNOLOGICAL` \| `ENVIRONMENTAL` \| `LEGAL` |
| `entries[].title` | string | ja | min. 2 Zeichen, max. 200 Zeichen |
| `entries[].detail` | string | – | max. 2000 Zeichen |
| `entries[].weight` | integer | – | ≥ 1, ≤ 5, Standard `3` |
| `entries[].sortOrder` | integer | – | ≥ 0, ≤ 100, Standard `0` |
| `supersedesId` | string | – | min. 1 Zeichen |

### `GET /api/bi/analysis/{id}`

**Tafel.** Mit Einträgen und Fassungskette.

- **Zugriff:** Erfordert die Berechtigung: `market:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `PATCH /api/bi/analysis/{id}`

**Tafel ändern.** Nur die aktuelle Fassung; Einträge werden als Ganzes ersetzt (422 bei abgelöster Fassung).

- **Zugriff:** Erfordert die Berechtigung: `market:manage`.
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
| `preparedOn` | string | – | – |
| `summary` | string | – | max. 6000 Zeichen |
| `reviewIntervalDays` | integer | – | ≥ 30, ≤ 1095 |
| `entries` | object[] | – | max. 80 Einträge |
| `entries[].bucket` | string | ja | `STRENGTH` \| `WEAKNESS` \| `OPPORTUNITY` \| `THREAT` \| `POLITICAL` \| `ECONOMIC` \| `SOCIAL` \| `TECHNOLOGICAL` \| `ENVIRONMENTAL` \| `LEGAL` |
| `entries[].title` | string | ja | min. 2 Zeichen, max. 200 Zeichen |
| `entries[].detail` | string | – | max. 2000 Zeichen |
| `entries[].weight` | integer | – | ≥ 1, ≤ 5, Standard `3` |
| `entries[].sortOrder` | integer | – | ≥ 0, ≤ 100, Standard `0` |

### `DELETE /api/bi/analysis/{id}`

**Tafel löschen.** Endgültig.

- **Zugriff:** Erfordert die Berechtigung: `market:manage`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/bi/meetings`

**Sitzungen.** Neueste zuerst, mit Teilnehmenden und Pendenzenzahl.

- **Zugriff:** Erfordert die Berechtigung: `meeting:read`.
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
| `from` | string | – | date-time |
| `to` | string | – | date-time |
| `objectiveId` | string | – | min. 1 Zeichen |

### `POST /api/bi/meetings`

**Sitzung anlegen.** Pendenzen werden als Aufgaben angelegt; Zuständige werden benachrichtigt.

- **Zugriff:** Erfordert die Berechtigung: `meeting:create`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `title` | string | ja | min. 3 Zeichen, max. 200 Zeichen |
| `heldAt` | string | ja | date-time |
| `location` | string | – | max. 160 Zeichen |
| `agenda` | string | – | max. 10000 Zeichen |
| `minutes` | string | – | max. 30000 Zeichen |
| `decisions` | string | – | max. 10000 Zeichen |
| `guestNames` | string[] | – | max. 30 Einträge, Standard `[]` |
| `participantIds` | string[] | – | max. 50 Einträge, Standard `[]` |
| `objectiveId` | string | – | min. 1 Zeichen |
| `actionItems` | object[] | – | max. 50 Einträge, Standard `[]` |
| `actionItems[].title` | string | ja | min. 3 Zeichen, max. 200 Zeichen |
| `actionItems[].assigneeId` | string | – | min. 1 Zeichen |
| `actionItems[].dueAt` | string | – | date-time |
| `actionItems[].priority` | string | – | `LOW` \| `NORMAL` \| `HIGH` \| `URGENT`, Standard `"NORMAL"` |

### `GET /api/bi/meetings/{id}`

**Sitzung.** Mit Teilnehmenden, Aufgaben und Dateien.

- **Zugriff:** Erfordert die Berechtigung: `meeting:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 404, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `PATCH /api/bi/meetings/{id}`

**Sitzung ändern.** Protokoll, Beschlüsse, Teilnehmende; weitere Pendenzen als Aufgaben.

- **Zugriff:** Erfordert die Berechtigung: `meeting:update`.
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
| `heldAt` | string | – | date-time |
| `location` | string | – | max. 160 Zeichen |
| `agenda` | string | – | max. 10000 Zeichen |
| `minutes` | string | – | max. 30000 Zeichen |
| `decisions` | string | – | max. 10000 Zeichen |
| `guestNames` | string[] | – | max. 30 Einträge, Standard `[]` |
| `participantIds` | string[] | – | max. 50 Einträge, Standard `[]` |
| `objectiveId` | string | – | min. 1 Zeichen |
| `actionItems` | object[] | – | max. 50 Einträge |
| `actionItems[].title` | string | ja | min. 3 Zeichen, max. 200 Zeichen |
| `actionItems[].assigneeId` | string | – | min. 1 Zeichen |
| `actionItems[].dueAt` | string | – | date-time |
| `actionItems[].priority` | string | – | `LOW` \| `NORMAL` \| `HIGH` \| `URGENT`, Standard `"NORMAL"` |

### `DELETE /api/bi/meetings/{id}`

**Sitzung löschen.** Papierkorb; erzeugte Aufgaben bleiben.

- **Zugriff:** Erfordert die Berechtigung: `meeting:delete`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

## Führung: Berichte

### `GET /api/bi/report-schedules`

**Berichtszeitpläne.** Mit letztem Lauf und nächstem Termin.

- **Zugriff:** Erfordert die Berechtigung: `bireport:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 401, 403, 429, 500

### `POST /api/bi/report-schedules`

**Zeitplan anlegen.** Wiederkehrender Bericht; der Nachtlauf erzeugt und verschickt ihn.

- **Zugriff:** Erfordert die Berechtigung: `bireport:manage`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `name` | string | ja | min. 2 Zeichen, max. 120 Zeichen |
| `kind` | string | – | `BUSINESS_PERFORMANCE` \| `FINANCIAL` \| `MARKETING` \| `SALES` \| `EMPLOYEE` \| `CUSTOMER` \| `QUARTERLY_REVIEW`, Standard `"BUSINESS_PERFORMANCE"` |
| `cadence` | string | – | `WEEKLY` \| `MONTHLY` \| `QUARTERLY` \| `YEARLY`, Standard `"MONTHLY"` |
| `format` | string | – | `PDF` \| `XLSX` \| `DOCX`, Standard `"PDF"` |
| `runOnDay` | integer | – | ≥ 1, ≤ 28, Standard `1` |
| `recipients` | string[] | – | max. 20 Einträge, Standard `[]` |
| `active` | boolean | – | Standard `true` |

### `PATCH /api/bi/report-schedules/{id}`

**Zeitplan ändern.** Takt, Format, Empfänger, aktiv/pausiert.

- **Zugriff:** Erfordert die Berechtigung: `bireport:manage`.
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
| `name` | string | – | min. 2 Zeichen, max. 120 Zeichen |
| `kind` | string | – | `BUSINESS_PERFORMANCE` \| `FINANCIAL` \| `MARKETING` \| `SALES` \| `EMPLOYEE` \| `CUSTOMER` \| `QUARTERLY_REVIEW`, Standard `"BUSINESS_PERFORMANCE"` |
| `cadence` | string | – | `WEEKLY` \| `MONTHLY` \| `QUARTERLY` \| `YEARLY`, Standard `"MONTHLY"` |
| `format` | string | – | `PDF` \| `XLSX` \| `DOCX`, Standard `"PDF"` |
| `runOnDay` | integer | – | ≥ 1, ≤ 28, Standard `1` |
| `recipients` | string[] | – | max. 20 Einträge, Standard `[]` |
| `active` | boolean | – | Standard `true` |

### `DELETE /api/bi/report-schedules/{id}`

**Zeitplan löschen.** Erzeugte Berichte bleiben.

- **Zugriff:** Erfordert die Berechtigung: `bireport:manage`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 204
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `GET /api/bi/reports`

**Erzeugte Berichte.** Neueste zuerst, mit Status und Datei.

- **Zugriff:** Erfordert die Berechtigung: `bireport:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 429, 500

**Query-Parameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `kind` | string | – | `BUSINESS_PERFORMANCE` \| `FINANCIAL` \| `MARKETING` \| `SALES` \| `EMPLOYEE` \| `CUSTOMER` \| `QUARTERLY_REVIEW` |
| `limit` | integer | – | ≥ 1, ≤ 100, Standard `30` |

### `POST /api/bi/reports/generate`

**Bericht erzeugen.** PDF, Excel oder Word für einen Zeitraum; die Datei bleibt liegen.

- **Zugriff:** Erfordert die Berechtigung: `bireport:manage`.
- **Rate-Limit-Klasse:** `apiWrite`
- **Erfolg:** 201
- **Mögliche Fehler:** 400, 401, 403, 409, 422, 429, 500

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `kind` | string | ja | `BUSINESS_PERFORMANCE` \| `FINANCIAL` \| `MARKETING` \| `SALES` \| `EMPLOYEE` \| `CUSTOMER` \| `QUARTERLY_REVIEW` |
| `format` | string | – | `PDF` \| `XLSX` \| `DOCX`, Standard `"PDF"` |
| `periodStart` | string | ja | – |
| `periodEnd` | string | ja | – |

### `GET /api/bi/reports/{id}/download`

**Bericht herunterladen.** Protokollierte Weiterleitung auf einen befristeten Verweis (422, wenn der Bericht nicht bereit ist).

- **Zugriff:** Erfordert die Berechtigung: `bireport:read`.
- **Rate-Limit-Klasse:** `apiRead`
- **Erfolg:** 200 (`application/octet-stream`)
- **Mögliche Fehler:** 400, 401, 403, 404, 422, 429, 500

**Pfadparameter**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
| `id` | string | ja | min. 1 Zeichen |

### `POST /api/bi/assistant`

**Führungsassistent.** Eine Fähigkeit je Aufruf (`kind`). Jede Antwort trägt Begründung, Datenquellen und Vertrauensgrad und ist ein Entwurf. Ohne ANTHROPIC_API_KEY 503.

- **Zugriff:** Erfordert die Berechtigungen: `cockpit:view`, `ai:use`.
- **Rate-Limit-Klasse:** `aiGenerate`
- **Erfolg:** 200
- **Mögliche Fehler:** 400, 401, 403, 422, 429, 500, 503

**Anfragekörper**

| Feld | Typ | Pflicht | Regeln |
| --- | --- | --- | --- |
