/**
 * Edge Tunnel Client
 *
 * Establishes a persistent WebSocket connection to the cloud for reverse proxy requests.
 * The cloud can route HTTP requests through this tunnel to access local edge resources.
 */

import WebSocket from 'ws';

// Configuration from environment
const CLOUD_TUNNEL_URL = process.env.CLOUD_TUNNEL_URL || '';
const EDGE_TUNNEL_TOKEN = process.env.EDGE_TUNNEL_TOKEN || '';
const EDGE_AGENT_ID = process.env.EDGE_AGENT_ID || '';

// Reconnection settings
const INITIAL_RECONNECT_DELAY = 1000; // 1 second
const MAX_RECONNECT_DELAY = 30000; // 30 seconds
const RECONNECT_MULTIPLIER = 2;

// State
let ws = null;
let fastifyApp = null;
let reconnectDelay = INITIAL_RECONNECT_DELAY;
let reconnectTimer = null;
let isShuttingDown = false;

/**
 * Initialize the tunnel client with a fastify app instance
 * @param {import('fastify').FastifyInstance} app - The fastify app for inject
 */
export function initTunnel(app) {
  fastifyApp = app;
}

/**
 * Start the tunnel connection
 */
export function startTunnel() {
  if (!CLOUD_TUNNEL_URL) {
    console.log('[Tunnel] CLOUD_TUNNEL_URL not configured, tunnel disabled');
    return;
  }

  if (!EDGE_TUNNEL_TOKEN) {
    console.log('[Tunnel] EDGE_TUNNEL_TOKEN not configured, tunnel disabled');
    return;
  }

  if (!EDGE_AGENT_ID) {
    console.log('[Tunnel] EDGE_AGENT_ID not configured, tunnel disabled');
    return;
  }

  if (!fastifyApp) {
    console.error('[Tunnel] Fastify app not initialized, call initTunnel first');
    return;
  }

  console.log(`[Tunnel] Connecting to ${CLOUD_TUNNEL_URL} as agent ${EDGE_AGENT_ID}...`);
  connect();
}

/**
 * Connect to the cloud WebSocket endpoint
 */
function connect() {
  if (isShuttingDown) {
    return;
  }

  // Build URL with query params
  const url = new URL(CLOUD_TUNNEL_URL);
  url.searchParams.set('agentId', EDGE_AGENT_ID);

  try {
    ws = new WebSocket(url.toString(), {
      headers: {
        'Authorization': `Bearer ${EDGE_TUNNEL_TOKEN}`,
      },
    });

    ws.on('open', () => {
      console.log(`[Tunnel] Connected to cloud as ${EDGE_AGENT_ID}`);
      // Reset reconnect delay on successful connection
      reconnectDelay = INITIAL_RECONNECT_DELAY;
    });

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === 'http_request') {
          await handleHttpRequest(message);
        } else {
          console.warn(`[Tunnel] Unknown message type: ${message.type}`);
        }
      } catch (err) {
        console.error('[Tunnel] Failed to handle message:', err);
      }
    });

    ws.on('close', (code, reason) => {
      console.log(`[Tunnel] Disconnected (code: ${code}, reason: ${reason?.toString() || 'none'})`);
      ws = null;
      scheduleReconnect();
    });

    ws.on('error', (err) => {
      console.error('[Tunnel] WebSocket error:', err.message);
      // Close will be called after error, which will trigger reconnect
    });

    ws.on('pong', () => {
      // Keep-alive pong received
    });
  } catch (err) {
    console.error('[Tunnel] Failed to connect:', err);
    ws = null;
    scheduleReconnect();
  }
}

/**
 * Schedule a reconnection attempt with exponential backoff
 */
function scheduleReconnect() {
  if (isShuttingDown) {
    return;
  }

  console.log(`[Tunnel] Reconnecting in ${reconnectDelay}ms...`);

  reconnectTimer = setTimeout(() => {
    connect();
  }, reconnectDelay);

  // Increase delay for next attempt (with cap)
  reconnectDelay = Math.min(reconnectDelay * RECONNECT_MULTIPLIER, MAX_RECONNECT_DELAY);
}

/**
 * Handle an HTTP request from the cloud
 * Uses fastify.inject to execute the request locally
 */
async function handleHttpRequest(message) {
  const { requestId, method, url, headers, bodyBase64 } = message;

  console.log(`[Tunnel] Proxying ${method} ${url} (requestId: ${requestId})`);

  const startTime = Date.now();

  try {
    // Prepare inject options
    const injectOptions = {
      method,
      url,
      headers: headers || {},
    };

    // Add body if present
    if (bodyBase64) {
      injectOptions.payload = Buffer.from(bodyBase64, 'base64');
    }

    // Execute request via fastify.inject
    const response = await fastifyApp.inject(injectOptions);

    const duration = Date.now() - startTime;
    console.log(`[Tunnel] Request ${requestId} completed: ${response.statusCode} in ${duration}ms`);

    // Build response message
    const responseMessage = {
      type: 'http_response',
      requestId,
      statusCode: response.statusCode,
      headers: response.headers,
      bodyBase64: response.rawPayload.length > 0
        ? response.rawPayload.toString('base64')
        : undefined,
    };

    // Send response back to cloud
    sendMessage(responseMessage);
  } catch (err) {
    console.error(`[Tunnel] Request ${requestId} failed:`, err);

    // Send error response
    const errorResponse = {
      type: 'http_response',
      requestId,
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      bodyBase64: Buffer.from(JSON.stringify({
        error: 'Internal Server Error',
        message: err.message,
      })).toString('base64'),
    };

    sendMessage(errorResponse);
  }
}

/**
 * Send a message through the WebSocket
 */
function sendMessage(message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error('[Tunnel] Cannot send message, WebSocket not connected');
    return;
  }

  try {
    ws.send(JSON.stringify(message));
  } catch (err) {
    console.error('[Tunnel] Failed to send message:', err);
  }
}

/**
 * Stop the tunnel connection
 */
export function stopTunnel() {
  console.log('[Tunnel] Stopping...');
  isShuttingDown = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (ws) {
    ws.close(1000, 'Shutting down');
    ws = null;
  }
}

/**
 * Check if tunnel is connected
 */
export function isTunnelConnected() {
  return ws && ws.readyState === WebSocket.OPEN;
}

/**
 * Get tunnel status for health checks
 */
export function getTunnelStatus() {
  return {
    configured: !!(CLOUD_TUNNEL_URL && EDGE_TUNNEL_TOKEN && EDGE_AGENT_ID),
    connected: isTunnelConnected(),
    agentId: EDGE_AGENT_ID || null,
    cloudUrl: CLOUD_TUNNEL_URL || null,
  };
}

export default {
  initTunnel,
  startTunnel,
  stopTunnel,
  isTunnelConnected,
  getTunnelStatus,
};
