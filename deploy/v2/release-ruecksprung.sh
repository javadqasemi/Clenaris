#!/usr/bin/env bash
#
# Production V2 — Rücksprung von Hand auf ein früheres, aufbewahrtes Release.
#
#   CLENARIS_BASIS=/home/clenaris/clenaris \
#     bash deploy/v2/release-ruecksprung.sh --auf <commit, 40 Hex> --erwartet-sha256 <64 Hex> \
#                                           [--port 3000] [--schema-bewusst]
#
# Eine dünne Hülle um `scripts/release-ruecksprung.ts` — mit genau zwei
# Aufgaben, die dort nicht gehen:
#
#  • **Die Sperre.** Dieselbe Datei wie `release-aktivieren.sh`
#    (`${BASIS}/.release.lock`, `flock`): Ein Rücksprung, während eine
#    Aktivierung läuft, schaltete mitten in deren Identitätsprüfung um. Node
#    kann kein `flock` halten, also hält es diese Hülle, solange das Werkzeug
#    läuft. Das Werkzeug bekommt den Deskriptor mit `9>&-` geschlossen: Es
#    startet pm2, womöglich den pm2-Dienst selbst, und ein Dienst, der die
#    Sperre erbt, hielte sie für immer.
#  • **Das Werkzeug aus dem laufenden Release.** Aufgelöst über
#    `readlink -f current` — nicht aus einem Arbeitsbaum, nicht aus dem Ziel.
#    Das laufende Release kennt seine eigenen Migrationen und deren
#    Einstufung; nur es kann sagen, was beim Rücksprung im Schema zurückbleibt.
#
# Ausgänge wie `release-aktivieren.sh` (Vertrag C3): 0 AKTIV (Ziel läuft,
# Identität bestätigt), 10 NICHT_UMGESCHALTET (verweigert, nichts geändert),
# 11 GESPERRT, 20 ZURUECK (Ziel scheiterte, das vorher Laufende läuft
# nachweislich wieder), 30 UNKLAR. Letzte Zeile: ERGEBNIS {…}.
#
# Die erwartete Summe kommt aus einer Quelle ausserhalb des Servers: aus der
# Zusammenfassung des CI-Laufs, der das Archiv gebaut hat, oder aus dem
# Release Center (`Release.artifactSha256`). Die `.sha256` neben dem
# aufbewahrten Archiv allein genügt nicht — sie liegt auf demselben Server.
#
set -Eeuo pipefail

readonly BASIS="${CLENARIS_BASIS:-/home/clenaris/clenaris}"
readonly SPERRE="${BASIS}/.release.lock"

ergebnis() {
  printf 'ERGEBNIS {"code":%d,"zustand":"%s","commit":""}\n' "$1" "$2"
  exit "$1"
}

[[ -d "${BASIS}" ]] || { echo "FEHLER: ${BASIS} fehlt." >&2; ergebnis 10 NICHT_UMGESCHALTET; }
command -v flock >/dev/null 2>&1 || { echo "FEHLER: flock fehlt." >&2; ergebnis 10 NICHT_UMGESCHALTET; }

exec 9>>"${SPERRE}"
if ! flock -n 9; then
  echo "Eine Aktivierung oder ein anderer Rücksprung hält ${SPERRE}." >&2
  ergebnis 11 GESPERRT
fi

[[ -L "${BASIS}/current" ]] || { echo "FEHLER: ${BASIS}/current fehlt — ohne laufendes Release kein Rücksprung." >&2; ergebnis 10 NICHT_UMGESCHALTET; }
AKTUELL="$(readlink -f -- "${BASIS}/current")"
readonly AKTUELL
readonly WERKZEUG="${AKTUELL}/scripts/release-ruecksprung.ts"
readonly TSX="${AKTUELL}/node_modules/tsx/dist/cli.mjs"
if [[ ! -f "${WERKZEUG}" || ! -f "${TSX}" ]]; then
  # Ein Release von vor dem 2026-09-30 bringt das Werkzeug nicht mit. Dann
  # gibt es keinen geprüften Rücksprung aus ihm heraus — und keinen
  # ungeprüften Ersatz aus diesem Skript.
  echo "FEHLER: Das laufende Release (${AKTUELL}) enthält scripts/release-ruecksprung.ts nicht." >&2
  ergebnis 10 NICHT_UMGESCHALTET
fi

# Kein `exec`: Die Hülle bleibt am Leben und hält damit die Sperre, bis das
# Werkzeug fertig ist; das Werkzeug selbst erbt den Deskriptor nicht.
set +e
CLENARIS_RELEASE_SPERRE="${SPERRE}" node "${TSX}" "${WERKZEUG}" --basis "${BASIS}" "$@" 9>&-
code=$?
set -e
exit "${code}"
