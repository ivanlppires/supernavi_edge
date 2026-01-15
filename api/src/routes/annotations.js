/**
 * Annotations API Routes
 * Local-first annotations with optimistic locking
 */

import {
  createAnnotation,
  getAnnotations,
  getAnnotation,
  updateAnnotation,
  deleteAnnotation
} from '../db/collaboration.js';
import { getSlide } from '../db/slides.js';
import { eventBus } from '../services/events.js';

export default async function annotationsRoutes(fastify) {
  // Get annotations for a slide
  fastify.get('/slides/:slideId/annotations', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          since: { type: 'string', format: 'date-time' }
        }
      }
    }
  }, async (request, reply) => {
    const { slideId } = request.params;
    const { since } = request.query;

    // Verify slide exists
    const slide = await getSlide(slideId);
    if (!slide) {
      reply.code(404);
      return { error: 'Slide not found' };
    }

    const annotations = await getAnnotations(slideId, since || null);

    return {
      items: annotations.map(a => ({
        annotationId: a.annotation_id,
        slideId: a.slide_id,
        type: a.type,
        geometry: a.geometry,
        style: a.style,
        authorId: a.author_id,
        version: a.version,
        createdAt: a.created_at,
        updatedAt: a.updated_at
      }))
    };
  });

  // Create a new annotation
  fastify.post('/slides/:slideId/annotations', {
    schema: {
      body: {
        type: 'object',
        required: ['type', 'geometry', 'authorId'],
        properties: {
          type: { type: 'string', enum: ['polygon', 'rectangle', 'ellipse', 'point', 'line', 'freehand'] },
          geometry: { type: 'object' },
          style: { type: 'object' },
          authorId: { type: 'string' },
          idempotencyKey: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { slideId } = request.params;
    const { type, geometry, style, authorId, idempotencyKey } = request.body;

    // Verify slide exists
    const slide = await getSlide(slideId);
    if (!slide) {
      reply.code(404);
      return { error: 'Slide not found' };
    }

    const { annotation, created } = await createAnnotation({
      slideId,
      type,
      geometry,
      style,
      authorId,
      idempotencyKey
    });

    // Emit SSE event only if actually created
    if (created) {
      eventBus.emit('sse', {
        event: 'annotation.created',
        data: {
          annotationId: annotation.annotation_id,
          slideId,
          type,
          authorId,
          timestamp: Date.now()
        }
      });
    }

    reply.code(created ? 201 : 200);
    return {
      annotationId: annotation.annotation_id,
      slideId: annotation.slide_id,
      type: annotation.type,
      geometry: annotation.geometry,
      style: annotation.style,
      authorId: annotation.author_id,
      version: annotation.version,
      createdAt: annotation.created_at,
      created
    };
  });

  // Update an annotation (with optimistic locking)
  fastify.patch('/annotations/:annotationId', {
    schema: {
      body: {
        type: 'object',
        required: ['expectedVersion'],
        properties: {
          expectedVersion: { type: 'integer', minimum: 1 },
          type: { type: 'string', enum: ['polygon', 'rectangle', 'ellipse', 'point', 'line', 'freehand'] },
          geometry: { type: 'object' },
          style: { type: 'object' }
        }
      }
    }
  }, async (request, reply) => {
    const { annotationId } = request.params;
    const { expectedVersion, type, geometry, style } = request.body;

    const updates = {};
    if (type !== undefined) updates.type = type;
    if (geometry !== undefined) updates.geometry = geometry;
    if (style !== undefined) updates.style = style;

    if (Object.keys(updates).length === 0) {
      reply.code(400);
      return { error: 'No updates provided' };
    }

    const result = await updateAnnotation(annotationId, expectedVersion, updates);

    if (result.error) {
      if (result.error === 'not_found') {
        reply.code(404);
        return { error: 'Annotation not found' };
      }
      if (result.error === 'deleted') {
        reply.code(410);
        return { error: 'Annotation has been deleted' };
      }
      if (result.error === 'version_conflict') {
        reply.code(409);
        return {
          error: 'Version conflict',
          expectedVersion,
          currentVersion: result.currentVersion
        };
      }
    }

    const annotation = result.annotation;

    // Emit SSE event
    eventBus.emit('sse', {
      event: 'annotation.updated',
      data: {
        annotationId: annotation.annotation_id,
        slideId: annotation.slide_id,
        version: annotation.version,
        timestamp: Date.now()
      }
    });

    return {
      annotationId: annotation.annotation_id,
      slideId: annotation.slide_id,
      type: annotation.type,
      geometry: annotation.geometry,
      style: annotation.style,
      authorId: annotation.author_id,
      version: annotation.version,
      updatedAt: annotation.updated_at
    };
  });

  // Delete an annotation (soft delete with optimistic locking)
  fastify.delete('/annotations/:annotationId', {
    schema: {
      querystring: {
        type: 'object',
        required: ['expectedVersion'],
        properties: {
          expectedVersion: { type: 'integer', minimum: 1 }
        }
      }
    }
  }, async (request, reply) => {
    const { annotationId } = request.params;
    const { expectedVersion } = request.query;

    const result = await deleteAnnotation(annotationId, expectedVersion);

    if (!result.success) {
      if (result.error === 'not_found') {
        reply.code(404);
        return { error: 'Annotation not found' };
      }
      if (result.error === 'already_deleted') {
        reply.code(410);
        return { error: 'Annotation already deleted' };
      }
      if (result.error === 'version_conflict') {
        reply.code(409);
        return {
          error: 'Version conflict',
          expectedVersion,
          currentVersion: result.currentVersion
        };
      }
    }

    // Emit SSE event
    eventBus.emit('sse', {
      event: 'annotation.deleted',
      data: {
        annotationId,
        slideId: result.annotation.slide_id,
        version: result.annotation.version,
        timestamp: Date.now()
      }
    });

    reply.code(204);
    return;
  });
}
