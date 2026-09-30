#!/usr/bin/env bash
#
# Production V2 — ein geprüftes Release-Artefakt aktivieren.
#
#   CLENARIS_BASIS=/home/clenaris/clenaris \
#     bash release-aktivieren.sh <archiv.tar.gz> --erwartet-sha256 <64 Hexzeichen>
#
# Der einzige vorgesehene Weg, eine Fassung in Betrieb zu nehmen — für beide
# Auslieferungswege gleich (Vertrag C3, 2026-09-30): den direkten Auftrag
# `auslieferung` in `.github/workflows/deploy.yml` und den Release-Ausführer
# (`deploy/v2/release-ausfuehrer.yml`). Beide übertragen Archiv, `.sha256` und
# **dieses Skript aus dem Archiv selbst** und rufen es mit der Summe auf, die
# sie auf ihrer Seite gemessen und gegen die CI-Beilage geprüft haben.
#
# Auf keinem Server ausgeführt und unter Windows ohne Bash nicht einmal
# örtlich gelaufen — vor dem ersten Einsatz auf einem Probeserver durchspielen
# (docs/PRODUCTION_V2.md, V2-3). Die Regeln des Umschaltens selbst stehen
# deshalb in TypeScript (`scripts/release/umschaltung.ts`) und sind dort mit
# Attrappen geprüft (`tests/api/release-ruecksprung.test.ts`).
#
# ---------------------------------------------------------------------------
#  Ausgänge (Vertrag C3)
# ---------------------------------------------------------------------------
#
#    0  AKTIV               die neue Fassung läuft, Identität bestätigt
#                           (auch: sie lief schon und bestätigt sich — Wiederholung)
#   10  NICHT_UMGESCHALTET  vor dem Umschalten abgebrochen; `current` unverändert
#                           (Migrationen können bereits angewandt sein — das
#                           Protokoll sagt es)
#   11  GESPERRT            eine andere Aktivierung oder ein Rücksprung hält
#                           ${BASIS}/.release.lock
#   20  ZURUECK             umgeschaltet, neue Fassung nicht bestätigt, die
#                           vorherige läuft nachweislich wieder
#   30  UNKLAR              alles andere nach dem Umschalten
#
# Letzte Zeile auf stdout, immer: ERGEBNIS {"code":…,"zustand":"…","commit":"…"}
# Jeder Lauf steht zusätzlich als eine Zeile in ${BASIS}/aktivierungen.jsonl
# (Zeit, von, nach, Code, Zustand, Migration — keine Werte aus der Umgebung,
# keine Geheimnisse).
#
# ---------------------------------------------------------------------------
#  Was sich gegenüber der Fassung vom 2026-09-27 geändert hat, und warum
# ---------------------------------------------------------------------------
#
#  • **Die erwartete Summe ist Pflicht.** Bisher genügte die `.sha256` neben
#    dem Archiv — die aber reist im selben Kanal wie das Archiv. Wer eines
#    tauschen kann, tauscht beide. Die erwartete Summe kommt jetzt vom
#    Aufrufer, der sie gegen die Beilage der CI geprüft hat; sie muss der
#    frisch gemessenen **und** der mitgelieferten entsprechen.
#  • **Eine Sperre.** Zwei Aktivierungen (oder Aktivierung und Rücksprung)
#    gleichzeitig prüften jede die Identität der anderen und schalteten
#    abwechselnd um.
#  • **Immer frisch entpacken.** Früher wurde ein vorhandenes
#    `releases/<commit>` „unverändert wiederverwendet" — also ungeprüft. Ein
#    Verzeichnis, das seit Tagen auf dem Server liegt, ist nicht das Archiv,
#    dessen Summe eben gemessen wurde.
#  • **Identität statt Behauptung.** `APP_VERSION` fällt weg. Die Instanz
#    meldet ihre Identität aus ihren eigenen Dateien (`RELEASE.json`,
#    `.next/BUILD_ID`); verglichen wird Commit, Build-ID und `belegt` — und
#    nach einem Rücksprung auch die der vorherigen Fassung.
#  • **Ein Ergebnis mit Bedeutung.** Früher endete jeder Fehler mit 1, ob vor
#    dem Umschalten oder danach, ob der Rücksprung gelang oder nicht. Der
#    Release-Ausführer schloss daraufhin auf „ROLLED_BACK", wenn eine zweite
#    Frage an die Instanz zufällig die alte Version lieferte.
#
# Aufbau auf dem Server:
#
#   $BASIS/releases/<commit>/   ein entpacktes Artefakt je Commit
#   $BASIS/archiv/              die aktivierten Archive (für den Rücksprung)
#   $BASIS/current -> releases/<commit>
#   $BASIS/shared/.env          Geheimnisse, nie im Artefakt
#   $BASIS/shared/logs/         Protokolle über Releases hinweg
#   $BASIS/releases-eingang/    Übergabe aus der Pipeline
#   $BASIS/aktivierungen.jsonl  jede Aktivierung und jeder Rücksprung
#
set -Eeuo pipefail
umask 027

readonly BASIS="${CLENARIS_BASIS:-/home/clenaris/clenaris}"
readonly PORT="${DEPLOY_PORT:-3000}"
readonly APP_NAME="${PM2_APP_NAME:-clenaris}"
readonly BEHALTEN="${CLENARIS_RELEASES_KEEP:-5}"
readonly SPERRE="${BASIS}/.release.lock"

# PHASE entscheidet, was ein unerwarteter Abbruch bedeutet: vor dem Umschalten
# ist nichts umgeschaltet (10), ab dem Umschalten ist der Zustand offen (30).
PHASE="vorbereitung"
COMMIT=""
VORHER=""
MIGRATION="nein"
ZIEL=""
NEU=""
ALT=""
KOPIE=""
GEMELDET=""

log()  { printf '%s  %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
fail() { log "FEHLER: $*"; exit 1; }

# Eine Zeile in aktivierungen.jsonl. Über node statt printf: Die Werte sind
# zwar Kennungen und Zustände, aber JSON von Hand zusammenzusetzen ist genau
# die Stelle, an der ein unerwartetes Zeichen eine kaputte Zeile erzeugt —
# in der einen Datei, die nach einem Vorfall stimmen muss. Dieselben Felder
# wie `aktivierungProtokollieren` in scripts/release/umschaltung.ts.
protokollieren() {
  [[ -d "${BASIS}" ]] || return 0
  node -e '
    const [datei, code, zustand, von, nach, migration] = process.argv.slice(1);
    const zeile = { zeitUtc: new Date().toISOString(), art: "aktivierung", von: von || null, nach: nach || null,
                    code: Number(code), zustand, migration };
    require("fs").appendFileSync(datei, JSON.stringify(zeile) + "\n", { mode: 0o640 });
  ' "${BASIS}/aktivierungen.jsonl" "$1" "$2" "${VORHER}" "${COMMIT}" "${MIGRATION}" \
    || log "WARNUNG: aktivierungen.jsonl nicht geschrieben."
}

# Ergebnis festhalten, ausgeben, beenden — der vorgesehene Weg zu jedem Ausgang.
melden() {
  local code="$1" zustand="$2"
  GEMELDET="ja"
  protokollieren "${code}" "${zustand}"
  printf 'ERGEBNIS {"code":%d,"zustand":"%s","commit":"%s"}\n' "${code}" "${zustand}" "${COMMIT}"
  exit "${code}"
}

aufraeumen() {
  if [[ -n "${NEU}" && -e "${NEU}" ]]; then rm -rf -- "${NEU}"; fi
  if [[ -n "${ALT}" && -e "${ALT}" ]]; then rm -rf -- "${ALT}"; fi
  if [[ -n "${KOPIE}" && -e "${KOPIE}" ]]; then rm -f -- "${KOPIE}"; fi
  return 0
}

# Jeder Ausgang läuft hier durch: Zwischenverzeichnisse weg, und ein Abbruch
# ohne `melden` (ein gescheiterter Befehl unter `set -e`, ein `fail`) bekommt
# seinen Code nach der Phase, in der er geschah — nie die nackte 1, die nichts
# darüber sagt, ob umgeschaltet wurde.
beim_ende() {
  local rc=$?
  trap - EXIT
  aufraeumen || true
  if [[ -z "${GEMELDET}" ]]; then
    local code=10 zustand="NICHT_UMGESCHALTET"
    case "${PHASE}" in
      umschaltung|abschluss) code=30; zustand="UNKLAR" ;;
    esac
    log "Abbruch in Phase ${PHASE} (Ausgang ${rc}) → ${zustand}."
    if [[ "${MIGRATION}" != "nein" ]]; then
      log "Achtung: Migration ${MIGRATION} — das Schema geht nie mit zurück."
    fi
    GEMELDET="ja"
    protokollieren "${code}" "${zustand}"
    printf 'ERGEBNIS {"code":%d,"zustand":"%s","commit":"%s"}\n' "${code}" "${zustand}" "${COMMIT}"
    exit "${code}"
  fi
  exit "${rc}"
}
trap beim_ende EXIT
trap 'log "FEHLER: Befehl in Zeile ${LINENO} gescheitert (Phase ${PHASE})."' ERR

# --- 0. Argumente -------------------------------------------------------------
ARCHIV=""
ERWARTET=""
while (($#)); do
  case "$1" in
    --erwartet-sha256)
      [[ $# -ge 2 ]] || fail "--erwartet-sha256 ohne Wert."
      ERWARTET="${2,,}"
      shift 2
      ;;
    --*) fail "Unbekannte Option: $1" ;;
    *)
      [[ -z "${ARCHIV}" ]] || fail "Mehr als ein Archiv angegeben."
      ARCHIV="$1"
      shift
      ;;
  esac
done
[[ -n "${ARCHIV}" ]] || fail "Archiv fehlt: bash release-aktivieren.sh <archiv.tar.gz> --erwartet-sha256 <hex64>"
[[ "${ERWARTET}" =~ ^[0-9a-f]{64}$ ]] \
  || fail "--erwartet-sha256 <64 Hexzeichen> fehlt oder ist ungültig — ohne erwartete Summe keine Aktivierung."
[[ "${PORT}" =~ ^[0-9]{2,5}$ ]] || fail "DEPLOY_PORT ist keine Portnummer."
{ [[ "${BEHALTEN}" =~ ^[0-9]+$ ]] && (( BEHALTEN >= 2 )); } \
  || fail "CLENARIS_RELEASES_KEEP muss mindestens 2 sein — das aktive und das vorherige Release bleiben immer."
[[ -d "${BASIS}" ]] || fail "${BASIS} fehlt."
for befehl in flock sha256sum tar node pm2 readlink; do
  command -v "${befehl}" >/dev/null 2>&1 || fail "Befehl ${befehl} nicht gefunden."
done

# --- 1. Sperre ----------------------------------------------------------------
# Dieselbe Datei wie deploy/v2/release-ruecksprung.sh. Jeder Aufruf, der
# länger lebende Prozesse starten kann (das Umschaltwerkzeug startet pm2 und
# damit womöglich den pm2-Dienst selbst), bekommt den Deskriptor mit `9>&-`
# geschlossen: Erbt der pm2-Dienst ihn, hält er die Sperre, solange er läuft —
# und jede weitere Aktivierung endete mit 11, bis jemand pm2 neu startet.
exec 9>>"${SPERRE}"
if ! flock -n 9; then
  log "Eine andere Aktivierung oder ein Rücksprung hält ${SPERRE}."
  melden 11 GESPERRT
fi
if [[ -L "${BASIS}/current" ]]; then
  VORHER="$(basename -- "$(readlink -f -- "${BASIS}/current")")"
fi

# --- 2. Summe -----------------------------------------------------------------
PHASE="pruefung"
[[ -f "${ARCHIV}" ]] || fail "Archiv ${ARCHIV} nicht gefunden."
[[ -f "${ARCHIV}.sha256" ]] || fail "Prüfsumme ${ARCHIV}.sha256 fehlt — ohne Summe keine Aktivierung."
[[ -f "${BASIS}/shared/.env" ]] || fail "${BASIS}/shared/.env fehlt."

# Gemessen und entpackt wird eine **eigene Kopie** im Basisverzeichnis, nicht
# die Datei im Eingang: Zwischen Messen und Entpacken könnte sonst jemand mit
# Schreibrecht auf den Eingang das Archiv tauschen, und entpackt würde, was
# nie gemessen wurde.
mkdir -p "${BASIS}/archiv"
KOPIE="${BASIS}/archiv/.eingang.$$.tar.gz"
cp -- "${ARCHIV}" "${KOPIE}"
MESSUNG="$(sha256sum -- "${KOPIE}" | cut -d' ' -f1)"
NOTIERT="$(awk 'NR == 1 { print tolower($1) }' "${ARCHIV}.sha256")"
[[ "${MESSUNG}" == "${ERWARTET}" ]] \
  || fail "SHA-256 des Archivs (${MESSUNG}) ist nicht die erwartete (${ERWARTET}). Das Archiv ist nicht das, was die Pipeline geprüft hat."
[[ "${MESSUNG}" == "${NOTIERT}" ]] \
  || fail "SHA-256 des Archivs passt nicht zu ${ARCHIV}.sha256 (${NOTIERT:-leer})."
log "Prüfsumme      : ${MESSUNG} (erwartet und mitgeliefert gleich)"

# --- 3. Manifest --------------------------------------------------------------
# Eine erste, schlanke Prüfung vor dem Entpacken — damit ein falsches Archiv
# nicht erst ein paar hundert Megabyte auf die Platte legt. Die vollständige
# Prüfung gegen das Schema folgt nach dem Entpacken, mit dem Werkzeug aus
# genau diesem Archiv.
MANIFEST="$(tar -xzOf "${KOPIE}" RELEASE.json)" || fail "RELEASE.json fehlt im Archiv."
WERTE="$(node -e '
  const m = JSON.parse(process.argv[1]);
  const fehler = [];
  if (m.format !== 2) fehler.push("format ist nicht 2");
  if (m.anwendung !== "clenaris") fehler.push("anwendung ist nicht clenaris");
  if (m.auslieferbar !== true) fehler.push("auslieferbar ist nicht true (Probe, unsauberer Baum, ohne Module oder nicht aus main)");
  if (typeof m.commit !== "string" || !/^[0-9a-f]{40}$/.test(m.commit)) fehler.push("commit ist keine 40-stellige Kennung");
  if (typeof m.buildId !== "string" || !/^[A-Za-z0-9._-]{1,200}$/.test(m.buildId)) fehler.push("buildId fehlt oder enthält unerwartete Zeichen");
  if (m.distDir !== ".next") fehler.push("distDir ist nicht .next");
  if (typeof m.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(m.version)) fehler.push("version ist keine semantische Version");
  if (typeof m.node !== "string" || !/^v?\d+\./.test(m.node)) fehler.push("node fehlt");
  if (fehler.length > 0) { process.stderr.write(fehler.join("; ") + "\n"); process.exit(1); }
  process.stdout.write([m.commit, m.buildId, m.version, m.node.replace(/^v/, "").split(".")[0]].join("\n") + "\n");
' "${MANIFEST}")" || fail "Manifest ungültig — nichts entpackt, nichts umgeschaltet."
COMMIT="$(sed -n 1p <<<"${WERTE}")"
BUILD_ID="$(sed -n 2p <<<"${WERTE}")"
VERSION="$(sed -n 3p <<<"${WERTE}")"
BAU_NODE="$(sed -n 4p <<<"${WERTE}")"
readonly COMMIT BUILD_ID VERSION BAU_NODE
log "Commit         : ${COMMIT}"
log "Version        : ${VERSION}"
log "Build-ID       : ${BUILD_ID}"

# Node muss in der Hauptversion übereinstimmen: node_modules enthält native
# Teile (Prisma-Engine), die gegen die Bau-Umgebung gebaut sind.
[[ "${BAU_NODE}" == "$(node -p 'process.versions.node.split(".")[0]')" ]] \
  || fail "Node-Hauptversion weicht vom Bau ab (Bau: ${BAU_NODE}, hier: $(node -v))."

# Seit V2-1 (2026-09-26) ist das Artefakt an keine Adresse gebunden: Die
# Herkunft dieser Instanz kommt zur Laufzeit aus `APP_URL`. Der Server muss
# sie nur **haben**; ohne sie verweigert die Anwendung in der Produktion
# jeden absoluten Link.
SERVER_URL="$(grep -E '^APP_URL=' "${BASIS}/shared/.env" | tail -n1 | cut -d= -f2- | tr -d '"'"'" || true)"
[[ -n "${SERVER_URL}" ]] || fail "APP_URL fehlt in ${BASIS}/shared/.env."
log "APP_URL        : ${SERVER_URL} (Laufzeit)"

# --- 4. Frisch entpacken ------------------------------------------------------
PHASE="entpacken"
ZIEL="${BASIS}/releases/${COMMIT}"
readonly ZIEL
mkdir -p "${BASIS}/releases"
NEU="${ZIEL}.tmp.$$"
rm -rf -- "${NEU}"
mkdir -p -- "${NEU}"
tar -xzf "${KOPIE}" -C "${NEU}" --no-same-owner
[[ "$(tr -d '[:space:]' < "${NEU}/.next/BUILD_ID" 2>/dev/null || true)" == "${BUILD_ID}" ]] \
  || fail ".next/BUILD_ID im entpackten Baum ist nicht die Build-ID des Manifests (${BUILD_ID})."

# Das Werkzeug kommt aus dem eben entpackten, gemessenen Archiv — nie aus
# `current/`. Mit `node …/tsx/dist/cli.mjs` statt `npx tsx`: `npx` sucht ein
# fehlendes Paket im Netz, und auf diesem Server wird nichts nachgeladen.
WERKZEUG_NEU=(node "${NEU}/node_modules/tsx/dist/cli.mjs" "${NEU}/scripts/release-umschalten.ts")
"${WERKZEUG_NEU[@]}" artefakt --verzeichnis "${NEU}" 9>&- \
  || fail "Das entpackte Release besteht die Prüfung gegen RELEASE.json (Format 2) nicht."

# Das gemessene Archiv aufbewahren — der Rücksprung (release-ruecksprung.sh)
# geht nur auf ein Archiv zurück, dessen Summe er erneut prüfen kann.
ARCHIVNAME="clenaris-${COMMIT:0:12}.tar.gz"
readonly ARCHIVNAME
mv -f -- "${KOPIE}" "${BASIS}/archiv/${ARCHIVNAME}"
KOPIE=""
printf '%s  %s\n' "${MESSUNG}" "${ARCHIVNAME}" > "${BASIS}/archiv/${ARCHIVNAME}.sha256"
# Den Eingang leeren, sobald die Kopie sicher liegt: Jedes Archiv bringt die
# `node_modules` mit, und ein Eingang, der nie geleert wird, füllt die Platte.
if [[ "$(readlink -f -- "$(dirname -- "${ARCHIV}")")" == "$(readlink -f -- "${BASIS}/releases-eingang" 2>/dev/null || true)" ]]; then
  rm -f -- "${ARCHIV}" "${ARCHIV}.sha256"
fi

# --- 5. Schon aktiv? ------------------------------------------------------------
# Eine Wiederholung (derselbe Lauf noch einmal, etwa nach einem Netzabbruch)
# darf nichts ändern. Läuft genau dieses Release und bestätigt seine
# Identität, ist die Arbeit getan. Läuft es angeblich, bestätigt sich aber
# nicht, wird ebenfalls nichts getan: Ein Neustart derselben Fassung verdeckte
# nur, dass sie krank ist.
if [[ -n "${VORHER}" && "${VORHER}" == "${COMMIT}" ]]; then
  if CLENARIS_RELEASE_SPERRE="${SPERRE}" PM2_APP_NAME="${APP_NAME}" \
       "${WERKZEUG_NEU[@]}" aktiv --basis "${BASIS}" --ziel "${ZIEL}" --erwartet-aus "${NEU}" --port "${PORT}" 9>&-; then
    log "Bereits aktiv  : ${COMMIT}, Identität bestätigt — nichts zu tun."
    melden 0 AKTIV
  fi
  fail "Release ${COMMIT} ist bereits aktiv, bestätigt seine Identität aber nicht — keine Änderung. Diagnose über /api/health und pm2 logs; zurück mit deploy/v2/release-ruecksprung.sh."
fi

# --- 6. An seinen Platz --------------------------------------------------------
# Ein vorhandenes, nicht aktives releases/<commit> wird ersetzt, nie
# wiederverwendet (siehe Kopf).
ln -sfn "${BASIS}/shared/.env" "${NEU}/.env"
mkdir -p "${BASIS}/shared/logs"
ln -sfn "${BASIS}/shared/logs" "${NEU}/logs"
if [[ -e "${ZIEL}" || -L "${ZIEL}" ]]; then
  log "releases/${COMMIT} liegt bereits vor, ist aber nicht aktiv — wird durch die frische Entpackung ersetzt."
  ALT="${ZIEL}.alt.$$"
  rm -rf -- "${ALT}"
  mv -T -- "${ZIEL}" "${ALT}"
fi
mv -T -- "${NEU}" "${ZIEL}"
NEU=""
if [[ -n "${ALT}" ]]; then rm -rf -- "${ALT}"; fi
ALT=""

cd "${ZIEL}"
readonly TSX=(node "${ZIEL}/node_modules/tsx/dist/cli.mjs")
readonly PRISMA=(node "${ZIEL}/node_modules/prisma/build/index.js")

# --- 7. Korrektur noch da? ------------------------------------------------------
PHASE="vorpruefung"
node scripts/react-hydrationskorrektur.mjs --pruefen >/dev/null \
  || fail "React-Hydrationskorrektur im Artefakt nicht vorhanden."

# --- 8. Migrationen -------------------------------------------------------------
# Reihenfolge (docs/PREPRODUCTION_READINESS.md, Migrationssicherheit):
#   lesende Vorprüfung → geprüfte Sicherung → Migration → Umschalten → Health.
# Die Vorprüfung steht vor der Sicherung: Findet sie einen Eindeutigkeits-
# konflikt, bricht die Aktivierung ab, bevor irgendetwas geschrieben wurde —
# `migrate deploy` bliebe sonst mitten in der Reihe stehen, und der Rücksprung
# stellt nur die Anwendung wieder her, nie das Schema.
#
# Zwei feste Regeln davor (Notfallauftrag 2026-09-27):
#
#  • **Erst das Artefakt, dann das Schema.** Hier liegt das Release bereits
#    geprüft und entpackt vor — die Migration läuft also erst, wenn feststeht,
#    dass das Programm, das zu ihr passt, sofort startbereit ist.
#  • **Produktionsvorprüfung vor jeder Schreibhandlung** (`--phase
#    vor-migration`): Umgebung, Geheimnisse, Demozugänge, Konten mit
#    veröffentlichten Passwörtern, Scanner, Proxy — und die Einstufung der
#    offenen Migrationen aus `security/migrations-vertraeglichkeit.json`. Eine
#    BRECHENDE Migration hält hier an, ausser `CLENARIS_WARTUNGSFENSTER=ja`
#    ist bewusst gesetzt.
wartung=()
if [[ "${CLENARIS_WARTUNGSFENSTER:-}" == "ja" ]]; then wartung=(--wartungsfenster); fi
"${TSX[@]}" scripts/production-preflight.ts --phase vor-migration ${wartung[@]+"${wartung[@]}"} \
  || fail "Produktionsvorprüfung (vor der Migration) nicht bestanden — nichts migriert, nichts umgeschaltet."

PHASE="migration"
if ! "${PRISMA[@]}" migrate status >/dev/null 2>&1; then
  log "Migrationen stehen an — Vorprüfung, dann Sicherung."
  "${TSX[@]}" scripts/migration-preflight.ts \
    || fail "Vorprüfung meldet Konflikte — keine Sicherung, keine Migration, kein Umschalten."
  APP_DIRECTORY="${BASIS}" "${TSX[@]}" scripts/db-backup.ts --grund migration --commit "${COMMIT}" \
    || fail "Sicherung fehlgeschlagen — keine Migration."
  MIGRATION="begonnen"
  "${PRISMA[@]}" migrate deploy \
    || fail "prisma migrate deploy ist gescheitert — nicht umgeschaltet; das Schema ist womöglich teilweise migriert."
  MIGRATION="angewandt"
fi

# Nach der Migration noch einmal, jetzt ohne offene Migration: Das Programm,
# das gleich startet, muss zu genau diesem Schema passen.
PHASE="nach-migration"
"${TSX[@]}" scripts/production-preflight.ts \
  || fail "Produktionsvorprüfung (vor dem Umschalten) nicht bestanden — nicht umgeschaltet."

# --- 9. Umschalten, prüfen, notfalls zurück --------------------------------------
# Das Werkzeug aus dem neuen Release setzt `current` atomar, lädt pm2, prüft
# die Identität (Commit, Build-ID, `belegt`) und schaltet bei Misserfolg
# zurück — und prüft dann die vorherige Fassung genauso. `pm2 save` geschieht
# dort, und nur nach einer bestätigten Identität (scripts/release/umschaltung.ts):
# eine Stelle für Aktivierung und Rücksprung, damit beide dieselbe Regel haben.
#
# Der Ausgang wird mit `|| UMSCHALTUNG=$?` festgehalten, nicht mit `set +e`:
# Die ERR-Falle feuert auch unter `set +e` und meldete dann einen
# „gescheiterten Befehl", wo nur ein Ausgang des Vertrags zurückkam (örtliche
# Rauchprobe 2026-09-30).
PHASE="umschaltung"
UMSCHALTUNG=0
CLENARIS_RELEASE_SPERRE="${SPERRE}" PM2_APP_NAME="${APP_NAME}" \
  "${TSX[@]}" "${ZIEL}/scripts/release-umschalten.ts" umschalten --basis "${BASIS}" --ziel "${ZIEL}" --port "${PORT}" 9>&- \
  || UMSCHALTUNG=$?
case "${UMSCHALTUNG}" in
  0)  PHASE="abschluss" ;;
  10) PHASE="nach-migration"; fail "Nicht umgeschaltet — current zeigt unverändert auf ${VORHER:-nichts}." ;;
  20) log "Zurückgesprungen auf ${VORHER}; die neue Fassung ${COMMIT} hat ihre Identität nicht bestätigt."; melden 20 ZURUECK ;;
  *)  log "Zustand unklar (Werkzeug: ${UMSCHALTUNG}). Sofort prüfen: readlink -f ${BASIS}/current, pm2 ls, /api/health."; melden 30 UNKLAR ;;
esac

# --- 10. Aufbewahrung -------------------------------------------------------------
# Nur nach bestätigter Umschaltung, und nur Verzeichnisse mit Commit-Namen —
# nie das aktive, nie das vorherige. Die Archive im Gleichschritt: Behalten
# wird das Archiv jedes Release, das noch unter releases/ liegt; ohne Archiv
# ist ein Rücksprung dorthin nicht mehr prüfbar und damit nicht mehr möglich.
aufbewahren() {
  local alt archiv kurz
  ls -1t -- "${BASIS}/releases" | grep -E '^[0-9a-f]{40}$' | tail -n +"$((BEHALTEN + 1))" | while read -r alt; do
    if [[ "${alt}" == "${COMMIT}" || "${alt}" == "${VORHER}" ]]; then continue; fi
    rm -rf -- "${BASIS}/releases/${alt}"
    log "Entfernt       : releases/${alt}"
  done
  for archiv in "${BASIS}"/archiv/clenaris-*.tar.gz; do
    [[ -e "${archiv}" ]] || continue
    kurz="$(basename -- "${archiv}" .tar.gz)"
    kurz="${kurz#clenaris-}"
    if ! compgen -G "${BASIS}/releases/${kurz}*" >/dev/null; then
      rm -f -- "${archiv}" "${archiv}.sha256"
      log "Entfernt       : archiv/$(basename -- "${archiv}")"
    fi
  done
}
aufbewahren || log "WARNUNG: Aufbewahrung nicht vollständig — die Aktivierung selbst ist bestätigt."

melden 0 AKTIV
