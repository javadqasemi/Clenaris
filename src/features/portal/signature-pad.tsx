'use client';

import * as React from 'react';
import { Eraser } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/**
 * Unterschriftenfeld.
 *
 * Architekturentscheide:
 *  • Reines Canvas mit Pointer-Events — funktioniert mit Finger, Stift und
 *    Maus, ohne Bibliothek.
 *  • Die Zeichenfläche skaliert mit `devicePixelRatio`, sonst wirkt der Strich
 *    auf Retina-Displays ausgefranst.
 *  • Ausgabe ist ein PNG-DataURL. Er wird am Beleg gespeichert und ins PDF
 *    eingebettet; zusammen mit Name, Zeitstempel und IP ist das eine
 *    einfache elektronische Signatur im Sinne des ZertES.
 */
export function SignaturePad({
  value,
  onChange,
  className,
}: {
  value: string | null;
  onChange: (dataUrl: string | null) => void;
  className?: string;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const drawing = React.useRef(false);
  const [hasStrokes, setHasStrokes] = React.useState(Boolean(value));

  // Zeichenfläche an die Anzeigegrösse anpassen.
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();

      canvas.width = rect.width * ratio;
      canvas.height = rect.height * ratio;

      const context = canvas.getContext('2d');
      if (!context) return;

      context.scale(ratio, ratio);
      context.lineWidth = 2;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.strokeStyle = getComputedStyle(canvas).color || '#0F172A';
    };

    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  const positionFrom = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const start = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const context = canvasRef.current?.getContext('2d');
    if (!context) return;

    const { x, y } = positionFrom(event);
    context.beginPath();
    context.moveTo(x, y);
    drawing.current = true;
  };

  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const context = canvasRef.current?.getContext('2d');
    if (!context) return;

    const { x, y } = positionFrom(event);
    context.lineTo(x, y);
    context.stroke();
    setHasStrokes(true);
  };

  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;

    const canvas = canvasRef.current;
    if (!canvas) return;
    onChange(canvas.toDataURL('image/png'));
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    context.clearRect(0, 0, canvas.width, canvas.height);
    setHasStrokes(false);
    onChange(null);
  };

  return (
    <div className={cn('space-y-2', className)}>
      <div className="relative overflow-hidden rounded-xl border-2 border-dashed border-border bg-card">
        <canvas
          ref={canvasRef}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerLeave={end}
          className="h-40 w-full touch-none text-foreground"
          aria-label="Unterschriftenfeld — mit Finger, Stift oder Maus unterschreiben"
          role="img"
        />

        {!hasStrokes ? (
          <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            Hier unterschreiben
          </p>
        ) : null}

        {/* Signaturlinie */}
        <div className="pointer-events-none absolute inset-x-8 bottom-8 border-b border-border" aria-hidden />
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Mit der Unterschrift wird die Ausführung bestätigt.
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={clear} disabled={!hasStrokes}>
          <Eraser aria-hidden />
          Löschen
        </Button>
      </div>
    </div>
  );
}
