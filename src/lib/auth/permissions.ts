/**
 * Berechtigungskatalog.
 *
 * Diese Datei ist die *einzige* Stelle, an der es steht: welche Berechtigungen
 * es gibt, wie sie heissen, wozu sie gehören und was sie erlauben. Alles
 * andere — Endpunkte, Seiten, Menüs, Schaltflächen — verweist hierher.
 *
 * Architekturentscheide:
 *
 *  • **Der Schlüssel ist `bereich:aktion`, die Anzeige `Bereich.Aktion`.**
 *    Beides ist dasselbe Modell; der Doppelpunkt ist im Code eingebürgert, der
 *    Punkt liest sich in einer Rechtematrix besser. Statt beides irgendwo
 *    umzurechnen, trägt jeder Eintrag beide Formen.
 *
 *  • **Schreiben ist in anlegen / ändern / löschen zerlegt.** Ein einziges
 *    `write` erlaubt niemandem, jemandem das *Löschen* zu entziehen, ohne ihm
 *    auch das Anlegen zu nehmen. Genau diese Trennung ist der Zweck einer
 *    feingliedrigen Rechteverwaltung; ohne sie ist die Matrix Dekoration.
 *
 *  • **Die Liste ist eine `as const`-Tupel, kein `string[]`.** Damit ist
 *    `Permission` eine Vereinigung von Literalen: ein Tippfehler in einer
 *    Route bricht den Build. Ohne das wäre er ein stiller Ausschluss aller
 *    Benutzer — der schlimmste denkbare Fehler an dieser Stelle, weil er
 *    aussieht wie eine korrekt greifende Sperre.
 *
 *  • **Die Beschreibungstabelle ist ein `Record<Permission, …>`.** Fehlt zu
 *    einem Schlüssel der Eintrag, bricht der Build ebenfalls. So kann kein
 *    Recht existieren, das in der Rechtematrix ohne Erklärung dasteht.
 */

/**
 * Alle Berechtigungen des Systems.
 *
 * Reihenfolge = Reihenfolge in der Rechtematrix innerhalb einer Gruppe.
 */
export const PERMISSIONS = [
  // --- Übersicht ------------------------------------------------------------
  'dashboard:view',
  'dashboard:financials',
  'report:read',
  'report:export',

  // --- Website --------------------------------------------------------------
  'content:read',
  'content:update',
  'seo:read',
  'seo:update',
  'cta:read',
  'cta:create',
  'cta:update',
  'cta:delete',
  'cta:publish',
  'navigation:read',
  'navigation:update',
  'legal:read',
  'legal:update',
  'gallery:read',
  'gallery:create',
  'gallery:update',
  'gallery:delete',
  'faq:read',
  'faq:create',
  'faq:update',
  'faq:delete',
  'blog:read',
  'blog:create',
  'blog:update',
  'blog:delete',
  'blog:publish',
  'media:read',
  'media:upload',
  'media:update',
  'media:delete',
  'review:read',
  'review:moderate',
  'review:delete',
  'review:write_own',

  // --- Katalog und Preise ---------------------------------------------------
  'service:read',
  'service:create',
  'service:update',
  'service:delete',
  'pricing:read',
  'pricing:update',
  'coupon:read',
  'coupon:create',
  'coupon:update',
  'coupon:delete',

  // --- Kundenbeziehung ------------------------------------------------------
  'lead:read',
  'lead:create',
  'lead:update',
  'lead:delete',
  'customer:read',
  'customer:create',
  'customer:update',
  'customer:delete',
  'customer:read_own',
  'customer:update_own',
  'property:read',
  'property:create',
  'property:update',
  'property:delete',
  'activity:read',
  'activity:create',
  'task:read',
  'task:create',
  'task:update',
  'task:delete',

  // --- Betrieb --------------------------------------------------------------
  'booking:read',
  'booking:create',
  'booking:update',
  'booking:delete',
  'booking:read_own',
  'booking:write_own',
  'quote:read',
  'quote:create',
  'quote:update',
  'quote:delete',
  'quote:send',
  'quote:convert',
  'quote:read_own',
  'quote:respond_own',
  'job:read',
  'job:create',
  'job:update',
  'job:delete',
  'job:assign',
  'job:dispatch',
  'job:read_assigned',
  'job:complete_assigned',
  'serviceArea:read',
  'serviceArea:update',

  // --- Finanzen -------------------------------------------------------------
  'invoice:read',
  'invoice:create',
  'invoice:update',
  'invoice:delete',
  'invoice:send',
  'invoice:read_own',
  'invoice:pay_own',
  'payment:read',
  'payment:create',
  'payment:delete',
  'creditnote:read',
  'creditnote:create',
  'expense:read',
  'expense:create',
  'expense:update',
  'expense:delete',
  'supplier:read',
  'supplier:create',
  'supplier:update',
  'supplier:delete',
  'accounting:export',

  // --- Personal -------------------------------------------------------------
  'employee:read',
  'employee:create',
  'employee:update',
  'employee:delete',
  'employee:read_own',
  'timetracking:own',
  'timetracking:read_all',
  'timetracking:approve',
  'absence:request',
  'absence:read_all',
  'absence:approve',
  'payslip:read_own',
  'payslip:create',
  'application:read',
  'application:update',
  'application:delete',
  'jobPosting:read',
  'jobPosting:create',
  'jobPosting:update',
  'jobPosting:delete',

  // --- Kommunikation --------------------------------------------------------
  'message:read',
  'message:create',
  'message:read_own',
  'message:write_own',
  'notification:read_own',
  'template:read',
  'template:update',
  'newsletter:read',
  'newsletter:create',
  'newsletter:delete',

  // --- System ---------------------------------------------------------------
  'settings:read',
  'settings:update',
  'company:read',
  'company:update',
  'user:read',
  'user:create',
  'user:update',
  'user:delete',
  'user:impersonate',
  'role:read',
  'role:assign',
  'audit:read',
  'automation:read',
  'automation:update',
  'file:read',
  'file:upload',
  'file:delete',
  'ai:use',
  'ai:configure',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type PermissionGroup =
  | 'Übersicht'
  | 'Website'
  | 'Katalog und Preise'
  | 'Kundenbeziehung'
  | 'Betrieb'
  | 'Finanzen'
  | 'Personal'
  | 'Kommunikation'
  | 'System';

export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  'Übersicht',
  'Website',
  'Katalog und Preise',
  'Kundenbeziehung',
  'Betrieb',
  'Finanzen',
  'Personal',
  'Kommunikation',
  'System',
] as const;

export interface PermissionMeta {
  /** Anzeige in der Rechtematrix, z. B. `Services.Create`. */
  label: string;
  group: PermissionGroup;
  /** Ein Satz, der sagt, was die Berechtigung *tatsächlich* erlaubt. */
  description: string;
  /**
   * true = wirkt nur auf eigene Datensätze.
   *
   * Für die Matrix wesentlich: eine Kundschaft mit `invoice:read_own` sieht
   * Rechnungen — aber nur ihre eigenen. Ohne diese Kennzeichnung liest sich
   * die Zeile, als hätte sie Einblick in die Buchhaltung.
   */
  scoped?: true;
}

/**
 * Beschreibung jeder Berechtigung.
 *
 * `Record<Permission, …>` erzwingt Vollständigkeit: ein neuer Schlüssel oben
 * ohne Eintrag hier bricht den Build.
 */
export const PERMISSION_META: Record<Permission, PermissionMeta> = {
  'dashboard:view': { label: 'Dashboard.View', group: 'Übersicht', description: 'Die Startseite des Arbeitsbereichs öffnen.' },
  'dashboard:financials': { label: 'Dashboard.Financials', group: 'Übersicht', description: 'Umsatz, Marge und Kosten auf der Übersicht sehen.' },
  'report:read': { label: 'Reports.View', group: 'Übersicht', description: 'Auswertungen und Statistiken öffnen.' },
  'report:export': { label: 'Reports.Export', group: 'Übersicht', description: 'Auswertungen als Excel- oder CSV-Datei herunterladen.' },

  'content:read': { label: 'Website.Content.View', group: 'Website', description: 'Redaktionelle Texte der Website einsehen.' },
  'content:update': { label: 'Website.Content.Edit', group: 'Website', description: 'Überschriften, Fliesstexte und Listen der Website ändern.' },
  'seo:read': { label: 'SEO.View', group: 'Website', description: 'Suchmaschinenangaben einsehen.' },
  'seo:update': { label: 'SEO.Edit', group: 'Website', description: 'Seitentitel, Beschreibungen und Indexierung steuern.' },
  'cta:read': { label: 'CTA.View', group: 'Website', description: 'Handlungsaufrufe einsehen.' },
  'cta:create': { label: 'CTA.Create', group: 'Website', description: 'Neue Handlungsaufrufe anlegen.' },
  'cta:update': { label: 'CTA.Edit', group: 'Website', description: 'Text, Farbe, Symbol, Ziel und Platzierung ändern.' },
  'cta:delete': { label: 'CTA.Delete', group: 'Website', description: 'Handlungsaufrufe entfernen.' },
  'cta:publish': { label: 'CTA.Publish', group: 'Website', description: 'Handlungsaufrufe veröffentlichen, terminieren und abschalten.' },
  'navigation:read': { label: 'Navigation.View', group: 'Website', description: 'Menüstruktur einsehen.' },
  'navigation:update': { label: 'Navigation.Edit', group: 'Website', description: 'Menüpunkte anlegen, umbenennen, umsortieren und entfernen.' },
  'legal:read': { label: 'Legal.View', group: 'Website', description: 'Rechtstexte einsehen.' },
  'legal:update': { label: 'Legal.Edit', group: 'Website', description: 'Impressum, Datenschutz, AGB und Cookie-Hinweis ändern.' },
  'gallery:read': { label: 'Gallery.View', group: 'Website', description: 'Referenzbilder einsehen.' },
  'gallery:create': { label: 'Gallery.Create', group: 'Website', description: 'Bilder zur Galerie hinzufügen.' },
  'gallery:update': { label: 'Gallery.Edit', group: 'Website', description: 'Titel, Zuordnung und Reihenfolge der Bilder ändern.' },
  'gallery:delete': { label: 'Gallery.Delete', group: 'Website', description: 'Bilder aus der Galerie entfernen.' },
  'faq:read': { label: 'FAQ.View', group: 'Website', description: 'Häufige Fragen einsehen.' },
  'faq:create': { label: 'FAQ.Create', group: 'Website', description: 'Neue Fragen und Antworten anlegen.' },
  'faq:update': { label: 'FAQ.Edit', group: 'Website', description: 'Fragen und Antworten ändern und umsortieren.' },
  'faq:delete': { label: 'FAQ.Delete', group: 'Website', description: 'Fragen entfernen.' },
  'blog:read': { label: 'Blog.View', group: 'Website', description: 'Beiträge und Entwürfe einsehen.' },
  'blog:create': { label: 'Blog.Create', group: 'Website', description: 'Neue Beiträge verfassen.' },
  'blog:update': { label: 'Blog.Edit', group: 'Website', description: 'Bestehende Beiträge ändern.' },
  'blog:delete': { label: 'Blog.Delete', group: 'Website', description: 'Beiträge entfernen.' },
  'blog:publish': { label: 'Blog.Publish', group: 'Website', description: 'Beiträge veröffentlichen und zurückziehen.' },
  'media:read': { label: 'Media.View', group: 'Website', description: 'Mediathek durchsuchen.' },
  'media:upload': { label: 'Media.Upload', group: 'Website', description: 'Bilder und Dokumente hochladen.' },
  'media:update': { label: 'Media.Edit', group: 'Website', description: 'Dateinamen, Alternativtexte und Zuordnung ändern.' },
  'media:delete': { label: 'Media.Delete', group: 'Website', description: 'Dateien endgültig löschen.' },
  'review:read': { label: 'Testimonials.View', group: 'Website', description: 'Kundenbewertungen einsehen.' },
  'review:moderate': { label: 'Testimonials.Moderate', group: 'Website', description: 'Bewertungen freigeben, verbergen und beantworten.' },
  'review:delete': { label: 'Testimonials.Delete', group: 'Website', description: 'Bewertungen entfernen.' },
  'review:write_own': { label: 'Testimonials.WriteOwn', group: 'Website', description: 'Eine Bewertung zum eigenen Auftrag abgeben.', scoped: true },

  'service:read': { label: 'Services.View', group: 'Katalog und Preise', description: 'Leistungskatalog einsehen.' },
  'service:create': { label: 'Services.Create', group: 'Katalog und Preise', description: 'Neue Leistungen, Kategorien und Zusätze anlegen.' },
  'service:update': { label: 'Services.Edit', group: 'Katalog und Preise', description: 'Leistungen, Kategorien und Zusätze ändern.' },
  'service:delete': { label: 'Services.Delete', group: 'Katalog und Preise', description: 'Leistungen, Kategorien und Zusätze entfernen.' },
  'pricing:read': { label: 'Pricing.View', group: 'Katalog und Preise', description: 'Preise, Ansätze und Preisregeln einsehen.' },
  'pricing:update': { label: 'Pricing.Edit', group: 'Katalog und Preise', description: 'Grundpreise, Ansätze, Mindestbeträge, Preisregeln und Steuersätze ändern.' },
  'coupon:read': { label: 'Coupons.View', group: 'Katalog und Preise', description: 'Gutscheincodes und Einlösestand einsehen.' },
  'coupon:create': { label: 'Coupons.Create', group: 'Katalog und Preise', description: 'Neue Gutscheincodes ausgeben.' },
  'coupon:update': { label: 'Coupons.Edit', group: 'Katalog und Preise', description: 'Gutscheine ändern, pausieren und beenden.' },
  'coupon:delete': { label: 'Coupons.Delete', group: 'Katalog und Preise', description: 'Nie eingelöste Gutscheine entfernen.' },

  'lead:read': { label: 'Leads.View', group: 'Kundenbeziehung', description: 'Anfragen und Pipeline einsehen.' },
  'lead:create': { label: 'Leads.Create', group: 'Kundenbeziehung', description: 'Anfragen erfassen.' },
  'lead:update': { label: 'Leads.Edit', group: 'Kundenbeziehung', description: 'Anfragen bearbeiten, zuweisen und verschieben.' },
  'lead:delete': { label: 'Leads.Delete', group: 'Kundenbeziehung', description: 'Anfragen entfernen.' },
  'customer:read': { label: 'Customers.View', group: 'Kundenbeziehung', description: 'Kundenakten einsehen.' },
  'customer:create': { label: 'Customers.Create', group: 'Kundenbeziehung', description: 'Kundendatensätze anlegen.' },
  'customer:update': { label: 'Customers.Edit', group: 'Kundenbeziehung', description: 'Stammdaten, Konditionen und Notizen ändern.' },
  'customer:delete': { label: 'Customers.Delete', group: 'Kundenbeziehung', description: 'Kundendatensätze löschen — wiederherstellbar.' },
  'customer:read_own': { label: 'Customers.ViewOwn', group: 'Kundenbeziehung', description: 'Die eigenen Stammdaten einsehen.', scoped: true },
  'customer:update_own': { label: 'Customers.EditOwn', group: 'Kundenbeziehung', description: 'Die eigenen Adressen anlegen, ändern und entfernen.', scoped: true },
  'property:read': { label: 'Properties.View', group: 'Kundenbeziehung', description: 'Objekte und Liegenschaften einsehen.' },
  'property:create': { label: 'Properties.Create', group: 'Kundenbeziehung', description: 'Objekte erfassen.' },
  'property:update': { label: 'Properties.Edit', group: 'Kundenbeziehung', description: 'Objektangaben, Zugang und Schlüsselablage ändern.' },
  'property:delete': { label: 'Properties.Delete', group: 'Kundenbeziehung', description: 'Objekte entfernen.' },
  'activity:read': { label: 'Activities.View', group: 'Kundenbeziehung', description: 'Gesprächsverlauf und Zeitachse einsehen.' },
  'activity:create': { label: 'Activities.Create', group: 'Kundenbeziehung', description: 'Notizen, Anrufe und Termine festhalten.' },
  'task:read': { label: 'Tasks.View', group: 'Kundenbeziehung', description: 'Aufgaben einsehen.' },
  'task:create': { label: 'Tasks.Create', group: 'Kundenbeziehung', description: 'Aufgaben anlegen.' },
  'task:update': { label: 'Tasks.Edit', group: 'Kundenbeziehung', description: 'Aufgaben zuweisen, terminieren und abschliessen.' },
  'task:delete': { label: 'Tasks.Delete', group: 'Kundenbeziehung', description: 'Aufgaben entfernen.' },

  'booking:read': { label: 'Bookings.View', group: 'Betrieb', description: 'Alle Buchungen einsehen.' },
  'booking:create': { label: 'Bookings.Create', group: 'Betrieb', description: 'Buchungen erfassen.' },
  'booking:update': { label: 'Bookings.Edit', group: 'Betrieb', description: 'Buchungen verschieben, bestätigen und stornieren.' },
  'booking:delete': { label: 'Bookings.Delete', group: 'Betrieb', description: 'Buchungen löschen — wiederherstellbar.' },
  'booking:read_own': { label: 'Bookings.ViewOwn', group: 'Betrieb', description: 'Die eigenen Buchungen einsehen.', scoped: true },
  'booking:write_own': { label: 'Bookings.EditOwn', group: 'Betrieb', description: 'Eigene Buchungen verschieben oder stornieren.', scoped: true },
  'quote:read': { label: 'Quotes.View', group: 'Betrieb', description: 'Offerten einsehen.' },
  'quote:create': { label: 'Quotes.Create', group: 'Betrieb', description: 'Offerten erstellen.' },
  'quote:update': { label: 'Quotes.Edit', group: 'Betrieb', description: 'Offerten bearbeiten.' },
  'quote:delete': { label: 'Quotes.Delete', group: 'Betrieb', description: 'Offerten löschen — wiederherstellbar.' },
  'quote:send': { label: 'Quotes.Send', group: 'Betrieb', description: 'Offerten an die Kundschaft versenden.' },
  'quote:convert': { label: 'Quotes.Convert', group: 'Betrieb', description: 'Angenommene Offerten in Aufträge und Rechnungen überführen.' },
  'quote:read_own': { label: 'Quotes.ViewOwn', group: 'Betrieb', description: 'Die eigenen Offerten einsehen.', scoped: true },
  'quote:respond_own': { label: 'Quotes.RespondOwn', group: 'Betrieb', description: 'Eine Offerte annehmen oder ablehnen.', scoped: true },
  'job:read': { label: 'Jobs.View', group: 'Betrieb', description: 'Alle Einsätze einsehen.' },
  'job:create': { label: 'Jobs.Create', group: 'Betrieb', description: 'Einsätze anlegen.' },
  'job:update': { label: 'Jobs.Edit', group: 'Betrieb', description: 'Einsätze ändern und Checklisten pflegen.' },
  'job:delete': { label: 'Jobs.Delete', group: 'Betrieb', description: 'Einsätze löschen — wiederherstellbar.' },
  'job:assign': { label: 'Jobs.Assign', group: 'Betrieb', description: 'Personal auf Einsätze buchen.' },
  'job:dispatch': { label: 'Jobs.Dispatch', group: 'Betrieb', description: 'Den Dispositionskalender bedienen.' },
  'job:read_assigned': { label: 'Jobs.ViewAssigned', group: 'Betrieb', description: 'Die eigenen zugewiesenen Einsätze einsehen.', scoped: true },
  'job:complete_assigned': { label: 'Jobs.CompleteAssigned', group: 'Betrieb', description: 'Einen zugewiesenen Einsatz abschliessen und rapportieren.', scoped: true },
  'serviceArea:read': { label: 'ServiceArea.View', group: 'Betrieb', description: 'Einsatzgebiet und Anfahrtspauschalen einsehen.' },
  'serviceArea:update': { label: 'ServiceArea.Edit', group: 'Betrieb', description: 'Postleitzahlen, Anfahrtszeiten und Pauschalen pflegen.' },

  'invoice:read': { label: 'Invoices.View', group: 'Finanzen', description: 'Rechnungen einsehen.' },
  'invoice:create': { label: 'Invoices.Create', group: 'Finanzen', description: 'Rechnungen erstellen.' },
  'invoice:update': { label: 'Invoices.Edit', group: 'Finanzen', description: 'Rechnungsentwürfe ändern.' },
  'invoice:delete': { label: 'Invoices.Delete', group: 'Finanzen', description: 'Rechnungsentwürfe löschen. Ausgestellte Rechnungen bleiben unantastbar.' },
  'invoice:send': { label: 'Invoices.Send', group: 'Finanzen', description: 'Rechnungen ausstellen, versenden und mahnen.' },
  'invoice:read_own': { label: 'Invoices.ViewOwn', group: 'Finanzen', description: 'Die eigenen Rechnungen einsehen.', scoped: true },
  'invoice:pay_own': { label: 'Invoices.PayOwn', group: 'Finanzen', description: 'Eine eigene Rechnung online bezahlen.', scoped: true },
  'payment:read': { label: 'Payments.View', group: 'Finanzen', description: 'Zahlungseingänge einsehen.' },
  'payment:create': { label: 'Payments.Create', group: 'Finanzen', description: 'Zahlungen manuell verbuchen.' },
  'payment:delete': { label: 'Payments.Delete', group: 'Finanzen', description: 'Eine fälschlich verbuchte Zahlung stornieren.' },
  'creditnote:read': { label: 'CreditNotes.View', group: 'Finanzen', description: 'Gutschriften einsehen.' },
  'creditnote:create': { label: 'CreditNotes.Create', group: 'Finanzen', description: 'Gutschriften ausstellen.' },
  'expense:read': { label: 'Expenses.View', group: 'Finanzen', description: 'Ausgaben einsehen.' },
  'expense:create': { label: 'Expenses.Create', group: 'Finanzen', description: 'Ausgaben erfassen.' },
  'expense:update': { label: 'Expenses.Edit', group: 'Finanzen', description: 'Ausgaben ändern.' },
  'expense:delete': { label: 'Expenses.Delete', group: 'Finanzen', description: 'Ausgaben entfernen.' },
  'supplier:read': { label: 'Suppliers.View', group: 'Finanzen', description: 'Lieferanten einsehen.' },
  'supplier:create': { label: 'Suppliers.Create', group: 'Finanzen', description: 'Lieferanten erfassen.' },
  'supplier:update': { label: 'Suppliers.Edit', group: 'Finanzen', description: 'Lieferantendaten ändern.' },
  'supplier:delete': { label: 'Suppliers.Delete', group: 'Finanzen', description: 'Lieferanten entfernen.' },
  'accounting:export': { label: 'Accounting.Export', group: 'Finanzen', description: 'Buchhaltungsdaten für die Treuhandstelle exportieren.' },

  'employee:read': { label: 'Employees.View', group: 'Personal', description: 'Personalakten einsehen.' },
  'employee:create': { label: 'Employees.Create', group: 'Personal', description: 'Mitarbeitende anlegen, inklusive Lohn- und AHV-Angaben.' },
  'employee:update': { label: 'Employees.Edit', group: 'Personal', description: 'Personalakten ändern.' },
  'employee:delete': { label: 'Employees.Delete', group: 'Personal', description: 'Mitarbeitende deaktivieren und entfernen.' },
  'employee:read_own': { label: 'Employees.ViewOwn', group: 'Personal', description: 'Die eigene Personalakte einsehen.', scoped: true },
  'timetracking:own': { label: 'TimeTracking.Own', group: 'Personal', description: 'Die eigene Arbeitszeit stempeln.', scoped: true },
  'timetracking:read_all': { label: 'TimeTracking.ViewAll', group: 'Personal', description: 'Die Zeiterfassung aller Mitarbeitenden einsehen.' },
  'timetracking:approve': { label: 'TimeTracking.Approve', group: 'Personal', description: 'Erfasste Zeiten freigeben und korrigieren.' },
  'absence:request': { label: 'Absences.Request', group: 'Personal', description: 'Eine eigene Abwesenheit beantragen.', scoped: true },
  'absence:read_all': { label: 'Absences.ViewAll', group: 'Personal', description: 'Alle Abwesenheitsgesuche einsehen.' },
  'absence:approve': { label: 'Absences.Approve', group: 'Personal', description: 'Abwesenheiten bewilligen oder ablehnen.' },
  'payslip:read_own': { label: 'Payslips.ViewOwn', group: 'Personal', description: 'Die eigenen Lohnabrechnungen einsehen.', scoped: true },
  'payslip:create': { label: 'Payslips.Create', group: 'Personal', description: 'Lohnabrechnungen erstellen.' },
  'application:read': { label: 'Applications.View', group: 'Personal', description: 'Bewerbungen einsehen.' },
  'application:update': { label: 'Applications.Edit', group: 'Personal', description: 'Bewerbungen bewerten und beantworten.' },
  'application:delete': { label: 'Applications.Delete', group: 'Personal', description: 'Bewerbungen löschen.' },
  'jobPosting:read': { label: 'JobPostings.View', group: 'Personal', description: 'Stellenangebote einsehen.' },
  'jobPosting:create': { label: 'JobPostings.Create', group: 'Personal', description: 'Stellenangebote ausschreiben.' },
  'jobPosting:update': { label: 'JobPostings.Edit', group: 'Personal', description: 'Stellenangebote ändern.' },
  'jobPosting:delete': { label: 'JobPostings.Delete', group: 'Personal', description: 'Stellenangebote entfernen.' },

  'message:read': { label: 'Messages.View', group: 'Kommunikation', description: 'Alle Nachrichtenverläufe einsehen.' },
  'message:create': { label: 'Messages.Create', group: 'Kommunikation', description: 'Nachrichten schreiben und beantworten.' },
  'message:read_own': { label: 'Messages.ViewOwn', group: 'Kommunikation', description: 'Die eigenen Verläufe einsehen.', scoped: true },
  'message:write_own': { label: 'Messages.WriteOwn', group: 'Kommunikation', description: 'In den eigenen Verläufen schreiben.', scoped: true },
  'notification:read_own': { label: 'Notifications.ViewOwn', group: 'Kommunikation', description: 'Die eigenen Benachrichtigungen einsehen.', scoped: true },
  'template:read': { label: 'Templates.View', group: 'Kommunikation', description: 'E-Mail- und SMS-Vorlagen einsehen.' },
  'template:update': { label: 'Templates.Edit', group: 'Kommunikation', description: 'Vorlagen ändern.' },
  'newsletter:read': { label: 'Newsletter.View', group: 'Kommunikation', description: 'Abonnentenliste einsehen.' },
  'newsletter:create': { label: 'Newsletter.Create', group: 'Kommunikation', description: 'Newsletter verfassen und versenden.' },
  'newsletter:delete': { label: 'Newsletter.Delete', group: 'Kommunikation', description: 'Abonnenten entfernen.' },

  'settings:read': { label: 'Settings.View', group: 'System', description: 'Einstellungen einsehen.' },
  'settings:update': { label: 'Settings.Edit', group: 'System', description: 'Betriebseinstellungen ändern.' },
  'company:read': { label: 'Company.View', group: 'System', description: 'Firmendaten einsehen.' },
  'company:update': { label: 'Company.Edit', group: 'System', description: 'Firmenname, Adresse, Kontakt, IBAN und Öffnungszeiten ändern.' },
  'user:read': { label: 'Users.View', group: 'System', description: 'Benutzerkonten einsehen.' },
  'user:create': { label: 'Users.Create', group: 'System', description: 'Benutzerkonten anlegen und einladen.' },
  'user:update': { label: 'Users.Edit', group: 'System', description: 'Konten ändern, sperren und entsperren.' },
  'user:delete': { label: 'Users.Delete', group: 'System', description: 'Konten löschen — wiederherstellbar.' },
  'user:impersonate': { label: 'Users.Impersonate', group: 'System', description: 'Sich als anderer Benutzer anmelden.' },
  'role:read': { label: 'Roles.View', group: 'System', description: 'Rollen und ihre Berechtigungen einsehen.' },
  'role:assign': { label: 'Roles.Assign', group: 'System', description: 'Benutzern eine Rolle zuweisen.' },
  'audit:read': { label: 'Audit.View', group: 'System', description: 'Das Prüfprotokoll einsehen.' },
  'automation:read': { label: 'Automations.View', group: 'System', description: 'Automatisierungen einsehen.' },
  'automation:update': { label: 'Automations.Edit', group: 'System', description: 'Automatisierungen anlegen, ändern und abschalten.' },
  'file:read': { label: 'Files.View', group: 'System', description: 'Angehängte Dateien öffnen.' },
  'file:upload': { label: 'Files.Upload', group: 'System', description: 'Dateien an Vorgänge anhängen.' },
  'file:delete': { label: 'Files.Delete', group: 'System', description: 'Angehängte Dateien löschen.' },
  'ai:use': { label: 'AI.Use', group: 'System', description: 'KI-Assistenz für Texte, Zusammenfassungen und Disposition nutzen.' },
  'ai:configure': { label: 'AI.Configure', group: 'System', description: 'KI-Einstellungen und Modellwahl ändern.' },
};

/** Anzeigename in Punktschreibweise, z. B. `Services.Create`. */
export function permissionLabel(key: Permission): string {
  return PERMISSION_META[key].label;
}

export function isPermission(key: string): key is Permission {
  return key in PERMISSION_META;
}

/** Berechtigungen nach Gruppe, in Katalogreihenfolge — für die Rechtematrix. */
export function permissionsByGroup(): { group: PermissionGroup; permissions: Permission[] }[] {
  return PERMISSION_GROUPS.map((group) => ({
    group,
    permissions: PERMISSIONS.filter((key) => PERMISSION_META[key].group === group),
  }));
}
