import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SECURITY_REPORT_QUELLEN, SECURITY_REPORT_STATUS } from '../../src/lib/validation/security-report';

/**
 * Die Vorlagen unter `ops/security-monitor/` gegen den Vertrag der Anwendung
 * (2026-09-26).
 *
 * **Was das ist — und was nicht.** Die Skripte sind Bash und liessen sich hier
 * weder ausführen noch mit `shellcheck` prüfen (keine Bash, keine stille
 * Installation). Diese Reihe liest sie **als Text** und prüft, was sich ohne
 * Ausführung sicher sagen lässt: dass sie nur Quellen und Zustände melden,
 * die der Berichtseingang annimmt, dass ihre Kennzahlen dem Schema genügen,
 * dass kein Geheimnis auf eine Befehlszeile gerät und dass der
 * Überwachungsrechner kein `CRON_SECRET` braucht. Ob die Skripte *laufen*,
 * beweist sie nicht — das bleibt EXTERNAL VERIFICATION REQUIRED
 * (`ops/security-monitor/INSTALL.md`, „Erprobung").
 */

const ORDNER = join(__dirname, '..', '..', 'ops', 'security-monitor');
const skripte = readdirSync(ORDNER).filter((d) => d.endsWith('.sh'));
const text = (d: string) => readFileSync(join(ORDNER, d), 'utf8');

describe('Überwachungsvorlagen (statisch)', () => {
  it('sind vorhanden: security_check, zap_baseline, deps_check, alert, lib', () => {
    assert.deepEqual(skripte.sort(), ['alert.sh', 'deps_check.sh', 'lib.sh', 'security_check.sh', 'zap_baseline.sh']);
  });

  it('Bash mit strengem Modus und Unix-Zeilenenden', () => {
    for (const d of skripte) {
      const t = text(d);
      assert.ok(t.startsWith('#!/usr/bin/env bash\n'), `${d}: Kopfzeile`);
      assert.ok(!t.includes('\r'), `${d}: Wagenrücklauf`);
      if (d !== 'lib.sh') assert.match(t, /^set -Eeuo pipefail$/m, `${d}: strenger Modus`);
    }
  });

  it('melden nur Quellen und Zustände, die der Berichtseingang kennt', () => {
    const aufrufe = skripte.flatMap((d) => [...text(d).matchAll(/^\s*melden\s+(\S+)\s+("?[^\s"]+"?)/gm)].map((m) => ({ d, quelle: m[1]!, status: m[2]!.replace(/"/g, '') })));
    assert.ok(aufrufe.length >= 4, `nur ${aufrufe.length} Meldungen gefunden`);
    for (const a of aufrufe) {
      assert.ok((SECURITY_REPORT_QUELLEN as readonly string[]).includes(a.quelle), `${a.d}: Quelle ${a.quelle}`);
      // Ein Variablenname ($status, $schwerste …) wird im Skript aus festen Werten gebildet — siehe nächster Fall.
      if (!a.status.startsWith('$')) assert.ok((SECURITY_REPORT_STATUS as readonly string[]).includes(a.status), `${a.d}: Zustand ${a.status}`);
    }
  });

  it('Zustandsvariablen nehmen nur zulässige Werte an', () => {
    for (const d of ['security_check.sh', 'zap_baseline.sh', 'deps_check.sh']) {
      const werte = [...text(d).matchAll(/(?:schwerste|status|integ_status)="([A-Z_]+)"/g)].map((m) => m[1]!);
      assert.ok(werte.length > 0, d);
      for (const w of werte) assert.ok((SECURITY_REPORT_STATUS as readonly string[]).includes(w), `${d}: ${w}`);
    }
  });

  it('Kennzahlen genügen dem Schema (Schlüsselform, höchstens 30)', () => {
    for (const d of skripte) {
      for (const block of text(d).matchAll(/'\{([a-zA-Z][\s\S]*?)\}'\)"/g)) {
        const schluessel = [...block[1]!.matchAll(/([a-zA-Z][a-zA-Z0-9_]*):\s*\$/g)].map((m) => m[1]!);
        if (schluessel.length === 0) continue;
        assert.ok(schluessel.length <= 30, `${d}: ${schluessel.length} Kennzahlen`);
        for (const k of schluessel) assert.match(k, /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/, `${d}: ${k}`);
      }
    }
  });

  it('kein CRON_SECRET auf dem Überwachungsrechner', () => {
    for (const d of [...skripte, 'monitor.env.example']) assert.ok(!text(d).includes('CRON_SECRET='), `${d} verlangt CRON_SECRET`);
    for (const d of skripte) assert.ok(!/\$\{?CRON_SECRET/.test(text(d)), `${d} benutzt CRON_SECRET`);
  });

  it('Token und Webhook-Adresse nie auf der Befehlszeile — nur über curl --config von der Standardeingabe', () => {
    for (const d of skripte) {
      const t = text(d);
      for (const zeile of t.split('\n')) {
        if (/curl\b/.test(zeile)) {
          // Nur was *nach* `curl` steht, sind seine Argumente; ein `printf …`
          // davor schreibt in die Pipe (`--config -`) und ist genau der Weg,
          // der gewollt ist.
          const argumente = zeile.slice(zeile.search(/\bcurl\b/));
          assert.ok(!/-H\s+["']?Authorization/i.test(argumente), `${d}: Authorization-Kopf auf der Befehlszeile: ${zeile.trim()}`);
          assert.ok(!/\$\{?(SECURITY_REPORT_TOKEN|ALERT_WEBHOOK_URL)/.test(argumente), `${d}: Geheimnis in curl-Argumenten: ${zeile.trim()}`);
        }
      }
      if (/SECURITY_REPORT_TOKEN|ALERT_WEBHOOK_URL/.test(t) && /curl\b/.test(t)) assert.match(t, /--config -/, `${d}: ohne --config -`);
    }
  });

  it('Alarmschlüssel sind gültige Dateinamen für alert.sh', () => {
    for (const d of skripte) {
      // Kommentarzeilen (Gebrauchsanleitung mit Platzhaltern) zählen nicht.
      const code = text(d).split('\n').filter((z) => !z.trim().startsWith('#')).join('\n');
      for (const m of code.matchAll(/alert\.sh"?\s+(info|warnung|kritisch|entwarnung)\s+([^\s"]+)/g)) {
        assert.match(m[2]!, /^[a-z0-9._-]{1,64}$/, `${d}: ${m[2]}`);
      }
    }
  });

  it('nur lesende Anfragen an die Anwendung — ausser dem einen Bericht', () => {
    for (const d of ['security_check.sh', 'deps_check.sh', 'zap_baseline.sh']) {
      const t = text(d);
      assert.ok(!/-X\s*(POST|PUT|PATCH|DELETE)/.test(t), `${d}: schreibende Methode`);
      // Nur curl-Zeilen: `mktemp -d` ist kein Datenversand.
      for (const zeile of t.split('\n').filter((z) => /\bcurl\b/.test(z))) {
        const argumente = zeile.slice(zeile.search(/\bcurl\b/));
        assert.ok(!/--data|\s-d\s|\s-F\s|--form/.test(argumente), `${d}: sendet Daten: ${zeile.trim()}`);
      }
    }
    // Der Bericht geht aus `lib.sh` — genau eine Stelle mit Rumpf.
    assert.equal([...text('lib.sh').matchAll(/--data-binary/g)].length, 1);
  });

  it('Takt: jede Anfrage in security_check.sh läuft über abrufen() mit Pause', () => {
    const t = text('security_check.sh');
    const direkteCurl = t.split('\n').filter((z) => /^\s*curl\b/.test(z) || /\|\s*$/.test(z) === false && /\bcurl --silent --proto/.test(z));
    // Zwei zulässige direkte Aufrufe: in abrufen() selbst und der Statusabruf mit Token, danach pause.
    assert.ok(direkteCurl.length <= 2, `direkte curl-Aufrufe: ${direkteCurl.length}`);
    assert.match(t, /abrufen\(\) \{[\s\S]*?pause\n\}/, 'abrufen() ohne pause');
    assert.match(t, /--config - -o "\$arbeit\/status\.json"[\s\S]{0,120}\n\s*pause/, 'Statusabruf ohne pause');
  });
});
