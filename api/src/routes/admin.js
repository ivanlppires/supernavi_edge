/**
 * SuperNavi Edge - Admin routes
 *
 * GET  /v1/admin/config          → current config + watcher state
 * POST /v1/admin/config          → update config (partial merge), save, reload
 * GET  /v1/admin/scanner/detect  → run auto-detection, return scored candidates
 */

import { getConfig, loadConfig, saveConfig, validateConfig, reloadConfig } from '../lib/edge-config.js';
import { autoDetectScannerDirs } from '../lib/motic-detect.js';
import { getWatcherState } from '../services/watcher.js';
import { restartTunnel } from '../services/tunnel.js';
import { enqueueJob } from '../lib/queue.js';
import { getPool } from '../db/index.js';

export default async function adminRoutes(fastify) {

  // GET /v1/admin/config — current config + watcher state
  fastify.get('/admin/config', async () => {
    const config = getConfig();
    const watcher = getWatcherState();
    return { config, watcher };
  });

  // POST /v1/admin/config — partial update, validate, save, reload
  fastify.post('/admin/config', async (request, reply) => {
    const patch = request.body;
    if (!patch || typeof patch !== 'object') {
      return reply.badRequest('Request body must be a JSON object');
    }

    // Merge patch onto current config (deep-merge nested objects)
    const current = getConfig();
    const merged = { ...current, ...patch };
    if (patch.scanner && current.scanner) {
      merged.scanner = { ...current.scanner, ...patch.scanner };
    }
    if (patch.cloud && current.cloud) {
      merged.cloud = { ...current.cloud, ...patch.cloud };
    }

    // Validate
    const { valid, errors, config: validated } = validateConfig(merged);
    if (!valid) {
      return reply.status(400).send({ error: 'Validation failed', errors });
    }

    // Detect if ingest dir changed (needs container restart for volume mount)
    const dirChanged = patch.slidesDirHost && patch.slidesDirHost !== current.slidesDirHost;

    // Detect if cloud settings changed
    const cloudChanged = patch.cloud && (
      patch.cloud.edgeKey !== undefined ||
      patch.cloud.agentId !== undefined
    );

    // Save
    validated.source = validated.source === 'defaults' ? 'wizard-http' : validated.source;
    await saveConfig(validated);

    // Reload cached config
    await reloadConfig();

    // Restart tunnel if cloud settings changed
    if (cloudChanged) {
      restartTunnel();
    }

    let message = 'Config saved and applied.';
    if (dirChanged) message = 'Config saved. Restart containers to apply new volume mount.';
    else if (cloudChanged) message = 'Config saved. Tunnel reconnecting...';

    return {
      config: validated,
      watcher: getWatcherState(),
      message,
    };
  });

  // POST /v1/admin/verify-key — verify EDGE_KEY against cloud, return edge info
  fastify.post('/admin/verify-key', async (request, reply) => {
    const { edgeKey } = request.body || {};
    if (!edgeKey || typeof edgeKey !== 'string') {
      return reply.status(400).send({ error: 'edgeKey is required' });
    }

    const cloudApiUrl = process.env.CLOUD_API_URL || 'https://cloud.supernavi.app';

    try {
      const res = await fetch(`${cloudApiUrl}/edge/identify`, {
        headers: { 'Authorization': `Bearer ${edgeKey}` },
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return reply.status(res.status).send({
          error: body.error || 'Key verification failed',
        });
      }

      const data = await res.json();
      return reply.send(data);
    } catch (err) {
      return reply.status(502).send({
        error: 'Could not reach cloud server',
        message: err.message,
      });
    }
  });

  // GET /v1/admin/scanner/detect — auto-detect scanner directories
  fastify.get('/admin/scanner/detect', async () => {
    const results = await autoDetectScannerDirs();
    return {
      candidates: results.map(r => ({
        path: r.candidate.path,
        scannerType: r.candidate.scannerType,
        model: r.candidate.model,
        finalScore: r.finalScore,
        slideCount: r.slideCount,
        recentFiles: r.recentFiles,
      })),
      count: results.length
    };
  });

  // POST /v1/admin/slides/:slideId/republish-preview — re-trigger preview upload
  fastify.post('/admin/slides/:slideId/republish-preview', async (request, reply) => {
    const { slideId } = request.params;
    const { force = true } = request.body || {};

    // Verify slide exists in local DB
    let slide;
    try {
      const result = await getPool().query('SELECT id, status, original_filename FROM slides WHERE id = $1', [slideId]);
      slide = result.rows[0];
    } catch {
      return reply.status(500).send({ error: 'Database query failed' });
    }

    if (!slide) {
      return reply.status(404).send({ error: 'Slide not found' });
    }

    await enqueueJob({
      type: 'PREVIEW_REPUBLISH',
      slideId,
      force,
    });

    return {
      success: true,
      slideId,
      filename: slide.original_filename,
      message: 'Preview republish queued',
    };
  });

  // POST /v1/admin/slides/republish-all-previews — re-trigger preview upload for all ready slides
  fastify.post('/admin/slides/republish-all-previews', async (request, reply) => {
    const { force = true } = request.body || {};

    let slides;
    try {
      const result = await getPool().query(
        "SELECT id, original_filename FROM slides WHERE status = 'ready'",
      );
      slides = result.rows;
    } catch {
      return reply.status(500).send({ error: 'Database query failed' });
    }

    if (slides.length === 0) {
      return reply.send({ success: true, queued: 0, message: 'No ready slides found' });
    }

    for (const slide of slides) {
      await enqueueJob({
        type: 'PREVIEW_REPUBLISH',
        slideId: slide.id,
        force,
      });
    }

    return {
      success: true,
      queued: slides.length,
      slides: slides.map(s => ({ slideId: s.id, filename: s.original_filename })),
      message: `Preview republish queued for ${slides.length} slide(s)`,
    };
  });

  // POST /v1/admin/slides/:slideId/publish-label — send this slide's label photo to the cloud
  fastify.post('/admin/slides/:slideId/publish-label', async (request, reply) => {
    const { slideId } = request.params;
    let slide;
    try {
      const result = await getPool().query(
        'SELECT id, original_filename, raw_path, dsmeta_path FROM slides WHERE id = $1', [slideId]);
      slide = result.rows[0];
    } catch {
      return reply.status(500).send({ error: 'Database query failed' });
    }
    if (!slide) return reply.status(404).send({ error: 'Slide not found' });
    if (!slide.dsmeta_path) return reply.status(400).send({ error: 'Slide has no .dsmeta folder (no label photo)' });

    await enqueueJob({ type: 'LABEL_PUBLISH', slideId, rawPath: slide.raw_path });
    return { success: true, slideId, filename: slide.original_filename, message: 'Label publish queued' };
  });

  // POST /v1/admin/slides/publish-all-labels — backfill: send the label photo of every
  // uploaded BigTIFF slide that has a .dsmeta folder (slides processed before label support)
  fastify.post('/admin/slides/publish-all-labels', async (request, reply) => {
    let slides;
    try {
      const result = await getPool().query(
        `SELECT id, original_filename, raw_path FROM slides
          WHERE dsmeta_path IS NOT NULL
            AND pipeline_mode = 'bigtiff_iiif'
            AND cloud_upload_status = 'done'
          ORDER BY created_at`,
      );
      slides = result.rows;
    } catch {
      return reply.status(500).send({ error: 'Database query failed' });
    }

    if (slides.length === 0) {
      return reply.send({ success: true, queued: 0, message: 'No uploaded slides with a label photo found' });
    }

    for (const slide of slides) {
      await enqueueJob({ type: 'LABEL_PUBLISH', slideId: slide.id, rawPath: slide.raw_path });
    }

    return {
      success: true,
      queued: slides.length,
      slides: slides.map(s => ({ slideId: s.id, filename: s.original_filename })),
      message: `Label publish queued for ${slides.length} slide(s)`,
    };
  });
}
