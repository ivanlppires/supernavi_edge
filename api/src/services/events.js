/**
 * SSE Event Emitter for real-time updates
 *
 * Pipeline Events:
 * - slide:import - New slide detected in inbox
 * - slide:ready - Slide processing complete (P0 done)
 * - tile:generated - Tile generated on-demand
 * - tile:pending - Tile generation started
 *
 * Collaboration Events:
 * - case.created - New case created
 * - case.slide_linked - Slide linked to case
 * - case.slide_unlinked - Slide unlinked from case
 * - annotation.created - New annotation created
 * - annotation.updated - Annotation updated
 * - annotation.deleted - Annotation soft deleted
 * - thread.created - New discussion thread created
 * - message.created - New message in thread
 */

import { EventEmitter } from 'events';
import { createClient } from 'redis';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

class SSEEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100); // Support many SSE clients
    this.redisSubscriber = null;
  }

  /**
   * Subscribe to Redis pub/sub for events from processor
   */
  async subscribeToRedis() {
    if (this.redisSubscriber) return;

    try {
      this.redisSubscriber = createClient({ url: redisUrl });
      this.redisSubscriber.on('error', err => console.error('Redis subscriber error:', err));
      await this.redisSubscriber.connect();

      await this.redisSubscriber.subscribe('supernavi:events', (message) => {
        try {
          const { event, data } = JSON.parse(message);
          this.emit('sse', { event, data });
        } catch (err) {
          console.error('Failed to parse Redis event:', err.message);
        }
      });

      console.log('Subscribed to Redis events channel');
    } catch (err) {
      console.error('Failed to subscribe to Redis:', err.message);
    }
  }

  /**
   * Emit slide import event
   */
  emitSlideImport(slideId, filename, format) {
    this.emit('sse', {
      event: 'slide:import',
      data: { slideId, filename, format, timestamp: Date.now() }
    });
  }

  /**
   * Emit slide ready event (called from Redis subscriber)
   */
  emitSlideReady(slideId, width, height, maxLevel) {
    this.emit('sse', {
      event: 'slide:ready',
      data: { slideId, width, height, maxLevel, timestamp: Date.now() }
    });
  }

  /**
   * Emit tile pending event
   */
  emitTilePending(slideId, z, x, y) {
    this.emit('sse', {
      event: 'tile:pending',
      data: { slideId, z, x, y, timestamp: Date.now() }
    });
  }

  /**
   * Emit tile generated event
   */
  emitTileGenerated(slideId, z, x, y) {
    this.emit('sse', {
      event: 'tile:generated',
      data: { slideId, z, x, y, timestamp: Date.now() }
    });
  }
}

// Singleton instance
export const eventBus = new SSEEventBus();

// Auto-subscribe to Redis when module is loaded
eventBus.subscribeToRedis().catch(err => {
  console.error('Failed to setup Redis subscription:', err.message);
});
