import { query } from './index.js';

/**
 * Fetch the clinical context for a case base, or null if none exists.
 */
export async function getCaseContext(caseBase) {
  const result = await query(
    `SELECT case_base, exam_type, subtipo, sexo, idade, material, hipotese,
            created_at, updated_at
       FROM case_contexts
      WHERE case_base = $1`,
    [caseBase]
  );
  return result.rows[0] || null;
}

/**
 * Idempotent insert/update of a case's clinical context.
 * Returns the stored row.
 */
export async function upsertCaseContext({ caseBase, examType, subtipo, sexo, idade, material, hipotese }) {
  const result = await query(
    `INSERT INTO case_contexts (case_base, exam_type, subtipo, sexo, idade, material, hipotese, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (case_base) DO UPDATE SET
       exam_type  = EXCLUDED.exam_type,
       subtipo    = EXCLUDED.subtipo,
       sexo       = EXCLUDED.sexo,
       idade      = EXCLUDED.idade,
       material   = EXCLUDED.material,
       hipotese   = EXCLUDED.hipotese,
       updated_at = NOW()
     RETURNING *`,
    [caseBase, examType, subtipo, sexo, idade, material, hipotese ?? null]
  );
  return result.rows[0];
}
