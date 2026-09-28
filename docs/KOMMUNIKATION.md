# Kommunikation: Vorlagen, Zustellstatus, Protokoll

> Stand: 23. September 2026 (Wave 14).

## 1. Statusinventar

| Punkt | Status | Beleg / Lücke |
|---|---|---|
| Transaktionale E-Mails (25 Vorlagen im Code, Deutsch) | COMPLETE (bestehend) | `src/lib/email/templates.ts` |
| SMS-Vorlagen (7, im Code) | COMPLETE (bestehend) | `src/lib/sms/client.ts` |
| Bearbeitbare DB-Vorlagen (`EmailTemplate`/`SmsTemplate`) | PARTIAL | nur für Automatisierungen genutzt; es gibt keine vorbelegten Zeilen, eine Automatisierungsaktion ohne Vorlage wird übersprungen (mit Grund im Lauf) |
| Mehrsprachige Vorlagen | NOT IMPLEMENTED | Schema kennt `locale`, die Code-Vorlagen sind deutsch |
| Protokoll je Versand (`EmailLog`/`SmsLog`) | COMPLETE | Status beim Übergeben: `simulated`/`sent`/`failed`, Anbieterkennung |
| **Zustellstatus vom Anbieter** | COMPLETE + VERIFIED (Resend) · EXTERNAL VERIFICATION REQUIRED (Twilio, echte Anbieter) | Webhooks `/api/webhooks/resend` (Svix-Signatur) und `/api/webhooks/twilio` (HMAC-SHA1) |
| Ordnungsfeste, idempotente Statusfolge | COMPLETE + VERIFIED | `naechsterStatus`: vorwärts; Abprall/Spam überschreibt Zustellung |
| Öffnen/Klicken (erster Zeitpunkt) | COMPLETE + VERIFIED | Resend-Ereignisse |
| Zustellprotokoll-Ansicht | COMPLETE + VERIFIED | `/admin/kommunikation`, `GET /api/communication/logs` (`template:read`) |
| Vorlagenschlüssel im Protokoll auch über `notify()` | COMPLETE + VERIFIED | vorher `null` — siehe §3 |
| Wiederholung fehlgeschlagener Versände | NOT IMPLEMENTED | ausser in Automatisierungen (3 Versuche) |
| Mandantenbezug der Protokolle (`organizationId`) | NOT IMPLEMENTED | einmandantiger Betrieb; siehe `docs/MANDANTEN.md` |

## 2. Zustellmeldungen

- **Resend:** Signatur nach Svix (`svix-id`, `svix-timestamp`, `svix-signature`;
  HMAC-SHA256 über `id.timestamp.body`, Geheimnis `RESEND_WEBHOOK_SECRET`),
  Zeitstempel höchstens fünf Minuten alt. Ereignisse `email.sent`,
  `delivered`, `delivery_delayed`, `bounced`, `complained`, `failed`,
  `opened`, `clicked`. Ohne Geheimnis 503; ungültig 401; unbekannte Kennung
  200 (andere Umgebung); Verarbeitungsfehler 500 (Anbieter wiederholt).
- **Twilio:** `sendSms` setzt `statusCallback`; Signatur `X-Twilio-Signature`
  über die **öffentliche** Adresse (`APP_URL`, zur Laufzeit) und die
  Formularfelder mit `TWILIO_AUTH_TOKEN`. Hinter einem Proxy muss die
  öffentliche Adresse stimmen — mit einem echten Konto zu prüfen.
- Gespeichert werden nur Status, Zeitpunkte und ein Fehlercode — kein Inhalt
  aus der Meldung.

## 3. Behobener Fehler: Bewertungsbitte mehrfach

`requestReviews` (Tageslauf, Fenster 24–72 Stunden nach Abschluss) prüfte
auf eine frühere Bitte über `EmailLog.templateKey = 'review_request'`. Weil
`notify()` den Schlüssel nicht weitergab, fand die Prüfung nie etwas — jede
Buchung konnte zwei- bis dreimal gebeten werden, Kundschaft ohne
E-Mail-Wunsch bekam die Mitteilung im Konto an jedem Tag im Fenster. Jetzt:
`notify()` reicht `templateKey` durch, und die Prüfung sieht zusätzlich die
Mitteilung im Konto (eindeutiger Verweis je Buchung).
`tests/api/kommunikation.test.ts` lässt den Tageslauf zweimal laufen.
