# layrton.dev

Personal page, served as static files from Cloudflare's edge (Workers static assets, free plan).
No framework, no client JavaScript, no web fonts: the page is a single ~1.5 KB (compressed) request
that fits in the first TCP round trip.

## Layout

```
src/site.mjs         all content
src/styles.css       inlined into every page; its SHA-256 goes into the CSP
src/static/          copied as-is: icons, Open Graph image, robots.txt, llms.txt
scripts/build.mjs    renders dist/: pages, 404, sitemap, manifest, security.txt, _headers, _redirects
scripts/assets.mjs   regenerates icons + OG image with headless Chrome (outputs are committed)
test/                checks on dist/: SEO tags, CSP hash, links, redirects, image sizes, size budget
wrangler.jsonc       Cloudflare config (serves dist/ on layrton.dev)
```

## Commands

```sh
npm install
npm run dev          # build + local Cloudflare runtime on http://localhost:8787
npm run check        # build + tests + HTML validation
npm run lighthouse   # Lighthouse CI (best of 3): perf ≥ 95, 100 elsewhere, 0 scripts, 0 fonts, < 10 KB
npm run assets       # after changing the name/role or the logo: re-render PNGs/ICO
npm run deploy       # check + wrangler deploy (CI does this on push to main)
```

## What's covered

- **Performance**: one request per page, inline critical CSS, no JS/fonts, Brotli, HTTP/3, 0-RTT, edge-served.
- **Accessibility**: WCAG AA contrast in light and dark, document `lang`, visible focus, landmarks,
  list semantics kept under `list-style: none`.
- **SEO**: canonical URL, sitemap with `lastmod`, `ProfilePage` structured data, noindex 404, old
  `/en` and `/pt` URLs 301 to `/`.
- **Social previews**: Open Graph + Twitter card with a 1200×630 image.
- **Security**: strict CSP (hash-based, no `unsafe-inline`), HSTS, nosniff, frame denial, COOP,
  Permissions-Policy, `/.well-known/security.txt` (RFC 9116).
- **Platform**: web app manifest, SVG favicon with dark-mode variant, ICO + Apple touch icon, `llms.txt`.

## Domains (Cloudflare zone config, not in this repo)

- `layrton.dev` is the only hostname attached to the Worker.
- `www.layrton.dev`, `layrton.com.br`, `www.layrton.com.br` → 301 to `https://layrton.dev` (path and
  query kept) via Redirect Rules, on proxied `AAAA 100::` placeholder records.
- Both zones: Always Use HTTPS, TLS ≥ 1.2, TLS 1.3, HTTP/3, 0-RTT, DNSSEC, DMARC, CAA.

## CI

`.github/workflows/ci.yml` runs `check` + Lighthouse on every push/PR and deploys `main`. It also
redeploys monthly so `security.txt` never expires. Required repository secrets:
`CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers") and `CLOUDFLARE_ACCOUNT_ID`.
