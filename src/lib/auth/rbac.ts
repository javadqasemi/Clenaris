import type { UserRole } from '@prisma/client';

import {
  PERMISSIONS,
  PERMISSION_META,
  type Permission,
} from './permissions';

export {
  PERMISSIONS,
  PERMISSION_GROUPS,
  PERMISSION_META,
  isPermission,
  permissionLabel,
  permissionsByGroup,
  type Permission,
  type PermissionGroup,
  type PermissionMeta,
} from './permissions';

/**
 * Rollenbasierte Zugriffskontrolle.
 *
 * Architekturentscheide:
 *
 *  • **Berechtigungen werden pro Rolle statisch aufgelöst.** Kein
 *    Datenbankzugriff, damit jede Prüfung — und es gibt Dutzende pro Seite —
 *    kostenlos ist. Die Zuordnung steht im Diff und kann nicht halb migriert
 *    sein. Die Prüf-API `can(role, permission)` bliebe bei einem späteren
 *    Wechsel auf benutzerdefinierte Rollen unverändert.
 *
 *  • **Rollenprüfung ersetzt nie den Datenfilter.** Eine Kundschaft hat
 *    `booking:read_own`, aber der Dienst filtert trotzdem zwingend auf
 *    `customerId`. Die Berechtigung sagt „darf diese Art von Daten sehen", der
 *    Filter sagt „welche". Beides zu verwechseln ist die häufigste Ursache
 *    dafür, dass jemand fremde Datensätze sieht.
 *
 *  • **`GUEST` ist eine Pseudorolle und steht nicht in der Datenbank.** Sie
 *    beschreibt, was jemand *ohne Anmeldung* darf. Stünde sie im
 *    `UserRole`-Enum, liesse sich ein Konto darauf setzen — ein angemeldeter
 *    Benutzer mit Gastrechten ist ein Zustand, den niemand gemeint hat und den
 *    jede Prüfung mitdenken müsste.
 */

/** Rollen inklusive der Pseudorolle für nicht angemeldete Besucher. */
export type ActorRole = UserRole | 'GUEST';

export const ACTOR_ROLES: ActorRole[] = [
  'SUPER_ADMIN',
  'ADMIN',
  'MANAGER',
  'EMPLOYEE',
  'CUSTOMER',
  'GUEST',
];

/**
 * Was ein nicht angemeldeter Besucher darf.
 *
 * Absichtlich leer. Die öffentliche Website liest ihre Daten über Server
 * Components und öffentliche Endpunkte, die gar keine Session kennen — sie
 * fragen nie `can()`. Wäre hier etwas eingetragen, entstünde der Eindruck,
 * die Freigabe der Website hinge an dieser Liste; sie hängt an
 * `definePublicRoute` und an den Routen unter `/api/public`.
 *
 * Die Rolle existiert, damit die Rechtematrix eine ehrliche Spalte für „ohne
 * Anmeldung" hat: sie zeigt schwarz auf weiss, dass ein Gast keine einzige
 * geschützte Berechtigung besitzt.
 */
const GUEST_PERMISSIONS: Permission[] = [];

const CUSTOMER_PERMISSIONS: Permission[] = [
  'customer:read_own',
  'customer:update_own',
  'booking:read_own',
  'booking:write_own',
  'quote:read_own',
  'quote:respond_own',
  // Die eigenen Verträge einsehen — Laufzeit, Leistungen, Termine, Preis.
  // Ein Dauerschuldverhältnis, dessen Inhalt die Kundschaft im Kundenbereich
  // nicht nachlesen kann, ist eine Bringschuld, die auf Anruf hinausläuft.
  'contract:read_own',
  /**
   * Die Kontrollen der eigenen Objekte.
   *
   * Eine zugesagte Qualität, deren Messung die Kundschaft nicht sehen darf,
   * ist eine Zusage an niemanden. Sichtbar ist deshalb das Ergebnis — nicht
   * die interne Notiz; die Einschränkung steht in der Prisma-`where`-Klausel
   * und in der Auswahl, nicht in der Anzeige.
   */
  'quality:read_own',
  /**
   * Reklamationen zu den eigenen Objekten melden und verfolgen (Wave 11).
   * Eine Reaktionsfrist, deren Stand die meldende Kundschaft nicht sieht,
   * ist eine Zusage ohne Gegenüber. Die Eigentümerschaft steht in der Abfrage.
   */
  'complaint:read_own',
  'complaint:create_own',
  'invoice:read_own',
  'invoice:pay_own',
  'property:read',
  'property:create',
  'property:update',
  'message:read_own',
  'message:write_own',
  'notification:read_own',
  'review:write_own',
  'file:upload',
  'file:read',
  'service:read',
];

const EMPLOYEE_PERMISSIONS: Permission[] = [
  'dashboard:view',
  'job:read_assigned',
  'job:complete_assigned',
  'timetracking:own',
  'employee:read_own',
  'absence:request',
  'payslip:read_own',
  /*
   * Kein `customer:read` mehr (2026-09-27). Die Begründung war „sie müssen
   * wissen, wohin sie fahren" — das beantwortet der zugeteilte Einsatz mit
   * seiner Adresse, und für Objekte zieht `propertyVisibilityWhere` genau
   * diese Linie. Das Recht öffnete dagegen `GET /api/customers` (der ganze
   * Kundenstamm mit Namen und E-Mail), `GET /api/customers/:id` (die volle
   * Akte samt Rechnungen und Zeitachse), die Adressen jeder Kundschaft und die
   * Kundensuche. Keine Seite des Portals brauchte es; mehrere Stellen mussten
   * die Rolle ausdrücklich wieder ausnehmen (`role !== 'EMPLOYEE'`) — ein
   * Zeichen, dass das Recht nicht passte.
   */
  'property:read',
  'message:read_own',
  'message:write_own',
  'notification:read_own',
  'task:read',
  'task:create',
  'task:update',
  'file:upload',
  'file:read',
  'service:read',
  'activity:read',
  'activity:create',
  // Persönliche Ziele und die eigenen Personaldokumente. Beide Rechte sind
  // datensatzbezogen — die Einschränkung greift im Dienst, nicht in der
  // Anzeige. `knowledge:read` ist der Grund, warum die Wissensdatenbank
  // überhaupt Nutzen hat: Abläufe und Schulungsunterlagen sind für die
  // Mitarbeitenden geschrieben.
  'objective:read_own',
  'objective:checkin',
  'knowledge:read',
  'document:read_own',
];

/**
 * Betriebsleitung: führt das Tagesgeschäft, gestaltet aber nicht den Aussen-
 * auftritt und nicht die Preise.
 *
 * Die Trennung ist keine Bequemlichkeit: Preise, Leistungsumfang, Gutscheine
 * und Website-Texte wirken auf *jeden künftigen* Abschluss und auf das, was
 * die Firma öffentlich zusagt. Das ist eine Geschäftsleitungsentscheidung.
 * Alles, was einen *laufenden* Vorgang betrifft, darf die Betriebsleitung.
 */
const MANAGER_PERMISSIONS: Permission[] = [
  'dashboard:view',
  'dashboard:financials',
  'report:read',
  'report:export',
  // Besuchszahlen: Die Betriebsleitung sieht Auswertungen und Kampagnen
  // (`report:read`, `newsletter:read`) — und damit auch, ob die Kampagne
  // Besuche und Anfragen gebracht hat. Die Messung enthält keine
  // Personendaten; es gibt keinen Grund, sie strenger zu halten als die
  // Finanzauswertung daneben.
  'traffic:read',

  'lead:read', 'lead:create', 'lead:update', 'lead:delete',
  'customer:read', 'customer:create', 'customer:update',
  'property:read', 'property:create', 'property:update', 'property:delete',
  'activity:read', 'activity:create',
  'task:read', 'task:create', 'task:update', 'task:delete',

  'booking:read', 'booking:create', 'booking:update', 'booking:delete',
  'quote:read', 'quote:create', 'quote:update', 'quote:delete', 'quote:send', 'quote:convert',
  // Verträge: vorbereiten ja, in Kraft setzen nein.
  //
  // Dieselbe Linie wie bei Preisen und Website, nur schärfer: Ein Vertrag
  // bindet den Betrieb über Monate. Entwerfen, ändern, eine neue Version
  // vorschlagen und daraus abrechnen gehört zum Tagesgeschäft. **Aktivieren,
  // freigeben, zur Unterschrift geben und kündigen** sind vier Zusagen nach
  // aussen — die trifft die Geschäftsleitung. Wer eine Änderung vorschlägt,
  // soll sie nicht selbst genehmigen; das ist das Vier-Augen-Prinzip und der
  // eigentliche Grund für die feine Zerlegung dieser Rechte.
  'contract:read', 'contract:create', 'contract:update', 'contract:delete_draft',
  'contract:version', 'contract:billing',
  /**
   * Qualitätskontrolle: begehen **und** abschliessen.
   *
   * Anders als bei Verträgen liegt die Linie hier nicht zwischen Entwurf und
   * Zusage nach aussen: Eine Begehung ist eine Feststellung über die eigene
   * Arbeit, und wer sie macht, schliesst sie auch ab. Die Betriebsleitung
   * davon auszuschliessen hiesse, die Person mit der Zange in der Hand auf
   * eine Freigabe warten zu lassen — und in der Zwischenzeit steht ein
   * halber Beleg im System.
   */
  'quality:read', 'quality:inspect', 'quality:complete',
  // Reklamationen, Material und Geräte sind laufender Betrieb (Wave 11).
  'complaint:read', 'complaint:create', 'complaint:update',
  'inventory:read', 'inventory:manage',
  'equipment:read', 'equipment:manage',
  'job:read', 'job:create', 'job:update', 'job:delete', 'job:assign', 'job:dispatch',
  'serviceArea:read',

  'timetracking:read_all', 'timetracking:approve',
  'employee:read', 'employee:update',
  'absence:read_all', 'absence:approve',
  'application:read', 'application:update',
  'jobPosting:read',

  'invoice:read', 'invoice:create', 'invoice:update', 'invoice:delete', 'invoice:send',
  'payment:read', 'payment:create',
  'creditnote:read', 'creditnote:create',
  'expense:read', 'expense:create', 'expense:update', 'expense:delete',
  'supplier:read', 'supplier:create', 'supplier:update',
  'accounting:export',

  // Unternehmensführung: sehen, was für die Steuerung des Tagesgeschäfts
  // nötig ist — gestalten nichts davon. Budget, Investitionen, Risikoregister
  // und Dokumentenablage fehlen hier bewusst; das sind
  // Geschäftsleitungsentscheidungen, dieselbe Linie wie bei Preisen und
  // Website. `cockpit:financials` fehlt aus demselben Grund, aus dem
  // `dashboard:financials` vorhanden ist: das operative Cockpit zeigt
  // Auslastung und Auftragslage, die Marge bleibt der Geschäftsleitung.
  'cockpit:view',
  'kpi:read',
  'objective:read', 'objective:update', 'objective:checkin',
  'action:read', 'action:create', 'action:update',
  'control:read',
  'knowledge:read',
  'meeting:read', 'meeting:create', 'meeting:update',
  // Unterzeichnung: Vorgänge anstossen und verfolgen gehört zum Tagesgeschäft.
  // Abbrechen nicht — ein laufender Vorgang beim Kunden ist eine Zusage, die
  // die Geschäftsleitung zurücknimmt, nicht die Betriebsleitung.
  'signature:read', 'signature:create',

  'message:read', 'message:create',
  'notification:read_own',
  'template:read',
  'newsletter:read',

  'ai:use',
  'automation:read', 'automation:update',
  'file:upload', 'file:read', 'file:delete',
  'settings:read',
  'company:read',

  // Lesend, nicht gestaltend: Katalog, Preise, Website.
  'service:read',
  'pricing:read',
  'coupon:read',
  'content:read',
  'seo:read',
  'cta:read',
  'navigation:read',
  'legal:read',
  'gallery:read',
  'faq:read',
  'blog:read', 'blog:create', 'blog:update', 'blog:publish',
  'media:read', 'media:upload',
  'review:read', 'review:moderate',
];

/**
 * Der Systemverantwortung vorbehalten.
 *
 * Bewusst schmal. Die Administration führt den Betrieb vollständig;
 * SUPER_ADMIN kommt nur für das dazu, was man nicht delegieren will:
 * **Rollen vergeben** (sonst könnte sich jede Administration selbst
 * höherstufen), **das Prüfprotokoll lesen** (wer überwacht wird, soll die
 * Überwachung nicht einsehen) und **sich als jemand anderes anmelden**.
 */
/**
 * `data:purge` kommt als viertes dazu: ganze Datenbereiche endgültig löschen.
 * Aus demselben Grund hier und nicht bei der Administration — die Handlung
 * ist unumkehrbar, und wer sie ausführt, soll im Protokoll stehen, das nur
 * diese Rolle liest.
 */
/**
 * `security:read` und `security:manage` folgen `audit:read` — aus demselben
 * Grund und mit einer zusätzlichen Schärfe.
 *
 * Das Sicherheitszentrum zeigt, wessen Anmeldungen scheitern, wessen Konto
 * gesperrt wurde und wer seinen zweiten Faktor abgeschaltet hat. Das ist eine
 * Aufsicht über Personen, und wer beaufsichtigt wird, darf sie nicht öffnen —
 * sonst sieht die Administration, die sich selbst zu weit vorgewagt hat, als
 * Erste, dass es aufgefallen ist.
 *
 * `security:manage` kommt hinzu, weil die Handlungen dort dieselbe Tragweite
 * haben wie das Lesen: Ein Konto entsperren heisst, eine Sperre aufzuheben,
 * die aus einem Grund zugeschlagen hat, und ein Ereignis zu bestätigen heisst,
 * es als angesehen zu erklären. Beides ist keine Betriebsführung.
 */
/**
 * `release:read` und `release:manage` (2026-09-26): die Versionsverwaltung.
 *
 * Wer eine neue Version freigibt, entscheidet über Ausfallzeit,
 * Datenbankmigrationen und darüber, ob eine Sicherheitslücke offen bleibt —
 * für alle, die mit dem System arbeiten. Das ist Systemverantwortung, nicht
 * Betriebsführung. Auch das Lesen bleibt hier: Ein Änderungsprotokoll mit
 * offenen Sicherheitskorrekturen beschreibt, wo das laufende System
 * verwundbar ist.
 */
const SUPER_ADMIN_ONLY: Permission[] = [
  'role:assign',
  'audit:read',
  'security:read',
  'security:manage',
  'user:impersonate',
  'data:purge',
  'release:read',
  'release:manage',
];

const ADMIN_PERMISSIONS: Permission[] = PERMISSIONS.filter(
  (permission) => !SUPER_ADMIN_ONLY.includes(permission),
);

const ROLE_PERMISSIONS: Record<ActorRole, ReadonlySet<Permission>> = {
  SUPER_ADMIN: new Set(PERMISSIONS),
  ADMIN: new Set(ADMIN_PERMISSIONS),
  MANAGER: new Set(MANAGER_PERMISSIONS),
  EMPLOYEE: new Set(EMPLOYEE_PERMISSIONS),
  CUSTOMER: new Set(CUSTOMER_PERMISSIONS),
  GUEST: new Set(GUEST_PERMISSIONS),
};

export function can(role: ActorRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

export function canAny(role: ActorRole, permissions: Permission[]): boolean {
  return permissions.some((p) => can(role, p));
}

export function canAll(role: ActorRole, permissions: Permission[]): boolean {
  return permissions.every((p) => can(role, p));
}

export function permissionsFor(role: ActorRole): Permission[] {
  // In Katalogreihenfolge, nicht in Einfügereihenfolge — die Rechtematrix
  // soll für jede Rolle dieselbe Zeilenfolge zeigen.
  const own = ROLE_PERMISSIONS[role] ?? new Set<Permission>();
  return PERMISSIONS.filter((permission) => own.has(permission));
}

/** Rollen-Hierarchie für „mindestens diese Rolle"-Prüfungen. */
const ROLE_RANK: Record<ActorRole, number> = {
  GUEST: -1,
  CUSTOMER: 0,
  EMPLOYEE: 1,
  MANAGER: 2,
  ADMIN: 3,
  SUPER_ADMIN: 4,
};

export function atLeast(role: ActorRole, minimum: ActorRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export function isStaff(role: ActorRole): boolean {
  return atLeast(role, 'EMPLOYEE');
}

/** Startseite nach dem Login, abhängig von der Rolle. */
export function homeRouteFor(role: ActorRole): string {
  switch (role) {
    case 'SUPER_ADMIN':
    case 'ADMIN':
    case 'MANAGER':
      return '/admin';
    case 'EMPLOYEE':
      return '/portal';
    case 'CUSTOMER':
    default:
      return '/konto';
  }
}

/**
 * Die persönlichen Einstellungen der Rolle — dort steht das Passwortformular.
 *
 * Gebraucht, wenn ein Konto sein Passwort wechseln *muss*: Die Anmeldung
 * leitete zuvor auf `/auth/passwort-aendern`, eine Seite, die es nie gab; wer
 * mit einem Startpasswort kam, landete auf einem 404. Das Passwort ändert man
 * in den persönlichen Einstellungen, und die gibt es in jedem Bereich. Bis
 * 2026-09-26 stand das Formular direkt auf `…/profil`; seit der Trennung von
 * Profil und Einstellungen führt der Weg eine Ebene tiefer, sonst landete die
 * erzwungene Änderung auf einer Seite ohne Passwortfeld.
 */
export function profileRouteFor(role: ActorRole): string {
  return `${homeRouteFor(role)}/profil/einstellungen`;
}

/**
 * Wohin eine Benachrichtigung über eine Aufgabe führt — abhängig davon, wer
 * sie bekommt.
 *
 * Aufgaben gehen an Büro *und* Mitarbeitende (Sitzungspendenzen, Massnahmen,
 * Erinnerungen, direkt zugewiesene Aufgaben). Bis 2026-09-28 zeigte jede
 * dieser Benachrichtigungen in die Verwaltung (`/admin/aufgaben`,
 * `/admin/fuehrung/…`) — Mitarbeitende wurden dort von der Middleware auf
 * `/portal` zurückgeworfen und fanden die Aufgabe nirgends, obwohl sie
 * `task:read`/`task:update` halten.
 *
 * Wer die Verwaltung betreten darf (`ROUTE_GUARDS`), bekommt den Verweis der
 * Aufrufstelle (die Aufgabenliste oder den genaueren Ort, etwa die Sitzung);
 * alle anderen die eigene Aufgabenliste im Portal. Die Entscheidung steht an
 * einer Stelle, damit keine neue Benachrichtigung sie wieder vergisst.
 */
export function taskLinkFor(role: ActorRole, adminHref = '/admin/aufgaben'): string {
  const admin = ROUTE_GUARDS.find((g) => g.prefix === '/admin');
  return role !== 'GUEST' && admin?.roles.includes(role) ? adminHref : '/portal/aufgaben';
}

/** Welche Rollen dürfen einen Pfad-Präfix betreten? Wird von der Middleware genutzt. */
export const ROUTE_GUARDS: { prefix: string; roles: UserRole[] }[] = [
  { prefix: '/admin', roles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] },
  { prefix: '/portal', roles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EMPLOYEE'] },
  /*
   * Nur Kundschaft (2026-09-28). Vorher durfte jede Rolle hinein, aber jede
   * Seite des Kundenbereichs verlangt ein Kundenprofil (`requireCustomerId`)
   * und warf für das Personal einen Fehler — ein offener Bereich, der nur aus
   * Fehlerseiten besteht. Das eigene Profil und die persönlichen
   * Einstellungen des Personals liegen unter `/admin/profil` bzw.
   * `/portal/profil` (dieselbe Seite, re-exportiert); dafür braucht es den
   * Kundenbereich nicht. Personal wird jetzt von Middleware und Layout auf die
   * eigene Startseite umgeleitet.
   */
  { prefix: '/konto', roles: ['CUSTOMER'] },
];

/** Anzeigename einer Rolle — für Oberfläche und Prüfprotokoll. */
export const ROLE_LABELS: Record<ActorRole, string> = {
  SUPER_ADMIN: 'Systemverantwortung',
  ADMIN: 'Administration',
  MANAGER: 'Betriebsleitung',
  EMPLOYEE: 'Mitarbeitende',
  CUSTOMER: 'Kundschaft',
  GUEST: 'Ohne Anmeldung',
};

/** Ein Satz je Rolle — steht in der Rechtematrix über der Spalte. */
export const ROLE_DESCRIPTIONS: Record<ActorRole, string> = {
  SUPER_ADMIN:
    'Alles, plus Rollenvergabe, Prüfprotokoll, Kontoübernahme, Datenbereinigung und Versionsfreigabe. Für genau eine oder zwei Personen gedacht.',
  ADMIN:
    'Führt den Betrieb vollständig und gestaltet Website, Katalog und Preise. Vergibt keine Rollen und sieht das Prüfprotokoll nicht.',
  MANAGER:
    'Tagesgeschäft von der Anfrage bis zur Rechnung. Sieht Katalog, Preise und Website, ändert sie aber nicht.',
  EMPLOYEE:
    'Die eigenen Einsätze, die eigene Zeit, die eigene Personalakte. Kein Zugang zur Verwaltung.',
  CUSTOMER: 'Ausschliesslich die eigenen Buchungen, Offerten, Rechnungen und Objekte.',
  GUEST: 'Nicht angemeldet. Sieht nur die öffentliche Website.',
};

export function assignableRoles(actor: ActorRole): UserRole[] {
  if (!can(actor, 'role:assign')) return [];
  return (['CUSTOMER', 'EMPLOYEE', 'MANAGER', 'ADMIN', 'SUPER_ADMIN'] as UserRole[]).filter(
    (role) => ROLE_RANK[role] <= ROLE_RANK[actor],
  );
}

export function guardForPath(pathname: string) {
  return ROUTE_GUARDS.find((g) => pathname === g.prefix || pathname.startsWith(`${g.prefix}/`));
}

/**
 * Seitenbereiche, die über die Bereichsrolle hinaus eine Berechtigung
 * verlangen.
 *
 * Warum hier und nicht nur in der Seite: eine Seite mit
 * `dynamic = 'force-dynamic'` streamt bereits, wenn die Prüfung greift — der
 * Statuscode steht dann fest und bleibt 200, auch wenn die Seite anschliessend
 * die 404-Ansicht rendert. Der Inhalt ist dadurch zwar geschützt, aber
 * Suchmaschinen und Überwachung sehen einen Erfolg. In der Middleware
 * entscheidet sich das, bevor irgendetwas gerendert wird.
 *
 * Die Prüfung in der Seite bleibt trotzdem bestehen: die Middleware ist ein
 * Vorfilter, nicht die Autorisierung.
 *
 * Die Reihenfolge ist bedeutsam — der erste Treffer gewinnt, spezifische
 * Pfade stehen deshalb vor ihren Präfixen.
 */
const PERMISSION_ROUTES: { prefix: string; permission: Permission }[] = [
  /**
   * Zwei Klassen von Seiten, und der Unterschied ist wichtig:
   *
   *  • Seiten mit einem **Lesemodus** verlangen nur das Leserecht. Wer nicht
   *    schreiben darf, sieht dort keine Schaltflächen — Katalog,
   *    Handlungsaufrufe, Mediathek, Benutzerkonten und die Rechtematrix sind
   *    so gebaut.
   *
   *  • Seiten, die **nur** Bearbeitungsmaske sind, verlangen das Schreibrecht.
   *    Die Redaktions- und die SEO-Maske bestehen ausschliesslich aus
   *    Eingabefeldern; jemanden hineinzulassen, der nichts speichern darf,
   *    wäre eine Einladung zum Ausfüllen mit anschliessendem 403.
   */
  { prefix: '/admin/inhalte', permission: 'content:update' },
  { prefix: '/admin/seo', permission: 'seo:update' },
  { prefix: '/admin/website', permission: 'faq:read' },
  { prefix: '/admin/cta', permission: 'cta:read' },
  { prefix: '/admin/medien', permission: 'media:read' },
  { prefix: '/admin/benutzer', permission: 'user:read' },
  // Reine Eingabemaske: Personal anlegen dürfen nur Administration und
  // Systemverantwortung. Die Seite streamt mit `force-dynamic`, bevor ihr
  // eigener Guard greift — der Statuscode wäre dann 200 mit Fehlerseite.
  { prefix: '/admin/personal/neu', permission: 'employee:create' },
  { prefix: '/admin/rollen', permission: 'role:read' },
  { prefix: '/admin/protokoll', permission: 'audit:read' },
  // Dieselbe Klasse wie das Prüfprotokoll: Es gibt keinen Lesemodus für
  // andere Rollen, die Seite existiert für sie nicht.
  { prefix: '/admin/sicherheit', permission: 'security:read' },
  // Reine Handlungsmaske ohne Lesemodus: wer nicht löschen darf, soll die
  // Seite gar nicht sehen — sie antwortet mit 404, nicht mit 403.
  { prefix: '/admin/datenbereinigung', permission: 'data:purge' },
  // Versionsverwaltung: dieselbe Klasse — für andere Rollen gibt es sie nicht.
  { prefix: '/admin/updates', permission: 'release:read' },
  { prefix: '/admin/papierkorb', permission: 'booking:delete' },
  { prefix: '/admin/einstellungen', permission: 'settings:read' },
  /**
   * Unternehmensführung. Die spezifischen Bereiche stehen vor dem Präfix
   * `/admin/fuehrung`, weil der erste Treffer gewinnt — sonst käme die
   * Betriebsleitung mit `cockpit:view` bis auf die Budgetseite.
   */
  { prefix: '/admin/fuehrung/budget', permission: 'budget:read' },
  { prefix: '/admin/fuehrung/investitionen', permission: 'investment:read' },
  { prefix: '/admin/fuehrung/szenarien', permission: 'scenario:read' },
  { prefix: '/admin/fuehrung/risiken', permission: 'risk:read' },
  { prefix: '/admin/fuehrung/qualitaet', permission: 'control:read' },
  { prefix: '/admin/fuehrung/massnahmen', permission: 'action:read' },
  { prefix: '/admin/fuehrung/dokumente', permission: 'document:read' },
  { prefix: '/admin/fuehrung/wissen', permission: 'knowledge:read' },
  { prefix: '/admin/fuehrung/markt', permission: 'market:read' },
  { prefix: '/admin/fuehrung/sitzungen', permission: 'meeting:read' },
  { prefix: '/admin/fuehrung/berichte', permission: 'bireport:read' },
  { prefix: '/admin/fuehrung/kennzahlen', permission: 'kpi:read' },
  // Reine Eingabemaske vor ihrem Präfix (2026-09-28): Die Betriebsleitung
  // liest Ziele, legt aber keine an — dieselbe Begründung wie bei
  // `/admin/personal/neu`, sonst stünde der Statuscode vor der Seitenprüfung fest.
  { prefix: '/admin/fuehrung/ziele/neu', permission: 'objective:create' },
  { prefix: '/admin/fuehrung/ziele', permission: 'objective:read' },
  { prefix: '/admin/fuehrung', permission: 'cockpit:view' },
];

export function permissionForPath(pathname: string): Permission | null {
  const match = PERMISSION_ROUTES.find(
    (route) => pathname === route.prefix || pathname.startsWith(`${route.prefix}/`),
  );
  return match?.permission ?? null;
}

/** Alle Berechtigungen mit ihrer Beschreibung — für die Rechtematrix. */
export function permissionMeta(permission: Permission) {
  return PERMISSION_META[permission];
}
