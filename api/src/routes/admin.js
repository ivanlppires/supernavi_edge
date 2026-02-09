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

    // Merge patch onto current config
    const current = getConfig();
    const merged = { ...current, ...patch };

    // Validate
    const { valid, errors, config: validated } = validateConfig(merged);
    if (!valid) {
      return reply.status(400).send({ error: 'Validation failed', errors });
    }

    // Detect if ingest dir changed (needs container restart for volume mount)
    const dirChanged = patch.slidesDirHost && patch.slidesDirHost !== current.slidesDirHost;

    // Save
    validated.source = validated.source === 'defaults' ? 'wizard-http' : validated.source;
    await saveConfig(validated);

    // Reload cached config
    await reloadConfig();

    return {
      config: validated,
      watcher: getWatcherState(),
      message: dirChanged
        ? 'Config saved. Restart containers to apply new volume mount.'
        : 'Config saved and applied.'
    };
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
