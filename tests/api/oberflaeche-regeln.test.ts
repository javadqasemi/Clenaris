import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { can, guardForPath, permissionForPath, taskLinkFor, type ActorRole } from '../../src/lib/auth/rbac';
import { filterNavigation } from '../../src/lib/auth/navigation';
import { FORBIDDEN_DIGEST, ForbiddenError, NotFoundError } from '../../src/lib/errors';

/**
 * Regeln der Oberfläche, direkt gerechnet (Audit Oberfläche 2026-09-28).
 *
 * Kein Server, keine Datenbank: Hier stehen nur die reinen Entscheidungen, die
 * die Seiten und Benachrichtigungen treffen — wohin ein Aufgabenlink führt,
 * wer den Kundenbereich betritt, welche Eingabemaske die Middleware vor dem
 * Rendern abweist, woran die Fehlergrenze eine fehlende Berechtigung erkennt.
 * Dass die Seiten diese Regeln auch anwenden, beweisen `tests/api/rbac.test.ts`,
 * `tests/api/ownership.test.ts` und `tests/pages/smoke.test.ts` über HTTP.
 */

describe('Aufgabenlinks nach Empfängerrolle (L-05)', () => {
  it('Mitarbeitende landen im Portal, nie in der Verwaltung', () => {
    assert.equal(taskLinkFor('EMPLOYEE'), '/portal/aufgaben');
    // Auch dann, wenn die Aufrufstelle einen genaueren Verwaltungsort nennt.
    assert.equal(taskLinkFor('EMPLOYEE', '/admin/fuehrung/sitzungen/abc'), '/portal/aufgaben');
    assert.equal(taskLinkFor('EMPLOYEE', '/admin/fuehrung/massnahmen'), '/portal/aufgaben');
  });

  it('das Büro bekommt den Verwaltungsort der Aufrufstelle', () => {
    for (const rolle of ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] as const) {
      assert.equal(taskLinkFor(rolle), '/admin/aufgaben', rolle);
      assert.equal(taskLinkFor(rolle, '/admin/fuehrung/sitzungen/abc'), '/admin/fuehrung/sitzungen/abc', rolle);
    }
  });

  it('der Link führt in einen Bereich, den die Rolle betreten darf', () => {
    for (const rolle of ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EMPLOYEE'] as const) {
      const ziel = taskLinkFor(rolle);
      assert.ok(guardForPath(ziel)?.roles.includes(rolle), `${rolle} → ${ziel}`);
      // Und die Seite dort verlangt ein Recht, das die Rolle hält.
      assert.ok(can(rolle, 'task:read'), rolle);
    }
  });
});

describe('Kundenbereich nur für Kundschaft (L-08)', () => {
  it('ROUTE_GUARDS lässt nur CUSTOMER in /konto', () => {
    const guard = guardForPath('/konto/bewertungen');
    assert.deepEqual(guard?.roles, ['CUSTOMER']);
  });

  it('die Profilseiten des Personals liegen ausserhalb von /konto', () => {
    assert.ok(guardForPath('/admin/profil/einstellungen')?.roles.includes('MANAGER'));
    assert.ok(guardForPath('/portal/profil/einstellungen')?.roles.includes('EMPLOYEE'));
  });
});

describe('Portalnavigation nach Rechten (L-08)', () => {
  const gruppen = [
    {
      items: [
        { href: '/portal/aufgaben', label: 'Meine Aufgaben', icon: 'checklist', permission: 'task:read' as const },
        { href: '/portal/ziele', label: 'Meine Ziele', icon: 'target', permission: 'objective:read_own' as const },
        { href: '/portal/wissen', label: 'Wissen', icon: 'book', permission: 'knowledge:read' as const },
      ],
    },
  ];
  const hrefs = (rolle: ActorRole) => filterNavigation(gruppen, rolle).flatMap((g) => g.items.map((i) => i.href));

  it('die Betriebsleitung sieht „Meine Ziele" nicht', () => {
    assert.ok(!hrefs('MANAGER').includes('/portal/ziele'));
    assert.ok(hrefs('MANAGER').includes('/portal/aufgaben'));
  });

  it('Mitarbeitende sehen Aufgaben, Ziele und Wissen', () => {
    assert.deepEqual(hrefs('EMPLOYEE'), ['/portal/aufgaben', '/portal/ziele', '/portal/wissen']);
  });
});

describe('Eingabemasken vor dem Rendern (L-10)', () => {
  it('„Ziel anlegen" verlangt objective:create, die Liste nur objective:read', () => {
    assert.equal(permissionForPath('/admin/fuehrung/ziele/neu'), 'objective:create');
    assert.equal(permissionForPath('/admin/fuehrung/ziele'), 'objective:read');
    assert.equal(permissionForPath('/admin/fuehrung/ziele/abc'), 'objective:read');
    assert.ok(!can('MANAGER', 'objective:create'));
  });
});

describe('Fehlende Berechtigung an der Fehlergrenze (L-09)', () => {
  it('ForbiddenError trägt die feste Kennung, die Next an den Browser durchreicht', () => {
    const fehler = new ForbiddenError('Fehlende Berechtigung: risk:read');
    assert.equal((fehler as unknown as { digest: string }).digest, FORBIDDEN_DIGEST);
    assert.equal(fehler.status, 403);
  });

  it('andere Fehler tragen sie nicht — sonst hiesse jeder Absturz „keine Berechtigung"', () => {
    assert.equal((new NotFoundError() as unknown as { digest?: string }).digest, undefined);
    assert.equal((new Error('x') as unknown as { digest?: string }).digest, undefined);
  });
});
