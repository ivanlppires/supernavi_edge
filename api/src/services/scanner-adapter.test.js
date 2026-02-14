import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { parseDsmeta, parseMoticPath } from '../lib/dsmeta-parser.js';

describe('scanner-adapter integration (filesystem only)', () => {
  let scannerDir;

  before(async () => {
    scannerDir = await mkdtemp(join(tmpdir(), 'scanner-test-'));

    // Slide 1: full structure with .dsmeta
    const slide1Dir = join(scannerDir, '2026', '0120', 'F278D360-BCCB-42D0-9F64-0587B91DEB50', '485948_20251212151927');
    await mkdir(slide1Dir, { recursive: true });
    await writeFile(join(slide1Dir, '485948_20251212151927.svs'), 'fake-svs-data');

    const dsmeta1 = join(slide1Dir, '485948_20251212151927.svs.dsmeta');
    await mkdir(dsmeta1);
    await writeFile(join(dsmeta1, 'info.txt'), [
      '[info]',
      'Guid=F278D360-BCCB-42D0-9F64-0587B91DEB50',
      'mifwidth=55333',
      'mifheight=22294',
      'Barcode=485948',
    ].join('\r\n'));
    await writeFile(join(dsmeta1, '1.jpg'), 'fake-thumb');

    // Slide 2: different date and barcode
    const slide2Dir = join(scannerDir, '2025', '1114', 'AAAABBBB-CCCC-DDDD-EEEE-FFFFFFFFFFFF', '999001_20251114093000');
    await mkdir(slide2Dir, { recursive: true });
    await writeFile(join(slide2Dir, '999001_20251114093000.svs'), 'fake-svs-data-2');

    // Non-SVS file (should be ignored)
    await writeFile(join(slide2Dir, 'readme.txt'), 'ignore me');
  });

  after(async () => {
    await rm(scannerDir, { recursive: true, force: true });
  });

  it('finds SVS files recursively, skipping .dsmeta dirs', async () => {
    const { readdir } = await import('fs/promises');
    const { extname } = await import('path');

    const WSI_EXTS = new Set(['.svs', '.ndpi', '.tif', '.tiff', '.mrxs']);

    async function findSvs(dir) {
      const results = [];
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.endsWith('.dsmeta')) continue;
          results.push(...await findSvs(full));
        } else if (entry.isFile() && WSI_EXTS.has(extname(entry.name).toLowerCase())) {
          results.push(full);
        }
      }
      return results;
    }

    const files = await findSvs(scannerDir);
    assert.equal(files.length, 2, `Expected 2 SVS files, got ${files.length}`);
    assert.ok(files.some(f => f.includes('485948_20251212151927.svs')));
    assert.ok(files.some(f => f.includes('999001_20251114093000.svs')));
  });

  it('parses .dsmeta from discovered files', async () => {
    const dsmetaPath = join(
      scannerDir, '2026', '0120',
      'F278D360-BCCB-42D0-9F64-0587B91DEB50',
      '485948_20251212151927',
      '485948_20251212151927.svs.dsmeta'
    );
    const result = await parseDsmeta(dsmetaPath);
    assert.ok(result);
    assert.equal(result.barcode, '485948');
    assert.equal(result.width, 55333);
    assert.equal(result.height, 22294);
  });

  it('parseMoticPath extracts metadata from scanner paths', () => {
    const fakePath = '/scanner/2026/0120/F278D360-BCCB-42D0-9F64-0587B91DEB50/485948_20251212151927/485948_20251212151927.svs';
    const result = parseMoticPath(fakePath);
    assert.ok(result);
    assert.equal(result.barcode, '485948');
    assert.equal(result.year, '2026');
    assert.equal(result.monthday, '0120');
    assert.equal(result.guid, 'F278D360-BCCB-42D0-9F64-0587B91DEB50');
    assert.equal(result.scanDatetime, '20251212151927');
  });
});
