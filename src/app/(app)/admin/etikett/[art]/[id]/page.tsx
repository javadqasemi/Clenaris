import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import QRCode from 'qrcode';

import { requirePagePermission } from '@/lib/auth/session';
import { formatDateTime } from '@/lib/utils';
import { SCAN_ENTITIES } from '@/lib/validation/scan';
import { getOrganizationId } from '@/server/services/organization.service';
import { ETIKETT_RECHT, etikettDaten } from '@/server/services/scan.service';
import { ActionButton } from '@/components/app/action-button';
import { DetailSection, PageHeader } from '@/components/app/page-parts';
import { PrintButton } from '@/features/booking/print-button';

export const metadata: Metadata = {
  title: 'Etikett',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const ART_LABEL: Record<(typeof SCAN_ENTITIES)[number], string> = {
  MATERIAL: 'Material',
  EQUIPMENT: 'Gerät',
  PROPERTY: 'Objekt',
  JOB: 'Einsatz',
};

/**
 * Etikett eines Datensatzes (Scanplattform, 2026-09-26).
 *
 * Nur eine Bearbeitungsmaske — `requirePagePermission` antwortet ohne das
 * Pflegerecht der Art mit 404, wie bei jeder reinen Bearbeitungsseite.
 *
 * **Das Aufrufen der Seite erzeugt keinen Code.** Ein GET, der schreibt,
 * liefe beim Vorladen eines Links, beim Crawlen einer Vorschau oder beim
 * Zurückblättern — und hinterliesse Codes, die niemand gedruckt hat. Erzeugt
 * wird mit dem Knopf (`POST /api/scan/codes`), gesperrt ebenso.
 *
 * **Auf dem Etikett steht nur der Code.** Der QR-Code enthält `CLX1:` und 20
 * Zufallszeichen; darunter steht dieselbe Zeichenfolge zum Abtippen, falls der
 * Aufdruck beschädigt ist, und die Bezeichnung des Gegenstands. Keine Adresse,
 * kein Kundenname, keine Nummer, die etwas über die Kundschaft verrät — beim
 * Objekt nur dessen Bezeichnung, die die Firma selbst vergibt.
 */
export default async function EtikettPage({ params }: { params: Promise<{ art: string; id: string }> }) {
  const { art: roh, id } = await params;
  const art = SCAN_ENTITIES.find((a) => a === roh);
  if (!art) notFound();
  await requirePagePermission(ETIKETT_RECHT[art]);

  const daten = await etikettDaten(await getOrganizationId(), art, id).catch(() => null);
  if (!daten) notFound();

  // Als Bild statt als eingebettetes SVG-Markup: kein `dangerouslySetInnerHTML`
  // für etwas, das auch ein `<img>` kann. Die CSP erlaubt `data:` für Bilder.
  const qr = daten.code
    ? `data:image/svg+xml;base64,${Buffer.from(
        await QRCode.toString(daten.code.inhalt, { type: 'svg', errorCorrectionLevel: 'Q', margin: 2 }),
      ).toString('base64')}`
    : null;

  return (
    <div className="space-y-8">
      <PageHeader
        title={`Etikett — ${ART_LABEL[art]}`}
        description={daten.titel}
        actions={
          daten.code ? (
            <>
              <PrintButton variant="outline" size="sm" />
              <ActionButton
                endpoint={`/api/scan/codes/${daten.code.id}`}
                method="DELETE"
                label="Etikett sperren"
                confirm="Das gedruckte Etikett löst danach nichts mehr auf. Ein neues bekommt einen neuen Code."
                successMessage="Etikett gesperrt."
                variant="ghost"
                size="sm"
              />
            </>
          ) : (
            <ActionButton
              endpoint="/api/scan/codes"
              body={{ entityType: art, entityId: id }}
              label="Etikett erzeugen"
              successMessage="Etikett erzeugt."
              size="sm"
            />
          )
        }
      />

      <DetailSection title="Zum Drucken" body="flush">
        {daten.code && qr ? (
          <div className="print-area flex flex-col items-center gap-2 p-6 text-center" data-etikett>
            {/* eslint-disable-next-line @next/next/no-img-element -- ein Daten-URI, nichts zu optimieren */}
            <img src={qr} alt={`QR-Code ${daten.code.inhalt}`} width={180} height={180} />
            <p className="font-medium">{daten.titel}</p>
            <p className="font-mono text-xs tracking-wider" data-etikett-code>
              {daten.code.inhalt}
            </p>
          </div>
        ) : (
          <p className="p-6 text-sm text-muted-foreground">
            Für diesen Datensatz gibt es kein gültiges Etikett.
            {daten.gesperrt > 0 ? ` ${daten.gesperrt} frühere${daten.gesperrt === 1 ? 's ist' : ' sind'} gesperrt.` : ''}
          </p>
        )}
      </DetailSection>
      {daten.code ? (
        <p className="text-xs text-muted-foreground">
          Erzeugt am {formatDateTime(daten.code.erzeugtAm)}.
          {daten.gesperrt > 0 ? ` ${daten.gesperrt} frühere${daten.gesperrt === 1 ? 's Etikett ist' : ' Etiketten sind'} gesperrt.` : ''}
        </p>
      ) : null}
    </div>
  );
}
