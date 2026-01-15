/**
 * Mock Cloud Server for Sync Testing
 *
 * Simulates cloud sync endpoints for local development and testing.
 * Accepts events from local sync engine and logs them.
 */

import Fastify from 'fastify';

const app = Fastify({ logger: true });

// Store received events in memory
const receivedEvents = [];
let totalEventsReceived = 0;

// Health endpoint
app.get('/health', async () => {
  return {
    status: 'ok',
    service: 'mock-cloud',
    eventsReceived: totalEventsReceived
  };
});

// Sync push endpoint
app.post('/v1/sync/push', async (request, reply) => {
  const { agentId, labId, events } = request.body;

  if (!events || !Array.isArray(events)) {
    return reply.code(400).send({ error: 'Invalid payload: events array required' });
  }

  // Validate authorization
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  const accepted = [];
  const rejected = [];

  for (const event of events) {
    const { eventId, entityType, entityId, op, payload, createdAt } = event;

    // Validate required fields
    if (!eventId || !entityType || !op) {
      rejected.push({
        eventId,
        reason: 'invalid: missing required fields'
      });
      continue;
    }

    // Simulate random rejections for testing (5% chance)
    if (Math.random() < 0.05) {
      rejected.push({
        eventId,
        reason: 'temporary: simulated failure for testing'
      });
      continue;
    }

    // Accept the event
    accepted.push(eventId);
    receivedEvents.push({
      eventId,
      agentId,
      labId,
      entityType,
      entityId,
      op,
      payload,
      createdAt,
      receivedAt: new Date().toISOString()
    });
    totalEventsReceived++;
  }

  app.log.info({
    agentId,
    labId,
    received: events.length,
    accepted: accepted.length,
    rejected: rejected.length
  }, 'Sync push processed');

  return {
    accepted,
    rejected,
    timestamp: new Date().toISOString()
  };
});

// List received events (for testing/debugging)
app.get('/v1/events', async (request, reply) => {
  const limit = parseInt(request.query.limit) || 100;
  const offset = parseInt(request.query.offset) || 0;

  return {
    total: receivedEvents.length,
    items: receivedEvents.slice(offset, offset + limit)
  };
});

// Clear events (for testing)
app.delete('/v1/events', async () => {
  const count = receivedEvents.length;
  receivedEvents.length = 0;
  totalEventsReceived = 0;
  return { cleared: count };
});

// Start server
const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || '0.0.0.0';

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`Mock cloud server running on http://${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
