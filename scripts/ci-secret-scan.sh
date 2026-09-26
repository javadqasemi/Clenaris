#!/usr/bin/env bash
#
# Sucht Zugangsdaten, die versehentlich im Repository gelandet sind.
#
#   bash scripts/ci-secret-scan.sh
#
# Seit 2026-09-27 nur noch eine Hülle: Die Regeln stehen in
# `scripts/security/geheimnisse.ts` — einmal, für CI und für jeden
# Entwicklerrechner. Vorher gab es sie nur hier in Bash, und unter Windows
# ohne Bash blieb die Prüfung örtlich „nicht geprüft". Die Begründungen der
# einzelnen Regeln (Tokengrenze, Ausnahmehosts, Mindestlängen) sind mit
# umgezogen.
#
# **Historie.** Geprüft wird der verfolgte Bestand im Arbeitsbaum, nicht die
# Historie. Die Historie wurde am 2026-09-21 einmalig vollständig geprüft
# (alle 55 erreichbaren Commits, sämtliche Anbietermuster plus GitHub-,
# Slack-, AWS- und Datenbank-Verbindungsmuster): kein echtes Zugangsdatum,
# nur Platzhalter, `example.ch`-Fixtures und die Wegwerfwerte des CI-Laufs.
# Wird die Prüfung wiederholt, gehört das Ergebnis hierher.
#
set -Eeuo pipefail

cd -- "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/.."
exec npx tsx scripts/security/geheimnisse.ts
