/**
 * SuperNavi Edge - Scanner Auto-Detection
 *
 * Scans the filesystem for known scanner output directories (MOTIC, Hamamatsu, etc.)
 * Works on both host (setup.js) and inside Docker container (admin endpoint).
 */

import { readdir, stat, access } from 'fs/promises';
import { join, extname } from 'path';
import { constants } from 'fs';

const WSI_EXTENSIONS = new Set(['.svs', '.ndpi', '.tif', '.tiff', '.mrxs', '.scn']);

const CANDIDATES = [
  // MOTIC - Linux
  { path: '/opt/motic/scans',       scannerType: 'motic', model: null, score: 100, os: 'linux' },
  { path: '/opt/motic/slides',      scannerType: 'motic', model: null, score: 95,  os: 'linux' },
  { path: '/home/motic/scans',      scannerType: 'motic', model: null, score: 90,  os: 'linux' },
  { path: '/motic',                 scannerType: 'motic', model: null, score: 85,  os: 'linux' },

  // MOTIC - Windows
  { path: 'C:\\Motic\\Scans',       scannerType: 'motic', model: null, score: 100, os: 'windows' },
  { path: 'C:\\Motic\\SlideScanner', scannerType: 'motic', model: null, score: 95,  os: 'windows' },
  { path: 'D:\\Motic\\Scans',       scannerType: 'motic', model: null, score: 90,  os: 'windows' },
  { path: 'C:\\MoticImageExport',   scannerType: 'motic', model: null, score: 85,  os: 'windows' },
  { path: 'C:\\ProgramData\\Motic', scannerType: 'motic', model: null, score: 80,  os: 'windows' },

  // Hamamatsu
  { path: 'C:\\NDP.view2\\Images',  scannerType: 'hamamatsu', model: null, score: 80, os: 'windows' },
  { path: '/opt/hamamatsu/ndpi',    scannerType: 'hamamatsu', model: null, score: 80, os: 'linux' },

  // Leica / Aperio
  { path: 'C:\\Aperio\\Images',     scannerType: 'leica', model: 'Aperio', score: 75, os: 'windows' },
  { path: '/opt/aperio/images',     scannerType: 'leica', model: 'Aperio', score: 75, os: 'linux' },

  // Generic Linux scanner locations
  { path: '/data/scanner',          scannerType: 'generic', model: null, score: 60, os: 'linux' },
  { path: '/mnt/scanner',           scannerType: 'generic', model: null, score: 55, os: 'linux' },
  { path: '/srv/scanner',           scannerType: 'generic', model: null, score: 50, os: 'linux' },

  // Home-based scanner folders (Linux)
  { path: '/home/scanner',          scannerType: 'generic', model: null, score: 45, os: 'linux' },
];

/**
 * Detect current OS.
 * @returns {'windows' | 'linux'}
 */
export function detectOS() {
  return process.platform === 'win32' ? 'windows' : 'linux';
}

/**
 * Normalize a Windows path to WSL path if running under Linux.
 * E.g. C:\Motic\Scans → /mnt/c/Motic/Scans
 */
function normalizePathForOS(candidatePath) {
  if (process.platform !== 'win32' && /^[A-Z]:\\/.test(candidatePath)) {
    const drive = candidatePath[0].toLowerCase();
    const rest = candidatePath.slice(3).replace(/\\/g, '/');
    return `/mnt/${drive}/${rest}`;
  }
  return candidatePath;
}

/**
 * Get the full list of candidate paths (all OS).
 * @returns {Array<{path: string, scannerType: string, model: string|null, score: number, os: string}>}
 */
export function getAllCandidates() {
  return [...CANDIDATES];
}

/**
 * Get candidate paths filtered by current OS.
 * @returns {Array<{path: string, scannerType: string, model: string|null, score: number, os: string}>}
 */
export function getCandidatePaths() {
  const os = detectOS();
  return CANDIDATES.filter(c => c.os === os || c.os === 'both');
}

/**
 * Scan a directory (non-recursive) for WSI slide files.
 * @param {string} dirPath
 * @returns {Promise<{slideCount: number, extensions: Set<string>, hasRecent: boolean}>}
 */
async function scanForSlides(dirPath) {
  const extensions = new Set();
  let slideCount = 0;
  let hasRecent = false;
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (WSI_EXTENSIONS.has(ext)) {
        slideCount++;
        extensions.add(ext);
        if (!hasRecent) {
          try {
            const s = await stat(join(dirPath, entry.name));
            if (s.mtimeMs > thirtyDaysAgo) hasRecent = true;
          } catch { /* ignore stat errors */ }
        }
      }
      // Early exit after finding enough evidence
      if (slideCount >= 10 && hasRecent) break;
    }
  } catch { /* directory not readable */ }

  return { slideCount, extensions, hasRecent };
}

/**
 * Score a candidate directory.
 *
 * Scoring: baseScore + extensionBonus (max 40) + recencyBonus (10) + nonEmptyBonus (5)
 *
 * @param {string} dirPath - Resolved path to check
 * @param {{path: string, scannerType: string, model: string|null, score: number, os: string}} candidate
 * @returns {Promise<{candidate: object, finalScore: number, exists: boolean, slideCount: number, recentFiles: boolean}>}
 */
export async function scoreCandidate(dirPath, candidate) {
  const result = {
    candidate,
    finalScore: 0,
    exists: false,
    slideCount: 0,
    recentFiles: false,
  };

  try {
    await access(dirPath, constants.R_OK);
    result.exists = true;
  } catch {
    return result;
  }

  const { slideCount, extensions, hasRecent } = await scanForSlides(dirPath);
  result.slideCount = slideCount;
  result.recentFiles = hasRecent;

  const extensionBonus = Math.min(20 * extensions.size, 40);
  const recencyBonus = hasRecent ? 10 : 0;
  const nonEmptyBonus = slideCount > 0 ? 5 : 0;

  result.finalScore = candidate.score + extensionBonus + recencyBonus + nonEmptyBonus;
  return result;
}

/**
 * Auto-detect scanner directories. Filters by current OS, scores each, returns sorted.
 * @returns {Promise<Array<{candidate: object, finalScore: number, exists: boolean, slideCount: number, recentFiles: boolean}>>}
 */
export async function autoDetectScannerDirs() {
  const candidates = getCandidatePaths();
  const results = await Promise.allSettled(
    candidates.map(c => {
      const resolvedPath = normalizePathForOS(c.path);
      return scoreCandidate(resolvedPath, c);
    })
  );

  return results
    .filter(r => r.status === 'fulfilled' && r.value.exists)
    .map(r => r.value)
    .sort((a, b) => b.finalScore - a.finalScore);
}

/**
 * Get the best candidate, or null if none found with score >= 50.
 * @returns {Promise<{path: string, scannerType: string, model: string|null, score: number, slideCount: number} | null>}
 */
export async function getBestCandidate() {
  const results = await autoDetectScannerDirs();
  if (results.length === 0) return null;

  const best = results[0];
  if (best.finalScore < 50) return null;

  return {
    path: normalizePathForOS(best.candidate.path),
    scannerType: best.candidate.scannerType,
    model: best.candidate.model,
    score: best.finalScore,
    slideCount: best.slideCount,
  };
}
