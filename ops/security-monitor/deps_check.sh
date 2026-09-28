#!/usr/bin/env bash
#
# Abhängigkeiten, Betriebssystem, Signaturen, Sicherung, Integrität — auf dem
# ANWENDUNGSSERVER, nur lesend.
#
#   set -a; . /etc/clenaris-monitor/monitor.env; set +a
#   ./deps_check.sh
#
# VORLAGE (ops/security-monitor/INSTALL.md). Nicht eingerichtet, nicht
# ausgeliefert. NICHT auf 2.29.18.45 — der gehört nicht mehr zu Clenaris.
#
# Anders als security_check.sh läuft dieses Skript auf dem Server selbst,
# weil es Dinge sieht, die von aussen unsichtbar sind. Es **ändert nichts**:
# kein `apt-get upgrade`, kein `npm install`, kein `npm audit fix`, kein
# Neustart. Updates sind eine Entscheidung mit Freigabe (Update Center der
# Anwendung, docs/RELEASEBEREITSCHAFT.md), keine Nebenwirkung einer Prüfung.
#
# Prüft:
#   1. Betriebssystem  ausstehende Pakete und Sicherheitsupdates (apt, Simulation)
#   2. npm audit       Laufzeitabhängigkeiten der ausgelieferten Fassung
#   3. ClamAV          Alter der Signaturen
#   4. Sicherung       Alter der neuesten clenaris_*.dump
#   5. AIDE            Abweichungen, falls eingerichtet (braucht root)
#
set -Eeuo pipefail

HIER="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HIER/lib.sh"

: "${APP_VERZEICHNIS:=/srv/clenaris/current}"
: "${BACKUP_VERZEICHNIS:=/srv/clenaris/backups}"
: "${BACKUP_WARN_STUNDEN:=26}"

benoetigt jq date find stat

arbeit="$(mktemp -d)"
trap 'rm -rf -- "$arbeit"' EXIT
BEFUNDE="$arbeit/befunde.jsonl"
: > "$BEFUNDE"
status="OK"
hebe() {
  if [[ "$1" == "KRITISCH" ]]; then status="KRITISCH"
  elif [[ "$1" == "WARNUNG" && "$status" == "OK" ]]; then status="WARNUNG"; fi
}
ungeprueft=()

# --- 1. Betriebssystem --------------------------------------------------------
pakete=-1
sicherheit=-1
if command -v apt-get >/dev/null 2>&1; then
  # Simulation auf den vorhandenen Paketlisten; `apt-get update` macht
  # unattended-upgrades bzw. der Betrieb, nicht diese Prüfung.
  apt-get -s -o Debug::NoLocking=true upgrade 2>/dev/null > "$arbeit/apt.txt" || true
  pakete="$(grep -c '^Inst ' "$arbeit/apt.txt" || true)"
  sicherheit="$(grep '^Inst ' "$arbeit/apt.txt" | grep -ci 'security' || true)"
  if (( sicherheit > 0 )); then
    befund hoch "$sicherheit Sicherheitsupdate(s) des Betriebssystems ausstehend" "apt"
    hebe WARNUNG
  fi
else
  ungeprueft+=("Betriebssystem (kein apt)")
fi

# --- 2. npm audit der ausgelieferten Fassung ---------------------------------
kritisch_npm=-1
hoch_npm=-1
if [[ -f "$APP_VERZEICHNIS/package-lock.json" ]] && command -v npm >/dev/null 2>&1; then
  ( cd -- "$APP_VERZEICHNIS" && npm audit --omit=dev --json 2>/dev/null ) > "$arbeit/audit.json" || true
  if jq -e '.metadata.vulnerabilities' "$arbeit/audit.json" >/dev/null 2>&1; then
    kritisch_npm="$(jq '.metadata.vulnerabilities.critical // 0' "$arbeit/audit.json")"
    hoch_npm="$(jq '.metadata.vulnerabilities.high // 0' "$arbeit/audit.json")"
    if (( kritisch_npm > 0 )); then
      befund kritisch "$kritisch_npm kritische Lücke(n) in Laufzeitabhängigkeiten" "$APP_VERZEICHNIS" "Bewertung: security/akzeptierte-befunde.json, docs/LIEFERKETTE.md"
      hebe KRITISCH
    fi
    # `high` ist bewertet (akzeptierte-befunde.json) — hier nur gezählt; die
    # Einordnung macht `npm run security:check` im CI.
  else
    ungeprueft+=("npm audit (Registry nicht erreichbar?)")
  fi
else
  ungeprueft+=("npm audit (kein package-lock.json in $APP_VERZEICHNIS)")
fi

# --- 3. ClamAV-Signaturen -----------------------------------------------------
signatur_h=-1
for datei in /var/lib/clamav/daily.cld /var/lib/clamav/daily.cvd; do
  if [[ -f "$datei" ]]; then
    signatur_h=$(( ( $(date +%s) - $(stat -c %Y "$datei") ) / 3600 ))
    break
  fi
done
if (( signatur_h < 0 )); then
  ungeprueft+=("ClamAV-Signaturen (keine daily.cld/cvd)")
elif (( signatur_h > 48 )); then
  befund hoch "ClamAV-Signaturen $signatur_h Stunden alt — freshclam prüfen" "/var/lib/clamav"
  hebe WARNUNG
fi

# --- 4. Sicherung -------------------------------------------------------------
backup_h=-1
if [[ -d "$BACKUP_VERZEICHNIS" ]]; then
  neueste="$(find "$BACKUP_VERZEICHNIS" -maxdepth 1 -type f -name 'clenaris_*.dump' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n1 | cut -d' ' -f1)"
  if [[ -n "$neueste" ]]; then
    backup_h=$(( ( $(date +%s) - ${neueste%.*} ) / 3600 ))
    if (( backup_h > BACKUP_WARN_STUNDEN )); then
      befund hoch "Letzte Sicherung vor $backup_h Stunden" "$BACKUP_VERZEICHNIS"
      hebe WARNUNG
      "$HIER/alert.sh" warnung backup "letzte Sicherung vor $backup_h Stunden" || true
    else
      "$HIER/alert.sh" entwarnung backup "Sicherung aktuell ($backup_h h)" || true
    fi
  else
    befund kritisch "Keine Sicherung gefunden" "$BACKUP_VERZEICHNIS"
    hebe KRITISCH
    "$HIER/alert.sh" kritisch backup "keine Sicherung im Verzeichnis" || true
  fi
else
  ungeprueft+=("Sicherung (Verzeichnis fehlt)")
fi

# --- 5. AIDE (Rechnerintegrität) ----------------------------------------------
aide_abw=-1
if command -v aide >/dev/null 2>&1 && [[ $EUID -eq 0 ]]; then
  set +e
  aide --check > "$arbeit/aide.txt" 2>&1
  aide_code=$?
  set -e
  # Bits 1/2/4: hinzugefügt/entfernt/geändert; >= 14 ist ein Fehler von AIDE selbst.
  if (( aide_code >= 14 )); then
    ungeprueft+=("AIDE (Fehler $aide_code)")
  else
    aide_abw="$(grep -Eo 'Total number of entries (added|removed|changed): *[0-9]+' "$arbeit/aide.txt" | awk '{s += $NF} END {print s + 0}')"
    : > "$arbeit/integ.jsonl"
    BEFUNDE_ALT="$BEFUNDE"; BEFUNDE="$arbeit/integ.jsonl"
    integ_status="OK"
    if (( aide_abw > 0 )); then
      befund hoch "AIDE: $aide_abw veränderte Datei(en) seit der letzten Grundlinie" "aide --check"
      integ_status="WARNUNG"
      "$HIER/alert.sh" warnung aide "$aide_abw Abweichung(en) — prüfen, dann Grundlinie erneuern" || true
    fi
    melden HOST_INTEGRITY "$integ_status" "AIDE-Prüfung: $aide_abw Abweichung(en)." "$(jq -cn --argjson a "$aide_abw" '{aideAbweichungen: $a}')"
    BEFUNDE="$BEFUNDE_ALT"
  fi
else
  ungeprueft+=("AIDE (nicht eingerichtet oder nicht als root)")
fi

# --- Bericht ---------------------------------------------------------------
if (( ${#ungeprueft[@]} > 0 )); then
  befund info "Nicht geprüft: $(IFS='; '; echo "${ungeprueft[*]}")"
fi
kennzahlen="$(jq -cn --argjson p "$pakete" --argjson s "$sicherheit" --argjson k "$kritisch_npm" --argjson h "$hoch_npm" \
  --argjson c "$signatur_h" --argjson b "$backup_h" \
  '{paketeMitUpdates: $p, sicherheitsupdates: $s, npmKritisch: $k, npmHoch: $h, malwareSignaturenAlterStunden: $c, backupAlterStunden: $b}')"
zusammenfassung="OS: $sicherheit Sicherheitsupdate(s); npm: $kritisch_npm kritisch, $hoch_npm hoch; Signaturen $signatur_h h; Sicherung $backup_h h; nicht geprüft: ${#ungeprueft[@]}."
melden DEPENDENCY_CHECK "$status" "$zusammenfassung" "$kennzahlen"
protokoll "deps_check: $status — $zusammenfassung"
echo "$status — $zusammenfassung"
[[ "$status" != "KRITISCH" ]]
