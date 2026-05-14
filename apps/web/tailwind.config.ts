import type { Config } from 'tailwindcss';

/**
 * Trade Way / Captain Masr CRM — Tailwind theme.
 *
 * Tokens follow PRD Master v2.0 Part C "UI Style Direction":
 *   - Trade Way green primary palette.
 *   - Status semantics: green/amber/red/gray/blue.
 */
const config: Config = {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '1rem',
      screens: {
        sm: '640px',
        md: '768px',
        lg: '1024px',
        xl: '1280px',
        '2xl': '1440px',
      },
    },
    extend: {
      colors: {
        // Trade Way brand green.
        brand: {
          DEFAULT: '#0E7C5A',
          hover: '#0B6849',
          50: '#E7F6EF',
          100: '#C6E9D7',
          200: '#9CD8BB',
          300: '#6FC59C',
          400: '#42B27D',
          500: '#14A878', // accent / active states per PRD Part C
          600: '#0E7C5A', // primary
          700: '#0B6849', // primary hover
          800: '#085438',
          900: '#063A2A',
          950: '#03241A',
        },
        // Status semantics (PRD Part C §C.2).
        status: {
          healthy: '#14A878', // green   — healthy / active / online
          warning: '#D97706', // amber   — warning / follow-up due / at-risk / idle
          breach: '#DC2626', // red     — breach / failed / offline-with-chats / opted-out
          inactive: '#9CA3AF', // gray    — inactive / closed / archived / paused / on-break
          info: '#2563EB', // blue    — informational / assigned / linked
        },
        // Neutral surface palette (corporate SaaS aesthetic).
        surface: {
          DEFAULT: '#F7F8F8',
          card: '#FFFFFF',
          border: '#E5E7EB',
        },
        ink: {
          primary: '#1F2A37',
          secondary: '#6B7280',
          tertiary: '#9CA3AF',
        },
        // Sprint 0 — dark sidebar palette per approved visual direction.
        // Used by the admin shell side-nav; kept as a named scale so future
        // dark surfaces (settings panels, mobile drawer) can reuse it.
        sidebar: {
          bg: '#0F172A',
          hover: '#1E293B',
          border: '#1E293B',
          text: '#CBD5E1', // slate-300 — default link text on dark
          textMuted: '#94A3B8', // slate-400 — section headers / disabled
          textActive: '#FFFFFF', // active route + section header on hover
        },
        // Sprint 1 — Captain Masr lifecycle journey palette. One pair
        // per canonical step: `*Fg` for the foreground (dot, text,
        // ring) and `*Bg` for the soft fill. Mirrors the approved
        // visual direction so the Journey Bar, future stage chips,
        // and dashboard counters all read from the same source of
        // truth.
        lifecycle: {
          freshLeadFg: '#3B82F6',
          freshLeadBg: '#DBEAFE',
          signupFg: '#F59E0B',
          signupBg: '#FEF3C7',
          activeFg: '#10B981',
          activeBg: '#D1FAE5',
          dftFg: '#8B5CF6',
          dftBg: '#EDE9FE',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          '"IBM Plex Sans Arabic"',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
      },
      fontSize: {
        // Tightened sizes that match PRD Part C scale (14px body, 16 section, 20 title, 13 meta).
        xs: ['0.8125rem', { lineHeight: '1.125rem' }], // 13px
        sm: ['0.875rem', { lineHeight: '1.25rem' }], // 14px
        base: ['1rem', { lineHeight: '1.5rem' }], // 16px
        lg: ['1.125rem', { lineHeight: '1.625rem' }], // 18px
        xl: ['1.25rem', { lineHeight: '1.75rem' }], // 20px
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(0 0 0 / 0.04), 0 1px 3px 0 rgb(0 0 0 / 0.06)',
      },
    },
  },
  plugins: [],
};

export default config;
