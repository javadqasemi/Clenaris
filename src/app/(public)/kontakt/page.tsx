import type { Metadata } from 'next';
import { Clock, Download, Mail, MapPin, Phone } from 'lucide-react';

import { qrSvg } from '@/lib/kontakt/qr';
import { Button } from '@/components/ui/button';
import { getPublicCompanyInfo } from '@/server/services/organization.service';
import { firmenVisitenkarte } from '@/server/services/visitenkarte.service';
import { ContactForm } from '@/features/public/contact-form';
import { Section } from '@/components/marketing/sections';
import { pageMetadata } from '@/lib/cms/metadata';

/**
 * Titel, Beschreibung und Vorschaubild kommen aus der Redaktion
 * (`/admin/seo`); fehlt eine Angabe, gilt der Wert aus dem Register.
 */
export const generateMetadata = (): Promise<Metadata> => pageMetadata('/kontakt');

export const revalidate = 3600;

const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

export default async function ContactPage() {
  const [company, visitenkarte] = await Promise.all([getPublicCompanyInfo(), firmenVisitenkarte()]);
  // Serverseitig, einmal je Neuaufbau der Seite (stündlich) — kein fremder Dienst, kein Skript.
  const qr = qrSvg(visitenkarte.vcard);
  const { dateiname } = visitenkarte;

  return (
    <>
      <section className="relative overflow-hidden border-b border-border">
        <div className="aare-wash pointer-events-none absolute inset-0" aria-hidden />
        {/* Auch der Kopfbereich trägt `form-measure`: Sonst begänne die
            Überschrift auf einem sehr breiten Bildschirm weiter links als das
            Formular darunter, und die Seite hätte zwei linke Kanten. */}
        <div className="form-measure container relative py-16 sm:py-20">
          <div className="max-w-2xl space-y-5">
            <h1 className="text-display font-bold text-balance">Sprechen wir darüber</h1>
            <p className="text-lg leading-relaxed text-muted-foreground">
              Ob konkrete Anfrage oder erste Frage: Wir antworten innerhalb eines Arbeitstages.
              Dringend? Dann greifen Sie zum Telefon — da geht es am schnellsten.
            </p>
          </div>
        </div>
      </section>

      <Section>
        {/* `form-measure`: Höchstbreite auf sehr grossen Bildschirmen, siehe
            `globals.css`. */}
        <div className="form-measure container grid gap-12 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-16">
          {/* Formular */}
          <div className="space-y-6">
            <h2 className="text-headline font-bold">Schreiben Sie uns</h2>
            <ContactForm />
          </div>

          {/* Kontaktangaben */}
          <aside className="space-y-8">
            {/* Im Druck hell: Ein dunkler Kartengrund aus dem Dunkelmodus kostet Toner und nimmt dem Code den Kontrast. */}
            <div className="space-y-5 rounded-2xl border border-border bg-card p-6 print:bg-white print:text-black">
              <h2 className="font-display text-lg font-semibold tracking-tight">Direkt erreichen</h2>

              {/*
                In einer `dl` darf zwischen ihr und `dt`/`dd` genau *ein* `div`
                stehen. Vorher lag das Icon daneben und das Paar in einem
                zweiten `div` — Screenreader lasen die Angaben dann nicht als
                Begriff und Wert (axe: definition-list, dlitem). Das Icon sitzt
                jetzt im `dt`, absolut in den linken Einzug gesetzt; das Bild
                bleibt dasselbe.
              */}
              <dl className="protocol-list">
                {company.phone ? (
                  <div className="relative py-3.5 pl-7">
                    <dt className="text-sm text-muted-foreground">
                      <Phone className="absolute left-0 top-[1.0625rem] size-4 text-primary" aria-hidden />
                      Telefon
                    </dt>
                    <dd>
                      <a
                        href={`tel:${company.phone.replace(/\s/g, '')}`}
                        className="font-medium tabular-nums text-primary underline-offset-4 hover:underline"
                      >
                        {company.phone}
                      </a>
                    </dd>
                  </div>
                ) : null}

                <div className="relative min-w-0 py-3.5 pl-7">
                  <dt className="text-sm text-muted-foreground">
                    <Mail className="absolute left-0 top-[1.0625rem] size-4 text-primary" aria-hidden />
                    E-Mail
                  </dt>
                  <dd className="truncate">
                    <a
                      href={`mailto:${company.email}`}
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {company.email}
                    </a>
                  </dd>
                </div>

                <div className="relative py-3.5 pl-7">
                  <dt className="text-sm text-muted-foreground">
                    <MapPin className="absolute left-0 top-[1.0625rem] size-4 text-primary" aria-hidden />
                    Adresse
                  </dt>
                  <dd className="font-medium not-italic">
                    {company.name}
                    <br />
                    {company.address.street}
                    <br />
                    {company.address.postalCode} {company.address.city}
                  </dd>
                </div>
              </dl>

              {/*
                Visitenkarte als QR-Code und als Datei (Teil I, 2026-09-28).

                Beides trägt dieselbe Zeichenkette aus `firmenVisitenkarte()`.
                Der Code steht für den Fall „Seite am Bildschirm, Telefon in
                der Hand"; die Schaltfläche für den Fall, dass die Seite schon
                auf dem Telefon offen ist — einen Code auf dem eigenen
                Bildschirm scannt niemand.

                Das SVG entsteht als JSX aus der Modulmatrix (`qrSvg`), nicht
                als fremdes Markup. Die Ruhezone ist **immer weiss**, auch im
                Dunkelmodus: Ein QR-Code braucht hellen Rand und dunkle Module,
                und ein invertierter Code wird von vielen Kameras nicht
                erkannt. `crispEdges` hält die Modulkanten beim Skalieren und
                im Druck scharf; die Grösse folgt der Kartenbreite bis 14 rem
                (rund 3 px je Modul bei einer vollständigen Karte), im Druck
                fest 4 cm (rund 0.55 mm je Modul, siehe
                `vcard-rechenkern.test.ts`).
              */}
              <figure className="space-y-3 border-t border-border pt-5 print:break-inside-avoid">
                <svg
                  viewBox={`0 0 ${qr.kante} ${qr.kante}`}
                  role="img"
                  aria-labelledby="kontakt-qr-titel"
                  shapeRendering="crispEdges"
                  className="mx-auto block aspect-square w-full max-w-56 rounded-lg border border-border [print-color-adjust:exact] print:w-[4cm] print:max-w-none print:rounded-none print:border-0"
                  data-kontakt-qr=""
                >
                  <title id="kontakt-qr-titel">
                    {`QR-Code mit der Visitenkarte von ${company.name} — mit der Kamera scannen, um den Kontakt zu speichern`}
                  </title>
                  <rect width={qr.kante} height={qr.kante} fill="#ffffff" />
                  <path d={qr.pfad} fill="#000000" />
                </svg>
                <figcaption className="text-center text-sm leading-relaxed text-muted-foreground">
                  Mit der Handykamera scannen und uns direkt im Adressbuch speichern.
                </figcaption>
              </figure>

              {/* `print-hidden` aus `globals.css` („Druck"): Eine Schaltfläche auf Papier führt nirgends hin. */}
              <Button asChild variant="outline" className="print-hidden w-full">
                <a href="/api/public/kontakt/vcard" download={dateiname}>
                  <Download aria-hidden />
                  Kontakt speichern
                </a>
              </Button>
            </div>

            {/* Öffnungszeiten */}
            <div className="space-y-4 rounded-2xl border border-border bg-card p-6">
              <h2 className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight">
                <Clock className="size-4 text-primary" aria-hidden />
                Wann wir erreichbar sind
              </h2>

              <dl className="protocol-list">
                {company.openingHours
                  .slice()
                  .sort((a, b) => (a.weekday || 7) - (b.weekday || 7))
                  .map((hour) => (
                    <div
                      key={hour.weekday}
                      className="flex items-baseline justify-between gap-4 py-2"
                    >
                      <dt className="text-sm text-muted-foreground">{WEEKDAYS[hour.weekday]}</dt>
                      <dd className="text-sm font-medium tabular-nums">
                        {hour.closed || !hour.opensAt
                          ? 'geschlossen'
                          : `${hour.opensAt} – ${hour.closesAt}`}
                      </dd>
                    </div>
                  ))}
              </dl>

              <p className="text-sm leading-relaxed text-muted-foreground">
                Ausserhalb dieser Zeiten nehmen wir Ihre Nachricht entgegen und melden uns am
                nächsten Arbeitstag.
              </p>
            </div>

            <div className="rounded-2xl border border-dashed border-border p-6">
              <h2 className="font-display text-base font-semibold">Sie kennen Ihren Bedarf?</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                Dann geht es schneller über den Preisrechner: Leistung wählen, Fläche eingeben,
                Termin buchen — ohne Rückrufschlaufe.
              </p>
              <a
                href="/buchen"
                className="mt-3 inline-block text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                Zum Preisrechner
              </a>
            </div>
          </aside>
        </div>
      </Section>
    </>
  );
}
