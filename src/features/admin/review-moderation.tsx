'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, MessageSquare, Sparkles, Star, X } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import { Alert } from '@/components/ui/primitives';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/overlays';

/**
 * Moderation einer Bewertung.
 *
 * Bei kritischen Bewertungen (≤ 3 Sterne) ist die Antwort die wichtigere
 * Handlung — sie steht deshalb prominent und wird bei Bedarf per KI-Entwurf
 * unterstützt. Ablehnen bleibt für Spam und Beleidigungen reserviert.
 */
export function ReviewModeration({
  reviewId,
  status,
  featured,
  hasReply,
  rating,
}: {
  reviewId: string;
  status: string;
  featured: boolean;
  hasReply: boolean;
  rating: number;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);
  const [replyOpen, setReplyOpen] = React.useState(false);
  const [reply, setReply] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const run = async (action: string, body: Record<string, unknown>, message: string) => {
    setPending(action);
    setError(null);
    try {
      await api.patch(`/api/reviews/${reviewId}`, body);
      toast.success(message);
      setReplyOpen(false);
      router.refresh();
    } catch (err) {
      const text =
        err instanceof ApiError ? err.message : 'Die Änderung konnte nicht gespeichert werden.';
      setError(text);
      toast.error(text);
    } finally {
      setPending(null);
    }
  };

  const draftReply = async () => {
    setPending('ai');
    try {
      const result = await api.post<{ text: string }>(`/api/reviews/${reviewId}/reply-draft`);
      setReply(result.text);
      setReplyOpen(true);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Der Entwurf konnte nicht erstellt werden.',
      );
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        {status === 'PENDING' ? (
          <>
            <Button
              size="sm"
              variant="success"
              loading={pending === 'publish'}
              onClick={() => run('publish', { status: 'PUBLISHED' }, 'Bewertung veröffentlicht.')}
            >
              <Check aria-hidden />
              Veröffentlichen
            </Button>
            <Button
              size="sm"
              variant="outline"
              loading={pending === 'reject'}
              onClick={() =>
                run('reject', { status: 'REJECTED' }, 'Bewertung abgelehnt und nicht veröffentlicht.')
              }
            >
              <X aria-hidden />
              Ablehnen
            </Button>
          </>
        ) : null}

        {status === 'PUBLISHED' ? (
          <Button
            size="sm"
            variant={featured ? 'secondary' : 'outline'}
            loading={pending === 'feature'}
            onClick={() =>
              run(
                'feature',
                { featured: !featured },
                featured ? 'Hervorhebung entfernt.' : 'Auf der Startseite hervorgehoben.',
              )
            }
          >
            <Star aria-hidden />
            {featured ? 'Hervorhebung entfernen' : 'Hervorheben'}
          </Button>
        ) : null}

        <Button
          size="sm"
          variant={rating <= 3 && !hasReply ? 'default' : 'ghost'}
          onClick={() => setReplyOpen(true)}
        >
          <MessageSquare aria-hidden />
          {hasReply ? 'Antwort bearbeiten' : 'Öffentlich antworten'}
        </Button>

        {rating <= 3 && !hasReply ? (
          <Button size="sm" variant="ghost" loading={pending === 'ai'} onClick={draftReply}>
            <Sparkles aria-hidden />
            Antwort entwerfen
          </Button>
        ) : null}
      </div>

      <Dialog open={replyOpen} onOpenChange={setReplyOpen}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Öffentlich antworten</DialogTitle>
            <DialogDescription>
              Ihre Antwort erscheint unter der Bewertung auf der Website. Sachlich bleiben,
              Verantwortung übernehmen, konkrete Verbesserung nennen — das überzeugt mehr als jede
              Rechtfertigung.
            </DialogDescription>
          </DialogHeader>

          {error ? <Alert variant="destructive">{error}</Alert> : null}

          <div className="space-y-2">
            <Label htmlFor="review-reply" required>
              Antwort
            </Label>
            <Textarea
              id="review-reply"
              value={reply}
              onChange={(event) => setReply(event.target.value)}
              rows={6}
              placeholder="Guten Tag Frau Muster, vielen Dank für Ihre offene Rückmeldung …"
            />
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setReplyOpen(false)}>
              Abbrechen
            </Button>
            <Button
              disabled={reply.trim().length < 10}
              loading={pending === 'reply'}
              onClick={() => run('reply', { reply }, 'Antwort veröffentlicht.')}
            >
              Antwort veröffentlichen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
