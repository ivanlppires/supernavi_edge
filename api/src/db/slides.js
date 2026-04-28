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
    `SELECT id, original_filename, status, width, height, max_level, level_ready_max,
            format, app_mag, mpp, created_at, ocr_status, external_case_base,
            external_slide_label, dsmeta_path, raw_path, pipeline_mode, tilegen_status,
            cloud_upload_status, latest_error, latest_error_stage, latest_error_at
       FROM slides ORDER BY created_at DESC`
  );
  return result.rows;
}

export async function findSlideByFilename(filename) {
  const result = await query(
    'SELECT * FROM slides WHERE original_filename = $1 ORDER BY created_at DESC LIMIT 1',
    [filename]
  );
  return result.rows[0] || null;
}

export async function createJob({ slideId, type }) {
  // Skip if an active job (queued or running) already exists for this slide+type
  const existing = await query(
    `SELECT id FROM jobs WHERE slide_id = $1 AND type = $2 AND status IN ('queued', 'running') LIMIT 1`,
    [slideId, type]
  );
  if (existing.rows.length > 0) {
    console.log(`[jobs] Skipping duplicate ${type} for ${slideId.substring(0, 12)} (existing: ${existing.rows[0].id})`);
    return null;
  }

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

/**
 * Update a slide's original_filename and external fields after OCR rename.
 */
export async function updateSlideOcr(id, { originalFilename, externalCaseId, externalCaseBase, externalSlideLabel, ocrStatus, dsmetaPath }) {
  const sets = [];
  const vals = [];
  let idx = 1;

  if (originalFilename !== undefined) { sets.push(`original_filename = $${idx++}`); vals.push(originalFilename); }
  if (externalCaseId !== undefined) { sets.push(`external_case_id = $${idx++}`); vals.push(externalCaseId); }
  if (externalCaseBase !== undefined) { sets.push(`external_case_base = $${idx++}`); vals.push(externalCaseBase); }
  if (externalSlideLabel !== undefined) { sets.push(`external_slide_label = $${idx++}`); vals.push(externalSlideLabel); }
  if (ocrStatus !== undefined) { sets.push(`ocr_status = $${idx++}`); vals.push(ocrStatus); }
  if (dsmetaPath !== undefined) { sets.push(`dsmeta_path = $${idx++}`); vals.push(dsmetaPath); }

  if (sets.length === 0) return;

  vals.push(id);
  await query(
    `UPDATE slides SET ${sets.join(', ')} WHERE id = $${idx}`,
    vals
  );
}

/**
 * Delete a slide and its associated jobs
 * @param {string} id - Slide ID
 * @returns {Promise<{deleted: boolean, slide: object|null}>}
 */
export async function deleteSlide(id) {
  // First get the slide info before deleting
  const slide = await getSlide(id);
  if (!slide) {
    return { deleted: false, slide: null };
  }

  // Delete associated jobs first (foreign key constraint)
  await query('DELETE FROM jobs WHERE slide_id = $1', [id]);

  // Delete the slide
  await query('DELETE FROM slides WHERE id = $1', [id]);

  return { deleted: true, slide };
}

/**
 * Deduplicate a slide label by appending B, C, D... if another slide
 * already has the same external_slide_label.
 *
 * @param {string} fullName - The OCR-parsed full name (e.g., "AP26000388A1")
 * @param {string} slideId  - Current slide ID (excluded from duplicate check)
 * @returns {Promise<string>} - Deduplicated fullName (e.g., "AP26000388A1B" if dup)
 */
export async function deduplicateSlideLabel(fullName, slideId) {
  const existing = await query(
    'SELECT id FROM slides WHERE external_slide_label = $1 AND id != $2 LIMIT 1',
    [fullName, slideId]
  );

  if (existing.rows.length === 0) return fullName;

  // Append B, C, D... until unique
  const suffixes = 'BCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const ch of suffixes) {
    const candidate = fullName + ch;
    const dup = await query(
      'SELECT id FROM slides WHERE external_slide_label = $1 AND id != $2 LIMIT 1',
      [candidate, slideId]
    );
    if (dup.rows.length === 0) {
      console.log(`[Dedup] "${fullName}" already exists, using "${candidate}"`);
      return candidate;
    }
  }

  // Extremely unlikely: 25+ duplicates — use timestamp suffix
  const ts = Date.now().toString(36);
  console.log(`[Dedup] "${fullName}" exhausted letter suffixes, using timestamp: "${fullName}_${ts}"`);
  return `${fullName}_${ts}`;
}

/**
 * List slides with pending OCR status for retry.
 */
export async function listPendingOcrSlides() {
  const result = await query(
    `SELECT id, original_filename, dsmeta_path, format FROM slides WHERE ocr_status = 'pending'`
  );
  return result.rows;
}
