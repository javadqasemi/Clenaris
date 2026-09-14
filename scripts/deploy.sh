#!/usr/bin/env bash
#
# Auslieferung auf den Produktionsserver.
#
#   bash scripts/deploy.sh
#
# Mit `bash` davor, nicht als `./scripts/deploy.sh`: Das Repository wird unter
# Windows gepflegt, und Git überträgt das Ausführungsrecht von dort nicht. Wer
# es auf dem Server setzen will: `chmod +x scripts/*.sh` — nötig ist es nicht.
#
# Wird von `.github/workflows/deploy.yml` über SSH aufgerufen, läuft aber
# genauso von Hand — das ist Absicht: Ein Auslieferungsweg, den man nur über
# GitHub auslösen kann, steht genau dann nicht zur Verfügung, wenn man ihn am
# dringendsten braucht.
#
# Eigenschaften:
#
#  • **Idempotent.** Zweimal hintereinander ausgeführt ändert der zweite Lauf
#    nichts: `git reset --hard` führt auf denselben Stand, `npm ci` erzeugt
#    denselben Baum, `prisma migrate deploy` überspringt angewandte
#    Migrationen, und der Reload ist ohnehin wiederholbar.
#
#  • **Alles oder nichts.** Schlägt ein Schritt fehl, wird der vorherige Stand
#    wiederhergestellt und der Prozess damit neu geladen. Es bleibt nie eine
#    halb ausgelieferte Fassung stehen.
#
#  • **Ohne Ausfallzeit.** `pm2 reload` startet die neuen Arbeiter und beendet
#    die alten erst, wenn die neuen auf dem Port hören.
#
# Steuerung über Umgebungsvariablen (alle optional):
#   DEPLOY_BRANCH        Zweig, Vorgabe `main`
#   DEPLOY_PORT          Port für den Health Check, Vorgabe 3000
#   DEPLOY_HEALTH_PATH   Pfad des Health Checks, Vorgabe /api/health
#   DEPLOY_RUN_SEED      `true` führt den Konfigurations-Seed aus, Vorgabe aus
#   DEPLOY_SKIP_ROLLBACK `true` lässt einen Fehlschlag stehen (nur zur Analyse)
#   PM2_APP_NAME         Prozessname, Vorgabe `clenaris`
#
set -Eeuo pipefail

# ---------------------------------------------------------------------------
#  Grundlagen
# ---------------------------------------------------------------------------

# Das Projektverzeichnis ergibt sich aus dem Ort des Skripts, nicht aus dem
# Arbeitsverzeichnis des Aufrufers. Sonst liefe ein Aufruf aus dem Heimatordner
# `git reset --hard` im falschen Repository aus — der teuerste denkbare Fehler.
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly APP_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "${APP_DIR}"

readonly BRANCH="${DEPLOY_BRANCH:-main}"
readonly PORT="${DEPLOY_PORT:-3000}"
readonly HEALTH_PATH="${DEPLOY_HEALTH_PATH:-/api/health}"
readonly HEALTH_URL="http://127.0.0.1:${PORT}${HEALTH_PATH}"
readonly APP_NAME="${PM2_APP_NAME:-clenaris}"

readonly LOG_DIR="${APP_DIR}/logs/deployment"
readonly BACKUP_DIR="${APP_DIR}/.deploy/backups"
readonly LOCK_FILE="${APP_DIR}/.deploy/deploy.lock"
readonly STAMP="$(date +%Y%m%d-%H%M%S)"
readonly LOG_FILE="${LOG_DIR}/${STAMP}.log"

mkdir -p "${LOG_DIR}" "${BACKUP_DIR}" "$(dirname -- "${LOCK_FILE}")" "${APP_DIR}/logs/pm2"

# Ab hier geht jede Ausgabe gleichzeitig ins Protokoll und an den Aufrufer.
# `exec` statt eines `| tee` am Ende jeder Zeile: So landet auch die Ausgabe
# von npm, Prisma und PM2 im Protokoll, nicht nur die eigenen Meldungen.
exec > >(tee -a "${LOG_FILE}") 2>&1

log()  { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
step() { printf '\n%s  ── %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
fail() { log "FEHLER: $*"; exit 1; }

# ---------------------------------------------------------------------------
#  Zustand für den Rücksprung
# ---------------------------------------------------------------------------

PREVIOUS_SHA=""
BACKUP_PATH=""
MIGRATIONS_APPLIED="nein"
DEPLOY_OK="nein"

# ---------------------------------------------------------------------------
#  Rücksprung
# ---------------------------------------------------------------------------
#
# Wichtig und in `docs/deployment.md` ausführlich begründet: Der Rücksprung
# stellt die **Anwendung** wieder her, nicht das **Datenbankschema**. Prisma
# kennt keine Abwärtsmigration, und eine automatisch erzeugte wäre gefährlicher
# als der Fehler, den sie beheben soll. Daraus folgt die Regel für jede
# Migration: Sie muss zur *vorherigen* Programmfassung passen — Spalten
# hinzufügen statt umbenennen, Nicht-Null erst im zweiten Schritt.
rollback() {
  if [[ "${DEPLOY_SKIP_ROLLBACK:-false}" == "true" ]]; then
    log "Rücksprung übersprungen (DEPLOY_SKIP_ROLLBACK=true). Der Stand bleibt zur Analyse stehen."
    return
  fi
  if [[ -z "${PREVIOUS_SHA}" ]]; then
    log "Kein vorheriger Stand bekannt — nichts zum Zurücksetzen."
    return
  fi

  step "RÜCKSPRUNG auf ${PREVIOUS_SHA}"

  if [[ "${MIGRATIONS_APPLIED}" == "ja" ]]; then
    log "ACHTUNG: In diesem Lauf wurden Migrationen angewandt. Sie bleiben bestehen."
    log "         Prüfen Sie, ob die vorherige Programmfassung mit dem neuen Schema läuft."
  fi

  git reset --hard "${PREVIOUS_SHA}" || log "Warnung: git reset im Rücksprung fehlgeschlagen."
  npm ci --no-audit --no-fund || log "Warnung: npm ci im Rücksprung fehlgeschlagen."

  # Der gesicherte Build ist schneller und verlässlicher als ein neuer: Er ist
  # genau der Stand, der vorher nachweislich lief.
  if [[ -n "${BACKUP_PATH}" && -d "${BACKUP_PATH}/.next" ]]; then
    rm -rf "${APP_DIR}/.next"
    cp -a "${BACKUP_PATH}/.next" "${APP_DIR}/.next"
    log "Vorherigen Build wiederhergestellt."
  else
    log "Kein gesicherter Build vorhanden — baue den vorherigen Stand neu."
    npm run build || log "Warnung: Neubau im Rücksprung fehlgeschlagen."
  fi

  if [[ -n "${BACKUP_PATH}" && -f "${BACKUP_PATH}/.env" ]]; then
    cp -a "${BACKUP_PATH}/.env" "${APP_DIR}/.env"
    chmod 600 "${APP_DIR}/.env"
    log "Vorherige Umgebungsdatei wiederhergestellt."
  fi

  reload_pm2 || log "Warnung: PM2-Reload im Rücksprung fehlgeschlagen."

  if health_check 12; then
    log "Rücksprung erfolgreich — der vorherige Stand antwortet wieder."
  else
    log "KRITISCH: Auch der vorherige Stand antwortet nicht. Manueller Eingriff nötig."
  fi
}

on_error() {
  local line=$1
  # Zuerst die Falle lösen und `set -e` abschalten. Sonst löste der erste
  # fehlschlagende Befehl *innerhalb* des Rücksprungs die Falle erneut aus —
  # und der Rücksprung bräche mitten in der Wiederherstellung ab, also genau
  # in dem Moment, in dem die Anwendung am verwundbarsten ist.
  trap - ERR
  set +e
  log "Abbruch in Zeile ${line}."
  rollback
  step "AUSLIEFERUNG FEHLGESCHLAGEN"
  log "Protokoll: ${LOG_FILE}"
  exit 1
}
trap 'on_error ${LINENO}' ERR

on_exit() {
  # Nur aufräumen, was dieser Lauf angelegt hat.
  rm -f "${APP_DIR}/.env.incoming" 2>/dev/null || true
}
trap on_exit EXIT

# ---------------------------------------------------------------------------
#  Hilfsfunktionen
# ---------------------------------------------------------------------------

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Befehl '$1' nicht gefunden. $2"
}

# Setzt einen Wert in `.env` — ersetzt ihn, wenn der Schlüssel schon da ist,
# sonst hängt er ihn an.
#
# Über `awk` und nicht über `sed -i "s|...|"`: Der Wert kommt aus einem Secret
# und darf jedes Zeichen enthalten. Ein Passwort mit `|`, `&` oder `/` würde
# einen `sed`-Ausdruck zerlegen und im besten Fall eine kaputte Zeile, im
# schlimmsten eine stille Falschbelegung erzeugen. `awk` bekommt den Wert über
# die Umgebung und interpretiert ihn nirgends.
set_env_var() {
  local key="$1" value="$2" tmp
  [[ "${key}" =~ ^[A-Z_][A-Z0-9_]*$ ]] || fail "Ungültiger Variablenname: ${key}"
  tmp="$(mktemp "${APP_DIR}/.env.tmp.XXXXXX")"
  ENV_KEY="${key}" ENV_VALUE="${value}" awk '
    BEGIN { key = ENVIRON["ENV_KEY"]; value = ENVIRON["ENV_VALUE"]; seen = 0 }
    index($0, key "=") == 1 { if (!seen) { print key "=" value; seen = 1 } next }
    { print }
    END { if (!seen) print key "=" value }
  ' "${APP_DIR}/.env" > "${tmp}"
  mv "${tmp}" "${APP_DIR}/.env"
  chmod 600 "${APP_DIR}/.env"
}

reload_pm2() {
  # `reload` setzt einen laufenden Prozess voraus. Beim allerersten Mal — und
  # nach einem Serverneustart ohne `pm2 resurrect` — gibt es keinen, dann ist
  # `start` richtig. Ein `reload` auf nichts schlüge sonst fehl, und die
  # Auslieferung bräche an der harmlosesten Stelle ab.
  if pm2 describe "${APP_NAME}" >/dev/null 2>&1; then
    log "PM2: reload ${APP_NAME} (ohne Ausfallzeit)"
    pm2 reload ecosystem.config.js --env production --update-env
  else
    log "PM2: ${APP_NAME} läuft nicht — Erststart"
    pm2 start ecosystem.config.js --env production
  fi
  pm2 save >/dev/null 2>&1 || true
}

# Wartet, bis der Health Check antwortet. Argument: Anzahl Versuche.
health_check() {
  local attempts="${1:-20}"
  local i
  for ((i = 1; i <= attempts; i++)); do
    local code
    code="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 10 "${HEALTH_URL}" 2>/dev/null || echo '000')"
    if [[ "${code}" == "200" ]]; then
      log "Health Check bestanden (HTTP 200, Versuch ${i})."
      curl -fsS --max-time 10 "${HEALTH_URL}" || true
      printf '\n'
      return 0
    fi
    log "Health Check Versuch ${i}/${attempts}: HTTP ${code} — warte 3 s."
    sleep 3
  done
  return 1
}

# ---------------------------------------------------------------------------
#  1) Vorprüfungen
# ---------------------------------------------------------------------------

step "AUSLIEFERUNG GESTARTET"
log "Verzeichnis: ${APP_DIR}"
log "Zweig:       ${BRANCH}"
log "Benutzer:    $(id -un)"
log "Protokoll:   ${LOG_FILE}"

[[ "$(id -u)" -ne 0 ]] || fail "Diese Auslieferung läuft nicht als root. Legen Sie einen eigenen Dienstbenutzer an."

require_command git  'Installieren Sie git.'
require_command node 'Installieren Sie Node.js 20.11 oder neuer.'
require_command npm  'Gehört zu Node.js.'
require_command pm2   'Installieren Sie PM2: npm install -g pm2'
require_command curl  'Wird für den Health Check gebraucht.'
require_command flock 'Gehört zu util-linux und trägt die Sperre gegen gleichzeitige Ausführung.'
require_command awk   'Wird für das Zusammenführen der Umgebungsdatei gebraucht.'

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "${node_major}" -ge 20 ]] || fail "Node ${node_major} ist zu alt. Die Anwendung verlangt mindestens 20.11."

[[ -d "${APP_DIR}/.git" ]] || fail "${APP_DIR} ist kein Git-Repository."

# Zwei gleichzeitige Auslieferungen würden sich gegenseitig den Arbeitsbaum
# unter den Füssen wegziehen. Der GitHub-Workflow verhindert das bereits über
# `concurrency`; hier steht die Sperre für den Fall des Aufrufs von Hand.
exec 9>"${LOCK_FILE}"
flock -n 9 || fail "Eine andere Auslieferung läuft bereits (Sperre: ${LOCK_FILE})."

# ---------------------------------------------------------------------------
#  2) Umgebungsdatei übernehmen
# ---------------------------------------------------------------------------
#
# Der Workflow legt `.env.incoming` aus den GitHub Secrets ab — und zwar nur
# die Schlüssel, die GitHub verwaltet.
#
# **Zusammenführen statt ersetzen**, und das ist der wichtige Teil: Die `.env`
# des Servers enthält weit mehr als die paar Secrets aus dem Workflow —
# Stripe, Resend, Twilio, Supabase, Maps, die Firmenangaben. Ein Ersetzen
# löschte sie alle, und die Anwendung liefe danach ohne E-Mail-Versand und
# ohne Zahlungen weiter, ohne dass irgendetwas fehlschlüge. Ein stiller
# Teilausfall ist schlimmer als ein lauter Abbruch.
#
# Fehlt die Datei, bleibt die bestehende `.env` unangetastet — genau das macht
# den Aufruf von Hand gefahrlos.
step "Umgebung"
[[ -f "${APP_DIR}/.env" ]] || fail "Es gibt keine .env. Legen Sie sie einmalig auf dem Server an (siehe docs/deployment.md)."
chmod 600 "${APP_DIR}/.env"

if [[ -f "${APP_DIR}/.env.incoming" ]]; then
  [[ -s "${APP_DIR}/.env.incoming" ]] || fail ".env.incoming ist leer — abgebrochen."
  merged=0
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ -z "${line}" || "${line}" == \#* ]] && continue
    [[ "${line}" == *=* ]] || continue
    set_env_var "${line%%=*}" "${line#*=}"
    merged=$((merged + 1))
  done < "${APP_DIR}/.env.incoming"
  shred -u "${APP_DIR}/.env.incoming" 2>/dev/null || rm -f "${APP_DIR}/.env.incoming"
  log "${merged} Werte aus den Secrets übernommen, übrige .env unverändert."
else
  log "Keine neuen Secrets — bestehende .env wird weiterverwendet."
fi

grep -q '^DATABASE_URL=' "${APP_DIR}/.env" || fail "DATABASE_URL fehlt in .env."
grep -q '^JWT_SECRET='   "${APP_DIR}/.env" || fail "JWT_SECRET fehlt in .env."

# ---------------------------------------------------------------------------
#  3) Sicherung
# ---------------------------------------------------------------------------

step "Sicherung des laufenden Stands"
PREVIOUS_SHA="$(git rev-parse HEAD)"
BACKUP_PATH="${BACKUP_DIR}/${STAMP}"
mkdir -p "${BACKUP_PATH}"
log "Aktueller Stand: ${PREVIOUS_SHA}"

if [[ -d "${APP_DIR}/.next" ]]; then
  # `cp -a` statt Verschieben: Der laufende Prozess liest weiter aus `.next`,
  # bis der Reload greift. Ein Verschieben zöge ihm die Dateien weg.
  cp -a "${APP_DIR}/.next" "${BACKUP_PATH}/.next"
  log "Build gesichert nach ${BACKUP_PATH}/.next"
fi
cp -a "${APP_DIR}/.env" "${BACKUP_PATH}/.env"
chmod 600 "${BACKUP_PATH}/.env"

# ---------------------------------------------------------------------------
#  4) Quellstand holen
# ---------------------------------------------------------------------------

step "Git"
git fetch --prune origin "${BRANCH}"
git reset --hard "origin/${BRANCH}"
# Unverfolgte Reste einer früheren Fassung — etwa eine gelöschte Route, die als
# Datei liegen bliebe — würden sonst mit ausgeliefert. Ausgenommen bleibt, was
# `.gitignore` bewusst schützt: `.env`, `logs/`, `.deploy/`, `node_modules/`.
git clean -fd -e .env -e logs -e .deploy -e node_modules

NEW_SHA="$(git rev-parse HEAD)"
log "Neuer Stand: ${NEW_SHA}"
if [[ "${NEW_SHA}" == "${PREVIOUS_SHA}" ]]; then
  log "Unverändert — die Auslieferung läuft trotzdem durch (idempotent)."
fi

# Die ausgelieferte Fassung gehört in den Health Check, damit von aussen
# nachprüfbar ist, welcher Stand tatsächlich antwortet.
set_env_var APP_VERSION "${NEW_SHA}"

# ---------------------------------------------------------------------------
#  5) Abhängigkeiten
# ---------------------------------------------------------------------------

step "Abhängigkeiten"
# `npm ci`, nicht `npm install`: nur die Sperrdatei zählt, und der Baum wird
# vorher gelöscht. Damit ist das Ergebnis reproduzierbar.
#
# Mit Entwicklungsabhängigkeiten, obwohl das ein Produktionsserver ist: Gebaut
# wird hier (TypeScript, Tailwind, Prisma CLI), und die Wartungsskripte laufen
# über `tsx`. Ein `--omit=dev` spart Plattenplatz und nimmt dafür die
# Möglichkeit, auf dem Server je wieder zu bauen.
npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------
#  6) Datenbank
# ---------------------------------------------------------------------------

step "Prisma"
npx prisma generate

# `migrate status` beantwortet die Frage, ob überhaupt etwas anliegt.
#
# Die Ausgabe wird erst eingesammelt und dann durchsucht — **nicht** über eine
# Pipe. Der Grund ist `set -o pipefail` in Verbindung damit, dass
# `migrate status` genau dann mit einem Fehlercode endet, wenn Migrationen
# *ausstehen*. In einer Pipe risse dieser Code das ganze Konstrukt auf
# «fehlgeschlagen», der `if`-Zweig wäre falsch, und ausgerechnet im
# Normalfall — es gibt neue Migrationen — würde keine angewandt.
#
# Entschieden wird über den Text, nicht über den Code: Ein Fehlercode kann auch
# «Datenbank nicht erreichbar» heissen, und `migrate deploy` ist folgenlos,
# wenn nichts ansteht. Der teurere Irrtum wäre, hier abzubrechen.
migrate_status="$(npx prisma migrate status 2>&1 || true)"
printf '%s\n' "${migrate_status}"

if printf '%s' "${migrate_status}" | grep -qi 'not yet been applied\|following migration'; then
  log "Neue Migrationen gefunden — werden angewandt."
  npx prisma migrate deploy
  MIGRATIONS_APPLIED="ja"
else
  log "Keine neuen Migrationen."
fi

if [[ "${DEPLOY_RUN_SEED:-false}" == "true" ]]; then
  # Nur der Konfigurations-Seed (Firma, Leistungen, Preise, Gebiet, Team) —
  # niemals `db:seed:demo`. Demodaten auf einem Produktionssystem sind
  # erfundene Bewertungen und Kundschaft, die öffentlich sichtbar werden.
  log "Konfigurations-Seed wird ausgeführt (DEPLOY_RUN_SEED=true)."
  npm run db:seed
else
  log "Seed übersprungen."
fi

# ---------------------------------------------------------------------------
#  7) Build
# ---------------------------------------------------------------------------

step "Build"
# Ein Fehler hier löst über die ERR-Falle den Rücksprung aus — der laufende
# Prozess bedient bis dahin ununterbrochen weiter aus dem alten `.next`.
npm run build
log "Build erfolgreich."

# ---------------------------------------------------------------------------
#  8) Neu laden
# ---------------------------------------------------------------------------

step "Neustart ohne Ausfallzeit"
reload_pm2
pm2 list

# ---------------------------------------------------------------------------
#  9) Health Check
# ---------------------------------------------------------------------------

step "Health Check"
if ! health_check 20; then
  fail "Health Check nach der Auslieferung fehlgeschlagen (${HEALTH_URL})."
fi

# ---------------------------------------------------------------------------
#  10) Aufräumen
# ---------------------------------------------------------------------------

step "Aufräumen"
# Drei Sicherungen genügen: Wer weiter zurück muss, tut das über Git und einen
# Neubau, nicht über einen Monate alten Build-Ordner.
find "${BACKUP_DIR}" -maxdepth 1 -mindepth 1 -type d | sort -r | tail -n +4 | while read -r old; do
  rm -rf "${old}"
  log "Alte Sicherung entfernt: $(basename -- "${old}")"
done

# Protokolle 30 Tage aufbewahren.
find "${LOG_DIR}" -maxdepth 1 -type f -name '*.log' -mtime +30 -delete 2>/dev/null || true

# Der Build-Zwischenspeicher wächst mit jeder Auslieferung; alles, was älter
# als eine Woche ist, gehört zu einer Build-ID, die es nicht mehr gibt.
if [[ -d "${APP_DIR}/.next/cache" ]]; then
  find "${APP_DIR}/.next/cache" -type f -mtime +7 -delete 2>/dev/null || true
  log "Build-Zwischenspeicher bereinigt."
fi

npm cache verify >/dev/null 2>&1 || true

DEPLOY_OK="ja"

# ---------------------------------------------------------------------------
#  11) Abschluss
# ---------------------------------------------------------------------------

step "Letzte Protokollzeilen der Anwendung"
pm2 logs "${APP_NAME}" --lines 25 --nostream || true

step "AUSLIEFERUNG ERFOLGREICH"
log "Stand:       ${PREVIOUS_SHA} → ${NEW_SHA}"
log "Migrationen: ${MIGRATIONS_APPLIED}"
log "Protokoll:   ${LOG_FILE}"
[[ "${DEPLOY_OK}" == "ja" ]]
