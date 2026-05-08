#!/usr/bin/env node
/**
 * Extract a Claude-Design bundle (.html, ~2.5 MB self-decoding) into flat static output.
 *
 * Usage:
 *   node extract.mjs <bundle.html> <output-dir>
 *
 * Example:
 *   node extract.mjs lp/esg-autopilot.html lp/esg-autopilot
 *
 * Output (flat, GH-Pages-ready):
 *   <output-dir>/index.html       — server-side-rendered, SEO-friendly
 *   <output-dir>/app.js           — React + components (hydrates the static HTML)
 *   <output-dir>/styles.css       — design tokens, only 2 variable fonts referenced
 *   <output-dir>/fonts/           — Plus Jakarta Sans variable + italic variable (TTF)
 *   <output-dir>/assets/          — logos, client images, etc.
 *
 * Setup (once):
 *   npm install
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { build as esbuildBuild } from 'esbuild';
import { execSync } from 'node:child_process';

// -------- args --------
const [bundlePathArg, outDirArg] = process.argv.slice(2);
if (!bundlePathArg || !outDirArg) {
  console.error('Usage: node extract.mjs <bundle.html> <output-dir>');
  process.exit(2);
}
const BUNDLE = path.resolve(bundlePathArg);
const OUT = path.resolve(outDirArg);
const TMP = path.join(path.dirname(BUNDLE), '.extract-tmp');

// -------- helpers --------
const grab = (html, type) => {
  const m = html.match(new RegExp(`<script type="__bundler/${type}"[^>]*>([\\s\\S]+?)</script>`));
  if (!m) throw new Error(`bundle is missing __bundler/${type} block — is this a Claude-Design bundle?`);
  return JSON.parse(m[1]);
};

const mimeToExt = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'font/woff2': 'woff2',
  'font/ttf': 'ttf',
  'font/woff': 'woff',
  'application/javascript': 'js',
  'text/javascript': 'js',
  'text/css': 'css',
};

/**
 * Derive a relative filename from a Claude-Design ext_resources id like "clientFom" or "logoSkillbyte".
 * Convention: prefix `client*` → assets/clients/<lc>.ext, prefix `logo*` → assets/logo-<kebab>.ext,
 * everything else → assets/<kebab>.ext.
 */
function deriveFilename(id, mime) {
  const ext = mimeToExt[mime] || 'bin';
  if (id.startsWith('client') && id.length > 6) {
    // handles both CamelCase (`clientFom`) and snake_case (`client_fom`)
    const tail = id.slice(6).replace(/^_/, '').replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');
    return `assets/clients/${tail}.${ext}`;
  }
  if (id.startsWith('logo') && id.length > 4) {
    const tail = id
      .slice(4)
      .replace(/^_/, '')
      .replace(/([A-Z])/g, '-$1')
      .toLowerCase()
      .replace(/^-/, '');
    return `assets/logo-${tail}.${ext}`;
  }
  const kebab = id.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');
  return `assets/${kebab}.${ext}`;
}

// -------- 1. read & parse bundle --------
console.log(`extracting ${path.relative(process.cwd(), BUNDLE)} → ${path.relative(process.cwd(), OUT)}/`);
const html = await fs.readFile(BUNDLE, 'utf8');
const manifest = grab(html, 'manifest');
const template = grab(html, 'template');
const extResources = grab(html, 'ext_resources');

// -------- 2. wipe & recreate output --------
await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(path.join(OUT, 'assets/clients'), { recursive: true });
await fs.mkdir(path.join(OUT, 'fonts'), { recursive: true });
await fs.rm(TMP, { recursive: true, force: true });
await fs.mkdir(TMP, { recursive: true });

// -------- 3. decode every asset (gunzip if compressed) --------
const assets = {};
for (const u in manifest) {
  const e = manifest[u];
  let buf = Buffer.from(e.data, 'base64');
  if (e.compressed) buf = zlib.gunzipSync(buf);
  assets[u] = { mime: e.mime, data: buf };
}

// -------- 4. write image assets, build id → file map --------
const idToFile = {};
for (const r of extResources) {
  const file = deriveFilename(r.id, assets[r.uuid].mime);
  idToFile[r.id] = file;
  await fs.mkdir(path.dirname(path.join(OUT, file)), { recursive: true });
  await fs.writeFile(path.join(OUT, file), assets[r.uuid].data);
}
console.log(`  wrote ${extResources.length} image asset(s)`);

// -------- 5. fonts: keep only the 2 variable fonts (first 2 unique UUIDs in CSS @font-face) --------
const tplStyles = [...template.matchAll(/<style[^>]*>([\s\S]+?)<\/style>/g)].map((m) => m[1]);
const designCss = tplStyles[0] || '';
const pageCss = tplStyles[1] || '';
const fontUuids = [...new Set([...designCss.matchAll(/url\(["']?([0-9a-f-]{36})["']?\)/g)].map((m) => m[1]))];
const variableUuid = fontUuids[0];
const italicUuid = fontUuids[1];
if (variableUuid) await fs.writeFile(path.join(OUT, 'fonts/PlusJakartaSans-Variable.ttf'), assets[variableUuid].data);
if (italicUuid) await fs.writeFile(path.join(OUT, 'fonts/PlusJakartaSans-Italic-Variable.ttf'), assets[italicUuid].data);
console.log(`  wrote 2 variable fonts (dropped ${Math.max(0, fontUuids.length - 2)} static-weight files)`);

// -------- 6. trim CSS: drop Google Fonts import, drop static-weight @font-face, rewrite UUIDs --------
let css = designCss;
css = css.replace(/@import url\(['"][^'"]+['"]\);?/g, '');
const fontFaceBlocks = css.match(/@font-face\s*\{[^}]*\}/g) || [];
fontFaceBlocks.forEach((block) => {
  const uuidsInBlock = [...block.matchAll(/[0-9a-f-]{36}/g)].map((m) => m[0]);
  const isVariable = uuidsInBlock.includes(variableUuid) || uuidsInBlock.includes(italicUuid);
  if (!isVariable) css = css.replace(block, '');
});
if (variableUuid) css = css.replaceAll(variableUuid, 'fonts/PlusJakartaSans-Variable.ttf');
if (italicUuid) css = css.replaceAll(italicUuid, 'fonts/PlusJakartaSans-Italic-Variable.ttf');
// Use Plus Jakarta Sans for body too (drops the need for Inter from Google Fonts)
css = css.replace(
  /--font-body:\s*'Inter'[^;]+;/,
  `--font-body:    'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;`,
);
const finalCss = css + '\n\n/* Page-specific overrides */\n' + pageCss;

// -------- 7. extract user JSX components, rewrite __resources references to relative paths --------
const userUuids = [...template.matchAll(/<script type="text\/babel" src="([^"]+)">/g)].map((m) => m[1]);
let combinedJsx = '';
for (const u of userUuids) {
  let src = assets[u].data.toString('utf8');
  src = src.replace(
    /(?:window\.)?__resources(?:\.([a-zA-Z0-9_]+)|\["([a-zA-Z0-9_]+)"\])/g,
    (_, idA, idB) => JSON.stringify(idToFile[idA || idB] || ''),
  );
  // strip the patterns Claude-Design uses to expose components globally —
  // `window.X = X;` lines and multiline `Object.assign(window, { ... });` blocks
  src = src.replace(/^\s*window\.\w+\s*=\s*\w+;?\s*$/gm, '');
  src = src.replace(/^\s*Object\.assign\(\s*window\s*,\s*\{[\s\S]*?\}\s*\)\s*;?\s*$/gm, '');
  combinedJsx += `\n// === ${u} ===\n${src}`;
}
// Some bundles split inline babel into multiple <script type="text/babel"> blocks
// (e.g. one for TWEAK_DEFAULTS, one for App). Grab them all in source order.
const inlineApp = [...template.matchAll(/<script type="text\/babel">([\s\S]+?)<\/script>/g)]
  .map((m) => m[1])
  .join('\n');
const appWithoutRender = inlineApp.replace(/const\s+root\s*=[\s\S]+?root\.render\([\s\S]+?\);?/, '');

// -------- 8. write SSR + client entries --------
// Runtime resources map — covers dynamic lookups like `__resources['client_' + l]`
// that the literal-key regex above can't rewrite at build time.
const resourcesMap =
  '{' +
  extResources.map((r) => `${JSON.stringify(r.id)}:${JSON.stringify(idToFile[r.id])}`).join(',') +
  '}';

const ssrEntry = `
import * as React from 'react';
import { renderToString } from 'react-dom/server';

globalThis.window = globalThis;
globalThis.window.parent = globalThis;
globalThis.window.addEventListener = () => {};
globalThis.window.removeEventListener = () => {};
globalThis.window.postMessage = () => {};
window.__resources = ${resourcesMap};

${combinedJsx}

${appWithoutRender}

process.stdout.write(renderToString(React.createElement(App)));
`;
await fs.writeFile(path.join(TMP, 'ssr-entry.jsx'), ssrEntry);

const clientEntry = `
import * as React from 'react';
import { hydrateRoot } from 'react-dom/client';

window.__resources = ${resourcesMap};

${combinedJsx}

${appWithoutRender}

hydrateRoot(document.getElementById('root'), React.createElement(App));
`;
await fs.writeFile(path.join(TMP, 'client-entry.jsx'), clientEntry);

// -------- 9. compile both with esbuild --------
const esbuildShared = {
  bundle: true,
  loader: { '.js': 'jsx', '.jsx': 'jsx' },
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  define: { 'process.env.NODE_ENV': '"production"' },
};
await esbuildBuild({
  ...esbuildShared,
  entryPoints: [path.join(TMP, 'ssr-entry.jsx')],
  format: 'cjs', // react-dom/server uses dynamic require
  outfile: path.join(TMP, 'ssr-entry.cjs'),
  platform: 'node',
});
await esbuildBuild({
  ...esbuildShared,
  entryPoints: [path.join(TMP, 'client-entry.jsx')],
  format: 'iife',
  outfile: path.join(OUT, 'app.js'),
  platform: 'browser',
  minify: true,
});
console.log('  compiled app.js');

// -------- 10. SSR → static HTML --------
const renderedHtml = execSync(`node ${path.join(TMP, 'ssr-entry.cjs')}`, {
  encoding: 'utf8',
  maxBuffer: 50 * 1024 * 1024,
});
console.log(`  SSR produced ${renderedHtml.length.toLocaleString()} chars of static HTML`);

// -------- 11. parse title/description from bundle template (so each landing page keeps its own SEO copy) --------
const titleMatch = template.match(/<title>([^<]+)<\/title>/);
const descMatch = template.match(/<meta\s+name="description"\s+content="([^"]+)"/);
const title = titleMatch ? titleMatch[1] : 'skillbyte';
const description = descMatch ? descMatch[1] : '';

// -------- 12. compose final index.html --------
const orgSchema = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'skillbyte GmbH',
  url: 'https://skillbyte.de',
  email: 'info@skillbyte.de',
  telephone: '+49-221-95490614',
  address: { '@type': 'PostalAddress', addressLocality: 'Köln', addressCountry: 'DE' },
};
const indexHtml = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="preload" href="fonts/PlusJakartaSans-Variable.ttf" as="font" type="font/ttf" crossorigin>
<link rel="stylesheet" href="styles.css">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:locale" content="de_DE">
<meta property="og:site_name" content="skillbyte">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#22C6DA">
<link rel="icon" href="../assets/images/favicon.png">
<script type="application/ld+json">${JSON.stringify(orgSchema)}</script>
</head>
<body>
<div id="root">${renderedHtml}</div>
<script src="app.js" defer></script>
</body>
</html>
`;

await fs.writeFile(path.join(OUT, 'index.html'), indexHtml);
await fs.writeFile(path.join(OUT, 'styles.css'), finalCss);

// -------- 13. cleanup tmp --------
await fs.rm(TMP, { recursive: true, force: true });

// -------- 14. summary --------
const stat = async (f) => (await fs.stat(path.join(OUT, f))).size;
console.log(`\n→ flat output written to ${path.relative(process.cwd(), OUT)}/`);
console.log(`  index.html : ${(await stat('index.html')).toLocaleString()} bytes`);
console.log(`  styles.css : ${(await stat('styles.css')).toLocaleString()} bytes`);
console.log(`  app.js     : ${(await stat('app.js')).toLocaleString()} bytes`);
console.log(`  + ${extResources.length} image(s) in assets/, 2 TTF(s) in fonts/`);
