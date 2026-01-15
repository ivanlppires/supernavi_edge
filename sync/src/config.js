/**
 * Sync Engine Configuration
 */

export const config = {
  // Database
  databaseUrl: process.env.DATABASE_URL || 'postgres://supernavi:supernavi@localhost:5432/supernavi',

  // Cloud API
  cloudSyncUrl: process.env.CLOUD_SYNC_URL || 'http://mock-cloud:4000',
  syncToken: process.env.SYNC_TOKEN || 'dev-token',

  // Agent Identity
  agentId: process.env.AGENT_ID || 'local-agent-001',
  labId: process.env.LAB_ID || 'lab-001',

  // Sync Parameters
  syncBatchSize: parseInt(process.env.SYNC_BATCH_SIZE || '50', 10),
  syncIntervalMs: parseInt(process.env.SYNC_INTERVAL_MS || '2000', 10),
  syncMaxRetry: parseInt(process.env.SYNC_MAX_RETRY || '10', 10),

  // Backoff
  initialBackoffMs: 1000,
  maxBackoffMs: 60000,
};

/**
 * Structured logger
 */
export const log = {
  info: (msg, data = {}) => {
    console.log(JSON.stringify({
      level: 'info',
      time: new Date().toISOString(),
      service: 'sync',
      msg,
      ...data
    }));
  },
  warn: (msg, data = {}) => {
    console.log(JSON.stringify({
      level: 'warn',
      time: new Date().toISOString(),
      service: 'sync',
      msg,
      ...data
    }));
  },
  error: (msg, data = {}) => {
    console.log(JSON.stringify({
      level: 'error',
      time: new Date().toISOString(),
      service: 'sync',
      msg,
      ...data
    }));
  },
  debug: (msg, data = {}) => {
    if (process.env.DEBUG) {
      console.log(JSON.stringify({
        level: 'debug',
        time: new Date().toISOString(),
        service: 'sync',
        msg,
        ...data
      }));
    }
  }
};
