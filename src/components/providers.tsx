'use client';

import * as React from 'react';
import { ThemeProvider } from 'next-themes';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';

import { TooltipProvider } from '@/components/ui/overlays';

/**
 * Anwendungsweite Provider.
 *
 * Architekturentscheid: Der QueryClient wird in `useState` erzeugt, nicht als
 * Modul-Singleton. Auf dem Server würde ein Singleton den Cache zwischen
 * Requests verschiedener Nutzer teilen — ein Datenleck. Pro Client-Instanz
 * einer zu haben ist der einzige sichere Weg.
 *
 * `staleTime` von 30 Sekunden verhindert, dass jeder Tab-Wechsel eine
 * Nachladewelle auslöst; kritische Mutationen invalidieren gezielt.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error) => {
              // 4xx nicht wiederholen — das Ergebnis ändert sich nicht.
              const status = (error as { status?: number })?.status;
              if (status && status >= 400 && status < 500) return false;
              return failureCount < 2;
            },
          },
          mutations: { retry: 0 },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
        storageKey="clenaris-theme"
      >
        <TooltipProvider delayDuration={250} skipDelayDuration={400}>
          {children}
          <Toaster
            position="bottom-right"
            closeButton
            richColors
            expand={false}
            duration={5000}
            toastOptions={{
              classNames: {
                toast:
                  'rounded-xl border border-border bg-card text-card-foreground shadow-elevated',
                title: 'font-medium text-sm',
                description: 'text-sm text-muted-foreground',
              },
            }}
          />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
