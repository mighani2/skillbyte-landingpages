# Editing Claude Design bundled HTML files

These landing pages (e.g. `lp/esg-autopilot.html`) are produced by Claude Design and are **not normal HTML**. The visible content lives inside a JSON-encoded blob and base64/gzip resources. Editing them with a text editor or naive `Edit` calls will silently corrupt them. This file documents how to edit them safely.

## File anatomy

A bundled file has roughly this shape:

```
<html>
  <head> … loader CSS, status text … </head>
  <body>
    <div id="status">…</div>
    <script>… ~170 lines of loader JS …</script>

    <script type="__bundler/manifest">{ "<uuid>": { mime, compressed, data }, … }</script>
    <script type="__bundler/ext_resources">[ { id, uuid }, … ]</script>
    <script type="__bundler/template">"<JSON-encoded full HTML document>"</script>
  </body>
</html>
```

What the loader does at runtime (relevant when reasoning about edits):
1. Decodes every `manifest` entry → creates a `blob:` URL per UUID.
2. Reads the `template` JSON string (the entire inner HTML document).
3. String-replaces every UUID inside the template with its corresponding blob URL.
4. Parses the result with `DOMParser` and **replaces `document.documentElement`** with it.
5. Re-creates each `<script>` element so it actually executes; for `text/babel` scripts with a `src=` UUID, it fetches the blob and inlines the content.

So at runtime, the page you see is the inner template, not the outer file.

## What lives where

- **Outer page**: only the loader UI ("Unpacking…", "Rendering…") and the bundler scripts. Almost never the right place to edit.
- **`__bundler/template`**: full inner HTML — `<head>`, `<body>`, `<style>`, the React `App` definition, and the `<script type="text/babel" src="UUID">` references that pull in each component. Edit here for anything that would normally go in `<head>` or `<body>` (e.g. cookie banner CSS link + script, meta tags, root-level CSS, the App wiring).
- **`__bundler/manifest`** entries:
  - `image/png`, `font/woff2`, `font/ttf`: assets, base64.
  - `application/javascript` with `compressed: true`: **gzipped UTF-8** source. Each React component (Footer, TopNav, Hero, PainSection, SolutionSection, ValueSection, ProcessSection, ProofSection, FAQSection, CTAForm) is one entry, plus React, ReactDOM, Babel-standalone. Edit here for component-level changes (text copy, links inside a component, props).
  - `text/javascript`: third-party libs (e.g. Babel-standalone), gzipped.

To find which manifest entry holds a component, decode each `application/javascript` entry and grep the source for the component name (recipe below).

## ⚠️ The one gotcha that will burn you: `</script>` escaping

The browser HTML parser does **not** care about JSON strings or escape syntax. Inside `<script type="…">…</script>`, it treats the content as raw text and looks only for the literal byte sequence `</script` (case-insensitive) to end the tag. If you re-encode the manifest or template JSON with Python's default `json.dumps()`, any `</script>` inside the JSON appears literally and **terminates the outer wrapping script tag prematurely**, silently breaking the page.

The original encoder works around this by escaping `/` as `/` inside any closing tag (e.g. `</title>`, `</script>`).

Python's `json.dumps()` does **not** escape `/` by default. **You must do this yourself before writing.** Either of these works:

```python
encoded = json.dumps(obj).replace('</', '<\\/')   # backslash-slash, valid JSON, browser-safe
# or
encoded = json.dumps(obj).replace('/', '\\u002F') # heavier, matches original style
```

`<\/script>` is valid JSON (`\/` is an explicit JSON escape that decodes back to `/`) and the HTML parser does not treat the leading `<\` as a tag terminator.

How to detect this corruption after a write:
- Python `json.loads()` on the template/manifest content fails with `Unterminated string`.
- `find('</script>', mstart)` returns a position **inside** the JSON instead of the real boundary.
- In a browser the page renders blank or shows the loader stuck on "Unpacking…".

Always verify by re-decoding (recipe below) before declaring the change done.

## Standard edit recipes

These all work from the project root or anywhere — paths are absolute.

### Recipe 1: edit a React component (e.g. footer links, button text)

```python
import json, base64, gzip

path = '/path/to/lp/<page>.html'
with open(path) as f:
    content = f.read()

# Find manifest block
ms = content.find('<script type="__bundler/manifest">')
me = content.find('</script>', ms)
manifest = json.loads(content[ms:me].split('>', 1)[1])

# Find the component: scan application/javascript entries for a marker string
for uuid, entry in manifest.items():
    if 'javascript' not in entry['mime']:
        continue
    raw = base64.b64decode(entry['data'])
    if entry['compressed']:
        raw = gzip.decompress(raw)
    src = raw.decode('utf-8')
    if 'function Footer' in src:        # or whatever marker identifies your component
        target_uuid = uuid
        target_src = src
        target_entry = entry
        break

# Edit the source
new_src = target_src.replace(OLD_SNIPPET, NEW_SNIPPET)
assert new_src != target_src, 'replacement did not match'

# Re-encode (gzip if originally compressed) and put back
new_bytes = new_src.encode('utf-8')
if target_entry['compressed']:
    new_bytes = gzip.compress(new_bytes)
target_entry['data'] = base64.b64encode(new_bytes).decode('ascii')
manifest[target_uuid] = target_entry

# CRITICAL: escape </ → <\/
new_manifest = json.dumps(manifest).replace('</', '<\\/')
new_content = content[:ms] + '<script type="__bundler/manifest">' + new_manifest + content[me:]

with open(path, 'w') as f:
    f.write(new_content)
```

### Recipe 2: inject into `<head>` or `<body>` (e.g. cookie banner)

```python
import json

ts = content.find('<script type="__bundler/template">')
te = content.find('</script>', ts)
template = json.loads(content[ts:te].split('>', 1)[1])  # decoded inner HTML string

# Inject before </head> or </body>
i = template.find('</head>')
template = template[:i] + '\n<link rel="stylesheet" href="…">\n' + template[i:]

i = template.find('</body>')
template = template[:i] + '\n<script type="module">…</script>\n' + template[i:]

# CRITICAL: escape </ → <\/
new_template = json.dumps(template).replace('</', '<\\/')
new_content = content[:ts] + '<script type="__bundler/template">' + new_template + content[te:]
```

If you change **both** manifest and template in one pass, remember positions shift. Replace them in order (manifest first, since it appears earlier in the file) and rebuild slice-by-slice rather than doing two independent replaces. See the cookie-consent + footer-links commit for a working example.

### Recipe 3: verification (always run after a write)

```python
with open(path) as f:
    v = f.read()

# Both blocks must JSON-parse cleanly
ms = v.find('<script type="__bundler/manifest">');  me = v.find('</script>', ms)
ts = v.find('<script type="__bundler/template">'); te = v.find('</script>', ts)
manifest_ok = json.loads(v[ms:me].split('>', 1)[1])  # raises if corrupted
template_ok = json.loads(v[ts:te].split('>', 1)[1])

# No stray </script tokens inside either block (would terminate outer tag in browser)
import re
assert not re.search(r'</script', v[ms+34:me], re.I), 'manifest block has stray </script'
assert not re.search(r'</script', v[ts+34:te], re.I), 'template block has stray </script'
```

## Things to watch out for

- **Don't grep the file directly** for component content — base64 image and font data is huge and noisy. Decode manifest entries first.
- **Don't try to `Edit` tool a JSX snippet** that's stored gzipped+base64 inside the manifest. The bytes you see in the file aren't the source. Always decode → edit → re-encode → re-base64.
- **Whitespace/quote style matters in `replace()`**. The manifest entries use single quotes inside JSX (`color: 'var(--fg-3)'`) but the surrounding HTML attributes use double quotes (`href="#"`). Get this wrong and the replacement silently no-ops; always assert that `new_src != old_src`.
- **The outer HTML's `<head>`/`<body>` is not the rendered page.** The rendered page is the template's `<head>`/`<body>`. Don't add cookie banners or meta tags to the outer file.
- **Component names are PascalCase identifiers in the template's `App` JSX**, e.g. `<Footer />`, `<Hero />`. To find which manifest entry implements one, search component sources for `function <Name>` or `window.<Name> = <Name>`.
- **`text/babel` script tags reference UUIDs in `src=`.** The order of these tags in the template defines load order. If you add a new component, both the manifest entry and the `<script type="text/babel" src="UUID">` reference need to be added.
- **Other landing pages in this repo (`chemie/`, `logistik/`, `maschinenbau/`, etc.) are *not* Claude Design bundles** — they're plain HTML with normal `<head>`/`<body>`. Edit those normally. Only `lp/*.html` (so far) are bundled.

## Standard wirings for new bundled `lp/` pages

When a new page lands in `lp/` from `skillbyte-landingpages-generator`, three site-wide concerns need verifying before it ships. The form always needs full wiring; favicon and footer are usually correct out of the generator but worth confirming.

### 1. Form: Formgrid POST + required GDPR checkbox

The `CTAForm` Claude Design emits ships with a fake `onSubmit={(e) => { e.preventDefault(); setSent(true); }}` — the form looks live but submits nothing. Replace it with a real submission to **Formgrid** — the endpoint every other landing page in the repo uses:

- **Endpoint**: `https://formgrid.dev/api/f/qyqh73ha` (POST, native form submit — Formgrid redirects to `/danke.html` on success).
- **Implementation pattern**: don't refactor every `Field` / `SelectField` helper to accept `name=""`. Keep the React state, intercept `onSubmit`, build a hidden `<form>` from state via `document.createElement('form')`, append to body, `.submit()`. Minimal change, native redirect.
- **Hidden tracking fields** (match `chemie/`, `logistik/`, `maschinenbau/`):
  - `landingpage` — `'lp/<slug>'`
  - `technologie` — short page topic (e.g. `'ESG-Autopilot'`)
  - `branche` — sector (e.g. `'Industrie'`, `'Chemie'`, `'Maschinenbau'`)
- **Standard data fields**: `name` = `firstName + ' ' + lastName`, plus `email`, `phone`, `company`, `employees`, `message` (from notes/textarea), `privacy` = `'1'`.
- **Page-specific extras** (e.g. `role`, `trigger`) just pass through — Formgrid forwards them as-is.
- **GDPR checkbox is mandatory and blocking**:
  - Add `acceptedPrivacy: false` to the React form state.
  - Render a `<label><input type="checkbox" required …></label>` block above the submit button with a link to `https://www.skillbyte.de/datenschutz` (matches the URL the chemie/logistik/etc. pages use in their inline privacy link).
  - `disabled={!form.acceptedPrivacy}` on submit; `opacity: 0.55`, `cursor: 'not-allowed'` while disabled.
  - Belt-and-braces: also `if (!form.acceptedPrivacy) return;` early in the submit handler.
  - Remove any pre-existing implicit-consent paragraph (`"Mit dem Absenden stimme ich zu …"`) below the button — it's redundant once the box is there.

The CTAForm fix is a Recipe-1 manifest patch (decode → string-replace → gzip → base64 → re-encode → `</` → `<\/` → verify). See the `lp/esg-autopilot.html` form-wiring commit for a working Python patch script.

### 2. Favicon

The template's `<head>` should include:

```html
<link rel="icon" href="../assets/images/favicon.png">
```

The `../` matters — `lp/` is one level below the repo root where `assets/` lives. If the generator emits `assets/images/favicon.png` (no `../`) or omits the link entirely, patch via Recipe 2.

### 3. Footer links

The `Footer` component should point to skillbyte's legal pages:

- Impressum: `https://www.skillbyte.de/rechtliches/impressum`
- Datenschutz: `https://www.skillbyte.de/rechtliches/datenschutz`

Plus the brand line with `info@skillbyte.de` and the Köln phone `0221-95490614`. If a generator-produced footer drops a link, uses different URLs, or omits the contact details, patch the Footer manifest entry via Recipe 1.
