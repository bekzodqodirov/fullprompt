import type { Config } from 'tailwindcss';

/**
 * Design tokens (2026-07 redesign).
 *
 * Colours are CSS variables written as raw channels so Tailwind's opacity
 * modifiers keep working (`bg-brand/10`), and so the whole palette can be
 * re-themed — or dark-moded — from one place instead of across 67 screens.
 */
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: token('brand-600'),
          50: token('brand-50'),
          100: token('brand-100'),
          200: token('brand-200'),
          500: token('brand-500'),
          600: token('brand-600'),
          700: token('brand-700'),
          800: token('brand-800'),
        },
        ink: {
          DEFAULT: token('ink-900'),
          900: token('ink-900'),
          700: token('ink-700'),
          500: token('ink-500'),
          400: token('ink-400'),
        },
        surface: {
          DEFAULT: token('surface'),
          raised: token('surface-raised'),
          sunken: token('surface-sunken'),
        },
        line: {
          DEFAULT: token('line'),
          strong: token('line-strong'),
        },
      },
      borderRadius: {
        lg: '0.625rem',
        xl: '0.875rem',
        '2xl': '1.125rem',
      },
      boxShadow: {
        // Two levels only: a resting card, and something genuinely floating.
        card: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
        pop: '0 10px 30px -10px rgb(15 23 42 / 0.25), 0 2px 8px -2px rgb(15 23 42 / 0.10)',
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
    },
  },
  plugins: [],
} satisfies Config;
