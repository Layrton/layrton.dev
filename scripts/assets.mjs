// Renders raster assets (PNG icons, favicon.ico, Open Graph images) into src/static/
// using headless Chrome over the DevTools protocol. Outputs are committed, so this only
// needs to run when the design or the text on the social cards changes:
//
//   npm run assets            (set CHROME=/path/to/chrome if it isn't auto-detected)

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { site } from '../src/site.mjs';

const STATIC = new URL('../src/static/', import.meta.url).pathname;

const CHROME_CANDIDATES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

// Square, full-bleed mark for PNG icons: iOS and Android apply their own corner masks.
// The glyph stays inside the maskable-icon safe zone (central 80% circle).
const squareMark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="${site.themeColor.dark}"/><path d="M11 8v16h11" fill="none" stroke="${site.themeColor.light}" stroke-width="3.5"/></svg>`;

// Inverted mark for the dark social card, so the tile stands out from the background.
const invertedMark = squareMark.replace(`fill="${site.themeColor.dark}"`, 'fill="#fafafa"').replace(`stroke="${site.themeColor.light}"`, 'stroke="#18181b"');

const iconPage = `<!DOCTYPE html><style>html,body{margin:0;width:100vw;height:100vh}svg{display:block;width:100%;height:100%}</style>${squareMark}`;

const ogPage = `<!DOCTYPE html><html lang="${site.lang}"><style>
html,body{margin:0;width:1200px;height:630px}
body{box-sizing:border-box;padding:80px 96px;display:flex;flex-direction:column;justify-content:space-between;
  background:${site.themeColor.dark};color:#e4e4e7;font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace}
.mark{width:96px;height:96px;border-radius:20px;overflow:hidden}.mark svg{display:block;width:100%;height:100%}
h1{font-size:96px;line-height:1.05;margin:0 0 20px;color:#fafafa;letter-spacing:-.02em}
p{margin:0;font-size:40px;color:#a1a1aa}
.url{font-size:32px;color:#93c5fd}
</style><div class="mark">${invertedMark}</div><div><h1>${site.name}</h1><p>${site.role}</p></div><div class="url">${new URL(site.origin).host}</div></html>`;

const jobs = [
  { out: 'icon-512.png', html: iconPage, width: 512, height: 512 },
  { out: 'icon-192.png', html: iconPage, width: 192, height: 192 },
  { out: 'apple-touch-icon.png', html: iconPage, width: 180, height: 180 },
  { out: 'favicon-32.png', html: iconPage, width: 32, height: 32, ico: 'favicon.ico' },
  { out: 'og.png', html: ogPage, width: 1200, height: 630 },
];

// Minimal DevTools protocol client over Node's built-in WebSocket.
async function launchChrome() {
  const bin = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!bin) throw new Error('Chrome not found; set CHROME=/path/to/chrome');
  const profile = await mkdtemp(join(tmpdir(), 'assets-chrome-'));
  const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--hide-scrollbars', 'about:blank'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    proc.on('exit', () => reject(new Error(`Chrome exited early:\n${buf}`)));
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  const close = async () => {
    ws.close();
    proc.kill();
    await rm(profile, { recursive: true, force: true });
  };
  return { send, close };
}

async function screenshot({ send }, { html, width, height }) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  const { frameTree } = await send('Page.getFrameTree', {}, sessionId);
  await send('Page.setDocumentContent', { frameId: frameTree.frame.id, html }, sessionId);
  await new Promise((r) => setTimeout(r, 150));
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } }, sessionId);
  await send('Target.closeTarget', { targetId });
  return Buffer.from(data, 'base64');
}

// ICO container holding a single PNG image (supported by every browser since IE Vista-era).
function pngToIco(png, size) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(size, 6);
  header.writeUInt8(size, 7);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}

const chrome = await launchChrome();
try {
  for (const job of jobs) {
    const png = await screenshot(chrome, job);
    if (job.ico) {
      await writeFile(join(STATIC, job.ico), pngToIco(png, job.width));
      console.log(`${job.ico} (${png.length + 22} B)`);
    } else {
      await writeFile(join(STATIC, job.out), png);
      console.log(`${job.out} (${png.length} B)`);
    }
  }
} finally {
  await chrome.close();
}
