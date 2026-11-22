import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type HtmlTagDescriptor, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Files in public/ the app needs offline, next to the hashed bundle. */
const PUBLIC_SHELL = [
  'manifest.webmanifest',
  'favicon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'worklets/meter-processor.js',
];

/**
 * Writes precache.json (every file of this build, so the service worker can
 * store the whole app on its first install and Musiccus opens offline) and
 * sw.js, stamped with a version derived from the build's contents. A new
 * version changes sw.js, which is how browsers learn that an update exists.
 */
function serviceWorker(): Plugin {
  return {
    name: 'musiccus-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      // Fontsource ships .woff next to .woff2 for old browsers; every browser
      // that can run Musiccus uses the .woff2, so the .woff stay out of the cache.
      const built = Object.keys(bundle)
        .filter((f) => !f.endsWith('.map') && !f.endsWith('.woff'))
        .sort();
      const version = createHash('sha256');
      for (const f of built) {
        const item = bundle[f];
        version.update(f).update(item.type === 'chunk' ? item.code : item.source);
      }
      for (const f of PUBLIC_SHELL) version.update(f).update(readFileSync(here(`./public/${f}`)));
      const stamp = version.digest('hex').slice(0, 12);
      this.emitFile({ type: 'asset', fileName: 'precache.json', source: JSON.stringify(['./', ...PUBLIC_SHELL, ...built]) });
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: readFileSync(here('./src/pwa/sw.js'), 'utf8').replaceAll('__BUILD__', stamp),
      });
    },
  };
}

/**
 * The site's public address, used for the link-preview image. Netlify and
 * Vercel provide it during their builds; elsewhere set SITE_URL, for example
 * SITE_URL=https://username.github.io/musiccus/ for GitHub Pages.
 */
function siteUrl(): string {
  const env = process.env;
  const url =
    env.SITE_URL ||
    (env.NETLIFY === 'true' ? env.URL : '') ||
    (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '') ||
    env.CF_PAGES_URL ||
    '';
  return url ? url.replace(/\/?$/, '/') : '';
}

/**
 * Link previews (WhatsApp, X, Facebook, Slack) need an absolute image URL.
 * Without a known address the image is still linked relatively, which some
 * apps resolve.
 */
function linkPreview(): Plugin {
  return {
    name: 'musiccus-link-preview',
    transformIndexHtml() {
      const site = siteUrl();
      const meta = (property: string, content: string, key = 'property'): HtmlTagDescriptor => ({
        tag: 'meta',
        attrs: { [key]: property, content },
        injectTo: 'head',
      });
      const tags = [
        meta('og:image', `${site || './'}og-image.jpg`),
        meta('og:image:type', 'image/jpeg'),
        meta('og:image:width', '1200'),
        meta('og:image:height', '630'),
        meta('og:image:alt', 'Musiccus: Dengar lebih dalam.'),
        meta('twitter:image', `${site || './'}og-image.jpg`, 'name'),
      ];
      if (site) {
        tags.push(meta('og:url', site));
        tags.push({ tag: 'link', attrs: { rel: 'canonical', href: site }, injectTo: 'head' });
      }
      return tags;
    },
  };
}

// Musiccus is a static site: no server code, no database, no special headers.
// A relative base lets the same build run at a domain root or in a subfolder
// (for example GitHub Pages).
export default defineConfig({
  base: './',
  plugins: [react(), serviceWorker(), linkPreview()],
  resolve: {
    alias: {
      // The build of ONNX Runtime that loads its glue and 28.7 MB wasm from a
      // URL prefix instead of bundling them, so no file in dist/ exceeds the
      // 25 MiB per-file limit some static hosts enforce.
      'onnxruntime-web/webgpu': here('./node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs'),
    },
  },
  server: { port: 5173 },
  preview: { port: 4173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
  // Pre-bundle the stem separator's runtime up front, so the first separation
  // does not trigger a dependency re-optimisation and page reload in dev.
  optimizeDeps: { include: ['onnxruntime-web/webgpu'] },
});
