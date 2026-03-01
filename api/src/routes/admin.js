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
}
