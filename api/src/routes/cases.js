/**
 * Cases API Routes
 * Local-first case management
 */

import {
  createCase,
  getCase,
  listCases,
  linkSlideToCase,
  unlinkSlideFromCase,
  findCaseByExternalRef
} from '../db/collaboration.js';
import { getSlide } from '../db/slides.js';
import { eventBus } from '../services/events.js';

export default async function casesRoutes(fastify) {
  // Create a new case
  fastify.post('/cases', {
    schema: {
      body: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', minLength: 1 },
          externalRef: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { title, externalRef } = request.body;

    const caseRecord = await createCase({ title, externalRef });

    // Emit SSE event
    eventBus.emit('sse', {
      event: 'case.created',
      data: {
        caseId: caseRecord.case_id,
        title: caseRecord.title,
        timestamp: Date.now()
      }
    });

    reply.code(201);
    return {
      caseId: caseRecord.case_id,
      title: caseRecord.title,
      externalRef: caseRecord.external_ref,
      createdAt: caseRecord.created_at
    };
  });

  // List all cases
  fastify.get('/cases', async () => {
    const cases = await listCases();
    return {
      items: cases.map(c => ({
        caseId: c.case_id,
        title: c.title,
        externalRef: c.external_ref,
        slideCount: parseInt(c.slide_count, 10),
        createdAt: c.created_at,
        updatedAt: c.updated_at
      }))
    };
  });

  // Get a case by external reference (AP number)
  fastify.get('/cases/by-ref/:caseBase', async (request, reply) => {
    const { caseBase } = request.params;

    const caseRecord = await findCaseByExternalRef(caseBase.toUpperCase());
    if (!caseRecord) {
      reply.code(404);
      return { error: 'Case not found' };
    }

    return {
      caseId: caseRecord.case_id,
      title: caseRecord.title,
      caseBase: caseRecord.external_ref,
      createdAt: caseRecord.created_at,
      updatedAt: caseRecord.updated_at,
      slides: caseRecord.slides.map(s => ({
        slideId: s.id,
        filename: s.original_filename,
        status: s.status,
        width: s.width,
        height: s.height,
        format: s.format,
        linkedAt: s.linked_at
      }))
    };
  });

  // Get a specific case with linked slides
  fastify.get('/cases/:caseId', async (request, reply) => {
    const { caseId } = request.params;

    const caseRecord = await getCase(caseId);
    if (!caseRecord) {
      reply.code(404);
      return { error: 'Case not found' };
    }

    return {
      caseId: caseRecord.case_id,
      title: caseRecord.title,
      externalRef: caseRecord.external_ref,
      createdAt: caseRecord.created_at,
      updatedAt: caseRecord.updated_at,
      slides: caseRecord.slides.map(s => ({
        slideId: s.id,
        originalFilename: s.original_filename,
        status: s.status,
        width: s.width,
        height: s.height,
        format: s.format,
        linkedAt: s.linked_at
      }))
    };
  });

  // Link a slide to a case
  fastify.post('/cases/:caseId/slides', {
    schema: {
      body: {
        type: 'object',
        required: ['slideId'],
        properties: {
          slideId: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { caseId } = request.params;
    const { slideId } = request.body;

    // Verify case exists
    const caseRecord = await getCase(caseId);
    if (!caseRecord) {
      reply.code(404);
      return { error: 'Case not found' };
    }

    // Verify slide exists
    const slide = await getSlide(slideId);
    if (!slide) {
      reply.code(404);
      return { error: 'Slide not found' };
    }

    const link = await linkSlideToCase(caseId, slideId);
    if (!link) {
      // Already linked
      reply.code(200);
      return { message: 'Slide already linked to case' };
    }

    // Emit SSE event
    eventBus.emit('sse', {
      event: 'case.slide_linked',
      data: {
        caseId,
        slideId,
        timestamp: Date.now()
      }
    });

    reply.code(201);
    return {
      caseId,
      slideId,
      linkedAt: link.linked_at
    };
  });

  // Unlink a slide from a case
  fastify.delete('/cases/:caseId/slides/:slideId', async (request, reply) => {
    const { caseId, slideId } = request.params;

    // Verify case exists
    const caseRecord = await getCase(caseId);
    if (!caseRecord) {
      reply.code(404);
      return { error: 'Case not found' };
    }

    const unlinked = await unlinkSlideFromCase(caseId, slideId);
    if (!unlinked) {
      reply.code(404);
      return { error: 'Slide not linked to this case' };
    }

    // Emit SSE event
    eventBus.emit('sse', {
      event: 'case.slide_unlinked',
      data: {
        caseId,
        slideId,
        timestamp: Date.now()
      }
    });

    reply.code(204);
    return;
  });
}
