import type { Metadata } from 'next';
import Link from 'next/link';
import { Mail } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { formatDateTime } from '@/lib/utils';
import { STATUS_BESCHRIFTUNG, istZustellstatus } from '@/lib/kommunikation/zustellung';
import { listeZustellprotokoll } from '@/server/services/kommunikation.service';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DetailSection, EmptyState, ListCard, PageHeader, TableScroll } from '@/components/app/page-parts';

export const metadata: Metadata = {
  title: 'Zustellprotokoll',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const VARIANTE: Record<string, 'success' | 'warning' | 'destructive' | 'neutral' | 'info'> = {
  delivered: 'success',
  sent: 'info',
  delivery_delayed: 'warning',
  bounced: 'destructive',
  complained: 'destructive',
  undelivered: 'destructive',
  failed: 'destructive',
  simulated: 'neutral',
  queued: 'neutral',
};

/**
 * Zustellprotokoll (Wave 14): Was ging hinaus, was kam an, was prallte ab.
 * Der Status stammt vom Anbieter (Webhook); ohne eingerichtete Meldungen
 * bleibt er bei „Übergeben" stehen — die Seite sagt das, statt „zugestellt"
 * zu behaupten.
 */
export default async function ZustellprotokollPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requirePermission('template:read');
  const params = await searchParams;
  const kanal = params.kanal === 'sms' ? 'sms' : 'email';
  const protokoll = await listeZustellprotokoll({ kanal, status: params.status || undefined });
  const beschriftung = (s: string) => (istZustellstatus(s) ? STATUS_BESCHRIFTUNG[s] : s);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Zustellprotokoll"
        description={'E-Mails und SMS der letzten 30 Tage mit dem Status, den der Anbieter meldet. Ohne eingerichtete Zustellmeldungen bleibt der Status bei „Übergeben".'}
        actions={
          <>
            <Button asChild variant={kanal === 'email' ? 'default' : 'outline'} size="sm">
              <Link href="/admin/kommunikation?kanal=email">E-Mail</Link>
            </Button>
            <Button asChild variant={kanal === 'sms' ? 'default' : 'outline'} size="sm">
              <Link href="/admin/kommunikation?kanal=sms">SMS</Link>
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap gap-2">
        {protokoll.jeStatus.map((s) => (
          <Link key={s.status} href={`/admin/kommunikation?kanal=${kanal}&status=${s.status}`}>
            <Badge variant={VARIANTE[s.status] ?? 'neutral'}>
              {beschriftung(s.status)}: {s.anzahl}
            </Badge>
          </Link>
        ))}
      </div>

      <DetailSection title={kanal === 'email' ? 'E-Mails' : 'SMS'} body="flush">
        {protokoll.eintraege.length === 0 ? (
          <EmptyState className="m-4" icon={<Mail aria-hidden />} title="Nichts versandt" description="In diesem Zeitraum ging über diesen Kanal nichts hinaus." />
        ) : (
          <ListCard>
            <TableScroll>
              <table className="data-table">
                <caption className="sr-only">Zustellprotokoll</caption>
                <thead>
                  <tr>
                    <th scope="col">Zeitpunkt</th>
                    <th scope="col">Empfänger</th>
                    {kanal === 'email' ? <th scope="col">Betreff</th> : null}
                    <th scope="col">Status</th>
                    <th scope="col">Zugestellt</th>
                  </tr>
                </thead>
                <tbody>
                  {protokoll.eintraege.map((e) => (
                    <tr key={e.id}>
                      <td className="text-muted-foreground">{formatDateTime(e.createdAt)}</td>
                      <td>{e.to}</td>
                      {kanal === 'email' && 'subject' in e ? (
                        <td>
                          {e.subject}
                          {'templateKey' in e && e.templateKey ? <span className="block text-xs text-muted-foreground">{e.templateKey}</span> : null}
                        </td>
                      ) : null}
                      <td>
                        <Badge size="sm" variant={VARIANTE[e.status] ?? 'neutral'} title={e.error ?? undefined}>
                          {beschriftung(e.status)}
                        </Badge>
                      </td>
                      <td className="text-muted-foreground">{e.deliveredAt ? formatDateTime(e.deliveredAt) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </ListCard>
        )}
      </DetailSection>
    </div>
  );
}
