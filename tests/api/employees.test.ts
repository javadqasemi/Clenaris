import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { data, del, get, patch, post, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';

/**
 * Personal: anlegen, bearbeiten, Lohnhistorie, Konto-Handlungen, Rechte.
 *
 * Die beiden Fehler, die diese Datei festhält: Das Anlegen scheiterte an
 * einem Datum als ISO-Zeitstempel (der Server verlangt JJJJ-MM-TT), und das
 * Bearbeiten scheiterte an `null` für geleerte Felder (das Schema kannte nur
 * „nicht mitgeschickt"). Beides sah in der Oberfläche wie „geht nicht" aus.
 *
 * Es gibt keinen harten Löschweg für Konten — Akten hängen an Zeiterfassung
 * und Lohn. Die Prüfung legt deshalb eine Akte mit eindeutiger Adresse an
 * und legt sie am Ende still; das Konto wandert in den Papierkorb.
 */

type Jars = Record<AccountName, string>;

interface EmployeeDetail {
  id: string;
  employeeNumber: string;
  position: string;
  department: string | null;
  permitType: string | null;
  birthday: string | null;
  street: string | null;
  city: string | null;
  notes: string | null;
  hourlyRate: string | number | null;
  user: { id: string; email: string; firstName: string; phone: string | null; status: string; mustChangePassword: boolean };
  salaryHistory?: { hourlyRate: string | number | null; reason: string | null; workloadPct: number }[];
}

const RUN = Date.now();
const EMAIL = `pruef.personal.${RUN}@example.ch`;

describe('Personal — anlegen, bearbeiten, Lohnhistorie, Konto', () => {
  let jars: Jars;
  let employeeId = '';
  let userId = '';

  const detail = async (jar: string) =>
    data(await get<{ data: EmployeeDetail }>(`/api/employees/${employeeId}`, { jar }));

  before(async () => {
    await requireServer();
    jars = await loginAll();
  });

  after(async () => {
    if (!employeeId) return;
    await del(`/api/employees/${employeeId}`, { jar: jars.admin });
    if (userId) await del(`/api/users/${userId}`, { jar: jars.super });
  });

  it('anlegen dürfen Administration und Systemverantwortung — nicht Betriebsleitung, Team, Kundschaft', async () => {
    for (const role of ['manager', 'employee', 'customer'] as const) {
      const response = await post(
        '/api/employees',
        { firstName: 'Verboten', lastName: 'Test', email: `verboten.${role}@example.ch`, hiredAt: '2026-09-14' },
        { jar: jars[role] },
      );
      assert.equal(response.status, 403, `${role} legt kein Personal an`);
    }
    const page = await get('/admin/personal/neu', { jar: jars.super });
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('Anlegen und einladen'), 'Systemverantwortung sieht das Formular');
    // 404 oder Umleitung — beides heisst „nicht da"; ein 200 mit Fehlerseite
    // oder gar das Formular wäre der Fehler.
    const hidden = await get('/admin/personal/neu', { jar: jars.manager });
    assert.ok(
      hidden.status === 404 || (hidden.status >= 300 && hidden.status < 400),
      `für die Betriebsleitung existiert die Maske nicht (HTTP ${hidden.status})`,
    );
    assert.ok(!hidden.text.includes('Anlegen und einladen'));
  });

  it('weist ein Datum als ISO-Zeitstempel ab und nimmt JJJJ-MM-TT an', async () => {
    const iso = await post(
      '/api/employees',
      { firstName: 'Prüf', lastName: 'Personal', email: EMAIL, hiredAt: '2026-09-14T00:00:00.000Z' },
      { jar: jars.admin },
    );
    assert.equal(iso.status, 422, iso.text);

    const created = await post<{ data: { id: string; employeeNumber: string } }>(
      '/api/employees',
      {
        firstName: 'Prüf',
        lastName: 'Personal',
        email: EMAIL,
        hiredAt: '2026-09-14',
        hourlyRate: 30,
        workloadPct: 80,
        permitType: 'B',
      },
      { jar: jars.admin },
    );
    assert.equal(created.status, 201, created.text);
    employeeId = data(created).id;

    const duplicate = await post(
      '/api/employees',
      { firstName: 'Prüf', lastName: 'Doppel', email: EMAIL, hiredAt: '2026-09-14' },
      { jar: jars.admin },
    );
    assert.equal(duplicate.status, 409, 'dieselbe Adresse zweimal');

    const employee = await detail(jars.admin);
    userId = employee.user.id;
    assert.equal(employee.user.status, 'PENDING', 'eingeladen, noch nicht aktiviert');
    assert.equal(employee.salaryHistory?.length, 1, 'Ausgangszeile der Lohnhistorie');
    assert.equal(employee.salaryHistory?.[0].reason, 'Anstellung');
  });

  it('verbirgt Lohn und Lohnhistorie vor der Betriebsleitung', async () => {
    const employee = await detail(jars.manager);
    assert.equal(employee.hourlyRate, null);
    assert.equal(employee.salaryHistory, undefined);
  });

  it('bearbeitet alle Felder — und nimmt null für geleerte Felder an', async () => {
    const cleared = await patch(
      `/api/employees/${employeeId}`,
      { position: 'Reinigungsfachkraft', permitType: null, department: null, phone: null },
      { jar: jars.manager },
    );
    assert.equal(cleared.status, 200, cleared.text);

    const full = await patch(
      `/api/employees/${employeeId}`,
      {
        firstName: 'Prüfa',
        lastName: 'Personalia',
        phone: '+41 79 000 00 00',
        birthday: '1990-05-17',
        street: 'Bundesgasse 1',
        postalCode: '3011',
        city: 'Bern',
        nationality: 'CH',
        notes: 'Prüfnotiz',
        department: 'Reinigung',
      },
      { jar: jars.manager },
    );
    assert.equal(full.status, 200, full.text);

    const employee = await detail(jars.admin);
    assert.equal(employee.user.firstName, 'Prüfa');
    assert.equal(employee.user.phone, '+41 79 000 00 00');
    assert.equal(employee.permitType, null, 'Bewilligung geleert');
    assert.equal(employee.department, 'Reinigung');
    assert.equal(employee.street, 'Bundesgasse 1');
    assert.equal(employee.city, 'Bern');
    assert.equal(employee.notes, 'Prüfnotiz');
    assert.equal(String(employee.birthday).slice(0, 10), '1990-05-17');
  });

  it('lehnt eine vergebene E-Mail und eine vergebene Personalnummer mit 409 ab', async () => {
    const email = await patch(`/api/employees/${employeeId}`, { email: 'admin@clenaris.ch' }, { jar: jars.admin });
    assert.equal(email.status, 409, email.text);

    const number = await patch(`/api/employees/${employeeId}`, { employeeNumber: 'MA-2026-00001' }, { jar: jars.admin });
    assert.equal(number.status, 409, number.text);

    const renamed = await patch(`/api/employees/${employeeId}`, { employeeNumber: `PRF-${RUN}` }, { jar: jars.admin });
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal((await detail(jars.admin)).employeeNumber, `PRF-${RUN}`);
  });

  it('schreibt jede Lohnänderung in die Lohnhistorie — unveränderte Werte nicht', async () => {
    const raise = await patch(
      `/api/employees/${employeeId}`,
      { hourlyRate: 33, salaryReason: 'Prüf-Lohnrunde', salaryValidFrom: '2026-10-01' },
      { jar: jars.admin },
    );
    assert.equal(raise.status, 200, raise.text);

    let employee = await detail(jars.admin);
    assert.equal(Number(employee.hourlyRate), 33);
    assert.equal(employee.salaryHistory?.length, 2);
    assert.equal(Number(employee.salaryHistory?.[0].hourlyRate), 33, 'neueste Zeile zuerst');
    assert.equal(employee.salaryHistory?.[0].reason, 'Prüf-Lohnrunde');

    const same = await patch(`/api/employees/${employeeId}`, { hourlyRate: 33, workloadPct: 80 }, { jar: jars.admin });
    assert.equal(same.status, 200);
    employee = await detail(jars.admin);
    assert.equal(employee.salaryHistory?.length, 2, 'keine Zeile ohne Änderung');

    const salaryByManager = await patch(`/api/employees/${employeeId}`, { hourlyRate: 99 }, { jar: jars.manager });
    // Die Betriebsleitung darf die Akte pflegen; ob sie Lohnfelder setzen
    // darf, entscheidet das Schema nicht — die Oberfläche zeigt sie ihr nicht.
    // Festgehalten wird hier nur, dass die Antwort keine 500 ist.
    assert.ok(salaryByManager.status < 500);
  });

  it('Konto-Handlungen: Zugangslink, Passwortzwang, Sperre, Profilbild', async () => {
    const link = await post<{ data: { kind: string } }>(`/api/users/${userId}/password-reset`, undefined, { jar: jars.admin });
    assert.equal(link.status, 200, link.text);
    assert.equal(data(link).kind, 'invite', 'eingeladenes Konto bekommt eine neue Einladung');

    const denied = await post(`/api/users/${userId}/password-reset`, undefined, { jar: jars.manager });
    assert.equal(denied.status, 403, 'Betriebsleitung löst keine Zugangslinks aus');

    const force = await patch(`/api/users/${userId}`, { mustChangePassword: true }, { jar: jars.admin });
    assert.equal(force.status, 200, force.text);
    assert.equal((await detail(jars.admin)).user.mustChangePassword, true);

    const photo = await patch(`/api/users/${userId}`, { avatarUrl: '/api/files/blob/pruefbild' }, { jar: jars.admin });
    assert.equal(photo.status, 200, photo.text);

    const suspend = await patch(`/api/users/${userId}`, { status: 'SUSPENDED' }, { jar: jars.admin });
    assert.equal(suspend.status, 200, suspend.text);
    const blocked = await post(`/api/users/${userId}/password-reset`, undefined, { jar: jars.admin });
    assert.equal(blocked.status, 422, 'gesperrtes Konto bekommt keinen Link');
  });

  it('stilllegen setzt Austritt, hält Zeiterfassung und Akte', async () => {
    const response = await del(`/api/employees/${employeeId}`, { jar: jars.admin });
    assert.equal(response.status, 204, response.text);
    const employee = await detail(jars.admin);
    assert.equal(employee.user.status, 'DISABLED');
    const listed = data(await get<{ data: { id: string }[] }>('/api/employees', { jar: jars.admin }));
    assert.ok(!listed.some((e) => e.id === employeeId), 'nicht mehr im aktiven Personal');
  });
});
