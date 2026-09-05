# Edge Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a local web dashboard to the SuperNavi Edge agent so lab technicians and admins can monitor connectivity, slide processing, and configure the system without terminal access.

**Architecture:** Single-page HTML/CSS/JS dashboard served by Fastify at route `/`. Uses SSE (`/v1/events`) for real-time updates. All data comes from existing API endpoints (`/v1/health`, `/v1/slides`, `/v1/admin/config`). No build step, no frontend framework.

**Tech Stack:** HTML5, CSS3, vanilla JavaScript, Fastify `@fastify/static` (already installed), SSE (already implemented).

**Security Note:** All dynamic content rendering MUST use safe DOM methods (textContent, createElement, setAttribute) instead of innerHTML to prevent XSS. No innerHTML with user/API data.

---

### Task 1: Serve dashboard static files from Fastify

**Files:**
- Modify: `api/src/server.js` (add second static plugin registration for dashboard)
- Create: `api/src/dashboard/index.html` (empty placeholder)

**Step 1: Create dashboard directory and placeholder**

Create `api/src/dashboard/index.html`:
```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>SuperNavi Edge</title>
</head>
<body>
  <h1>SuperNavi Edge Dashboard</h1>
  <p>Em construcao...</p>
</body>
</html>
```

**Step 2: Register second @fastify/static for dashboard**

In `api/src/server.js`, after the existing `fastifyStatic` registration (line 51-55), add:

```javascript
// Dashboard UI (served at root /)
await app.register(fastifyStatic, {
  root: join(__dirname, 'dashboard'),
  prefix: '/',
  decorateReply: false,
  wildcard: false
});
```

Note: `decorateReply: false` is required because a second static plugin cannot re-decorate. `wildcard: false` prevents catching all routes.

**Step 3: Verify it works**

Rebuild and test:
```bash
docker compose up -d --build api
curl -s http://localhost:3000/ | head -5
```
Expected: the HTML placeholder content.

Also verify existing API still works:
```bash
curl -s http://localhost:3000/v1/health | jq .status
```
Expected: `"ok"`

**Step 4: Commit**
```bash
git add api/src/server.js api/src/dashboard/index.html
git commit -m "feat(dashboard): serve static dashboard from Fastify root"
```

---

### Task 2: Dashboard API endpoint

The existing `/v1/health` is close but missing some data (slide counts, job queue stats, disk usage). Create a dedicated dashboard data endpoint.

**Files:**
- Create: `api/src/routes/dashboard.js`

**Step 1: Create the dashboard data route**

Create `api/src/routes/dashboard.js`:

```javascript
/**
 * Dashboard data route
 *
 * GET /v1/dashboard - aggregated status for the dashboard UI
 */

import { getTunnelStatus } from '../services/tunnel.js';
import { getWatcherState } from '../services/watcher.js';
import { getScannerState } from '../services/scanner-adapter.js';
import { getConfig } from '../lib/edge-config.js';
import { query } from '../db/index.js';

export default async function dashboardRoutes(fastify) {

  fastify.get('/dashboard', async () => {
    const tunnel = getTunnelStatus();
    const watcher = getWatcherState();
    const scanner = getScannerState();
    const config = getConfig();

    // Slide counts by status
    const slideCounts = await query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'ready') AS ready,
        COUNT(*) FILTER (WHERE status = 'processing') AS processing,
        COUNT(*) FILTER (WHERE status = 'queued') AS queued,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed
      FROM slides
    `);

    // Active jobs
    const jobCounts = await query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'queued') AS queued,
        COUNT(*) FILTER (WHERE status = 'running') AS running
      FROM jobs
      WHERE status IN ('queued', 'running')
    `);

    // Current running job details
    const activeJobs = await query(`
      SELECT j.id, j.slide_id, j.type, j.status, j.created_at,
             s.original_filename
      FROM jobs j
      LEFT JOIN slides s ON s.id = j.slide_id
      WHERE j.status IN ('queued', 'running')
      ORDER BY j.created_at ASC
      LIMIT 10
    `);

    const counts = slideCounts.rows[0] || {};
    const jobs = jobCounts.rows[0] || {};

    return {
      tunnel,
      watcher,
      scanner,
      config: {
        source: config.source,
        scannerType: config.scanner?.type,
        slidesDirHost: config.slidesDirHost,
        stableSeconds: config.stableSeconds,
        caseBaseRegex: config.caseBaseRegex
      },
      slides: {
        total: Number(counts.total) || 0,
        ready: Number(counts.ready) || 0,
        processing: Number(counts.processing) || 0,
        queued: Number(counts.queued) || 0,
        failed: Number(counts.failed) || 0
      },
      jobs: {
        pending: Number(jobs.queued) || 0,
        running: Number(jobs.running) || 0,
        active: activeJobs.rows
      }
    };
  });
}
```

**Step 2: Verify endpoint works**

```bash
docker compose up -d --build api
curl -s http://localhost:3000/v1/dashboard | jq
```

Expected: JSON with tunnel, watcher, scanner, config, slides, jobs fields.

**Step 3: Commit**
```bash
git add api/src/routes/dashboard.js
git commit -m "feat(dashboard): add /v1/dashboard aggregated status endpoint"
```

---

### Task 3: Dashboard HTML shell with tab navigation

**Files:**
- Modify: `api/src/dashboard/index.html` (replace placeholder with full SPA shell)
- Create: `api/src/dashboard/style.css` (stub)
- Create: `api/src/dashboard/app.js` (tab switching)

**Step 1: Write the dashboard HTML**

Replace `api/src/dashboard/index.html` with the full single-page shell containing:

- Header with SuperNavi name and connection status indicator
- Tab bar: Status | Laminas | Atividade | Configuracoes
- 4 tab panels (content sections)
- Linked CSS (`style.css`) and JS (`app.js`)

**Step 2: Create CSS and JS stubs**

`app.js` — tab switching logic using DOM event listeners.

`style.css` — basic reset, tab active state, panel show/hide.

**Step 3: Verify tabs work**

```bash
docker compose up -d --build api
```
Open http://localhost:3000/ in browser. Clicking tabs should switch visible sections.

**Step 4: Commit**
```bash
git add api/src/dashboard/
git commit -m "feat(dashboard): HTML shell with tab navigation"
```

---

### Task 4: Status tab - system health cards

**Files:**
- Modify: `api/src/dashboard/index.html` (add status cards HTML)
- Modify: `api/src/dashboard/style.css` (add card styles)
- Modify: `api/src/dashboard/app.js` (add data fetching + rendering)

**Step 1: Add status cards HTML to the status tab panel**

6 cards: Tunnel Cloud, Watcher, Banco de Dados, Fila (Redis), Processador, Disco.

Each card has: icon area, title, status indicator (dot + text), detail line.

**Step 2: Add JS to fetch `/v1/dashboard` and populate cards**

Use `fetch('/v1/dashboard')` and safe DOM methods (textContent, classList) to update card states.

- Green dot + "Conectado" for healthy
- Red dot + "Desconectado" for unhealthy
- Yellow dot + "Verificando..." for pending

Refresh every 10 seconds via `setInterval`.

**Step 3: Add CSS for cards grid**

Responsive grid layout, status indicator colors, clean card design.

**Step 4: Verify cards render with real data**

```bash
docker compose up -d --build api
```
Open http://localhost:3000/ - status cards should show real tunnel/watcher/DB status.

**Step 5: Commit**
```bash
git add api/src/dashboard/
git commit -m "feat(dashboard): status tab with system health cards"
```

---

### Task 5: SSE integration for real-time updates

**Files:**
- Modify: `api/src/dashboard/app.js` (add EventSource connection)

**Step 1: Add SSE connection to app.js**

```javascript
const eventSource = new EventSource('/v1/events');

eventSource.addEventListener('connected', () => {
  setConnectionStatus(true);
});

eventSource.addEventListener('slide:import', (e) => {
  const data = JSON.parse(e.data);
  addActivityEvent('import', `Lamina ${data.filename} detectada`);
  loadDashboard();
});

eventSource.addEventListener('slide:ready', (e) => {
  addActivityEvent('ready', 'Lamina pronta para visualizacao');
  loadDashboard();
});

eventSource.onerror = () => {
  setConnectionStatus(false);
};
```

**Step 2: Update connection status indicator in header**

Header dot turns green when SSE connected, red when disconnected.

**Step 3: Verify real-time**

Drop a file into `data/inbox/` and watch the dashboard update without refresh.

**Step 4: Commit**
```bash
git add api/src/dashboard/app.js
git commit -m "feat(dashboard): SSE integration for real-time updates"
```

---

### Task 6: Slides tab - list with thumbnails and status

**Files:**
- Modify: `api/src/dashboard/index.html` (slides list structure)
- Modify: `api/src/dashboard/style.css` (slide card styles)
- Modify: `api/src/dashboard/app.js` (fetch `/v1/slides`, render list, status filter)

**Step 1: Add slides toolbar and list container HTML**

Toolbar with filter buttons (Todas, Prontas, Processando, Erro) and count display.
List container div for dynamically created slide cards.

**Step 2: Add JS to fetch and render slides**

Use `fetch('/v1/slides')` and safe DOM creation (createElement, textContent, appendChild) to build slide cards. Each card shows:
- Thumbnail image (`/v1/slides/{id}/thumb`)
- Filename
- Format, dimensions, magnification
- Status badge (color-coded)
- Relative timestamp

**Step 3: Add filter logic**

Click filter buttons to show/hide slides by status using CSS classes.

**Step 4: Wire SSE events to auto-refresh slides list**

On `slide:import` and `slide:ready` events, call `loadSlides()`.

**Step 5: CSS for slide cards**

Horizontal card layout: thumbnail left, info center, timestamp right. Status badges with colors.

**Step 6: Verify with real slides**

Open slides tab - should show all slides with thumbnails and correct statuses.

**Step 7: Commit**
```bash
git add api/src/dashboard/
git commit -m "feat(dashboard): slides tab with thumbnails, status, and filters"
```

---

### Task 7: Activity tab - event feed

**Files:**
- Modify: `api/src/dashboard/index.html` (activity feed structure)
- Modify: `api/src/dashboard/style.css` (feed styles)
- Modify: `api/src/dashboard/app.js` (event ring buffer, SSE to feed)

**Step 1: Add activity feed HTML**

Header with title and clear button. Feed container div.

**Step 2: Add JS event ring buffer and rendering**

Ring buffer of 100 events max. Each event stores type, message, detail, and timestamp.

Use safe DOM methods (createElement, textContent) to render feed items. Map SSE event types to Portuguese messages:
- `slide:import` -> "Lamina {filename} detectada na pasta"
- `slide:ready` -> "Lamina pronta para visualizacao"
- `tile:pending` -> "Gerando tile z={z} x={x} y={y}"
- `tile:generated` -> "Tile gerado"
- etc.

**Step 3: Add clear button handler**

Empties the ring buffer and re-renders.

**Step 4: Verify feed populates in real-time**

Drop a file into inbox, watch events appear in the feed.

**Step 5: Commit**
```bash
git add api/src/dashboard/
git commit -m "feat(dashboard): activity tab with real-time event feed"
```

---

### Task 8: Settings tab - configuration form

**Files:**
- Modify: `api/src/dashboard/index.html` (config form)
- Modify: `api/src/dashboard/style.css` (form styles)
- Modify: `api/src/dashboard/app.js` (load config, save config)

**Step 1: Add config form HTML**

Form with fields:
- Pasta de Laminas (text input for slidesDirHost)
- Tipo de Scanner (select dropdown)
- Tempo de Estabilidade (range slider 5-60s with live display)
- Regex de Caso (text input for caseBaseRegex)
- Save button with status message area

**Step 2: Add JS to load and save config**

`loadConfig()` fetches `GET /v1/admin/config` and populates form fields.

Form submit handler sends `POST /v1/admin/config` with JSON body. Shows success/error message.

Range slider updates display label on input event.

**Step 3: Load config on page load and when switching to settings tab**

**Step 4: Verify save works**

Change a value, click save, verify response message appears and config persists.

**Step 5: Commit**
```bash
git add api/src/dashboard/
git commit -m "feat(dashboard): settings tab with config form"
```

---

### Task 9: Visual styling - operational monitoring aesthetic

**Files:**
- Modify: `api/src/dashboard/style.css` (complete styling pass)
- Modify: `api/src/dashboard/index.html` (minor structural tweaks if needed)

**Step 1: Apply production-quality styling**

Use the `frontend-design:frontend-design` skill to style the dashboard with:

- Dark theme by default (operational/monitoring aesthetic)
- Clean typography (system fonts for operational tool)
- Color-coded status indicators: green (ok), red (error), yellow (warning), blue (processing)
- Responsive cards grid
- Smooth transitions on status changes
- Pulsing animation for "processing" status
- Compact, information-dense layout
- CSS custom properties for all colors

**Step 2: Verify visual quality**

Open in browser, check all 4 tabs look polished and consistent.

**Step 3: Commit**
```bash
git add api/src/dashboard/
git commit -m "feat(dashboard): production-quality operational styling"
```

---

### Task 10: Docker build verification and Dockerfile check

**Files:**
- Verify: `api/Dockerfile` (ensure dashboard dir is included in COPY)

**Step 1: Check Dockerfile copies dashboard files**

The Dockerfile likely does `COPY . .` or similar. Verify `src/dashboard/` is within the build context. If needed, add explicit COPY.

**Step 2: Full rebuild and integration test**

```bash
docker compose down
docker compose up -d --build
```

Open http://localhost:3000/ and verify:
1. Status tab: all 6 cards show correct state
2. Drop file into `data/inbox/` -> Activity and Slides update in real-time
3. Settings: change value, save, verify persistence
4. API endpoints still work (`/v1/health`, `/v1/slides`)

**Step 3: Test edge cases**

1. Disconnect tunnel -> tunnel card goes red
2. Navigate between tabs rapidly -> no UI glitches
3. Refresh page -> state loads correctly

**Step 4: Commit**
```bash
git add -A
git commit -m "feat(dashboard): edge monitoring dashboard v1 complete"
```
