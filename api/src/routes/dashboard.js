/**
 * Dashboard data route
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

    const slideCounts = await query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'ready') AS ready,
        COUNT(*) FILTER (WHERE status = 'processing') AS processing,
        COUNT(*) FILTER (WHERE status = 'queued') AS queued,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed
      FROM slides
    `);

    const jobCounts = await query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'queued') AS queued,
        COUNT(*) FILTER (WHERE status = 'running') AS running
      FROM jobs
      WHERE status IN ('queued', 'running')
    `);

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
