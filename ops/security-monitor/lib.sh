#!/usr/bin/env bash
#
# Gemeinsame Hilfen der Überwachungsskripte. Wird mit `source` geladen.
#
# VORLAGE (ops/security-monitor/INSTALL.md). Nicht eingerichtet, nicht ausgeliefert.
#
# Drei Grundsätze, die jedes Skript hier einhält:
#
#  1. Höchstens 2 Anfragen pro Sekunde an die Anwendung (`pause` nach jeder
#     Anfrage). Die Überwachung darf nie selbst die Last sein, die sie meldet.
#  2. Nur lesende Anfragen (GET/HEAD) an die Anwendung — ausser dem einen
#     POST an den Berichtseingang. Nichts, was einen Zustand ändert.
#  3. Geheimnisse nur aus der Umgebung; an curl über die Standardeingabe
#     (`--config -`), damit sie nicht in der Prozessliste stehen.

: "${MONITOR_PAUSE_S:=0.5}"
: "${MONITOR_ZEITLIMIT_S:=10}"
: "${MONITOR_ZUSTAND:=/var/lib/clenaris-monitor}"
: "${MONITOR_PROTOKOLL:=/var/log/clenaris-monitor}"
: "${SECURITY_REPORT_URL:=}"
: "${SECURITY_REPORT_TOKEN:=}"

HIER="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

benoetigt() {
  local fehlt=0
  for werkzeug in "$@"; do
    if ! command -v "$werkzeug" >/dev/null 2>&1; then
      echo "Fehlendes Werkzeug: $werkzeug" >&2
      fehlt=1
    fi
  done
  (( fehlt == 0 )) || exit 3
}

pause() {
  sleep "$MONITOR_PAUSE_S"
}

protokoll() {
  mkdir -p "$MONITOR_PROTOKOLL"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$MONITOR_PROTOKOLL/monitor.log"
}

# Ein Befund als JSON-Zeile in die Sammeldatei $BEFUNDE.
# befund <schwere> <titel> [ort] [details]   schwere: kritisch|hoch|mittel|niedrig|info
befund() {
  jq -cn --arg s "$1" --arg t "${2:0:300}" --arg o "${3:-}" --arg d "${4:-}" \
    '{schwere: $s, titel: $t} + (if $o != "" then {ort: $o[0:300]} else {} end) + (if $d != "" then {details: $d[0:1000]} else {} end)' \
    >> "$BEFUNDE"
}

# Den Bericht an die Sicherheitszentrale senden.
# melden <quelle> <status> <zusammenfassung> <kennzahlen-json>
melden() {
  local quelle="$1" status="$2" zusammenfassung="$3" kennzahlen="$4"
  local rumpf
  rumpf="$(jq -cn \
    --arg quelle "$quelle" --arg status "$status" --arg z "${zusammenfassung:0:500}" \
    --arg zeit "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson k "$kennzahlen" \
    --slurpfile befunde "$BEFUNDE" \
    '{quelle: $quelle, status: $status, erstelltAm: $zeit, zusammenfassung: $z, befunde: ($befunde[0:200]), kennzahlen: $k}')"
  if [[ -z "$SECURITY_REPORT_URL" || -z "$SECURITY_REPORT_TOKEN" ]]; then
    protokoll "Bericht nicht gesendet (SECURITY_REPORT_URL/SECURITY_REPORT_TOKEN leer): $quelle $status"
    return 0
  fi
  if [[ "$SECURITY_REPORT_URL" != https://* || "$SECURITY_REPORT_URL$SECURITY_REPORT_TOKEN" == *'"'* ]]; then
    protokoll "Bericht nicht gesendet: SECURITY_REPORT_URL muss https sein, keine Anführungszeichen"
    return 0
  fi
  local code
  code="$(printf 'url = "%s"\nheader = "Authorization: Bearer %s"\n' "$SECURITY_REPORT_URL" "$SECURITY_REPORT_TOKEN" |
    curl --silent --show-error --max-time 15 --proto '=https' --config - \
      -H 'Content-Type: application/json' --data-binary "$rumpf" -o /dev/null -w '%{http_code}' || echo 000)"
  protokoll "Bericht $quelle $status gesendet: HTTP $code"
  pause
}
