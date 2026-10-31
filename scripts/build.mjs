import { build } from 'esbuild';
import { mkdir, cp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
await mkdir('dist', { recursive: true });
await cp('public', 'dist', { recursive: true });
await build({ entryPoints: ['src/content.js', 'src/background.js'], bundle: true, format: 'iife', outdir: 'dist', target: 'chrome120' });
await build({ entryPoints: ['src/player.js'], bundle: true, format: 'esm', outdir: 'dist', target: 'chrome120' });
await writeFile('dist/manifest.json', JSON.stringify({
  manifest_version: 3, name: 'Article Voice · AI Reader', version: '0.2.3', minimum_chrome_version: '120',
  description: 'Listen with Cartesia or local Qwen3-TTS voices, word highlighting, auto-scroll and pitch-preserving playback up to 3×.',
  permissions: ['activeTab', 'scripting', 'storage'], host_permissions: ['https://api.cartesia.ai/*', 'http://127.0.0.1/*'],
  action: { default_title: 'Read this article with Article Voice' },
  icons: { 16: 'icon16.png', 48: 'icon48.png', 128: 'icon128.png' },
  background: { service_worker: 'background.js' },
  web_accessible_resources: [{ resources: ['player.html', 'player.js', 'player.css'], matches: ['http://*/*', 'https://*/*'] }],
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; connect-src https://api.cartesia.ai http://127.0.0.1:4318; media-src 'self' blob:; style-src 'self'; frame-ancestors http: https:" }
}, null, 2));
console.log(`Extension built at ${resolve('dist')}`);
