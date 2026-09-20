'use client';

import * as React from 'react';
import { AlertTriangle, CheckCircle2, Loader2, PenLine, Type } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { formatDateLong } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import { Alert } from '@/components/ui/primitives';
import { Checkbox } from '@/components/ui/controls';
import { PdfViewer } from '@/components/app/pdf-viewer';
import { SignaturePad } from '@/features/portal/signature-pad';

/**
 * Der Ablauf für die unterzeichnende Person.
 *
 * Dokument ansehen → (Code bestätigen) → Zustimmung → Name → zeichnen
 * **oder tippen** → verbindlich unterzeichnen. Nichts wird beim Zeichnen
 * gespeichert; der eine Aufruf am Ende ist die Handlung. Der Server prüft
 * dort alles noch einmal — Sitzung, Code, Zustimmung, Prüfsumme des
 * Originals aus den Bytes — und entscheidet.
 *
 * Was diese Maske nicht behauptet: nichts über Identität, nichts über
 * „qualifiziert". Sie sagt „elektronisch unterzeichnen" und beschreibt, was
 * festgehalten wird.
 */

interface Zustand {
  request: {
    publicId: string;
    title: string;
    status: string;
    artifactMode: 'EMBEDDED_VISUAL' | 'DETACHED_EVIDENCE';
    assuranceLevel: string;
    expiresAt: string;
    documentVersion: number | null;
    consent: { text: string; version: string; locale: string };
  };
  participant: {
    name: string;
    email: string;
    phone: string | null;
    status: string;
    requiresCode: boolean;
    verified: boolean;
    signedAt: string | null;
    declinedAt: string | null;
  };
}

export function SigningFlow({ publicId }: { publicId: string }) {
  const [zustand, setZustand] = React.useState<Zustand | null>(null);
  const [lade, setLade] = React.useState<'laden' | 'bereit' | 'ungueltig' | 'fehler'>('laden');

  const [code, setCode] = React.useState('');
  const [codeGesendet, setCodeGesendet] = React.useState<{ sentTo: string; resendAfter: string } | null>(null);
  const [zustimmung, setZustimmung] = React.useState(false);
  const [name, setName] = React.useState('');
  const [methode, setMethode] = React.useState<'DRAWN' | 'TYPED'>('DRAWN');
  const [bild, setBild] = React.useState<string | null>(null);
  const [grund, setGrund] = React.useState('');
  const [ablehnen, setAblehnen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [fehler, setFehler] = React.useState<string | null>(null);

  const laden = React.useCallback(async () => {
    try {
      const z = await api.get<Zustand>(`/api/public/signatures/${publicId}`);
      setZustand(z);
      setName((n) => n || z.participant.name);
      setLade('bereit');
    } catch (error) {
      setLade(error instanceof ApiError && error.status === 404 ? 'ungueltig' : 'fehler');
    }
  }, [publicId]);

  React.useEffect(() => {
    void laden();
  }, [laden]);

  const aufruf = async (fn: () => Promise<void>) => {
    setBusy(true);
    setFehler(null);
    try {
      await fn();
    } catch (error) {
      const m = error instanceof ApiError ? error.message : 'Das hat nicht geklappt. Bitte erneut versuchen.';
      setFehler(m);
      toast.error(m);
    } finally {
      setBusy(false);
    }
  };

  const codeAnfordern = () =>
    aufruf(async () => {
      const r = await api.post<{ sentTo: string; resendAfter: string }>(`/api/public/signatures/${publicId}/otp/request`, {});
      setCodeGesendet(r);
      toast.success(`Code gesendet an ${r.sentTo}.`);
    });

  const codePruefen = () =>
    aufruf(async () => {
      await api.post(`/api/public/signatures/${publicId}/otp/verify`, { code });
      toast.success('Code bestätigt.');
      await laden();
    });

  const unterzeichnen = () =>
    aufruf(async () => {
      await api.post(`/api/public/signatures/${publicId}/complete`, {
        accepted: true,
        method: methode,
        name: name.trim(),
        imageDataUrl: methode === 'DRAWN' ? bild : undefined,
      });
      toast.success('Vielen Dank — das Dokument ist unterzeichnet.');
      await laden();
    });

  const ablehnung = () =>
    aufruf(async () => {
      await api.post(`/api/public/signatures/${publicId}/decline`, { reason: grund || undefined });
      await laden();
    });

  if (lade === 'laden') {
    return (
      <div className="container flex min-h-[50vh] items-center justify-center" role="status">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
      </div>
    );
  }
  if (lade !== 'bereit' || !zustand) {
    return (
      <div className="container max-w-lg py-16 text-center">
        <AlertTriangle className="mx-auto mb-3 size-8 text-warning" aria-hidden />
        <h1 className="font-display text-lg font-semibold">
          {lade === 'ungueltig' ? 'Dieser Link ist nicht mehr gültig' : 'Verbindung unterbrochen'}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {lade === 'ungueltig'
            ? 'Die Sitzung ist abgelaufen oder der Vorgang ist beendet. Öffnen Sie den Link aus Ihrer E-Mail erneut.'
            : 'Bitte laden Sie die Seite neu.'}
        </p>
      </div>
    );
  }

  const { request, participant } = zustand;
  const fertig = participant.status === 'SIGNED';
  const abgelehnt = participant.status === 'DECLINED';
  const offen = request.status === 'PENDING' && !fertig && !abgelehnt;
  const codeNoetig = participant.requiresCode && !participant.verified;
  const kannUnterzeichnen =
    offen && !codeNoetig && zustimmung && name.trim().length >= 2 && (methode === 'TYPED' || Boolean(bild));

  return (
    <div className="container max-w-3xl space-y-8 py-10">
      <header className="space-y-2">
        <p className="text-meta text-muted-foreground">Elektronische Unterzeichnung</p>
        <h1 className="font-display text-title font-bold">{request.title}</h1>
        <p className="text-sm text-muted-foreground">
          Für {participant.name} ({participant.email})
          {request.documentVersion ? ` · Fassung ${request.documentVersion}` : ''} · gültig bis{' '}
          {formatDateLong(new Date(request.expiresAt))}
        </p>
      </header>

      {fertig ? (
        <Alert variant="success" title="Unterzeichnet">
          Vielen Dank. Sie erhalten eine E-Mail mit einem Link zum unterzeichneten Dokument und zum Signaturprotokoll.
        </Alert>
      ) : null}
      {abgelehnt ? <Alert variant="warning" title="Abgelehnt">Sie haben die Unterzeichnung abgelehnt.</Alert> : null}
      {!offen && !fertig && !abgelehnt ? (
        <Alert variant="warning" title="Vorgang beendet">Dieser Vorgang ist nicht mehr offen.</Alert>
      ) : null}

      <section aria-label="Dokument" className="space-y-3">
        <h2 className="font-display text-lg font-semibold">1. Dokument lesen</h2>
        <p className="text-sm text-muted-foreground">
          {request.artifactMode === 'DETACHED_EVIDENCE'
            ? 'Sie bestätigen genau dieses Dokument. Es bleibt unverändert; Ihre Unterzeichnung wird in einem separaten Signaturprotokoll festgehalten.'
            : 'Sie unterzeichnen genau dieses Dokument. Nach Abschluss entsteht eine Fassung mit sichtbarer Unterschrift.'}
        </p>
        <PdfViewer
          source={`/api/public/signatures/${publicId}/document`}
          fileName={`${request.title}.pdf`}
          canPrint={false}
          initialFit="width"
        />
      </section>

      {offen ? (
        <>
          {participant.requiresCode ? (
            <section aria-label="Bestätigungscode" className="space-y-3">
              <h2 className="font-display text-lg font-semibold">2. Code bestätigen</h2>
              {participant.verified ? (
                <p className="flex items-center gap-2 text-sm text-success">
                  <CheckCircle2 className="size-4" aria-hidden /> Code bestätigt.
                </p>
              ) : (
                <div className="space-y-3 rounded-2xl border border-border bg-card p-5">
                  <p className="text-sm text-muted-foreground">
                    Wir senden Ihnen einen sechsstelligen Code{' '}
                    {request.assuranceLevel === 'LINK_PLUS_SMS_CODE' ? `per SMS an ${participant.phone ?? 'Ihre Mobilnummer'}` : `per E-Mail an ${participant.email}`}.
                  </p>
                  <div className="flex flex-wrap items-end gap-3">
                    <Button type="button" variant="outline" onClick={codeAnfordern} disabled={busy}>
                      {codeGesendet ? 'Code erneut senden' : 'Code senden'}
                    </Button>
                    {codeGesendet ? (
                      <>
                        <div className="space-y-1">
                          <Label htmlFor="sig-code">Code</Label>
                          <Input
                            id="sig-code"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            maxLength={6}
                            value={code}
                            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                            className="w-32 tabular-nums"
                          />
                        </div>
                        <Button type="button" onClick={codePruefen} disabled={busy || code.length !== 6}>
                          Bestätigen
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              )}
            </section>
          ) : null}

          <section aria-label="Zustimmung und Unterschrift" className="space-y-4">
            <h2 className="font-display text-lg font-semibold">{participant.requiresCode ? '3.' : '2.'} Zustimmen und unterzeichnen</h2>

            <label className="flex items-start gap-3 rounded-2xl border border-border bg-card p-5">
              <Checkbox
                checked={zustimmung}
                onCheckedChange={(v) => setZustimmung(v === true)}
                aria-describedby="sig-consent-text"
                disabled={codeNoetig}
              />
              <span id="sig-consent-text" className="text-sm leading-relaxed">
                {request.consent.text}
              </span>
            </label>

            <div className="space-y-1">
              <Label htmlFor="sig-name">Ihr Name</Label>
              <Input id="sig-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} disabled={codeNoetig} />
            </div>

            <div className="space-y-2">
              <div className="flex gap-2" role="radiogroup" aria-label="Art der Unterschrift">
                <Button
                  type="button"
                  variant={methode === 'DRAWN' ? 'secondary' : 'outline'}
                  size="sm"
                  role="radio"
                  aria-checked={methode === 'DRAWN'}
                  onClick={() => setMethode('DRAWN')}
                >
                  <PenLine aria-hidden /> Zeichnen
                </Button>
                <Button
                  type="button"
                  variant={methode === 'TYPED' ? 'secondary' : 'outline'}
                  size="sm"
                  role="radio"
                  aria-checked={methode === 'TYPED'}
                  onClick={() => setMethode('TYPED')}
                >
                  <Type aria-hidden /> Tippen
                </Button>
              </div>
              {methode === 'DRAWN' ? (
                <SignaturePad value={bild} onChange={setBild} />
              ) : (
                <div className="rounded-2xl border border-border bg-card p-5">
                  <p className="font-display text-2xl italic">{name.trim() || 'Ihr Name'}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Ihr Name wird als getippte Unterschrift festgehalten — vollständig mit der Tastatur bedienbar.
                  </p>
                </div>
              )}
            </div>

            {fehler ? <Alert variant="destructive">{fehler}</Alert> : null}

            <div className="flex flex-col gap-3 sm:flex-row">
              <Button type="button" size="lg" className="sm:flex-1" onClick={unterzeichnen} disabled={!kannUnterzeichnen || busy}>
                {busy ? <Loader2 className="animate-spin" aria-hidden /> : <CheckCircle2 aria-hidden />}
                Verbindlich elektronisch unterzeichnen
              </Button>
              <Button type="button" size="lg" variant="ghost" onClick={() => setAblehnen((v) => !v)} disabled={busy}>
                Ablehnen
              </Button>
            </div>
            {ablehnen ? (
              <div className="space-y-3 rounded-2xl border border-border bg-card p-5">
                <Label htmlFor="sig-grund">Grund (optional)</Label>
                <Textarea id="sig-grund" value={grund} onChange={(e) => setGrund(e.target.value)} rows={3} maxLength={500} />
                <Button type="button" variant="destructive" onClick={ablehnung} disabled={busy}>
                  Unterzeichnung ablehnen
                </Button>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Festgehalten werden Zeitpunkt, der verwendete Link, ein bestätigter Code, Ihr Name, die Art der Unterschrift und
              technische Angaben Ihres Geräts. Keine qualifizierte elektronische Signatur.
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}
