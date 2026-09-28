#!/usr/bin/env bash
#
# Alarm senden — mit Schwere und Entdoppelung.
#
#   alert.sh <schwere> <schluessel> <text>
#     schwere    : info | warnung | kritisch
#     schluessel : stabile Kennung des Problems, z. B. "tls-ablauf" oder "health"
#     text       : eine Zeile für Menschen (keine Geheimnisse)
#
#   alert.sh entwarnung <schluessel> <text>   # Problem behoben — einmal melden, Zustand löschen
#
# VORLAGE für den externen Überwachungsrechner (ops/security-monitor/INSTALL.md).
# Nicht eingerichtet, nicht ausgeliefert. Nicht auf 2.29.18.45 installieren.
#
# Entdoppelung: Je Schlüssel steht in $MONITOR_ZUSTAND/alarme/<schluessel> die
# zuletzt gemeldete Schwere und Zeit. Derselbe Alarm geht erst nach
# ALERT_WIEDERHOLEN_MIN Minuten wieder hinaus; eine HÖHERE Schwere sofort.
# Ohne Entdoppelung meldete ein Prüflauf alle fünf Minuten dasselbe — und nach
# einem Tag liest niemand mehr hin, auch nicht beim echten Ausfall.
#
# Geheimnisse (Webhook-Adresse) kommen aus der Umgebung und gehen nicht über
# die Befehlszeile: curl liest seine Konfiguration von der Standardeingabe.
#
set -Eeuo pipefail

: "${MONITOR_ZUSTAND:=/var/lib/clenaris-monitor}"
: "${ALERT_WIEDERHOLEN_MIN:=60}"
: "${ALERT_WEBHOOK_URL:=}"
: "${ALERT_MAIL_AN:=}"

schwere="${1:-}"
schluessel="${2:-}"
text="${3:-}"

case "$schwere" in
  info|warnung|kritisch|entwarnung) ;;
  *) echo "alert.sh: Schwere muss info|warnung|kritisch|entwarnung sein" >&2; exit 2 ;;
esac
# Der Schlüssel wird ein Dateiname: nur harmlose Zeichen.
if [[ ! "$schluessel" =~ ^[a-z0-9._-]{1,64}$ ]]; then
  echo "alert.sh: ungültiger Schlüssel" >&2
  exit 2
fi
# Eine Zeile, begrenzt, ohne Steuerzeichen.
text="$(printf '%s' "$text" | tr -d '\000-\010\013\014\016-\037' | tr '\n\r' '  ' | cut -c1-400)"

rang() {
  case "$1" in info) echo 1 ;; warnung) echo 2 ;; kritisch) echo 3 ;; *) echo 0 ;; esac
}

verzeichnis="$MONITOR_ZUSTAND/alarme"
mkdir -p "$verzeichnis"
chmod 0750 "$verzeichnis"
datei="$verzeichnis/$schluessel"
jetzt="$(date +%s)"

if [[ "$schwere" == "entwarnung" ]]; then
  # Nur wenn vorher ein Alarm lief — sonst wäre jede gesunde Runde eine Nachricht.
  [[ -f "$datei" ]] || exit 0
  rm -f -- "$datei"
else
  if [[ -f "$datei" ]]; then
    read -r alt_schwere alt_zeit < "$datei" || true
    if (( $(rang "$schwere") <= $(rang "${alt_schwere:-info}") )) && (( jetzt - ${alt_zeit:-0} < ALERT_WIEDERHOLEN_MIN * 60 )); then
      exit 0
    fi
  fi
  printf '%s %s\n' "$schwere" "$jetzt" > "$datei"
fi

rechner="$(hostname -s 2>/dev/null || echo monitor)"
zeile="[Clenaris ${schwere^^}] ${schluessel}: ${text} (${rechner}, $(date -u +%Y-%m-%dT%H:%M:%SZ))"

gesendet=0
if [[ -n "$ALERT_WEBHOOK_URL" ]]; then
  # Nur https, und nur Zeichen, die in eine curl-Konfigurationszeile passen —
  # ein Anführungszeichen in der Adresse würde die Zeile sonst umdeuten.
  if [[ "$ALERT_WEBHOOK_URL" != https://* || "$ALERT_WEBHOOK_URL" == *[[:space:]\"\\]* ]]; then
    echo "alert.sh: ALERT_WEBHOOK_URL muss eine https-Adresse ohne Anführungszeichen sein — nicht gesendet" >&2
  else
    # JSON sicher bauen (jq maskiert), Adresse über --config von stdin.
    rumpf="$(jq -cn --arg text "$zeile" '{text: $text}')"
    if printf 'url = "%s"\n' "$ALERT_WEBHOOK_URL" | curl --silent --show-error --fail --max-time 10 \
        --proto '=https' --config - -H 'Content-Type: application/json' --data "$rumpf" >/dev/null; then
      gesendet=1
    else
      echo "alert.sh: Webhook nicht erreichbar" >&2
    fi
  fi
fi
if [[ -n "$ALERT_MAIL_AN" ]] && command -v mail >/dev/null 2>&1; then
  if printf '%s\n' "$zeile" | mail -s "[Clenaris ${schwere^^}] ${schluessel}" -- "$ALERT_MAIL_AN"; then
    gesendet=1
  fi
fi

# Immer ins Protokoll — auch wenn kein Kanal eingerichtet ist.
logger -t clenaris-monitor -- "$zeile" 2>/dev/null || true
echo "$zeile"
if (( gesendet == 0 )) && [[ -n "$ALERT_WEBHOOK_URL$ALERT_MAIL_AN" ]]; then
  exit 1
fi
