'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Save, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import { Alert } from '@/components/ui/primitives';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/overlays';

/**
 * Blogartikel entwerfen.
 *
 * Der Entwurf wird als `DRAFT` gespeichert, nie direkt veröffentlicht. Ein
 * ungelesener KI-Text auf der Firmenwebsite ist ein Reputationsrisiko — die
 * Freigabe bleibt bewusst ein zweiter, bewusster Schritt.
 */
export function BlogDraftDialog() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const [topic, setTopic] = React.useState('');
  const [keywords, setKeywords] = React.useState('');
  const [draft, setDraft] = React.useState<{
    title: string;
    excerpt: string;
    content: string;
    seoTitle: string;
    seoDescription: string;
  } | null>(null);

  const generate = async () => {
    setPending('generate');
    setError(null);
    try {
      const result = await api.post<typeof draft>('/api/ai/blog-draft', {
        topic,
        keywords: keywords
          .split(',')
          .map((keyword) => keyword.trim())
          .filter(Boolean),
      });
      setDraft(result);
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Der Entwurf konnte nicht erstellt werden.';
      setError(message);
      toast.error(message);
    } finally {
      setPending(null);
    }
  };

  const save = async () => {
    if (!draft) return;
    setPending('save');
    setError(null);
    try {
      await api.post('/api/blog', draft);
      toast.success('Entwurf gespeichert. Nach der Prüfung können Sie ihn veröffentlichen.');
      setOpen(false);
      setDraft(null);
      setTopic('');
      setKeywords('');
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Der Entwurf konnte nicht gespeichert werden.';
      setError(message);
      toast.error(message);
    } finally {
      setPending(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Sparkles aria-hidden />
          Artikel entwerfen
        </Button>
      </DialogTrigger>

      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Blogartikel entwerfen</DialogTitle>
          <DialogDescription>
            Thema und Suchbegriffe angeben — wir erstellen einen Rohtext. Der Artikel wird als
            Entwurf gespeichert; veröffentlichen Sie ihn erst nach dem Gegenlesen.
          </DialogDescription>
        </DialogHeader>

        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="blog-topic" required>
                Thema
              </Label>
              <Input
                id="blog-topic"
                value={topic}
                onChange={(event) => setTopic(event.target.value)}
                placeholder="z. B. Backofen richtig reinigen ohne aggressive Chemie"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="blog-keywords">Suchbegriffe</Label>
              <Input
                id="blog-keywords"
                value={keywords}
                onChange={(event) => setKeywords(event.target.value)}
                placeholder="Backofen reinigen, Hausmittel, Fett lösen"
              />
            </div>
          </div>

          <Button
            variant="outline"
            onClick={generate}
            loading={pending === 'generate'}
            disabled={topic.trim().length < 5}
          >
            <Sparkles aria-hidden />
            Entwurf erstellen
          </Button>

          {draft ? (
            <div className="space-y-4 border-t border-border pt-4">
              <div className="space-y-2">
                <Label htmlFor="draft-title">Titel</Label>
                <Input
                  id="draft-title"
                  value={draft.title}
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="draft-excerpt">Teaser</Label>
                <Textarea
                  id="draft-excerpt"
                  value={draft.excerpt}
                  onChange={(event) => setDraft({ ...draft, excerpt: event.target.value })}
                  rows={2}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="draft-content">Text (Markdown)</Label>
                <Textarea
                  id="draft-content"
                  value={draft.content}
                  onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                  rows={16}
                  className="font-mono text-sm"
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="draft-seo-title">SEO-Titel</Label>
                  <Input
                    id="draft-seo-title"
                    value={draft.seoTitle}
                    onChange={(event) => setDraft({ ...draft, seoTitle: event.target.value })}
                    maxLength={60}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="draft-seo-description">SEO-Beschreibung</Label>
                  <Input
                    id="draft-seo-description"
                    value={draft.seoDescription}
                    onChange={(event) => setDraft({ ...draft, seoDescription: event.target.value })}
                    maxLength={155}
                  />
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Abbrechen
          </Button>
          <Button onClick={save} loading={pending === 'save'} disabled={!draft}>
            <Save aria-hidden />
            Als Entwurf speichern
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
