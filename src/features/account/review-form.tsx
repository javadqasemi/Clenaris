'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Star } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { cn, formatDate } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/controls';
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
 * Bewertung abgeben.
 *
 * Die Sternewahl ist eine echte Radiogruppe, keine Reihe von Buttons: mit
 * Pfeiltasten bedienbar, mit Screenreader ansagbar, und ohne JavaScript
 * immer noch ein sinnvolles Formularfeld.
 */
interface ReviewableBooking {
  id: string;
  number: string;
  scheduledStart: string | Date;
  serviceName: string;
}

const RATING_LABELS = [
  'Gar nicht zufrieden',
  'Wenig zufrieden',
  'Teils zufrieden',
  'Zufrieden',
  'Sehr zufrieden',
];

export function ReviewForm({ bookings }: { bookings: ReviewableBooking[] }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [rating, setRating] = React.useState(5);
  const [bookingId, setBookingId] = React.useState(bookings[0]?.id ?? '');
  const [title, setTitle] = React.useState('');
  const [body, setBody] = React.useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    try {
      await api.post('/api/reviews', {
        rating,
        title: title.trim() || undefined,
        body: body.trim(),
        bookingId: bookingId || undefined,
      });
      toast.success('Danke! Ihre Bewertung ist bei uns eingegangen.');
      setOpen(false);
      setTitle('');
      setBody('');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Senden fehlgeschlagen.');
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button disabled={bookings.length === 0}>
          <Star aria-hidden />
          Bewertung schreiben
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Wie war die Reinigung?</DialogTitle>
          <DialogDescription>
            Ihre Rückmeldung geht zuerst an die Betriebsleitung. Veröffentlicht wird sie erst,
            wenn wir sie gelesen haben — auch die kritische.
          </DialogDescription>
        </DialogHeader>

        <form id="review-form" className="space-y-5" onSubmit={submit}>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Bewertung</legend>
            <div className="flex items-center gap-1" role="radiogroup" aria-label="Sterne">
              {[1, 2, 3, 4, 5].map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={rating === value}
                  aria-label={`${value} von 5 — ${RATING_LABELS[value - 1]}`}
                  onClick={() => setRating(value)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
                      event.preventDefault();
                      setRating((current) => Math.min(5, current + 1));
                    }
                    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
                      event.preventDefault();
                      setRating((current) => Math.max(1, current - 1));
                    }
                  }}
                  tabIndex={rating === value ? 0 : -1}
                  className="rounded-lg p-1 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Star
                    className={cn(
                      'size-7',
                      value <= rating
                        ? 'fill-accent text-accent'
                        : 'text-muted-foreground/40',
                    )}
                    aria-hidden
                  />
                </button>
              ))}
              <span className="ml-2 text-sm text-muted-foreground">
                {RATING_LABELS[rating - 1]}
              </span>
            </div>
          </fieldset>

          {bookings.length > 0 ? (
            <div className="space-y-2">
              <Label htmlFor="booking">Termin</Label>
              <Select value={bookingId} onValueChange={setBookingId}>
                <SelectTrigger id="booking">
                  <SelectValue placeholder="Termin wählen" />
                </SelectTrigger>
                <SelectContent>
                  {bookings.map((booking) => (
                    <SelectItem key={booking.id} value={booking.id}>
                      {formatDate(booking.scheduledStart)} · {booking.serviceName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="review-title">Titel (freiwillig)</Label>
            <Input
              id="review-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={120}
              placeholder="z. B. Umzugsreinigung ohne Nachbesserung"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="review-body">Ihre Erfahrung</Label>
            <Textarea
              id="review-body"
              rows={5}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              maxLength={2000}
              required
              placeholder="Was ist gut gelaufen, was nicht?"
            />
            <p className="text-xs text-muted-foreground">
              {body.trim().length} von mindestens 10 Zeichen
            </p>
          </div>
        </form>

        <DialogFooter>
          <Button variant="outline" type="button" onClick={() => setOpen(false)}>
            Abbrechen
          </Button>
          <Button type="submit" form="review-form" disabled={pending || body.trim().length < 10}>
            {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Bewertung senden
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
