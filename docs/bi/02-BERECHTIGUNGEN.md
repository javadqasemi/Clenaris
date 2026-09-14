# Berechtigungen und Navigation

Alles, was in `src/lib/auth/permissions.ts`, `src/lib/auth/rbac.ts` und
`src/app/(app)/admin/layout.tsx` dazukommt.

---

## 1. Leitgedanke

Die bestehende Rollentrennung ist ausdrücklich begründet
(`rbac.ts`, Kommentar über `MANAGER_PERMISSIONS`):

> Preise, Leistungsumfang, Gutscheine und Website-Texte wirken auf *jeden
> künftigen* Abschluss und auf das, was die Firma öffentlich zusagt. Das ist
> eine Geschäftsleitungsentscheidung. Alles, was einen *laufenden* Vorgang
> betrifft, darf die Betriebsleitung.

Unternehmensführung liegt vollständig auf der gestaltenden Seite dieser
Linie. Strategie, Budget, Investitionen, Risikoregister und Personaldokumente
sind keine laufenden Vorgänge.

Daraus folgt die Grundregel: **Die Betriebsleitung sieht, was sie für die
Steuerung des Tagesgeschäfts braucht, und gestaltet nichts davon.**
Konkret sieht `MANAGER` Kennzahlen, das Cockpit ohne Finanzteil und die
eigenen Bereichsziele — und weder Budget, noch Investitionen, noch das
Risikoregister, noch die Dokumentenablage.

Wer das lockern will, ändert genau eine Liste (`MANAGER_PERMISSIONS`) und
sieht die Folge in der Rechtematrix unter `/admin/rollen`. Das ist der Zweck
des statischen Katalogs.

---

## 2. Neue Berechtigungsgruppe

`PERMISSION_GROUPS` in `src/lib/auth/permissions.ts` bekommt einen Eintrag.
Er steht **nach `Finanzen`**, weil die Reihenfolge die Reihenfolge in der
Rechtematrix ist und Unternehmensführung dort neben die Finanzen gehört:

```ts
export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  'Übersicht',
  'Website',
  'Katalog und Preise',
  'Kundenbeziehung',
  'Betrieb',
  'Finanzen',
  'Unternehmensführung', // neu
  'Personal',
  'Kommunikation',
  'System',
] as const;
```

---

## 3. Neue Berechtigungen

Einzufügen in `PERMISSIONS`, als eigener Block nach den Finanzrechten.
Die Reihenfolge innerhalb des Blocks ist die Reihenfolge in der Matrix.

```ts
  // --- Unternehmensführung ---------------------------------------------------
  'cockpit:view',
  'cockpit:financials',

  'kpi:read',
  'kpi:manage',

  'objective:read',
  'objective:read_own',
  'objective:create',
  'objective:update',
  'objective:delete',
  'objective:checkin',

  'budget:read',
  'budget:create',
  'budget:update',
  'budget:delete',
  'budget:approve',

  'investment:read',
  'investment:create',
  'investment:update',
  'investment:delete',

  'scenario:read',
  'scenario:manage',

  'risk:read',
  'risk:create',
  'risk:update',
  'risk:delete',

  'control:read',
  'control:create',
  'control:update',
  'control:delete',

  'action:read',
  'action:create',
  'action:update',

  'document:read',
  'document:read_own',
  'document:create',
  'document:update',
  'document:delete',

  'knowledge:read',
  'knowledge:create',
  'knowledge:update',
  'knowledge:delete',

  'market:read',
  'market:manage',

  'meeting:read',
  'meeting:create',
  'meeting:update',
  'meeting:delete',

  'bireport:read',
  'bireport:manage',
```

### 3.1 Warum diese Schnitte

**`cockpit:view` getrennt von `cockpit:financials`.** Dieselbe Trennung, die
`dashboard:view` / `dashboard:financials` heute schon macht. Die
Betriebsleitung soll Auslastung, Stornoquote und Auftragslage sehen, ohne
Marge und Liquidität. Ohne die Trennung wäre das Cockpit entweder für alle
offen oder für alle zu — und beides ist falsch.

**`objective:read_own` als eigenes Recht.** Persönliche OKR sind der eine
Teil dieses Moduls, der Mitarbeitende erreicht. Ohne `read_own` bekämen sie
`objective:read` und damit die Firmenstrategie; mit `read_own` sehen sie die
Ziele, deren Verantwortung bei ihnen liegt, und die Firmenziele, die als
`COMPANY` und `ACTIVE` ausdrücklich für alle gelten. Diese Einschränkung
gehört in die Prisma-`where`-Klausel (siehe Abschnitt 6).

**`document:read_own` als eigenes Recht.** Eine Person muss ihren Vertrag und
ihr Zeugnis sehen — und nur ihre. `document:read` ohne Zusatz gäbe Zugriff
auf alle Personaldokumente.

**`budget:approve` getrennt.** Genehmigen friert die Planwerte ein. Wer das
darf, entscheidet, woran später gemessen wird; das ist nicht dasselbe wie
Zahlen eintragen.

**Kein `bi:write` als Sammelrecht.** Die Begründung steht im Kopf von
`permissions.ts`: ein einziges `write` erlaubt niemandem, das Löschen zu
entziehen, ohne auch das Anlegen zu nehmen.

---

## 4. `PERMISSION_META`

`Record<Permission, …>` erzwingt Vollständigkeit — ein Schlüssel ohne Eintrag
bricht den Build, und das ist beabsichtigt. Vollständige Tabelle:

```ts
  'cockpit:view': { label: 'Cockpit.View', group: 'Unternehmensführung', description: 'Das Führungscockpit mit Gesundheitswert und Kennzahlen öffnen.' },
  'cockpit:financials': { label: 'Cockpit.Financials', group: 'Unternehmensführung', description: 'Marge, Liquidität und Kostenkennzahlen im Cockpit sehen.' },

  'kpi:read': { label: 'Kpi.View', group: 'Unternehmensführung', description: 'Kennzahlen und ihren Verlauf einsehen.' },
  'kpi:manage': { label: 'Kpi.Manage', group: 'Unternehmensführung', description: 'Kennzahlen anlegen, Zielwerte setzen und Gewichte im Gesundheitswert ändern.' },

  'objective:read': { label: 'Objectives.View', group: 'Unternehmensführung', description: 'Strategien, Ziele und Initiativen der Firma einsehen.' },
  'objective:read_own': { label: 'Objectives.View.Own', group: 'Unternehmensführung', description: 'Die eigenen Ziele und die freigegebenen Firmenziele einsehen.', scoped: true },
  'objective:create': { label: 'Objectives.Create', group: 'Unternehmensführung', description: 'Strategien, Ziele und Initiativen anlegen.' },
  'objective:update': { label: 'Objectives.Update', group: 'Unternehmensführung', description: 'Ziele bearbeiten, umhängen und ihren Status ändern.' },
  'objective:delete': { label: 'Objectives.Delete', group: 'Unternehmensführung', description: 'Ziele löschen.' },
  'objective:checkin': { label: 'Objectives.Checkin', group: 'Unternehmensführung', description: 'Fortschritt zu einem Schlüsselergebnis eintragen.' },

  'budget:read': { label: 'Budget.View', group: 'Unternehmensführung', description: 'Budgets mit Plan-, Ist- und Abweichungswerten einsehen.' },
  'budget:create': { label: 'Budget.Create', group: 'Unternehmensführung', description: 'Budgetperioden und Budgetzeilen anlegen.' },
  'budget:update': { label: 'Budget.Update', group: 'Unternehmensführung', description: 'Budgetzeilen ändern und Nachträge erfassen.' },
  'budget:delete': { label: 'Budget.Delete', group: 'Unternehmensführung', description: 'Budgetperioden und -zeilen löschen.' },
  'budget:approve': { label: 'Budget.Approve', group: 'Unternehmensführung', description: 'Ein Budget genehmigen und damit die Planwerte festschreiben.' },

  'investment:read': { label: 'Investments.View', group: 'Unternehmensführung', description: 'Investitionen und das Anlagenverzeichnis einsehen.' },
  'investment:create': { label: 'Investments.Create', group: 'Unternehmensführung', description: 'Investitionen erfassen.' },
  'investment:update': { label: 'Investments.Update', group: 'Unternehmensführung', description: 'Investitionen ändern, in Betrieb nehmen oder ausbuchen.' },
  'investment:delete': { label: 'Investments.Delete', group: 'Unternehmensführung', description: 'Investitionen löschen.' },

  'scenario:read': { label: 'Scenarios.View', group: 'Unternehmensführung', description: 'Geschäftsszenarien und ihre Rechnung einsehen.' },
  'scenario:manage': { label: 'Scenarios.Manage', group: 'Unternehmensführung', description: 'Szenarien anlegen, Annahmen ändern und neu rechnen.' },

  'risk:read': { label: 'Risks.View', group: 'Unternehmensführung', description: 'Das Risikoregister und die Risikomatrix einsehen.' },
  'risk:create': { label: 'Risks.Create', group: 'Unternehmensführung', description: 'Risiken erfassen.' },
  'risk:update': { label: 'Risks.Update', group: 'Unternehmensführung', description: 'Risiken bewerten, Massnahmen hinterlegen und Prüfungen abschliessen.' },
  'risk:delete': { label: 'Risks.Delete', group: 'Unternehmensführung', description: 'Risiken löschen.' },

  'control:read': { label: 'Controls.View', group: 'Unternehmensführung', description: 'Abläufe, Qualitätsstandards, Compliance-Pflichten und Notfallpläne einsehen.' },
  'control:create': { label: 'Controls.Create', group: 'Unternehmensführung', description: 'Kontrollen und Standards anlegen.' },
  'control:update': { label: 'Controls.Update', group: 'Unternehmensführung', description: 'Kontrollen ändern und ihre Prüfung abschliessen.' },
  'control:delete': { label: 'Controls.Delete', group: 'Unternehmensführung', description: 'Kontrollen löschen.' },

  'action:read': { label: 'Actions.View', group: 'Unternehmensführung', description: 'Korrektur- und Verbesserungsmassnahmen einsehen.' },
  'action:create': { label: 'Actions.Create', group: 'Unternehmensführung', description: 'Massnahmen zu Risiken, Kontrollen oder Reklamationen eröffnen.' },
  'action:update': { label: 'Actions.Update', group: 'Unternehmensführung', description: 'Massnahmen bearbeiten und ihre Wirksamkeit bestätigen.' },

  'document:read': { label: 'Documents.View', group: 'Unternehmensführung', description: 'Dokumente der Ablage im Rahmen ihrer Sichtbarkeit öffnen.' },
  'document:read_own': { label: 'Documents.View.Own', group: 'Unternehmensführung', description: 'Die eigenen Personaldokumente öffnen.', scoped: true },
  'document:create': { label: 'Documents.Create', group: 'Unternehmensführung', description: 'Dokumente ablegen und neue Fassungen hochladen.' },
  'document:update': { label: 'Documents.Update', group: 'Unternehmensführung', description: 'Angaben, Fristen und Sichtbarkeit eines Dokuments ändern.' },
  'document:delete': { label: 'Documents.Delete', group: 'Unternehmensführung', description: 'Dokumente löschen.' },

  'knowledge:read': { label: 'Knowledge.View', group: 'Unternehmensführung', description: 'Die interne Wissensdatenbank lesen.' },
  'knowledge:create': { label: 'Knowledge.Create', group: 'Unternehmensführung', description: 'Wissensartikel verfassen.' },
  'knowledge:update': { label: 'Knowledge.Update', group: 'Unternehmensführung', description: 'Wissensartikel bearbeiten und veröffentlichen.' },
  'knowledge:delete': { label: 'Knowledge.Delete', group: 'Unternehmensführung', description: 'Wissensartikel löschen.' },

  'market:read': { label: 'Market.View', group: 'Unternehmensführung', description: 'Wettbewerber, Marktbeobachtungen und Analysen einsehen.' },
  'market:manage': { label: 'Market.Manage', group: 'Unternehmensführung', description: 'Wettbewerber, Marktbeobachtungen sowie SWOT- und PESTEL-Tafeln pflegen.' },

  'meeting:read': { label: 'Meetings.View', group: 'Unternehmensführung', description: 'Sitzungsprotokolle und Beschlüsse einsehen.' },
  'meeting:create': { label: 'Meetings.Create', group: 'Unternehmensführung', description: 'Sitzungen anlegen.' },
  'meeting:update': { label: 'Meetings.Update', group: 'Unternehmensführung', description: 'Protokolle, Beschlüsse und Pendenzen bearbeiten.' },
  'meeting:delete': { label: 'Meetings.Delete', group: 'Unternehmensführung', description: 'Sitzungen löschen.' },

  'bireport:read': { label: 'BusinessReports.View', group: 'Unternehmensführung', description: 'Erzeugte Führungsberichte öffnen und herunterladen.' },
  'bireport:manage': { label: 'BusinessReports.Manage', group: 'Unternehmensführung', description: 'Berichtszeitpläne einrichten und Berichte ausserplanmässig erzeugen.' },
```

---

## 5. Rollenzuordnung

### 5.1 `ADMIN` und `SUPER_ADMIN`

Nichts zu tun. `ADMIN_PERMISSIONS` ist `PERMISSIONS` ohne die drei
Systemrechte — neue Rechte landen automatisch dort. Genau dafür ist die
Filterung gebaut.

### 5.2 `MANAGER`

In `MANAGER_PERMISSIONS` einfügen, mit Kommentar:

```ts
  // Unternehmensführung: sehen, was für die Steuerung des Tagesgeschäfts
  // nötig ist — gestalten nichts davon. Budget, Investitionen, Risikoregister
  // und Dokumentenablage fehlen hier bewusst; das sind
  // Geschäftsleitungsentscheidungen, dieselbe Linie wie bei Preisen und
  // Website. `cockpit:financials` fehlt aus demselben Grund wie
  // `dashboard:financials` vorhanden ist: das operative Cockpit zeigt
  // Auslastung und Auftragslage, die Marge bleibt der Geschäftsleitung.
  'cockpit:view',
  'kpi:read',
  'objective:read',
  'objective:update',
  'objective:checkin',
  'action:read',
  'action:create',
  'action:update',
  'control:read',
  'knowledge:read',
  'meeting:read',
  'meeting:create',
  'meeting:update',
```

Anmerkung zu `dashboard:financials`: `MANAGER` hat es bereits. Das ist kein
Widerspruch — das bestehende Dashboard zeigt Umsatz eines Zeitraums, das
Cockpit zeigt Marge, Liquiditätsvorschau und Kostenstruktur. Wenn sich
herausstellt, dass die Trennung im Alltag stört, ist `cockpit:financials` in
dieser Liste eine Zeile.

### 5.3 `EMPLOYEE`

```ts
  // Persönliche Ziele und die eigenen Personaldokumente. Beide Rechte sind
  // datensatzbezogen — die Einschränkung greift im Dienst, nicht in der
  // Anzeige.
  'objective:read_own',
  'objective:checkin',
  'knowledge:read',
  'document:read_own',
```

`knowledge:read` ist der Grund, warum die Wissensdatenbank überhaupt Nutzen
hat: Ablaufbeschreibungen und Schulungsunterlagen sind für die
Mitarbeitenden geschrieben. Die Sichtbarkeit je Artikel
(`DocumentVisibility`) entscheidet, was davon ankommt.

### 5.4 `CUSTOMER`

Nichts. Kein Recht dieses Moduls geht an die Kundschaft.

---

## 6. Datensatzbezogene Einschränkungen

`read_own` ist eine Aussage über die Art der Daten, nicht über die Menge.
Welche Datensätze, entscheidet der Dienst — in der `where`-Klausel, nie im
Rendering.

### 6.1 Ziele

```ts
// objective.service.ts
function scopeFor(session: SessionUser): Prisma.ObjectiveWhereInput {
  if (can(session.role, 'objective:read')) return {};

  // EMPLOYEE: die eigenen Ziele plus die aktiven Firmenziele. Letztere
  // ausdrücklich, weil ein Quartalsziel, das niemand ausser der Leitung
  // sieht, seinen Zweck verfehlt.
  return {
    OR: [
      { ownerId: session.id },
      { level: 'COMPANY', status: 'ACTIVE' },
      { keyResults: { some: { /* … */ } } },
    ],
  };
}
```

### 6.2 Dokumente

Die schärfste Regel des Moduls:

```ts
// document.service.ts
function visibilityFor(session: SessionUser, employeeId: string | null) {
  const levels: DocumentVisibility[] = [];
  if (atLeast(session.role, 'ADMIN')) levels.push('MANAGEMENT', 'OPERATIONS', 'STAFF');
  else if (session.role === 'MANAGER') levels.push('OPERATIONS', 'STAFF');
  else if (session.role === 'EMPLOYEE') levels.push('STAFF');

  return {
    OR: [
      { visibility: { in: levels } },
      // Die eigene Personalakte — unabhängig von der Stufe.
      ...(employeeId
        ? [{ visibility: 'EMPLOYEE_PRIVATE' as const, subjectEmployeeId: employeeId }]
        : []),
    ],
  };
}
```

Drei Punkte dazu, jeder davon ein bereits anderswo begangener Fehler:

1. `EMPLOYEE_PRIVATE` ist **nie** in `levels`. Es kommt ausschliesslich über
   den zweiten Zweig mit `subjectEmployeeId` hinein.
2. Die Prüfung gehört in **eine** Funktion, die Liste, Detailansicht und
   Download benutzen. Eine Download-Route, die nur `document:read` prüft und
   dann `findUnique` macht, ist der klassische horizontale Zugriffsfehler.
3. `tests/api/ownership.test.ts` bekommt Fälle dafür — ein Test, der nur den
   Statuscode prüft, findet ein Leck nicht.

---

## 7. Middleware

`PERMISSION_ROUTES` in `rbac.ts` bekommt Einträge für Seiten, die **nur**
Bearbeitungsmaske sind oder heikel genug, dass der Vorfilter vor dem Rendern
greifen soll:

```ts
  { prefix: '/admin/fuehrung/budget', permission: 'budget:read' },
  { prefix: '/admin/fuehrung/investitionen', permission: 'investment:read' },
  { prefix: '/admin/fuehrung/szenarien', permission: 'scenario:read' },
  { prefix: '/admin/fuehrung/risiken', permission: 'risk:read' },
  { prefix: '/admin/fuehrung/qualitaet', permission: 'control:read' },
  { prefix: '/admin/fuehrung/dokumente', permission: 'document:read' },
  { prefix: '/admin/fuehrung/markt', permission: 'market:read' },
  { prefix: '/admin/fuehrung/berichte', permission: 'bireport:read' },
  { prefix: '/admin/fuehrung', permission: 'cockpit:view' },
```

**Die Reihenfolge ist bedeutsam** — der erste Treffer gewinnt, deshalb steht
der Präfix `/admin/fuehrung` zuletzt. Der Kommentar an der bestehenden Liste
sagt das ausdrücklich; die Zeilen hier folgen ihm.

Die Prüfung in der Seite selbst bleibt bestehen. Die Middleware ist ein
Vorfilter, nicht die Autorisierung — sie läuft auf Edge und kann nicht auf
Prisma zugreifen.

---

## 8. Navigation

Neue Gruppe in `src/app/(app)/admin/layout.tsx`, **zwischen `Finanzen` und
`Website`**:

```tsx
    {
      label: 'Unternehmensführung',
      items: [
        { href: '/admin/fuehrung', label: 'Cockpit', icon: 'analytics', exact: true, permission: 'cockpit:view' },
        { href: '/admin/fuehrung/kennzahlen', label: 'Kennzahlen', icon: 'analytics', permission: 'kpi:read' },
        { href: '/admin/fuehrung/ziele', label: 'Ziele und Strategie', icon: 'target', permission: 'objective:read' },
        { href: '/admin/fuehrung/budget', label: 'Budget', icon: 'expenses', permission: 'budget:read' },
        { href: '/admin/fuehrung/investitionen', label: 'Investitionen', icon: 'cards', permission: 'investment:read' },
        { href: '/admin/fuehrung/szenarien', label: 'Szenarien', icon: 'analytics', permission: 'scenario:read' },
        { href: '/admin/fuehrung/risiken', label: 'Risiken', icon: 'shield', badge: overdueReviews, permission: 'risk:read' },
        { href: '/admin/fuehrung/qualitaet', label: 'Qualität und Abläufe', icon: 'checklist', permission: 'control:read' },
        { href: '/admin/fuehrung/dokumente', label: 'Dokumente', icon: 'documents', badge: expiringDocuments, permission: 'document:read' },
        { href: '/admin/fuehrung/wissen', label: 'Wissen', icon: 'book', permission: 'knowledge:read' },
        { href: '/admin/fuehrung/markt', label: 'Markt und Wettbewerb', icon: 'compass', permission: 'market:read' },
        { href: '/admin/fuehrung/sitzungen', label: 'Sitzungen', icon: 'calendar', permission: 'meeting:read' },
        { href: '/admin/fuehrung/berichte', label: 'Berichte', icon: 'reports', permission: 'bireport:read' },
      ],
    },
```

### 8.1 Die beiden Zähler

Sie sind nicht Zierde. Der Kommentar über der bestehenden Navigation nennt
den Massstab: sichtbar gehören die Zahlen, die im Tagesgeschäft **eine
Handlung auslösen**. Für dieses Modul sind das genau zwei:

```tsx
  const [overdueReviews, expiringDocuments] = await Promise.all([
    // Fällige Prüfungen quer über Risiken, Kontrollen und Ziele. Ohne diese
    // Zahl verrottet das Modul still — geführte Einträge veralten, ohne dass
    // es jemandem auffällt, und ein SWOT von vor drei Jahren sieht im Menü
    // genauso gepflegt aus wie ein frisches.
    Promise.all([
      prisma.riskEntry.count({ where: { organizationId, deletedAt: null, nextReviewAt: { lte: new Date() } } }),
      prisma.controlEntry.count({ where: { organizationId, deletedAt: null, nextReviewAt: { lte: new Date() } } }),
      prisma.objective.count({ where: { organizationId, deletedAt: null, status: 'ACTIVE', nextReviewAt: { lte: new Date() } } }),
    ]).then((counts) => counts.reduce((sum, n) => sum + n, 0)),

    // Verträge, Policen und Zertifikate, die innerhalb ihrer Vorwarnfrist
    // ablaufen. Das ist der Grund, warum eine Vertragsablage mehr wert ist
    // als ein Ordner auf dem Laufwerk.
    prisma.managedDocument.count({
      where: {
        organizationId,
        deletedAt: null,
        expiresOn: { lte: addDays(new Date(), 30), gte: new Date() },
      },
    }),
  ]);
```

Dreizehn Menüpunkte sind viel. Zwei Auswege, falls es im Alltag drückt:
Untermenü auf der Cockpit-Seite statt in der Seitenleiste, oder die Gruppe
auf sechs Einträge kürzen und den Rest über das Cockpit erreichbar machen.
Diese Entscheidung fällt sinnvollerweise, wenn Phase 1–4 stehen und man
sieht, was tatsächlich benutzt wird.

### 8.2 Symbole

`NAV_ICONS` in `src/components/app/app-shell.tsx` kennt noch nicht:
`target`, `shield`, `checklist`, `documents`, `book`, `compass`, `reports`.
Passende `lucide-react`-Symbole und Ergänzung des `satisfies`-Objekts —
`shield` kollidiert nicht mit dem bestehenden `roles` (`ShieldCheck`).

---

## 9. Prüfliste

- [ ] `PERMISSION_GROUPS` erweitert
- [ ] Alle Rechte in `PERMISSIONS` (Reihenfolge = Matrixreihenfolge)
- [ ] Jedes Recht hat einen `PERMISSION_META`-Eintrag → sonst bricht der Build
- [ ] `scoped: true` bei `objective:read_own` und `document:read_own`
- [ ] `MANAGER_PERMISSIONS` und `EMPLOYEE_PERMISSIONS` ergänzt
- [ ] `PERMISSION_ROUTES` ergänzt, spezifische Pfade **vor** dem Präfix
- [ ] Navigationsgruppe samt Zählern
- [ ] Neue Symbole in `NAV_ICONS`
- [ ] `/admin/rollen` aufrufen und die neue Gruppe je Rolle durchlesen
- [ ] `npm run typecheck`
