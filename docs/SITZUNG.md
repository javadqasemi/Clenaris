# Sitzung — Laufzeit, Leerlauf, mehrere Tabs

> Stand 2026-09-28. Gilt für Verwaltung, Personalportal und Kundenkonto.

## Was gilt

| | Ohne „Angemeldet bleiben" (Vorgabe) | Mit „Angemeldet bleiben" |
|---|---|---|
| Zugangscookie `clenaris_at` | Sitzungscookie (kein `Max-Age`, kein `Expires`); Token lebt 15 min | `Max-Age` = `JWT_ACCESS_TTL` |
| Erneuerungscookie `clenaris_rt` | Sitzungscookie | `Max-Age` = `JWT_REFRESH_TTL` (Vorgabe 30 Tage) |
| Leerlauffenster auf dem Server | `SESSION_IDLE_TTL` (Vorgabe 15 min) | `SESSION_REMEMBER_IDLE_TTL` (Vorgabe 7 Tage) |
| Warnung im Browser | 2 min vor Ablauf des Fensters | ebenso (bei 7 Tagen praktisch nie) |
| Absolute Obergrenze | `JWT_REFRESH_TTL` | `JWT_REFRESH_TTL` |

Alle Cookies: `HttpOnly`, `SameSite=Lax`, in der Produktion `Secure`.

Die Wahl steht als signierter Anspruch `rem` im Erneuerungstoken und wandert
bei jeder Rotation mit — auch durch den zweiten Faktor (im Zwischenschein)
und durch Geräteübergabe und Entsperren (aus dem aktuellen Token). Nachträglich
setzen lässt sie sich nicht.

## Leerlauf — der Server entscheidet

`refreshSession` (`src/server/services/session-refresh.service.ts`) erneuert
nur, wenn der vorgelegte Erneuerungstoken jünger ist als das Leerlauffenster
dieser Sitzung; sonst wird er widerrufen. Das gilt unabhängig davon, ob ein
Browser-Tab offen ist, ob Skripte laufen oder ob jemand die Uhr des Geräts
verstellt.

Der Aktivitätswächter im Browser (`src/features/account/session-keepalive.tsx`)
ist die Anzeige dieser Regel, nicht die Regel selbst:

- Aktivität (Maus, Tastatur, Berührung, Scrollen) erneuert die Sitzung
  vorbeugend alle 10 Minuten.
- Zwei Minuten vor Ablauf erscheint „Sitzung läuft bald ab" mit
  **Weiterarbeiten** und **Abmelden**.
- Ohne Antwort meldet der Browser selbst ab und öffnet die Anmeldung mit
  Rücksprungziel.

## Mehrere Tabs

Alle Tabs eines Browsers sind **eine** Sitzung (dieselben Cookies, dieselbe
Rotationsfamilie):

- Der Zeitpunkt der letzten Aktivität ist gemeinsam (`localStorage` und
  `BroadcastChannel`). Wer in einem Tab arbeitet, hält alle angemeldet; ein Tab
  im Hintergrund meldet niemanden ab.
- „Weiterarbeiten" in einem Tab schliesst die Warnung in allen.
- Eine Abmeldung — über das Profilmenü, über „Abmelden" in der Warnung oder
  nach Leerlauf — schickt alle anderen Tabs zur Anmeldung (`grund=abgemeldet`).
- Im Browserspeicher liegt nur ein Zeitstempel. Tokens stehen ausschliesslich
  in `HttpOnly`-Cookies, die kein Skript lesen kann.

Geprüft in `tests/e2e/sitzung-tabs.spec.ts` (mit vorgespulter Uhr) und
`tests/api/session-refresh.test.ts` (Cookie-Laufzeiten, Rotation, Abmeldung).

## Grenzen — was die Anwendung nicht zusichert

- **Das Schliessen des Browsers ist nicht zuverlässig erkennbar.** Es gibt
  kein Ereignis, das nur dann und immer dann feuert: `beforeunload` und
  `pagehide` feuern auch beim Neuladen und beim Seitenwechsel und nie beim
  Absturz oder beim Beenden über das Betriebssystem; `sendBeacon` ist ein
  Versuch ohne Zustellgarantie. Eine Abmeldung darauf zu stützen, meldete
  Leute beim Neuladen ab und liesse andere angemeldet. Deshalb gibt es sie
  nicht.
- **Sitzungswiederherstellung.** Chrome, Edge, Firefox und Safari können beim
  Start „die Tabs vom letzten Mal" wiederherstellen — und stellen dabei auch
  Sitzungscookies wieder her. Ein Sitzungscookie endet also mit dem Browser
  *nur dann*, wenn der Browser das zulässt. Die Grenze, die trotzdem gilt, ist
  das Leerlauffenster auf dem Server: Nach 15 Minuten ohne Erneuerung nimmt der
  Server den Token nicht mehr an, egal was der Browser wiederherstellt.
- **Mobile Browser** beenden sich selten wirklich; dort ist das
  Leerlauffenster die massgebliche Grenze.
- Ein gesperrtes Konto kann einen noch gültigen Zugangstoken bis zu
  15 Minuten nutzen (bekannter, bewusster Kompromiss, siehe
  `docs/ARCHITECTURE.md`); Verwaltungsvorgänge mit Rollen- oder Kontosperre
  widerrufen die Sitzungen zusätzlich (`revokeAllSessions`).

## Einstellungen

| Variable | Vorgabe | Bedeutung |
|---|---|---|
| `JWT_ACCESS_TTL` | 900 | Lebensdauer des Zugangstokens (s) |
| `JWT_REFRESH_TTL` | 2 592 000 | Absolute Obergrenze einer Sitzung (s) |
| `SESSION_IDLE_TTL` | 900 | Leerlauffenster ohne „Angemeldet bleiben" (s) |
| `SESSION_REMEMBER_IDLE_TTL` | 604 800 | Leerlauffenster mit „Angemeldet bleiben" (s) |
