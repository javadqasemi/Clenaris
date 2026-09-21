#!/usr/bin/env bash
#
# Sucht Zugangsdaten, die versehentlich im Repository gelandet sind.
#
#   bash scripts/ci-secret-scan.sh
#
# Läuft im Qualitätstor der Auslieferung und lokal vor einem Commit.
#
# Absicht und Grenzen: Das hier ersetzt keine Geheimnisverwaltung und findet
# kein selbstausgedachtes Passwort. Es findet die Muster, die Anbieter fest
# vergeben — und genau die sind es, die aus Versehen in einem Commit landen,
# weil sie aussehen wie eine belanglose Zeichenkette. Ein einziger solcher
# Fund ist teuer genug, um die zwei Sekunden Laufzeit zu rechtfertigen.
#
# Die Muster verlangen alle eine Mindestlänge. Das ist der Grund, warum
# `.env.example` mit seinen Platzhaltern (`sk_test_...`, `AIza...`, `re_...`)
# nicht anschlägt: Ein Platzhalter ist zu kurz, ein echter Schlüssel nie.
#
# **Reichweite.** Geprüft wird der *verfolgte Bestand im Arbeitsbaum*, nicht
# die Historie. Das ist Absicht — ein Lauf über alle Commits gehört nicht in
# jede Auslieferung. Die Historie wurde am 2026-09-21 einmalig vollständig
# geprüft (alle 55 erreichbaren Commits, sämtliche Muster unten plus GitHub-,
# Slack-, AWS- und Datenbank-Verbindungsmuster): kein echtes Zugangsdatum,
# nur Platzhalter, `example.ch`-Fixtures und die Wegwerfwerte des CI-Laufs.
# Wird die Prüfung wiederholt, gehört das Ergebnis hierher.
#
set -Eeuo pipefail

cd -- "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/.."

fehler=0
melde() {
  printf '  ✗ %s\n' "$*"
  fehler=$((fehler + 1))
}

printf 'Suche nach Zugangsdaten im verfolgten Bestand …\n'

# ---------------------------------------------------------------------------
#  1) Umgebungsdateien dürfen nicht verfolgt sein
# ---------------------------------------------------------------------------
#
# `.env.example` ist ausdrücklich erwünscht — sie enthält die Namen, nicht die
# Werte. Jede andere `.env`-Datei gehört nicht ins Repository, unabhängig davon,
# was gerade darinsteht: Was einmal verfolgt ist, bleibt in der Historie.
while IFS= read -r datei; do
  [[ -z "${datei}" ]] && continue
  case "${datei}" in
    .env.example|*.env.example) continue ;;
  esac
  melde "Umgebungsdatei ist verfolgt: ${datei}"
done < <(git ls-files | grep -E '(^|/)\.env($|\.)' || true)

# ---------------------------------------------------------------------------
#  2) .gitignore schützt die Umgebungsdateien
# ---------------------------------------------------------------------------
if ! grep -qE '^\.env$' .gitignore; then
  melde '.gitignore schliesst `.env` nicht aus.'
fi

# ---------------------------------------------------------------------------
#  3) Anbieter-Schlüssel im Quelltext
# ---------------------------------------------------------------------------

# Eine Tokengrenze vor jedem Präfix: Zeilenanfang oder ein Zeichen, das kein
# Wortzeichen ist.
#
# **Der Anlass, und er hat die Auslieferung fünf Tage lang blockiert.** Das
# Resend-Muster lautete `re_[0-9A-Za-z_-]{24,}` — ohne Grenze. In
# `signature_requests_signedArtifactId_key` steckt aber `…signatu` **`re_`**
# `quests_signedArtifactId_key`, und danach folgen mehr als 24 Wortzeichen.
# Der Signaturkern brachte am 2026-09-20 rund sechshundert solcher Bezeichner
# mit; seither meldete jeder Lauf einen Fund, und die Prüfung scheiterte an
# SQL-Bezeichnern statt an einem Schlüssel.
#
# Warum eine Grenze und nicht ein kürzeres Muster: Ein abgeschwächtes Muster
# findet weniger echte Schlüssel. Die Grenze ändert dagegen nicht, *was* ein
# Schlüssel ist, sondern *wo* einer anfangen darf — nämlich dort, wo auch ein
# Mensch ein neues Wort sieht. Ein echter Schlüssel steht immer hinter `=`,
# `"`, `'`, Leerzeichen, `:`, `/` oder am Zeilenanfang; keiner steht mitten in
# einem Bezeichner.
#
# `\b` stünde näher an der Absicht, ist in POSIX-ERE aber nicht zugesichert —
# `git grep -E` müsste dafür je nach Fassung auf PCRE ausweichen. Die
# Alternation ist in jeder ERE-Umsetzung dasselbe und braucht kein `-P`.
readonly TOKENGRENZE='(^|[^0-9A-Za-z_])'

# Paare aus Beschreibung und erweitertem regulärem Ausdruck.
#
# Getrennt wird am **ersten** `|`; die Ausdrücke dürfen also selbst welche
# enthalten (die Grenze oben tut es).
muster=(
  "Stripe (live)|${TOKENGRENZE}sk_live_[0-9a-zA-Z]{20,}"
  "Stripe (test)|${TOKENGRENZE}sk_test_[0-9a-zA-Z]{20,}"
  "Stripe Restricted|${TOKENGRENZE}rk_live_[0-9a-zA-Z]{20,}"
  "Stripe Webhook|${TOKENGRENZE}whsec_[0-9a-zA-Z]{24,}"
  "Google API|${TOKENGRENZE}AIza[0-9A-Za-z_-]{35}"
  "Resend|${TOKENGRENZE}re_[0-9A-Za-z_-]{24,}"
  "Anthropic|${TOKENGRENZE}sk-ant-[0-9A-Za-z_-]{24,}"
  "OpenAI|${TOKENGRENZE}sk-proj-[0-9A-Za-z_-]{24,}"
  "Twilio Account SID|${TOKENGRENZE}AC[0-9a-f]{32}"
  "SendGrid|${TOKENGRENZE}SG\.[0-9A-Za-z_-]{20,}\.[0-9A-Za-z_-]{20,}"
  "AWS Zugriffsschlüssel|${TOKENGRENZE}AKIA[0-9A-Z]{16}"
  'Privater Schlüssel|-----BEGIN [A-Z ]*PRIVATE KEY-----'
  "JSON Web Token|${TOKENGRENZE}eyJhbGciOi[0-9A-Za-z_-]{30,}"
)

# Erzeugte Dokumentation und die Sperrdatei bleiben aussen vor: In `docs/`
# stehen Beispielantworten, und `package-lock.json` enthält Prüfsummen, die
# einem Schlüssel ähneln können.
readonly AUSNAHMEN=(':!docs/' ':!package-lock.json' ':!*.lock')

for eintrag in "${muster[@]}"; do
  name="${eintrag%%|*}"
  regex="${eintrag#*|}"
  if treffer="$(git grep -nIE -- "${regex}" -- "${AUSNAHMEN[@]}" 2>/dev/null)"; then
    while IFS= read -r zeile; do
      [[ -z "${zeile}" ]] && continue
      melde "${name} gefunden: ${zeile%%:*}:$(echo "${zeile}" | cut -d: -f2)"
    done <<< "${treffer}"
  fi
done

# ---------------------------------------------------------------------------
#  4) Datenbank-Verbindungszeichenfolgen mit Passwort
# ---------------------------------------------------------------------------
#
# Zwei Ausnahmen, beide mit Grund:
#
#  • `.env.example` zeigt absichtlich den *Aufbau* einer Verbindung, mit
#    `PASSWORD` als Platzhalter. Ein Muster, das echte Passwörter findet,
#    findet diesen Platzhalter zwangsläufig auch. Die Anbieter-Muster oben
#    gelten für die Datei weiterhin — ein versehentlich hineinkopierter
#    Stripe- oder Google-Schlüssel fällt also nach wie vor auf.
#
#  • Verbindungen nach `localhost` oder `127.0.0.1`. Eine Datenbank, die aus
#    Sicht einer eingecheckten Datei auf demselben Rechner läuft, ist keine
#    Produktionsdatenbank: Das sind Wegwerf-Zugangsdaten für einen
#    CI-Dienstcontainer oder eine Entwicklungsumgebung. Ohne diese Ausnahme
#    meldete die Suche den eigenen Prüfauftrag als Fund — und eine Prüfung,
#    die zuverlässig falschen Alarm schlägt, wird abgeschaltet statt gelesen.
#
#  • **Dokumentationsnamen.** `example.com`, `example.net`, `example.org`,
#    `example.ch` sowie `.invalid`, `.test` und `.localhost`. Diese Namen
#    sind für Beispiele reserviert beziehungsweise nicht auflösbar; eine
#    Verbindungszeichenfolge dorthin *kann* keine Produktionszugangsdaten
#    tragen. Das Projekt benutzt `example.ch` durchgehend als Fixture-Domain.
#
#    Der Anlass ist derselbe wie bei der Tokengrenze oben: Seit
#    `tests/api/datenbanksicherung.test.ts` das Zerlegen einer
#    Verbindungszeichenfolge prüft — mit erfundenen Passwörtern gegen
#    `db.example.ch` —, meldete diese Suche zwei Funde je Lauf. Beide waren
#    Fixtures. Wer eine Verbindung zerlegen testen will, braucht eine
#    Verbindung mit Passwort; der Test lässt sich nicht ohne sie schreiben.
readonly DB_MUSTER='postgres(ql)?://[a-zA-Z0-9_.-]+:[^@/ ":]{8,}@'
readonly DB_AUSNAHMEHOSTS='@(([a-zA-Z0-9_-]+\.)*(localhost|invalid|test|example\.(com|net|org|ch))|127\.0\.0\.1)(:[0-9]+)?/'
if treffer="$(git grep -nIE -- "${DB_MUSTER}" -- "${AUSNAHMEN[@]}" ':!.env.example' 2>/dev/null \
              | grep -vE "${DB_AUSNAHMEHOSTS}" || true)"; then
  while IFS= read -r zeile; do
    [[ -z "${zeile}" ]] && continue
    melde "Datenbankverbindung mit Passwort: ${zeile%%:*}:$(echo "${zeile}" | cut -d: -f2)"
  done <<< "${treffer}"
fi

# ---------------------------------------------------------------------------
#  5) Geheimnisse im Browser-Bündel
# ---------------------------------------------------------------------------
#
# Alles mit dem Präfix `NEXT_PUBLIC_` wird zur Bauzeit in den JavaScript-Code
# eingesetzt und ist damit für jeden Besucher lesbar. Ein `NEXT_PUBLIC_`-Name,
# der nach einem Geheimnis klingt, ist deshalb immer ein Fehler — entweder im
# Namen oder in der Absicht.
if treffer="$(git grep -nIE -- 'NEXT_PUBLIC_[A-Z0-9_]*(SECRET|PRIVATE|SERVICE_ROLE|PASSWORD|TOKEN)' -- "${AUSNAHMEN[@]}" 2>/dev/null)"; then
  while IFS= read -r zeile; do
    [[ -z "${zeile}" ]] && continue
    melde "Geheimnis im Browser-Bündel: ${zeile}"
  done <<< "${treffer}"
fi

# ---------------------------------------------------------------------------
#  Ergebnis
# ---------------------------------------------------------------------------

if [[ "${fehler}" -gt 0 ]]; then
  printf '\n%s Fund(e). Die Auslieferung bricht ab.\n' "${fehler}"
  printf 'Ein einmal veröffentlichter Schlüssel ist verbrannt: erst beim Anbieter widerrufen,\n'
  printf 'dann aus der Historie entfernen — das Entfernen allein genügt nicht.\n'
  exit 1
fi

printf '  ✓ Keine Zugangsdaten im verfolgten Bestand gefunden.\n'
