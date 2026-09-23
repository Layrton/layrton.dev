// Builds the site into dist/. No dependencies: Node's standard library only.
//
//   src/site.mjs     content
//   src/styles.css   inlined into every page (hashed into the CSP)
//   src/static/      copied as-is (icons, OG image, robots.txt, …)

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { site } from '../src/site.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const abs = (path) => new URL(path, site.origin).href;

// Whitespace/comment removal is enough for this stylesheet: no strings contain these characters.
const minifyCss = (css) =>
  css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}:;,])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();

// Templates below put one tag per line, so dropping line breaks between tags never
// touches inline text spacing.
const minifyHtml = (html) => html.replace(/>\s*\n\s*</g, '><').trim() + '\n';

const cspHash = (content) => `'sha256-${createHash('sha256').update(content).digest('base64')}'`;

// Date the content last changed, for sitemap <lastmod>.
function lastModified() {
  try {
    const date = execFileSync('git', ['log', '-1', '--format=%cs', '--', 'src'], { cwd: ROOT, encoding: 'utf8' }).trim();
    if (date) return date;
  } catch {}
  return new Date().toISOString().slice(0, 10);
}

function head({ title, description, css, extra }) {
  return `<!DOCTYPE html>
<html lang="${site.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="author" content="${esc(site.name)}">
${extra}
<meta name="color-scheme" content="light dark">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="${site.themeColor.light}">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${site.themeColor.dark}">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<style>${css}</style>`;
}

function homePage(css) {
  const url = abs('/');
  const [firstName, ...lastName] = site.name.split(' ');
  const meta = [
    `<link rel="canonical" href="${url}">`,
    `<meta property="og:type" content="profile">`,
    `<meta property="og:site_name" content="${esc(site.name)}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:title" content="${esc(site.title)}">`,
    `<meta property="og:description" content="${esc(site.description)}">`,
    `<meta property="og:locale" content="${site.ogLocale}">`,
    `<meta property="og:image" content="${abs('/og.png')}">`,
    `<meta property="og:image:type" content="image/png">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="${esc(site.ogImageAlt)}">`,
    `<meta property="profile:first_name" content="${esc(firstName)}">`,
    `<meta property="profile:last_name" content="${esc(lastName.join(' '))}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
  ];
  // https://developers.google.com/search/docs/appearance/structured-data/profile-page
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    url,
    name: site.title,
    inLanguage: site.lang,
    mainEntity: {
      '@type': 'Person',
      '@id': `${url}#person`,
      name: site.name,
      jobTitle: site.role,
      url,
      email: `mailto:${site.email}`,
      sameAs: [site.github],
    },
  }).replace(/</g, '\\u003c');

  return minifyHtml(`${head({ title: site.title, description: site.description, css, extra: meta.join('\n') })}
<script type="application/ld+json">${jsonLd}</script>
</head>
<body>
<main>
<h1>${esc(site.name)}</h1>
<p class="role">${esc(site.role)}</p>
<p class="bio">${esc(site.bio)}</p>
<h2>Contact</h2>
<ul role="list">
<li>E-mail: <a href="mailto:${site.email}">${esc(site.email)}</a></li>
<li>GitHub: <a href="${site.github}" rel="me">${esc(new URL(site.github).host + new URL(site.github).pathname)}</a></li>
</ul>
</main>
</body>
</html>`);
}

function notFoundPage(css) {
  return minifyHtml(`${head({ title: `Page not found — ${site.name}`, description: 'Page not found.', css, extra: '<meta name="robots" content="noindex">' })}
</head>
<body>
<main>
<h1>404</h1>
<p class="role">Page not found.</p>
<p class="bio"><a href="/">Go to the home page</a></p>
</main>
</body>
</html>`);
}

const sitemap = (lastmod) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${abs('/')}</loc><lastmod>${lastmod}</lastmod></url>
</urlset>
`;

const manifest = () =>
  JSON.stringify(
    {
      name: site.name,
      short_name: site.name.split(' ')[0],
      description: site.description,
      lang: site.lang,
      start_url: '/',
      scope: '/',
      display: 'browser',
      background_color: site.themeColor.dark,
      theme_color: site.themeColor.dark,
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    null,
    2,
  ) + '\n';

// RFC 9116. Expires is refreshed on every build; CI redeploys monthly so it never lapses.
function securityTxt(now) {
  const expires = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);
  expires.setUTCHours(0, 0, 0, 0);
  return `Contact: mailto:${site.email}
Expires: ${expires.toISOString()}
Preferred-Languages: ${site.lang}
Canonical: ${abs('/.well-known/security.txt')}
`;
}

// Cloudflare Workers static assets header rules.
// https://developers.cloudflare.com/workers/static-assets/headers/
function headers(styleHash) {
  const csp = [
    "default-src 'none'",
    `style-src ${styleHash}`,
    "img-src 'self'",
    "manifest-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  const longCache = 'public, max-age=86400, stale-while-revalidate=604800';
  return `/*
  Content-Security-Policy: ${csp}
  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Cross-Origin-Opener-Policy: same-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()

/icon.svg
  ! Content-Security-Policy
  Cache-Control: ${longCache}

/favicon.ico
  Cache-Control: ${longCache}

/apple-touch-icon.png
  Cache-Control: ${longCache}

/icon-*
  Cache-Control: ${longCache}

/og.png
  Cache-Control: ${longCache}
`;
}

// Old URLs from earlier versions of the site (English used to live at /en, Portuguese at /pt).
const redirects = `/en  /  301
/en/  /  301
/pt  /  301
/pt/  /  301
`;

const now = new Date();
const css = minifyCss(await readFile(join(ROOT, 'src/styles.css'), 'utf8'));
const styleHash = cspHash(css);

await rm(DIST, { recursive: true, force: true });
await mkdir(join(DIST, '.well-known'), { recursive: true });
await cp(join(ROOT, 'src/static'), DIST, { recursive: true });

const files = {
  'index.html': homePage(css),
  '404.html': notFoundPage(css),
  'sitemap.xml': sitemap(lastModified()),
  'manifest.webmanifest': manifest(),
  '.well-known/security.txt': securityTxt(now),
  _headers: headers(styleHash),
  _redirects: redirects,
};

for (const [name, content] of Object.entries(files)) await writeFile(join(DIST, name), content);

for (const name of Object.keys(files).sort()) {
  const bytes = Buffer.byteLength(files[name]);
  console.log(`${name.padEnd(28)} ${String(bytes).padStart(6)} B`);
}
console.log(`style-src ${styleHash}`);
