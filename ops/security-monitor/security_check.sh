#!/usr/bin/env bash
#
# Externe Sicherheitsüberwachung von Clenaris — von aussen, nur lesend.
#
#   set -a; . /etc/clenaris-monitor/monitor.env; set +a
#   ./security_check.sh
#
# VORLAGE für einen EIGENEN Überwachungsrechner (ops/security-monitor/INSTALL.md).
# Nicht eingerichtet, nicht ausgeliefert. NICHT auf 2.29.18.45 installieren und
# nicht auf dem Anwendungsserver selbst: Eine Überwachung, die mit dem
# überwachten Rechner ausfällt, meldet genau dann nichts.
#
# Prüft, in dieser Reihenfolge, mit höchstens 2 Anfragen pro Sekunde:
#
#   1. Gesundheit    GET $MONITOR_HEALTH_PFAD — erreichbar, Status, Antwortzeit
#   2. Kopfzeilen    GET / — HSTS, CSP, nosniff, Frame-Schutz, Referrer, Permissions
#   3. TLS           Ablauf des Zertifikats (openssl), ohne HTTP-Anfrage
#   4. Dateien       eine feste, kurze Liste von Pfaden, die nie erreichbar sein
#                    dürfen (.env, .git, Abzüge, Schema) — nur GET, begrenzte Grösse
#   5. Betrieb       GET /api/cron/status mit SECURITY_REPORT_TOKEN: geplante
#                    Läufe, ClamAV erreichbar, Alter von Sicherung und
#                    bestandener Wiederherstellungsprobe — je eigener Alarm
#
# Meldet das Ergebnis an die Sicherheitszentrale (EXTERNAL_MONITOR) und
# alarmiert über alert.sh — mit Entwarnung, wenn ein Problem verschwindet.
#
# Was diese Prüfung NICHT ist: ein Angriff, ein Scanner mit Nutzlasten, eine
# Lastprobe. Sie sendet keine Eingaben an Formulare und keine POST-Anfragen an
# die Anwendung (ausser dem Bericht an den dafür vorgesehenen Eingang).
#
set -Eeuo pipefail

HIER="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HIER/lib.sh"

: "${MONITOR_ZIEL:?MONITOR_ZIEL fehlt (z. B. https://clenaris.qasemi.ch)}"
: "${MONITOR_HEALTH_PFAD:=/api/health}"
: "${MONITOR_TLS_WARN_TAGE:=21}"
: "${MONITOR_TLS_KRITISCH_TAGE:=7}"

benoetigt curl jq openssl date

if [[ "$MONITOR_ZIEL" != https://* ]]; then
  echo "MONITOR_ZIEL muss https sein." >&2
  exit 2
fi
host="${MONITOR_ZIEL#https://}"
host="${host%%/*}"
host="${host%%:*}"

arbeit="$(mktemp -d)"
trap 'rm -rf -- "$arbeit"' EXIT
BEFUNDE="$arbeit/befunde.jsonl"
: > "$BEFUNDE"

schwerste="OK"
hebe() { # hebe WARNUNG|KRITISCH
  if [[ "$1" == "KRITISCH" ]]; then schwerste="KRITISCH"
  elif [[ "$1" == "WARNUNG" && "$schwerste" == "OK" ]]; then schwerste="WARNUNG"; fi
}

abrufen() { # abrufen <pfad> <kopfdatei> <rumpfdatei> -> "code zeit"
  curl --silent --proto '=https' --max-time "$MONITOR_ZEITLIMIT_S" --max-filesize 262144 \
    -A 'clenaris-monitor/1 (+ops/security-monitor)' \
    -D "$2" -o "$3" -w '%{http_code} %{time_total}' -- "https://${host}$1" 2>/dev/null || echo "000 0"
  pause
}

# --- 1. Gesundheit -----------------------------------------------------------
read -r code zeit <<< "$(abrufen "$MONITOR_HEALTH_PFAD" "$arbeit/h.kopf" "$arbeit/h.rumpf")"
antwort_ms="$(awk -v z="$zeit" 'BEGIN { printf "%d", z * 1000 }')"
health_status="$(jq -r '.data.status // .status // "unbekannt"' "$arbeit/h.rumpf" 2>/dev/null || echo unbekannt)"
erreichbar=false
if [[ "$code" == "200" ]]; then
  erreichbar=true
  "$HIER/alert.sh" entwarnung health "wieder erreichbar (HTTP 200, ${antwort_ms} ms)" || true
  if [[ "$health_status" != "ok" && "$health_status" != "healthy" ]]; then
    befund mittel "Gesundheitsendpunkt meldet Status: $health_status" "$MONITOR_HEALTH_PFAD"
    hebe WARNUNG
  fi
  if (( antwort_ms > 3000 )); then
    befund mittel "Langsame Antwort: ${antwort_ms} ms" "$MONITOR_HEALTH_PFAD"
    hebe WARNUNG
  fi
else
  befund kritisch "Anwendung nicht erreichbar (HTTP $code)" "$MONITOR_HEALTH_PFAD"
  hebe KRITISCH
  "$HIER/alert.sh" kritisch health "nicht erreichbar (HTTP $code)" || true
fi

# --- 2. Sicherheitskopfzeilen -------------------------------------------------
fehlend=0
if [[ "$erreichbar" == true ]]; then
  read -r code _ <<< "$(abrufen "/" "$arbeit/s.kopf" "$arbeit/s.rumpf")"
  kopf="$(tr 'A-Z' 'a-z' < "$arbeit/s.kopf")"
  pruefe_kopf() { # pruefe_kopf <regex> <bezeichnung>
    if ! grep -Eq "$1" <<< "$kopf"; then
      befund mittel "Sicherheitskopfzeile fehlt: $2" "/"
      fehlend=$((fehlend + 1))
    fi
  }
  pruefe_kopf '^strict-transport-security: .*max-age=[1-9]' 'Strict-Transport-Security'
  pruefe_kopf '^content-security-policy: ' 'Content-Security-Policy'
  pruefe_kopf '^x-content-type-options: *nosniff' 'X-Content-Type-Options: nosniff'
  pruefe_kopf '^(x-frame-options: |content-security-policy: .*frame-ancestors)' 'Frame-Schutz (X-Frame-Options oder frame-ancestors)'
  pruefe_kopf '^referrer-policy: ' 'Referrer-Policy'
  pruefe_kopf '^permissions-policy: ' 'Permissions-Policy'
  if grep -Eq '^(x-powered-by|server): .*[0-9]' <<< "$kopf"; then
    befund niedrig "Versionsangabe in Server-/X-Powered-By-Kopfzeile" "/"
  fi
  if (( fehlend > 0 )); then
    hebe WARNUNG
    "$HIER/alert.sh" warnung kopfzeilen "$fehlend Sicherheitskopfzeile(n) fehlen" || true
  else
    "$HIER/alert.sh" entwarnung kopfzeilen "Sicherheitskopfzeilen vollständig" || true
  fi
fi

# --- 3. TLS-Zertifikat --------------------------------------------------------
tls_tage=-1
ende="$(echo | timeout "$MONITOR_ZEITLIMIT_S" openssl s_client -servername "$host" -connect "${host}:443" 2>/dev/null |
  openssl x509 -noout -enddate 2>/dev/null | sed 's/^notAfter=//' || true)"
if [[ -n "$ende" ]]; then
  tls_tage=$(( ( $(date -d "$ende" +%s) - $(date +%s) ) / 86400 ))
  if (( tls_tage < MONITOR_TLS_KRITISCH_TAGE )); then
    befund kritisch "TLS-Zertifikat läuft in $tls_tage Tagen ab" "$host:443"
    hebe KRITISCH
    "$HIER/alert.sh" kritisch tls-ablauf "Zertifikat läuft in $tls_tage Tagen ab" || true
  elif (( tls_tage < MONITOR_TLS_WARN_TAGE )); then
    befund mittel "TLS-Zertifikat läuft in $tls_tage Tagen ab" "$host:443"
    hebe WARNUNG
    "$HIER/alert.sh" warnung tls-ablauf "Zertifikat läuft in $tls_tage Tagen ab" || true
  else
    "$HIER/alert.sh" entwarnung tls-ablauf "Zertifikat gültig noch $tls_tage Tage" || true
  fi
else
  befund hoch "TLS-Zertifikat nicht lesbar" "$host:443"
  hebe WARNUNG
fi

# --- 4. Dateien, die nie erreichbar sein dürfen ------------------------------
# Feste, kurze Liste — kein Wörterbuch, keine Suche. Jede Zeile: Pfad und
# Schwere, falls er mit 200 antwortet. Next.js antwortet auf Unbekanntes mit
# 404; ein 200 heisst hier, dass etwas ausgeliefert wird, was im Build nichts
# zu suchen hat.
offen=0
if [[ "$erreichbar" == true ]]; then
  while read -r pfad schwere; do
    [[ -z "$pfad" || "$pfad" == \#* ]] && continue
    read -r code _ <<< "$(abrufen "$pfad" "$arbeit/d.kopf" "$arbeit/d.rumpf")"
    if [[ "$code" == "200" ]]; then
      # Die eigene 404-Seite mit Status 200 wäre ein anderer Fehler, aber kein
      # offengelegtes Geheimnis — am Inhalt erkennbar.
      if grep -qi '<html' "$arbeit/d.rumpf" && [[ "$pfad" != *.html ]]; then
        befund niedrig "Pfad antwortet 200 mit einer HTML-Seite" "$pfad"
      else
        befund "$schwere" "Offen erreichbar: $pfad" "$pfad"
        offen=$((offen + 1))
      fi
    fi
  done <<'LISTE'
/.env kritisch
/.env.local kritisch
/.env.production kritisch
/.git/HEAD kritisch
/.git/config kritisch
/.npmrc kritisch
/backup.sql kritisch
/dump.sql kritisch
/db.sql kritisch
/prisma/schema.prisma hoch
/package.json mittel
/package-lock.json mittel
/next.config.ts mittel
/.next/server/app-paths-manifest.json hoch
/security-reports/letzter-lauf.json hoch
/.DS_Store niedrig
LISTE
  if (( offen > 0 )); then
    hebe KRITISCH
    "$HIER/alert.sh" kritisch dateien "$offen Datei(en) offen erreichbar — sofort prüfen" || true
  else
    "$HIER/alert.sh" entwarnung dateien "keine offen erreichbaren Dateien" || true
  fi
  # Ein geschützter Endpunkt muss ohne Token abweisen.
  read -r code _ <<< "$(abrufen "/api/cron/status" "$arbeit/c.kopf" "$arbeit/c.rumpf")"
  if [[ "$code" == "200" ]]; then
    befund kritisch "Cron-Status ohne Token erreichbar" "/api/cron/status"
    hebe KRITISCH
  fi
fi

# --- 5. Betrieb: geplante Läufe, Schadsoftwareprüfer, Sicherung, Probe ---------
# Mit dem Überwachungstoken (SECURITY_REPORT_TOKEN), nicht mit CRON_SECRET:
# Dieses Token liest den Zustand, löst aber keinen Lauf aus. Jeder Punkt hat
# einen eigenen Alarmschlüssel — ein gemeinsamer Alarm hiesse, erst suchen zu
# müssen, was los ist.
cron_gesund=unbekannt
pruefer=unbekannt
sicherung_h=-1
probe_h=-1
if [[ "$erreichbar" == true && -n "${SECURITY_REPORT_TOKEN:-}" && "$SECURITY_REPORT_TOKEN" != *'"'* ]]; then
  code="$(printf 'url = "https://%s/api/cron/status"\nheader = "Authorization: Bearer %s"\n' "$host" "$SECURITY_REPORT_TOKEN" |
    curl --silent --proto '=https' --max-time "$MONITOR_ZEITLIMIT_S" --config - -o "$arbeit/status.json" -w '%{http_code}' 2>/dev/null || echo 000)"
  pause
  if [[ "$code" == "200" || "$code" == "503" ]] && jq -e '.betrieb' "$arbeit/status.json" >/dev/null 2>&1; then
    cron_gesund="$(jq -r '.gesund' "$arbeit/status.json")"
    if [[ "$cron_gesund" != "true" ]]; then
      befund kritisch "Geplante Läufe ausgeblieben, hängend oder wiederholt gescheitert" "/api/cron/status"
      hebe KRITISCH
      "$HIER/alert.sh" kritisch cron "geplante Läufe nicht gesund" || true
    else
      "$HIER/alert.sh" entwarnung cron "geplante Läufe gesund" || true
    fi

    pruefer="$(jq -r '.betrieb.schadsoftwarepruefer | if .eingerichtet | not then "fehlt" elif .art != "clamav" then .art elif .erreichbar then "erreichbar" else "stumm" end' "$arbeit/status.json")"
    if [[ "$pruefer" != "erreichbar" ]]; then
      befund kritisch "Schadsoftwareprüfer: $pruefer — neue Dateien bleiben gesperrt" "ClamAV"
      hebe KRITISCH
      "$HIER/alert.sh" kritisch clamav "Schadsoftwareprüfer $pruefer" || true
    else
      "$HIER/alert.sh" entwarnung clamav "Schadsoftwareprüfer erreichbar" || true
    fi

    sicherung_h="$(jq -r '.betrieb.sicherung.alterStunden // -1' "$arbeit/status.json")"
    if [[ "$(jq -r '.betrieb.sicherung.frisch' "$arbeit/status.json")" != "true" ]]; then
      befund hoch "Letzte gemeldete Sicherung zu alt oder nie ($sicherung_h h)" "BACKUP"
      hebe WARNUNG
      "$HIER/alert.sh" warnung sicherung "letzte Sicherung ${sicherung_h} h (oder nie)" || true
    else
      "$HIER/alert.sh" entwarnung sicherung "Sicherung aktuell" || true
    fi

    probe_h="$(jq -r '.betrieb.wiederherstellung.alterStunden // -1' "$arbeit/status.json")"
    if [[ "$(jq -r '.betrieb.wiederherstellung.frisch' "$arbeit/status.json")" != "true" ]]; then
      befund hoch "Letzte bestandene Wiederherstellungsprobe zu alt oder nie ($probe_h h)" "BACKUP"
      hebe WARNUNG
      "$HIER/alert.sh" warnung wiederherstellung "letzte bestandene Probe ${probe_h} h (oder nie)" || true
    else
      "$HIER/alert.sh" entwarnung wiederherstellung "Wiederherstellungsprobe aktuell" || true
    fi
  else
    befund hoch "Betriebszustand nicht lesbar (HTTP $code) — Token prüfen" "/api/cron/status"
    hebe WARNUNG
  fi
fi

# --- Bericht ---------------------------------------------------------------
anzahl="$(wc -l < "$BEFUNDE" | tr -d ' ')"
kennzahlen="$(jq -cn --argjson e "$erreichbar" --argjson ms "$antwort_ms" --arg hs "$health_status" \
  --argjson tls "$tls_tage" --argjson kf "$fehlend" --argjson od "$offen" \
  --arg cg "$cron_gesund" --arg pr "$pruefer" --argjson sh "$sicherung_h" --argjson ph "$probe_h" \
  '{erreichbar: $e, antwortMs: $ms, healthStatus: $hs, tlsTageBisAblauf: $tls, kopfzeilenFehlend: $kf, offengelegteDateien: $od,
    cronGesund: $cg, schadsoftwarepruefer: $pr, backupAlterStunden: $sh, wiederherstellungAlterStunden: $ph}')"
zusammenfassung="Erreichbar: $erreichbar, TLS noch $tls_tage Tage, $fehlend Kopfzeile(n) fehlen, $offen Datei(en) offen, $anzahl Befund(e)."
melden EXTERNAL_MONITOR "$schwerste" "$zusammenfassung" "$kennzahlen"
protokoll "security_check: $schwerste — $zusammenfassung"
echo "$schwerste — $zusammenfassung"
[[ "$schwerste" != "KRITISCH" ]]
