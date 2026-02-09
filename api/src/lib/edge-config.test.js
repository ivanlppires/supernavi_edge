import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { join } from 'path';
import {
  getDefaults,
  validateConfig,
  loadConfig,
  saveConfig,
  getConfig,
  reloadConfig,
} from './edge-config.js';

describe('edge-config', () => {

  describe('getDefaults', () => {
    it('returns a complete config object', () => {
      const d = getDefaults();
      assert.equal(d.version, 1);
      assert.equal(d.source, 'defaults');
      assert.equal(d.slidesDirContainer, '/data/inbox');
      assert.equal(d.rawDirContainer, '/data/raw');
      assert.equal(d.derivedDirContainer, '/data/derived');
      assert.equal(d.stableSeconds, 15);
      assert.ok(d.caseBaseRegex);
      assert.equal(d.scanner.type, 'unknown');
    });

    it('returns fresh copies each time', () => {
      const a = getDefaults();
      const b = getDefaults();
      a.stableSeconds = 999;
      assert.equal(b.stableSeconds, 15);
    });
  });

  describe('validateConfig', () => {
    it('accepts a valid complete config', () => {
      const { valid, errors } = validateConfig({
        version: 1,
        source: 'wizard-cli',
        scanner: { type: 'motic', model: null },
        slidesDirHost: '/opt/motic/scans',
        slidesDirContainer: '/data/inbox',
        rawDirContainer: '/data/raw',
        derivedDirContainer: '/data/derived',
        stableSeconds: 15,
        caseBaseRegex: '^(AP\\d{6,12})',
      });
      assert.ok(valid, `Unexpected errors: ${errors.join(', ')}`);
      assert.equal(errors.length, 0);
    });

    it('accepts partial config and fills defaults', () => {
      const { valid, config } = validateConfig({ slidesDirHost: '/motic' });
      assert.ok(valid);
      assert.equal(config.slidesDirHost, '/motic');
      assert.equal(config.stableSeconds, 15); // default
    });

    it('rejects version != 1', () => {
      const { valid, errors } = validateConfig({ version: 2 });
      assert.ok(!valid);
      assert.ok(errors.some(e => e.includes('version')));
    });

    it('rejects empty slidesDirHost', () => {
      const { valid, errors } = validateConfig({ slidesDirHost: '' });
      assert.ok(!valid);
      assert.ok(errors.some(e => e.includes('slidesDirHost')));
    });

    it('rejects slidesDirContainer not starting with /', () => {
      const { valid, errors } = validateConfig({ slidesDirContainer: 'data/inbox' });
      assert.ok(!valid);
      assert.ok(errors.some(e => e.includes('slidesDirContainer')));
    });

    it('rejects stableSeconds < 1', () => {
      const { valid, errors } = validateConfig({ stableSeconds: 0 });
      assert.ok(!valid);
      assert.ok(errors.some(e => e.includes('stableSeconds')));
    });

    it('rejects stableSeconds > 300', () => {
      const { valid, errors } = validateConfig({ stableSeconds: 500 });
      assert.ok(!valid);
      assert.ok(errors.some(e => e.includes('stableSeconds')));
    });

    it('rejects invalid caseBaseRegex', () => {
      const { valid, errors } = validateConfig({ caseBaseRegex: '[invalid(' });
      assert.ok(!valid);
      assert.ok(errors.some(e => e.includes('caseBaseRegex')));
    });

    it('accepts valid caseBaseRegex', () => {
      const { valid } = validateConfig({ caseBaseRegex: '^(AP\\d+)' });
      assert.ok(valid);
    });
  });

  describe('saveConfig + loadConfig', () => {
    let tempDir;

    before(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'edge-cfg-test-'));
    });

    after(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('saves and loads config correctly', async () => {
      const configPath = join(tempDir, 'config', 'edge-config.json');
      const config = {
        ...getDefaults(),
        source: 'test',
        slidesDirHost: '/test/path',
        stableSeconds: 20,
      };

      await saveConfig(config, { path: configPath });

      // Verify file exists and is valid JSON
      const raw = JSON.parse(await readFile(configPath, 'utf8'));
      assert.equal(raw.source, 'test');
      assert.equal(raw.slidesDirHost, '/test/path');
      assert.equal(raw.stableSeconds, 20);
      assert.ok(raw.updatedAt);
      assert.ok(raw.createdAt);
    });
  });

  describe('getConfig', () => {
    it('returns defaults when nothing loaded', () => {
      const config = getConfig();
      assert.equal(config.version, 1);
      assert.ok(config.stableSeconds > 0);
    });
  });
});
