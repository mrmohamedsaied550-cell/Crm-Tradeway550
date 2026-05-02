import type { MetadataRoute } from 'next';

/**
 * P3-01 — installable PWA manifest.
 *
 * `display: 'standalone'` makes the installed app open without
 * browser chrome on Android / desktop Chrome / iOS (when added to
 * home screen). `start_url: '/agent/workspace'` lands the agent on
 * their working surface immediately on launch — admins still see
 * everything when they navigate, but the icon defaults to the
 * field-sales view.
 *
 * Icons are SVG so they look crisp at any density; iOS Safari uses
 * `/apple-touch-icon.svg` (declared on the layout's `Metadata.icons`)
 * for the home-screen badge, while Android reads from this manifest.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Trade Way / Captain Masr CRM',
    short_name: 'TW CRM',
    description: 'Captain acquisition + activation CRM',
    start_url: '/agent/workspace',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff',
    theme_color: '#1f3864',
    lang: 'en',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/icon-maskable.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'maskable',
      },
    ],
  };
}
