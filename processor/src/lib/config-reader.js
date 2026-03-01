/**
 * Lightweight config reader for processor container.
 * Reads EDGE_KEY (and other cloud fields) from the mounted edge-config.json,
 * falling back to environment variables.
 *
 * The config file is mounted read-only at /config/edge-config.json.
 */

import { readFileSync } from 'fs';

const CONFIG_PATH = '/config/edge-config.json';

let _cached = null;

function loadConfig() {
  if (_cached) return _cached;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    _cached = raw.cloud || {};
  } catch {
    _cached = {};
  }
  return _cached;
}

/**
 * Get EDGE_KEY: config file takes priority over env var.
 */
export function getEdgeKey() {
  const cloud = loadConfig();
  return cloud.edgeKey || process.env.EDGE_KEY || '';
}

/**
 * Get Cloud API URL: env var takes priority (set via docker-compose).
 */
export function getCloudApiUrl() {
  return process.env.CLOUD_API_URL || process.env.CLOUD_SYNC_URL || 'https://cloud.supernavi.app';
}
