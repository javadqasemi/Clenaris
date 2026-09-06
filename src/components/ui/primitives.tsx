'use client';

import * as React from 'react';
import * as AvatarPrimitive from '@radix-ui/react-avatar';
import * as ProgressPrimitive from '@radix-ui/react-progress';
import * as SeparatorPrimitive from '@radix-ui/react-separator';
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import { cva, type VariantProps } from 'class-variance-authority';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';

import { cn, colorFromString, initials } from '@/lib/utils';

// ---------------------------------------------------------------------------
//  Separator
// ---------------------------------------------------------------------------

const Separator = React.forwardRef<
  React.ElementRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, orientation = 'horizontal', decorative = true, ...props }, ref) => (
  <SeparatorPrimitive.Root
    ref={ref}
    decorative={decorative}
    orientation={orientation}
    className={cn(
      'shrink-0 bg-border',
      orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
      className,
    )}
    {...props}
  />
));
Separator.displayName = 'Separator';

// ---------------------------------------------------------------------------
//  Avatar
// ---------------------------------------------------------------------------

const Avatar = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root> & { size?: 'sm' | 'md' | 'lg' }
>(({ className, size = 'md', ...props }, ref) => (
  <AvatarPrimitive.Root
    ref={ref}
    className={cn(
      'relative flex shrink-0 overflow-hidden rounded-full',
      { sm: 'size-8', md: 'size-10', lg: 'size-14' }[size],
      className,
    )}
    {...props}
  />
));
Avatar.displayName = 'Avatar';

const AvatarImage = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Image>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Image ref={ref} className={cn('aspect-square size-full object-cover', className)} {...props} />
));
AvatarImage.displayName = 'AvatarImage';

const AvatarFallback = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    className={cn(
      'flex size-full items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground',
      className,
    )}
    {...props}
  />
));
AvatarFallback.displayName = 'AvatarFallback';

/**
 * Personen-Avatar mit deterministischer Farbe aus dem Namen — ohne Bild sieht
 * jede Person trotzdem eindeutig aus.
 */
export function PersonAvatar({
  firstName,
  lastName,
  src,
  size = 'md',
  color,
  className,
}: {
  firstName?: string | null;
  lastName?: string | null;
  src?: string | null;
  size?: 'sm' | 'md' | 'lg';
  color?: string | null;
  className?: string;
}) {
  const name = `${firstName ?? ''} ${lastName ?? ''}`.trim() || '?';
  const background = color ?? colorFromString(name);

  return (
    <Avatar size={size} className={className}>
      {src ? <AvatarImage src={src} alt={name} /> : null}
      <AvatarFallback style={{ backgroundColor: `${background}1F`, color: background }}>
        {initials(firstName, lastName)}
      </AvatarFallback>
    </Avatar>
  );
}

// ---------------------------------------------------------------------------
//  Progress
// ---------------------------------------------------------------------------

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & { indicatorClassName?: string }
>(({ className, value, indicatorClassName, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn('relative h-2 w-full overflow-hidden rounded-full bg-muted', className)}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className={cn('h-full rounded-full bg-primary transition-transform duration-500 ease-spring', indicatorClassName)}
      style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
    />
  </ProgressPrimitive.Root>
));
Progress.displayName = 'Progress';

// ---------------------------------------------------------------------------
//  ScrollArea
// ---------------------------------------------------------------------------

const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <ScrollAreaPrimitive.Root ref={ref} className={cn('relative overflow-hidden', className)} {...props}>
    <ScrollAreaPrimitive.Viewport className="size-full rounded-[inherit]">
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollAreaPrimitive.Scrollbar
      orientation="vertical"
      className="flex w-2.5 touch-none select-none border-l border-l-transparent p-px transition-colors"
    >
      <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-border" />
    </ScrollAreaPrimitive.Scrollbar>
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
));
ScrollArea.displayName = 'ScrollArea';

// ---------------------------------------------------------------------------
//  Skeleton
// ---------------------------------------------------------------------------

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('skeleton', className)} aria-hidden {...props} />;
}

// ---------------------------------------------------------------------------
//  Alert
// ---------------------------------------------------------------------------

const alertVariants = cva(
  'relative flex gap-3 rounded-xl border p-4 text-sm [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:mt-0.5',
  {
    variants: {
      variant: {
        default: 'border-border bg-muted/60 text-foreground',
        info: 'border-info/25 bg-info/8 text-info',
        success: 'border-success/25 bg-success/8 text-success',
        warning: 'border-warning/30 bg-warning/8 text-warning',
        destructive: 'border-destructive/25 bg-destructive/8 text-destructive',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

const ALERT_ICONS = {
  default: Info,
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  destructive: XCircle,
} as const;

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {
  title?: string;
  hideIcon?: boolean;
}

function Alert({ className, variant = 'default', title, hideIcon, children, ...props }: AlertProps) {
  const Icon = ALERT_ICONS[variant ?? 'default'];
  return (
    <div role="alert" className={cn(alertVariants({ variant }), className)} {...props}>
      {hideIcon ? null : <Icon aria-hidden />}
      <div className="space-y-1">
        {title ? <p className="font-semibold leading-tight">{title}</p> : null}
        {children ? <div className="leading-relaxed [&_a]:underline">{children}</div> : null}
      </div>
    </div>
  );
}

export {
  Separator,
  Avatar,
  AvatarImage,
  AvatarFallback,
  Progress,
  ScrollArea,
  Skeleton,
  Alert,
  alertVariants,
};
