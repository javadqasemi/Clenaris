#!/usr/bin/env bash
#
# OWASP-ZAP-Grundprüfung (Baseline) gegen Clenaris — NUR PASSIV.
#
#   set -a; . /etc/clenaris-monitor/monitor.env; set +a
#   ./zap_baseline.sh
#
# VORLAGE für den Überwachungsrechner (ops/security-monitor/INSTALL.md).
# Nicht eingerichtet, nicht ausgeliefert. NICHT auf 2.29.18.45.
#
# Was die Baseline tut: Sie erkundet die Website eine begrenzte Zeit mit dem
# Spider und bewertet die Antworten **passiv** — Kopfzeilen, Cookies,
# Informationspreisgabe, gemischte Inhalte. Sie sendet **keine**
# Angriffsnutzlasten. Der aktive Scan (`zap-full-scan.py`, `zap-api-scan.py`)
# ist gegen Produktion ausdrücklich NICHT vorgesehen: Er schreibt in Formulare,
# legt Anfragen, Buchungen und Konten an und kann Kontosperren auslösen.
# Aktive Prüfungen gehören gegen eine Kopie (`npm run preview:server`).
#
# Last: Der ZAP-Spider hält sich nicht an die 2 Anfragen pro Sekunde der
# übrigen Überwachung. Die Laufzeit ist deshalb begrenzt (ZAP_SPIDER_MIN) und
# der Takt wöchentlich, ausserhalb der Arbeitszeit (INSTALL.md). Wer das
# strenger will, prüft gegen die Vorschau statt gegen Produktion.
#
# Ergebnis: Bericht ZAP_BASELINE an die Sicherheitszentrale; Alarm bei
# Befunden der Risikostufe „High".
#
set -Eeuo pipefail

HIER="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HIER/lib.sh"

: "${MONITOR_ZIEL:?MONITOR_ZIEL fehlt}"
: "${ZAP_ABBILD:=ghcr.io/zaproxy/zaproxy:stable}"
: "${ZAP_SPIDER_MIN:=2}"

benoetigt docker jq

if [[ "$MONITOR_ZIEL" != https://* ]]; then
  echo "MONITOR_ZIEL muss https sein." >&2
  exit 2
fi
if [[ ! "$ZAP_SPIDER_MIN" =~ ^[1-9][0-9]?$ ]]; then
  echo "ZAP_SPIDER_MIN muss 1–99 sein." >&2
  exit 2
fi

arbeit="$(mktemp -d)"
trap 'rm -rf -- "$arbeit"' EXIT
chmod 0777 "$arbeit" # der Container schreibt als eigener Benutzer
BEFUNDE="$arbeit/befunde.jsonl"
: > "$BEFUNDE"

# -I: Warnungen beenden den Lauf nicht mit Fehlercode — ausgewertet wird der
# JSON-Bericht, nicht der Rückgabewert. Kein -a (keine Alpha-Regeln), kein -j
# (kein AJAX-Spider mit Browser).
set +e
docker run --rm --network host -v "$arbeit:/zap/wrk:rw" "$ZAP_ABBILD" \
  zap-baseline.py -t "$MONITOR_ZIEL" -m "$ZAP_SPIDER_MIN" -J zap.json -I >"$arbeit/zap.log" 2>&1
lauf=$?
set -e

if [[ ! -s "$arbeit/zap.json" ]]; then
  befund hoch "ZAP-Grundprüfung ohne Bericht (Rückgabe $lauf)" "" "$(tail -n 20 "$arbeit/zap.log" | tr '\n' ' ' | cut -c1-900)"
  melden ZAP_BASELINE NICHT_GEPRUEFT "ZAP lief nicht durch (Rückgabe $lauf)." '{}'
  exit 1
fi

# riskcode: 0 Info, 1 Niedrig, 2 Mittel, 3 Hoch.
jq -c '.site[]?.alerts[]? | {
    titel: ("ZAP: " + .name)[0:300],
    schwere: (if .riskcode == "3" then "hoch" elif .riskcode == "2" then "mittel" elif .riskcode == "1" then "niedrig" else "info" end),
    ort: ((.instances[0].uri // "")[0:300]),
    details: ("Fundstellen: " + (.count // "?") + (if .cweid then " · CWE-" + .cweid else "" end))
  }' "$arbeit/zap.json" > "$BEFUNDE"

hoch="$(jq -s '[.[] | select(.schwere == "hoch")] | length' "$BEFUNDE")"
mittel="$(jq -s '[.[] | select(.schwere == "mittel")] | length' "$BEFUNDE")"
status="OK"
(( mittel > 0 )) && status="WARNUNG"
(( hoch > 0 )) && status="KRITISCH"

kennzahlen="$(jq -cn --argjson h "$hoch" --argjson m "$mittel" '{zapFehler: $h, zapWarnungen: $m}')"
melden ZAP_BASELINE "$status" "ZAP-Grundprüfung (passiv): $hoch hoch, $mittel mittel." "$kennzahlen"
if (( hoch > 0 )); then
  "$HIER/alert.sh" kritisch zap "$hoch Befund(e) der Stufe hoch in der ZAP-Grundprüfung" || true
else
  "$HIER/alert.sh" entwarnung zap "keine Befunde der Stufe hoch" || true
fi
protokoll "zap_baseline: $status — $hoch hoch, $mittel mittel"
echo "$status — $hoch hoch, $mittel mittel"
