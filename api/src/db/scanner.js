import { query } from './index.js';

/**
 * Build SQL to check if a scanner file path has been processed.
 */
export function buildCheckExists(filePath) {
  return {
    sql: 'SELECT slide_id FROM scanner_files WHERE file_path = $1',
    params: [filePath],
  };
}

/**
 * Build SQL to insert a scanner file tracking record.
 */
export function buildInsertScannerFile({ filePath, slideId, scannerBarcode, scannerGuid, scanDatetime }) {
  return {
    sql: `INSERT INTO scanner_files (file_path, slide_id, scanner_barcode, scanner_guid, scan_datetime)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (file_path) DO NOTHING`,
    params: [filePath, slideId, scannerBarcode, scannerGuid, scanDatetime],
  };
}

/**
 * Check if a scanner file path has already been processed.
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
export async function scannerFileExists(filePath) {
  const { sql, params } = buildCheckExists(filePath);
  const result = await query(sql, params);
  return result.rows.length > 0;
}

/**
 * Insert a scanner file tracking record.
 */
export async function insertScannerFile({ filePath, slideId, scannerBarcode, scannerGuid, scanDatetime }) {
  const { sql, params } = buildInsertScannerFile({ filePath, slideId, scannerBarcode, scannerGuid, scanDatetime });
  await query(sql, params);
}

/**
 * Get all known scanner file paths (for bulk dedup check).
 * @returns {Promise<Set<string>>}
 */
export async function getAllScannerFilePaths() {
  const result = await query('SELECT file_path FROM scanner_files');
  return new Set(result.rows.map(r => r.file_path));
}
