'use client';

import * as React from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronUp, ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { NAV_LOCATION_LABELS, NAV_LOCATIONS, LEGAL_LABELS } from '@/lib/validation/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { Tabs, TabsContent, TabsList, TabsTriggerUnderline } from '@/components/ui/controls';
import { EmptyState, ListCard, TableScroll } from '@/components/app/page-parts';

import { FaqForm, type FaqRow } from './faq-form';
import { GalleryForm, type GalleryRow } from './gallery-form';
import { NavItemForm, type NavRow } from './nav-form';
import { LegalForm, type LegalRow } from './legal-form';
import { ConfirmDelete } from './confirm-delete';

/**
 * Website-Inhalte: häufige Fragen, Galerie, Navigation, Rechtstexte.
 *
 * Vier Register statt vier Seiten, weil sie zusammen die Frage beantworten
 * „was steht auf der Website" — und weil man beim Pflegen der Navigation
 * regelmässig merkt, dass ein Ziel noch fehlt.
 */

export interface WebsiteData {
  faqs: FaqRow[];
  gallery: GalleryRow[];
  navigation: NavRow[];
  legal: LegalRow[];
}

export interface WebsiteRights {
  faq: { create: boolean; update: boolean; delete: boolean };
  gallery: { create: boolean; update: boolean; delete: boolean };
  navigation: { update: boolean };
  legal: { update: boolean };
}

type Editing =
  | { kind: 'faq'; row?: FaqRow }
  | { kind: 'gallery'; row?: GalleryRow }
  | { kind: 'nav'; row?: NavRow }
  | { kind: 'legal'; row: LegalRow }
  | null;

export function WebsiteWorkspace({ data, rights }: { data: WebsiteData; rights: WebsiteRights }) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<Editing>(null);
  const [deleting, setDeleting] = React.useState<{
    title: string;
    description: string;
    endpoint: string;
  } | null>(null);
  const [busy, setBusy] = React.useState(false);

  const move = async (
    endpoint: string,
    payload: Record<string, unknown>,
    ids: string[],
    index: number,
    delta: number,
  ) => {
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    const next = [...ids];
    [next[index], next[target]] = [next[target], next[index]];

    setBusy(true);
    try {
      await api.post(endpoint, { ...payload, ids: next });
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Die Reihenfolge blieb ungespeichert.');
    } finally {
      setBusy(false);
    }
  };

  const faqIds = data.faqs.map((f) => f.id);
  const galleryIds = data.gallery.map((g) => g.id);

  return (
    <>
      <Tabs defaultValue="faq">
        <div className="overflow-x-auto">
          <TabsList variant="underline">
            <TabsTriggerUnderline value="faq">
              Häufige Fragen
              <Count value={data.faqs.length} />
            </TabsTriggerUnderline>
            <TabsTriggerUnderline value="gallery">
              Galerie
              <Count value={data.gallery.length} />
            </TabsTriggerUnderline>
            <TabsTriggerUnderline value="nav">
              Navigation
              <Count value={data.navigation.length} />
            </TabsTriggerUnderline>
            <TabsTriggerUnderline value="legal">
              Rechtstexte
              <Count value={data.legal.filter((l) => l.version > 0).length} />
            </TabsTriggerUnderline>
          </TabsList>
        </div>

        {/* --- Häufige Fragen ---------------------------------------------- */}
        <TabsContent value="faq" className="space-y-4">
          <ListCard
            title={`Häufige Fragen (${data.faqs.length})`}
            action={
              rights.faq.create ? (
                <Button size="sm" onClick={() => setEditing({ kind: 'faq' })}>
                  <Plus aria-hidden />
                  Frage
                </Button>
              ) : null
            }
            footer={
              <p className="text-meta leading-relaxed text-muted-foreground">
                Erscheint auf <code>/faq</code> und in Auszügen auf der Startseite. Die Reihenfolge
                bestimmt, was zuerst gelesen wird — die häufigste Frage gehört nach oben.
              </p>
            }
          >
            {data.faqs.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  title="Noch keine Fragen"
                  description="Jede Frage, die am Telefon zweimal kommt, gehört hierher — sie spart beim dritten Mal den Anruf."
                />
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {data.faqs.map((faq, index) => (
                  <li key={faq.id} className="flex flex-wrap items-start justify-between gap-4 p-5">
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {faq.question}
                        <Badge variant="neutral" size="sm">
                          {faq.category}
                        </Badge>
                        {faq.active ? null : (
                          <Badge variant="neutral" size="sm">
                            Nicht sichtbar
                          </Badge>
                        )}
                      </p>
                      <p className="line-clamp-2 text-meta leading-relaxed text-muted-foreground">
                        {faq.answer}
                      </p>
                    </div>

                    <RowButtons
                      label={faq.question}
                      canUpdate={rights.faq.update}
                      canDelete={rights.faq.delete}
                      busy={busy}
                      first={index === 0}
                      last={index === data.faqs.length - 1}
                      onUp={() => move('/api/website/reorder', { entity: 'faq' }, faqIds, index, -1)}
                      onDown={() => move('/api/website/reorder', { entity: 'faq' }, faqIds, index, 1)}
                      onEdit={() => setEditing({ kind: 'faq', row: faq })}
                      onDelete={() =>
                        setDeleting({
                          title: faq.question,
                          description:
                            'Die Frage verschwindet sofort von der Website. Es gibt keinen Papierkorb — eine Frage ist schnell neu erfasst.',
                          endpoint: `/api/faq/${faq.id}`,
                        })
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </ListCard>
        </TabsContent>

        {/* --- Galerie ------------------------------------------------------ */}
        <TabsContent value="gallery" className="space-y-4">
          <ListCard
            title={`Vorher / Nachher (${data.gallery.length})`}
            action={
              rights.gallery.create ? (
                <Button size="sm" onClick={() => setEditing({ kind: 'gallery' })}>
                  <Plus aria-hidden />
                  Eintrag
                </Button>
              ) : null
            }
            footer={
              <p className="text-meta leading-relaxed text-muted-foreground">
                Der hervorgehobene Eintrag steht im Kopfbereich der Startseite. Reinigung beweist
                man mit dem Ergebnis, nicht mit Adjektiven — das ist das stärkste Argument der
                Seite.
              </p>
            }
          >
            {data.gallery.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  title="Noch keine Bilder"
                  description="Ohne Vorher-/Nachher-Vergleich zeigt die Startseite einen leeren Platzhalter."
                />
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {data.gallery.map((item, index) => (
                  <li key={item.id} className="flex flex-wrap items-center justify-between gap-4 p-5">
                    <div className="flex min-w-0 flex-1 items-center gap-4">
                      <div className="flex shrink-0 gap-1">
                        <Thumb src={item.beforeUrl} label="vorher" />
                        <Thumb src={item.afterUrl} label="nachher" />
                      </div>
                      <div className="min-w-0 space-y-1">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          {item.title}
                          {item.featured ? (
                            <Badge variant="info" size="sm">
                              Startseite
                            </Badge>
                          ) : null}
                          {item.published ? null : (
                            <Badge variant="neutral" size="sm">
                              Nicht sichtbar
                            </Badge>
                          )}
                        </p>
                        <p className="text-meta text-muted-foreground">
                          {item.location ?? 'ohne Ortsangabe'}
                        </p>
                      </div>
                    </div>

                    <RowButtons
                      label={item.title}
                      canUpdate={rights.gallery.update}
                      canDelete={rights.gallery.delete}
                      busy={busy}
                      first={index === 0}
                      last={index === data.gallery.length - 1}
                      onUp={() =>
                        move('/api/website/reorder', { entity: 'gallery' }, galleryIds, index, -1)
                      }
                      onDown={() =>
                        move('/api/website/reorder', { entity: 'gallery' }, galleryIds, index, 1)
                      }
                      onEdit={() => setEditing({ kind: 'gallery', row: item })}
                      onDelete={() =>
                        setDeleting({
                          title: item.title,
                          description:
                            'Der Eintrag verschwindet von der Galerie und ggf. von der Startseite. Die Bilddateien selbst bleiben in der Mediathek.',
                          endpoint: `/api/gallery/${item.id}`,
                        })
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </ListCard>
        </TabsContent>

        {/* --- Navigation --------------------------------------------------- */}
        <TabsContent value="nav" className="space-y-4">
          <Alert variant="info">
            Logo, Telefonnummer und die Handlungsaufrufe stehen nicht in dieser Liste — sie kommen
            aus den Firmendaten und der CTA-Verwaltung. Hier stehen die Menüpunkte.
          </Alert>

          {NAV_LOCATIONS.map((location) => {
            const rows = data.navigation.filter(
              (item) => item.location === location && !item.parentId,
            );
            const ids = rows.map((r) => r.id);

            return (
              <ListCard
                key={location}
                title={`${NAV_LOCATION_LABELS[location]} (${rows.length})`}
                action={
                  rights.navigation.update && location !== 'HEADER_PANEL' ? (
                    <Button size="sm" variant="outline" onClick={() => setEditing({ kind: 'nav' })}>
                      <Plus aria-hidden />
                      Punkt
                    </Button>
                  ) : null
                }
              >
                {rows.length === 0 ? (
                  <p className="px-5 py-6 text-sm text-muted-foreground">
                    {location === 'HEADER_PANEL'
                      ? 'Punkte im Aufklappbereich erscheinen unter ihrem übergeordneten Eintrag der Kopfzeile.'
                      : 'An diesem Ort steht nichts.'}
                  </p>
                ) : (
                  <ul className="divide-y divide-border">
                    {rows.map((item, index) => {
                      const children = data.navigation.filter((c) => c.parentId === item.id);
                      return (
                        <li key={item.id} className="p-5">
                          <div className="flex flex-wrap items-start justify-between gap-4">
                            <div className="min-w-0 space-y-1">
                              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                                {item.label}
                                {item.active ? null : (
                                  <Badge variant="neutral" size="sm">
                                    Nicht sichtbar
                                  </Badge>
                                )}
                                {item.newTab ? (
                                  <ExternalLink
                                    className="size-3 text-muted-foreground"
                                    aria-label="Öffnet in neuem Tab"
                                  />
                                ) : null}
                              </p>
                              <p className="font-mono text-meta text-muted-foreground">
                                {item.href}
                              </p>
                              {children.length > 0 ? (
                                <ul className="mt-2 space-y-1 border-l border-border pl-4">
                                  {children.map((child) => (
                                    <li
                                      key={child.id}
                                      className="flex flex-wrap items-center justify-between gap-2 text-meta"
                                    >
                                      <span>
                                        {child.label}{' '}
                                        <span className="font-mono text-muted-foreground">
                                          {child.href}
                                        </span>
                                      </span>
                                      {rights.navigation.update ? (
                                        <span className="flex gap-0.5">
                                          <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            aria-label={`${child.label} bearbeiten`}
                                            onClick={() => setEditing({ kind: 'nav', row: child })}
                                          >
                                            <Pencil aria-hidden />
                                          </Button>
                                          <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            aria-label={`${child.label} löschen`}
                                            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                            onClick={() =>
                                              setDeleting({
                                                title: child.label,
                                                description:
                                                  'Der Punkt verschwindet aus dem Aufklappbereich.',
                                                endpoint: `/api/navigation/${child.id}`,
                                              })
                                            }
                                          >
                                            <Trash2 aria-hidden />
                                          </Button>
                                        </span>
                                      ) : null}
                                    </li>
                                  ))}
                                </ul>
                              ) : null}
                            </div>

                            <RowButtons
                              label={item.label}
                              canUpdate={rights.navigation.update}
                              canDelete={rights.navigation.update}
                              busy={busy}
                              first={index === 0}
                              last={index === rows.length - 1}
                              onUp={() =>
                                move('/api/navigation/reorder', { location }, ids, index, -1)
                              }
                              onDown={() =>
                                move('/api/navigation/reorder', { location }, ids, index, 1)
                              }
                              onEdit={() => setEditing({ kind: 'nav', row: item })}
                              onDelete={() =>
                                setDeleting({
                                  title: item.label,
                                  description:
                                    children.length > 0
                                      ? `Der Punkt verschwindet aus dem Menü — mitsamt seinen ${children.length} Unterpunkten. Ein Unterpunkt ohne seinen Aufklapper wäre nirgends erreichbar.`
                                      : 'Der Punkt verschwindet aus dem Menü.',
                                  endpoint: `/api/navigation/${item.id}`,
                                })
                              }
                            />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </ListCard>
            );
          })}
        </TabsContent>

        {/* --- Rechtstexte -------------------------------------------------- */}
        <TabsContent value="legal" className="space-y-4">
          <Alert variant="info">
            Solange kein Text erfasst ist, zeigt die Website die eingebaute Auslieferungsfassung —
            eine leere Datenschutzerklärung wäre ein Rechtsmangel. Sobald Sie hier speichern,
            ersetzt Ihr Text sie vollständig.
          </Alert>

          <ListCard title="Rechtstexte">
            <TableScroll minWidth="42rem">
              <table className="data-table">
                <caption className="sr-only">Impressum, Datenschutz, AGB, Cookie-Hinweis</caption>
                <thead>
                  <tr>
                    <th scope="col">Dokument</th>
                    <th scope="col">Fassung</th>
                    <th scope="col">In Kraft seit</th>
                    <th scope="col">Umfang</th>
                    <th scope="col" className="text-right">
                      <span className="sr-only">Aktionen</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.legal.map((doc) => (
                    <tr key={doc.slug}>
                      <td>
                        <span className="font-medium">
                          {LEGAL_LABELS[doc.slug as keyof typeof LEGAL_LABELS] ?? doc.slug}
                        </span>
                        <span className="block font-mono text-xs text-muted-foreground">
                          /legal/{doc.slug}
                        </span>
                      </td>
                      <td>
                        {doc.version > 0 ? (
                          <Badge variant="success" size="sm">
                            Fassung {doc.version}
                          </Badge>
                        ) : (
                          <Badge variant="warning" size="sm">
                            Auslieferungsfassung
                          </Badge>
                        )}
                      </td>
                      <td className="whitespace-nowrap text-muted-foreground">
                        {doc.effectiveFrom
                          ? new Date(doc.effectiveFrom).toLocaleDateString('de-CH', {
                              day: '2-digit',
                              month: '2-digit',
                              year: 'numeric',
                              timeZone: 'Europe/Zurich',
                            })
                          : '—'}
                      </td>
                      <td className="num text-muted-foreground">
                        {doc.body.length > 0 ? `${doc.body.length} Zeichen` : '—'}
                      </td>
                      <td>
                        <div className="flex justify-end gap-2">
                          <Button asChild variant="ghost" size="sm">
                            <a
                              href={`/legal/${doc.slug}`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <ExternalLink aria-hidden />
                              Ansehen
                            </a>
                          </Button>
                          {rights.legal.update ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setEditing({ kind: 'legal', row: doc })}
                            >
                              <Pencil aria-hidden />
                              Bearbeiten
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </ListCard>
        </TabsContent>
      </Tabs>

      <FaqForm
        open={editing?.kind === 'faq'}
        onOpenChange={(open) => !open && setEditing(null)}
        faq={editing?.kind === 'faq' ? editing.row : undefined}
      />
      <GalleryForm
        open={editing?.kind === 'gallery'}
        onOpenChange={(open) => !open && setEditing(null)}
        item={editing?.kind === 'gallery' ? editing.row : undefined}
      />
      <NavItemForm
        open={editing?.kind === 'nav'}
        onOpenChange={(open) => !open && setEditing(null)}
        item={editing?.kind === 'nav' ? editing.row : undefined}
        headerItems={data.navigation.filter((n) => n.location === 'HEADER' && !n.parentId)}
      />
      <LegalForm
        open={editing?.kind === 'legal'}
        onOpenChange={(open) => !open && setEditing(null)}
        document={editing?.kind === 'legal' ? editing.row : undefined}
      />

      <ConfirmDelete
        target={deleting}
        onClose={() => setDeleting(null)}
      />
    </>
  );
}

function Count({ value }: { value: number }) {
  return <span className="text-xs tabular-nums text-muted-foreground">{value}</span>;
}

function Thumb({ src, label }: { src: string; label: string }) {
  return (
    <span className="relative block size-12 overflow-hidden rounded-lg border border-border bg-muted">
      {/* `unoptimized`: die Adressen kommen aus dem Objektspeicher und stehen
          nicht in der Domänenliste von next.config. */}
      <Image src={src} alt={label} fill unoptimized sizes="48px" className="object-cover" />
    </span>
  );
}

function RowButtons({
  label,
  canUpdate,
  canDelete,
  busy,
  first,
  last,
  onUp,
  onDown,
  onEdit,
  onDelete,
}: {
  label: string;
  canUpdate: boolean;
  canDelete: boolean;
  busy: boolean;
  first: boolean;
  last: boolean;
  onUp: () => void;
  onDown: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={cn('flex shrink-0 items-center gap-0.5')}>
      {canUpdate ? (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`${label} nach oben`}
            disabled={first || busy}
            onClick={onUp}
          >
            <ChevronUp aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`${label} nach unten`}
            disabled={last || busy}
            onClick={onDown}
          >
            <ChevronDown aria-hidden />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={`${label} bearbeiten`} onClick={onEdit}>
            <Pencil aria-hidden />
          </Button>
        </>
      ) : null}
      {canDelete ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`${label} löschen`}
          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}
