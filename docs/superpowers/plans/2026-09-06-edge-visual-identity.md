# Edge Visual Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the edge dashboard (`supernavi_edge/api/src/dashboard/`) on a SuperNavi token system derived from the logo, with the review queue as the first thing on screen and the seven services shown as logo-shaped blocks.

**Architecture:** Static HTML/CSS/JS served by `@fastify/static` from the `dashboard` folder (no build step). `tokens.css` holds only variables and `@font-face`; `dashboard.css` holds layout and components; `index.html` gets a header, a left rail (still `nav#tabBar` with `.tab-btn[data-tab]` so the existing tab router works), an overview with the review strip and service blocks, a new "Revisão" panel, and restyled lists and modals. `app.js` keeps every API call; it gains block rendering, the review strip/panel, an `activateTab()` helper, and row-style slide items. A mock server serves the folder with fixture data for visual verification.

**Tech Stack:** Vanilla HTML/CSS/JS, Node 20 (`node:test`, `node:http`), Atkinson Hyperlegible Next (woff2, self-hosted), Lucide-style inline SVG icons.

**Spec:** `docs/superpowers/specs/2026-09-06-edge-visual-identity-design.md` (project root, outside the edge repo).

## Global Constraints

- Repo: `supernavi_edge` (git). Branch `feat/visual-identity` from `origin/main`. Version `0.4.0` in `api/package.json`, `api/package-lock.json` (two occurrences), `processor/package.json`, `processor/package-lock.json` (two occurrences).
- No CDN. Fonts are woff2 files committed under `api/src/dashboard/fonts/`.
- Every `id` the current `app.js` reads must survive: `tabBar`, `panel-status`, `panel-slides`, `panel-failures`, `panel-activity`, `panel-settings`, `statusGrid`, `processorBody`, `btnRepublishPreviews`, `republishStatus`, `btnPublishLabels`, `publishLabelsStatus`, `filterButtons`, `slidesCount`, `slidesList`, `slidesEmpty`, `failuresSubtitle`, `refreshFailures`, `failuresList`, `failuresEmpty`, `stuckSyncSection`, `stuckSyncList`, `failuresBadge`, `pipelineModal`, `pipelineModalTitle`, `pipelineModalSubtitle`, `pipelineModalClose`, `pipelineModalBody`, `clearActivity`, `activityFeed`, `activityEmpty`, `settingsForm`, `cfgEdgeKey`, `toggleEdgeKey`, `edgeInfo`, `edgeInfoName`, `edgeInfoLab`, `cfgSlidesDir`, `cfgScannerType`, `cfgStableSeconds`, `stableSecondsValue`, `saveConfig`, `saveStatus`, `ocrModal`, `ocrPrev`, `ocrNavCounter`, `ocrNext`, `ocrModalClose`, `ocrSlide2Image`, `ocrLabelImage`, `ocrLabelPlaceholder`, `ocrReading`, `ocrFilename`, `ocrStatusValue`, `ocrManualInput`, `btnManualSave`, `ocrManualPreview`, `ocrStatusMsg`, `btnReocr`, `btnCloseOcr`, `pendingBadge`, `pendingCount`, `reviewModal`, `reviewModalTitle`, `reviewModalClose`, `reviewImage`, `reviewImageEmpty`, `reviewFilename`, `reviewFilenameHint`, `reviewFilenameError`, `reviewRescan`, `reviewConfirm`. The `#pendingPanel*` ids are removed together with their JS block (Task 5).
- Copy rules (spec 3.5): sentence case everywhere, no ALL CAPS, no monospace, action names Confirmar / Renomear / Confirmar todas / Rescanear / Publicar etiquetas / Republicar previews / Salvar configuração. Empty states: "Nenhuma lâmina com falha. O scanner segue sendo monitorado." / "Nenhuma lâmina aguardando confirmação." / "Nenhuma lâmina encontrada com este filtro." / "Nenhuma atividade registrada ainda."
- Colors, type scale, spacing and radii exactly as spec 3.1 to 3.4 (values repeated in `tokens.css` below).
- Existing edge tests must stay green: `node --test api/src/lib/*.test.js api/src/db/*.test.js api/src/services/*.test.js` and `node --test --test-force-exit api/src/routes/*.test.js`.
- `app.js` keeps its "no innerHTML with API data" rule: build nodes with `el()`.

---

### Task 1: Fonts and `tokens.css`

**Files:**
- Create: `api/src/dashboard/fonts/atkinson-hyperlegible-next-400.woff2`, `-500.woff2`, `-700.woff2`
- Create: `api/src/dashboard/tokens.css`
- Create: `api/src/dashboard/tokens.test.js`
- Create: `scripts/fetch-dashboard-fonts.sh`

**Interfaces:**
- Produces: CSS custom properties on `:root` named exactly as listed in the file below (`--sn-*`), consumed by `dashboard.css` (Task 4) and inline styles in `index.html` (Task 3).

- [ ] **Step 1: Create the branch**

```bash
cd supernavi_edge && git fetch -q origin && git checkout -b feat/visual-identity origin/main
```

- [ ] **Step 2: Write the failing test for tokens and fonts**

Create `api/src/dashboard/tokens.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const css = () => readFileSync(join(here, 'tokens.css'), 'utf8');

function hex(css, name) {
  const m = css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(m, `token ${name} missing or not a 6-digit hex`);
  return m[1];
}
function luminance(h) {
  const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

describe('tokens.css', () => {
  it('defines the brand palette from the logo', () => {
    const s = css();
    assert.equal(hex(s, '--sn-petroleo'), '#003858');
    assert.equal(hex(s, '--sn-azul'), '#3890D0');
    assert.equal(hex(s, '--sn-grafite'), '#304048');
    assert.equal(hex(s, '--sn-prata'), '#B8B8C0');
  });

  it('keeps text readable on the card surface (WCAG 7:1 primary, 4.5:1 secondary)', () => {
    const s = css();
    assert.ok(contrast(hex(s, '--sn-texto'), hex(s, '--sn-cartao')) >= 7);
    assert.ok(contrast(hex(s, '--sn-texto-2'), hex(s, '--sn-cartao')) >= 4.5);
    assert.ok(contrast(hex(s, '--sn-texto'), hex(s, '--sn-fundo')) >= 7);
  });

  it('keeps state colors legible as text on the panel', () => {
    const s = css();
    for (const t of ['--sn-ok', '--sn-atencao', '--sn-falha', '--sn-azul']) {
      assert.ok(contrast(hex(s, t), hex(s, '--sn-painel')) >= 3, `${t} on painel`);
    }
  });

  it('self-hosts the three Atkinson Hyperlegible Next faces', () => {
    const s = css();
    for (const w of [400, 500, 700]) {
      const f = join(here, 'fonts', `atkinson-hyperlegible-next-${w}.woff2`);
      assert.ok(statSync(f).size > 10_000, `${f} too small`);
      assert.match(s, new RegExp(`url\\("/fonts/atkinson-hyperlegible-next-${w}\\.woff2"\\)`));
    }
    assert.doesNotMatch(s, /fonts\.googleapis|gstatic/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test api/src/dashboard/tokens.test.js`
Expected: FAIL (ENOENT tokens.css).

- [ ] **Step 4: Download the fonts**

Create `scripts/fetch-dashboard-fonts.sh`:

```bash
#!/usr/bin/env bash
# Downloads the latin woff2 faces of Atkinson Hyperlegible Next (400/500/700)
# into api/src/dashboard/fonts/. Run once; the files are committed.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/api/src/dashboard/fonts"
mkdir -p "$DIR"
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
for W in 400 500 700; do
  CSS=$(curl -sf -A "$UA" "https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:wght@${W}&display=swap")
  # The latin block is the last @font-face in the response; take its woff2 URL.
  URL=$(printf '%s' "$CSS" | awk '/\/\* latin \*\//{f=1} f && /url\(/{print; exit}' | sed -E 's/.*url\(([^)]+)\).*/\1/')
  [ -n "$URL" ] || { echo "no latin url for weight $W"; exit 1; }
  curl -sf -A "$UA" "$URL" -o "$DIR/atkinson-hyperlegible-next-${W}.woff2"
  echo "weight $W -> $(wc -c < "$DIR/atkinson-hyperlegible-next-${W}.woff2") bytes"
done
```

Run: `chmod +x scripts/fetch-dashboard-fonts.sh && scripts/fetch-dashboard-fonts.sh`
Expected: three lines, each above 10000 bytes.

- [ ] **Step 5: Write `tokens.css`**

Create `api/src/dashboard/tokens.css`:

```css
/* SuperNavi design tokens. Only variables and @font-face live here.
   Spec: docs/superpowers/specs/2026-09-06-edge-visual-identity-design.md (§3) */

@font-face {
  font-family: "Atkinson Hyperlegible Next";
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url("/fonts/atkinson-hyperlegible-next-400.woff2") format("woff2");
}
@font-face {
  font-family: "Atkinson Hyperlegible Next";
  font-style: normal;
  font-weight: 500;
  font-display: swap;
  src: url("/fonts/atkinson-hyperlegible-next-500.woff2") format("woff2");
}
@font-face {
  font-family: "Atkinson Hyperlegible Next";
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url("/fonts/atkinson-hyperlegible-next-700.woff2") format("woff2");
}

:root {
  /* Brand (sampled from the logo) */
  --sn-petroleo: #003858;
  --sn-azul: #3890D0;
  --sn-grafite: #304048;
  --sn-prata: #B8B8C0;
  --sn-papel: #F4F7FA;

  /* States */
  --sn-ok: #35B37A;
  --sn-atencao: #E0A33A;
  --sn-falha: #E25C5C;
  --sn-ok-bg: rgba(53, 179, 122, 0.14);
  --sn-atencao-bg: rgba(224, 163, 58, 0.14);
  --sn-falha-bg: rgba(226, 92, 92, 0.14);
  --sn-azul-bg: rgba(56, 144, 208, 0.14);

  /* Dark scale (petróleo darkened) */
  --sn-fundo: #071A28;
  --sn-painel: #0B2436;
  --sn-cartao: #10334A;
  --sn-realce: #1A4460;
  --sn-borda: rgba(184, 184, 192, 0.14);
  --sn-texto: #E6EEF5;
  --sn-texto-2: #9FB3C4;
  --sn-texto-3: #6E8496;
  --sn-sombra: 0 8px 24px rgba(0, 0, 0, 0.35);
  --sn-veu: rgba(7, 26, 40, 0.7);

  /* Type */
  --sn-fonte: "Atkinson Hyperlegible Next", system-ui, "Segoe UI", sans-serif;
  --sn-t-grande: 32px;
  --sn-t-pagina: 22px;
  --sn-t-secao: 18px;
  --sn-t-id: 15px;
  --sn-t-corpo: 14px;
  --sn-t-lista: 13px;

  /* Spacing */
  --sn-esp-1: 4px;
  --sn-esp-2: 8px;
  --sn-esp-3: 12px;
  --sn-esp-4: 16px;
  --sn-esp-5: 24px;
  --sn-esp-6: 32px;
  --sn-esp-7: 48px;

  /* Radius */
  --sn-raio-controle: 6px;
  --sn-raio-cartao: 10px;
  --sn-raio-bloco: 12px;

  /* Motion */
  --sn-mov: 240ms ease;

  /* Layout */
  --sn-cabecalho: 56px;
  --sn-trilho: 200px;
  --sn-trilho-min: 56px;
  --sn-conteudo-max: 1180px;
}

@media (prefers-reduced-motion: reduce) {
  :root { --sn-mov: 0ms; }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test api/src/dashboard/tokens.test.js`
Expected: 4 pass.

- [ ] **Step 7: Commit**

```bash
git add api/src/dashboard/tokens.css api/src/dashboard/tokens.test.js api/src/dashboard/fonts scripts/fetch-dashboard-fonts.sh
git commit -m "feat(dashboard): SuperNavi tokens and self-hosted Atkinson Hyperlegible Next"
```

---

### Task 2: Mock server for visual verification

**Files:**
- Create: `scripts/dashboard-mock.js`
- Create: `scripts/dashboard-mock.test.js`

**Interfaces:**
- Produces: `node scripts/dashboard-mock.js [port] [cenario]` serving `api/src/dashboard/` at `/` plus the `/v1/*` routes the dashboard calls. Scenarios: `normal` (17 pending, all services up), `falhas` (tunnel down, 3 failures, 2 stuck sync), `vazio` (nothing pending, no slides). Exported `buildFixtures(cenario)` for tests.

- [ ] **Step 1: Write the failing test**

Create `scripts/dashboard-mock.test.js`:

```js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMock } from './dashboard-mock.js';

describe('dashboard-mock', () => {
  let srv; let base;
  before(async () => { srv = await startMock(0, 'normal'); base = `http://127.0.0.1:${srv.address().port}`; });
  after(() => srv.close());

  it('serves the dashboard index', async () => {
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /SuperNavi Edge/);
  });

  it('answers the dashboard, slides and pending routes', async () => {
    const d = await (await fetch(`${base}/v1/dashboard`)).json();
    assert.equal(d.tunnel.connected, true);
    assert.equal(d.slides.total, 119);
    const s = await (await fetch(`${base}/v1/slides`)).json();
    assert.ok(Array.isArray(s.slides) && s.slides.length >= 10);
    const p = await (await fetch(`${base}/v1/pending-slides`)).json();
    assert.equal(p.total, 17);
    assert.equal(p.slides.length, 17);
  });

  it('serves a label image for a pending slide', async () => {
    const p = await (await fetch(`${base}/v1/pending-slides`)).json();
    const r = await fetch(`${base}/v1/pending-slides/${p.slides[0].id}/image?which=label`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/svg+xml');
  });

  it('switches to the failure scenario with ?cenario=falhas', async () => {
    const d = await (await fetch(`${base}/v1/dashboard?cenario=falhas`)).json();
    assert.equal(d.tunnel.connected, false);
    const f = await (await fetch(`${base}/v1/dashboard/failures?cenario=falhas`)).json();
    assert.equal(f.failures.length, 3);
    assert.equal(f.stuckSync.length, 2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/dashboard-mock.test.js`
Expected: FAIL (cannot find module `./dashboard-mock.js`).

- [ ] **Step 3: Write the mock server**

Create `scripts/dashboard-mock.js`:

```js
#!/usr/bin/env node
/**
 * Serves api/src/dashboard/ with fixture data so the UI can be reviewed without
 * the edge stack. Usage: node scripts/dashboard-mock.js [port=8099] [cenario=normal]
 * Scenarios: normal | falhas | vazio. Any request may override with ?cenario=.
 * The scenario given on the command line is the default; the page itself does
 * not pass ?cenario, so start one process per scenario when taking screenshots.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'src', 'dashboard');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

const id = (n) => (String(n).padStart(2, '0') + 'a'.repeat(62)).slice(0, 64);
const iso = (minAgo) => new Date(Date.now() - minAgo * 60_000).toISOString();

export function buildFixtures(cenario = 'normal') {
  const falhas = cenario === 'falhas';
  const vazio = cenario === 'vazio';
  const pending = vazio ? [] : Array.from({ length: 17 }, (_, i) => ({
    id: id(100 + i),
    proposed_name: i === 3 ? null : `AP2600${String(1402 + i * 71).padStart(4, '0')}${i % 4 === 1 ? 'B' : ''}`,
    original_filename: `_2026090${(i % 9) + 1}0${String(85830 + i * 97).slice(0, 5)}.svs`,
    case_base: null, created_at: iso(30 + i * 60), format: 'svs', has_dsmeta: true,
  }));
  const statuses = ['ready', 'ready', 'ready', 'processing', 'ready', 'queued', 'ready', 'failed', 'ready', 'ready', 'ready', 'ready'];
  const slides = vazio ? [] : statuses.map((status, i) => ({
    slideId: id(i), originalFilename: i === 1 ? 'RE26000003.svs' : `_202609060${String(90000 + i * 313).slice(0, 5)}.svs`,
    externalCaseBase: i === 1 ? 'RE26000003' : `AP2600${String(2600 + i).padStart(4, '0')}`,
    externalSlideLabel: i === 1 ? 'RE26000003' : `AP2600${String(2600 + i).padStart(4, '0')}${i % 3 === 0 ? 'A' : ''}`,
    reviewStatus: i % 5 === 0 ? 'pending' : 'confirmed',
    status, format: 'svs', width: 66192, height: 142109, appMag: 40, pipelineMode: 'bigtiff_iiif',
    cloudUploadStatus: status === 'ready' ? 'done' : 'pending', hasLabel: true, hasRawFile: true,
    latestError: status === 'failed' ? 'vips tiffsave: out of memory' : null, latestErrorStage: status === 'failed' ? 'bigtiff' : null,
    createdAt: iso(20 + i * 45),
  }));
  const failures = falhas ? [0, 1, 2].map(i => ({
    slideId: id(70 + i), originalFilename: `_2026090512${String(3000 + i * 111).slice(0, 4)}.svs`, stage: ['bigtiff', 'upload', 'p0'][i],
    message: ['vips tiffsave: out of memory', 'Cloud init failed: 503', 'Could not determine slide dimensions'][i], errorAt: iso(15 + i * 40),
    advice: { severity: ['error', 'warn', 'error'][i], reason: ['Faltou memória ao gerar o BigTIFF', 'A nuvem não respondeu ao iniciar o envio', 'O arquivo não tem dimensões legíveis'][i], suggestion: ['Feche outros programas e reprocesse', 'Reprocessar quando o túnel voltar', 'Rescanear a lâmina'][i], action: 'reprocess' },
  })) : [];
  const stuckSync = falhas ? [0, 1].map(i => ({ eventId: 500 + i, entityType: 'slide', entityId: id(80 + i), op: 'registered', attempts: 12 + i, lastError: 'ECONNRESET', createdAt: iso(200 + i * 30) })) : [];
  return {
    health: { status: 'ok', version: '0.4.0', mode: 'local', tunnel: { configured: true, connected: !falhas, agentId: 'MAC01' }, watcher: { state: 'running', ingestDir: '/data/inbox' }, scanner: { enabled: true, state: falhas ? 'error' : 'running', error: falhas ? 'Pasta do scanner inacessível' : null, totalDiscovered: 119 } },
    dashboard: {
      tunnel: { configured: true, connected: !falhas, agentId: 'MAC01' },
      watcher: { state: 'running', ingestDir: '/data/inbox' },
      scanner: { enabled: true, state: falhas ? 'error' : 'running', error: falhas ? 'Pasta do scanner inacessível' : null, lastScan: iso(1), lastScanCount: 0, totalDiscovered: 119 },
      config: { source: 'auto-detect', scannerType: 'motic', slidesDirHost: '/Volumes/Motic/Completed', stableSeconds: 15 },
      slides: { total: vazio ? 0 : 119, ready: vazio ? 0 : 104, processing: vazio ? 0 : 1, queued: vazio ? 0 : 1, failed: falhas ? 3 : (vazio ? 0 : 1), withProblems: falhas ? 3 : 0 },
      jobs: { pending: vazio ? 0 : 3, running: vazio ? 0 : 1, active: vazio ? [] : [{ slide_id: id(3), original_filename: '_20260906091239.svs', type: 'BIGTIFF', status: 'running' }] },
      sync: { stuckCount: stuckSync.length },
    },
    slides: { slides }, pending: { total: pending.length, slides: pending },
    failures: { failures, stuckSync, total: failures.length, stuckSyncTotal: stuckSync.length },
    config: { edgeKey: '', slidesDirHost: '/Volumes/Motic/Completed', scannerType: 'motic', stableSeconds: 15 },
  };
}

function labelSvg(name) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="220" viewBox="0 0 320 220"><rect width="320" height="220" fill="#e9e6df"/><rect x="18" y="18" width="284" height="184" rx="6" fill="#fbfaf6" stroke="#c9c4b8"/><text x="36" y="70" font-family="sans-serif" font-size="22" fill="#2a2a2a">26-${(name || 'xxxx').slice(-4)}</text><text x="36" y="110" font-family="sans-serif" font-size="16" fill="#555">HE  · 05/09</text><rect x="200" y="40" width="80" height="80" fill="#222"/></svg>`;
}

function json(res, body, status = 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }

export function startMock(port = 8099, defaultCenario = 'normal') {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const fx = buildFixtures(url.searchParams.get('cenario') || defaultCenario);
    const p = url.pathname;
    if (p === '/v1/health') return json(res, fx.health);
    if (p === '/v1/dashboard') return json(res, fx.dashboard);
    if (p === '/v1/dashboard/failures') return json(res, fx.failures);
    if (p === '/v1/slides') return json(res, fx.slides);
    if (p === '/v1/pending-slides') return json(res, fx.pending);
    if (p === '/v1/admin/config') return json(res, fx.config);
    let m;
    if ((m = p.match(/^\/v1\/pending-slides\/([0-9a-f]{64})\/image$/))) {
      const s = fx.pending.slides.find(x => x.id === m[1]);
      res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end(labelSvg(s?.proposed_name));
    }
    if ((m = p.match(/^\/v1\/slides\/([0-9a-f]{64})\/(thumb|label|slide2)$/))) {
      res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end(labelSvg('thumb'));
    }
    if ((m = p.match(/^\/v1\/slides\/([0-9a-f]{64})\/pipeline$/))) {
      return json(res, { slideId: m[1], events: [
        { stage: 'ingest', level: 'info', message: 'Arquivo estável, registrado', created_at: iso(120) },
        { stage: 'bigtiff', level: 'info', message: 'BigTIFF pipeline complete', created_at: iso(90) },
        { stage: 'sync', level: 'info', message: 'Synced to cloud: slide/registered', created_at: iso(88) },
        { stage: 'preview', level: 'error', message: 'Label photo upload to the cloud failed', created_at: iso(30), details: { code: 'ETIMEDOUT' } },
      ] });
    }
    if (p === '/v1/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connected\ndata: {}\n\n'); return; }
    if (req.method === 'POST' && p.startsWith('/v1/')) return json(res, { success: true, queued: 104, message: 'ok' });
    const file = join(ROOT, p === '/' ? 'index.html' : p);
    try { const body = await readFile(file); res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' }); res.end(body); }
    catch { res.writeHead(404); res.end('not found'); }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2] || 8099); const cenario = process.argv[3] || 'normal';
  startMock(port, cenario).then(() => console.log(`dashboard mock (${cenario}) at http://127.0.0.1:${port}/`));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/dashboard-mock.test.js`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/dashboard-mock.js scripts/dashboard-mock.test.js
git commit -m "chore(dashboard): mock server with fixture scenarios for visual review"
```

---

### Task 3: New `index.html`

**Files:**
- Modify: `api/src/dashboard/index.html` (full rewrite)

**Interfaces:**
- Produces the DOM contract used by Task 5: rail buttons `.tab-btn[data-tab]` for `status|slides|review|failures|activity|settings`; header dots `#hdrTunnelDot`, `#hdrTunnelText`, `#hdrScannerDot`, `#hdrScannerText`, `#hdrAgent`; blocks `#blk-tunnel`, `#blk-scanner`, `#blk-watcher`, `#blk-db`, `#blk-queue`, `#blk-processor`, `#blk-disk` each with `.block` and `.block-detail`; overview review strip `#ovReview` with `#ovReviewCount`, `#ovReviewThumbs`, `#ovReviewConfirmAll`, `#ovReviewOpen`, `#ovReviewEmpty`; recent slides `#recentSlides`; review panel `#panel-review` with `#reviewQueueCount`, `#reviewConfirmAll`, `#reviewList`, `#reviewEmpty`; rail badge `#pendingBadge` containing `#pendingCount`.

- [ ] **Step 1: Replace `index.html`**

Write `api/src/dashboard/index.html` with exactly this content:

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SuperNavi Edge</title>
  <link rel="stylesheet" href="/tokens.css">
  <link rel="stylesheet" href="/dashboard.css">
</head>
<body>
<div class="app">

  <header class="topbar">
    <div class="brand">
      <svg class="brand-mark" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
        <rect x="10" y="1"  width="8" height="8" rx="2.4" fill="var(--sn-prata)"/>
        <rect x="1"  y="10" width="8" height="8" rx="2.4" fill="var(--sn-prata)"/>
        <rect x="10" y="10" width="8" height="8" rx="2.4" fill="var(--sn-azul)"/>
        <rect x="19" y="10" width="8" height="8" rx="2.4" fill="var(--sn-prata)"/>
        <rect x="10" y="19" width="8" height="8" rx="2.4" fill="var(--sn-prata)"/>
      </svg>
      <span class="brand-name">SuperNavi Edge</span>
      <span class="brand-agent" id="hdrAgent">Agente --</span>
    </div>
    <div class="topbar-health" aria-live="polite">
      <span class="health"><span class="dot" id="hdrTunnelDot"></span><span id="hdrTunnelText">Túnel</span></span>
      <span class="health"><span class="dot" id="hdrScannerDot"></span><span id="hdrScannerText">Scanner</span></span>
    </div>
  </header>

  <nav class="rail" id="tabBar" aria-label="Seções">
    <button class="tab-btn active" data-tab="status">
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
      <span>Visão geral</span>
    </button>
    <button class="tab-btn" data-tab="slides">
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/></svg>
      <span>Lâminas</span>
    </button>
    <button class="tab-btn" data-tab="review">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
      <span>Revisão</span>
      <span class="rail-badge hidden" id="pendingBadge" title="Aguardando confirmação"><span id="pendingCount">0</span></span>
    </button>
    <button class="tab-btn" data-tab="failures">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
      <span>Falhas</span>
      <span class="rail-badge rail-badge-falha" id="failuresBadge" style="display:none">0</span>
    </button>
    <button class="tab-btn" data-tab="activity">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
      <span>Atividade</span>
    </button>
    <button class="tab-btn" data-tab="settings">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>
      <span>Configurações</span>
    </button>
  </nav>

  <main class="content">

    <!-- Visão geral -->
    <section class="tab-panel active" id="panel-status">
      <div class="review-strip" id="ovReview">
        <div class="review-strip-head">
          <h2 class="t-secao">Aguardando sua confirmação</h2>
          <span class="t-grande" id="ovReviewCount">0</span>
          <div class="review-strip-actions">
            <button class="btn" id="ovReviewConfirmAll">Confirmar todas</button>
            <button class="btn btn-primario" id="ovReviewOpen">Abrir revisão</button>
          </div>
        </div>
        <div class="review-thumbs" id="ovReviewThumbs"></div>
        <p class="review-strip-empty t-2 hidden" id="ovReviewEmpty">Nenhuma lâmina aguardando confirmação.</p>
      </div>

      <div class="services-head">
        <h2 class="t-secao">Serviços</h2>
        <div class="maintenance">
          <button class="btn btn-pequeno" id="btnRepublishPreviews">Republicar previews</button>
          <span class="maint-status t-3" id="republishStatus"></span>
          <button class="btn btn-pequeno" id="btnPublishLabels">Publicar etiquetas</button>
          <span class="maint-status t-3" id="publishLabelsStatus"></span>
        </div>
      </div>
      <div class="blocks" id="statusGrid">
        <div class="service" id="blk-tunnel"><span class="block" data-state="unknown"></span><div class="service-text"><span class="service-name">Túnel</span><span class="block-detail t-3">--</span></div></div>
        <div class="service" id="blk-scanner"><span class="block" data-state="unknown"></span><div class="service-text"><span class="service-name">Scanner</span><span class="block-detail t-3">--</span></div></div>
        <div class="service" id="blk-watcher"><span class="block" data-state="unknown"></span><div class="service-text"><span class="service-name">Entrada</span><span class="block-detail t-3">--</span></div></div>
        <div class="service" id="blk-db"><span class="block" data-state="unknown"></span><div class="service-text"><span class="service-name">Banco</span><span class="block-detail t-3">--</span></div></div>
        <div class="service" id="blk-queue"><span class="block" data-state="unknown"></span><div class="service-text"><span class="service-name">Fila</span><span class="block-detail t-3">--</span></div></div>
        <div class="service" id="blk-processor"><span class="block" data-state="unknown"></span><div class="service-text"><span class="service-name">Processador</span><span class="block-detail t-3" id="processorBody">--</span></div></div>
        <div class="service" id="blk-disk"><span class="block" data-state="unknown"></span><div class="service-text"><span class="service-name">Disco</span><span class="block-detail t-3">--</span></div></div>
      </div>

      <div class="section-head">
        <h2 class="t-secao">Lâminas recentes</h2>
        <button class="btn btn-link" data-goto="slides">Ver todas</button>
      </div>
      <div class="rows" id="recentSlides"></div>
    </section>

    <!-- Lâminas -->
    <section class="tab-panel" id="panel-slides">
      <div class="section-head">
        <h2 class="t-pagina">Lâminas</h2>
        <span class="t-2 tnum" id="slidesCount">0 lâminas</span>
      </div>
      <div class="segment" id="filterButtons" role="tablist">
        <button class="filter-btn active" data-filter="all">Todas</button>
        <button class="filter-btn" data-filter="ready">Prontas</button>
        <button class="filter-btn" data-filter="processing">Processando</button>
        <button class="filter-btn" data-filter="failed">Erro</button>
      </div>
      <div class="rows" id="slidesList">
        <p class="empty" id="slidesEmpty">Nenhuma lâmina encontrada com este filtro.</p>
      </div>
    </section>

    <!-- Revisão -->
    <section class="tab-panel" id="panel-review">
      <div class="section-head">
        <h2 class="t-pagina">Revisão</h2>
        <span class="t-2 tnum" id="reviewQueueCount">0 aguardando</span>
        <button class="btn" id="reviewConfirmAll">Confirmar todas</button>
      </div>
      <p class="t-2">Confira a foto da etiqueta e confirme o nome lido. Um nome só entra no PathoWeb depois que uma pessoa confirma.</p>
      <div class="review-cards" id="reviewList"></div>
      <p class="empty hidden" id="reviewEmpty">Nenhuma lâmina aguardando confirmação.</p>
    </section>

    <!-- Falhas -->
    <section class="tab-panel" id="panel-failures">
      <div class="section-head">
        <h2 class="t-pagina">Falhas</h2>
        <span class="t-2" id="failuresSubtitle">--</span>
        <button class="btn btn-pequeno" id="refreshFailures">Atualizar</button>
      </div>
      <h3 class="t-secao">Falhas de processamento</h3>
      <div class="rows" id="failuresList">
        <p class="empty" id="failuresEmpty">Nenhuma lâmina com falha. O scanner segue sendo monitorado.</p>
      </div>
      <div id="stuckSyncSection" style="display:none">
        <h3 class="t-secao">Sincronização travada</h3>
        <div class="rows" id="stuckSyncList"></div>
      </div>
    </section>

    <!-- Atividade -->
    <section class="tab-panel" id="panel-activity">
      <div class="section-head">
        <h2 class="t-pagina">Atividade</h2>
        <button class="btn btn-pequeno" id="clearActivity">Limpar</button>
      </div>
      <div class="rows" id="activityFeed">
        <p class="empty" id="activityEmpty">Nenhuma atividade registrada ainda.</p>
      </div>
    </section>

    <!-- Configurações -->
    <section class="tab-panel" id="panel-settings">
      <div class="section-head"><h2 class="t-pagina">Configurações</h2></div>
      <form class="form" id="settingsForm" onsubmit="return false">
        <h3 class="t-secao">Conexão com a nuvem</h3>
        <div class="field">
          <label for="cfgEdgeKey">Chave do edge</label>
          <div class="field-row">
            <input type="password" id="cfgEdgeKey" placeholder="Cole a chave gerada no painel da nuvem" autocomplete="off">
            <button type="button" class="btn btn-icone" id="toggleEdgeKey" aria-label="Mostrar ou ocultar chave">
              <svg viewBox="0 0 24 24" class="icon-eye" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              <svg viewBox="0 0 24 24" class="icon-eye-off" style="display:none" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            </button>
          </div>
          <small>Gerada no painel de administração da nuvem. Identifica este edge no túnel.</small>
        </div>
        <div class="edge-info" id="edgeInfo" style="display:none">
          <span class="dot ok"></span>
          <span><strong id="edgeInfoName">--</strong> <span class="t-2" id="edgeInfoLab">--</span></span>
        </div>

        <h3 class="t-secao">Scanner e pasta</h3>
        <div class="field">
          <label for="cfgSlidesDir">Pasta de lâminas</label>
          <input type="text" id="cfgSlidesDir" placeholder="/caminho/para/laminas">
          <small>Pasta do scanner monitorada no computador.</small>
        </div>
        <div class="field">
          <label for="cfgScannerType">Tipo de scanner</label>
          <select id="cfgScannerType">
            <option value="unknown">Desconhecido</option>
            <option value="motic">Motic</option>
            <option value="leica">Leica</option>
            <option value="hamamatsu">Hamamatsu</option>
            <option value="3dhistech">3DHistech</option>
            <option value="zeiss">Zeiss</option>
          </select>
        </div>
        <div class="field">
          <label for="cfgStableSeconds">Tempo de estabilidade: <span class="tnum" id="stableSecondsValue">10</span> s</label>
          <input type="range" id="cfgStableSeconds" min="5" max="60" value="10" step="1">
          <small>Segundos de espera depois da última modificação do arquivo antes de ler a lâmina.</small>
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn-primario" id="saveConfig">Salvar configuração</button>
          <span class="t-2" id="saveStatus"></span>
        </div>
      </form>
    </section>

  </main>
</div>

<!-- Timeline da lâmina -->
<div class="modal-veu" id="pipelineModal">
  <div class="modal modal-timeline" role="dialog" aria-modal="true" aria-labelledby="pipelineModalTitle">
    <header class="modal-head">
      <div>
        <h2 class="t-secao" id="pipelineModalTitle">Timeline da lâmina</h2>
        <div class="t-2" id="pipelineModalSubtitle">--</div>
      </div>
      <button class="btn btn-icone" id="pipelineModalClose" aria-label="Fechar">&times;</button>
    </header>
    <div class="modal-body" id="pipelineModalBody"><p class="t-2">Carregando...</p></div>
  </div>
</div>

<!-- Renomear lâmina já identificada -->
<div class="modal-veu" id="ocrModal">
  <div class="modal modal-renomear" role="dialog" aria-modal="true">
    <header class="modal-head">
      <h2 class="t-secao">Renomear lâmina</h2>
      <div class="modal-nav">
        <button class="btn btn-icone" id="ocrPrev" aria-label="Anterior">&#8249;</button>
        <span class="t-2 tnum" id="ocrNavCounter">1 / 1</span>
        <button class="btn btn-icone" id="ocrNext" aria-label="Próxima">&#8250;</button>
      </div>
      <button class="btn btn-icone" id="ocrModalClose" aria-label="Fechar">&times;</button>
    </header>
    <div class="modal-body modal-colunas">
      <div class="foto">
        <div class="segment segment-pequeno">
          <button class="ocr-tab active" data-tab="slide2">Lâmina</button>
          <button class="ocr-tab" data-tab="label">Etiqueta</button>
        </div>
        <div class="foto-quadro">
          <img id="ocrSlide2Image" alt="Foto da lâmina inteira">
          <img id="ocrLabelImage" alt="Foto da etiqueta" style="display:none">
          <div class="foto-vazia" id="ocrLabelPlaceholder" style="display:none">Foto não disponível</div>
        </div>
      </div>
      <div class="form">
        <dl class="dados">
          <dt>Leitura</dt><dd id="ocrReading">--</dd>
          <dt>Arquivo</dt><dd id="ocrFilename">--</dd>
          <dt>Situação</dt><dd id="ocrStatusValue">--</dd>
        </dl>
        <div class="field">
          <label for="ocrManualInput">Novo nome</label>
          <div class="field-row">
            <input type="text" id="ocrManualInput" class="t-id" placeholder="AP26000388A1, RE26000003 ou 26-388A" autocomplete="off" spellcheck="false">
            <button class="btn btn-primario" id="btnManualSave" disabled>Renomear</button>
          </div>
          <small id="ocrManualPreview"></small>
        </div>
        <p class="t-2" id="ocrStatusMsg"></p>
        <div class="form-actions">
          <button class="btn" id="btnReocr">Ler etiqueta de novo</button>
          <button class="btn" id="btnCloseOcr">Fechar</button>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- Revisar lâmina pendente -->
<div id="reviewModal" class="modal-veu hidden">
  <div class="modal modal-revisao" role="dialog" aria-modal="true" aria-labelledby="reviewModalTitle">
    <header class="modal-head">
      <h2 class="t-secao" id="reviewModalTitle">Revisar lâmina</h2>
      <button type="button" class="btn btn-icone" id="reviewModalClose" aria-label="Fechar">&times;</button>
    </header>
    <div class="modal-body modal-colunas">
      <div class="foto">
        <div class="segment segment-pequeno review-modal__image-toggle">
          <button type="button" data-which="label" class="active">Etiqueta</button>
          <button type="button" data-which="slide2">Lâmina inteira</button>
        </div>
        <div class="foto-quadro">
          <img id="reviewImage" alt="Foto da etiqueta">
          <div id="reviewImageEmpty" class="foto-vazia hidden">Foto não disponível</div>
        </div>
      </div>
      <div class="form">
        <div class="field">
          <label for="reviewFilename">Nome da lâmina</label>
          <input type="text" id="reviewFilename" class="t-id" autocomplete="off" spellcheck="false">
          <small id="reviewFilenameHint">Leitura do OCR</small>
          <small id="reviewFilenameError" class="erro hidden"></small>
        </div>
        <div class="form-actions">
          <button type="button" class="btn" id="reviewRescan">Rescanear</button>
          <span class="spacer"></span>
          <button type="button" class="btn btn-primario" id="reviewConfirm" disabled>Confirmar e próxima</button>
        </div>
      </div>
    </div>
  </div>
</div>

<script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Sanity-check the id contract**

Run:
```bash
cd api/src/dashboard && for id in tabBar panel-status panel-slides panel-review panel-failures panel-activity panel-settings statusGrid processorBody btnRepublishPreviews republishStatus btnPublishLabels publishLabelsStatus filterButtons slidesCount slidesList slidesEmpty failuresSubtitle refreshFailures failuresList failuresEmpty stuckSyncSection stuckSyncList failuresBadge pipelineModal pipelineModalTitle pipelineModalSubtitle pipelineModalClose pipelineModalBody clearActivity activityFeed activityEmpty settingsForm cfgEdgeKey toggleEdgeKey edgeInfo edgeInfoName edgeInfoLab cfgSlidesDir cfgScannerType cfgStableSeconds stableSecondsValue saveConfig saveStatus ocrModal ocrPrev ocrNavCounter ocrNext ocrModalClose ocrSlide2Image ocrLabelImage ocrLabelPlaceholder ocrReading ocrFilename ocrStatusValue ocrManualInput btnManualSave ocrManualPreview ocrStatusMsg btnReocr btnCloseOcr pendingBadge pendingCount reviewModal reviewModalTitle reviewModalClose reviewImage reviewImageEmpty reviewFilename reviewFilenameHint reviewFilenameError reviewRescan reviewConfirm hdrTunnelDot hdrScannerDot hdrAgent ovReview ovReviewCount ovReviewThumbs ovReviewConfirmAll ovReviewOpen ovReviewEmpty recentSlides reviewQueueCount reviewConfirmAll reviewList reviewEmpty; do grep -q "id=\"$id\"" index.html || echo "MISSING $id"; done; echo checked
```
Expected: only `checked`.

- [ ] **Step 3: Commit**

```bash
git add api/src/dashboard/index.html
git commit -m "feat(dashboard): new markup — topbar, rail, overview with review strip and service blocks"
```

---

### Task 4: `dashboard.css`

**Files:**
- Create: `api/src/dashboard/dashboard.css`
- Delete: `api/src/dashboard/style.css`

**Interfaces:**
- Consumes tokens from Task 1 and class names from Task 3 and Task 5: `.app .topbar .brand .rail .tab-btn .rail-badge .content .tab-panel .review-strip .review-thumbs .thumb .blocks .service .block[data-state] .section-head .rows .row .row-id .row-file .chip .btn .btn-primario .btn-pequeno .btn-icone .btn-link .btn-perigo .segment .filter-btn .field .form .dados .modal-veu .modal .modal-head .modal-body .modal-colunas .foto .foto-quadro .foto-vazia .review-cards .review-card .empty .dot .hidden .t-grande .t-pagina .t-secao .t-id .t-2 .t-3 .tnum`, plus the `.pipeline-*`, `.failure-*`, `.activity-*` class names that `app.js` already generates (unchanged).

- [ ] **Step 1: Write `dashboard.css`**

Create `api/src/dashboard/dashboard.css`:

```css
/* SuperNavi Edge dashboard. Components and layout only; values come from tokens.css.
   One class per selector, no ids, no !important. */

/* ---- Base ---- */
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  font-family: var(--sn-fonte);
  font-size: var(--sn-t-corpo);
  line-height: 1.5;
  color: var(--sn-texto);
  background: var(--sn-fundo);
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3, p, dl, dd, dt { margin: 0; }
button, input, select { font: inherit; color: inherit; }
button { cursor: pointer; }
img { max-width: 100%; display: block; }
svg { display: block; }
.hidden { display: none; }
.spacer { flex: 1; }

:focus-visible { outline: 2px solid var(--sn-azul); outline-offset: 2px; border-radius: var(--sn-raio-controle); }

/* ---- Type ---- */
.t-grande { font-size: var(--sn-t-grande); line-height: 1.1; font-weight: 700; font-variant-numeric: tabular-nums; }
.t-pagina { font-size: var(--sn-t-pagina); line-height: 1.25; font-weight: 700; }
.t-secao { font-size: var(--sn-t-secao); line-height: 1.3; font-weight: 700; }
.t-id { font-size: var(--sn-t-id); line-height: 1.4; font-weight: 700; font-variant-numeric: tabular-nums; }
.t-2 { color: var(--sn-texto-2); }
.t-3 { color: var(--sn-texto-3); font-size: var(--sn-t-lista); }
.tnum { font-variant-numeric: tabular-nums; }

/* ---- Layout ---- */
.app {
  display: grid;
  grid-template-columns: var(--sn-trilho) 1fr;
  grid-template-rows: var(--sn-cabecalho) 1fr;
  min-height: 100vh;
}
.topbar {
  grid-column: 1 / -1;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 var(--sn-esp-5);
  background: var(--sn-painel);
  border-bottom: 1px solid var(--sn-borda);
}
.brand { display: flex; align-items: center; gap: var(--sn-esp-3); }
.brand-name { font-size: var(--sn-t-id); font-weight: 700; }
.brand-agent { color: var(--sn-texto-2); font-size: var(--sn-t-lista); }
.topbar-health { display: flex; gap: var(--sn-esp-5); font-size: var(--sn-t-lista); color: var(--sn-texto-2); }
.health { display: inline-flex; align-items: center; gap: var(--sn-esp-2); }

.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--sn-prata); opacity: .5; transition: background var(--sn-mov), opacity var(--sn-mov); }
.dot.ok { background: var(--sn-ok); opacity: 1; }
.dot.atencao { background: var(--sn-atencao); opacity: 1; }
.dot.falha { background: var(--sn-falha); opacity: 1; }
.dot.azul { background: var(--sn-azul); opacity: 1; }

.rail {
  display: flex; flex-direction: column; gap: 2px;
  padding: var(--sn-esp-3) var(--sn-esp-2);
  background: var(--sn-painel);
  border-right: 1px solid var(--sn-borda);
}
.tab-btn {
  position: relative;
  display: flex; align-items: center; gap: var(--sn-esp-3);
  width: 100%; padding: 10px var(--sn-esp-3);
  border: 0; border-radius: var(--sn-raio-controle);
  background: transparent; color: var(--sn-texto-2);
  font-size: var(--sn-t-lista); font-weight: 500; text-align: left;
  transition: background var(--sn-mov), color var(--sn-mov);
}
.tab-btn svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; flex: none; }
.tab-btn:hover { background: var(--sn-realce); color: var(--sn-texto); }
.tab-btn.active { background: var(--sn-cartao); color: var(--sn-texto); }
.tab-btn.active::before { content: ""; position: absolute; left: -8px; top: 8px; bottom: 8px; width: 3px; border-radius: 2px; background: var(--sn-azul); }
.rail-badge {
  margin-left: auto; min-width: 22px; height: 22px; padding: 0 7px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 11px; background: var(--sn-atencao); color: var(--sn-fundo);
  font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums;
}
.rail-badge-falha { background: var(--sn-falha); }

.content { padding: var(--sn-esp-5); max-width: var(--sn-conteudo-max); width: 100%; }
.tab-panel { display: none; }
.tab-panel.active { display: block; }
.section-head { display: flex; align-items: center; gap: var(--sn-esp-4); margin: var(--sn-esp-6) 0 var(--sn-esp-3); }
.section-head:first-child { margin-top: 0; }
.section-head > .btn:last-child { margin-left: auto; }
.section-head .t-2 { margin-left: var(--sn-esp-1); }
.services-head { display: flex; align-items: center; justify-content: space-between; margin: var(--sn-esp-6) 0 var(--sn-esp-3); }
.maintenance { display: flex; align-items: center; gap: var(--sn-esp-2); }
.maint-status:empty { display: none; }

/* ---- Buttons ---- */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--sn-esp-2);
  height: 36px; padding: 0 var(--sn-esp-4);
  border: 1px solid var(--sn-borda); border-radius: var(--sn-raio-controle);
  background: transparent; color: var(--sn-texto);
  font-size: var(--sn-t-corpo); font-weight: 500; white-space: nowrap;
  transition: background var(--sn-mov), border-color var(--sn-mov);
}
.btn:hover { background: var(--sn-realce); }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.btn-primario { background: var(--sn-azul); border-color: var(--sn-azul); color: var(--sn-fundo); }
.btn-primario:hover { background: #4a9edb; }
.btn-perigo { border-color: var(--sn-falha); color: var(--sn-falha); }
.btn-perigo:hover { background: var(--sn-falha-bg); }
.btn-pequeno { height: 30px; padding: 0 var(--sn-esp-3); font-size: var(--sn-t-lista); }
.btn-icone { width: 36px; padding: 0; font-size: 20px; line-height: 1; }
.btn-icone svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.5; }
.btn-link { border: 0; height: auto; padding: 0; color: var(--sn-azul); font-weight: 500; }
.btn-link:hover { background: transparent; text-decoration: underline; }

/* ---- Chips ---- */
.chip {
  display: inline-flex; align-items: center; height: 22px; padding: 0 var(--sn-esp-2);
  border-radius: var(--sn-raio-controle); font-size: var(--sn-t-lista); font-weight: 500; white-space: nowrap;
  background: var(--sn-realce); color: var(--sn-texto-2);
}
.chip-ok { background: var(--sn-ok-bg); color: var(--sn-ok); }
.chip-azul { background: var(--sn-azul-bg); color: var(--sn-azul); }
.chip-atencao { background: var(--sn-atencao-bg); color: var(--sn-atencao); }
.chip-falha { background: var(--sn-falha-bg); color: var(--sn-falha); }

/* ---- Segmented filters ---- */
.segment { display: inline-flex; padding: 3px; border: 1px solid var(--sn-borda); border-radius: var(--sn-raio-controle); background: var(--sn-painel); margin-bottom: var(--sn-esp-4); }
.segment button { height: 28px; padding: 0 var(--sn-esp-3); border: 0; border-radius: 4px; background: transparent; color: var(--sn-texto-2); font-size: var(--sn-t-lista); font-weight: 500; }
.segment button.active { background: var(--sn-cartao); color: var(--sn-texto); }
.segment-pequeno { margin-bottom: var(--sn-esp-3); }

/* ---- Review strip (overview) ---- */
.review-strip { padding: var(--sn-esp-5); border: 1px solid var(--sn-borda); border-radius: var(--sn-raio-cartao); background: var(--sn-painel); }
.review-strip-head { display: flex; align-items: center; gap: var(--sn-esp-4); }
.review-strip-head .t-grande { color: var(--sn-atencao); }
.review-strip-actions { margin-left: auto; display: flex; gap: var(--sn-esp-2); }
.review-thumbs { display: flex; gap: var(--sn-esp-3); margin-top: var(--sn-esp-4); }
.review-thumbs:empty { display: none; }
.thumb {
  display: flex; flex-direction: column; gap: var(--sn-esp-1);
  width: 132px; padding: var(--sn-esp-2); border: 1px solid var(--sn-borda); border-radius: var(--sn-raio-cartao);
  background: var(--sn-cartao); color: inherit; text-align: left;
}
.thumb:hover { border-color: var(--sn-azul); }
.thumb img { width: 100%; height: 64px; object-fit: cover; border-radius: 4px; background: var(--sn-fundo); }
.thumb-name { font-size: var(--sn-t-lista); font-weight: 700; font-variant-numeric: tabular-nums; }
.thumb-more { justify-content: center; align-items: center; font-weight: 700; color: var(--sn-texto-2); }
.review-strip-empty { margin-top: var(--sn-esp-3); }
.review-strip.vazio .review-strip-head .t-grande, .review-strip.vazio .review-strip-actions { display: none; }
.review-strip.vazio { padding: var(--sn-esp-4) var(--sn-esp-5); }

/* ---- Service blocks ---- */
.blocks { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: var(--sn-esp-4); }
.service { display: flex; align-items: center; gap: var(--sn-esp-3); min-width: 0; }
.service-text { display: flex; flex-direction: column; min-width: 0; }
.service-name { font-weight: 500; }
.block-detail { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.block {
  position: relative; flex: none; width: 44px; height: 44px;
  border-radius: var(--sn-raio-bloco);
  background: transparent; border: 2px solid rgba(184, 184, 192, 0.4);
  transition: background var(--sn-mov), border-color var(--sn-mov);
}
.block::after {
  content: ""; position: absolute; right: -2px; top: 50%; width: 12px; height: 14px;
  transform: translateY(-50%); background: var(--sn-fundo); border-radius: 3px 0 0 3px;
}
.block[data-state="ok"] { background: var(--sn-ok); border-color: var(--sn-ok); }
.block[data-state="azul"] { background: var(--sn-azul); border-color: var(--sn-azul); }
.block[data-state="atencao"] { background: transparent; border-color: var(--sn-atencao); }
.block[data-state="falha"] { background: var(--sn-falha); border-color: var(--sn-falha); }

/* ---- Rows (slides, failures, activity) ---- */
.rows { display: flex; flex-direction: column; }
.row {
  display: grid; grid-template-columns: 180px 1fr auto auto auto; align-items: center; gap: var(--sn-esp-4);
  min-height: 48px; padding: var(--sn-esp-2) var(--sn-esp-3);
  border-bottom: 1px solid var(--sn-borda);
}
.row:hover { background: var(--sn-cartao); }
.row-id { font-size: var(--sn-t-id); font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
.row-id.sem-nome { color: var(--sn-atencao); font-weight: 500; }
.row-file { color: var(--sn-texto-2); font-size: var(--sn-t-lista); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row-time { color: var(--sn-texto-3); font-size: var(--sn-t-lista); font-variant-numeric: tabular-nums; white-space: nowrap; }
.row-actions { display: flex; gap: var(--sn-esp-2); }
.row-actions .btn { height: 30px; padding: 0 var(--sn-esp-3); font-size: var(--sn-t-lista); }
.row-erro { grid-column: 2 / -1; color: var(--sn-falha); font-size: var(--sn-t-lista); }
.empty { padding: var(--sn-esp-6) var(--sn-esp-3); color: var(--sn-texto-2); }

/* Failures rows keep the app.js class names */
.failure-card { display: grid; grid-template-columns: 1fr auto auto; gap: var(--sn-esp-2) var(--sn-esp-4); padding: var(--sn-esp-3); border-bottom: 1px solid var(--sn-borda); }
.failure-card-header { display: contents; }
.failure-filename { font-size: var(--sn-t-id); font-weight: 700; font-variant-numeric: tabular-nums; }
.failure-stage-badge { justify-self: start; }
.failure-time { color: var(--sn-texto-3); font-size: var(--sn-t-lista); }
.failure-reason { grid-column: 1 / -1; color: var(--sn-texto); }
.failure-suggestion { grid-column: 1 / -1; color: var(--sn-texto-2); font-size: var(--sn-t-lista); }
.failure-suggestion-label { color: var(--sn-texto-3); }
.failure-actions { grid-column: 1 / -1; display: flex; gap: var(--sn-esp-2); }
.failure-message { grid-column: 1 / -1; color: var(--sn-texto-3); font-size: var(--sn-t-lista); word-break: break-all; }
.severity-error .failure-stage-badge, .failure-stage-badge { display: inline-flex; align-items: center; height: 22px; padding: 0 var(--sn-esp-2); border-radius: var(--sn-raio-controle); font-size: var(--sn-t-lista); font-weight: 500; background: var(--sn-falha-bg); color: var(--sn-falha); }
.severity-warn .failure-stage-badge { background: var(--sn-atencao-bg); color: var(--sn-atencao); }

.activity-item { display: grid; grid-template-columns: 8px 1fr auto; align-items: center; gap: var(--sn-esp-3); padding: var(--sn-esp-2) var(--sn-esp-3); border-bottom: 1px solid var(--sn-borda); }
.activity-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--sn-prata); }
.activity-dot.success { background: var(--sn-ok); }
.activity-dot.error { background: var(--sn-falha); }
.activity-dot.info { background: var(--sn-azul); }
.activity-dot.warning { background: var(--sn-atencao); }
.activity-message { font-size: var(--sn-t-lista); }
.activity-time { color: var(--sn-texto-3); font-size: var(--sn-t-lista); font-variant-numeric: tabular-nums; }

/* ---- Review cards (Revisão) ---- */
.review-cards { display: flex; flex-direction: column; gap: var(--sn-esp-3); margin-top: var(--sn-esp-4); }
.review-card {
  display: grid; grid-template-columns: 160px 1fr; gap: var(--sn-esp-4);
  padding: var(--sn-esp-4); border: 1px solid var(--sn-borda); border-radius: var(--sn-raio-cartao); background: var(--sn-cartao);
}
.review-card img { width: 160px; height: 110px; object-fit: cover; border-radius: var(--sn-raio-controle); background: var(--sn-fundo); }
.review-card .field { margin: 0; }
.review-card-file { color: var(--sn-texto-2); font-size: var(--sn-t-lista); }
.review-card-actions { display: flex; gap: var(--sn-esp-2); margin-top: var(--sn-esp-3); }

/* ---- Forms ---- */
.form { max-width: 560px; }
.form .t-secao { margin: var(--sn-esp-5) 0 var(--sn-esp-3); }
.form .t-secao:first-child { margin-top: 0; }
.field { display: flex; flex-direction: column; gap: var(--sn-esp-1); margin-bottom: var(--sn-esp-4); }
.field label { font-weight: 500; }
.field small { color: var(--sn-texto-3); font-size: var(--sn-t-lista); }
.field small.erro { color: var(--sn-falha); }
.field-row { display: flex; gap: var(--sn-esp-2); }
.field-row input { flex: 1; }
.field input[type="text"], .field input[type="password"], .field select {
  height: 36px; padding: 0 var(--sn-esp-3);
  border: 1px solid var(--sn-borda); border-radius: var(--sn-raio-controle);
  background: var(--sn-fundo); color: var(--sn-texto);
}
.field input:focus, .field select:focus { outline: 2px solid var(--sn-azul); outline-offset: 0; border-color: var(--sn-azul); }
.field input.invalido { border-color: var(--sn-falha); }
.field input[type="range"] { accent-color: var(--sn-azul); }
.form-actions { display: flex; align-items: center; gap: var(--sn-esp-3); margin-top: var(--sn-esp-4); }
.edge-info { display: flex; align-items: center; gap: var(--sn-esp-2); padding: var(--sn-esp-3); border: 1px solid var(--sn-borda); border-radius: var(--sn-raio-controle); margin-bottom: var(--sn-esp-4); }
.dados { display: grid; grid-template-columns: auto 1fr; gap: var(--sn-esp-1) var(--sn-esp-4); margin-bottom: var(--sn-esp-4); font-size: var(--sn-t-lista); }
.dados dt { color: var(--sn-texto-3); }
.dados dd { font-variant-numeric: tabular-nums; word-break: break-all; }

/* ---- Modals ---- */
.modal-veu { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; background: var(--sn-veu); z-index: 50; padding: var(--sn-esp-5); }
.modal-veu.visible, .modal-veu.aberto { display: flex; }
.modal { width: 100%; max-height: 90vh; overflow: auto; border: 1px solid var(--sn-borda); border-radius: var(--sn-raio-cartao); background: var(--sn-cartao); box-shadow: var(--sn-sombra); }
.modal-timeline { max-width: 640px; }
.modal-renomear, .modal-revisao { max-width: 720px; }
.modal-head { display: flex; align-items: center; gap: var(--sn-esp-4); padding: var(--sn-esp-4) var(--sn-esp-5); border-bottom: 1px solid var(--sn-borda); }
.modal-head .btn-icone:last-child { margin-left: auto; }
.modal-nav { display: flex; align-items: center; gap: var(--sn-esp-2); }
.modal-body { padding: var(--sn-esp-5); }
.modal-colunas { display: grid; grid-template-columns: 300px 1fr; gap: var(--sn-esp-5); }
.foto-quadro { position: relative; min-height: 200px; border-radius: var(--sn-raio-controle); background: var(--sn-fundo); overflow: hidden; }
.foto-quadro img { width: 100%; }
.foto-vazia { padding: var(--sn-esp-6); text-align: center; color: var(--sn-texto-3); }

/* Timeline (class names come from app.js renderPipelineTimeline, unchanged) */
.pipeline-loading, .pipeline-empty { color: var(--sn-texto-2); }
.pipeline-error { color: var(--sn-falha); }
.pipeline-advice { padding: var(--sn-esp-3); border-radius: var(--sn-raio-controle); background: var(--sn-atencao-bg); margin-bottom: var(--sn-esp-4); font-size: var(--sn-t-lista); }
.pipeline-advice.severity-error { background: var(--sn-falha-bg); }
.pipeline-advice-title { font-weight: 700; }
.pipeline-advice-suggestion { color: var(--sn-texto-2); }
.pipeline-section-title { font-size: var(--sn-t-corpo); font-weight: 700; margin: var(--sn-esp-4) 0 var(--sn-esp-2); }
.pipeline-timeline, .pipeline-jobs { display: flex; flex-direction: column; }
.pipeline-event { display: grid; grid-template-columns: 8px 1fr auto; gap: var(--sn-esp-3); align-items: start; padding: var(--sn-esp-2) 0; border-bottom: 1px solid var(--sn-borda); font-size: var(--sn-t-lista); }
.pipeline-event-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; background: var(--sn-prata); }
.pipeline-event.level-info .pipeline-event-dot { background: var(--sn-azul); }
.pipeline-event.level-warn .pipeline-event-dot { background: var(--sn-atencao); }
.pipeline-event.level-error .pipeline-event-dot { background: var(--sn-falha); }
.pipeline-event-stage { color: var(--sn-texto-2); margin-right: var(--sn-esp-2); }
.pipeline-event-details { color: var(--sn-texto-3); white-space: pre-wrap; word-break: break-all; }
.pipeline-event-time, .pipeline-job-time { color: var(--sn-texto-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
.pipeline-job-row { display: grid; grid-template-columns: 1fr auto auto; gap: var(--sn-esp-3); padding: var(--sn-esp-2) 0; border-bottom: 1px solid var(--sn-borda); font-size: var(--sn-t-lista); }
.pipeline-job-status { color: var(--sn-texto-2); }
.pipeline-job-row.status-failed .pipeline-job-status { color: var(--sn-falha); }
.pipeline-job-row.status-done .pipeline-job-status { color: var(--sn-ok); }
.pipeline-job-error, .pipeline-sync-reason { grid-column: 1 / -1; color: var(--sn-falha); }
.pipeline-sync-failure { padding: var(--sn-esp-2) 0; border-bottom: 1px solid var(--sn-borda); font-size: var(--sn-t-lista); }

/* Reprocess button states toggled by app.js */
.btn-reprocess-sent { border-color: var(--sn-ok); color: var(--sn-ok); }
.btn-reprocess-error { border-color: var(--sn-falha); color: var(--sn-falha); }

/* ---- Responsive ---- */
@media (max-width: 1100px) {
  .app { grid-template-columns: var(--sn-trilho-min) 1fr; }
  .tab-btn span, .rail-badge { display: none; }
  .tab-btn { justify-content: center; padding: 10px 0; }
  .blocks { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
@media (max-width: 900px) {
  .row { grid-template-columns: 1fr auto auto auto; }
  .row-file { display: none; }
  .modal-colunas { grid-template-columns: 1fr; }
}
```

Note on `.modal-veu.visible`: `app.js` shows `#pipelineModal` and `#ocrModal` by adding the class `visible` (see `classList.add('visible')`) and shows `#reviewModal` by removing `hidden`. Both paths are covered: `.hidden` is `display:none`, and `.modal-veu` without `.hidden` and without `.visible` is also `display:none`, so `#reviewModal` needs the `aberto` class too. Task 5 Step 6 adds it.

- [ ] **Step 2: Delete `style.css`**

```bash
git rm -q api/src/dashboard/style.css
```

- [ ] **Step 3: Lint the CSS for balanced braces and token usage**

Run:
```bash
node -e "
const s=require('fs').readFileSync('api/src/dashboard/dashboard.css','utf8');
const open=(s.match(/{/g)||[]).length, close=(s.match(/}/g)||[]).length;
if(open!==close) throw new Error('braces '+open+' vs '+close);
const hex=[...s.matchAll(/#[0-9a-fA-F]{6}\b/g)].map(m=>m[0]);
console.log('braces ok; literal hex colors:', hex);
"
```
Expected: `braces ok; literal hex colors: [ '#4a9edb' ]` (the primary hover is the only literal).

- [ ] **Step 4: Commit**

```bash
git add -A api/src/dashboard
git commit -m "feat(dashboard): dashboard.css on SuperNavi tokens; drop style.css"
```

---

### Task 5: `app.js` changes

**Files:**
- Modify: `api/src/dashboard/app.js`

**Interfaces:**
- Consumes DOM ids/classes from Task 3.
- Produces: `activateTab(tabId)`, `renderBlocks(data)`, `renderReviewStrip(data)`, `renderReviewList(data)`, `refreshPending()`, `confirmAllPending(statusEl)`.

- [ ] **Step 1: Tab router with `activateTab()` and rail links**

Replace `initTabs()` (lines 29–50) with:

```js
  function activateTab(tabId) {
    $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabId));
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + tabId));
    if (tabId === 'slides') fetchSlides();
    if (tabId === 'settings') loadSettings();
    if (tabId === 'failures') fetchFailures();
    if (tabId === 'review') refreshPending();
  }

  function initTabs() {
    $('#tabBar').addEventListener('click', (e) => {
      const btn = e.target.closest('.tab-btn');
      if (btn) activateTab(btn.dataset.tab);
    });
    document.addEventListener('click', (e) => {
      const goto = e.target.closest('[data-goto]');
      if (goto) activateTab(goto.dataset.goto);
    });
  }
```

- [ ] **Step 2: Replace `renderDashboard()` with block rendering**

Replace the whole `renderDashboard(data)` function (lines 133–210) with:

```js
  function setBlock(id, state, detail) {
    const wrap = $('#' + id);
    if (!wrap) return;
    const block = wrap.querySelector('.block');
    if (block) block.dataset.state = state;
    const det = wrap.querySelector('.block-detail');
    if (det) det.textContent = detail;
  }

  function setHealthDot(dotSel, textSel, state, label) {
    const dot = $(dotSel);
    if (dot) dot.className = 'dot ' + state;
    setText(textSel, label);
  }

  function renderBlocks(data) {
    if (data.tunnel) {
      const on = !!data.tunnel.connected;
      setBlock('blk-tunnel', on ? 'ok' : 'falha', on ? 'Agente ' + (data.tunnel.agentId || '--') : 'Sem conexão com a nuvem');
      setHealthDot('#hdrTunnelDot', '#hdrTunnelText', on ? 'ok' : 'falha', on ? 'Túnel' : 'Túnel caído');
      setText('#hdrAgent', 'Agente ' + (data.tunnel.agentId || '--'));
    }
    if (data.scanner) {
      const s = data.scanner;
      let state = 'unknown'; let detail = '--'; let dot = 'unknown'; let label = 'Scanner';
      if (!s.enabled) { state = 'atencao'; detail = 'Desligado'; dot = 'atencao'; }
      else if (s.state === 'running') { state = 'ok'; detail = (data.config?.scannerType || 'scanner') + ' · ' + (s.totalDiscovered ?? 0) + ' lâminas'; dot = 'ok'; }
      else if (s.state === 'error') { state = 'falha'; detail = s.error || 'Erro'; dot = 'falha'; label = 'Scanner com erro'; }
      else { state = 'atencao'; detail = s.state || 'Parado'; dot = 'atencao'; }
      setBlock('blk-scanner', state, detail);
      setHealthDot('#hdrScannerDot', '#hdrScannerText', dot, label);
    }
    if (data.watcher) {
      const w = data.watcher;
      const map = { running: ['ok', w.ingestDir || 'Monitorando'], needs_config: ['atencao', 'Precisa configurar'], dir_inaccessible: ['falha', 'Pasta inacessível'] };
      const [state, detail] = map[w.state] || ['atencao', 'Parada'];
      setBlock('blk-watcher', state, detail);
    }
    if (data.slides) {
      setBlock('blk-db', 'ok', data.slides.total + ' lâminas');
      const failed = data.slides.failed || 0;
      setBlock('blk-disk', failed > 0 ? 'atencao' : 'ok', data.slides.ready + ' prontas' + (failed > 0 ? ' · ' + failed + ' com erro' : ''));
    }
    if (data.jobs) {
      const total = (data.jobs.pending || 0) + (data.jobs.running || 0);
      setBlock('blk-queue', total > 0 ? 'azul' : 'ok', total > 0 ? data.jobs.pending + ' na fila · ' + data.jobs.running + ' rodando' : 'Vazia');
      const active = data.jobs.active || [];
      const job = active[0];
      setBlock('blk-processor', job ? 'azul' : 'ok', job ? (job.type + ' · ' + (job.original_filename || job.slide_id || '').slice(0, 24)) : 'Ocioso');
    }
    const totalIssues = ((data.slides && data.slides.withProblems) || 0) + ((data.sync && data.sync.stuckCount) || 0);
    const badge = $('#failuresBadge');
    if (badge) { badge.textContent = String(totalIssues); badge.style.display = totalIssues > 0 ? '' : 'none'; }
  }

  function renderDashboard(data) {
    renderBlocks(data);
  }
```

- [ ] **Step 3: Slides as rows, plus recent slides on the overview**

In `renderSlides()` (line 232) find the line that appends cards (`list.appendChild(buildSlideCard(slide))` or equivalent) and, right after the loop, add the recent list:

```js
    const recent = $('#recentSlides');
    if (recent) {
      clearChildren(recent);
      slidesData.slice(0, 10).forEach((s) => recent.appendChild(buildSlideCard(s)));
    }
```

Replace the body of `buildSlideCard(slide)` (lines 265–423) with the row version. Keep the function name and the `slide-card` class (other code queries `.slide-card`):

```js
  function buildSlideCard(slide) {
    const row = el('div', { className: 'row slide-card' });
    row.setAttribute('data-status', slide.status || 'queued');
    row.setAttribute('data-slide-id', slide.slideId);

    const pendingReview = slide.reviewStatus === 'pending';
    const named = !!slide.externalSlideLabel;
    const idCell = el('button', { className: 'row-id btn-link' + (named ? '' : ' sem-nome') });
    idCell.textContent = named ? slide.externalSlideLabel : 'Sem identificação';
    idCell.title = pendingReview ? 'Leitura do OCR, aguardando confirmação' : 'Renomear';
    idCell.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pendingReview || !named) {
        document.dispatchEvent(new CustomEvent('open-review-modal', { detail: { slideId: slide.slideId } }));
      } else {
        openOcrModal(slide);
      }
    });
    row.appendChild(idCell);

    const file = el('div', { className: 'row-file' });
    file.textContent = slide.originalFilename || '--';
    file.title = (slide.width && slide.height) ? slide.width + ' × ' + slide.height + (slide.appMag ? ' · ' + slide.appMag + '×' : '') : '';
    row.appendChild(file);

    const chipClass = { ready: 'chip-ok', processing: 'chip-azul', queued: 'chip-atencao', failed: 'chip-falha' }[slide.status] || '';
    const chip = el('span', { className: 'chip badge badge-' + (slide.status || 'queued') + ' ' + chipClass });
    chip.textContent = pendingReview && slide.status === 'ready' ? 'pronta · confirmar nome' : statusLabel(slide.status);
    row.appendChild(chip);

    const time = el('span', { className: 'row-time' });
    time.textContent = relativeTime(slide.createdAt);
    row.appendChild(time);

    const actions = el('div', { className: 'row-actions' });
    const tl = el('button', { className: 'btn' });
    tl.textContent = 'Timeline';
    tl.addEventListener('click', (e) => { e.stopPropagation(); openPipelineModal(slide.slideId, slide.originalFilename); });
    actions.appendChild(tl);
    if (slide.status === 'failed' || slide.latestError) {
      const btn = el('button', { className: 'btn btn-reprocess' });
      btn.textContent = 'Reprocessar';
      btn.addEventListener('click', (e) => { e.stopPropagation(); reprocessSlide(slide.slideId, btn); });
      actions.appendChild(btn);
    }
    const del = el('button', { className: 'btn btn-perigo btn-delete' });
    del.textContent = 'Excluir';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteSlide(slide.slideId, slide.originalFilename, row); });
    actions.appendChild(del);
    row.appendChild(actions);

    if (slide.latestError) {
      const err = el('div', { className: 'row-erro' });
      err.textContent = (slide.latestErrorStage ? slide.latestErrorStage + ': ' : '') + slide.latestError;
      row.appendChild(err);
    }
    return row;
  }
```

Then update `statusLabel()` (line 424) so the labels are sentence case: `ready: 'pronta'`, `processing: 'processando'`, `queued: 'na fila'`, `failed: 'erro'`, default `'--'`.

In `reprocessSlide()` and `deleteSlide()` nothing changes (they receive the button and the row). Check they do not rely on `.slide-thumb`: run `grep -n "slide-thumb\|slide-info\|slide-meta" app.js` and delete any leftover references (Expected after the rewrite: none).

- [ ] **Step 4: Failure cards use `.btn` classes and the spec's empty copy**

In `buildFailureCard()` and `buildStuckSyncCard()`, every `el('button', { className: 'btn-reprocess' })` becomes `el('button', { className: 'btn btn-reprocess' })`, `'btn-delete'` becomes `'btn btn-perigo btn-delete'`, and any `'btn-timeline'` or similar becomes `'btn'`. Run `grep -n "className: 'btn-" app.js` to find them all; each must start with `'btn '`.

In `renderFailures()`, the subtitle text becomes: `n === 0 ? 'Tudo em ordem' : n + (n === 1 ? ' lâmina com falha' : ' lâminas com falha')` where `n` is the failures count already computed there.

- [ ] **Step 5: Replace the pending popover block with the review strip and panel**

Delete the block that starts at the comment `// === Review queue: notification panel` (line ~1766) and ends right before `// === Review queue: review modal` (the code that references `pendingPanel`, `pendingPanelList`, `pendingPanelCount`, `pendingPanelClose`, `pendingPanelOpenAll`, `pendingConfirmAll`, `buildPendingPanelItem`, `renderPendingPanel`, the `open-pending-panel` listener, the outside-click and Escape handlers). Keep `updatePendingBadge()` and the initial `fetch('/v1/pending-slides')`. Also delete the two `pendingBadge.addEventListener(...)` calls that dispatch `open-pending-panel` (the rail button already switches tabs through `initTabs`).

Insert in their place:

```js
  // === Review queue: overview strip + Revisão panel ============================
  let pendingData = { total: 0, slides: [] };

  function labelUrl(id) { return '/v1/pending-slides/' + encodeURIComponent(id) + '/image?which=label'; }

  function renderReviewStrip() {
    const strip = $('#ovReview');
    if (!strip) return;
    const { total, slides } = pendingData;
    strip.classList.toggle('vazio', total === 0);
    setText('#ovReviewCount', String(total));
    $('#ovReviewEmpty').classList.toggle('hidden', total !== 0);
    const thumbs = $('#ovReviewThumbs');
    clearChildren(thumbs);
    slides.slice(0, 5).forEach((s) => {
      const b = el('button', { className: 'thumb', type: 'button' });
      const img = el('img', { src: labelUrl(s.id), alt: '' });
      b.appendChild(img);
      const name = el('span', { className: 'thumb-name' });
      name.textContent = s.proposed_name || 'Sem leitura';
      b.appendChild(name);
      b.addEventListener('click', () => document.dispatchEvent(new CustomEvent('open-review-modal', { detail: { slideId: s.id } })));
      thumbs.appendChild(b);
    });
    if (total > 5) {
      const more = el('button', { className: 'thumb thumb-more', type: 'button' });
      more.textContent = '+' + (total - 5);
      more.addEventListener('click', () => activateTab('review'));
      thumbs.appendChild(more);
    }
  }

  function buildReviewCard(s) {
    const card = el('div', { className: 'review-card' });
    card.dataset.slideId = s.id;
    const img = el('img', { src: labelUrl(s.id), alt: 'Foto da etiqueta' });
    card.appendChild(img);

    const body = el('div');
    const field = el('div', { className: 'field' });
    const label = el('label'); label.textContent = 'Nome lido pelo OCR';
    const input = el('input', { type: 'text', className: 't-id', autocomplete: 'off', spellcheck: 'false' });
    input.value = s.proposed_name || '';
    input.placeholder = 'AP26000388A1, RE26000003 ou 26-388A';
    const file = el('small', { className: 'review-card-file' }); file.textContent = s.original_filename || '';
    const err = el('small', { className: 'erro hidden' });
    field.appendChild(label); field.appendChild(input); field.appendChild(file); field.appendChild(err);
    body.appendChild(field);

    const actions = el('div', { className: 'review-card-actions' });
    const confirm = el('button', { className: 'btn btn-primario', type: 'button' }); confirm.textContent = 'Confirmar';
    const open = el('button', { className: 'btn', type: 'button' }); open.textContent = 'Ver lâmina inteira';
    const rescan = el('button', { className: 'btn', type: 'button' }); rescan.textContent = 'Rescanear';
    actions.appendChild(confirm); actions.appendChild(open); actions.appendChild(rescan);
    body.appendChild(actions);
    card.appendChild(body);

    confirm.addEventListener('click', async () => {
      const parsed = parseOcrInput(input.value);
      if (!parsed) {
        input.classList.add('invalido'); err.textContent = 'Formato inválido. Use o nome completo (AP26000388A1, C26000588A, RE26000003) ou abreviado com 3 dígitos ou mais (26-388A).'; err.classList.remove('hidden');
        return;
      }
      confirm.disabled = true;
      try {
        const r = await fetch('/v1/pending-slides/' + encodeURIComponent(s.id) + '/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: parsed.fullName }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || d.message || r.statusText);
        card.remove();
        await refreshPending();
        fetchSlides();
      } catch (e) {
        err.textContent = e.message; err.classList.remove('hidden'); confirm.disabled = false;
      }
    });
    input.addEventListener('input', () => { input.classList.remove('invalido'); err.classList.add('hidden'); });
    open.addEventListener('click', () => document.dispatchEvent(new CustomEvent('open-review-modal', { detail: { slideId: s.id } })));
    rescan.addEventListener('click', async () => {
      rescan.disabled = true;
      try {
        const r = await fetch('/v1/pending-slides/' + encodeURIComponent(s.id) + '/rescan', { method: 'POST' });
        if (!r.ok) throw new Error(r.statusText);
        card.remove(); await refreshPending();
      } catch (e) { err.textContent = 'Não foi possível marcar para rescanear: ' + e.message; err.classList.remove('hidden'); rescan.disabled = false; }
    });
    return card;
  }

  function renderReviewList() {
    const list = $('#reviewList');
    if (!list) return;
    const { total, slides } = pendingData;
    setText('#reviewQueueCount', total + (total === 1 ? ' aguardando' : ' aguardando'));
    $('#reviewEmpty').classList.toggle('hidden', total !== 0);
    clearChildren(list);
    slides.forEach((s) => list.appendChild(buildReviewCard(s)));
  }

  async function refreshPending() {
    try {
      const r = await fetch('/v1/pending-slides');
      if (!r.ok) throw new Error(r.statusText);
      const d = await r.json();
      pendingData = { total: d.total || 0, slides: d.slides || [] };
    } catch (e) {
      console.error('pending fetch error:', e);
    }
    updatePendingBadge(pendingData.total);
    renderReviewStrip();
    renderReviewList();
  }

  async function confirmAllPending(statusEl) {
    if (statusEl) statusEl.textContent = 'Confirmando...';
    try {
      const r = await fetch('/v1/pending-slides/confirm-all', { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || r.statusText);
      const n = d.confirmed || 0; // server returns { ok, confirmed, skipped, failed }
      if (statusEl) statusEl.textContent = n === 1 ? 'Leitura confirmada: 1 lâmina' : 'Leituras confirmadas: ' + n + ' lâminas';
    } catch (e) {
      if (statusEl) statusEl.textContent = 'Não foi possível confirmar: ' + e.message;
    }
    await refreshPending();
    fetchSlides();
  }

  ['#ovReviewConfirmAll', '#reviewConfirmAll'].forEach((sel) => {
    const b = $(sel);
    if (b) b.addEventListener('click', () => confirmAllPending($('#reviewQueueCount')));
  });
  const ovOpen = $('#ovReviewOpen');
  if (ovOpen) ovOpen.addEventListener('click', () => activateTab('review'));
  refreshPending();
```

Also make the review modal refresh the strip after a confirmation: in `loadNextOrClose()` (line ~1990) add `refreshPending();` as its first statement.

- [ ] **Step 6: Modal visibility classes**

`#reviewModal` is shown with `classList.remove('hidden')`. With the new CSS a `.modal-veu` is `display:none` unless it has `visible` or `aberto`. In `openReview()` replace `reviewModal.classList.remove('hidden')` with `reviewModal.classList.remove('hidden'); reviewModal.classList.add('aberto');` and in `closeReviewModal()` replace `reviewModal.classList.add('hidden')` with `reviewModal.classList.add('hidden'); reviewModal.classList.remove('aberto');`. `#pipelineModal` and `#ocrModal` already toggle `visible` (`overlay.classList.add('visible')` at line ~763 and the matching remove in `closeOcrModal()` / `closePipelineModal()`); nothing to change there.

- [ ] **Step 7: Timeline stays as is**

`renderPipelineTimeline()` keeps its `pipeline-*` class names; `dashboard.css` (Task 4) styles them. No change in this step; just confirm `grep -c "className: 'pipeline-" app.js` is greater than 0 so the CSS has something to style.

- [ ] **Step 8: Copy fixes**

- `eventToMessage()`: keep messages, but replace any ALL CAPS status words (`'READY'`, `'FAILED'`) with `'pronta'` / `'com erro'`.
- Maintenance status texts inside `wireMaintenanceAction()`: success text becomes `'Etiquetas publicadas: ' + queued + ' lâminas'` for labels and `'Previews republicados: ' + queued + ' lâminas'` for previews, where `queued` is `data.queued`; error text `'Não foi possível: ' + message`. Use the `url` argument to pick the noun (`url.includes('labels')`).
- `populateSettingsForm()` / `initSettingsForm()`: save status success `'Configuração salva'`, error `'Não foi possível salvar: ' + message`.

- [ ] **Step 9: Syntax check and route tests**

Run:
```bash
node --check api/src/dashboard/app.js && echo syntax-ok
grep -n "pendingPanel\|slide-thumb\|open-pending-panel" api/src/dashboard/app.js   # expected: no output
node --test --test-force-exit api/src/routes/*.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```
Expected: `syntax-ok`, no leftovers, route tests all pass.

- [ ] **Step 10: Commit**

```bash
git add api/src/dashboard/app.js
git commit -m "feat(dashboard): service blocks, review strip and Revisão panel, slide rows, sentence-case copy"
```

---

### Task 6: Visual verification with the mock

**Files:**
- Create: `docs/dashboard-review/` screenshots (not committed; keep in the session scratchpad)

- [ ] **Step 1: Start three mocks**

```bash
node scripts/dashboard-mock.js 8101 normal & node scripts/dashboard-mock.js 8102 falhas & node scripts/dashboard-mock.js 8103 vazio &
```

- [ ] **Step 2: Screenshot checklist (1366 × 768, Chrome)**

For each of `http://127.0.0.1:8101/`, `8102`, `8103`, capture and check against the spec:

- Visão geral: review strip first; count 17 in amber (8101), strip collapsed to one line (8103); seven blocks in one row, tunnel block red and header "Túnel caído" (8102); recent slides as rows with the identifier first.
- Lâminas: segment filters, rows, `RE26000003` row, error row with the red message line.
- Revisão: 17 cards, photo left, editable name, three buttons; empty copy on 8103.
- Falhas: three rows with stage chip, reason, suggestion, buttons (8102); empty copy on 8101.
- Atividade: empty copy.
- Configurações: one column, labels above fields, hints below.
- Modals: click a row "Timeline"; click a review card "Ver lâmina inteira".
- Resize to 1000 px: rail collapses to icons; blocks in two rows.
- Keyboard: Tab through the rail and buttons; the focus ring is visible.

Fix anything that deviates, re-run Step 2 for the affected screen, then commit with `git commit -am "fix(dashboard): visual review adjustments"`.

- [ ] **Step 3: Stop the mocks**

```bash
kill %1 %2 %3
```

---

### Task 7: Docs, version, PR

**Files:**
- Modify: `README.md` (dashboard section), `api/package.json`, `api/package-lock.json`, `processor/package.json`, `processor/package-lock.json`

- [ ] **Step 1: README**

In `README.md`, find the section that describes the dashboard (search `Dashboard` heading) and replace its body with:

```markdown
O dashboard (`api/src/dashboard/`) é HTML, CSS e JS estáticos servidos pela API.
Identidade visual: `tokens.css` (cores e tipografia derivadas do logo, fonte
Atkinson Hyperlegible Next hospedada em `fonts/`) e `dashboard.css` (componentes).
Spec: `docs/superpowers/specs/2026-09-06-edge-visual-identity-design.md` na raiz
do projeto.

Seções: Visão geral (fila de revisão, blocos de serviços, lâminas recentes),
Lâminas, Revisão, Falhas, Atividade, Configurações.

Para revisar a interface sem o stack: `node scripts/dashboard-mock.js 8099 normal`
(cenários `normal`, `falhas`, `vazio`) e abrir `http://127.0.0.1:8099/`.
```

- [ ] **Step 2: Copy the spec and plan into the edge repo**

The project root is not a git repository (each of `supernavi_edge`, `supernavi_cloud`, `supernavi_frontend`, `supernavi_extension` is its own). So the documents travel with the edge:

```bash
mkdir -p docs/superpowers/specs docs/superpowers/plans
cp ../docs/superpowers/specs/2026-09-06-edge-visual-identity-design.md docs/superpowers/specs/
cp ../docs/superpowers/plans/2026-09-06-edge-visual-identity.md docs/superpowers/plans/
```

- [ ] **Step 3: Version 0.4.0**

```bash
for f in api/package.json processor/package.json; do sed -i '0,/"version": "0.3.2"/s//"version": "0.4.0"/' $f; done
for f in api/package-lock.json processor/package-lock.json; do sed -i '0,/"version": "0.3.2"/s//"version": "0.4.0"/; 0,/"version": "0.3.2"/s//"version": "0.4.0"/' $f; done
grep -m1 '"version"' api/package.json processor/package.json
```
Expected: both `0.4.0`.

- [ ] **Step 4: Full test run**

```bash
node --test api/src/lib/*.test.js api/src/db/*.test.js api/src/services/*.test.js api/src/dashboard/*.test.js scripts/*.test.js processor/src/lib/*.test.js processor/src/*.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"
node --test --test-force-exit api/src/routes/*.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```
Expected: 0 fail in both.

- [ ] **Step 5: Commit, push, PR**

```bash
git add -A
git commit -m "chore(edge): 0.4.0 — dashboard on the SuperNavi visual identity"
git push -u origin feat/visual-identity
gh pr create --base main --head feat/visual-identity --title "feat(dashboard): SuperNavi visual identity (0.4.0)" --body "Rebuilds the edge dashboard on tokens derived from the logo (spec: docs/superpowers/specs/2026-09-06-edge-visual-identity-design.md). Review queue first, seven service blocks, slide rows, self-hosted Atkinson Hyperlegible Next, mock server for visual review. No API changes."
```

Deploy on the lab: `git pull && docker compose up -d --build api`, then `/v1/health` shows `0.4.0`.
