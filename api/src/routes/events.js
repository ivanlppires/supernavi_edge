/**
 * SSE Events Route
 *
 * GET /v1/events - Server-Sent Events stream for real-time updates
 */

import { eventBus } from '../services/events.js';

export default async function eventsRoutes(fastify) {
  // SSE endpoint for real-time events
  fastify.get('/events', async (request, reply) => {
    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no' // Disable nginx buffering
    });

    // Send initial connection event
    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);

    // Keep-alive ping every 30 seconds
    const keepAlive = setInterval(() => {
      reply.raw.write(`: ping\n\n`);
    }, 30000);

    // SSE event handler
    const onEvent = ({ event, data }) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Subscribe to events
    eventBus.on('sse', onEvent);

    // Cleanup on disconnect
    request.raw.on('close', () => {
      clearInterval(keepAlive);
      eventBus.off('sse', onEvent);
    });

    // Don't end the response - keep it open for SSE
    return reply;
  });
}
