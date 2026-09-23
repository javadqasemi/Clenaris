#!/usr/bin/env bash
#
# Production V2 — ein geprüftes Release-Artefakt aktivieren.
#
#   bash release-aktivieren.sh <archiv.tar.gz>
#
# ENTWURF (Wave 22). Nicht an `.github/workflows/deploy.yml` angeschlossen und
# auf keinem Server ausgeführt. Unter Windows ohne Bash nicht einmal örtlich
# gelaufen — vor dem ersten Einsatz auf einem Probeserver durchspielen
# (docs/PRODUCTION_V2.md, „Abnahme").
#
# ---------------------------------------------------------------------------
#  Unterschied zu scripts/deploy.sh
# ---------------------------------------------------------------------------
#
# `deploy.sh` holt den Commit und **baut auf dem Server**. Dieses Skript baut
# nichts: Es bekommt das Artefakt, das in der Pipeline geprüft wurde
# (`scripts/release-artefakt.ts`), prüft dessen Summe und Manifest, entpackt
# es in ein eigenes Verzeichnis und schaltet einen Verweis um. Was läuft, ist
# bytegenau, was geprüft wurde.
#
# Aufbau auf dem Server:
#
#   $BASIS/releases/<commit>/   ein entpacktes Artefakt je Commit, unverändert
#   $BASIS/current -> releases/<commit>
#   $BASIS/shared/.env          Geheimnisse, nie im Artefakt
#   $BASIS/shared/logs/         Protokolle über Releases hinweg
#
# Rücksprung = Verweis zurück + Reload. Kein Neubau, kein `npm ci`, keine
# Minuten — und das Schema bleibt, wie es ist (wie bei deploy.sh: eine
# Migration rückwärts ist eine Entscheidung, keine Automatik).
#
set -Eeuo pipefail

readonly ARCHIV="${1:?Archiv fehlt: bash release-aktivieren.sh <archiv.tar.gz>}"
readonly BASIS="${CLENARIS_BASIS:-/home/clenaris/clenaris}"
readonly PORT="${DEPLOY_PORT:-3000}"
readonly APP_NAME="${PM2_APP_NAME:-clenaris}"
readonly BEHALTEN="${CLENARIS_RELEASES_KEEP:-5}"

log()  { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
fail() { log "FEHLER: $*"; exit 1; }

[[ -f "${ARCHIV}" ]] || fail "Archiv ${ARCHIV} nicht gefunden."
[[ -f "${ARCHIV}.sha256" ]] || fail "Prüfsumme ${ARCHIV}.sha256 fehlt — ohne Summe keine Aktivierung."
[[ -f "${BASIS}/shared/.env" ]] || fail "${BASIS}/shared/.env fehlt."

# --- 1. Summe ---------------------------------------------------------------
# `sha256sum -c` im Verzeichnis des Archivs: Die .sha256-Datei nennt den
# Dateinamen ohne Pfad.
( cd "$(dirname -- "${ARCHIV}")" && sha256sum -c --status "$(basename -- "${ARCHIV}").sha256" ) \
  || fail "SHA-256 stimmt nicht. Das Archiv ist nicht das, was die Pipeline geprüft hat."
log "Prüfsumme      : in Ordnung"

# --- 2. Manifest ------------------------------------------------------------
MANIFEST="$(tar -xzOf "${ARCHIV}" RELEASE.json)" || fail "RELEASE.json fehlt im Archiv."
feld() { node -e 'const m=JSON.parse(process.argv[1]); const v=m[process.argv[2]]; process.stdout.write(v===undefined?"":String(v))' "${MANIFEST}" "$1"; }

[[ "$(feld anwendung)" == "clenaris" ]] || fail "Das Archiv ist kein Clenaris-Release."
[[ "$(feld auslieferbar)" == "true" ]] || fail "Das Manifest sagt auslieferbar=false (Probe, unsauberer Baum oder ohne Module)."
readonly COMMIT="$(feld commit)"
[[ "${COMMIT}" =~ ^[0-9a-f]{40}$ ]] || fail "Kein gültiger Commit im Manifest."
log "Commit         : ${COMMIT}"
log "Build-ID       : $(feld buildId)"
log "Node (Bau)     : $(feld node), hier: $(node -v)"

# Die beim Bau eingesetzte Adresse muss die dieses Servers sein —
# `NEXT_PUBLIC_*` steht fest im Bündel, die `.env` ändert daran nichts mehr.
SERVER_URL="$(grep -E '^NEXT_PUBLIC_APP_URL=' "${BASIS}/shared/.env" | tail -n1 | cut -d= -f2- | tr -d '"'"'")"
[[ -n "$(feld appUrl)" && "$(feld appUrl)" == "${SERVER_URL}" ]] \
  || fail "Artefakt gebaut für „$(feld appUrl)", Server ist „${SERVER_URL}"."

# Node muss in der Hauptversion übereinstimmen: node_modules enthält native
# Teile (Prisma-Engine), die gegen die Bau-Umgebung gebaut sind.
[[ "$(feld node | cut -d. -f1)" == "$(node -v | cut -d. -f1)" ]] \
  || fail "Node-Hauptversion weicht vom Bau ab."

# --- 3. Entpacken -----------------------------------------------------------
readonly ZIEL="${BASIS}/releases/${COMMIT}"
if [[ -d "${ZIEL}" ]]; then
  log "Release liegt bereits vor — wird unverändert wiederverwendet."
else
  mkdir -p "${ZIEL}.tmp"
  tar -xzf "${ARCHIV}" -C "${ZIEL}.tmp"
  mv "${ZIEL}.tmp" "${ZIEL}"
fi
ln -sfn "${BASIS}/shared/.env" "${ZIEL}/.env"
mkdir -p "${BASIS}/shared/logs"
ln -sfn "${BASIS}/shared/logs" "${ZIEL}/logs"

cd "${ZIEL}"

# --- 4. Korrektur noch da? --------------------------------------------------
node scripts/react-hydrationskorrektur.mjs --pruefen >/dev/null \
  || fail "React-Hydrationskorrektur im Artefakt nicht vorhanden."

# --- 5. Migrationen ---------------------------------------------------------
# Dieselbe Regel wie in deploy.sh: ohne geprüfte Sicherung keine Migration.
if ! npx prisma migrate status >/dev/null 2>&1; then
  log "Migrationen stehen an — Sicherung zuerst."
  APP_DIRECTORY="${BASIS}" npx tsx scripts/db-backup.ts --grund migration --commit "${COMMIT}" \
    || fail "Sicherung fehlgeschlagen — keine Migration."
  npx prisma migrate deploy
fi

# --- 6. Umschalten ----------------------------------------------------------
VORHER=""
[[ -L "${BASIS}/current" ]] && VORHER="$(readlink -f "${BASIS}/current")"

umschalten() {
  ln -sfn "$1" "${BASIS}/current.tmp"
  mv -T "${BASIS}/current.tmp" "${BASIS}/current"   # atomar
  APP_VERSION="$(basename -- "$1")" pm2 startOrReload "${BASIS}/current/ecosystem.config.js" --update-env
}

umschalten "${ZIEL}"

# --- 7. Health Check --------------------------------------------------------
gesund=""
for _ in $(seq 1 30); do
  antwort="$(curl -fsS "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || true)"
  if [[ "${antwort}" == *"\"version\":\"${COMMIT}\""* ]]; then gesund="ja"; break; fi
  sleep 2
done

if [[ -z "${gesund}" ]]; then
  log "Health Check meldet nicht ${COMMIT}."
  if [[ -n "${VORHER}" ]]; then
    log "Rücksprung auf $(basename -- "${VORHER}")."
    umschalten "${VORHER}"
  fi
  fail "Aktivierung fehlgeschlagen."
fi
log "Aktiv          : ${COMMIT}"

# --- 8. Aufbewahrung --------------------------------------------------------
# Nur Verzeichnisse mit Commit-Namen, nie das aktive, nie das vorherige.
cd "${BASIS}/releases"
ls -1t | grep -E '^[0-9a-f]{40}$' | tail -n +"$((BEHALTEN + 1))" | while read -r alt; do
  [[ "${BASIS}/releases/${alt}" == "${ZIEL}" || "${BASIS}/releases/${alt}" == "${VORHER}" ]] && continue
  rm -rf -- "${BASIS}/releases/${alt}"
  log "Entfernt       : ${alt}"
done
