import type { Metadata } from 'next';

import { LegalBody } from '@/components/marketing/legal-body';

import { getPublicCompanyInfo } from '@/server/services/organization.service';

export const metadata: Metadata = {
  title: 'Allgemeine Geschäftsbedingungen',
  description:
    'AGB der Clenaris Reinigungen GmbH: Vertragsschluss, Preise, Stornierung, Abgabegarantie, Haftung und Gerichtsstand.',
  alternates: { canonical: '/legal/agb' },
};

export const revalidate = 86400;

export default async function TermsPage() {
  const company = await getPublicCompanyInfo();

  return (
    <LegalBody slug="agb">
      <h1 className="text-headline font-bold">Allgemeine Geschäftsbedingungen</h1>
      <p className="text-sm text-muted-foreground">Stand: 1. Januar 2026</p>

      <h2>1. Geltungsbereich</h2>
      <p>
        Diese Bedingungen gelten für alle Verträge zwischen der{' '}
        {company.legalName ?? company.name} („wir“) und Auftraggebenden („Sie“) über
        Reinigungsdienstleistungen. Abweichende Bedingungen gelten nur, wenn wir ihnen schriftlich
        zugestimmt haben.
      </p>

      <h2>2. Vertragsschluss</h2>
      <p>
        Der Vertrag kommt zustande, wenn wir Ihre Buchung bestätigen — per E-Mail oder durch
        Freigabe im Kundenkonto. Bei Offerten gilt der Vertrag mit Ihrer Annahme als geschlossen;
        die digitale Annahme mit Namenseingabe und Unterschrift ist einer handschriftlichen
        gleichgestellt.
      </p>
      <p>
        Der im Buchungsprozess berechnete Preis ist verbindlich, sofern Ihre Angaben zum Objekt
        zutreffen. Weicht die tatsächliche Situation wesentlich ab, informieren wir Sie vor
        Arbeitsbeginn und holen Ihre Zustimmung ein.
      </p>

      <h2>3. Leistungsumfang</h2>
      <p>
        Der Umfang ergibt sich aus der gebuchten Leistung und den auf unserer Website
        veröffentlichten Leistungsbeschrieben. Reinigungsmittel und Geräte stellen wir. Wasser und
        Strom stellen Sie kostenlos zur Verfügung.
      </p>
      <p>
        Sie stellen sicher, dass wir zum vereinbarten Zeitpunkt Zugang zum Objekt haben. Ist das
        nicht der Fall und können wir nicht arbeiten, verrechnen wir 50 % des vereinbarten Betrags.
      </p>

      <h2>4. Preise und Zahlung</h2>
      <ul>
        <li>Alle Preise verstehen sich in Schweizer Franken zuzüglich 8.1 % Mehrwertsteuer.</li>
        <li>Die Rechnung stellen wir nach dem Einsatz, zahlbar innert 30 Tagen netto.</li>
        <li>
          Sie können per QR-Rechnung, Kreditkarte oder TWINT bezahlen. Für Zahlungen mit Karte und
          TWINT fallen für Sie keine Zusatzkosten an.
        </li>
        <li>
          Bei Zahlungsverzug senden wir eine Zahlungserinnerung. Ab der ersten Mahnung verrechnen
          wir CHF 20, ab der zweiten CHF 40 Mahngebühr sowie Verzugszins von 5 % gemäss Art. 104
          OR.
        </li>
      </ul>

      <h2>5. Stornierung und Umbuchung</h2>
      <ul>
        <li>Bis 24 Stunden vor dem Termin kostenlos, über Ihr Kundenkonto oder telefonisch.</li>
        <li>
          Danach verrechnen wir 50 % des vereinbarten Betrags, weil das Team bereits eingeplant und
          entlöhnt ist.
        </li>
        <li>
          Bei Nichtantreffen ohne Absage verrechnen wir den vollen Betrag.
        </li>
        <li>
          Müssen wir absagen (Krankheit, höhere Gewalt), bieten wir umgehend einen Ersatztermin an.
          Ihnen entstehen keine Kosten.
        </li>
      </ul>

      <h2>6. Abgabegarantie bei der Umzugsreinigung</h2>
      <p>
        Bei der Umzugsreinigung mit Abgabegarantie gilt: Beanstandet die Vermieterschaft oder
        Verwaltung bei der Wohnungsübergabe Reinigungsmängel, beheben wir diese innert 48 Stunden
        kostenlos. Voraussetzung ist, dass
      </p>
      <ul>
        <li>Sie uns die Beanstandung innert 3 Tagen nach der Übergabe melden,</li>
        <li>das Objekt seit unserer Reinigung nicht mehr genutzt wurde,</li>
        <li>die Beanstandung die von uns übernommenen Bereiche betrifft.</li>
      </ul>
      <p>
        Nicht erfasst sind Mängel an der Bausubstanz, Abnützungsschäden und Beanstandungen an
        Bereichen, die vertraglich ausgeschlossen waren.
      </p>

      <h2>7. Mängelrüge</h2>
      <p>
        Melden Sie Beanstandungen innert 3 Tagen nach dem Einsatz. Wir bessern kostenlos nach.
        Gelingt die Nachbesserung nicht, mindern wir den Preis angemessen. Eine Meldung nach dieser
        Frist können wir nicht mehr berücksichtigen, weil sich der Zustand nicht mehr zuordnen
        lässt.
      </p>

      <h2>8. Haftung</h2>
      <p>
        Wir haften für Schäden, die wir bei der Auftragsausführung schuldhaft verursachen. Dafür
        besteht eine Betriebshaftpflichtversicherung mit einer Deckungssumme von CHF 5 Millionen.
      </p>
      <p>
        Nicht: für Schäden an Gegenständen, auf die wir vorgängig schriftlich hingewiesen wurden und
        die dennoch nicht entfernt wurden; für vorbestehende Schäden; für Folgeschäden und
        entgangenen Gewinn, soweit gesetzlich zulässig.
      </p>
      <p>
        Bewahren Sie Wertsachen, Bargeld und Schmuck während des Einsatzes verschlossen auf. Für
        Verlust solcher Gegenstände übernehmen wir keine Haftung.
      </p>

      <h2>9. Schlüssel</h2>
      <p>
        Übergebene Schlüssel bewahren wir anonymisiert in einem gesicherten Depot auf und
        protokollieren jede Übergabe. Bei Verlust tragen wir die Kosten für den Ersatz und
        gegebenenfalls den Schliessanlagenwechsel im Rahmen unserer Versicherung.
      </p>

      <h2>10. Abwerbeverbot</h2>
      <p>
        Während der Vertragsdauer und 12 Monate danach stellen Sie unsere Mitarbeitenden nicht
        direkt an. Bei Zuwiderhandlung wird eine Konventionalstrafe von drei Bruttomonatslöhnen der
        betreffenden Person fällig.
      </p>

      <h2>11. Datenschutz</h2>
      <p>
        Wir bearbeiten Ihre Daten nach unserer{' '}
        <a href="/legal/datenschutz" className="text-primary underline underline-offset-4">
          Datenschutzerklärung
        </a>
        .
      </p>

      <h2>12. Anwendbares Recht und Gerichtsstand</h2>
      <p>
        Es gilt ausschliesslich Schweizer Recht unter Ausschluss des UN-Kaufrechts. Gerichtsstand
        ist {company.address.city}. Zwingende Gerichtsstände für Konsumentinnen und Konsumenten
        bleiben vorbehalten.
      </p>

      <h2>13. Salvatorische Klausel</h2>
      <p>
        Sollte eine Bestimmung unwirksam sein, bleiben die übrigen wirksam. Die unwirksame
        Bestimmung wird durch eine ersetzt, die dem wirtschaftlichen Zweck am nächsten kommt.
      </p>
    </LegalBody>
  );
}
