import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getTunnelStatus } from '../services/tunnel.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load version from package.json
const pkg = JSON.parse(
  readFileSync(join(__dirname, '../../package.json'), 'utf8')
);

export default async function healthRoutes(fastify) {
  fastify.get('/health', async () => {
    const tunnel = getTunnelStatus();
    return {
      status: 'ok',
      version: pkg.version,
      mode: 'local',
      timestamp: new Date().toISOString(),
      tunnel: {
        configured: tunnel.configured,
        connected: tunnel.connected,
        agentId: tunnel.agentId
      }
    };
  });
}
