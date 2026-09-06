import type { Metadata } from 'next';

import { LegalBody } from '@/components/marketing/legal-body';

import { ConsentSettingsLink } from '@/features/public/consent-settings-link';

export const metadata: Metadata = {
  title: 'Cookie-Erklärung',
  description:
    'Welche Cookies wir setzen, wozu, und wie Sie Ihre Einwilligung jederzeit ändern können.',
  alternates: { canonical: '/legal/cookies' },
};

export const revalidate = 86400;

/**
 * Cookie-Erklärung.
 *
 * Die Tabelle listet jeden Cookie einzeln auf — Name, Zweck, Laufzeit. Eine
 * pauschale Aussage („wir verwenden Cookies zur Verbesserung") genügt weder
 * dem DSG noch der DSGVO.
 */
const COOKIES = [
  {
    category: 'Notwendig',
    description:
      'Diese Cookies sind für den Betrieb zwingend. Sie werden ohne Einwilligung gesetzt, weil die Website sonst nicht funktioniert.',
    items: [
      {
        name: 'clenaris_at',
        purpose: 'Hält Ihre Anmeldung aufrecht (Access-Token)',
        duration: '15 Minuten',
      },
      {
        name: 'clenaris_rt',
        purpose: 'Verlängert die Sitzung, ohne dass Sie sich neu anmelden müssen',
        duration: '30 Tage',
      },
      {
        name: 'clenaris-theme',
        purpose: 'Merkt sich, ob Sie die helle oder dunkle Darstellung gewählt haben',
        duration: 'Dauerhaft (lokal gespeichert)',
      },
      {
        name: 'clenaris-consent',
        purpose: 'Speichert Ihre Cookie-Entscheidung, damit wir nicht erneut fragen',
        duration: '12 Monate',
      },
      {
        name: 'clenaris-booking',
        purpose: 'Bewahrt Ihre Eingaben im Buchungsassistenten bei einem Neuladen',
        duration: 'Bis zum Schliessen des Browser-Tabs',
      },
    ],
  },
  {
    category: 'Statistik',
    description:
      'Nur mit Ihrer Einwilligung. Wir messen anonymisiert, welche Seiten genutzt werden, um die Website zu verbessern. Die IP-Adresse wird gekürzt.',
    items: [
      { name: '_ga', purpose: 'Unterscheidet Besucherinnen und Besucher', duration: '13 Monate' },
      { name: '_ga_*', purpose: 'Hält den Sitzungsstatus (Google Analytics 4)', duration: '13 Monate' },
    ],
  },
  {
    category: 'Marketing',
    description:
      'Nur mit Ihrer Einwilligung. Diese Cookies messen den Erfolg von Werbekampagnen. Ohne sie sehen Sie gleich viel Werbung, aber weniger passende.',
    items: [
      { name: '_fbp', purpose: 'Misst Kampagnenerfolge auf Meta-Plattformen', duration: '3 Monate' },
      { name: '_gcl_au', purpose: 'Misst Conversions aus Google Ads', duration: '3 Monate' },
    ],
  },
];

export default function CookiePolicyPage() {
  return (
    <LegalBody slug="cookies">
      <h1 className="text-headline font-bold">Cookie-Erklärung</h1>
      <p className="text-sm text-muted-foreground">Stand: 1. Januar 2026</p>

      <p>
        Cookies sind kleine Textdateien, die eine Website in Ihrem Browser ablegt. Wir setzen sie
        sparsam ein und listen hier jeden einzelnen auf — mit Zweck und Laufzeit.
      </p>

      <ConsentSettingsLink />

      {COOKIES.map((group) => (
        <section key={group.category}>
          <h2>{group.category}</h2>
          <p>{group.description}</p>

          <div className="not-prose mt-4 overflow-x-auto">
            <table className="data-table min-w-[32rem]">
              <caption className="sr-only">Cookies der Kategorie {group.category}</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Zweck</th>
                  <th scope="col">Laufzeit</th>
                </tr>
              </thead>
              <tbody>
                {group.items.map((cookie) => (
                  <tr key={cookie.name}>
                    <td className="font-medium">{cookie.name}</td>
                    <td className="text-muted-foreground">{cookie.purpose}</td>
                    <td className="whitespace-nowrap text-muted-foreground">{cookie.duration}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <h2>Cookies im Browser löschen</h2>
      <p>
        Sie können Cookies jederzeit in Ihren Browsereinstellungen löschen oder blockieren. Beachten
        Sie: Ohne die notwendigen Cookies können Sie sich nicht anmelden und keine Buchung
        abschliessen.
      </p>

      <h2>Weitere Informationen</h2>
      <p>
        Wie wir Personendaten insgesamt bearbeiten, steht in unserer{' '}
        <a href="/legal/datenschutz" className="text-primary underline underline-offset-4">
          Datenschutzerklärung
        </a>
        .
      </p>
    </LegalBody>
  );
}
