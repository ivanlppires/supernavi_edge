/**
 * SuperNavi Edge - Configuration Reader/Writer
 *
 * Manages edge-config.json: load, validate, save, singleton cache.
 * Works both on host (setup.js) and inside container (API runtime).
 */

import { readFile, writeFile, rename, mkdir, access } from 'fs/promises';
import { dirname, join } from 'path';
import { constants } from 'fs';

// ============================================================================
// Defaults
// ============================================================================

const DEFAULTS = {
  version: 1,
  source: 'defaults',
  scanner: { type: 'unknown', model: null },
  slidesDirHost: './data/inbox',
  slidesDirContainer: '/data/inbox',
  rawDirContainer: '/data/raw',
  derivedDirContainer: '/data/derived',
  stableSeconds: 15,
  caseBaseRegex: '^(AP\\d{6,12})',
};

/**
 * Return a fresh copy of default config values.
 * @returns {object}
 */
export function getDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

// ============================================================================
// Path resolution
// ============================================================================

/**
 * Get path to the config file.
 * Inside container: /config/edge-config.json
 * On host (or fallback): ./config/edge-config.json
 *
 * @param {{ host?: boolean }} [options]
 * @returns {string}
 */
export function getConfigPath(options = {}) {
  if (options.host) {
    return join(process.cwd(), 'config', 'edge-config.json');
  }
  // Inside container, check /config first
  return '/config/edge-config.json';
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate a config object. Returns cleaned config + errors.
 * @param {object} raw
 * @returns {{ valid: boolean, errors: string[], config: object }}
 */
export function validateConfig(raw) {
  const errors = [];
  const config = { ...getDefaults() };

  if (raw.version !== undefined) {
    if (raw.version !== 1) errors.push('version must be 1');
    else config.version = 1;
  }

  if (raw.source !== undefined) {
    config.source = String(raw.source);
  }

  if (raw.scanner !== undefined && typeof raw.scanner === 'object') {
    config.scanner = {
      type: raw.scanner.type || 'unknown',
      model: raw.scanner.model || null,
    };
  }

  if (raw.slidesDirHost !== undefined) {
    if (typeof raw.slidesDirHost !== 'string' || raw.slidesDirHost.trim() === '') {
      errors.push('slidesDirHost must be a non-empty string');
    } else {
      config.slidesDirHost = raw.slidesDirHost;
    }
  }

  if (raw.slidesDirContainer !== undefined) {
    if (typeof raw.slidesDirContainer !== 'string' || !raw.slidesDirContainer.startsWith('/')) {
      errors.push('slidesDirContainer must start with /');
    } else {
      config.slidesDirContainer = raw.slidesDirContainer;
    }
  }

  if (raw.rawDirContainer !== undefined) {
    if (typeof raw.rawDirContainer !== 'string' || !raw.rawDirContainer.startsWith('/')) {
      errors.push('rawDirContainer must start with /');
    } else {
      config.rawDirContainer = raw.rawDirContainer;
    }
  }

  if (raw.derivedDirContainer !== undefined) {
    if (typeof raw.derivedDirContainer !== 'string' || !raw.derivedDirContainer.startsWith('/')) {
      errors.push('derivedDirContainer must start with /');
    } else {
      config.derivedDirContainer = raw.derivedDirContainer;
    }
  }

  if (raw.stableSeconds !== undefined) {
    const val = Number(raw.stableSeconds);
    if (isNaN(val) || val < 1 || val > 300) {
      errors.push('stableSeconds must be between 1 and 300');
    } else {
      config.stableSeconds = val;
    }
  }

  if (raw.caseBaseRegex !== undefined) {
    try {
      new RegExp(raw.caseBaseRegex);
      config.caseBaseRegex = raw.caseBaseRegex;
    } catch {
      errors.push('caseBaseRegex is not a valid regular expression');
    }
  }

  // Timestamps
  if (raw.createdAt) config.createdAt = raw.createdAt;
  if (raw.updatedAt) config.updatedAt = raw.updatedAt;

  return { valid: errors.length === 0, errors, config };
}

// ============================================================================
// Load / Save
// ============================================================================

/**
 * Read and validate config from disk.
 * If file does not exist, returns defaults with loaded=false.
 *
 * @returns {Promise<{ config: object, loaded: boolean, errors: string[] }>}
 */
export async function loadConfig() {
  const paths = [getConfigPath(), getConfigPath({ host: true })];

  for (const configPath of paths) {
    try {
      await access(configPath, constants.R_OK);
      const raw = JSON.parse(await readFile(configPath, 'utf8'));
      const { valid, errors, config } = validateConfig(raw);
      _cachedConfig = config;
      return { config, loaded: true, errors };
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      if (err instanceof SyntaxError) {
        return { config: getDefaults(), loaded: false, errors: ['Config file contains invalid JSON'] };
      }
      // Permission error or other - try next path
      continue;
    }
  }

  const defaults = getDefaults();
  _cachedConfig = defaults;
  return { config: defaults, loaded: false, errors: [] };
}

/**
 * Write config to disk atomically (write tmp, then rename).
 *
 * @param {object} config
 * @param {{ path?: string }} [options]
 */
export async function saveConfig(config, options = {}) {
  const configPath = options.path || getConfigPath({ host: true });
  await mkdir(dirname(configPath), { recursive: true });

  config.updatedAt = new Date().toISOString();
  if (!config.createdAt) config.createdAt = config.updatedAt;

  const json = JSON.stringify(config, null, 2) + '\n';
  const tmpPath = configPath + '.tmp';

  await writeFile(tmpPath, json, 'utf8');
  await rename(tmpPath, configPath);
  _cachedConfig = config;
}

// ============================================================================
// Singleton cache
// ============================================================================

let _cachedConfig = null;

/**
 * Get cached config (or defaults if not loaded yet).
 * @returns {object}
 */
export function getConfig() {
  return _cachedConfig || getDefaults();
}

/**
 * Reload config from disk and update cache.
 * @returns {Promise<{ config: object, loaded: boolean, errors: string[] }>}
 */
export async function reloadConfig() {
  _cachedConfig = null;
  return loadConfig();
}
