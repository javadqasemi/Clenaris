'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { EyeOff, RotateCcw, Save } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import { Checkbox } from '@/components/ui/controls';
import { Badge } from '@/components/ui/badge';

/**
 * Pflege der Suchmaschinenangaben.
 *
 * Gestaltungsentscheide:
 *
 *  • **Die Vorschau zeigt das Suchergebnis, nicht die Felder.** Niemand kann
 *    an zwei Eingabefeldern ablesen, wie ein Treffer bei Google aussieht —
 *    an einer Nachbildung schon. Sie macht auch sofort sichtbar, wo der Text
 *    abgeschnitten wird.
 *
 *  • **Die Längenmarke ist eine Warnung, keine Sperre.** Google schneidet
 *    Titel bei rund 60 und Beschreibungen bei rund 155 Zeichen ab — das sind
 *    Erfahrungswerte, keine Regeln. Wer bewusst länger schreibt, soll das
 *    dürfen und die Folge sehen.
 *
 *  • **„Nicht indexieren" steht abgesetzt und rot markiert.** Es ist die
 *    einzige Schaltung hier, die eine Seite aus den Suchergebnissen wirft.
 */
export interface SeoPageState {
  path: string;
  label: string;
  title: string;
  description: string;
  keywords: string[];
  ogImageUrl: string;
  noIndex: boolean;
  /** Registerwert — gilt, solange nichts gepflegt ist. */
  defaultTitle: string;
  defaultDescription: string;
  curated: boolean;
}

const TITLE_LIMIT = 60;
const DESCRIPTION_LIMIT = 155;

export function SeoEditor({ pages, siteUrl }: { pages: SeoPageState[]; siteUrl: string }) {
  const [activePath, setActivePath] = React.useState(pages[0]?.path ?? '/');
  const active = pages.find((page) => page.path === activePath) ?? pages[0];

  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)] lg:items-start">
      <nav
        aria-label="Seite wählen"
        className="overflow-hidden rounded-2xl border border-border bg-card"
      >
        <ul className="divide-y divide-border">
          {pages.map((page) => (
            <li key={page.path}>
              <button
                type="button"
                onClick={() => setActivePath(page.path)}
                aria-current={page.path === activePath ? 'true' : undefined}
                className={cn(
                  'flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm transition-colors hover:bg-muted/60',
                  page.path === activePath && 'bg-primary/6 font-medium text-primary',
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate">{page.label}</span>
                  <span className="block truncate font-mono text-2xs text-muted-foreground">
                    {page.path}
                  </span>
                </span>
                {page.noIndex ? (
                  <EyeOff className="size-3.5 shrink-0 text-destructive" aria-label="Nicht indexiert" />
                ) : page.curated ? (
                  <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="Gepflegt" />
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {active ? <SeoForm key={active.path} page={active} siteUrl={siteUrl} /> : null}
    </div>
  );
}

function SeoForm({ page, siteUrl }: { page: SeoPageState; siteUrl: string }) {
  const router = useRouter();
  const [title, setTitle] = React.useState(page.title);
  const [description, setDescription] = React.useState(page.description);
  const [keywords, setKeywords] = React.useState(page.keywords.join(', '));
  const [ogImageUrl, setOgImageUrl] = React.useState(page.ogImageUrl);
  const [noIndex, setNoIndex] = React.useState(page.noIndex);
  const [saving, setSaving] = React.useState(false);

  const shownTitle = title.trim() || page.defaultTitle;
  const shownDescription = description.trim() || page.defaultDescription;

  const save = async () => {
    setSaving(true);
    try {
      await api.patch('/api/seo', {
        path: page.path,
        title: title.trim(),
        description: description.trim(),
        keywords: keywords
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean),
        ogImageUrl: ogImageUrl.trim(),
        noIndex,
      });
      toast.success(`Angaben für „${page.label}" gespeichert.`);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Speichern fehlgeschlagen.');
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setTitle('');
    setDescription('');
    setKeywords('');
    setOgImageUrl('');
    setNoIndex(false);
  };

  return (
    <div className="space-y-6">
      {/* Vorschau */}
      <section
        className="space-y-3 rounded-2xl border border-border bg-card p-6 shadow-soft"
        aria-label="Vorschau des Suchergebnisses"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-base font-semibold tracking-tight">
            So sieht der Treffer aus
          </h2>
          {noIndex ? (
            <Badge variant="destructive" size="sm">
              Wird nicht angezeigt
            </Badge>
          ) : null}
        </div>

        <div className={cn('max-w-2xl space-y-1', noIndex && 'opacity-40')}>
          <p className="truncate text-2xs text-muted-foreground">
            {siteUrl.replace(/^https?:\/\//, '')}
            {page.path === '/' ? '' : page.path}
          </p>
          <p className="truncate text-lg text-primary">
            {truncate(shownTitle, TITLE_LIMIT)}
          </p>
          <p className="text-meta leading-relaxed text-muted-foreground">
            {truncate(shownDescription, DESCRIPTION_LIMIT)}
          </p>
        </div>
      </section>

      {/* Felder */}
      <section className="space-y-5 rounded-2xl border border-border bg-card p-6 shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-base font-semibold tracking-tight">{page.label}</h2>
          {page.curated ? (
            <Button variant="ghost" size="sm" onClick={reset}>
              <RotateCcw aria-hidden />
              Auf Standard
            </Button>
          ) : null}
        </div>

        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <Label htmlFor="seo-title">Seitentitel</Label>
            <Meter current={(title.trim() || page.defaultTitle).length} limit={TITLE_LIMIT} />
          </div>
          <Input
            id="seo-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={page.defaultTitle}
            aria-describedby="seo-title-help"
          />
          <p id="seo-title-help" className="text-meta text-muted-foreground">
            Leer lassen für den Standardtitel. Google schneidet nach rund {TITLE_LIMIT} Zeichen ab.
          </p>
        </div>

        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <Label htmlFor="seo-description">Beschreibung</Label>
            <Meter
              current={(description.trim() || page.defaultDescription).length}
              limit={DESCRIPTION_LIMIT}
            />
          </div>
          <Textarea
            id="seo-description"
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={page.defaultDescription}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="seo-keywords">Schlüsselwörter</Label>
          <Input
            id="seo-keywords"
            value={keywords}
            onChange={(event) => setKeywords(event.target.value)}
            placeholder="Reinigungsfirma Bern, Umzugsreinigung"
            aria-describedby="seo-keywords-help"
          />
          <p id="seo-keywords-help" className="text-meta text-muted-foreground">
            Mit Komma trennen. Google wertet sie seit Jahren nicht mehr aus — andere Suchdienste
            und interne Auswertungen schon.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="seo-og">Vorschaubild beim Teilen</Label>
          <Input
            id="seo-og"
            type="url"
            value={ogImageUrl}
            onChange={(event) => setOgImageUrl(event.target.value)}
            placeholder="https://…/vorschau.jpg"
            aria-describedby="seo-og-help"
          />
          <p id="seo-og-help" className="text-meta text-muted-foreground">
            Erscheint, wenn jemand den Link in WhatsApp, LinkedIn oder Facebook teilt. Ideal
            1200 × 630 Pixel.
          </p>
        </div>
      </section>

      {/* Ausschluss aus dem Index */}
      <section className="rounded-2xl border border-destructive/25 bg-destructive/5 p-5">
        <label className="flex items-start gap-3">
          <Checkbox
            checked={noIndex}
            onCheckedChange={(checked) => setNoIndex(checked === true)}
            aria-describedby="seo-noindex-help"
          />
          <span className="space-y-1">
            <span className="block text-sm font-medium">Diese Seite nicht indexieren</span>
            <span id="seo-noindex-help" className="block text-meta leading-relaxed text-muted-foreground">
              Die Seite verschwindet aus den Suchergebnissen — nicht sofort, aber innerhalb
              weniger Wochen. Sinnvoll für Kampagnenseiten und Dubletten, sonst kostet es
              Anfragen.
            </span>
          </span>
        </label>
      </section>

      <div className="flex justify-end">
        <Button onClick={save} loading={saving}>
          <Save aria-hidden />
          Speichern
        </Button>
      </div>
    </div>
  );
}

function Meter({ current, limit }: { current: number; limit: number }) {
  const over = current > limit;
  return (
    <span
      className={cn(
        'text-2xs tabular-nums',
        over ? 'font-medium text-warning' : 'text-muted-foreground',
      )}
    >
      {current} / {limit}
      {over ? ' — wird abgeschnitten' : ''}
    </span>
  );
}

function truncate(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}
