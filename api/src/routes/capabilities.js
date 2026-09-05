export default async function capabilitiesRoutes(fastify) {
  fastify.get('/capabilities', async () => {
    return {
      mode: 'local',
      features: {
        tiles: true,
        annotations: true,
        sync: true,
        // Names come from OCR and are confirmed by a person in the dashboard queue
        review_queue: true,
      },
      formats: {
        supported: ['svs', 'ndpi', 'tiff', 'mrxs'],
        primary: ['svs', 'ndpi']
      }
    };
  });
}
