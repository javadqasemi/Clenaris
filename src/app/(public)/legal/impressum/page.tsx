import type { Metadata } from 'next';

import { getPublicCompanyInfo } from '@/server/services/organization.service';

export const metadata: Metadata = {
  title: 'Impressum',
  description: 'Angaben zur Clenaris Reinigungen GmbH gemäss Schweizer Recht.',
  alternates: { canonical: '/legal/impressum' },
  robots: { index: true, follow: true },
};

export const revalidate = 86400;

export default async function ImprintPage() {
  const company = await getPublicCompanyInfo();

  return (
    <>
      <h1 className="text-headline font-bold">Impressum</h1>

      <p>
        Angaben gemäss Art. 3 Abs. 1 lit. s des Bundesgesetzes gegen den unlauteren Wettbewerb
        (UWG).
      </p>

      <h2>Verantwortlich für diese Website</h2>

      <dl className="protocol-list border-t border-border">
        {[
          { label: 'Firma', value: company.legalName ?? company.name },
          {
            label: 'Adresse',
            value: `${company.address.street}, ${company.address.postalCode} ${company.address.city}, Schweiz`,
          },
          ...(company.phone ? [{ label: 'Telefon', value: company.phone }] : []),
          { label: 'E-Mail', value: company.email },
          ...(company.vatNumber ? [{ label: 'MWST-Nummer', value: company.vatNumber }] : []),
          { label: 'Rechtsform', value: 'Gesellschaft mit beschränkter Haftung (GmbH)' },
          { label: 'Handelsregister', value: `Handelsregisteramt des Kantons ${company.address.canton}` },
        ].map((row) => (
          <div key={row.label} className="protocol-row">
            <dt className="protocol-label">{row.label}</dt>
            <dd className="protocol-value">{row.value}</dd>
          </div>
        ))}
      </dl>

      <h2>Haftungsausschluss</h2>
      <p>
        Wir erstellen die Inhalte dieser Website mit Sorgfalt, übernehmen jedoch keine Gewähr für
        Richtigkeit, Vollständigkeit und Aktualität. Haftungsansprüche wegen Schäden materieller
        oder immaterieller Art, die aus dem Zugriff auf diese Website entstehen, sind
        ausgeschlossen, soweit dies gesetzlich zulässig ist.
      </p>
      <p>
        Preisangaben auf dieser Website sind Richtwerte. Verbindlich ist ausschliesslich der im
        Buchungsprozess berechnete oder in einer schriftlichen Offerte genannte Betrag.
      </p>

      <h2>Verweise auf Websites Dritter</h2>
      <p>
        Diese Website enthält Verweise auf Websites Dritter. Für deren Inhalte sind ausschliesslich
        die jeweiligen Betreiber verantwortlich. Zum Zeitpunkt der Verlinkung waren keine
        rechtswidrigen Inhalte erkennbar.
      </p>

      <h2>Urheberrecht</h2>
      <p>
        Sämtliche Inhalte dieser Website — insbesondere Texte, Fotografien und Grafiken — sind
        urheberrechtlich geschützt. Eine Verwendung ausserhalb der gesetzlichen Schranken bedarf
        unserer vorgängigen schriftlichen Zustimmung.
      </p>

      <h2>Streitbeilegung</h2>
      <p>
        Bei Beanstandungen wenden Sie sich bitte zuerst direkt an uns — die meisten Anliegen lassen
        sich so am schnellsten klären. Gerichtsstand ist {company.address.city}, Schweiz. Es gilt
        ausschliesslich Schweizer Recht.
      </p>
    </>
  );
}
