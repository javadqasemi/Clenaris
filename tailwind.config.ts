import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

const config: Config = {
  darkMode: ['class'],
  content: ['./src/**/*.{ts,tsx,mdx}'],
  theme: {
    container: {
      center: true,
      padding: { DEFAULT: '1.25rem', sm: '1.5rem', lg: '2rem', '2xl': '2.5rem' },
      screens: { '2xl': '1360px' },
    },
    extend: {
      /**
       * Umbruchpunkte oberhalb von `2xl`.
       *
       * Tailwind hört bei 1536 px auf. Das war lange genug: der Behälter
       * deckelt bei 1360 px, und auf einem 1920er-Bildschirm sieht das
       * richtig aus. Auf einem 49-Zoll-Bildschirm (5120 × 1440) steht
       * derselbe 1360-px-Streifen in der Mitte und lässt links und rechts je
       * 1880 px Leerfläche — die Seite wirkt dort nicht ruhig, sondern
       * verloren, und der Text ist auf die Distanz, aus der man einen solchen
       * Bildschirm betrachtet, schlicht zu klein.
       *
       * Die Werte sind an tatsächlicher Hardware ausgerichtet, nicht an einer
       * runden Zahlenreihe:
       *
       *  • `3xl` 2000 px — beginnt *oberhalb* von 1920. Das ist Absicht: der
       *    mit Abstand häufigste Desktop-Bildschirm soll exakt so bleiben,
       *    wie er heute aussieht. Ein 4K-Bildschirm mit 200 % Skalierung
       *    meldet ebenfalls 1920 CSS-Pixel und bleibt damit ebenfalls
       *    unberührt — dort ist die Schrift physisch schon gross genug.
       *  • `4xl` 2560 px — WQHD, 34-Zoll-Ultrawide, 4K bei 150 %.
       *  • `5xl` 3200 px — 4K bei 125 %.
       *  • `6xl` 3840 px — 4K nativ; hier liegt auch der 49-Zöller mit 5120 px.
       *
       * Die Stufen werden an zwei Orten wirksam: hier als Varianten für
       * zusätzliche Rasterspalten, und in `globals.css` als Wachstum des
       * Behälters und der Grundschriftgrösse. Beide Ladders benutzen
       * dieselben Schwellen — zwei Systeme mit verschobenen Schwellen ergäben
       * Sprünge, bei denen die Schrift wächst, die Spalte aber nicht.
       */
      screens: {
        '3xl': '2000px',
        '4xl': '2560px',
        '5xl': '3200px',
        '6xl': '3840px',
      },
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
          50: 'hsl(var(--primary-50))',
          100: 'hsl(var(--primary-100))',
          200: 'hsl(var(--primary-200))',
          300: 'hsl(var(--primary-300))',
          400: 'hsl(var(--primary-400))',
          500: 'hsl(var(--primary-500))',
          600: 'hsl(var(--primary-600))',
          700: 'hsl(var(--primary-700))',
          800: 'hsl(var(--primary-800))',
          900: 'hsl(var(--primary-900))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
        },
        info: {
          DEFAULT: 'hsl(var(--info))',
          foreground: 'hsl(var(--info-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        surface: {
          DEFAULT: 'hsl(var(--surface))',
          foreground: 'hsl(var(--surface-foreground))',
        },
      },
      borderRadius: {
        '4xl': '2rem',
        '3xl': '1.5rem',
        '2xl': 'calc(var(--radius) + 6px)',
        xl: 'calc(var(--radius) + 4px)',
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'var(--font-sans)', 'ui-sans-serif', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      /**
       * Typografische Skala.
       *
       * Zwischen Tailwinds `xs` (12 px) und `base` (16 px) fehlen zwei Stufen,
       * die dieses Produkt ständig braucht: 13 px für dichten Bedienungstext
       * (Formularhinweise, kleine Schaltflächen, Fehlermeldungen) und 15 px
       * für Fliesstext-Absätze, denen 14 px zu eng und 16 px zu gross ist.
       *
       * Sie stehen hier als benannte Stufen, weil sie sonst als
       * `text-[0.8125rem]` durch den Code wandern — dann ist die Skala keine
       * Vereinbarung mehr, sondern eine Sammlung von Einzelfällen.
       *
       * **Die Untergrenzen der drei Display-Grade sind gesenkt worden, die
       * Steigung nicht.** Der mittlere Term (`6vw`, `4vw`, `2.2vw`) bleibt
       * unverändert, weil er die ganze Tablet- und Desktop-Strecke bestimmt —
       * dort war nie etwas falsch. Falsch war nur der Boden: `2.5rem` heisst
       * 40 px Überschrift auf einem 320-px-Telefon, und deutsche
       * Zusammensetzungen wie „Umzugsreinigung" passen dort nicht mehr in
       * eine Zeile. Da `clamp` unterhalb des Knickpunkts ohnehin flach ist,
       * wirkt die Senkung ausschliesslich auf kleinen Geräten: `display` ist
       * ab 567 px, `headline` ab 700 px, `title` ab 909 px wieder
       * bitgleich mit vorher.
       *
       * Nach oben braucht es keine weitere Stufe. Die Obergrenzen stehen in
       * `rem`, und die Grundschriftgrösse wächst auf sehr breiten
       * Bildschirmen mit (siehe `globals.css`) — 4.75 rem sind dort von
       * selbst 104 px statt 76 px.
       */
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.01em' }],
        meta: ['0.8125rem', { lineHeight: '1.15rem' }],
        body: ['0.9375rem', { lineHeight: '1.6' }],
        display: ['clamp(2.125rem, 6vw, 4.75rem)', { lineHeight: '1.02', letterSpacing: '-0.035em' }],
        headline: ['clamp(1.75rem, 4vw, 3rem)', { lineHeight: '1.08', letterSpacing: '-0.028em' }],
        title: ['clamp(1.25rem, 2.2vw, 1.875rem)', { lineHeight: '1.2', letterSpacing: '-0.02em' }],
      },
      boxShadow: {
        soft: '0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.06)',
        card: '0 2px 4px -1px rgba(16,24,40,0.04), 0 8px 24px -6px rgba(16,24,40,0.10)',
        elevated:
          '0 4px 8px -2px rgba(16,24,40,0.06), 0 18px 48px -12px rgba(16,24,40,0.16)',
        glow: '0 0 0 1px hsl(var(--primary) / 0.16), 0 8px 32px -8px hsl(var(--primary) / 0.42)',
        inset: 'inset 0 1px 0 0 rgba(255,255,255,0.08)',
      },
      backgroundImage: {
        'grid-light':
          'linear-gradient(to right, rgba(16,24,40,0.045) 1px, transparent 1px), linear-gradient(to bottom, rgba(16,24,40,0.045) 1px, transparent 1px)',
        'grid-dark':
          'linear-gradient(to right, rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.05) 1px, transparent 1px)',
        'radial-fade':
          'radial-gradient(60% 60% at 50% 0%, hsl(var(--primary) / 0.18) 0%, transparent 70%)',
        shine:
          'linear-gradient(110deg, transparent 25%, rgba(255,255,255,0.55) 50%, transparent 75%)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        marquee: {
          from: { transform: 'translateX(0)' },
          to: { transform: 'translateX(-50%)' },
        },
        'pulse-ring': {
          '0%': { transform: 'scale(0.9)', opacity: '0.7' },
          '70%': { transform: 'scale(1.35)', opacity: '0' },
          '100%': { transform: 'scale(1.35)', opacity: '0' },
        },
        /**
         * Der Navigationsbalken.
         *
         * Ein *unbestimmter* Lauf und keine Prozentanzeige: Wie lange eine
         * Seite braucht, weiss niemand — eine Zahl, die bei 80 % stehen
         * bleibt, ist eine Behauptung. Der Balken wandert von links nach
         * rechts durch und sagt damit nur, was er weiss: es passiert etwas.
         */
        'nav-progress': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(400%)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.22s cubic-bezier(0.32,0.72,0,1)',
        'accordion-up': 'accordion-up 0.22s cubic-bezier(0.32,0.72,0,1)',
        'fade-up': 'fade-up 0.5s cubic-bezier(0.16,1,0.3,1) both',
        shimmer: 'shimmer 2s infinite',
        marquee: 'marquee 38s linear infinite',
        'pulse-ring': 'pulse-ring 2.4s cubic-bezier(0.24,0,0.38,1) infinite',
        'nav-progress': 'nav-progress 1.1s cubic-bezier(0.4,0,0.2,1) infinite',
      },
      transitionTimingFunction: {
        spring: 'cubic-bezier(0.16, 1, 0.3, 1)',
        'apple-out': 'cubic-bezier(0.32, 0.72, 0, 1)',
      },
    },
  },
  plugins: [animate],
};

export default config;
