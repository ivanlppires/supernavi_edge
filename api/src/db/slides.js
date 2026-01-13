import { query } from './index.js';

export async function createSlide({ id, originalFilename, rawPath, format = 'unknown' }) {
  const result = await query(
    `INSERT INTO slides (id, original_filename, raw_path, status, format)
     VALUES ($1, $2, $3, 'queued', $4)
     ON CONFLICT (id) DO UPDATE SET
       original_filename = EXCLUDED.original_filename,
       raw_path = EXCLUDED.raw_path,
       format = EXCLUDED.format,
       status = 'queued'
     RETURNING *`,
    [id, originalFilename, rawPath, format]
  );
  return result.rows[0];
}

export async function updateSlide(id, updates) {
  const fields = [];
  const values = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(updates)) {
    const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    fields.push(`${dbKey} = $${paramIndex}`);
    values.push(value);
    paramIndex++;
  }

  values.push(id);
  const result = await query(
    `UPDATE slides SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );
  return result.rows[0];
}

export async function getSlide(id) {
  const result = await query('SELECT * FROM slides WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function listSlides() {
  const result = await query(
    'SELECT id, status, width, height, max_level, level_ready_max, format, created_at FROM slides ORDER BY created_at DESC'
  );
  return result.rows;
}

export async function createJob({ slideId, type }) {
  const result = await query(
    `INSERT INTO jobs (slide_id, type, status)
     VALUES ($1, $2, 'queued')
     RETURNING *`,
    [slideId, type]
  );
  return result.rows[0];
}

export async function updateJob(id, updates) {
  const fields = ['updated_at = NOW()'];
  const values = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(updates)) {
    const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    fields.push(`${dbKey} = $${paramIndex}`);
    values.push(value);
    paramIndex++;
  }

  values.push(id);
  const result = await query(
    `UPDATE jobs SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );
  return result.rows[0];
}

export async function updateLevelReadyMax(id, levelReadyMax) {
  await query(
    'UPDATE slides SET level_ready_max = $1 WHERE id = $2',
    [levelReadyMax, id]
  );
}
