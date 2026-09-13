# Datenmodell

> Diese Datei wird von `npm run erd` aus `prisma/schema.prisma` erzeugt. Die
> Diagramme sind damit nie älter als das Schema. Prosa und Bereichseinteilung
> stehen in `scripts/generate-erd.ts`.

**110 Modelle, 67 Aufzählungstypen, 1973 Felder.**
PostgreSQL 16+; alle Zeitstempel als `timestamptz` in UTC, Anzeige in Europe/Zurich.

## Vier Entscheidungen, die das ganze Schema prägen

**1. `Organization` als Mandantenwurzel.** Fast jede Tabelle trägt eine
`organizationId`. Die Plattform läuft heute einmandantig, aber diese Spalte
nachträglich über fünfzig Tabellen einzuziehen wäre eine Migration, die man
nicht zweimal machen will.

**2. Selektive Soft-Deletes.** `deletedAt` tragen nur die Tabellen, deren
Einträge man später noch braucht: Kundschaft, Buchungen, Offerten, Einsätze,
Rechnungen, Objekte. Eine gelöschte Benachrichtigung ist dagegen einfach weg.
Überall Soft-Deletes bedeutet, überall daran denken zu müssen — und irgendwo
vergisst man es.

**3. Finanzbelege sind fortschreibend.** Eine ausgestellte Rechnung wird nie
geändert oder gelöscht; Korrekturen entstehen als Gutschrift. Die
Belegnummern kommen aus `NumberSequence` und werden innerhalb derselben
Transaktion vergeben wie der Beleg — nur so bleibt die Folge lückenlos, wie
es Art. 957a OR verlangt.

**4. Momentaufnahmen statt Verweise bei Preisen und Adressen.** Buchungen,
Offerten und Rechnungen speichern Bezeichnung, Ansatz und Empfängeranschrift
als Kopie. Ändert sich der Katalog oder zieht die Kundschaft um, bleibt der
Beleg so lesbar, wie er ausgestellt wurde.

## Bereichsübersicht

```mermaid
flowchart LR
  stammdaten["Mandant und Stammdaten<br/><small>6 Modelle</small>"]
  identitaet["Identität und Zugriff<br/><small>5 Modelle</small>"]
  crm["CRM<br/><small>13 Modelle</small>"]
  katalog["Leistungskatalog und Preislogik<br/><small>6 Modelle</small>"]
  auftrag["Buchung, Offerte, Einsatz<br/><small>10 Modelle</small>"]
  personal["Personal und Zeit<br/><small>7 Modelle</small>"]
  finanzen["Finanzen<br/><small>8 Modelle</small>"]
  kommunikation["Kommunikation und Automatisierung<br/><small>10 Modelle</small>"]
  marketing["Marketing und Inhalte<br/><small>13 Modelle</small>"]
  redaktion["Redaktion<br/><small>6 Modelle</small>"]
  fuehrung["Unternehmensführung<br/><small>26 Modelle</small>"]
  stammdaten --> identitaet
  identitaet --> crm
  crm --> auftrag
  katalog --> auftrag
  auftrag --> personal
  auftrag --> finanzen
  crm --> kommunikation
  crm --> marketing
  stammdaten --> redaktion
```

## Mandant und Stammdaten

Die `Organization` ist die Wurzel des Mandanten: nahezu jede Tabelle hängt über `organizationId` daran. Die Plattform ist heute einmandantig betrieben, das Schema aber bereits mehrmandantenfähig — eine nachträgliche Einführung dieser Spalte über fünfzig Tabellen wäre eine Migration, die man nicht zweimal machen will. `NumberSequence` erzeugt die lückenlosen Belegnummern innerhalb der jeweiligen Geschäftstransaktion.

```mermaid
erDiagram
  Organization {
    String id PK
    String slug UK
    String name
    String legalName
    String email
    String phone
    String website
    String street
  }
  NumberSequence {
    String id PK
    String organizationId
    String scope
    Int year
    Int current
  }
  OpeningHours {
    String id PK
    String organizationId
    Int weekday
    String opensAt
    String closesAt
    Boolean closed
  }
  Holiday {
    String id PK
    String organizationId
    String name
    DateTime date
    Boolean recurring
    String canton
  }
  ServiceArea {
    String id PK
    String organizationId
    String postalCode
    String city
    String canton
    Decimal travelFee
    Int travelMinutes
    Boolean active
  }
  TaxRate {
    String id PK
    String organizationId
    String name
    Decimal rate
    Boolean isDefault
    Boolean active
  }
  Organization ||--o{ NumberSequence : "organization"
  Organization ||--o{ OpeningHours : "organization"
  Organization ||--o{ Holiday : "organization"
  Organization ||--o{ ServiceArea : "organization"
  Organization ||--o{ TaxRate : "organization"
```

| Modell | Tabelle | Felder | Zweck |
| --- | --- | --- | --- |
| `Organization` | `organizations` | 107 | – |
| `NumberSequence` | `number_sequences` | 6 | – |
| `OpeningHours` | `opening_hours` | 7 | – |
| `Holiday` | `holidays` | 7 | – |
| `ServiceArea` | `service_areas` | 11 | – |
| `TaxRate` | `tax_rates` | 7 | – |

## Identität und Zugriff

`User` trägt Anmeldung und Rolle; `Customer` und `Employee` sind die fachlichen Profile daneben. Diese Trennung erlaubt Gastbuchungen ohne Konto und Kundendatensätze, die erst später ein Login erhalten. `RefreshToken` speichert nur den SHA-256-Hash und eine Familien-ID — daran erkennt die Rotation die Wiederverwendung eines bereits verbrauchten Tokens. `AuditLog` und `Consent` sind die Nachweisschicht für das Schweizer DSG und die DSGVO.

```mermaid
erDiagram
  User {
    String id PK
    String organizationId
    String email UK
    DateTime emailVerified
    String phone
    String passwordHash
    String firstName
    String lastName
  }
  RefreshToken {
    String id PK
    String userId
    String tokenHash UK
    String family
    String userAgent
    String ip
    DateTime expiresAt
    DateTime revokedAt
  }
  VerificationToken {
    String id PK
    String userId
    String email
    String tokenHash UK
    String purpose
    DateTime expiresAt
    DateTime usedAt
    DateTime createdAt
  }
  Consent {
    String id PK
    String userId
    ConsentType type
    Boolean granted
    String version
    String ip
    String userAgent
    DateTime grantedAt
  }
  AuditLog {
    String id PK
    String organizationId
    String userId
    AuditAction action
    String entity
    String entityId
    String summary
    Json changes
  }
  User ||--o{ RefreshToken : "user"
  User |o--o{ VerificationToken : "user"
  User ||--o{ Consent : "user"
  User |o--o{ AuditLog : "user"
```

| Modell | Tabelle | Felder | Zweck |
| --- | --- | --- | --- |
| `User` | `users` | 51 | – |
| `RefreshToken` | `refresh_tokens` | 10 | – |
| `VerificationToken` | `verification_tokens` | 9 | – |
| `Consent` | `consents` | 9 | – |
| `AuditLog` | `audit_logs` | 13 | – |

## CRM

Der Weg einer Anfrage: `Lead` → `Customer` → `Property`. Adressen und Objekte sind eigene Tabellen, weil ein Geschäftskunde mehrere Liegenschaften hat und eine Rechnungsadresse selten die Einsatzadresse ist. `Activity` ist die gemeinsame Zeitachse über Kundschaft, Anfragen, Einsätze und Belege.

```mermaid
erDiagram
  PipelineStage {
    String id PK
    String organizationId
    String name
    String key
    String color
    Int position
    Boolean isWon
    Boolean isLost
  }
  Tag {
    String id PK
    String organizationId
    String name
    String color
  }
  Lead {
    String id PK
    String organizationId
    String number
    String firstName
    String lastName
    String email
    String phone
    String company
  }
  LeadTag {
    String leadId
    String tagId
  }
  Customer {
    String id PK
    String organizationId
    String number
    String userId UK
    CustomerType type
    String companyName
    String firstName
    String lastName
  }
  CustomerTag {
    String customerId
    String tagId
  }
  Contact {
    String id PK
    String customerId
    String firstName
    String lastName
    String position
    String email
    String phone
    String mobile
  }
  Address {
    String id PK
    String customerId
    String label
    String firstName
    String lastName
    String company
    String street
    String streetNo
  }
  Building {
    String id PK
    String name
    String street
    String postalCode
    String city
    String canton
    Int floors
    Int units
  }
  Property {
    String id PK
    String customerId
    String addressId
    String buildingId
    String label
    PropertyKind kind
    Int squareMeters
    Decimal rooms
  }
  PaymentMethodRef {
    String id PK
    String customerId
    String provider
    PaymentMethod type
    String externalId
    String brand
    String last4
    Int expMonth
  }
  Activity {
    String id PK
    ActivityType type
    String subject
    String body
    Json metadata
    String customerId
    String leadId
    String jobId
  }
  Task {
    String id PK
    String title
    String description
    TaskStatus status
    TaskPriority priority
    DateTime dueAt
    DateTime completedAt
    DateTime reminderAt
  }
  PipelineStage |o--o{ Lead : "stage"
  Customer |o--o{ Lead : "customer"
  Lead ||--o{ LeadTag : "lead"
  Tag ||--o{ LeadTag : "tag"
  Customer |o--o{ Customer : "referredBy"
  Customer ||--o{ CustomerTag : "customer"
  Tag ||--o{ CustomerTag : "tag"
  Customer ||--o{ Contact : "customer"
  Customer ||--o{ Address : "customer"
  Customer ||--o{ Property : "customer"
  Address |o--o{ Property : "address"
  Building |o--o{ Property : "building"
  Customer ||--o{ PaymentMethodRef : "customer"
  Customer |o--o{ Activity : "customer"
  Lead |o--o{ Activity : "lead"
  Customer |o--o{ Task : "customer"
  Lead |o--o{ Task : "lead"
```

| Modell | Tabelle | Felder | Zweck |
| --- | --- | --- | --- |
| `Lead` | `leads` | 39 | – |
| `Customer` | `customers` | 56 | – |
| `Contact` | `contacts` | 13 | – |
| `Address` | `addresses` | 25 | – |
| `Building` | `buildings` | 17 | – |
| `Property` | `properties` | 30 | – |
| `PipelineStage` | `pipeline_stages` | 10 | – |
| `Tag` | `tags` | 7 | – |
| `LeadTag` | `lead_tags` | 4 | – |
| `CustomerTag` | `customer_tags` | 4 | – |
| `Activity` | `activities` | 22 | – |
| `Task` | `tasks` | 26 | – |
| `PaymentMethodRef` | `payment_methods` | 12 | – |

## Leistungskatalog und Preislogik

Der Katalog bestimmt, was angeboten wird und was es kostet. `PriceRule` trägt die Bedingung als JSON und wird von `lib/pricing/engine.ts` ausgewertet — so lassen sich Wochenend- und Flächenzuschläge ohne Codeänderung ergänzen. Preise gelten immer serverseitig; der Browser rechnet nur mit, um sofort etwas anzeigen zu können.

```mermaid
erDiagram
  ServiceCategory {
    String id PK
    String organizationId
    String slug
    String name
    String nameEn
    String nameFr
    String nameIt
    String description
  }
  Service {
    String id PK
    String organizationId
    String categoryId
    String slug
    ServiceKind kind
    String name
    String nameEn
    String nameFr
  }
  ServiceExtra {
    String id PK
    String organizationId
    String slug
    String name
    String description
    String icon
    Decimal price
    PricingModel pricingModel
  }
  ServiceExtraOnService {
    String serviceId
    String extraId
  }
  PriceRule {
    String id PK
    String serviceId
    String name
    Json condition
    Decimal multiplier
    Decimal surcharge
    Int priority
    Boolean active
  }
  RecurrenceRule {
    String id PK
    Frequency frequency
    Int interval
    Int_list weekdays
    Int monthDay
    DateTime startDate
    DateTime endDate
    Int count
  }
  ServiceCategory |o--o{ Service : "category"
  Service ||--o{ ServiceExtraOnService : "service"
  ServiceExtra ||--o{ ServiceExtraOnService : "extra"
  Service |o--o{ PriceRule : "service"
```

| Modell | Tabelle | Felder | Zweck |
| --- | --- | --- | --- |
| `ServiceCategory` | `service_categories` | 13 | – |
| `Service` | `services` | 42 | – |
| `ServiceExtra` | `service_extras` | 15 | – |
| `ServiceExtraOnService` | `service_extras_on_services` | 4 | – |
| `PriceRule` | `price_rules` | 9 | – |
| `RecurrenceRule` | `recurrence_rules` | 13 | – |

## Buchung, Offerte, Einsatz

Die drei Formen eines Auftrags. `Booking` ist die Vereinbarung mit der Kundschaft, `Job` die Ausführung durch das Team — getrennt, weil eine wöchentliche Buchung zweiundfünfzig Einsätze erzeugt. Preise werden in der Buchung als Momentaufnahme festgehalten: ändert sich der Katalog, bleibt der vereinbarte Preis gültig.

```mermaid
erDiagram
  Booking {
    String id PK
    String organizationId
    String number
    String customerId
    String addressId
    String propertyId
    String quoteId UK
    BookingStatus status
  }
  BookingItem {
    String id PK
    String bookingId
    String serviceId
    String name
    String description
    Decimal quantity
    String unit
    Decimal unitPrice
  }
  BookingExtra {
    String id PK
    String bookingId
    String extraId
    String name
    Int quantity
    Decimal unitPrice
    Decimal lineTotal
    Int durationMin
  }
  Quote {
    String id PK
    String organizationId
    String number
    String customerId
    String leadId
    String propertyId
    String title
    QuoteStatus status
  }
  QuoteItem {
    String id PK
    String quoteId
    String serviceId
    String name
    String description
    Decimal quantity
    String unit
    Decimal unitPrice
  }
  Job {
    String id PK
    String organizationId
    String number
    String bookingId
    String customerId
    String addressId
    String propertyId
    String serviceId
  }
  JobAssignment {
    String id PK
    String jobId
    String employeeId
    AssignmentRole role
    DateTime acceptedAt
    DateTime declinedAt
    String declineReason
    DateTime notifiedAt
  }
  JobChecklistItem {
    String id PK
    String jobId
    String label
    String room
    Boolean required
    Boolean done
    DateTime doneAt
    String doneById
  }
  JobPhoto {
    String id PK
    String jobId
    JobPhotoType type
    String url
    String thumbnailUrl
    String caption
    String room
    Float lat
  }
  MaterialUsage {
    String id PK
    String jobId
    String name
    String sku
    Decimal quantity
    String unit
    Decimal unitCost
    Decimal total
  }
  Quote |o--|| Booking : "quote"
  Booking |o--o{ Booking : "parentBooking"
  Booking ||--o{ BookingItem : "booking"
  Booking ||--o{ BookingExtra : "booking"
  Booking |o--o{ Quote : "booking"
  Quote ||--o{ QuoteItem : "quote"
  Booking |o--o{ Job : "booking"
  Job ||--o{ JobAssignment : "job"
  Job ||--o{ JobChecklistItem : "job"
  Job ||--o{ JobPhoto : "job"
  Job ||--o{ MaterialUsage : "job"
```

| Modell | Tabelle | Felder | Zweck |
| --- | --- | --- | --- |
| `Booking` | `bookings` | 61 | – |
| `BookingItem` | `booking_items` | 14 | – |
| `BookingExtra` | `booking_extras` | 10 | – |
| `Quote` | `quotes` | 47 | – |
| `QuoteItem` | `quote_items` | 15 | – |
| `Job` | `jobs` | 49 | – |
| `JobAssignment` | `job_assignments` | 11 | – |
| `JobChecklistItem` | `job_checklist_items` | 11 | – |
| `JobPhoto` | `job_photos` | 12 | – |
| `MaterialUsage` | `material_usages` | 11 | – |

## Personal und Zeit

`TimeEntry` ist die Grundlage der Lohnabrechnung, `GpsEvent` belegt An- und Abfahrt bei Objekten ohne Ansprechperson. `Availability` und `Absence` speisen die Disposition: wer abwesend ist, erscheint gar nicht erst als Vorschlag.

```mermaid
erDiagram
  TimeEntry {
    String id PK
    String jobId
    String employeeId
    DateTime startedAt
    DateTime endedAt
    Int breakMin
    Int minutes
    String note
  }
  GpsEvent {
    String id PK
    String jobId
    String employeeId
    String type
    Float lat
    Float lng
    Float accuracy
    Float distanceM
  }
  Employee {
    String id PK
    String organizationId
    String userId UK
    String employeeNumber
    EmploymentType employmentType
    String position
    String department
    DateTime hiredAt
  }
  EmployeeSkill {
    String id PK
    String employeeId
    String name
    Int level
    DateTime certifiedUntil
  }
  Availability {
    String id PK
    String employeeId
    Int weekday
    String startTime
    String endTime
  }
  Absence {
    String id PK
    String employeeId
    AbsenceType type
    AbsenceStatus status
    DateTime startDate
    DateTime endDate
    Boolean halfDay
    Decimal days
  }
  Payslip {
    String id PK
    String employeeId
    Int year
    Int month
    Decimal hours
    Decimal grossPay
    Decimal ahvIv
    Decimal alv
  }
  Employee ||--o{ TimeEntry : "employee"
  Employee ||--o{ GpsEvent : "employee"
  Employee ||--o{ EmployeeSkill : "employee"
  Employee ||--o{ Availability : "employee"
  Employee ||--o{ Absence : "employee"
  Employee ||--o{ Payslip : "employee"
```

| Modell | Tabelle | Felder | Zweck |
| --- | --- | --- | --- |
| `Employee` | `employees` | 39 | – |
| `EmployeeSkill` | `employee_skills` | 6 | – |
| `Availability` | `availabilities` | 6 | – |
| `Absence` | `absences` | 15 | – |
| `Payslip` | `payslips` | 16 | – |
| `TimeEntry` | `time_entries` | 16 | – |
| `GpsEvent` | `gps_events` | 12 | – |

## Finanzen

Finanzbelege sind fortschreibend, nie überschreibend: eine ausgestellte `Invoice` wird nicht mehr geändert, Korrekturen laufen über `CreditNote`. Das verlangt die Aufbewahrungspflicht nach Art. 957a OR. `Payment.providerPaymentId` ist eindeutig — daran erkennt der Stripe-Webhook eine bereits gebuchte Zahlung und bleibt idempotent.

```mermaid
erDiagram
  Invoice {
    String id PK
    String organizationId
    String number
    String customerId
    String bookingId
    String quoteId
    InvoiceStatus status
    DateTime issueDate
  }
  InvoiceItem {
    String id PK
    String invoiceId
    String jobId
    String name
    String description
    Decimal quantity
    String unit
    Decimal unitPrice
  }
  Payment {
    String id PK
    String invoiceId
    String customerId
    Decimal amount
    String currency
    PaymentMethod method
    PaymentStatus status
    String reference
  }
  PaymentReminder {
    String id PK
    String invoiceId
    Int level
    Decimal fee
    DateTime sentAt
    NotificationChannel channel
    String pdfUrl
  }
  CreditNote {
    String id PK
    String organizationId
    String number
    String invoiceId
    String customerId
    String reason
    DateTime issueDate
    Decimal netTotal
  }
  Supplier {
    String id PK
    String organizationId
    String name
    String contactName
    String email
    String phone
    String street
    String postalCode
  }
  Expense {
    String id PK
    String organizationId
    String supplierId
    ExpenseCategory category
    String description
    String reference
    DateTime expenseDate
    Decimal netAmount
  }
  AccountingExport {
    String id PK
    String organizationId
    String format
    DateTime periodFrom
    DateTime periodTo
    String fileUrl
    Int rowCount
    String createdById
  }
  Invoice ||--o{ InvoiceItem : "invoice"
  Invoice |o--o{ Payment : "invoice"
  Invoice ||--o{ PaymentReminder : "invoice"
  Invoice |o--o{ CreditNote : "invoice"
  Supplier |o--o{ Expense : "supplier"
```

| Modell | Tabelle | Felder | Zweck |
| --- | --- | --- | --- |
| `Invoice` | `invoices` | 56 | – |
| `InvoiceItem` | `invoice_items` | 16 | – |
| `Payment` | `payments` | 21 | – |
| `PaymentReminder` | `payment_reminders` | 8 | – |
| `CreditNote` | `credit_notes` | 17 | – |
| `Supplier` | `suppliers` | 21 | – |
| `Expense` | `expenses` | 23 | – |
| `AccountingExport` | `accounting_exports` | 10 | – |

## Kommunikation und Automatisierung

Jeder ausgehende Versand wird protokolliert (`EmailLog`, `SmsLog`) — bei einer Reklamation muss belegbar sein, was wann an wen ging. `Automation` beschreibt Auslöser und Aktionen als Daten, damit sich Abläufe ohne Codeänderung anpassen lassen.

```mermaid
erDiagram
  MessageThread {
    String id PK
    String customerId
    String jobId
    String subject
    Boolean closed
    DateTime lastMessageAt
    DateTime createdAt
  }
  Message {
    String id PK
    String threadId
    String authorId
    MessageAuthorType authorType
    String body
    DateTime readAt
    DateTime createdAt
  }
  Notification {
    String id PK
    String userId
    NotificationChannel channel
    NotificationStatus status
    String title
    String body
    String link
    Json meta
  }
  EmailTemplate {
    String id PK
    String organizationId
    String key
    Locale locale
    String subject
    String bodyHtml
    String bodyText
    Boolean active
  }
  SmsTemplate {
    String id PK
    String organizationId
    String key
    Locale locale
    String body
    Boolean active
  }
  EmailLog {
    String id PK
    String to
    String from
    String subject
    String templateKey
    String providerId
    String status
    String error
  }
  SmsLog {
    String id PK
    String to
    String body
    String providerId
    String status
    String error
    Int segments
    Decimal cost
  }
  Automation {
    String id PK
    String organizationId
    String name
    String description
    AutomationTrigger trigger
    Json conditions
    Int delayMinutes
    Boolean active
  }
  AutomationAction {
    String id PK
    String automationId
    AutomationActionType type
    Json config
    Int position
  }
  AutomationRun {
    String id PK
    String automationId
    String entity
    String entityId
    AutomationRunStatus status
    DateTime scheduledFor
    DateTime startedAt
    DateTime finishedAt
  }
  MessageThread ||--o{ Message : "thread"
  Automation ||--o{ AutomationAction : "automation"
  Automation ||--o{ AutomationRun : "automation"
```

| Modell | Tabelle | Felder | Zweck |
| --- | --- | --- | --- |
| `MessageThread` | `message_threads` | 10 | – |
| `Message` | `messages` | 10 | – |
| `Notification` | `notifications` | 13 | – |
| `EmailTemplate` | `email_templates` | 11 | – |
| `SmsTemplate` | `sms_templates` | 7 | – |
| `EmailLog` | `email_logs` | 13 | – |
| `SmsLog` | `sms_logs` | 11 | – |
| `Automation` | `automations` | 13 | – |
| `AutomationAction` | `automation_actions` | 6 | – |
| `AutomationRun` | `automation_runs` | 12 | – |

## Marketing und Inhalte

Website-Inhalte und Vertriebsinstrumente. Bewertungen durchlaufen immer die Moderation, bevor sie öffentlich werden — veröffentlicht wird auch die kritische, aber erst nachdem der Betrieb sie gesehen und beantwortet hat.

```mermaid
erDiagram
  Coupon {
    String id PK
    String organizationId
    String code
    String description
    DiscountType discountType
    Decimal discountValue
    Decimal minOrderValue
    Decimal maxDiscount
  }
  GiftCard {
    String id PK
    String organizationId
    String code UK
    Decimal initialValue
    Decimal balance
    String currency
    String purchasedById
    String recipientName
  }
  NewsletterSubscriber {
    String id PK
    String organizationId
    String email
    String firstName
    Locale locale
    Boolean confirmed
    String confirmToken UK
    String unsubscribeToken UK
  }
  BlogCategory {
    String id PK
    String organizationId
    String slug
    String name
    String description
  }
  BlogPost {
    String id PK
    String organizationId
    String categoryId
    String authorId
    String slug
    Locale locale
    String title
    String excerpt
  }
  StoredFile {
    String id PK
    String organizationId
    String path
    String mimeType
    Int sizeBytes
    Int maxBytes
    Bytes data
    String uploadedById
  }
  LandingPage {
    String id PK
    String organizationId
    String slug
    Locale locale
    String title
    PostStatus status
    Json blocks
    String seoTitle
  }
  Review {
    String id PK
    String organizationId
    String customerId
    String bookingId
    String userId
    String authorName
    Int rating
    String title
  }
  Faq {
    String id PK
    String organizationId
    Locale locale
    String category
    String question
    String answer
    Int position
    Boolean active
  }
  GalleryItem {
    String id PK
    String organizationId
    String title
    String description
    ServiceKind serviceKind
    String beforeUrl
    String afterUrl
    String location
  }
  JobPosting {
    String id PK
    String organizationId
    String slug
    String title
    String location
    EmploymentType employmentType
    Int workloadFrom
    Int workloadTo
  }
  JobApplication {
    String id PK
    String postingId
    String firstName
    String lastName
    String email
    String phone
    String message
    String cvUrl
  }
  FileAsset {
    String id PK
    String organizationId
    FileScope scope
    String bucket
    String path
    String url
    String filename
    String mimeType
  }
  BlogCategory |o--o{ BlogPost : "category"
  JobPosting ||--o{ JobApplication : "posting"
  JobApplication |o--o{ FileAsset : "application"
```

| Modell | Tabelle | Felder | Zweck |
| --- | --- | --- | --- |
| `Coupon` | `coupons` | 19 | – |
| `GiftCard` | `gift_cards` | 16 | – |
| `NewsletterSubscriber` | `newsletter_subscribers` | 12 | – |
| `BlogCategory` | `blog_categories` | 7 | – |
| `BlogPost` | `blog_posts` | 22 | – |
| `LandingPage` | `landing_pages` | 13 | – |
| `Review` | `reviews` | 22 | – |
| `Faq` | `faqs` | 9 | – |
| `GalleryItem` | `gallery_items` | 13 | – |
| `JobPosting` | `job_postings` | 20 | – |
| `JobApplication` | `job_applications` | 16 | – |
| `FileAsset` | `file_assets` | 48 | – |
| `StoredFile` | `stored_files` | 12 | – |

## Redaktion

Die Texte der öffentlichen Website. `ContentBlock` ist ein Schlüssel-Wert-Speicher; welche Schlüssel gültig sind und welcher Text gilt, solange nichts gepflegt wurde, steht als Register im Code (`lib/cms/registry.ts`). Daraus folgt, dass eine fehlende Zeile die Website nicht zerlegt — sie zeigt dann den Auslieferungstext. `SeoMeta` hängt bewusst an einer *Route* und nicht an einem Baustein: `noIndex` ist eine technische Schaltung, die eine Seite aus dem Suchindex wirft.

```mermaid
erDiagram
  ContentBlock {
    String id PK
    String organizationId
    String key
    Locale locale
    Json value
    Json draftValue
    DateTime publishedAt
    String updatedById
  }
  ContentRevision {
    String id PK
    String organizationId
    String blockId
    String key
    Locale locale
    Json value
    String createdById
    DateTime createdAt
  }
  SeoMeta {
    String id PK
    String organizationId
    String path
    Locale locale
    String title
    String description
    String_list keywords
    String ogImageUrl
  }
  CallToAction {
    String id PK
    String organizationId
    String key
    String label
    String note
    String href
    Boolean newTab
    String icon
  }
  NavigationItem {
    String id PK
    String organizationId
    NavLocation location
    String label
    String href
    String description
    String icon
    Boolean newTab
  }
  LegalDocument {
    String id PK
    String organizationId
    String slug
    String title
    String body
    Int version
    DateTime effectiveFrom
    DateTime createdAt
  }
  ContentBlock ||--o{ ContentRevision : "block"
  NavigationItem |o--o{ NavigationItem : "parent"
```

| Modell | Tabelle | Felder | Zweck |
| --- | --- | --- | --- |
| `ContentBlock` | `content_blocks` | 12 | – |
| `ContentRevision` | `content_revisions` | 10 | – |
| `SeoMeta` | `seo_meta` | 13 | – |
| `CallToAction` | `calls_to_action` | 21 | – |
| `NavigationItem` | `navigation_items` | 16 | – |
| `LegalDocument` | `legal_documents` | 10 | – |

## Unternehmensführung

Kennzahlen, Ziele, Finanzplanung, Risiko und Qualität, Wissen und Berichte. Der wichtigste Entscheid: `KpiSnapshot` speichert den Verlauf, statt ihn bei jedem Aufruf neu zu rechnen — eine live gerechnete Kurve schreibt die Vergangenheit um, sobald eine Buchung storniert oder eine Gutschrift gebucht wird. Strategie, Ziel und Initiative sind *ein* Modell (`Objective`) mit Selbstbezug; die Roadmap ist nur eine Ansicht davon. Massnahmen (`CorrectiveAction`) und Sitzungspendenzen laufen über `Task`, damit es nur eine Pendenzenliste gibt. `ManagedDocument` trägt die Sichtbarkeit als Spalte, die in der Prisma-Abfrage wirkt — `EMPLOYEE_PRIVATE` heisst Geschäftsleitung und betroffene Person.

```mermaid
erDiagram
  KpiDefinition {
    String id PK
    String organizationId
    String key
    String label
    String description
    String group
    KpiUnit unit
    KpiDirection direction
  }
  KpiTarget {
    String id PK
    String definitionId
    KpiPeriod period
    DateTime periodStart
    Decimal targetValue
    String note
    DateTime createdAt
  }
  KpiSnapshot {
    String id PK
    String organizationId
    String definitionId
    KpiPeriod period
    DateTime periodStart
    DateTime periodEnd
    Decimal value
    Decimal targetValue
  }
  HealthSnapshot {
    String id PK
    String organizationId
    DateTime takenOn
    Int score
    Int scoreDelta
    Json components
    String topRisk
    DateTime createdAt
  }
  Objective {
    String id PK
    String organizationId
    ObjectiveHorizon horizon
    ObjectiveLevel level
    ObjectiveStatus status
    String title
    String description
    String department
  }
  KeyResult {
    String id PK
    String objectiveId
    String title
    String kpiDefinitionId
    KpiPeriod kpiPeriod
    KpiUnit unit
    KpiDirection direction
    Decimal startValue
  }
  KeyResultCheckin {
    String id PK
    String keyResultId
    Decimal value
    String comment
    Boolean automatic
    String authorId
    DateTime recordedAt
  }
  BudgetPeriod {
    String id PK
    String organizationId
    String name
    Int fiscalYear
    DateTime startsOn
    DateTime endsOn
    BudgetStatus status
    DateTime approvedAt
  }
  BudgetLine {
    String id PK
    String periodId
    ExpenseCategory category
    String label
    Decimal plannedAmount
    Decimal revisedAmount
    Decimal_list monthlyPlan
    String note
  }
  Investment {
    String id PK
    String organizationId
    String name
    ExpenseCategory category
    InvestmentStatus status
    String description
    String supplierId
    Decimal purchaseAmount
  }
  Scenario {
    String id PK
    String organizationId
    String name
    ScenarioKind kind
    Int fiscalYear
    Int horizonMonths
    String description
    Decimal openingCash
  }
  ScenarioAssumption {
    String id PK
    String scenarioId
    String key
    String label
    Decimal value
    KpiUnit unit
    Decimal monthlyChangePct
    String note
  }
  RiskEntry {
    String id PK
    String organizationId
    String title
    String description
    RiskCategory category
    RiskStatus status
    Int probability
    Int impact
  }
  ControlEntry {
    String id PK
    String organizationId
    ControlKind kind
    ControlStatus status
    String reference
    String title
    String description
    String evidenceNote
  }
  CorrectiveAction {
    String id PK
    String organizationId
    ActionKind kind
    String title
    String rootCause
    String description
    String riskId
    String controlId
  }
  ManagedDocument {
    String id PK
    String organizationId
    String title
    DocumentCategory category
    DocumentVisibility visibility
    String description
    String_list tags
    String subjectEmployeeId
  }
  DocumentVersion {
    String id PK
    String documentId
    Int version
    String fileAssetId
    String changeNote
    String uploadedById
    DateTime createdAt
  }
  KnowledgeArticle {
    String id PK
    String organizationId
    String slug
    String title
    String summary
    String body
    String category
    String_list tags
  }
  Competitor {
    String id PK
    String organizationId
    String name
    String website
    String region
    String_list services
    Decimal priceFrom
    Decimal priceTo
  }
  MarketInsight {
    String id PK
    String organizationId
    InsightKind kind
    String title
    String body
    String sourceUrl
    String sourceName
    DateTime observedOn
  }
  AnalysisBoard {
    String id PK
    String organizationId
    AnalysisKind kind
    String title
    DateTime preparedOn
    String summary
    String supersededById UK
    Int reviewIntervalDays
  }
  AnalysisEntry {
    String id PK
    String boardId
    AnalysisBucket bucket
    String title
    String detail
    Int weight
    Int sortOrder
  }
  Meeting {
    String id PK
    String organizationId
    String title
    DateTime heldAt
    String location
    String agenda
    String minutes
    String decisions
  }
  MeetingParticipant {
    String id PK
    String meetingId
    String userId
    Boolean attended
  }
  ReportSchedule {
    String id PK
    String organizationId
    String name
    ReportKind kind
    ReportCadence cadence
    ReportFormat format
    Int runOnDay
    String_list recipients
  }
  ReportRun {
    String id PK
    String scheduleId
    String organizationId
    ReportKind kind
    ReportFormat format
    DateTime periodStart
    DateTime periodEnd
    String fileAssetId
  }
  KpiDefinition ||--o{ KpiTarget : "definition"
  KpiDefinition ||--o{ KpiSnapshot : "definition"
  Objective |o--o{ Objective : "parent"
  Objective ||--o{ KeyResult : "objective"
  KpiDefinition |o--o{ KeyResult : "definition"
  KeyResult ||--o{ KeyResultCheckin : "keyResult"
  BudgetPeriod ||--o{ BudgetLine : "period"
  Scenario ||--o{ ScenarioAssumption : "scenario"
  RiskEntry |o--o{ CorrectiveAction : "risk"
  ControlEntry |o--o{ CorrectiveAction : "control"
  DocumentVersion |o--|| ManagedDocument : "currentVersion"
  ManagedDocument ||--o{ DocumentVersion : "document"
  ManagedDocument |o--o{ DocumentVersion : "current"
  AnalysisBoard |o--|| AnalysisBoard : "supersededBy"
  AnalysisBoard |o--o{ AnalysisBoard : "supersedes"
  AnalysisBoard ||--o{ AnalysisEntry : "board"
  Objective |o--o{ Meeting : "objective"
  Meeting ||--o{ MeetingParticipant : "meeting"
  ReportSchedule |o--o{ ReportRun : "schedule"
```

| Modell | Tabelle | Felder | Zweck |
| --- | --- | --- | --- |
| `KpiDefinition` | `kpi_definitions` | 21 | – |
| `KpiTarget` | `kpi_targets` | 8 | – |
| `KpiSnapshot` | `kpi_snapshots` | 15 | – |
| `HealthSnapshot` | `health_snapshots` | 9 | – |
| `Objective` | `objectives` | 33 | – |
| `KeyResult` | `key_results` | 18 | – |
| `KeyResultCheckin` | `key_result_checkins` | 9 | – |
| `BudgetPeriod` | `budget_periods` | 14 | – |
| `BudgetLine` | `budget_lines` | 12 | – |
| `Investment` | `investments` | 28 | – |
| `Scenario` | `scenarios` | 16 | – |
| `ScenarioAssumption` | `scenario_assumptions` | 10 | – |
| `RiskEntry` | `risk_entries` | 28 | – |
| `ControlEntry` | `control_entries` | 20 | – |
| `CorrectiveAction` | `corrective_actions` | 22 | – |
| `ManagedDocument` | `managed_documents` | 23 | – |
| `DocumentVersion` | `document_versions` | 10 | – |
| `KnowledgeArticle` | `knowledge_articles` | 21 | – |
| `Competitor` | `competitors` | 22 | – |
| `MarketInsight` | `market_insights` | 16 | – |
| `AnalysisBoard` | `analysis_boards` | 16 | – |
| `AnalysisEntry` | `analysis_entries` | 8 | – |
| `Meeting` | `meetings` | 19 | – |
| `MeetingParticipant` | `meeting_participants` | 6 | – |
| `ReportSchedule` | `report_schedules` | 15 | – |
| `ReportRun` | `report_runs` | 16 | – |

## Aufzählungstypen

PostgreSQL-`ENUM`-Typen statt Textspalten mit Prüfbedingung: die Datenbank
weist einen unbekannten Wert von sich aus zurück, und Prisma erzeugt daraus
exakte TypeScript-Typen.

| Typ | Werte |
| --- | --- |
| `Locale` | `DE`, `EN`, `FR`, `IT` |
| `UserRole` |  |
| `UserStatus` | `PENDING`, `ACTIVE`, `SUSPENDED`, `DISABLED` |
| `CustomerType` | `PRIVATE`, `BUSINESS` |
| `LeadStatus` | `NEW`, `CONTACTED`, `QUALIFIED`, `PROPOSAL`, `WON`, `LOST` |
| `LeadSource` | `WEBSITE`, `PHONE`, `EMAIL`, `REFERRAL`, `GOOGLE_ADS`, `META_ADS`, `SEO`, `WALK_IN`, `PARTNER`, `OTHER` |
| `PropertyKind` | `APARTMENT`, `HOUSE`, `OFFICE`, `COMMERCIAL`, `INDUSTRIAL`, `CONSTRUCTION_SITE`, `PRACTICE`, `RESTAURANT`, `SCHOOL`, `OTHER` |
| `ServiceKind` | `OFFICE_CLEANING`, `MOVE_OUT_CLEANING`, `RESIDENTIAL_CLEANING`, `WINDOW_CLEANING`, `CONSTRUCTION_CLEANING`, `BUILDING_MAINTENANCE`, `SPECIAL` |
| `PricingModel` | `PER_HOUR`, `PER_SQM`, `FLAT`, `PER_UNIT`, `ON_REQUEST` |
| `Frequency` | `ONCE`, `WEEKLY`, `BIWEEKLY`, `MONTHLY`, `QUARTERLY`, `SEMIANNUAL`, `ANNUAL`, `CUSTOM` |
| `BookingStatus` | `DRAFT`, `CONFIRMED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`, `NO_SHOW` |
| `QuoteStatus` | `DRAFT`, `SENT`, `VIEWED`, `ACCEPTED`, `REJECTED`, `EXPIRED`, `CONVERTED` |
| `JobStatus` | `UNASSIGNED`, `SCHEDULED`, `DISPATCHED`, `EN_ROUTE`, `IN_PROGRESS`, `ON_HOLD`, `COMPLETED`, `VERIFIED`, `CANCELLED` |
| `JobPhotoType` | `BEFORE`, `AFTER`, `DAMAGE`, `DOCUMENT`, `OTHER` |
| `AssignmentRole` | `LEAD`, `MEMBER`, `TRAINEE`, `SUPERVISOR` |
| `InvoiceStatus` | `DRAFT`, `ISSUED`, `SENT`, `PARTIALLY_PAID`, `PAID`, `OVERDUE`, `CANCELLED`, `WRITTEN_OFF` |
| `PaymentMethod` | `CARD`, `TWINT`, `BANK_TRANSFER`, `CASH`, `SEPA`, `GIFT_CARD`, `CREDIT_NOTE`, `OTHER` |
| `PaymentStatus` | `PENDING`, `PROCESSING`, `SUCCEEDED`, `FAILED`, `REFUNDED`, `PARTIALLY_REFUNDED`, `CANCELLED` |
| `ExpenseCategory` | `MATERIAL`, `EQUIPMENT`, `VEHICLE`, `FUEL`, `INSURANCE`, `RENT`, `SALARY`, `SOCIAL_SECURITY`, `MARKETING`, `SOFTWARE`, `TRAINING`, `TAXES`, `OTHER` |
| `AbsenceType` | `VACATION`, `SICK`, `ACCIDENT`, `MILITARY`, `MATERNITY`, `PATERNITY`, `UNPAID`, `TRAINING`, `PUBLIC_HOLIDAY`, `OTHER` |
| `AbsenceStatus` | `REQUESTED`, `APPROVED`, `REJECTED`, `CANCELLED` |
| `EmploymentType` | `FULL_TIME`, `PART_TIME`, `HOURLY`, `TEMPORARY`, `APPRENTICE`, `CONTRACTOR` |
| `ActivityType` | `NOTE`, `CALL`, `EMAIL`, `SMS`, `MEETING`, `TASK`, `STATUS_CHANGE`, `FILE_UPLOAD`, `SYSTEM` |
| `TaskPriority` | `LOW`, `NORMAL`, `HIGH`, `URGENT` |
| `TaskStatus` | `OPEN`, `IN_PROGRESS`, `DONE`, `CANCELLED` |
| `NotificationChannel` | `IN_APP`, `EMAIL`, `SMS`, `PUSH` |
| `NotificationStatus` | `QUEUED`, `SENT`, `DELIVERED`, `FAILED`, `READ` |
| `MessageAuthorType` | `CUSTOMER`, `STAFF`, `SYSTEM`, `AI` |
| `ReviewStatus` | `PENDING`, `PUBLISHED`, `REJECTED` |
| `DiscountType` | `PERCENT`, `FIXED` |
| `CouponStatus` | `ACTIVE`, `PAUSED`, `EXPIRED`, `DEPLETED` |
| `PostStatus` | `DRAFT`, `SCHEDULED`, `PUBLISHED`, `ARCHIVED` |
| `ApplicationStatus` | `RECEIVED`, `SCREENING`, `INTERVIEW`, `OFFER`, `HIRED`, `REJECTED`, `WITHDRAWN` |
| `AutomationTrigger` | `BOOKING_CREATED`, `BOOKING_CONFIRMED`, `BOOKING_REMINDER_24H`, `BOOKING_REMINDER_2H`, `BOOKING_COMPLETED`, `BOOKING_CANCELLED`, `QUOTE_SENT`, `QUOTE_ACCEPTED`, `QUOTE_EXPIRING`, `INVOICE_ISSUED`, `INVOICE_DUE_SOON`, `INVOICE_OVERDUE`, `JOB_ASSIGNED`, `JOB_COMPLETED`, `CUSTOMER_BIRTHDAY`, `REVIEW_REQUEST`, `LEAD_CREATED`, `LEAD_IDLE`, `TASK_DUE`, `RECURRING_BOOKING_GENERATE` |
| `AutomationActionType` | `SEND_EMAIL`, `SEND_SMS`, `CREATE_TASK`, `CREATE_NOTIFICATION`, `UPDATE_STATUS`, `WEBHOOK`, `AI_GENERATE` |
| `AutomationRunStatus` | `PENDING`, `RUNNING`, `SUCCESS`, `FAILED`, `SKIPPED` |
| `FileScope` | `BOOKING`, `QUOTE`, `INVOICE`, `JOB`, `CUSTOMER`, `EMPLOYEE`, `PROPERTY`, `BLOG`, `GALLERY`, `APPLICATION`, `EXPENSE`, `MESSAGE`, `OTHER`, `OBJECTIVE`, `INVESTMENT`, `RISK`, `CONTROL`, `DOCUMENT`, `ARTICLE`, `MEETING`, `REPORT` |
| `AuditAction` | `CREATE`, `UPDATE`, `DELETE`, `LOGIN`, `LOGIN_FAILED`, `LOGOUT`, `PASSWORD_RESET`, `PERMISSION_CHANGE`, `EXPORT`, `IMPORT`, `PAYMENT`, `ACCESS_DENIED` |
| `ConsentType` | `MARKETING_EMAIL`, `MARKETING_SMS`, `ANALYTICS`, `TERMS`, `PRIVACY`, `DATA_PROCESSING` |
| `CtaSlot` | `HEADER`, `HERO_PRIMARY`, `HERO_SECONDARY`, `SECTION_BANNER`, `FOOTER`, `MOBILE_BAR` |
| `CtaStyle` | `PRIMARY`, `SECONDARY`, `OUTLINE`, `GHOST`, `ACCENT`, `SUCCESS`, `CUSTOM` |
| `NavLocation` | `HEADER`, `HEADER_PANEL`, `FOOTER_SERVICES`, `FOOTER_COMPANY`, `FOOTER_LEGAL` |
| `KpiUnit` | `DAYS`, `HOURS` |
| `KpiDirection` | `UP_IS_GOOD`, `DOWN_IS_GOOD` |
| `KpiPeriod` | `DAY`, `WEEK`, `MONTH`, `QUARTER`, `YEAR` |
| `KpiSource` | `DERIVED`, `MANUAL` |
| `ObjectiveHorizon` |  |
| `ObjectiveLevel` | `COMPANY`, `DEPARTMENT`, `PERSONAL` |
| `ObjectiveStatus` | `DRAFT`, `ACTIVE`, `AT_RISK`, `ACHIEVED`, `MISSED`, `CANCELLED` |
| `BudgetStatus` | `DRAFT`, `APPROVED`, `CLOSED` |
| `InvestmentStatus` | `PLANNED`, `APPROVED`, `ORDERED`, `ACTIVE`, `DISPOSED`, `CANCELLED` |
| `DepreciationMethod` | `NONE` |
| `ScenarioKind` | `BEST`, `EXPECTED`, `WORST` |
| `RiskCategory` | `FINANCIAL`, `OPERATIONAL`, `PERSONNEL`, `LEGAL`, `DATA_PROTECTION`, `IT_SECURITY`, `REPUTATION`, `MARKET`, `ENVIRONMENT` |
| `RiskStatus` | `IDENTIFIED`, `ASSESSED`, `MITIGATING`, `ACCEPTED`, `CLOSED` |
| `ControlKind` |  |
| `ControlStatus` | `DRAFT`, `ACTIVE`, `DUE`, `NON_COMPLIANT`, `RETIRED` |
| `ActionKind` |  |
| `DocumentCategory` | `BUSINESS_PLAN`, `CONTRACT`, `INSURANCE`, `EMPLOYEE`, `CERTIFICATE`, `LICENSE`, `SUPPLIER`, `TAX`, `LEGAL`, `POLICY`, `OTHER` |
| `DocumentVisibility` |  |
| `ArticleStatus` | `DRAFT`, `PUBLISHED`, `ARCHIVED` |
| `InsightKind` | `INDUSTRY`, `CUSTOMER`, `COMPETITOR`, `TECHNOLOGY`, `ECONOMY`, `LEGAL`, `ENVIRONMENT` |
| `AnalysisKind` | `SWOT`, `PESTEL` |
| `AnalysisBucket` | `STRENGTH`, `WEAKNESS`, `OPPORTUNITY`, `THREAT`, `POLITICAL`, `ECONOMIC`, `SOCIAL`, `TECHNOLOGICAL`, `ENVIRONMENTAL`, `LEGAL` |
| `ReportKind` | `BUSINESS_PERFORMANCE`, `FINANCIAL`, `MARKETING`, `SALES`, `EMPLOYEE`, `CUSTOMER`, `QUARTERLY_REVIEW` |
| `ReportCadence` | `WEEKLY`, `MONTHLY`, `QUARTERLY`, `YEARLY` |
| `ReportFormat` | `PDF`, `XLSX`, `DOCX` |

## Migrationen

```bash
npm run db:migrate     # Entwicklung: Migration erzeugen und anwenden
npm run db:deploy      # Produktion: vorhandene Migrationen anwenden
npm run db:seed        # Schweizer Demodaten (idempotent)
npm run db:studio      # Prisma Studio
npm run erd            # diese Datei neu erzeugen
```

Die Erstmigration liegt in `prisma/migrations/`. Sie legt alle Aufzählungs-
typen, Tabellen, Indizes und Fremdschlüssel an; `npm run db:seed` füllt sie
anschliessend mit einem vollständigen Betrieb im Kanton Bern.
