import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import withSerwistInit from '@serwist/next';

const withNextIntl = createNextIntlPlugin('./src/modules/platform/i18n/request.ts');

const withSerwist = withSerwistInit({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  disable: process.env.NODE_ENV === 'development',
});

// Native/node-only packages that must never enter a webpack bundle.
// `serverExternalPackages` covers most cases, but the dev-mode
// instrumentation compile ignores it, so they are ALSO added as explicit
// webpack externals for server bundles below.
const NODE_ONLY_PACKAGES = [
  'pg-boss',
  'sharp',
  'pino',
  '@node-rs/argon2',
  'postgres',
  'pg',
  'pg-native',
  'grammy',
  // MTProto client for the CRM chat import — a large node-only package that
  // must never be reachable from a browser bundle.
  'telegram',
  // Loads a wasm binary (harfbuzz) — webpack must not try to parse it.
  'subset-font',
  'harfbuzzjs',
];

const nextConfig: NextConfig = {
  output: 'standalone',
  // Shown on /profile so "is the server on the new build?" is answerable at
  // a glance (inlined at build time).
  env: { NEXT_PUBLIC_BUILD_AT: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC' },
  // Pin the tracing root to THIS project. Without it, a stray lockfile in a
  // parent folder (seen on the owner's Windows PC: C:\Users\USER\package-lock.json)
  // makes Next treat the parent as the workspace root and emit the standalone
  // build into .next/standalone/<project>/ where start-standalone.mjs can't find it.
  outputFileTracingRoot: __dirname,
  serverExternalPackages: NODE_ONLY_PACKAGES,
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : [config.externals]),
        ...NODE_ONLY_PACKAGES.map((pkg) => ({ [pkg]: `commonjs ${pkg}` })),
      ];
    }
    return config;
  },
  images: {
    // All images come from our own storage via signed URLs; no external hosts.
    remotePatterns: [],
  },
};

export default withSerwist(withNextIntl(nextConfig));
