import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
await mkdir('.cache', { recursive: true });
await build({ entryPoints: ['tests/demo.js', 'tests/demo-player.js', 'tests/source-demo.js'], bundle: true, format: 'esm', outdir: '.cache', target: 'chrome120' });
async function getKey() {
  if (process.env.CARTESIA_API_KEY) return process.env.CARTESIA_API_KEY;
  try { return (await readFile('.env', 'utf8')).match(/^CARTESIA_API_KEY\s*=\s*["']?([^\r\n"']+)/m)?.[1]?.trim() || ''; }
  catch { return ''; }
}
const base = resolve('.');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wav': 'audio/wav', '.png': 'image/png' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'POST' && url.pathname === '/test/ocr') {
      if (req.headers.origin !== 'http://127.0.0.1:4317') { res.writeHead(403); res.end(); return; }
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 12 * 1024 * 1024) throw new Error('Oversized image'); }
      const child = spawn(resolve('macos/.build/release/ArticleVoiceOCR'), [], { stdio: ['pipe', 'pipe', 'ignore'] });
      const timer = setTimeout(() => child.kill(), 30_000);
      res.on('close', () => { if (child.exitCode == null) child.kill(); });
      child.on('error', () => { clearTimeout(timer); res.writeHead(503); res.end('Build ArticleVoiceOCR before this check.'); });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      child.stdout.pipe(res); child.on('close', () => clearTimeout(timer)); child.stdin.end(raw); return;
    }
    if (req.method === 'GET' && url.pathname === '/test/config') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ liveAvailable: !!await getKey(), voiceId: process.env.CARTESIA_VOICE_ID || 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4' })); return;
    }
    if (req.method === 'POST' && url.pathname === '/test/live-speech') {
      // Test-only loopback proxy; never return or log the key. A browser click
      // starts a public fixture narration. Not bundled into the extension.
      const key = await getKey();
      if (req.headers.origin !== 'http://127.0.0.1:4317' || !key) { res.writeHead(403); res.end(); return; }
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 50_000) throw new Error('Oversized request'); }
      const body = JSON.parse(raw);
      const upstream = await fetch('https://api.cartesia.ai/tts/sse', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Cartesia-Version': '2026-08-14', 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(60_000)
      });
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'text/event-stream' });
      if (upstream.ok) { for await (const chunk of upstream.body) res.write(chunk); } else res.write('Cartesia request rejected.');
      res.end(); return;
    }
    if (req.method === 'GET' && url.pathname === '/test/live-voices') {
      const key = await getKey();
      if (req.headers['sec-fetch-site'] !== 'same-origin' || !key) { res.writeHead(403); res.end(); return; }
      const upstreamUrl = new URL('https://api.cartesia.ai/voices');
      for (const name of ['limit', 'starting_after', 'q', 'gender', 'language'])
        if (url.searchParams.has(name)) upstreamUrl.searchParams.set(name, url.searchParams.get(name));
      const upstream = await fetch(upstreamUrl, { headers: { Authorization: `Bearer ${key}`, 'Cartesia-Version': '2026-08-14' }, signal: AbortSignal.timeout(30_000) });
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      res.end(upstream.ok ? await upstream.text() : JSON.stringify({ error: 'Cartesia voice lookup rejected.' })); return;
    }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    let pathname = url.pathname;
    if (pathname === '/') pathname = '/tests/article.html';
    if (pathname === '/player.html') {
      const html = (await readFile('public/player.html', 'utf8')).replace('href="player.css"', 'href="/public/player.css"').replace('src="player.js"', 'src="/.cache/demo-player.js"');
      res.setHeader('Content-Type', 'text/html'); res.end(html); return;
    }
    const file = resolve(base, `.${decodeURIComponent(pathname)}`);
    // Serve only development artifacts, never env files or arbitrary siblings.
    if (!['tests', 'public', '.cache'].some(dir => file.startsWith(resolve(base, dir) + sep)) || /\/\./.test(pathname.slice(1))) {
      res.writeHead(404); res.end(); return;
    }
    res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.writeHead(500); res.end('Development server error'); }
});
server.listen(4317, '127.0.0.1', () => console.log('Browser test: http://127.0.0.1:4317 · live Cartesia reads its key from .env'));
