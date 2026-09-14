'use client';

import { Printer } from 'lucide-react';

import { Button, type ButtonProps } from '@/components/ui/button';

/**
 * «Drucken»-Schaltfläche.
 *
 * `window.print()` braucht einen Client-Aufruf, sonst nichts — deshalb kein
 * eigener Zustand und kein Dialog. Welche Teile der Seite gedruckt werden,
 * regelt der Druck-Abschnitt in `globals.css` über `.print-area`; die
 * Schaltfläche selbst gehört nicht dazu.
 */
export function PrintButton({
  label = 'Drucken',
  ...props
}: Omit<ButtonProps, 'onClick' | 'children'> & { label?: string }) {
  return (
    <Button type="button" onClick={() => window.print()} {...props}>
      <Printer aria-hidden />
      {label}
    </Button>
  );
}
