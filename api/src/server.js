import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import autoLoad from '@fastify/autoload';
import sensible from '@fastify/sensible';
import cors from '@fastify/cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { runMigrations, closePool } from './db/index.js';
import { startWatcher } from './services/watcher.js';
import { closeRedis } from './lib/queue.js';
import { initTunnel, startTunnel, stopTunnel } from './services/tunnel.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DERIVED_DIR = process.env.DERIVED_DIR || '/data/derived';

async function buildApp() {
  const app = Fastify({
    logger: true,
    // Increase body limit for large slide files (2GB)
    bodyLimit: 2 * 1024 * 1024 * 1024
  });

  // Register core plugins
  await app.register(sensible);
  await app.register(cors, {
    origin: true,
    credentials: true
  });

  // Content type parser for binary uploads (SVS, TIFF, etc.)
  // Pass through raw stream for the upload endpoint
  app.addContentTypeParser('application/octet-stream', function (request, payload, done) {
    done(null, payload);
  });

  // Catch-all parser for unknown content types (for slide files with exotic MIME types)
  app.addContentTypeParser('*', function (request, payload, done) {
    // Only pass through raw stream for upload endpoint
    if (request.url.includes('/slides/upload')) {
      done(null, payload);
    } else {
      done(null, undefined);
    }
  });

  // Static files for derived content
  await app.register(fastifyStatic, {
    root: DERIVED_DIR,
    prefix: '/static/',
    decorateReply: false
  });

  // Auto-load plugins
  await app.register(autoLoad, {
    dir: join(__dirname, 'plugins'),
    options: {}
  });

  // Auto-load routes
  await app.register(autoLoad, {
    dir: join(__dirname, 'routes'),
    options: { prefix: '/v1' }
  });

  return app;
}

async function start() {
  console.log('SuperNavi Local Agent starting...');

  // Run database migrations
  console.log('Running database migrations...');
  let retries = 10;
  while (retries > 0) {
    try {
      await runMigrations();
      break;
    } catch (err) {
      retries--;
      if (retries === 0) {
        console.error('Failed to run migrations after retries:', err);
        process.exit(1);
      }
      console.log(`Database not ready, retrying in 2s... (${retries} retries left)`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Start file watcher
  console.log('Starting file watcher...');
  try {
    await startWatcher();
  } catch (err) {
    console.error('Failed to start watcher:', err);
  }

  // Build and start server
  const app = await buildApp();
  const port = process.env.PORT || 3000;
  const host = '0.0.0.0';

  // Initialize tunnel with the app (for fastify.inject)
  initTunnel(app);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
    stopTunnel();
    await app.close();
    await closePool();
    await closeRedis();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  try {
    await app.listen({ port, host });
    console.log(`SuperNavi Local Agent running on port ${port}`);

    // Start tunnel connection to cloud (if configured)
    startTunnel();
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();

// Export buildApp for tunnel client to use fastify.inject
export { buildApp };
