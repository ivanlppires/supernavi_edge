import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getTunnelStatus } from '../services/tunnel.js';
import { getWatcherState } from '../services/watcher.js';
import { getScannerState } from '../services/scanner-adapter.js';
import { getConfig } from '../lib/edge-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load version from package.json
const pkg = JSON.parse(
  readFileSync(join(__dirname, '../../package.json'), 'utf8')
);

export default async function healthRoutes(fastify) {
  fastify.get('/health', async () => {
    const tunnel = getTunnelStatus();
    const watcher = getWatcherState();
    const scanner = getScannerState();
    const config = getConfig();

    const needsConfig = watcher.state === 'needs_config';

    return {
      status: needsConfig ? 'needs_config' : 'ok',
      version: pkg.version,
      mode: 'local',
      timestamp: new Date().toISOString(),
      tunnel: {
        configured: tunnel.configured,
        connected: tunnel.connected,
        agentId: tunnel.agentId
      },
      watcher: {
        state: watcher.state,
        error: watcher.error,
        ingestDir: watcher.ingestDir
      },
      scanner: {
        enabled: scanner.enabled,
        state: scanner.state,
        lastScan: scanner.lastScan,
        lastScanCount: scanner.lastScanCount,
        totalDiscovered: scanner.totalDiscovered,
        error: scanner.error,
      },
      config: {
        loaded: config.source !== 'defaults',
        source: config.source,
        scannerType: config.scanner?.type || 'unknown',
        stableSeconds: config.stableSeconds
      }
    };
  });
}
