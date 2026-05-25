import { isReviewQueueEnabled } from '../lib/feature-flags.js';

export default async function capabilitiesRoutes(fastify) {
  fastify.get('/capabilities', async () => {
    return {
      mode: 'local',
      features: {
        tiles: true,
        annotations: true,
        sync: true,
        review_queue: isReviewQueueEnabled(),
      },
      formats: {
        supported: ['svs', 'ndpi', 'tiff', 'mrxs'],
        primary: ['svs', 'ndpi']
      }
    };
  });
}
