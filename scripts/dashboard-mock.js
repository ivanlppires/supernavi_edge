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
    slides: { items: slides }, pending: { total: pending.length, slides: pending },
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
      const sl = fx.slides.items.find(x => x.slideId === m[1]) || fx.slides.items[0] || { slideId: m[1], originalFilename: 'x.svs', status: 'ready', format: 'svs' };
      return json(res, {
        slide: { slideId: m[1], originalFilename: sl.originalFilename, status: sl.status, format: sl.format, tilegenStatus: 'done', cloudUploadStatus: 'done', latestError: sl.latestError || null, latestErrorStage: sl.latestErrorStage || null, latestErrorAt: sl.latestError ? iso(30) : null, createdAt: sl.createdAt || iso(120) },
        advice: sl.latestError ? { severity: 'error', reason: 'Faltou memória ao gerar o BigTIFF', suggestion: 'Feche outros programas e reprocesse', action: 'reprocess' } : null,
        events: [
          { id: 1, stage: 'ingest', level: 'info', message: 'Arquivo estável, registrado', details: null, createdAt: iso(120) },
          { id: 2, stage: 'bigtiff', level: 'info', message: 'BigTIFF pipeline complete', details: null, createdAt: iso(90) },
          { id: 3, stage: 'sync', level: 'info', message: 'Synced to cloud: slide/registered', details: null, createdAt: iso(88) },
          { id: 4, stage: 'preview', level: 'error', message: 'Label photo upload to the cloud failed', details: { code: 'ETIMEDOUT' }, createdAt: iso(30) },
        ],
        jobs: [
          { id: 10, type: 'P0', status: 'done', error: null, createdAt: iso(121), updatedAt: iso(119) },
          { id: 11, type: 'BIGTIFF', status: sl.status === 'failed' ? 'failed' : 'done', error: sl.latestError || null, createdAt: iso(118), updatedAt: iso(90) },
        ],
        syncFailures: [],
      });
    }
    if (p === '/v1/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connected\ndata: {}\n\n'); return; }
    if (req.method === 'POST' && p.startsWith('/v1/')) return json(res, { success: true, ok: true, confirmed: 16, skipped: 1, failed: [], queued: 104, message: 'ok' });
    const file = join(ROOT, p === '/' ? 'index.html' : p);
    try { const body = await readFile(file); res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(body); }
    catch { res.writeHead(404); res.end('not found'); }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2] || 8099); const cenario = process.argv[3] || 'normal';
  startMock(port, cenario).then(() => console.log(`dashboard mock (${cenario}) at http://127.0.0.1:${port}/`));
}
