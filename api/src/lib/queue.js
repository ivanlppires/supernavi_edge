import { createClient } from 'redis';

let client = null;

export async function getRedisClient() {
  if (!client) {
    client = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379'
    });
    client.on('error', err => console.error('Redis error:', err));
    await client.connect();
  }
  return client;
}

export async function enqueueJob(jobData) {
  const redis = await getRedisClient();
  await redis.lPush('jobs:pending', JSON.stringify(jobData));
  console.log(`Enqueued job: ${jobData.type} for slide ${jobData.slideId}`);
}

export async function closeRedis() {
  if (client) {
    await client.quit();
    client = null;
  }
}
