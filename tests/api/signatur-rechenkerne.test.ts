import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { clientReportedUserAgent, resolveClientIp, trustedProxyMode } from '../../src/lib/http/client-ip';
import {
  CONSENT_VERSIONS,
  CURRENT_CONSENT_VERSION,
  DEFAULT_CONSENT_LOCALE,
  consentHash,
  consentText,
  isConsentLocale,
  isConsentVersion,
} from '../../src/lib/signature/consent';

/**
 * Die reine Rechnung der elektronischen Unterzeichnung — direkt importiert,
 * aus demselben Grund wie `zugriffstokens.test.ts`: Über HTTP liesse sich
 * nur beobachten, *dass* eine Adresse gespeichert wurde, nicht, ob sie
 * geglaubt werden durfte.
 *
 * **Der Befund dahinter.** `getClientIp` glaubte bis Gate 4B jedem Kopf, den
 * irgendwer schickte (`cf-connecting-ip` zuerst). Ohne Cloudflare davor
 * setzt der Client diesen Kopf selbst; die im Prüfprotokoll und bei der
 * Offertannahme gespeicherte Adresse war damit eine Behauptung des
 * Absenders. Diese Reihe hält fest, welchem Kopf in welchem Modus geglaubt
 * wird — und dass ein gefälschter in keinem Modus durchkommt.
 *
 * Der Modus wird je Fall über `process.env.TRUSTED_PROXY_MODE` gesetzt und
 * hinterher zurückgesetzt; `trustedProxyMode()` liest die Variable bei jedem
 * Aufruf, damit genau das möglich ist.
 */

const vorher = process.env.TRUSTED_PROXY_MODE;
after(() => {
  if (vorher === undefined) delete process.env.TRUSTED_PROXY_MODE;
  else process.env.TRUSTED_PROXY_MODE = vorher;
});

function anfrage(headers: Record<string, string>): Request {
  return new Request('http://localhost/api/public/signatures/exchange', { method: 'POST', headers });
}

const GEFAELSCHT = {
  'cf-connecting-ip': '203.0.113.99',
  'x-forwarded-for': '198.51.100.7, 203.0.113.99',
  'x-real-ip': '192.0.2.44',
};

describe('Adressermittlung — TRUSTED_PROXY_MODE', () => {
  it('fällt ohne oder mit unbekanntem Wert auf NONE zurück', () => {
    delete process.env.TRUSTED_PROXY_MODE;
    assert.equal(trustedProxyMode(), 'NONE');
    process.env.TRUSTED_PROXY_MODE = 'irgendwas';
    assert.equal(trustedProxyMode(), 'NONE', 'ein Tippfehler darf nicht in einen vertrauenden Modus kippen');
    process.env.TRUSTED_PROXY_MODE = ' cloudflare ';
    assert.equal(trustedProxyMode(), 'CLOUDFLARE', 'Gross-/Kleinschreibung und Leerraum sind egal');
  });

  it('NONE: kein Kopf wird geglaubt — die Adresse ist nicht verfügbar', () => {
    process.env.TRUSTED_PROXY_MODE = 'NONE';
    const ergebnis = resolveClientIp(anfrage(GEFAELSCHT));
    assert.deepEqual(ergebnis, { ip: null, source: 'UNAVAILABLE' });
  });

  it('CLOUDFLARE: nur CF-Connecting-IP, nie X-Forwarded-For', () => {
    process.env.TRUSTED_PROXY_MODE = 'CLOUDFLARE';
    assert.deepEqual(resolveClientIp(anfrage(GEFAELSCHT)), { ip: '203.0.113.99', source: 'CLOUDFLARE' });
    assert.deepEqual(
      resolveClientIp(anfrage({ 'x-forwarded-for': '198.51.100.7', 'x-real-ip': '192.0.2.44' })),
      { ip: null, source: 'UNAVAILABLE' },
      'ohne den Cloudflare-Kopf gibt es keine Adresse — auch wenn andere Köpfe da sind',
    );
  });

  it('SINGLE_REVERSE_PROXY: ausschliesslich X-Real-IP — kein Rückfall auf X-Forwarded-For, nie CF-Connecting-IP', () => {
    process.env.TRUSTED_PROXY_MODE = 'SINGLE_REVERSE_PROXY';
    assert.deepEqual(resolveClientIp(anfrage(GEFAELSCHT)), { ip: '192.0.2.44', source: 'NGINX_X_REAL_IP' });
    /**
     * Gate 4C: Fehlt `X-Real-IP`, ist der Proxy falsch konfiguriert oder die
     * Anfrage kam an ihm vorbei. Ein Rückfall auf `X-Forwarded-For` eröffnete
     * genau dann einen zweiten, vom Absender beschreibbaren Pfad — fail-closed.
     */
    assert.deepEqual(
      resolveClientIp(anfrage({ 'x-forwarded-for': '198.51.100.7, 203.0.113.99' })),
      { ip: null, source: 'UNAVAILABLE' },
      'X-Forwarded-For allein ergibt keine Adresse',
    );
    assert.deepEqual(
      resolveClientIp(anfrage({ 'cf-connecting-ip': '203.0.113.99' })),
      { ip: null, source: 'UNAVAILABLE' },
      'ein Cloudflare-Kopf hinter Nginx ist vom Absender geschrieben',
    );
  });

  it('nimmt nur Werte an, die wie eine Adresse aussehen', () => {
    process.env.TRUSTED_PROXY_MODE = 'CLOUDFLARE';
    for (const wert of ['', 'nicht-eine-adresse', '203.0.113.99; DROP TABLE', '<script>', 'a'.repeat(60)]) {
      assert.deepEqual(resolveClientIp(anfrage({ 'cf-connecting-ip': wert })), { ip: null, source: 'UNAVAILABLE' }, `«${wert}»`);
    }
    assert.equal(resolveClientIp(anfrage({ 'cf-connecting-ip': '2001:db8::1' })).ip, '2001:db8::1', 'IPv6');
  });

  it('kürzt und säubert die Browser-Angabe', () => {
    // CR, LF und NUL weist schon die Fetch-API ab; andere Steuerzeichen
    // (hier \u0001, \u001f, DEL) kommen durch und müssen weg.
    const ua = clientReportedUserAgent(anfrage({ 'user-agent': 'Mozilla/5.0\u0001 Prüf\u001f\u007f ' + 'x'.repeat(1000) }));
    assert.ok(ua);
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[\u0000-\u001f\u007f]/.test(ua), 'keine Steuerzeichen');
    assert.ok(ua.startsWith('Mozilla/5.0 Prüf'));
    assert.equal(ua.length, 512, 'gedeckelt');
    assert.equal(clientReportedUserAgent(anfrage({})), null);
  });
});

describe('Zustimmung — Wortlaut im Code, Hash über die Bytes', () => {
  it('kennt die aktuelle Fassung und Sprache', () => {
    assert.ok(isConsentVersion(CURRENT_CONSENT_VERSION));
    assert.ok(isConsentLocale(DEFAULT_CONSENT_LOCALE));
    assert.ok(!isConsentVersion('v0'));
    assert.ok(!isConsentLocale('en-US'));
    assert.ok(CONSENT_VERSIONS.includes('v1'));
  });

  it('liefert einen Text ohne rechtliche Zusagen', () => {
    const text = consentText('v1', 'de-CH');
    assert.ok(text.length > 40);
    assert.ok(!/qualifiziert|QES|ZertES|gleichgestellt|amtlich/i.test(text), text);
    assert.ok(/elektronisch unterzeichne/.test(text));
    assert.ok(!/ß/.test(text), 'Schweizer Schreibweise');
  });

  it('hasht den exakten UTF-8-Wortlaut mit SHA-256', () => {
    const text = consentText('v1', 'de-CH');
    assert.equal(consentHash(text), createHash('sha256').update(text, 'utf8').digest('hex'));
    assert.notEqual(consentHash(text), consentHash(`${text} `), 'ein Leerzeichen ist ein anderer Wortlaut');
  });

  it('weist unbekannte Fassungen ab, statt einen Ersatztext zu liefern', () => {
    assert.throws(() => consentText('v9' as never, 'de-CH'));
  });
});
