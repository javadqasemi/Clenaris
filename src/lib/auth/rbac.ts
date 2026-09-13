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
  'customer:read',
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

  'lead:read', 'lead:create', 'lead:update', 'lead:delete',
  'customer:read', 'customer:create', 'customer:update',
  'property:read', 'property:create', 'property:update', 'property:delete',
  'activity:read', 'activity:create',
  'task:read', 'task:create', 'task:update', 'task:delete',

  'booking:read', 'booking:create', 'booking:update', 'booking:delete',
  'quote:read', 'quote:create', 'quote:update', 'quote:delete', 'quote:send', 'quote:convert',
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
 * SUPER_ADMIN kommt nur für drei Dinge dazu, die man nicht delegieren will:
 * **Rollen vergeben** (sonst könnte sich jede Administration selbst
 * höherstufen), **das Prüfprotokoll lesen** (wer überwacht wird, soll die
 * Überwachung nicht einsehen) und **sich als jemand anderes anmelden**.
 */
const SUPER_ADMIN_ONLY: Permission[] = ['role:assign', 'audit:read', 'user:impersonate'];

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
 * Die Profilseite der Rolle — dort steht das Passwortformular.
 *
 * Gebraucht, wenn ein Konto sein Passwort wechseln *muss*: Die Anmeldung
 * leitete zuvor auf `/auth/passwort-aendern`, eine Seite, die es nie gab; wer
 * mit einem Startpasswort kam, landete auf einem 404. Das Passwort ändert man
 * auf der Profilseite, und die gibt es in jedem Bereich.
 */
export function profileRouteFor(role: ActorRole): string {
  return `${homeRouteFor(role)}/profil`;
}

/** Welche Rollen dürfen einen Pfad-Präfix betreten? Wird von der Middleware genutzt. */
export const ROUTE_GUARDS: { prefix: string; roles: UserRole[] }[] = [
  { prefix: '/admin', roles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] },
  { prefix: '/portal', roles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EMPLOYEE'] },
  { prefix: '/konto', roles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'CUSTOMER'] },
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
    'Alles, plus Rollenvergabe, Prüfprotokoll und Kontoübernahme. Für genau eine oder zwei Personen gedacht.',
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
  { prefix: '/admin/rollen', permission: 'role:read' },
  { prefix: '/admin/protokoll', permission: 'audit:read' },
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
