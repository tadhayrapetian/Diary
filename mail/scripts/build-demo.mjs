// Builds the whole client plus the demo mailbox into one self-contained HTML file
// that opens in any browser, phone included, with no server:
//   npm run build:demo            → dist/aether-demo.html
//   npm run build:demo -- out.html
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || join(root, 'dist', 'aether-demo.html');
const read = (f) => readFileSync(join(root, f), 'utf8');

const bundle = await build({
  entryPoints: [join(root, 'demo/main.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  write: false,
  alias: { 'node:events': join(root, 'demo/shim-events.js') },
  inject: [join(root, 'demo/shim-buffer.js')],
});
const js = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = `${read('public/styles.css')}\n${read('public/classic.css')}`.replace(/<\/style/gi, '<\\/style');

const html = `<title>Aether Mail</title>
<meta name="theme-color" content="#f4f3f0">
<style>${css}</style>
<script>${read('public/boot.js')}</script>
<div class="app" id="app">
  <header class="classic-bar" id="classic-bar"></header>
  <aside class="sidebar" id="sidebar"></aside>
  <section class="pane list-pane" id="list-pane"></section>
  <section class="pane reader-pane" id="reader-pane"></section>
  <footer class="classic-status" id="classic-status"></footer>
</div>
<div class="toasts" id="toasts" role="status" aria-live="polite"></div>
<script type="module">${js}</script>
`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`wrote ${out} (${Math.round(html.length / 1024)} KB)`);
