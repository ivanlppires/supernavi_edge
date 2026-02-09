import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import {
  getAllCandidates,
  getCandidatePaths,
  detectOS,
  scoreCandidate,
  autoDetectScannerDirs,
  getBestCandidate,
} from './motic-detect.js';

describe('motic-detect', () => {

  describe('getAllCandidates', () => {
    it('returns a non-empty array', () => {
      const candidates = getAllCandidates();
      assert.ok(candidates.length > 0);
    });

    it('all candidates have required fields', () => {
      for (const c of getAllCandidates()) {
        assert.ok(typeof c.path === 'string' && c.path.length > 0);
        assert.ok(typeof c.scannerType === 'string');
        assert.ok(typeof c.score === 'number' && c.score > 0);
        assert.ok(c.os === 'linux' || c.os === 'windows' || c.os === 'both');
      }
    });

    it('includes both linux and windows candidates', () => {
      const candidates = getAllCandidates();
      assert.ok(candidates.some(c => c.os === 'linux'));
      assert.ok(candidates.some(c => c.os === 'windows'));
    });
  });

  describe('getCandidatePaths', () => {
    it('filters by current OS', () => {
      const expected = detectOS();
      const candidates = getCandidatePaths();
      for (const c of candidates) {
        assert.ok(c.os === expected || c.os === 'both',
          `Expected os=${expected} or both, got ${c.os} for ${c.path}`);
      }
    });
  });

  describe('scoreCandidate', () => {
    let tempDir;

    before(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'motic-test-'));
    });

    after(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('returns exists: false for non-existent directory', async () => {
      const result = await scoreCandidate('/nonexistent/path/xyz', {
        path: '/nonexistent', scannerType: 'test', model: null, score: 100, os: 'linux'
      });
      assert.equal(result.exists, false);
      assert.equal(result.finalScore, 0);
    });

    it('returns base score for existing empty directory', async () => {
      const emptyDir = join(tempDir, 'empty');
      await mkdir(emptyDir);
      const result = await scoreCandidate(emptyDir, {
        path: emptyDir, scannerType: 'test', model: null, score: 80, os: 'linux'
      });
      assert.equal(result.exists, true);
      assert.equal(result.slideCount, 0);
      assert.equal(result.finalScore, 80); // base only, no bonuses
    });

    it('adds bonus for directories containing SVS files', async () => {
      const svsDir = join(tempDir, 'with-svs');
      await mkdir(svsDir);
      await writeFile(join(svsDir, 'slide1.svs'), 'fake');
      await writeFile(join(svsDir, 'slide2.svs'), 'fake');

      const result = await scoreCandidate(svsDir, {
        path: svsDir, scannerType: 'test', model: null, score: 80, os: 'linux'
      });
      assert.equal(result.exists, true);
      assert.equal(result.slideCount, 2);
      // base(80) + extension(20 * 1 unique ext = 20) + recency(10) + nonEmpty(5) = 115
      assert.equal(result.finalScore, 115);
    });

    it('adds bonus for multiple extension types', async () => {
      const multiDir = join(tempDir, 'with-multi');
      await mkdir(multiDir);
      await writeFile(join(multiDir, 'slide.svs'), 'fake');
      await writeFile(join(multiDir, 'slide.ndpi'), 'fake');
      await writeFile(join(multiDir, 'slide.tiff'), 'fake');

      const result = await scoreCandidate(multiDir, {
        path: multiDir, scannerType: 'test', model: null, score: 50, os: 'linux'
      });
      // base(50) + extension(min(20*3, 40) = 40) + recency(10) + nonEmpty(5) = 105
      assert.equal(result.finalScore, 105);
    });

    it('caps extension bonus at 40', async () => {
      const manyDir = join(tempDir, 'with-many');
      await mkdir(manyDir);
      await writeFile(join(manyDir, 'a.svs'), 'fake');
      await writeFile(join(manyDir, 'b.ndpi'), 'fake');
      await writeFile(join(manyDir, 'c.tif'), 'fake');
      await writeFile(join(manyDir, 'd.mrxs'), 'fake');
      await writeFile(join(manyDir, 'e.scn'), 'fake');

      const result = await scoreCandidate(manyDir, {
        path: manyDir, scannerType: 'test', model: null, score: 50, os: 'linux'
      });
      // extension bonus capped at 40, not 20*5=100
      // base(50) + ext(40) + recency(10) + nonEmpty(5) = 105
      assert.equal(result.finalScore, 105);
    });

    it('ignores non-slide files', async () => {
      const txtDir = join(tempDir, 'with-txt');
      await mkdir(txtDir);
      await writeFile(join(txtDir, 'readme.txt'), 'not a slide');
      await writeFile(join(txtDir, 'photo.jpg'), 'not a slide');

      const result = await scoreCandidate(txtDir, {
        path: txtDir, scannerType: 'test', model: null, score: 80, os: 'linux'
      });
      assert.equal(result.slideCount, 0);
      assert.equal(result.finalScore, 80); // base only
    });
  });

  describe('autoDetectScannerDirs', () => {
    it('returns an array sorted by finalScore descending', async () => {
      const results = await autoDetectScannerDirs();
      assert.ok(Array.isArray(results));
      for (let i = 1; i < results.length; i++) {
        assert.ok(results[i - 1].finalScore >= results[i].finalScore,
          'Results should be sorted by finalScore descending');
      }
    });

    it('only returns existing directories', async () => {
      const results = await autoDetectScannerDirs();
      for (const r of results) {
        assert.equal(r.exists, true);
      }
    });
  });

  describe('getBestCandidate', () => {
    it('returns null or a valid candidate object', async () => {
      const best = await getBestCandidate();
      if (best !== null) {
        assert.ok(typeof best.path === 'string');
        assert.ok(typeof best.scannerType === 'string');
        assert.ok(typeof best.score === 'number');
        assert.ok(best.score >= 50);
      }
    });
  });
});
