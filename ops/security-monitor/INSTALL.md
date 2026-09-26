# Externe Sicherheitsüberwachung — Installationsanleitung

Stand 2026-09-26. **Vorlagen, nicht eingerichtet und nicht ausgeliefert.**
Diese Dateien sind Bausteine für eine *künftige*, saubere
Überwachungsumgebung. Sie wurden in keiner Umgebung ausgeführt; unter dem
Entwicklungsrechner (Windows, ohne lauffähige Bash) liess sich nicht einmal
die Syntax prüfen. Vor dem ersten Einsatz: `shellcheck *.sh` und ein Lauf mit
leerem `SECURITY_REPORT_URL` (siehe „Erprobung").

> **Nicht auf 2.29.18.45 installieren.** Dieser Rechner gehört nicht zur
> sauberen Umgebung. Die Überwachung läuft auf einem **eigenen**
> Überwachungsrechner; nur `deps_check.sh` läuft auf dem Anwendungsserver.

## Aufbau

```
 ┌──────────────────────────┐        HTTPS, ≤ 2 Anfragen/s, nur GET
 │ Überwachungsrechner      │ ───────────────────────────────────────┐
 │ (eigener, kleiner VPS)   │                                         ▼
 │  security_check.sh  5min │                         ┌────────────────────────────┐
 │  zap_baseline.sh   wöch. │ ── passiv, begrenzt ──▶ │ https://clenaris.qasemi.ch │
 │  alert.sh (Webhook/Mail) │                         │  /api/health               │
 └──────────┬───────────────┘                         │  /api/cron/security-report │◀─┐
            │ POST Bericht (Bearer SECURITY_REPORT_TOKEN)                         │  │
            └────────────────────────────────────────▶└────────────────────────────┘  │
                                                        Anwendungsserver             │
                                                         deps_check.sh  täglich ─────┘
                                                         db-backup / restore-verify ─┘
```

* **Warum ein eigener Rechner.** Eine Überwachung auf dem überwachten Server
  fällt mit ihm aus und meldet genau dann nichts. Dazu sieht sie die Anwendung
  nicht so, wie die Kundschaft sie sieht (DNS, TLS, Proxy, Firewall).
* **Warum Bericht *und* Alarm.** Der Bericht landet in der Sicherheitszentrale
  (`/admin/sicherheit`), der Alarm beim Menschen. Bleibt der Bericht aus,
  zeigt die Zentrale „Ausgeblieben" — auch das ist ein Signal, wenn der
  Überwachungsrechner selbst stirbt.
* **Die Anwendung führt nichts aus.** Sie speichert Berichte; keine Route
  startet eine Prüfung, eine Shell oder einen Neustart.

## Dateien

| Datei | Wo | Was |
|---|---|---|
| `lib.sh` | beide | Gemeinsame Hilfen: Takt (≤ 2/s), Protokoll, Befunde, Bericht |
| `security_check.sh` | Überwachungsrechner | Gesundheit, Kopfzeilen, TLS, offen erreichbare Dateien → `EXTERNAL_MONITOR` |
| `zap_baseline.sh` | Überwachungsrechner | ZAP-Baseline, **nur passiv** → `ZAP_BASELINE` |
| `deps_check.sh` | Anwendungsserver | OS-Updates, npm audit, ClamAV-Signaturen, Sicherungsalter, AIDE → `DEPENDENCY_CHECK`, `HOST_INTEGRITY` |
| `alert.sh` | beide | Alarm mit Schwere und Entdoppelung (Webhook, Mail, syslog) |
| `logrotate.conf` | beide | Rotation von `/var/log/clenaris-monitor/*.log` |
| `monitor.env.example` | beide | Konfiguration; Geheimnisse nur hier |

## Voraussetzungen

Debian 12 / Ubuntu 24.04 (die Skripte nutzen GNU `date -d`, `stat -c`,
`find -printf`).

```bash
sudo apt-get install --no-install-recommends curl jq openssl ca-certificates bsdutils
# nur für zap_baseline.sh:
sudo apt-get install docker.io      # oder Docker nach Herstelleranleitung
# optional für Mail-Alarme:
sudo apt-get install bsd-mailx      # mit eingerichtetem MTA
```

## Einrichten

```bash
sudo useradd --system --home /var/lib/clenaris-monitor --shell /usr/sbin/nologin clenaris-monitor
sudo install -d -o clenaris-monitor -g clenaris-monitor -m 0750 /var/lib/clenaris-monitor
sudo install -d -o clenaris-monitor -g adm -m 0750 /var/log/clenaris-monitor
sudo install -d -o root -g root -m 0755 /opt/clenaris-monitor
sudo install -m 0755 lib.sh security_check.sh zap_baseline.sh deps_check.sh alert.sh /opt/clenaris-monitor/
sudo install -d -o root -g clenaris-monitor -m 0750 /etc/clenaris-monitor
sudo install -o root -g clenaris-monitor -m 0640 monitor.env.example /etc/clenaris-monitor/monitor.env
sudo install -o root -g root -m 0644 logrotate.conf /etc/logrotate.d/clenaris-monitor
sudoedit /etc/clenaris-monitor/monitor.env      # Ziel, Token, Alarmwege
```

`SECURITY_REPORT_TOKEN` muss **derselbe Wert** sein wie in der `.env` der
Anwendung und darf **nicht** `CRON_SECRET` sein. Mindestens 32 zufällige
Zeichen: `openssl rand -hex 32`.

Für `zap_baseline.sh` braucht der Benutzer Docker-Rechte
(`usermod -aG docker clenaris-monitor`) — das ist faktisch root auf dem
Überwachungsrechner. Deshalb: eigener Rechner, auf dem sonst nichts läuft.

## Takt

`/etc/cron.d/clenaris-monitor` (Überwachungsrechner):

```cron
SHELL=/bin/bash
# Alle 5 Minuten: Gesundheit, Kopfzeilen, TLS, Dateien (≈ 20 Anfragen, ≤ 2/s)
*/5 * * * *  clenaris-monitor  set -a; . /etc/clenaris-monitor/monitor.env; set +a; /opt/clenaris-monitor/security_check.sh >/dev/null
# Sonntag 03:30: ZAP-Baseline, passiv, 2 Minuten Spider
30 3 * * 0   clenaris-monitor  set -a; . /etc/clenaris-monitor/monitor.env; set +a; /opt/clenaris-monitor/zap_baseline.sh >/dev/null
```

Anwendungsserver (`deps_check.sh` als root für AIDE, sonst als eigener Benutzer):

```cron
SHELL=/bin/bash
15 5 * * *   root  set -a; . /etc/clenaris-monitor/monitor.env; set +a; /opt/clenaris-monitor/deps_check.sh >/dev/null
```

Alle Zeiten sind Vorschläge; die Sicherheitszentrale erwartet
`EXTERNAL_MONITOR` spätestens alle 2 h, `DEPENDENCY_CHECK`/`HOST_INTEGRITY`
alle 26 h, `ZAP_BASELINE` alle 8 Tage
(`ERWARTET_ALLE_STUNDEN` in `src/server/services/security-report.service.ts`).

## Erprobung

1. `shellcheck *.sh` — muss ohne Fehler durchlaufen.
2. Mit leerem `SECURITY_REPORT_URL` und leerem `ALERT_WEBHOOK_URL`:
   `./security_check.sh` → eine Zeile Ergebnis, Protokoll in
   `/var/log/clenaris-monitor/monitor.log`, keine Nachricht nach aussen.
3. Alarmweg: `./alert.sh warnung probe "Probealarm"` → Nachricht; ein
   zweiter Aufruf innerhalb von `ALERT_WIEDERHOLEN_MIN` → nichts;
   `./alert.sh kritisch probe "…"` → sofort; `./alert.sh entwarnung probe "…"`.
4. Bericht: Token setzen, `./security_check.sh`, dann in `/admin/sicherheit`
   die Zeile „Externe Überwachung" prüfen. Falsches Token → HTTP 401 im
   Protokoll.
5. ZAP zuerst gegen die Vorschau (`npm run preview:server`), nicht gegen
   Produktion.

## Was die Vorlagen bewusst nicht tun

* Keine aktiven Scans gegen Produktion (kein `zap-full-scan`, keine
  Nutzlasten, keine Formulare, keine Anmeldeversuche).
* Keine Änderungen am Server: kein `apt-get upgrade`, kein `npm install`,
  kein `npm audit fix`, kein Neustart. Updates gehen durch das Update Center
  der Anwendung (Freigabe, Termin) und die Auslieferung.
* Keine Geheimnisse in Befehlszeilen oder Protokollen (curl liest Adresse
  und Token über `--config -` von der Standardeingabe).
* Keine Speicherung von Antwortinhalten — nur Status, Zeiten, Befundtitel.

## Rechnerschutz und Schadsoftware — dokumentiert, nicht installiert

Diese Massnahmen gehören zur sauberen Umgebung. Keine davon ist
eingerichtet; jede ist ein eigener Arbeitsschritt mit eigener Abnahme.

| Massnahme | Zweck | Hinweise |
|---|---|---|
| **unattended-upgrades** (nur Sicherheitsquelle) | Sicherheitsupdates des Betriebssystems ohne Wartezeit | Neustarts nicht automatisch; `deps_check.sh` meldet Ausstehendes |
| **SSH-Härtung** | nur Schlüssel, kein root-Login, eigener Benutzer | `PasswordAuthentication no`, `PermitRootLogin no`, `AllowUsers …` |
| **Firewall** (ufw/nftables) | nur 22 (begrenzt), 80/443 | Datenbank und ClamAV nur auf loopback |
| **fail2ban** | SSH-Rateraten bremsen | ergänzt, ersetzt nicht die Schlüsselpflicht |
| **ClamAV** (`clamd` + `freshclam`) | Prüfung hochgeladener Dateien — **in der Anwendung bereits angebunden** (`docs/MALWARE_PROTECTION.md`) | Signaturalter meldet `deps_check.sh` |
| **AIDE** | Dateiintegrität: Grundlinie, tägliche Prüfung | Grundlinie nach jeder Auslieferung erneuern, sonst meldet jede Auslieferung Abweichungen; `deps_check.sh` meldet `HOST_INTEGRITY` |
| **Wazuh** (Agent + Manager) | Protokollkorrelation, Integrität, Schwachstellen | eigener Manager-Rechner; schwergewichtig — erst bei mehreren Servern |
| **Falco** | Laufzeitverhalten (unerwartete Prozesse, Shells in Containern) | sinnvoll erst mit Containerbetrieb |
| **auditd** | Kernelprotokoll sicherheitsrelevanter Aufrufe | Regeln für `/srv/clenaris`, `/etc`, Benutzerwechsel |

Keine dieser Massnahmen macht einen Rechner „sicher". Sie verkleinern die
Angriffsfläche und machen Veränderungen sichtbar — gemeldet wird, was sie
erkennen, nicht, was sie nicht erkennen.

## Entfernen

```bash
sudo rm -f /etc/cron.d/clenaris-monitor /etc/logrotate.d/clenaris-monitor
sudo rm -rf /opt/clenaris-monitor /etc/clenaris-monitor /var/lib/clenaris-monitor
sudo userdel clenaris-monitor
```

In der Anwendung `SECURITY_REPORT_TOKEN` leeren — dann nimmt der Eingang
nichts mehr an, und die Zentrale zeigt die Quellen nach Ablauf als
„Ausgeblieben".
