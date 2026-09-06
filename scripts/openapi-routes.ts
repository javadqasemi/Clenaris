import type { ZodTypeAny } from 'zod';

import * as auth from '@/lib/validation/auth';
import * as crm from '@/lib/validation/crm';
import * as booking from '@/lib/validation/booking';
import * as operations from '@/lib/validation/operations';
import * as finance from '@/lib/validation/finance';
import * as messaging from '@/lib/validation/messaging';
import * as ai from '@/lib/validation/ai';
import * as content from '@/lib/validation/content';
import * as files from '@/lib/validation/files';
import * as cms from '@/lib/validation/cms';
import * as catalog from '@/lib/validation/catalog';
import * as cta from '@/lib/validation/cta';
import * as website from '@/lib/validation/website';
import * as opsAdmin from '@/lib/validation/operations-admin';
import * as nav from '@/lib/validation/navigation';
import * as users from '@/lib/validation/users';
import * as q from '@/lib/validation/queries';

/**
 * Registrierung aller REST-Endpunkte.
 *
 * Architekturentscheid: Die Liste ist von Hand gepflegt, die *Schemas* darin
 * sind es nicht — sie sind Verweise auf genau die Zod-Objekte, die zur
 * Laufzeit validieren. Damit kann die Doku bei den Feldern nicht abweichen;
 * abweichen könnte nur, welche Endpunkte gelistet sind, und das prüft der
 * Abgleich in `generate-openapi.ts` gegen den Dateibaum.
 */

export type Guard =
  | { kind: 'public' }
  | { kind: 'cron' }
  | { kind: 'session' }
  | { kind: 'permissions'; permissions: string[]; mode: 'all' | 'any' }
  | { kind: 'role'; roles: string[] };

export interface RouteDoc {
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  /** Pfad in OpenAPI-Schreibweise, also `{id}` statt `[id]`. */
  path: string;
  tag: string;
  summary: string;
  description: string;
  guard: Guard;
  rateLimit?: string;
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
  /** Antwortcode bei Erfolg; Standard 200. */
  status?: 200 | 201 | 204;
  /** Nicht-JSON-Antwort, etwa ein PDF oder eine Tabelle. */
  produces?: string;
  /**
   * Zusätzliche Fehlercodes, die sich nicht aus Methode und Schutz ableiten
   * lassen — etwa 401 bei falschen Zugangsdaten an einem öffentlichen Endpunkt.
   */
  extraErrors?: number[];
}

const perm = (mode: 'all' | 'any', ...permissions: string[]): Guard => ({
  kind: 'permissions',
  permissions,
  mode,
});

export const ROUTES: RouteDoc[] = [
  // -------------------------------------------------------------------------
  //  Authentifizierung
  // -------------------------------------------------------------------------
  {
    method: 'post',
    path: '/api/auth/login',
    tag: 'Authentifizierung',
    summary: 'Anmelden',
    description:
      'Prüft E-Mail und Passwort und setzt Access- und Refresh-Token als httpOnly-Cookies. ' +
      'Die Antwort enthält keine Token — sie stehen ausschliesslich in den Cookies, damit ' +
      'JavaScript im Browser sie nicht auslesen kann.',
    guard: { kind: 'public' },
    rateLimit: 'login',
    body: auth.loginSchema,
    extraErrors: [401],
  },
  {
    method: 'post',
    path: '/api/auth/register',
    tag: 'Authentifizierung',
    summary: 'Kundenkonto eröffnen',
    description:
      'Legt Benutzerkonto und Kundendatensatz an und meldet direkt an. Die Rolle ist immer ' +
      'CUSTOMER; Mitarbeitendenkonten entstehen ausschliesslich über eine Einladung.',
    guard: { kind: 'public' },
    rateLimit: 'register',
    body: auth.registerSchema,
    status: 201,
  },
  {
    method: 'post',
    path: '/api/auth/logout',
    tag: 'Authentifizierung',
    summary: 'Abmelden',
    description:
      'Widerruft den Refresh-Token in der Datenbank und löscht beide Cookies. Ein blosses ' +
      'Löschen im Browser würde einen gestohlenen Token weiterleben lassen.',
    guard: { kind: 'public' },
  },
  {
    method: 'post',
    path: '/api/auth/refresh',
    tag: 'Authentifizierung',
    summary: 'Sitzung erneuern',
    description:
      'Tauscht den Refresh-Token gegen ein neues Paar. Rotation mit Wiederverwendungs-' +
      'erkennung: Wird ein bereits verbrauchter Token erneut vorgelegt, gilt die ganze ' +
      'Token-Familie als kompromittiert und wird verworfen.',
    guard: { kind: 'public' },
    extraErrors: [401],
  },
  {
    method: 'get',
    path: '/api/auth/session',
    tag: 'Authentifizierung',
    summary: 'Sitzungsstatus',
    description:
      'Beantwortet „bin ich angemeldet, und wohin gehöre ich?". Existiert, damit die ' +
      'öffentliche Website die Sitzung nicht im Layout lesen muss — ein Cookie-Zugriff dort ' +
      'würde jede Marketingseite dynamisch machen und jeden Besuch zu einer ' +
      'Datenbankabfrage. Die Antwort ist absichtlich mager und wird nicht zwischengespeichert.',
    guard: { kind: 'public' },
  },
  {
    method: 'post',
    path: '/api/auth/password',
    tag: 'Authentifizierung',
    summary: 'Passwort zurücksetzen oder Einladung annehmen',
    description:
      'Ein Endpunkt für drei Vorgänge, unterschieden über `action`. `forgot` und `reset` ' +
      'antworten immer erfolgreich — die Antwort darf nicht verraten, ob eine Adresse ' +
      'registriert ist.',
    guard: { kind: 'public' },
    rateLimit: 'passwordReset',
    body: auth.passwordActionSchema,
  },
  {
    method: 'patch',
    path: '/api/auth/password',
    tag: 'Authentifizierung',
    summary: 'Passwort ändern',
    description:
      'Ändert das eigene Passwort. Verlangt das bisherige und widerruft anschliessend alle ' +
      'übrigen Sitzungen — wer sein Passwort ändert, will fremde Geräte ausgesperrt wissen.',
    guard: { kind: 'session' },
    rateLimit: 'apiWrite',
    body: auth.changePasswordSchema,
  },
  {
    method: 'patch',
    path: '/api/account/profile',
    tag: 'Authentifizierung',
    summary: 'Eigene Stammdaten ändern',
    description:
      'Name, Telefon, Sprache, Erscheinungsbild und Benachrichtigungseinstellungen. Die ' +
      'E-Mail-Adresse ist bewusst nicht dabei: ein Wechsel muss über einen Bestätigungslink ' +
      'an die neue Adresse laufen.',
    guard: { kind: 'session' },
    rateLimit: 'apiWrite',
    body: auth.updateProfileSchema,
  },
  {
    method: 'get',
    path: '/api/auth/2fa',
    tag: 'Authentifizierung',
    summary: 'Zustand des zweiten Faktors',
    description:
      'Ob die Zwei-Faktor-Anmeldung eingeschaltet ist, seit wann, und wie viele ' +
      'Wiederherstellungscodes noch übrig sind. Weder Geheimnis noch Codes werden je ' +
      'zurückgegeben — die Codes existieren nach der Einrichtung nur noch als Hash.',
    guard: { kind: 'session' },
    rateLimit: 'apiRead',
  },
  {
    method: 'post',
    path: '/api/auth/2fa/setup',
    tag: 'Authentifizierung',
    summary: 'Einrichtung beginnen',
    description:
      'Erzeugt ein TOTP-Geheimnis und liefert es als QR-Code und als Text zum Abtippen. ' +
      'Der Schutz wird dabei **nicht** eingeschaltet: erst der bestätigte Code unter ' +
      '`/api/auth/2fa/confirm` stellt ihn scharf. Ohne diesen zweiten Schritt sperrt sich ' +
      'aus, wer den QR-Code scannt und dann das Telefon zurücksetzt. Ein bereits ' +
      'eingeschalteter Faktor wird nicht überschrieben.',
    guard: { kind: 'session' },
    rateLimit: 'apiWrite',
    extraErrors: [422],
  },
  {
    method: 'post',
    path: '/api/auth/2fa/confirm',
    tag: 'Authentifizierung',
    summary: 'Einrichtung bestätigen',
    description:
      'Prüft den ersten Code und schaltet die Zwei-Faktor-Anmeldung ein. Die Antwort ' +
      'enthält die zehn Wiederherstellungscodes — **einmalig**. Danach existieren sie nur ' +
      'noch als Hash; wer sie nicht notiert, braucht die Systemverantwortung.',
    guard: { kind: 'session' },
    rateLimit: 'login',
    body: auth.twoFactorConfirmSchema,
    extraErrors: [401, 422],
  },
  {
    method: 'post',
    path: '/api/auth/2fa/disable',
    tag: 'Authentifizierung',
    summary: 'Zweiten Faktor ausschalten',
    description:
      'Verlangt Passwort **und** einen gültigen Code — ein Wiederherstellungscode zählt ' +
      'ebenfalls. Nur das Passwort würde genügen, wenn jemand eine offene Sitzung ' +
      'übernimmt, und dann wäre der zweite Faktor genau in dem Moment weg, in dem er ' +
      'gebraucht wird.',
    guard: { kind: 'session' },
    rateLimit: 'login',
    body: auth.twoFactorDisableSchema,
    status: 204,
    extraErrors: [401, 422],
  },
  {
    method: 'post',
    path: '/api/auth/2fa/verify',
    tag: 'Authentifizierung',
    summary: 'Zweiter Schritt der Anmeldung',
    description:
      'Öffentlich, weil hier noch keine Sitzung besteht: Der Aufrufer weist sich über den ' +
      'kurzlebigen Zwischenschein aus, den `/api/auth/login` gesetzt hat. Dieser Endpunkt ' +
      'erzeugt das Zugangstoken. Sechs Ziffern sind eine Million Möglichkeiten — ohne das ' +
      'Anmelde-Limit wären sie in Minuten durchprobiert.',
    guard: { kind: 'public' },
    rateLimit: 'login',
    body: auth.twoFactorTokenSchema,
    extraErrors: [401],
  },
  {
    method: 'delete',
    path: '/api/users/{id}/2fa',
    tag: 'Benutzer & Rollen',
    summary: 'Zweiten Faktor eines Kontos zurücksetzen',
    description:
      'Der Notausgang, wenn jemand Telefon *und* Wiederherstellungscodes verloren hat. ' +
      'Nur die Systemverantwortung darf das — es ist die einzige Handlung, die einen ' +
      'Schutz von aussen entfernt. Alle Sitzungen der Person werden dabei beendet: Ist ' +
      'das Konto tatsächlich übernommen worden, endet der Zugriff in diesem Moment.',
    guard: perm('all', 'user:update', 'role:assign'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
    extraErrors: [422],
  },

  // -------------------------------------------------------------------------
  //  Öffentlich (Website)
  // -------------------------------------------------------------------------
  {
    method: 'post',
    path: '/api/public/pricing/estimate',
    tag: 'Öffentlich',
    summary: 'Preis berechnen',
    description:
      'Sofortpreis ohne Anmeldung. Die Berechnung läuft vollständig auf dem Server; die ' +
      'Antwort enthält die vollständige Herleitung, damit die Website jeden Posten benennen kann.',
    guard: { kind: 'public' },
    rateLimit: 'priceEstimate',
    body: booking.publicEstimateSchema,
  },
  {
    method: 'get',
    path: '/api/public/availability',
    tag: 'Öffentlich',
    summary: 'Freie Zeitfenster eines Tages',
    description:
      'Berücksichtigt Öffnungszeiten, Feiertage, bestehende Einsätze, Abwesenheiten und die ' +
      'benötigte Teamgrösse. Ein Fenster erscheint nur, wenn genügend Personal frei ist.',
    guard: { kind: 'public' },
    rateLimit: 'apiRead',
    query: q.availabilityCheckQuery,
  },
  {
    method: 'get',
    path: '/api/public/service-areas/check',
    tag: 'Öffentlich',
    summary: 'Postleitzahl im Einsatzgebiet?',
    description:
      'Antwortet mit Ort, Anfahrtspauschale und Fahrzeit — oder mit der Auskunft, dass wir ' +
      'dort (noch) nicht arbeiten.',
    guard: { kind: 'public' },
    rateLimit: 'apiRead',
    query: q.postalCodeQuery,
  },
  {
    method: 'post',
    path: '/api/public/bookings',
    tag: 'Öffentlich',
    summary: 'Termin buchen',
    description:
      'Erstellt Buchung, Einsatz und — falls nötig — Kundendatensatz in einer Transaktion. ' +
      'Der Preis wird serverseitig neu berechnet; ein mitgeschickter Betrag wird ignoriert.',
    guard: { kind: 'public' },
    rateLimit: 'bookingCreate',
    body: booking.createBookingSchema,
    status: 201,
  },
  {
    method: 'post',
    path: '/api/public/contact',
    tag: 'Öffentlich',
    summary: 'Kontakt- oder Offertanfrage',
    description:
      'Legt einen Lead an und benachrichtigt das Büro. Statt eines CAPTCHAs schützen ein ' +
      'Honeypot-Feld und ein striktes Rate-Limit — beides ohne Hürde für die Anfragenden.',
    guard: { kind: 'public' },
    rateLimit: 'contactForm',
    body: crm.contactFormSchema,
    status: 201,
  },
  {
    method: 'post',
    path: '/api/public/newsletter',
    tag: 'Öffentlich',
    summary: 'Newsletter abonnieren',
    description:
      'Double-Opt-in: die Anmeldung gilt erst mit Bestätigung des Links in der E-Mail. Die ' +
      'Einwilligung wird mit Zeitpunkt und IP protokolliert (DSGVO Art. 7 Abs. 1).',
    guard: { kind: 'public' },
    rateLimit: 'newsletter',
    body: crm.newsletterSchema,
    status: 201,
  },
  {
    method: 'post',
    path: '/api/public/applications',
    tag: 'Öffentlich',
    summary: 'Auf eine Stelle bewerben',
    description:
      'Der Lebenslauf wird vorab direkt zu Supabase Storage geladen; hier kommt nur seine ' +
      'Adresse an.',
    guard: { kind: 'public' },
    rateLimit: 'contactForm',
    body: content.publicApplicationSchema,
    status: 201,
  },
  {
    method: 'post',
    path: '/api/public/ai/chat',
    tag: 'Öffentlich',
    summary: 'Chat-Assistent',
    description:
      'Beantwortet Fragen zu Leistungen, Preisen und Gebiet. Die Antwort wird als Server-Sent-' +
      'Events gestreamt. Der Assistent nennt nur Preise aus dem Katalog und bucht nichts — ' +
      'gebucht wird über das Formular.',
    guard: { kind: 'public' },
    rateLimit: 'aiChat',
    body: ai.chatSchema,
    produces: 'text/event-stream',
  },
  {
    method: 'get',
    path: '/api/public/quotes/{token}/pdf',
    tag: 'Öffentlich',
    summary: 'Offerte als PDF',
    description: 'Zugriff über den Magic-Link-Token aus der Offerten-E-Mail, ohne Anmeldung.',
    guard: { kind: 'public' },
    extraErrors: [404],
    rateLimit: 'apiRead',
    params: q.publicTokenParams,
    produces: 'application/pdf',
  },
  {
    method: 'post',
    path: '/api/public/quotes/{token}/respond',
    tag: 'Öffentlich',
    summary: 'Offerte annehmen oder ablehnen',
    description:
      'Bei Annahme werden Unterschrift, Name, IP und Zeitpunkt festgehalten — das ist der ' +
      'Nachweis des Vertragsschlusses.',
    guard: { kind: 'public' },
    extraErrors: [404],
    rateLimit: 'apiWrite',
    params: q.publicTokenParams,
    body: operations.respondQuoteSchema,
  },
  {
    method: 'get',
    path: '/api/public/invoices/{token}/pdf',
    tag: 'Öffentlich',
    summary: 'Rechnung als PDF',
    description: 'Enthält den Schweizer QR-Einzahlungsschein nach SIX-Norm v2.3.',
    guard: { kind: 'public' },
    extraErrors: [404],
    rateLimit: 'apiRead',
    params: q.publicTokenParams,
    produces: 'application/pdf',
  },
  {
    method: 'post',
    path: '/api/public/invoices/{token}/pay',
    tag: 'Öffentlich',
    summary: 'Online-Zahlung starten',
    description:
      'Erstellt eine Stripe-Checkout-Session für Karte oder TWINT und liefert die Adresse zur ' +
      'Weiterleitung. Der Betrag stammt aus der Datenbank, nie vom Client. Gebucht wird der ' +
      'Eingang über den Webhook, nicht über die Rückkehr-URL.',
    extraErrors: [404, 422],
    guard: { kind: 'public' },
    rateLimit: 'apiWrite',
    params: q.publicTokenParams,
    body: finance.payInvoiceSchema,
  },
  {
    method: 'post',
    path: '/api/files/upload-url',
    tag: 'Dateien',
    summary: 'Signierte Upload-Adresse anfordern',
    description:
      'Dateien laufen nicht durch die Applikation, sondern direkt zu Supabase Storage. Das ' +
      'umgeht das 4.5-MB-Limit für Function-Bodies. Ohne Anmeldung sind nur die Profile ' +
      '`bookingPhoto` und `cv` erlaubt.',
    guard: { kind: 'public' },
    rateLimit: 'fileUpload',
    body: files.uploadUrlSchema,
    status: 201,
  },

  // -------------------------------------------------------------------------
  //  CRM
  // -------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/leads',
    tag: 'CRM',
    summary: 'Anfragen auflisten',
    description: 'Sortiert nach Bewertung und Eingang, mit Filter nach Status und Zuständigkeit.',
    guard: perm('all', 'lead:read'),
    rateLimit: 'apiRead',
    query: q.leadListQuery,
  },
  {
    method: 'post',
    path: '/api/leads',
    tag: 'CRM',
    summary: 'Anfrage erfassen',
    description:
      'Für Anrufe und Laufkundschaft. Anfragen über die Website laufen über ' +
      '`/api/public/contact` und durchlaufen dort Honeypot und strengeres Rate-Limiting.',
    guard: perm('all', 'lead:write'),
    rateLimit: 'apiWrite',
    body: crm.createLeadSchema,
    status: 201,
  },
  {
    method: 'patch',
    path: '/api/leads/{id}',
    tag: 'CRM',
    summary: 'Anfrage ändern',
    description: 'Status, Zuständigkeit, Pipeline-Stufe, Bewertung, Nachfassdatum, Etiketten.',
    guard: perm('all', 'lead:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: crm.updateLeadSchema,
  },
  {
    method: 'post',
    path: '/api/leads/{id}/convert',
    tag: 'CRM',
    summary: 'Anfrage in Kundschaft überführen',
    description:
      'Übernimmt Stammdaten und Verlauf und markiert den Lead als gewonnen. Bestehende ' +
      'Offerten werden mit übertragen.',
    guard: perm('all', 'customer:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 201,
  },
  {
    method: 'get',
    path: '/api/customers',
    tag: 'CRM',
    summary: 'Kundschaft auflisten',
    description: 'Volltextsuche über Nummer, Name, Firma, E-Mail und Telefon.',
    guard: perm('all', 'customer:read'),
    rateLimit: 'apiRead',
    query: q.customerListQuery,
  },
  {
    method: 'post',
    path: '/api/customers',
    tag: 'CRM',
    summary: 'Kundendatensatz anlegen',
    description:
      'Legt auf Wunsch gleich das Kundenkonto an und versendet die Einladung. Doppelte ' +
      'E-Mail-Adressen werden mit 409 abgewiesen.',
    guard: perm('all', 'customer:write'),
    rateLimit: 'apiWrite',
    body: crm.createCustomerSchema,
    status: 201,
  },
  {
    method: 'post',
    path: '/api/activities',
    tag: 'CRM',
    summary: 'Verlaufseintrag erfassen',
    description: 'Notiz, Telefonat, E-Mail, Termin oder SMS an Kundschaft, Lead oder Einsatz.',
    guard: perm('all', 'activity:write'),
    rateLimit: 'apiWrite',
    body: crm.createActivitySchema,
    status: 201,
  },
  {
    method: 'get',
    path: '/api/tasks',
    tag: 'CRM',
    summary: 'Offene Aufgaben',
    description:
      'Mitarbeitende sehen ausschliesslich die eigenen — die Einschränkung greift in der ' +
      'Abfrage, nicht im Frontend.',
    guard: perm('all', 'task:read'),
    rateLimit: 'apiRead',
    query: q.searchQuery,
  },
  {
    method: 'post',
    path: '/api/tasks',
    tag: 'CRM',
    summary: 'Aufgabe anlegen',
    description: 'Wer eine Aufgabe zugewiesen bekommt, wird sofort benachrichtigt.',
    guard: perm('all', 'task:write'),
    rateLimit: 'apiWrite',
    body: crm.createTaskSchema,
    status: 201,
  },
  {
    method: 'patch',
    path: '/api/tasks/{id}',
    tag: 'CRM',
    summary: 'Aufgabe ändern',
    description: 'Status, Fälligkeit, Zuständigkeit und Beschreibung.',
    guard: perm('all', 'task:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: crm.updateTaskSchema,
  },

  // -------------------------------------------------------------------------
  //  Nachrichten
  // -------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/messages',
    tag: 'Nachrichten',
    summary: 'Verläufe auflisten',
    description:
      'Kundschaft sieht nur die eigenen Verläufe, das Büro alle. Die Einschränkung ergibt ' +
      'sich aus der Rolle, nicht aus einem Query-Parameter.',
    guard: perm('any', 'message:read', 'message:read_own'),
    rateLimit: 'apiRead',
    query: q.threadListQuery,
  },
  {
    method: 'post',
    path: '/api/messages',
    tag: 'Nachrichten',
    summary: 'Verlauf eröffnen',
    description: 'Der Verlauf wird immer an einen Kundendatensatz gebunden.',
    guard: perm('any', 'message:write', 'message:write_own'),
    rateLimit: 'apiWrite',
    body: messaging.createThreadSchema,
    status: 201,
  },
  {
    method: 'get',
    path: '/api/messages/{id}',
    tag: 'Nachrichten',
    summary: 'Verlauf lesen',
    description:
      'Markiert beim Lesen die Nachrichten der Gegenseite als gelesen — nie die eigenen.',
    guard: perm('any', 'message:read', 'message:read_own'),
    rateLimit: 'apiRead',
    params: q.idParam,
  },
  {
    method: 'post',
    path: '/api/messages/{id}',
    tag: 'Nachrichten',
    summary: 'Antworten',
    description:
      'Ein abgeschlossener Verlauf nimmt keine Antworten mehr an. Nur Mitarbeitende dürfen ' +
      'mit `close` abschliessen.',
    guard: perm('any', 'message:write', 'message:write_own'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: messaging.replyMessageSchema,
    status: 201,
  },
  {
    method: 'get',
    path: '/api/notifications',
    tag: 'Nachrichten',
    summary: 'Eigene Benachrichtigungen',
    description: 'Die letzten 50 In-App-Meldungen, neueste zuerst.',
    guard: perm('all', 'notification:read_own'),
  },
  {
    method: 'get',
    path: '/api/notifications/count',
    tag: 'Nachrichten',
    summary: 'Anzahl ungelesener Meldungen',
    description: 'Speist die Glocke im Kopfbereich; bewusst schlank gehalten.',
    guard: perm('all', 'notification:read_own'),
  },
  {
    method: 'post',
    path: '/api/notifications/{id}/read',
    tag: 'Nachrichten',
    summary: 'Meldung als gelesen markieren',
    description: 'Wirkt nur auf eigene Meldungen.',
    guard: perm('all', 'notification:read_own'),
    params: q.idParam,
  },
  {
    method: 'post',
    path: '/api/notifications/read-all',
    tag: 'Nachrichten',
    summary: 'Alle Meldungen als gelesen markieren',
    description: 'Setzt den Zähler auf null.',
    guard: perm('all', 'notification:read_own'),
  },

  // -------------------------------------------------------------------------
  //  Buchungen
  // -------------------------------------------------------------------------
  {
    method: 'post',
    path: '/api/bookings/{id}/confirm',
    tag: 'Buchungen',
    summary: 'Buchung bestätigen',
    description:
      'Bestätigt den Termin, erzeugt den Einsatz und versendet die Bestätigung an die ' +
      'Kundschaft.',
    guard: perm('all', 'booking:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
  },
  {
    method: 'post',
    path: '/api/bookings/{id}/reschedule',
    tag: 'Buchungen',
    summary: 'Termin verschieben',
    description: 'Prüft die Verfügbarkeit erneut und verschiebt den zugehörigen Einsatz mit.',
    guard: perm('all', 'booking:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: booking.rescheduleBookingSchema,
  },
  {
    method: 'post',
    path: '/api/bookings/{id}/cancel',
    tag: 'Buchungen',
    summary: 'Buchung stornieren',
    description:
      'Storniert Buchung und Einsatz. Ab 24 Stunden vor Beginn fällt gemäss AGB eine ' +
      'Ausfallentschädigung an; der Endpunkt berechnet sie, verrechnet sie aber nicht selbst.',
    guard: perm('all', 'booking:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: booking.cancelBookingSchema,
  },
  {
    method: 'post',
    path: '/api/bookings/{id}/invoice',
    tag: 'Buchungen',
    summary: 'Rechnung zur Buchung erstellen',
    description: 'Übernimmt die Positionen der Buchung als Rechnungsentwurf.',
    guard: perm('all', 'invoice:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 201,
  },
  {
    method: 'post',
    path: '/api/account/bookings/{id}/reschedule',
    tag: 'Buchungen',
    summary: 'Eigenen Termin verschieben',
    description:
      'Für die Kundschaft. Bis 24 Stunden vor Beginn kostenlos; danach verweist die Antwort ' +
      'auf den telefonischen Weg.',
    guard: perm('all', 'booking:write_own'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: booking.rescheduleBookingSchema,
  },
  {
    method: 'post',
    path: '/api/account/bookings/{id}/cancel',
    tag: 'Buchungen',
    summary: 'Eigenen Termin absagen',
    description: 'Für die Kundschaft, mit denselben Fristen wie beim Verschieben.',
    guard: perm('all', 'booking:write_own'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: booking.cancelBookingSchema,
  },

  // -------------------------------------------------------------------------
  //  Offerten
  // -------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/quotes',
    tag: 'Offerten',
    summary: 'Offerten auflisten',
    description: 'Mit Suche über Nummer, Titel und Empfänger.',
    guard: perm('all', 'quote:read'),
    rateLimit: 'apiRead',
    query: q.searchQuery,
  },
  {
    method: 'post',
    path: '/api/quotes',
    tag: 'Offerten',
    summary: 'Offerte erstellen',
    description:
      'Die Summen werden serverseitig berechnet; optionale Positionen zählen nicht ins Total.',
    guard: perm('all', 'quote:write'),
    rateLimit: 'apiWrite',
    body: operations.createQuoteSchema,
    status: 201,
  },
  {
    method: 'get',
    path: '/api/quotes/{id}',
    tag: 'Offerten',
    summary: 'Offerte lesen',
    description: 'Mit Positionen, Empfänger, Objekt, Dateien und Verlauf.',
    guard: perm('all', 'quote:read'),
    rateLimit: 'apiRead',
    params: q.idParam,
  },
  {
    method: 'patch',
    path: '/api/quotes/{id}',
    tag: 'Offerten',
    summary: 'Offerte ändern',
    description:
      'Nur Entwürfe und versendete Offerten. Eine angenommene Offerte ist Vertragsgrundlage ' +
      'und wird nicht mehr verändert, sondern dupliziert.',
    guard: perm('all', 'quote:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: operations.updateQuoteSchema,
  },
  {
    method: 'post',
    path: '/api/quotes/{id}/send',
    tag: 'Offerten',
    summary: 'Offerte versenden',
    description:
      'Versendet die Offerte als PDF mit Magic Link zur Online-Annahme und setzt den Status ' +
      'auf SENT.',
    guard: perm('all', 'quote:send'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: operations.sendQuoteSchema,
  },
  {
    method: 'post',
    path: '/api/quotes/{id}/duplicate',
    tag: 'Offerten',
    summary: 'Offerte duplizieren',
    description:
      'Der übliche Weg, eine bereits beantwortete Offerte anzupassen: die alte bleibt als ' +
      'Beleg bestehen.',
    guard: perm('all', 'quote:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 201,
  },
  {
    method: 'post',
    path: '/api/quotes/{id}/convert',
    tag: 'Offerten',
    summary: 'Offerte in Buchung oder Rechnung überführen',
    description: 'Setzt den Status auf CONVERTED und verknüpft das Ergebnis mit der Offerte.',
    guard: perm('all', 'quote:convert'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: operations.convertQuoteSchema,
    status: 201,
  },
  {
    method: 'get',
    path: '/api/quotes/{id}/pdf',
    tag: 'Offerten',
    summary: 'Offerte als PDF',
    description: 'Kundschaft erhält nur die eigenen Offerten.',
    guard: perm('any', 'quote:read', 'quote:read_own'),
    rateLimit: 'apiRead',
    params: q.idParam,
    produces: 'application/pdf',
  },

  // -------------------------------------------------------------------------
  //  Einsätze
  // -------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/jobs/calendar',
    tag: 'Einsätze',
    summary: 'Einsätze im Zeitraum',
    description:
      'Speist Dispositions- und Mitarbeiterkalender. Mitarbeitende erhalten ausschliesslich ' +
      'die eigenen Einsätze.',
    guard: perm('any', 'job:read', 'job:read_assigned'),
    rateLimit: 'apiRead',
    query: q.calendarRangeQuery,
  },
  {
    method: 'get',
    path: '/api/jobs/{id}',
    tag: 'Einsätze',
    summary: 'Einsatz lesen',
    description: 'Mit Checkliste, Fotos, Zeiten, Material und Zuteilung.',
    guard: perm('any', 'job:read', 'job:read_assigned'),
    rateLimit: 'apiRead',
    params: q.idParam,
  },
  {
    method: 'patch',
    path: '/api/jobs/{id}',
    tag: 'Einsätze',
    summary: 'Einsatz ändern',
    description: 'Titel, Beschreibung, Notizen, Status und geplante Dauer.',
    guard: perm('all', 'job:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: operations.updateJobSchema,
  },
  {
    method: 'post',
    path: '/api/jobs/{id}/assign',
    tag: 'Einsätze',
    summary: 'Personal zuteilen',
    description:
      'Prüft Überschneidungen und Abwesenheiten und benachrichtigt die zugeteilten Personen.',
    guard: perm('all', 'job:assign'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: operations.assignJobSchema,
  },
  {
    method: 'post',
    path: '/api/jobs/{id}/move',
    tag: 'Einsätze',
    summary: 'Einsatz verschieben',
    description: 'Gegenstück zum Ziehen im Dispositionskalender.',
    guard: perm('all', 'job:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: operations.moveJobSchema,
  },
  {
    method: 'post',
    path: '/api/jobs/{id}/complete',
    tag: 'Einsätze',
    summary: 'Einsatz abschliessen',
    description:
      'Erfasst Abschlussbericht, Materialverbrauch und die Unterschrift der Kundschaft und ' +
      'stoppt laufende Zeiterfassungen.',
    guard: perm('any', 'job:complete_assigned', 'job:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: operations.completeJobSchema,
  },
  {
    method: 'post',
    path: '/api/jobs/{id}/photos',
    tag: 'Einsätze',
    summary: 'Foto verknüpfen',
    description:
      'Registriert ein bereits zu Supabase geladenes Bild als Vorher-, Nachher- oder ' +
      'Schadensfoto.',
    guard: perm('any', 'job:complete_assigned', 'job:write'),
    rateLimit: 'fileUpload',
    params: q.idParam,
    body: operations.jobPhotoSchema,
    status: 201,
  },
  {
    method: 'post',
    path: '/api/jobs/checklist/{id}',
    tag: 'Einsätze',
    summary: 'Checklistenpunkt abhaken',
    description: 'Hält fest, wer wann abgehakt hat.',
    guard: perm('any', 'job:complete_assigned', 'job:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: operations.checklistToggleSchema,
  },
  {
    method: 'get',
    path: '/api/jobs/{id}/report',
    tag: 'Einsätze',
    summary: 'Einsatzbericht als PDF',
    description: 'Mit Checkliste, Vorher-Nachher-Fotos und Unterschrift.',
    guard: perm('all', 'job:read'),
    rateLimit: 'apiRead',
    params: q.idParam,
    produces: 'application/pdf',
  },
  {
    method: 'post',
    path: '/api/jobs/{id}/report/draft',
    tag: 'Künstliche Intelligenz',
    summary: 'Berichtstext entwerfen',
    description:
      'Formuliert aus Checkliste, Zeiten und Notizen einen Berichtstext. Der Entwurf wird ' +
      'nicht gespeichert — er landet im Formular und wird vor dem Abschluss geprüft.',
    guard: perm('all', 'ai:use', 'job:write'),
    rateLimit: 'aiGenerate',
    params: q.idParam,
  },
  {
    method: 'post',
    path: '/api/time/clock-in',
    tag: 'Einsätze',
    summary: 'Einstempeln',
    description:
      'Erfasst Beginn und — sofern erlaubt — den Standort. Eine zweite laufende Erfassung ' +
      'wird abgewiesen.',
    guard: perm('all', 'timetracking:own'),
    rateLimit: 'apiWrite',
    body: operations.clockSchema,
    status: 201,
  },
  {
    method: 'post',
    path: '/api/time/clock-out',
    tag: 'Einsätze',
    summary: 'Ausstempeln',
    description: 'Schliesst die laufende Erfassung und rechnet die Dauer auf die Minute genau ab.',
    guard: perm('all', 'timetracking:own'),
    rateLimit: 'apiWrite',
    body: operations.clockSchema,
  },

  // -------------------------------------------------------------------------
  //  Personal
  // -------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/employees',
    tag: 'Personal',
    summary: 'Mitarbeitende auflisten',
    description:
      'Ohne Blätterung — Disposition und Zuteilung brauchen die vollständige Liste in einem Zug.',
    guard: perm('all', 'employee:read'),
    rateLimit: 'apiRead',
    query: q.employeeListQuery,
  },
  {
    method: 'post',
    path: '/api/employees',
    tag: 'Personal',
    summary: 'Mitarbeitende/n anlegen',
    description:
      'Legt zugleich das Portalkonto an und versendet die Einladung. Ausschliesslich für die ' +
      'Rolle ADMIN: mit dem Datensatz entstehen Lohnfelder, AHV-Nummer und IBAN.',
    guard: { kind: 'role', roles: ['ADMIN'] },
    rateLimit: 'apiWrite',
    body: operations.createEmployeeSchema,
    status: 201,
  },
  {
    method: 'post',
    path: '/api/absences',
    tag: 'Personal',
    summary: 'Abwesenheit beantragen',
    description:
      'Zählt Wochenenden und Feiertage nicht mit und prüft das Ferienguthaben, bevor der ' +
      'Antrag entsteht.',
    guard: perm('all', 'absence:request'),
    rateLimit: 'apiWrite',
    body: operations.absenceRequestSchema,
    status: 201,
  },
  {
    method: 'post',
    path: '/api/absences/{id}/decide',
    tag: 'Personal',
    summary: 'Abwesenheit bewilligen oder ablehnen',
    description: 'Bei Bewilligung wird die Person für den Zeitraum aus der Disposition genommen.',
    guard: perm('all', 'absence:approve'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: operations.absenceDecisionSchema,
  },
  {
    method: 'patch',
    path: '/api/applications/{id}',
    tag: 'Personal',
    summary: 'Bewerbung weiterbewegen',
    description:
      'Status, Bewertung und interne Notiz. Bewusst ohne automatische Absage-E-Mail — eine ' +
      'Absage schreibt man selbst.',
    guard: perm('all', 'career:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: content.updateApplicationSchema,
  },

  // -------------------------------------------------------------------------
  //  Finanzen
  // -------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/invoices',
    tag: 'Finanzen',
    summary: 'Rechnungen auflisten',
    description:
      'Die Summen für offen, überfällig und bezahlt reisen im Meta-Teil der Antwort mit.',
    guard: perm('all', 'invoice:read'),
    rateLimit: 'apiRead',
    query: q.invoiceListQuery,
  },
  {
    method: 'post',
    path: '/api/invoices',
    tag: 'Finanzen',
    summary: 'Rechnung erstellen',
    description:
      'Standardmässig als Entwurf. Erst das Ausstellen vergibt die Nummer — eine vergebene, ' +
      'nie benutzte Nummer reisst eine Lücke in die Folge (Art. 957a OR).',
    guard: perm('all', 'invoice:write'),
    rateLimit: 'apiWrite',
    body: finance.createInvoiceSchema,
    status: 201,
  },
  {
    method: 'post',
    path: '/api/invoices/{id}/issue',
    tag: 'Finanzen',
    summary: 'Rechnung ausstellen',
    description:
      'Vergibt die lückenlose Rechnungsnummer und die QR-Referenz innerhalb der Transaktion. ' +
      'Ab hier ist die Rechnung unveränderlich; Korrekturen laufen über eine Gutschrift.',
    guard: perm('all', 'invoice:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
  },
  {
    method: 'post',
    path: '/api/invoices/{id}/send',
    tag: 'Finanzen',
    summary: 'Rechnung versenden',
    description: 'Versendet das PDF mit QR-Einzahlungsschein und Zahllink.',
    guard: perm('all', 'invoice:send'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: finance.sendInvoiceEmailSchema,
  },
  {
    method: 'post',
    path: '/api/invoices/{id}/payments',
    tag: 'Finanzen',
    summary: 'Zahlungseingang erfassen',
    description:
      'Für Banküberweisungen und Bargeld. Aktualisiert Saldo und Status; eine Überzahlung ' +
      'wird abgewiesen statt still verbucht.',
    guard: perm('all', 'invoice:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: finance.recordPaymentSchema,
    status: 201,
  },
  {
    method: 'post',
    path: '/api/invoices/{id}/cancel',
    tag: 'Finanzen',
    summary: 'Rechnung stornieren',
    description:
      'Erzeugt eine Gutschrift über den vollen Betrag. Die Rechnung selbst wird nicht ' +
      'gelöscht — die Buchführung muss den Vorgang später erklären können.',
    guard: perm('all', 'invoice:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: finance.cancelInvoiceSchema,
    status: 201,
  },
  {
    method: 'get',
    path: '/api/invoices/{id}/pdf',
    tag: 'Finanzen',
    summary: 'Rechnung als PDF',
    description:
      'Mit Schweizer QR-Einzahlungsschein (SIX v2.3). Kundschaft erhält nur die eigenen.',
    guard: perm('any', 'invoice:read', 'invoice:read_own'),
    rateLimit: 'apiRead',
    params: q.idParam,
    produces: 'application/pdf',
  },
  {
    method: 'get',
    path: '/api/expenses',
    tag: 'Finanzen',
    summary: 'Ausgaben auflisten',
    description: 'Mit Kategorie, Lieferant und Belegdatei.',
    guard: perm('all', 'expense:read'),
    rateLimit: 'apiRead',
    query: q.searchQuery,
  },
  {
    method: 'post',
    path: '/api/expenses',
    tag: 'Finanzen',
    summary: 'Ausgabe erfassen',
    description: 'Eingegeben wird netto; MWST und Brutto rechnet der Server.',
    guard: perm('all', 'expense:write'),
    rateLimit: 'apiWrite',
    body: finance.createExpenseSchema,
    status: 201,
  },

  // -------------------------------------------------------------------------
  //  Exporte
  // -------------------------------------------------------------------------
  {
    method: 'post',
    path: '/api/exports/buchhaltung',
    tag: 'Exporte',
    summary: 'Buchhaltungsexport',
    description:
      'CSV im Format der gängigen Schweizer Treuhandsoftware, mit Sollkonto, Habenkonto und ' +
      'MWST-Code je Buchung.',
    guard: perm('all', 'accounting:export'),
    rateLimit: 'apiWrite',
    body: finance.accountingExportSchema,
    produces: 'text/csv',
  },
  {
    method: 'get',
    path: '/api/exports/rechnungen',
    tag: 'Exporte',
    summary: 'Rechnungen als Excel',
    description: 'Mit Summenzeile und formatierten Beträgen.',
    guard: perm('all', 'report:export'),
    rateLimit: 'apiRead',
    query: q.exportRangeQuery,
    produces: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  {
    method: 'get',
    path: '/api/exports/kunden',
    tag: 'Exporte',
    summary: 'Kundschaft als Excel',
    description: 'Stammdaten, Umsatz und Anzahl Aufträge je Datensatz.',
    guard: perm('all', 'report:export', 'customer:read'),
    rateLimit: 'apiRead',
    produces: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  {
    method: 'get',
    path: '/api/exports/zeiterfassung',
    tag: 'Exporte',
    summary: 'Zeiterfassung als Excel',
    description: 'Grundlage für die Lohnverarbeitung, je Person und Tag.',
    guard: perm('all', 'timetracking:read_all'),
    rateLimit: 'apiRead',
    query: q.exportRangeQuery,
    produces: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },

  // -------------------------------------------------------------------------
  //  Inhalte und Bewertungen
  // -------------------------------------------------------------------------
  {
    method: 'post',
    path: '/api/blog',
    tag: 'Inhalte',
    summary: 'Blogbeitrag anlegen',
    description: 'Erstellt einen Entwurf; der Slug wird aus dem Titel abgeleitet.',
    guard: perm('all', 'blog:write'),
    rateLimit: 'apiWrite',
    body: content.createBlogPostSchema,
    status: 201,
  },
  {
    method: 'get',
    path: '/api/reviews',
    tag: 'Inhalte',
    summary: 'Eigene Bewertungen',
    description: 'Für die Kundschaft — mit dem Moderationsstand und unserer Antwort.',
    guard: perm('any', 'review:write_own', 'review:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'post',
    path: '/api/reviews',
    tag: 'Inhalte',
    summary: 'Bewertung abgeben',
    description:
      'Nur zu abgeschlossenen eigenen Terminen und je Termin genau einmal. Jede Bewertung ' +
      'geht in die Moderation — veröffentlicht wird auch die schlechte, aber erst nachdem ' +
      'der Betrieb sie gesehen hat.',
    guard: perm('all', 'review:write_own'),
    rateLimit: 'apiWrite',
    body: crm.createReviewSchema,
    status: 201,
  },
  {
    method: 'patch',
    path: '/api/reviews/{id}',
    tag: 'Inhalte',
    summary: 'Bewertung moderieren',
    description:
      'Veröffentlichen, ablehnen, hervorheben, öffentlich antworten. Leert den Bewertungs-' +
      'Cache, damit die Website nicht bis zu 30 Minuten den alten Schnitt zeigt.',
    guard: perm('all', 'review:moderate'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: content.moderateReviewSchema,
  },
  {
    method: 'post',
    path: '/api/reviews/{id}/reply-draft',
    tag: 'Künstliche Intelligenz',
    summary: 'Antwort auf Bewertung entwerfen',
    description:
      'Formuliert einen Antwortvorschlag im Ton des Betriebs. Veröffentlicht wird er erst ' +
      'nach Freigabe über die Moderation.',
    guard: perm('all', 'ai:use', 'review:moderate'),
    rateLimit: 'aiGenerate',
    params: q.idParam,
  },

  // -------------------------------------------------------------------------
  //  Künstliche Intelligenz
  // -------------------------------------------------------------------------
  {
    method: 'post',
    path: '/api/ai/quote-draft',
    tag: 'Künstliche Intelligenz',
    summary: 'Offertentwurf aus einer Anfrage',
    description:
      'Der Stundenansatz kommt aus dem Leistungskatalog, nicht aus dem Modell: es verteilt ' +
      'den Aufwand auf Positionen, es erfindet keine Tarife.',
    guard: perm('all', 'ai:use', 'quote:write'),
    rateLimit: 'aiGenerate',
    body: ai.quoteDraftSchema,
  },
  {
    method: 'post',
    path: '/api/ai/email',
    tag: 'Künstliche Intelligenz',
    summary: 'E-Mail entwerfen',
    description: 'Der Endpunkt versendet bewusst nichts — der Entwurf geht ins Formular.',
    guard: perm('all', 'ai:use'),
    rateLimit: 'aiGenerate',
    body: ai.emailDraftSchema,
  },
  {
    method: 'post',
    path: '/api/ai/summarize',
    tag: 'Künstliche Intelligenz',
    summary: 'Text zusammenfassen',
    description: 'Für lange Kundenverläufe und Berichte.',
    guard: perm('all', 'ai:use'),
    rateLimit: 'aiGenerate',
    body: ai.summarizeSchema,
  },
  {
    method: 'post',
    path: '/api/ai/translate',
    tag: 'Künstliche Intelligenz',
    summary: 'Text übersetzen',
    description:
      'Deutsch, Französisch, Italienisch, Englisch — die vier Sprachen der Schweizer Kundschaft.',
    guard: perm('all', 'ai:use'),
    rateLimit: 'aiGenerate',
    body: ai.translateSchema,
  },
  {
    method: 'post',
    path: '/api/ai/blog-draft',
    tag: 'Künstliche Intelligenz',
    summary: 'Blogbeitrag entwerfen',
    description: 'Liefert Titel, Anriss, Fliesstext und SEO-Angaben als Entwurf.',
    guard: perm('all', 'ai:use', 'blog:write'),
    rateLimit: 'aiGenerate',
    body: ai.blogDraftSchema,
  },
  {
    method: 'post',
    path: '/api/ai/dispatch',
    tag: 'Künstliche Intelligenz',
    summary: 'Tourenvorschlag für einen Tag',
    description:
      'Schlägt eine Zuteilung vor, die Fahrwege verkürzt. Der Vorschlag wird nicht ' +
      'ausgeführt — die Disposition entscheidet.',
    guard: perm('all', 'ai:use', 'job:dispatch'),
    rateLimit: 'aiGenerate',
    body: ai.dispatchSuggestSchema,
  },

  // -------------------------------------------------------------------------
  //  Redaktion
  // -------------------------------------------------------------------------
  {
    method: 'patch',
    path: '/api/content',
    tag: 'Inhalte',
    summary: 'Website-Texte pflegen',
    description:
      'Sammelübergabe aller Änderungen eines Formulars — die Redaktion ändert selten ein ' +
      'einzelnes Feld. Ein geleertes Feld löscht die Zeile; die Website zeigt dann wieder den ' +
      'Auslieferungstext aus dem Register. Leert anschliessend Inhalts- und Seitencache, damit ' +
      'die Änderung sofort sichtbar wird.',
    guard: perm('all', 'content:write'),
    rateLimit: 'apiWrite',
    body: cms.updateContentSchema,
  },
  {
    method: 'patch',
    path: '/api/seo',
    tag: 'Inhalte',
    summary: 'Suchmaschinenangaben pflegen',
    description:
      'Titel, Beschreibung, Schlüsselwörter und Vorschaubild einer Seite. Leere Felder setzen ' +
      'auf den Registerwert zurück. `noIndex` nimmt die Seite aus dem Index und wird im ' +
      'Prüfprotokoll gesondert vermerkt.',
    guard: perm('all', 'seo:write'),
    rateLimit: 'apiWrite',
    body: cms.updateSeoSchema,
  },

  // -------------------------------------------------------------------------
  //  Leistungskatalog und Preise
  // -------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/services',
    tag: 'Katalog',
    summary: 'Leistungen auflisten',
    description:
      'Vollständiger Katalog, auch inaktive Einträge. Bewusst ohne Blätterung: der Katalog ' +
      'umfasst eine zweistellige Zahl von Einträgen, und die Verwaltung sortiert sie um — ' +
      'blättern hiesse, über Seitengrenzen zu sortieren.',
    guard: perm('all', 'service:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'post',
    path: '/api/services',
    tag: 'Katalog',
    summary: 'Leistung anlegen',
    description:
      'Der Kurzname wird zur öffentlichen Adresse `/leistungen/{slug}` und muss eindeutig sein. ' +
      'Das Preismodell bestimmt, welcher Ansatz verlangt wird: PER_HOUR braucht `hourlyRate`, ' +
      'PER_SQM braucht `pricePerSqm`, FLAT braucht `basePrice`.',
    guard: perm('all', 'service:write'),
    rateLimit: 'apiWrite',
    body: catalog.createServiceSchema,
    status: 201,
  },
  {
    method: 'get',
    path: '/api/services/{id}',
    tag: 'Katalog',
    summary: 'Leistung abrufen',
    description: 'Eine Leistung samt zugehörigen Preisregeln und Zusatzzuordnung.',
    guard: perm('all', 'service:read'),
    rateLimit: 'apiRead',
    params: q.idParam,
  },
  {
    method: 'patch',
    path: '/api/services/{id}',
    tag: 'Katalog',
    summary: 'Leistung ändern',
    description:
      'Teil-Update. Querbedingungen werden gegen den gespeicherten Stand geprüft: ein Wechsel ' +
      'des Preismodells ohne passenden Ansatz wird mit 422 abgelehnt, weil die Preis-Engine ' +
      'sonst still mit 0 rechnen würde. Bestehende Buchungen und Rechnungen bleiben unberührt — ' +
      'sie tragen Preis und Steuersatz als eigene Werte.',
    guard: perm('all', 'service:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: catalog.updateServiceSchema,
    extraErrors: [422],
  },
  {
    method: 'delete',
    path: '/api/services/{id}',
    tag: 'Katalog',
    summary: 'Leistung löschen',
    description:
      'Nur möglich, solange die Leistung in keiner Buchung, Offerte oder keinem Einsatz ' +
      'vorkommt. Andernfalls 422 mit der Zahl der Vorgänge und dem Hinweis, sie stattdessen ' +
      'auf inaktiv zu setzen.',
    guard: perm('all', 'service:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
    extraErrors: [422],
  },
  {
    method: 'get',
    path: '/api/service-categories',
    tag: 'Katalog',
    summary: 'Kategorien auflisten',
    description: 'Gruppen, nach denen die Leistungen auf der Website sortiert erscheinen.',
    guard: perm('all', 'service:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'post',
    path: '/api/service-categories',
    tag: 'Katalog',
    summary: 'Kategorie anlegen',
    description: 'Der Kurzname muss innerhalb der Organisation eindeutig sein.',
    guard: perm('all', 'service:write'),
    rateLimit: 'apiWrite',
    body: catalog.createCategorySchema,
    status: 201,
  },
  {
    method: 'patch',
    path: '/api/service-categories/{id}',
    tag: 'Katalog',
    summary: 'Kategorie ändern',
    description: 'Teil-Update der Gruppenangaben.',
    guard: perm('all', 'service:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: catalog.updateCategorySchema,
  },
  {
    method: 'delete',
    path: '/api/service-categories/{id}',
    tag: 'Katalog',
    summary: 'Kategorie löschen',
    description:
      'Die Leistungen darin bleiben bestehen und stehen anschliessend ohne Kategorie da. Die ' +
      'Antwort nennt unter `unassigned`, wie viele das betrifft.',
    guard: perm('all', 'service:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
  },
  {
    method: 'get',
    path: '/api/service-extras',
    tag: 'Katalog',
    summary: 'Zusatzleistungen auflisten',
    description: 'Buchbare Optionen samt der Leistungen, bei denen sie angeboten werden.',
    guard: perm('all', 'service:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'post',
    path: '/api/service-extras',
    tag: 'Katalog',
    summary: 'Zusatzleistung anlegen',
    description:
      'Eine leere `serviceIds`-Liste bedeutet: bei allen Leistungen anbieten. Fremde IDs ' +
      'werden verworfen.',
    guard: perm('all', 'service:write'),
    rateLimit: 'apiWrite',
    body: catalog.createExtraSchema,
    status: 201,
  },
  {
    method: 'patch',
    path: '/api/service-extras/{id}',
    tag: 'Katalog',
    summary: 'Zusatzleistung ändern',
    description:
      '`serviceIds` ist der gewünschte Endzustand der Zuordnung, kein Zuwachs. Fehlt das Feld, ' +
      'bleibt die Zuordnung unangetastet.',
    guard: perm('all', 'service:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: catalog.updateExtraSchema,
  },
  {
    method: 'delete',
    path: '/api/service-extras/{id}',
    tag: 'Katalog',
    summary: 'Zusatzleistung löschen',
    description: 'Nur möglich, solange keine Buchung sie enthält; andernfalls 422.',
    guard: perm('all', 'service:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
    extraErrors: [422],
  },
  {
    method: 'get',
    path: '/api/price-rules',
    tag: 'Katalog',
    summary: 'Preisregeln auflisten',
    description:
      'Aufsteigend nach `priority` — dieselbe Reihenfolge, in der die Preis-Engine sie anwendet.',
    guard: perm('all', 'service:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'post',
    path: '/api/price-rules',
    tag: 'Katalog',
    summary: 'Preisregel anlegen',
    description:
      'Die Bedingung ist streng validiert: ein unbekannter Schlüssel wird abgelehnt, statt ' +
      'stillschweigend zu einer leeren Bedingung zu werden — die auf jeden Auftrag passt. Eine ' +
      'Regel ohne Wirkung (Faktor 1 und Betrag 0) wird ebenfalls abgelehnt.',
    guard: perm('all', 'service:write'),
    rateLimit: 'apiWrite',
    body: catalog.createPriceRuleSchema,
    status: 201,
  },
  {
    method: 'patch',
    path: '/api/price-rules/{id}',
    tag: 'Katalog',
    summary: 'Preisregel ändern',
    description: 'Teil-Update. Die Bedingung wird als Ganzes ersetzt, nicht zusammengeführt.',
    guard: perm('all', 'service:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: catalog.updatePriceRuleSchema,
  },
  {
    method: 'delete',
    path: '/api/price-rules/{id}',
    tag: 'Katalog',
    summary: 'Preisregel löschen',
    description:
      'Ohne Rückfrage möglich: bestehende Belege führen den Zuschlag als eigene Position mit ' +
      'eigenem Betrag und verlieren nichts.',
    guard: perm('all', 'service:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
  },
  {
    method: 'post',
    path: '/api/catalog/reorder',
    tag: 'Katalog',
    summary: 'Reihenfolge setzen',
    description:
      'Übergeben wird die vollständige Reihenfolge als Liste von IDs; die Positionen vergibt ' +
      'der Server aus dem Index. So kann kein Zustand entstehen, in dem zwei Einträge dieselbe ' +
      'Position tragen. Alles läuft in einer Transaktion.',
    guard: perm('all', 'service:write'),
    rateLimit: 'apiWrite',
    body: catalog.reorderSchema,
  },
  {
    method: 'get',
    path: '/api/tax-rates',
    tag: 'Katalog',
    summary: 'Steuersätze auflisten',
    description: 'Hinterlegte Mehrwertsteuersätze, absteigend nach Satz.',
    guard: perm('all', 'service:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'post',
    path: '/api/tax-rates',
    tag: 'Katalog',
    summary: 'Steuersatz anlegen',
    description:
      'Wird der neue Satz als Standard markiert, verliert der bisherige diese Markierung in ' +
      'derselben Transaktion — zwei Standardsätze wären ein Zustand, in dem die Sortierung ' +
      'entscheidet.',
    guard: perm('all', 'settings:write'),
    rateLimit: 'apiWrite',
    body: catalog.createTaxRateSchema,
    status: 201,
  },
  {
    method: 'patch',
    path: '/api/tax-rates/{id}',
    tag: 'Katalog',
    summary: 'Steuersatz ändern',
    description: 'Teil-Update.',
    guard: perm('all', 'settings:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: catalog.updateTaxRateSchema,
  },
  {
    method: 'delete',
    path: '/api/tax-rates/{id}',
    tag: 'Katalog',
    summary: 'Steuersatz löschen',
    description:
      'Der Standardsatz ist geschützt: bestimmen Sie zuerst einen anderen als Standard. ' +
      'Bestehende Rechnungen behalten ihren Satz — er steht als eigene Spalte auf jeder Position.',
    guard: perm('all', 'settings:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
    extraErrors: [422],
  },
  {
    method: 'get',
    path: '/api/coupons',
    tag: 'Katalog',
    summary: 'Gutscheine auflisten',
    description: 'Codes samt Einlösestand.',
    guard: perm('all', 'coupon:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'post',
    path: '/api/coupons',
    tag: 'Katalog',
    summary: 'Gutschein ausgeben',
    description: 'Der Code wird in Grossbuchstaben normalisiert und muss eindeutig sein.',
    guard: perm('all', 'coupon:write'),
    rateLimit: 'apiWrite',
    body: catalog.createCouponSchema,
    status: 201,
  },
  {
    method: 'patch',
    path: '/api/coupons/{id}',
    tag: 'Katalog',
    summary: 'Gutschein ändern',
    description:
      'Der Einlösezähler lässt sich nicht setzen: er hält eine Tatsache fest, keine Absicht. ' +
      'Wäre er beschreibbar, liesse sich jedes Nutzungslimit beliebig oft aufheben.',
    guard: perm('all', 'coupon:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: catalog.updateCouponSchema,
  },
  {
    method: 'delete',
    path: '/api/coupons/{id}',
    tag: 'Katalog',
    summary: 'Gutschein löschen',
    description:
      'Nur möglich, solange der Code nie eingelöst wurde; andernfalls 422 mit dem Hinweis, ihn ' +
      'auf „pausiert" zu setzen.',
    guard: perm('all', 'coupon:write'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
    extraErrors: [422],
  },

  // -------------------------------------------------------------------------
  //  Papierkorb
  // -------------------------------------------------------------------------
  {
    method: 'delete',
    path: '/api/customers/{id}',
    tag: 'CRM',
    summary: 'Kundschaft in den Papierkorb legen',
    description:
      'Offene Rechnungen und geplante Termine verhindern das Löschen — die Antwort nennt die Zahl. Weich gelöscht: der Datensatz verschwindet aus allen Listen, bleibt aber ' +
      'wiederherstellbar. Verknüpfte Datensätze werden nicht mitgelöscht.',
    guard: perm('all', 'customer:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
    extraErrors: [422],
  },
  {
    method: 'post',
    path: '/api/customers/{id}/restore',
    tag: 'CRM',
    summary: 'Kundschaft wiederherstellen',
    description: 'Holt den Datensatz aus dem Papierkorb zurück.',
    guard: perm('all', 'customer:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    extraErrors: [422],
  },
  {
    method: 'delete',
    path: '/api/leads/{id}',
    tag: 'CRM',
    summary: 'Anfrage in den Papierkorb legen',
    description:
      'Eine in eine Kundschaft überführte Anfrage bleibt als Herkunftsnachweis erhalten. Weich gelöscht: der Datensatz verschwindet aus allen Listen, bleibt aber ' +
      'wiederherstellbar. Verknüpfte Datensätze werden nicht mitgelöscht.',
    guard: perm('all', 'lead:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
    extraErrors: [422],
  },
  {
    method: 'post',
    path: '/api/leads/{id}/restore',
    tag: 'CRM',
    summary: 'Anfrage wiederherstellen',
    description: 'Holt den Datensatz aus dem Papierkorb zurück.',
    guard: perm('all', 'lead:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    extraErrors: [422],
  },
  {
    method: 'delete',
    path: '/api/bookings/{id}',
    tag: 'Buchungen',
    summary: 'Buchung in den Papierkorb legen',
    description:
      'Eine bereits verrechnete Buchung bleibt erhalten. Weich gelöscht: der Datensatz verschwindet aus allen Listen, bleibt aber ' +
      'wiederherstellbar. Verknüpfte Datensätze werden nicht mitgelöscht.',
    guard: perm('all', 'booking:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
    extraErrors: [422],
  },
  {
    method: 'post',
    path: '/api/bookings/{id}/restore',
    tag: 'Buchungen',
    summary: 'Buchung wiederherstellen',
    description: 'Holt den Datensatz aus dem Papierkorb zurück.',
    guard: perm('all', 'booking:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    extraErrors: [422],
  },
  {
    method: 'delete',
    path: '/api/quotes/{id}',
    tag: 'Offerten',
    summary: 'Offerte in den Papierkorb legen',
    description:
      'Eine angenommene Offerte ist eine vertragliche Zusage und bleibt erhalten. Weich gelöscht: der Datensatz verschwindet aus allen Listen, bleibt aber ' +
      'wiederherstellbar. Verknüpfte Datensätze werden nicht mitgelöscht.',
    guard: perm('all', 'quote:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
    extraErrors: [422],
  },
  {
    method: 'post',
    path: '/api/quotes/{id}/restore',
    tag: 'Offerten',
    summary: 'Offerte wiederherstellen',
    description: 'Holt den Datensatz aus dem Papierkorb zurück.',
    guard: perm('all', 'quote:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    extraErrors: [422],
  },
  {
    method: 'delete',
    path: '/api/invoices/{id}',
    tag: 'Finanzen',
    summary: 'Rechnung in den Papierkorb legen',
    description:
      'Nur Entwürfe. Ausgestellte Rechnungen bleiben unantastbar: nach Art. 957a OR muss die Nummerierung lückenlos sein. Weich gelöscht: der Datensatz verschwindet aus allen Listen, bleibt aber ' +
      'wiederherstellbar. Verknüpfte Datensätze werden nicht mitgelöscht.',
    guard: perm('all', 'invoice:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
    extraErrors: [422],
  },
  {
    method: 'post',
    path: '/api/invoices/{id}/restore',
    tag: 'Finanzen',
    summary: 'Rechnung wiederherstellen',
    description: 'Holt den Datensatz aus dem Papierkorb zurück.',
    guard: perm('all', 'invoice:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    extraErrors: [422],
  },
  {
    method: 'delete',
    path: '/api/jobs/{id}',
    tag: 'Einsätze',
    summary: 'Einsatz in den Papierkorb legen',
    description:
      'Abgeschlossene Einsätze und solche mit gestempelter Zeit bleiben erhalten. Weich gelöscht: der Datensatz verschwindet aus allen Listen, bleibt aber ' +
      'wiederherstellbar. Verknüpfte Datensätze werden nicht mitgelöscht.',
    guard: perm('all', 'job:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
    extraErrors: [422],
  },
  {
    method: 'post',
    path: '/api/jobs/{id}/restore',
    tag: 'Einsätze',
    summary: 'Einsatz wiederherstellen',
    description: 'Holt den Datensatz aus dem Papierkorb zurück.',
    guard: perm('all', 'job:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    extraErrors: [422],
  },
  {
    method: 'delete',
    path: '/api/properties/{id}',
    tag: 'CRM',
    summary: 'Objekt in den Papierkorb legen',
    description:
      'Objekte mit geplanten Einsätzen bleiben erhalten. Weich gelöscht: der Datensatz verschwindet aus allen Listen, bleibt aber ' +
      'wiederherstellbar. Verknüpfte Datensätze werden nicht mitgelöscht.',
    guard: perm('all', 'property:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
    extraErrors: [422],
  },
  {
    method: 'post',
    path: '/api/properties/{id}/restore',
    tag: 'CRM',
    summary: 'Objekt wiederherstellen',
    description: 'Holt den Datensatz aus dem Papierkorb zurück.',
    guard: perm('all', 'property:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    extraErrors: [422],
  },

  // -------------------------------------------------------------------------
  //  Handlungsaufrufe
  // -------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/cta',
    tag: 'Website',
    summary: 'Handlungsaufrufe auflisten',
    description:
      'Alle Aufrufe, auch abgeschaltete. `?papierkorb=1` zeigt zusätzlich die gelöschten.',
    guard: perm('all', 'cta:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'post',
    path: '/api/cta',
    tag: 'Website',
    summary: 'Handlungsaufruf anlegen',
    description:
      'Das Ziel wird gegen eine Positivliste geprüft: interner Pfad, https, tel oder mailto. ' +
      'Ein freies Adressfeld wäre der direkte Weg zu einem javascript:-Ziel auf der ' +
      'öffentlichen Website.',
    guard: perm('all', 'cta:create'),
    rateLimit: 'apiWrite',
    body: cta.createCtaSchema,
    status: 201,
  },
  {
    method: 'get',
    path: '/api/cta/{id}',
    tag: 'Website',
    summary: 'Handlungsaufruf abrufen',
    description: 'Ein einzelner Aufruf mit allen Feldern.',
    guard: perm('all', 'cta:read'),
    rateLimit: 'apiRead',
    params: q.idParam,
  },
  {
    method: 'patch',
    path: '/api/cta/{id}',
    tag: 'Website',
    summary: 'Handlungsaufruf ändern',
    description: 'Teil-Update von Text, Farbe, Symbol, Ziel, Platz, Seiten und Laufzeit.',
    guard: perm('all', 'cta:update'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: cta.updateCtaSchema,
    extraErrors: [422],
  },
  {
    method: 'delete',
    path: '/api/cta/{id}',
    tag: 'Website',
    summary: 'Handlungsaufruf löschen',
    description:
      'Standard ist der Papierkorb. `?endgueltig=1` entfernt ihn wirklich, aber nur wenn er ' +
      'bereits im Papierkorb liegt.',
    guard: perm('all', 'cta:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
    extraErrors: [422],
  },
  {
    method: 'post',
    path: '/api/cta/{id}/publish',
    tag: 'Website',
    summary: 'Handlungsaufruf ein- oder ausschalten',
    description:
      'Eigene Berechtigung, weil dies die einzige Handlung ist, die etwas auf der öffentlichen ' +
      'Website erscheinen lässt. Wer Texte vorbereiten darf, muss nicht veröffentlichen dürfen.',
    guard: perm('all', 'cta:publish'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    extraErrors: [422],
  },
  {
    method: 'post',
    path: '/api/cta/{id}/restore',
    tag: 'Website',
    summary: 'Handlungsaufruf wiederherstellen',
    description: 'Kommt bewusst abgeschaltet zurück — erst ansehen, dann veröffentlichen.',
    guard: perm('all', 'cta:update'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    extraErrors: [422],
  },
  {
    method: 'post',
    path: '/api/cta/reorder',
    tag: 'Website',
    summary: 'Reihenfolge der Handlungsaufrufe setzen',
    description:
      'Übergeben wird die Reihenfolge als Liste von IDs; die Positionen vergibt der Server aus ' +
      'dem Index.',
    guard: perm('all', 'cta:update'),
    rateLimit: 'apiWrite',
    body: cta.ctaReorderSchema,
  },

  // -------------------------------------------------------------------------
  //  Mediathek
  // -------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/media',
    tag: 'Website',
    summary: 'Mediathek durchsuchen',
    description: 'Alle hochgeladenen Dateien mit Blätterung, Filter nach Bereich und Dateityp.',
    guard: perm('all', 'media:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'post',
    path: '/api/media',
    tag: 'Website',
    summary: 'Hochgeladene Datei registrieren',
    description:
      'Der Upload selbst läuft direkt zu Supabase (/api/files/upload-url). Dieser Endpunkt hält ' +
      'nur fest, was dort gelandet ist — sonst gäbe es Dateien, die in keiner Liste erscheinen.',
    guard: perm('all', 'media:upload'),
    rateLimit: 'apiWrite',
    status: 201,
  },
  {
    method: 'patch',
    path: '/api/media/{id}',
    tag: 'Website',
    summary: 'Datei umbenennen oder zuordnen',
    description: 'Ändert Anzeigename und Bereich. Die Adresse der Datei bleibt bestehen.',
    guard: perm('all', 'media:update'),
    rateLimit: 'apiWrite',
    params: q.idParam,
  },
  {
    method: 'delete',
    path: '/api/media/{id}',
    tag: 'Website',
    summary: 'Datei endgültig löschen',
    description:
      'Kein Papierkorb — die Datei liegt im Objektspeicher und kostet dort Geld. Hängt sie an ' +
      'einem Beleg, antwortet der Endpunkt mit 422 und nennt woran; `?trotzdem=1` setzt sich ' +
      'darüber hinweg.',
    guard: perm('all', 'media:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
    extraErrors: [422],
  },

  // -------------------------------------------------------------------------
  //  Benutzerkonten
  // -------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/users',
    tag: 'System',
    summary: 'Benutzerkonten auflisten',
    description: 'Filter nach Rolle, Status und Suchbegriff. `?papierkorb=1` zeigt gelöschte mit.',
    guard: perm('all', 'user:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'post',
    path: '/api/users',
    tag: 'System',
    summary: 'Person einladen',
    description:
      'Kein Passwortfeld: die Person vergibt es selbst über einen einmaligen Link. Die Rolle ' +
      'wird zusätzlich gegen die eigene Stufe geprüft — sonst könnte jemand mit user:create, ' +
      'aber ohne role:assign, über den Umweg einer Einladung eine Systemverantwortung erzeugen.',
    guard: perm('all', 'user:create'),
    rateLimit: 'apiWrite',
    body: users.inviteUserSchema,
    status: 201,
    extraErrors: [409],
  },
  {
    method: 'patch',
    path: '/api/users/{id}',
    tag: 'System',
    summary: 'Konto ändern',
    description:
      'Stammdaten, Sprache und Sperrung. Eine Sperre beendet alle laufenden Sitzungen sofort. ' +
      'Die Rolle lässt sich hier nicht ändern.',
    guard: perm('all', 'user:update'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: users.updateUserSchema,
    extraErrors: [409, 422],
  },
  {
    method: 'patch',
    path: '/api/users/{id}/role',
    tag: 'System',
    summary: 'Rolle zuweisen',
    description:
      'Drei Sperren: nur bis zur eigenen Stufe, nicht die eigene Rolle, und nie die letzte ' +
      'aktive Systemverantwortung. Alle Sitzungen des Kontos werden beendet, weil die Rolle im ' +
      'Zugangstoken steckt.',
    guard: perm('all', 'role:assign'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: users.assignRoleSchema,
    extraErrors: [422],
  },
  {
    method: 'delete',
    path: '/api/users/{id}',
    tag: 'System',
    summary: 'Konto in den Papierkorb legen',
    description:
      'Weich: ein Konto hängt an Aktivitäten, Nachrichten, Bewertungen und Protokolleinträgen. ' +
      'Ein hartes Löschen risse dort überall Lücken.',
    guard: perm('all', 'user:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
    extraErrors: [422],
  },
  {
    method: 'post',
    path: '/api/users/{id}/restore',
    tag: 'System',
    summary: 'Konto wiederherstellen',
    description: 'Kommt gesperrt zurück — der Zugang wird bewusst in einem zweiten Schritt frei.',
    guard: perm('all', 'user:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    extraErrors: [422],
  },

  // -------------------------------------------------------------------------
  //  Website: Fragen, Galerie, Stellen
  // -------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/faq',
    tag: 'Website',
    summary: 'Häufige Fragen auflisten',
    description: 'Alle Fragen, auch abgeschaltete, gruppiert nach Kategorie.',
    guard: perm('all', 'faq:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'post',
    path: '/api/faq',
    tag: 'Website',
    summary: 'Frage anlegen',
    description: 'Erscheint nach dem Speichern auf /faq und auf der Startseite.',
    guard: perm('all', 'faq:create'),
    rateLimit: 'apiWrite',
    body: website.createFaqSchema,
    status: 201,
  },
  {
    method: 'patch',
    path: '/api/faq/{id}',
    tag: 'Website',
    summary: 'Frage ändern',
    description: 'Teil-Update von Frage, Antwort, Kategorie und Sichtbarkeit.',
    guard: perm('all', 'faq:update'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: website.updateFaqSchema,
  },
  {
    method: 'delete',
    path: '/api/faq/{id}',
    tag: 'Website',
    summary: 'Frage löschen',
    description: 'Endgültig — eine Frage ist schnell neu erfasst.',
    guard: perm('all', 'faq:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
  },
  {
    method: 'get',
    path: '/api/gallery',
    tag: 'Website',
    summary: 'Galerie auflisten',
    description: 'Alle Vorher-/Nachher-Einträge, auch unveröffentlichte.',
    guard: perm('all', 'gallery:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'post',
    path: '/api/gallery',
    tag: 'Website',
    summary: 'Galerieeintrag anlegen',
    description:
      'Vorher und Nachher müssen verschiedene Bilder sein — sonst zeigt der Schieberegler auf ' +
      'der Startseite nichts. Beide Adressen müssen über https ausgeliefert werden.',
    guard: perm('all', 'gallery:create'),
    rateLimit: 'apiWrite',
    body: website.createGalleryItemSchema,
    status: 201,
  },
  {
    method: 'patch',
    path: '/api/gallery/{id}',
    tag: 'Website',
    summary: 'Galerieeintrag ändern',
    description:
      'Teil-Update. Die Bildgleichheit wird gegen den gespeicherten Stand geprüft, damit sich ' +
      'nicht ein Bild auf das andere setzen lässt.',
    guard: perm('all', 'gallery:update'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: website.updateGalleryItemSchema,
    extraErrors: [422],
  },
  {
    method: 'delete',
    path: '/api/gallery/{id}',
    tag: 'Website',
    summary: 'Galerieeintrag löschen',
    description: 'Endgültig. Die Bilddateien liegen in der Mediathek und bleiben bestehen.',
    guard: perm('all', 'gallery:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
  },
  {
    method: 'post',
    path: '/api/website/reorder',
    tag: 'Website',
    summary: 'Reihenfolge von Fragen oder Galeriebildern setzen',
    description:
      'Übergeben wird die Reihenfolge als Liste von IDs; die Positionen vergibt der Server aus ' +
      'dem Index.',
    guard: perm('any', 'faq:update', 'gallery:update'),
    rateLimit: 'apiWrite',
    body: website.websiteReorderSchema,
  },
  {
    method: 'get',
    path: '/api/job-postings',
    tag: 'Personal',
    summary: 'Stellenangebote auflisten',
    description: 'Mit der Zahl der eingegangenen Bewerbungen je Angebot.',
    guard: perm('all', 'jobPosting:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'post',
    path: '/api/job-postings',
    tag: 'Personal',
    summary: 'Stellenangebot anlegen',
    description:
      'Das Veröffentlichungsdatum entsteht beim Veröffentlichen, nicht beim Anlegen — ein ' +
      'Entwurf hat keines.',
    guard: perm('all', 'jobPosting:create'),
    rateLimit: 'apiWrite',
    body: website.createJobPostingSchema,
    status: 201,
    extraErrors: [409],
  },
  {
    method: 'patch',
    path: '/api/job-postings/{id}',
    tag: 'Personal',
    summary: 'Stellenangebot ändern',
    description:
      'Das Veröffentlichungsdatum wird beim ersten Veröffentlichen gesetzt und danach nicht ' +
      'mehr geändert — sonst rutschte die Anzeige bei jeder Korrektur in Stellenportalen nach ' +
      'oben, als wäre sie neu.',
    guard: perm('all', 'jobPosting:update'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: website.updateJobPostingSchema,
    extraErrors: [409],
  },
  {
    method: 'delete',
    path: '/api/job-postings/{id}',
    tag: 'Personal',
    summary: 'Stellenangebot löschen',
    description:
      'Nur ohne Bewerbungen. Bewerbungen sind Personendaten mit Auskunftsanspruch; ohne die ' +
      'zugehörige Stelle liessen sie sich nicht mehr erklären. Archivieren Sie stattdessen.',
    guard: perm('all', 'jobPosting:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
    extraErrors: [422],
  },

  // -------------------------------------------------------------------------
  //  Firmendaten und Öffnungszeiten
  // -------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/company',
    tag: 'System',
    summary: 'Firmendaten abrufen',
    description: 'Stammdaten samt Öffnungszeiten.',
    guard: perm('all', 'company:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'patch',
    path: '/api/company',
    tag: 'System',
    summary: 'Firmendaten ändern',
    description:
      'IBAN und QR-IBAN werden gegen die Prüfziffer nach ISO 13616 geprüft. Eine falsche Nummer ' +
      'fiele sonst erst auf, wenn eine Kundschaft die erste Rechnung nicht bezahlen kann — und ' +
      'stünde dann bereits auf ausgestellten, unveränderlichen Belegen.',
    guard: perm('all', 'company:update'),
    rateLimit: 'apiWrite',
    body: cms.updateCompanySchema,
    extraErrors: [422],
  },
  {
    method: 'get',
    path: '/api/opening-hours',
    tag: 'System',
    summary: 'Öffnungszeiten abrufen',
    description: 'Sieben Zeilen, Sonntag bis Samstag.',
    guard: perm('all', 'company:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'put',
    path: '/api/opening-hours',
    tag: 'System',
    summary: 'Öffnungszeiten setzen',
    description:
      'PUT statt PATCH: der Körper beschreibt den vollständigen gewünschten Wochenplan. Einzelne ' +
      'Tage zu pflegen wären sieben Anfragen, von denen jede für sich fehlschlagen könnte.',
    guard: perm('all', 'company:update'),
    rateLimit: 'apiWrite',
    extraErrors: [422],
  },

  // -------------------------------------------------------------------------
  //  Lieferanten und Zahlungen
  // -------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/suppliers',
    tag: 'Finanzen',
    summary: 'Lieferanten auflisten',
    description: 'Mit der Zahl der darauf gebuchten Ausgaben.',
    guard: perm('all', 'supplier:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'post',
    path: '/api/suppliers',
    tag: 'Finanzen',
    summary: 'Lieferant erfassen',
    description: 'Ein neu erfasster Lieferant ist aktiv.',
    guard: perm('all', 'supplier:create'),
    rateLimit: 'apiWrite',
    body: finance.createSupplierSchema,
    status: 201,
  },
  {
    method: 'patch',
    path: '/api/suppliers/{id}',
    tag: 'Finanzen',
    summary: 'Lieferant ändern',
    description:
      'Teil-Update. Mit active=false wird der Lieferant stillgelegt, ohne Belege zu verlieren.',
    guard: perm('all', 'supplier:update'),
    rateLimit: 'apiWrite',
    params: q.idParam,
  },
  {
    method: 'delete',
    path: '/api/suppliers/{id}',
    tag: 'Finanzen',
    summary: 'Lieferant löschen',
    description:
      'Nur ohne gebuchte Ausgaben. Eine Ausgabe ohne ihren Lieferanten liesse sich in der ' +
      'Buchhaltung nicht mehr zuordnen — setzen Sie ihn stattdessen auf inaktiv.',
    guard: perm('all', 'supplier:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
    extraErrors: [422],
  },
  {
    method: 'get',
    path: '/api/payments',
    tag: 'Finanzen',
    summary: 'Zahlungseingänge auflisten',
    description:
      'Sortiert nach Erfassung, nicht nach Zahlungsdatum — erfasst wird auch, was noch nicht ' +
      'bezahlt ist. Enthält Zahlungen mit und ohne Rechnungsbezug.',
    guard: perm('all', 'payment:read'),
    rateLimit: 'apiRead',
  },

  // -------------------------------------------------------------------------
  //  Kundschaft und Personal: Detail und Änderung
  // -------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/customers/{id}',
    tag: 'CRM',
    summary: 'Kundenakte abrufen',
    description: 'Stammdaten, Adressen, Objekte, Buchungen, Rechnungen und Zeitachse.',
    guard: perm('all', 'customer:read'),
    rateLimit: 'apiRead',
    params: q.idParam,
  },
  {
    method: 'patch',
    path: '/api/customers/{id}',
    tag: 'CRM',
    summary: 'Kundenakte ändern',
    description: 'Stammdaten, Konditionen und interne Notizen.',
    guard: perm('all', 'customer:update'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: crm.updateCustomerSchema,
  },
  {
    method: 'get',
    path: '/api/employees/{id}',
    tag: 'Personal',
    summary: 'Personalakte abrufen',
    description:
      'Lohn, AHV-Nummer und Bankverbindung erscheinen nur mit payslip:create. Die Schwelle ist ' +
      'bewusst nicht das Lesen der Akte: wer Einsätze plant und Ferien bewilligt, braucht die ' +
      'Zahlen nicht. Es sind besonders schützenswerte Personendaten nach DSG.',
    guard: perm('all', 'employee:read'),
    rateLimit: 'apiRead',
    params: q.idParam,
  },
  {
    method: 'patch',
    path: '/api/employees/{id}',
    tag: 'Personal',
    summary: 'Personalakte ändern',
    description: 'Stammdaten, Pensum, Qualifikationen und Lohnangaben.',
    guard: perm('all', 'employee:update'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: operations.updateEmployeeSchema,
  },

  // -------------------------------------------------------------------------
  //  Einsatzgebiet, Newsletter, Automatisierungen, Vorlagen
  // -------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/service-areas',
    tag: 'Betrieb',
    summary: 'Einsatzgebiet auflisten',
    description: 'Postleitzahlen, Anfahrtszeiten und Pauschalen.',
    guard: perm('all', 'serviceArea:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'post',
    path: '/api/service-areas',
    tag: 'Betrieb',
    summary: 'Postleitzahl aufnehmen',
    description:
      'Die Anfahrtspauschale fliesst in jeden künftigen Preis; die Änderung wird protokolliert ' +
      'und der Preis-Zwischenspeicher geleert.',
    guard: perm('all', 'serviceArea:update'),
    rateLimit: 'apiWrite',
    body: opsAdmin.createServiceAreaSchema,
    status: 201,
    extraErrors: [409],
  },
  {
    method: 'patch',
    path: '/api/service-areas/{id}',
    tag: 'Betrieb',
    summary: 'Einsatzgebiet ändern',
    description: 'Teil-Update von Ort, Pauschale, Anfahrtszeit und Sichtbarkeit.',
    guard: perm('all', 'serviceArea:update'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: opsAdmin.updateServiceAreaSchema,
    extraErrors: [409],
  },
  {
    method: 'delete',
    path: '/api/service-areas/{id}',
    tag: 'Betrieb',
    summary: 'Postleitzahl entfernen',
    description:
      'Nicht möglich, solange dort Einsätze geplant sind — die Preisberechnung für eine ' +
      'Verschiebung schlüge fehl. Setzen Sie das Gebiet stattdessen inaktiv.',
    guard: perm('all', 'serviceArea:update'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
    extraErrors: [422],
  },
  {
    method: 'post',
    path: '/api/service-areas/bulk',
    tag: 'Betrieb',
    summary: 'Mehrere Postleitzahlen auf einmal',
    description:
      'Ohne overwrite bleiben bestehende Einträge unangetastet — der Normalfall beim Nachtragen ' +
      'einer Region. Die Antwort nennt, wie viele angelegt, überschrieben und übersprungen wurden.',
    guard: perm('all', 'serviceArea:update'),
    rateLimit: 'apiWrite',
    body: opsAdmin.bulkServiceAreaSchema,
  },
  {
    method: 'get',
    path: '/api/newsletter',
    tag: 'Kommunikation',
    summary: 'Abonnentenliste',
    description:
      'Ausgetragene erscheinen nicht: sie haben widersprochen, und eine Liste, aus der man sie ' +
      'versehentlich wieder anschreibt, ist genau der Fehler, den das Austragen verhindern soll.',
    guard: perm('all', 'newsletter:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'delete',
    path: '/api/newsletter/{id}',
    tag: 'Kommunikation',
    summary: 'Abonnement austragen',
    description:
      'Die Zeile bleibt bestehen und wird als ausgetragen markiert — sie ist der Nachweis, dass ' +
      'widersprochen wurde. Ändern gibt es bewusst nicht: die E-Mail-Adresse ist der ' +
      'Identifikator, und sie zu ändern hiesse, jemand anderen anzuschreiben.',
    guard: perm('all', 'newsletter:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
    extraErrors: [422],
  },
  {
    method: 'get',
    path: '/api/automations',
    tag: 'System',
    summary: 'Automatisierungen auflisten',
    description: 'Regeln samt Aktionen und Zahl der bisherigen Läufe.',
    guard: perm('all', 'automation:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'post',
    path: '/api/automations',
    tag: 'System',
    summary: 'Automatisierung anlegen',
    description:
      'Mindestens eine Aktion ist Pflicht: eine Regel ohne Aktion löst aus und tut nichts — sie ' +
      'stünde in der Liste und wäre nicht als wirkungslos erkennbar.',
    guard: perm('all', 'automation:update'),
    rateLimit: 'apiWrite',
    body: opsAdmin.createAutomationSchema,
    status: 201,
  },
  {
    method: 'patch',
    path: '/api/automations/{id}',
    tag: 'System',
    summary: 'Automatisierung ändern',
    description: 'Die Aktionsliste ist der gewünschte Endzustand, kein Zuwachs.',
    guard: perm('all', 'automation:update'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: opsAdmin.updateAutomationSchema,
  },
  {
    method: 'delete',
    path: '/api/automations/{id}',
    tag: 'System',
    summary: 'Automatisierung löschen',
    description:
      'Nur ohne Laufhistorie. Die Läufe belegen, warum welche Nachricht verschickt wurde; ohne ' +
      'die zugehörige Regel wären sie nicht mehr lesbar. Schalten Sie die Regel stattdessen ab.',
    guard: perm('all', 'automation:update'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
    extraErrors: [422],
  },
  {
    method: 'get',
    path: '/api/templates',
    tag: 'Kommunikation',
    summary: 'E-Mail- und SMS-Vorlagen',
    description:
      'Anlegen und Löschen gibt es bewusst nicht: der Schlüssel steht im Code, dort wird die ' +
      'Vorlage nachgeschlagen. Eine frei angelegte riefe niemand auf; eine gelöschte liesse eine ' +
      'Bestätigungsmail ausfallen.',
    guard: perm('all', 'template:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'patch',
    path: '/api/templates/email/{id}',
    tag: 'Kommunikation',
    summary: 'E-Mail-Vorlage ändern',
    description:
      'Platzhalter dürfen wegfallen, aber keine neuen dazukommen: ein Platzhalter, den der ' +
      'Versand nicht füllt, erscheint wörtlich in der E-Mail an die Kundschaft. Die ' +
      'Fehlermeldung nennt die verfügbaren.',
    guard: perm('all', 'template:update'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: opsAdmin.updateEmailTemplateSchema,
    extraErrors: [422],
  },
  {
    method: 'patch',
    path: '/api/templates/sms/{id}',
    tag: 'Kommunikation',
    summary: 'SMS-Vorlage ändern',
    description: 'Höchstens 480 Zeichen — darüber kostet der Versand mehr als drei SMS je Empfänger.',
    guard: perm('all', 'template:update'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: opsAdmin.updateSmsTemplateSchema,
    extraErrors: [422],
  },

  // -------------------------------------------------------------------------
  //  Navigation und Rechtstexte
  // -------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/navigation',
    tag: 'Website',
    summary: 'Menüpunkte auflisten',
    description: 'Alle Punkte aller Orte, auch abgeschaltete.',
    guard: perm('all', 'navigation:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'post',
    path: '/api/navigation',
    tag: 'Website',
    summary: 'Menüpunkt anlegen',
    description:
      'Das Ziel wird gegen dieselbe Positivliste geprüft wie bei einem Handlungsaufruf. Ein ' +
      'Menüpunkt mit javascript:-Ziel stünde auf jeder Seite der Website, nicht nur auf einer.',
    guard: perm('all', 'navigation:update'),
    rateLimit: 'apiWrite',
    body: nav.createNavItemSchema,
    status: 201,
  },
  {
    method: 'patch',
    path: '/api/navigation/{id}',
    tag: 'Website',
    summary: 'Menüpunkt ändern',
    description: 'Teil-Update von Beschriftung, Ziel, Ort und Sichtbarkeit.',
    guard: perm('all', 'navigation:update'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: nav.updateNavItemSchema,
    extraErrors: [422],
  },
  {
    method: 'delete',
    path: '/api/navigation/{id}',
    tag: 'Website',
    summary: 'Menüpunkt löschen',
    description:
      'Unterpunkte gehen mit — ein Punkt im Aufklappbereich ohne seinen Aufklapper wäre nirgends ' +
      'erreichbar. Die Antwort nennt unter removedChildren, wie viele das betraf.',
    guard: perm('all', 'navigation:update'),
    rateLimit: 'apiWrite',
    params: q.idParam,
  },
  {
    method: 'post',
    path: '/api/navigation/reorder',
    tag: 'Website',
    summary: 'Reihenfolge im Menü setzen',
    description:
      'Je Ort und je Aufklappbereich getrennt: die Positionen zweier verschiedener Menüs haben ' +
      'nichts miteinander zu tun.',
    guard: perm('all', 'navigation:update'),
    rateLimit: 'apiWrite',
    body: nav.navReorderSchema,
  },
  {
    method: 'get',
    path: '/api/legal',
    tag: 'Website',
    summary: 'Rechtstexte auflisten',
    description:
      'Noch nicht erfasste erscheinen als leere Platzhalter mit version 0. Sonst sähe die ' +
      'Redaktion eine kurze Liste und wüsste nicht, dass die Datenschutzerklärung fehlt — und ' +
      'genau deren Fehlen ist ein Rechtsmangel.',
    guard: perm('all', 'legal:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'get',
    path: '/api/legal/{slug}',
    tag: 'Website',
    summary: 'Rechtstext abrufen',
    description: 'Einer von: impressum, datenschutz, agb, cookies.',
    guard: perm('all', 'legal:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'put',
    path: '/api/legal/{slug}',
    tag: 'Website',
    summary: 'Rechtstext setzen',
    description:
      'PUT, weil der Körper den vollständigen Text beschreibt. Ob eine Änderung eine neue ' +
      'Fassung ist, entscheidet die Redaktion über newVersion und nicht ein Zähler: eine ' +
      'korrigierte Kommasetzung ist keine, eine geänderte Aufbewahrungsfrist schon. Die ' +
      'Fassungsnummer ist der Bezugspunkt, wenn jemand fragt, welchen AGB er zugestimmt hat. ' +
      'Löschen gibt es nicht — die vier Adressen sind aus Fusszeile, Cookie-Hinweis und E-Mails ' +
      'verlinkt.',
    guard: perm('all', 'legal:update'),
    rateLimit: 'apiWrite',
    body: nav.updateLegalSchema,
  },

  // -------------------------------------------------------------------------
  //  Ausgaben, Aufgaben, Bewertungen
  // -------------------------------------------------------------------------
  {
    method: 'patch',
    path: '/api/expenses/{id}',
    tag: 'Finanzen',
    summary: 'Ausgabe korrigieren',
    description:
      'Betrag, Satz und Summe hängen zusammen und werden immer gemeinsam neu gerechnet, damit ' +
      'keine Ausgabe mit unstimmiger MWST entsteht.',
    guard: perm('all', 'expense:update'),
    rateLimit: 'apiWrite',
    params: q.idParam,
  },
  {
    method: 'delete',
    path: '/api/expenses/{id}',
    tag: 'Finanzen',
    summary: 'Ausgabe löschen',
    description:
      'Nicht möglich, sobald die Ausgabe in einem Buchhaltungsexport enthalten war: die ' +
      'Treuhandstelle hat den Beleg dann bereits verbucht, und ein Loch in der exportierten ' +
      'Reihe fällt erst beim Abschluss auf.',
    guard: perm('all', 'expense:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
    extraErrors: [422],
  },
  {
    method: 'delete',
    path: '/api/tasks/{id}',
    tag: 'CRM',
    summary: 'Aufgabe löschen',
    description:
      'Ohne fachliche Sperre — eine Aufgabe ist eine Notiz, kein Beleg. Mitarbeitende dürfen nur ' +
      'eigene löschen.',
    guard: perm('all', 'task:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
    extraErrors: [403],
  },
  {
    method: 'delete',
    path: '/api/reviews/{id}',
    tag: 'Website',
    summary: 'Bewertung löschen',
    description:
      'Eine veröffentlichte Bewertung lässt sich nicht löschen, nur verbergen. Eine Kundschaft ' +
      'hat sie geschrieben und darauf vertraut, dass sie steht; sie spurlos verschwinden zu ' +
      'lassen, wäre unredlich — und die Lesenden bekämen nur noch die guten zu sehen. Verbergen ' +
      'ist im Prüfprotokoll nachvollziehbar.',
    guard: perm('all', 'review:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
    extraErrors: [422],
  },

  // -------------------------------------------------------------------------
  //  Blog, Objekte, Buchungen, Abwesenheiten, Bewerbungen, Einstellungen
  // -------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/blog',
    tag: 'Website',
    summary: 'Beiträge auflisten',
    description: 'Alle Beiträge, auch Entwürfe. Ohne Blätterung — ein Reinigungsbetrieb schreibt keine tausend Artikel.',
    guard: perm('all', 'blog:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'get',
    path: '/api/blog/{id}',
    tag: 'Website',
    summary: 'Beitrag abrufen',
    description: 'Ein Beitrag samt Entwurfsfassung, Kategorie und Autorin.',
    guard: perm('all', 'blog:read'),
    rateLimit: 'apiRead',
    params: q.idParam,
  },
  {
    method: 'patch',
    path: '/api/blog/{id}',
    tag: 'Website',
    summary: 'Beitrag ändern',
    description:
      'Der Statuswechsel verlangt zusätzlich blog:publish — wer Texte redigiert, muss nicht auch ' +
      'veröffentlichen dürfen. Das Veröffentlichungsdatum entsteht beim ersten Veröffentlichen ' +
      'und ändert sich danach nicht: sonst rutschte ein Beitrag bei jeder Korrektur im Feed und ' +
      'in Suchmaschinen nach oben, als wäre er neu.',
    guard: perm('all', 'blog:update'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    extraErrors: [422],
  },
  {
    method: 'delete',
    path: '/api/blog/{id}',
    tag: 'Website',
    summary: 'Beitrag löschen',
    description:
      'Ein veröffentlichter Beitrag wird archiviert, nicht gelöscht: seine Adresse ist verlinkt ' +
      'und möglicherweise indexiert. Entwürfe lassen sich entfernen.',
    guard: perm('all', 'blog:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
    extraErrors: [422],
  },
  {
    method: 'get',
    path: '/api/properties',
    tag: 'CRM',
    summary: 'Objekte auflisten',
    description:
      'Property trägt kein organizationId — die Zugehörigkeit erbt es von der Kundschaft; der ' +
      'Mandantenfilter läuft über die Beziehung. Der Alarmcode erscheint nicht in der Liste: er ' +
      'gehört auf den Einsatzrapport der zugewiesenen Person.',
    guard: perm('all', 'property:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'post',
    path: '/api/properties',
    tag: 'CRM',
    summary: 'Objekt erfassen',
    description:
      'Eine bestehende Adresse wird gegen die Kundschaft geprüft — ohne das liesse sich ein ' +
      'Objekt an eine fremde Adresse hängen, und der Einsatzrapport führte das Team dorthin.',
    guard: perm('all', 'property:create'),
    rateLimit: 'apiWrite',
    status: 201,
  },
  {
    method: 'get',
    path: '/api/bookings',
    tag: 'Buchungen',
    summary: 'Buchungen auflisten',
    description:
      'Die Kundensicht auf einen Auftrag. Die Betriebssicht steht unter /api/jobs: eine Buchung ' +
      'kann mehrere Einsätze erzeugen, und ein Einsatz kann ohne Buchung bestehen.',
    guard: perm('all', 'booking:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'get',
    path: '/api/absences',
    tag: 'Personal',
    summary: 'Abwesenheiten auflisten',
    description:
      'Mitarbeitende sehen ausschliesslich die eigenen. Das ist keine Bequemlichkeit: wer wann ' +
      'in den Ferien war, ist eine Personalangabe und geht die Kolleginnen und Kollegen nichts an.',
    guard: perm('any', 'absence:read_all', 'absence:request'),
    rateLimit: 'apiRead',
  },
  {
    method: 'patch',
    path: '/api/invoices/{id}',
    tag: 'Finanzen',
    summary: 'Rechnungsentwurf ändern',
    description:
      'Nur Entwürfe. Eine ausgestellte Rechnung ist ein Beleg: Betrag, Datum und Nummer sind ab ' +
      'dem Ausstellen unveränderlich, weil die Buchhaltung darauf aufbaut und die Kundschaft sie ' +
      'erhalten hat. Korrigiert wird über eine Gutschrift.',
    guard: perm('all', 'invoice:update'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    extraErrors: [422],
  },
  {
    method: 'delete',
    path: '/api/applications/{id}',
    tag: 'Personal',
    summary: 'Bewerbung löschen',
    description:
      'Bewerbungsunterlagen sind Personendaten. Nach DSG dürfen sie nur so lange aufbewahrt ' +
      'werden, wie es der Zweck erfordert — nach einer Absage sind das wenige Monate. Das ' +
      'Löschen ist deshalb ausdrücklich vorgesehen und nicht durch eine Aufbewahrungsregel ' +
      'gesperrt. Angehängte Dateien gehen über die Kaskade mit.',
    guard: perm('all', 'application:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
  },
  {
    method: 'get',
    path: '/api/settings',
    tag: 'System',
    summary: 'Betriebseinstellungen',
    description:
      'Vorlaufzeiten, Stornofristen, Mahnwesen, Bewertungsanfragen. Fehlende Schlüssel liefern ' +
      'den Auslieferungswert.',
    guard: perm('all', 'settings:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'patch',
    path: '/api/settings',
    tag: 'System',
    summary: 'Betriebseinstellungen ändern',
    description:
      'Teil-Update: gesendet wird nur, was sich ändert. Ein vollständiges Überschreiben würde ' +
      'bei zwei gleichzeitig geöffneten Masken die Änderung der jeweils anderen still verwerfen. ' +
      'Das Schema ist streng — ein freies JSON-Feld wäre die Stelle, an der ein Tippfehler im ' +
      'Schlüssel eine Einstellung wirkungslos macht, ohne dass es jemand bemerkt.',
    guard: perm('all', 'settings:update'),
    rateLimit: 'apiWrite',
  },

  // -------------------------------------------------------------------------
  //  Zahlungen, Objektdetail, Personalaustritt, Bewerbungsdetail
  // -------------------------------------------------------------------------
  {
    method: 'patch',
    path: '/api/payments/{id}',
    tag: 'Finanzen',
    summary: 'Zahlung korrigieren',
    description:
      'Beleg, Notiz und Zahlungsdatum. Der Betrag ist nicht änderbar: er stammt vom ' +
      'Zahlungsanbieter oder wurde beim Verbuchen gegen den offenen Posten gerechnet. Ihn ' +
      'nachträglich zu verstellen liesse Rechnungssaldo und Zahlungssumme auseinanderlaufen — ' +
      'und das fiele erst beim Jahresabschluss auf. Ein falscher Betrag wird storniert und neu ' +
      'verbucht.',
    guard: perm('all', 'payment:create'),
    rateLimit: 'apiWrite',
    params: q.idParam,
  },
  {
    method: 'delete',
    path: '/api/payments/{id}',
    tag: 'Finanzen',
    summary: 'Zahlung stornieren',
    description:
      'Nur von Hand erfasste Zahlungen. Was über Stripe oder Datatrans hereinkam, ist beim ' +
      'Zahlungsanbieter eine Tatsache; die Zeile zu entfernen hiesse, die eigene Buchhaltung ' +
      'gegen den Kontoauszug laufen zu lassen. Der offene Posten der Rechnung wird in derselben ' +
      'Transaktion zurückgesetzt — sonst bliebe sie als bezahlt stehen, obwohl kein Geld da ist.',
    guard: perm('all', 'payment:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
    extraErrors: [422],
  },
  {
    method: 'get',
    path: '/api/properties/{id}',
    tag: 'CRM',
    summary: 'Objektakte abrufen',
    description: 'Objektangaben, Adresse, Kundschaft und die letzten Einsätze.',
    guard: perm('all', 'property:read'),
    rateLimit: 'apiRead',
    params: q.idParam,
  },
  {
    method: 'patch',
    path: '/api/properties/{id}',
    tag: 'CRM',
    summary: 'Objekt ändern',
    description:
      'Die Kundschaft lässt sich nicht wechseln: das würde Einsatzhistorie und daran hängende ' +
      'Rechnungen an die falsche Akte binden. Bei einem Eigentümerwechsel wird ein neues Objekt ' +
      'erfasst und das alte stillgelegt.',
    guard: perm('all', 'property:update'),
    rateLimit: 'apiWrite',
    params: q.idParam,
  },
  {
    method: 'delete',
    path: '/api/employees/{id}',
    tag: 'Personal',
    summary: 'Mitarbeitende stilllegen',
    description:
      'Kein Löschen, sondern inaktiv setzen mit Austrittsdatum; der Zugang wird gesperrt. Eine ' +
      'Personalakte hängt an Zeiterfassung, Lohnabrechnungen und Einsatzrapporten — sie zu ' +
      'entfernen risse dort Lücken, die man Jahre später bei einer Lohnprüfung wiederfindet. ' +
      'Geplante Einsätze müssen vorher umgeteilt werden.',
    guard: perm('all', 'employee:delete'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    status: 204,
    extraErrors: [422],
  },
  {
    method: 'get',
    path: '/api/applications/{id}',
    tag: 'Personal',
    summary: 'Bewerbung abrufen',
    description: 'Angaben zur bewerbenden Person samt hochgeladenen Unterlagen.',
    guard: perm('all', 'application:read'),
    rateLimit: 'apiRead',
    params: q.idParam,
  },

  // -------------------------------------------------------------------------
  //  System
  // -------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/cron/hourly',
    tag: 'System',
    summary: 'Stündliche Aufgaben',
    description:
      'Terminerinnerungen 24 h und 2 h vorher, fällige Aufgabenerinnerungen. Authentifiziert ' +
      'über `Authorization: Bearer $CRON_SECRET`.',
    guard: { kind: 'cron' },
  },
  {
    method: 'get',
    path: '/api/cron/daily',
    tag: 'System',
    summary: 'Tägliche Aufgaben',
    description:
      'Mahnläufe, ablaufende Offerten, Wiederholungsbuchungen, Bewertungsanfragen, ' +
      'Geburtstagsgrüsse, Automatisierungen.',
    guard: { kind: 'cron' },
  },
  {
    method: 'post',
    path: '/api/webhooks/stripe',
    tag: 'System',
    summary: 'Stripe-Webhook',
    description:
      'Bucht Zahlungseingänge, Rückerstattungen und Fehlschläge. Prüft die Signatur gegen den ' +
      'Rohkörper und arbeitet idempotent. Bei einem Fehler antwortet der Endpunkt mit 500, ' +
      'damit Stripe erneut zustellt — eine stille 200 würde die Zahlung verlieren.',
    guard: { kind: 'public' },
  },
];
