/**
 * Threads & Messages API Routes
 * Local-first discussion threads
 */

import {
  createThread,
  getThreads,
  getThread,
  createMessage,
  getMessages
} from '../db/collaboration.js';
import { getSlide } from '../db/slides.js';
import { eventBus } from '../services/events.js';

export default async function threadsRoutes(fastify) {
  // Get threads for a slide
  fastify.get('/slides/:slideId/threads', async (request, reply) => {
    const { slideId } = request.params;

    // Verify slide exists
    const slide = await getSlide(slideId);
    if (!slide) {
      reply.code(404);
      return { error: 'Slide not found' };
    }

    const threads = await getThreads(slideId);

    return {
      items: threads.map(t => ({
        threadId: t.thread_id,
        slideId: t.slide_id,
        title: t.title,
        anchorType: t.anchor_type,
        anchorId: t.anchor_id,
        messageCount: parseInt(t.message_count, 10),
        createdAt: t.created_at,
        updatedAt: t.updated_at
      }))
    };
  });

  // Create a new thread
  fastify.post('/slides/:slideId/threads', {
    schema: {
      body: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          anchor: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              id: { type: 'string' }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const { slideId } = request.params;
    const { title, anchor } = request.body;

    // Verify slide exists
    const slide = await getSlide(slideId);
    if (!slide) {
      reply.code(404);
      return { error: 'Slide not found' };
    }

    const thread = await createThread({
      slideId,
      title,
      anchorType: anchor?.type || null,
      anchorId: anchor?.id || null
    });

    // Emit SSE event
    eventBus.emit('sse', {
      event: 'thread.created',
      data: {
        threadId: thread.thread_id,
        slideId,
        title: thread.title,
        anchorType: thread.anchor_type,
        anchorId: thread.anchor_id,
        timestamp: Date.now()
      }
    });

    reply.code(201);
    return {
      threadId: thread.thread_id,
      slideId: thread.slide_id,
      title: thread.title,
      anchorType: thread.anchor_type,
      anchorId: thread.anchor_id,
      createdAt: thread.created_at
    };
  });

  // Get messages for a thread
  fastify.get('/threads/:threadId/messages', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          since: { type: 'string', format: 'date-time' }
        }
      }
    }
  }, async (request, reply) => {
    const { threadId } = request.params;
    const { since } = request.query;

    // Verify thread exists
    const thread = await getThread(threadId);
    if (!thread) {
      reply.code(404);
      return { error: 'Thread not found' };
    }

    const messages = await getMessages(threadId, since || null);

    return {
      threadId,
      items: messages.map(m => ({
        messageId: m.message_id,
        threadId: m.thread_id,
        authorId: m.author_id,
        text: m.text,
        createdAt: m.created_at
      }))
    };
  });

  // Create a new message
  fastify.post('/threads/:threadId/messages', {
    schema: {
      body: {
        type: 'object',
        required: ['authorId', 'text'],
        properties: {
          authorId: { type: 'string' },
          text: { type: 'string', minLength: 1 },
          idempotencyKey: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { threadId } = request.params;
    const { authorId, text, idempotencyKey } = request.body;

    // Verify thread exists
    const thread = await getThread(threadId);
    if (!thread) {
      reply.code(404);
      return { error: 'Thread not found' };
    }

    const { message, created } = await createMessage({
      threadId,
      authorId,
      text,
      idempotencyKey
    });

    // Emit SSE event only if actually created
    if (created) {
      eventBus.emit('sse', {
        event: 'message.created',
        data: {
          messageId: message.message_id,
          threadId,
          slideId: thread.slide_id,
          authorId,
          timestamp: Date.now()
        }
      });
    }

    reply.code(created ? 201 : 200);
    return {
      messageId: message.message_id,
      threadId: message.thread_id,
      authorId: message.author_id,
      text: message.text,
      createdAt: message.created_at,
      created
    };
  });
}
