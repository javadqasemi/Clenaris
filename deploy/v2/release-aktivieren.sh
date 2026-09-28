#!/usr/bin/env bash
#
# Production V2 — ein geprüftes Release-Artefakt aktivieren.
#
#   bash release-aktivieren.sh <archiv.tar.gz>
#
# Seit 2026-09-27 der einzige vorgesehene Auslieferungsweg (Notfallauftrag,
# Phase 8): `.github/workflows/deploy.yml` überträgt das in CI gepackte
# Artefakt und ruft dieses Skript. Auf keinem Server ausgeführt und unter
# Windows ohne Bash nicht einmal örtlich gelaufen — vor dem ersten Einsatz auf
# einem Probeserver durchspielen (docs/PRODUCTION_V2.md, V2-3).
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

# Seit V2-1 (2026-09-26) ist das Artefakt an keine Adresse gebunden: Die
# Herkunft dieser Instanz kommt zur Laufzeit aus `APP_URL`. Bis dahin stand
# hier ein Vergleich „gebaut für X, Server ist Y" — nötig, solange die
# Adresse im Bündel festsass. Jetzt muss der Server sie nur **haben**; ohne
# sie verweigert die Anwendung in der Produktion jeden absoluten Link.
SERVER_URL="$(grep -E '^APP_URL=' "${BASIS}/shared/.env" | tail -n1 | cut -d= -f2- | tr -d '"'"'")"
[[ -n "${SERVER_URL}" ]] || fail "APP_URL fehlt in ${BASIS}/shared/.env."
log "APP_URL        : ${SERVER_URL} (Laufzeit)"
log "Kanonisch      : $(feld seitenUrl) (Bauzeit, statische Website)"

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
# Reihenfolge (docs/PREPRODUCTION_READINESS.md, Migrationssicherheit):
#   lesende Vorprüfung → geprüfte Sicherung → Migration → Umschalten → Health.
# Die Vorprüfung steht vor der Sicherung: Findet sie einen Eindeutigkeits-
# konflikt, bricht die Aktivierung ab, bevor irgendetwas geschrieben wurde —
# `migrate deploy` bliebe sonst mitten in der Reihe stehen, und der Rücksprung
# stellt nur die Anwendung wieder her, nie das Schema. (Ergänzt 2026-09-26;
# vorher fehlte die Vorprüfung hier, während `deploy.sh` sie kannte.)
#
# Seit dem Notfallauftrag 2026-09-27 mit zwei festen Regeln davor:
#
#  • **Erst das Artefakt, dann das Schema.** Hier liegt das Release bereits
#    geprüft und entpackt vor — die Migration läuft also erst, wenn feststeht,
#    dass das Programm, das zu ihr passt, sofort startbereit ist. Die
#    Auslieferung auf den alten Server hatte das umgekehrt: Sie migrierte und
#    baute danach zehn Minuten lang, während die alte Fassung gegen das neue
#    Schema lief.
#  • **Produktionsvorprüfung vor jeder Schreibhandlung** (`--phase
#    vor-migration`): Umgebung, Geheimnisse, Demozugänge, Konten mit
#    veröffentlichten Passwörtern, Scanner, Proxy — und die Einstufung der
#    offenen Migrationen aus `security/migrations-vertraeglichkeit.json`. Eine
#    BRECHENDE Migration hält hier an, ausser `CLENARIS_WARTUNGSFENSTER=ja`
#    ist bewusst gesetzt.
wartung=()
[[ "${CLENARIS_WARTUNGSFENSTER:-}" == "ja" ]] && wartung=(--wartungsfenster)
npx tsx scripts/production-preflight.ts --phase vor-migration "${wartung[@]}" \
  || fail "Produktionsvorprüfung (vor der Migration) nicht bestanden — nichts migriert, nichts umgeschaltet."

if ! npx prisma migrate status >/dev/null 2>&1; then
  log "Migrationen stehen an — Vorprüfung, dann Sicherung."
  npx tsx scripts/migration-preflight.ts \
    || fail "Vorprüfung meldet Konflikte — keine Sicherung, keine Migration, kein Umschalten."
  APP_DIRECTORY="${BASIS}" npx tsx scripts/db-backup.ts --grund migration --commit "${COMMIT}" \
    || fail "Sicherung fehlgeschlagen — keine Migration."
  npx prisma migrate deploy
fi

# Nach der Migration noch einmal, jetzt ohne offene Migration: Das Programm,
# das gleich startet, muss zu genau diesem Schema passen.
npx tsx scripts/production-preflight.ts \
  || fail "Produktionsvorprüfung (vor dem Umschalten) nicht bestanden — nicht umgeschaltet. Achtung: Migrationen sind bereits angewandt."

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
