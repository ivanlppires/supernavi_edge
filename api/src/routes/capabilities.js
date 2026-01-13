export default async function capabilitiesRoutes(fastify) {
  fastify.get('/capabilities', async () => {
    return {
      mode: 'local',
      features: {
        tiles: true,
        annotations: true,
        sync: true
      },
      formats: {
        supported: ['svs', 'ndpi', 'tiff', 'mrxs'],
        primary: ['svs', 'ndpi']
      }
    };
  });
}
