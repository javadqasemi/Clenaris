'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Icon links im Feld (z. B. Suche, Währung). */
  startIcon?: React.ReactNode;
  endIcon?: React.ReactNode;
  /** Einheit rechts im Feld, z. B. „m²" oder „CHF". */
  suffix?: string;
  invalid?: boolean;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', startIcon, endIcon, suffix, invalid, ...props }, ref) => {
    const field = (
      <input
        type={type}
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          'flex h-11 w-full rounded-xl border bg-card px-3.5 py-2 text-sm text-foreground',
          'transition-[border-color,box-shadow] duration-200',
          'placeholder:text-muted-foreground/70',
          'focus-visible:outline-none focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-primary/12',
          'disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-70',
          'file:border-0 file:bg-transparent file:text-sm file:font-medium',
          invalid ? 'border-destructive focus-visible:ring-destructive/15' : 'border-input',
          startIcon && 'pl-10',
          (endIcon || suffix) && 'pr-11',
          className,
        )}
        {...props}
      />
    );

    if (!startIcon && !endIcon && !suffix) return field;

    return (
      <div className="relative">
        {startIcon ? (
          <span
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground [&_svg]:size-4"
            aria-hidden
          >
            {startIcon}
          </span>
        ) : null}
        {field}
        {endIcon ? (
          <span
            className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground [&_svg]:size-4"
            aria-hidden
          >
            {endIcon}
          </span>
        ) : null}
        {suffix && !endIcon ? (
          <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
            {suffix}
          </span>
        ) : null}
      </div>
    );
  },
);
Input.displayName = 'Input';

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
>(({ className, invalid, rows = 4, ...props }, ref) => (
  <textarea
    ref={ref}
    rows={rows}
    aria-invalid={invalid || undefined}
    className={cn(
      'flex w-full rounded-xl border bg-card px-3.5 py-3 text-sm text-foreground',
      'transition-[border-color,box-shadow] duration-200',
      'placeholder:text-muted-foreground/70',
      'focus-visible:outline-none focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-primary/12',
      'disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-70',
      invalid ? 'border-destructive focus-visible:ring-destructive/15' : 'border-input',
      className,
    )}
    {...props}
  />
));
Textarea.displayName = 'Textarea';

export { Input, Textarea };
