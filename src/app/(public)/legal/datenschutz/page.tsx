import type { Metadata } from 'next';

import { getPublicCompanyInfo } from '@/server/services/organization.service';
import { ConsentSettingsLink } from '@/features/public/consent-settings-link';

export const metadata: Metadata = {
  title: 'Datenschutzerklärung',
  description:
    'Wie wir Personendaten bearbeiten — nach dem revidierten Schweizer Datenschutzgesetz (DSG) und der DSGVO.',
  alternates: { canonical: '/legal/datenschutz' },
};

export const revalidate = 86400;

export default async function PrivacyPage() {
  const company = await getPublicCompanyInfo();

  return (
    <>
      <h1 className="text-headline font-bold">Datenschutzerklärung</h1>
      <p className="text-sm text-muted-foreground">Stand: 1. Januar 2026 · Version 1.0</p>

      <p>
        Wir bearbeiten Personendaten nach dem revidierten Schweizer Datenschutzgesetz (DSG) und,
        soweit anwendbar, nach der Datenschutz-Grundverordnung (DSGVO). Diese Erklärung sagt in
        verständlicher Sprache, welche Daten wir bearbeiten, wozu, wie lange und welche Rechte Sie
        haben.
      </p>

      <h2>1. Verantwortliche Stelle</h2>
      <p>
        {company.legalName ?? company.name}, {company.address.street},{' '}
        {company.address.postalCode} {company.address.city}, Schweiz. Bei Fragen zum Datenschutz
        erreichen Sie uns unter{' '}
        <a href={`mailto:${company.email}`} className="text-primary underline underline-offset-4">
          {company.email}
        </a>
        {company.phone ? ` oder ${company.phone}` : ''}.
      </p>

      <h2>2. Welche Daten wir bearbeiten</h2>

      <h3>Bei einer Buchung oder Offertanfrage</h3>
      <ul>
        <li>Name, E-Mail-Adresse, Telefonnummer, bei Geschäftskunden die Firma</li>
        <li>Einsatzadresse und Angaben zum Objekt (Fläche, Zimmerzahl, Zugangsinformationen)</li>
        <li>Gewählte Leistungen, Termine und Preise</li>
        <li>Ihre Mitteilungen an uns</li>
      </ul>
      <p>
        Rechtsgrundlage ist die Vertragserfüllung (Art. 31 Abs. 2 lit. a DSG, Art. 6 Abs. 1 lit. b
        DSGVO). Ohne diese Daten können wir den Auftrag nicht ausführen.
      </p>

      <h3>Während und nach dem Einsatz</h3>
      <ul>
        <li>Vorher- und Nachher-Fotos der gereinigten Bereiche</li>
        <li>Abgearbeitete Checkliste und verwendetes Material</li>
        <li>Ihre Unterschrift, falls Sie die Arbeit vor Ort abnehmen</li>
      </ul>
      <p>
        Diese Daten dokumentieren unsere Leistung. Fotos zeigen Räume und Oberflächen, keine
        Personen. Sie können jederzeit verlangen, dass wir auf Fotos verzichten.
      </p>

      <h3>Bei einem Kundenkonto</h3>
      <ul>
        <li>Anmeldedaten (E-Mail und ein Passwort-Hash — das Passwort selbst kennen wir nicht)</li>
        <li>Zeitpunkt und IP-Adresse der letzten Anmeldung, zur Absicherung des Kontos</li>
        <li>Ihre Einwilligungen mit Zeitstempel</li>
      </ul>

      <h3>Beim Besuch der Website</h3>
      <ul>
        <li>
          Technisch notwendige Daten, die jeder Webserver protokolliert: IP-Adresse, Zeitpunkt,
          aufgerufene Seite, Browser
        </li>
        <li>
          Statistikdaten nur, wenn Sie eingewilligt haben — mit gekürzter IP-Adresse und ohne
          Zusammenführung mit Ihrem Konto
        </li>
      </ul>

      <h2>3. Wie lange wir Daten aufbewahren</h2>
      <dl className="protocol-list border-t border-border">
        {[
          {
            label: 'Rechnungen und Belege',
            value: '10 Jahre — gesetzliche Aufbewahrungspflicht nach Art. 958f OR',
          },
          { label: 'Kundenstammdaten', value: 'Solange die Geschäftsbeziehung besteht, danach 10 Jahre' },
          { label: 'Einsatzfotos', value: '24 Monate, danach automatische Löschung' },
          { label: 'Anfragen ohne Auftrag', value: '24 Monate' },
          { label: 'Bewerbungsunterlagen', value: '6 Monate nach Abschluss des Verfahrens' },
          { label: 'Server-Protokolle', value: '90 Tage' },
          { label: 'Analysedaten', value: '14 Monate' },
        ].map((row) => (
          <div key={row.label} className="protocol-row">
            <dt className="protocol-label">{row.label}</dt>
            <dd className="protocol-value font-normal text-muted-foreground">{row.value}</dd>
          </div>
        ))}
      </dl>

      <h2>4. An wen wir Daten weitergeben</h2>
      <p>
        Wir verkaufen keine Daten. Wir geben sie nur weiter, soweit das für den Betrieb nötig ist —
        an folgende Auftragsbearbeiter, jeweils mit Auftragsbearbeitungsvertrag:
      </p>
      <dl className="protocol-list border-t border-border">
        {[
          { label: 'Vercel Inc. (USA/EU)', value: 'Betrieb der Website, Standort Frankfurt' },
          { label: 'Supabase (EU)', value: 'Datenbank und Dateiablage, Standort EU' },
          { label: 'Stripe Payments Europe', value: 'Zahlungsabwicklung Karte und TWINT' },
          { label: 'Resend (EU/USA)', value: 'Versand von Transaktions-E-Mails' },
          { label: 'Twilio (EU/USA)', value: 'SMS-Versand für Terminerinnerungen' },
          { label: 'Google Ireland (Maps)', value: 'Adressvervollständigung und Kartendarstellung' },
          { label: 'Anthropic (USA)', value: 'KI-Assistent — ohne Kundenstammdaten' },
        ].map((row) => (
          <div key={row.label} className="protocol-row">
            <dt className="protocol-label">{row.label}</dt>
            <dd className="protocol-value font-normal text-muted-foreground">{row.value}</dd>
          </div>
        ))}
      </dl>
      <p>
        Bei Übermittlungen in die USA stützen wir uns auf Standardvertragsklauseln und, soweit
        einschlägig, auf das EU-US Data Privacy Framework.
      </p>

      <h2>5. Ihre Rechte</h2>
      <p>Sie haben jederzeit das Recht:</p>
      <ul>
        <li>Auskunft über die zu Ihnen bearbeiteten Daten zu verlangen (Art. 25 DSG)</li>
        <li>unrichtige Daten berichtigen zu lassen (Art. 32 DSG)</li>
        <li>die Löschung zu verlangen, soweit keine Aufbewahrungspflicht entgegensteht</li>
        <li>Ihre Daten in einem gängigen Format zu erhalten (Datenportabilität)</li>
        <li>eine erteilte Einwilligung jederzeit zu widerrufen</li>
        <li>der Bearbeitung zu Werbezwecken zu widersprechen</li>
      </ul>
      <p>
        Eine E-Mail an{' '}
        <a href={`mailto:${company.email}`} className="text-primary underline underline-offset-4">
          {company.email}
        </a>{' '}
        genügt. Wir antworten innerhalb von 30 Tagen und kostenlos. Sie können sich zudem beim
        Eidgenössischen Datenschutz- und Öffentlichkeitsbeauftragten (EDÖB) beschweren.
      </p>

      <h2>6. Datensicherheit</h2>
      <ul>
        <li>Sämtliche Übertragungen sind mit TLS verschlüsselt</li>
        <li>Passwörter werden mit Argon2id gehasht und sind für uns nicht lesbar</li>
        <li>Zugriffe sind nach Rollen beschränkt und werden protokolliert</li>
        <li>Sensible Angaben wie Schlüsselcodes werden verschlüsselt gespeichert</li>
        <li>Tägliche Sicherungen mit siebentägiger Wiederherstellungsmöglichkeit</li>
      </ul>

      <h2>7. Cookies</h2>
      <p>
        Wir setzen technisch notwendige Cookies für Anmeldung und Sicherheit — dafür brauchen wir
        keine Einwilligung. Statistik- und Marketing-Cookies setzen wir nur nach Ihrer aktiven
        Zustimmung. Details stehen in der{' '}
        <a href="/legal/cookies" className="text-primary underline underline-offset-4">
          Cookie-Erklärung
        </a>
        .
      </p>
      <ConsentSettingsLink />

      <h2>8. Änderungen</h2>
      <p>
        Wir passen diese Erklärung an, wenn sich unsere Bearbeitung ändert. Bei wesentlichen
        Änderungen informieren wir aktiv angemeldete Kundinnen und Kunden per E-Mail.
      </p>
    </>
  );
}
