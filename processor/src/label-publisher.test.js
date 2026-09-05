import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { bigtiffPrefix, buildBigtiffPublishedPayload, uploadLabelPhoto } from './label-publisher.js';

describe('bigtiffPrefix', () => {
  it('derives the slide prefix from the slide.tif key', () => {
    assert.equal(bigtiffPrefix('slides/c1b7217e/slide.tif'), 'slides/c1b7217e/');
  });
  it('returns null for missing or flat keys', () => {
    assert.equal(bigtiffPrefix(null), null);
    assert.equal(bigtiffPrefix(''), null);
    assert.equal(bigtiffPrefix('slide.tif'), null);
  });
});

describe('buildBigtiffPublishedPayload', () => {
  const slide = {
    id: 'slide-1', width: 66192, height: 142109, max_level: 18, s3_bigtiff_key: 'slides/slide-1/slide.tif',
    bigtiff_size: '904350614', external_case_id: 'pathoweb:AP26002614', external_case_base: 'AP26002614', external_slide_label: 'AP26002614A',
  };
  const wasabi = { bucket: 'b', region: 'us-east-1', endpoint: 'https://s3.example', prefixBase: 'previews' };

  it('mirrors the BIGTIFF job payload and carries label_key when given', () => {
    const p = buildBigtiffPublishedPayload({ slide, wasabi, s3Prefix: 'slides/slide-1/', labelKey: 'slides/slide-1/label.jpg' });
    assert.equal(p.slide_id, 'slide-1');
    assert.equal(p.label_key, 'slides/slide-1/label.jpg');
    assert.equal(p.thumb_key, 'slides/slide-1/thumb.jpg');
    assert.equal(p.manifest_key, 'slides/slide-1/manifest.json');
    assert.equal(p.pipeline_mode, 'bigtiff_iiif');
    assert.equal(p.bigtiff_key, 'slides/slide-1/slide.tif');
    assert.equal(p.max_preview_level, 18);
    assert.equal(p.external_case_base, 'AP26002614');
    assert.equal(p.wasabi_bucket, 'b');
    assert.equal(p.tile_size, 256);
  });

  it('converts the BIGINT bigtiff_size (a string from pg) to a number', () => {
    const p = buildBigtiffPublishedPayload({ slide, wasabi, s3Prefix: 'slides/slide-1/', labelKey: null });
    assert.equal(p.bigtiff_size, 904350614);
    assert.equal(typeof p.bigtiff_size, 'number');
  });

  it('omits label_key and bigtiff_size when absent', () => {
    const p = buildBigtiffPublishedPayload({ slide: { ...slide, bigtiff_size: null }, wasabi, s3Prefix: 'slides/slide-1/', labelKey: null });
    assert.equal('label_key' in p, false);
    assert.equal('bigtiff_size' in p, false);
  });
});

describe('uploadLabelPhoto', () => {
  let root;
  let labelPath;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'label-pub-'));
    labelPath = join(root, 'label.jpg');
    await writeFile(labelPath, 'photo-bytes');
  });
  after(async () => { await rm(root, { recursive: true, force: true }); });

  function fetchMock(calls, { urlOk = true, putOk = true } = {}) {
    return async (url, opts) => {
      calls.push({ url, method: opts.method, headers: opts.headers, body: opts.body });
      if (String(url).endsWith('/edge/upload-urls')) {
        const { items } = JSON.parse(opts.body);
        return { ok: urlOk, status: urlOk ? 200 : 500, json: async () => ({ putUrls: { [items[0].key]: 'https://put.example/label' } }) };
      }
      return { ok: putOk, status: putOk ? 200 : 403 };
    };
  }

  it('requests a presigned URL with the edge key and PUTs the photo', async () => {
    const calls = [];
    const key = await uploadLabelPhoto('slide-1', 'slides/slide-1/', { fetch: fetchMock(calls), labelPath, edgeKey: 'k', cloudApiUrl: 'https://cloud.example' });
    assert.equal(key, 'slides/slide-1/label.jpg');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://cloud.example/edge/upload-urls');
    assert.equal(calls[0].headers['X-EDGE-KEY'], 'k');
    assert.deepEqual(JSON.parse(calls[0].body), { slideId: 'slide-1', items: [{ key: 'slides/slide-1/label.jpg', contentType: 'image/jpeg' }] });
    assert.equal(calls[1].url, 'https://put.example/label');
    assert.equal(calls[1].method, 'PUT');
    assert.equal(calls[1].headers['Content-Type'], 'image/jpeg');
  });

  it('returns null without calling the cloud when there is no photo', async () => {
    const calls = [];
    assert.equal(await uploadLabelPhoto('slide-1', 'slides/slide-1/', { fetch: fetchMock(calls), labelPath: null, edgeKey: 'k', cloudApiUrl: 'https://cloud.example' }), null);
    assert.equal(calls.length, 0);
  });

  it('returns null when the PUT fails or the key is missing', async () => {
    assert.equal(await uploadLabelPhoto('slide-1', 'slides/slide-1/', { fetch: fetchMock([], { putOk: false }), labelPath, edgeKey: 'k', cloudApiUrl: 'https://cloud.example' }), null);
    assert.equal(await uploadLabelPhoto('slide-1', 'slides/slide-1/', { fetch: fetchMock([], { urlOk: false }), labelPath, edgeKey: 'k', cloudApiUrl: 'https://cloud.example' }), null);
    assert.equal(await uploadLabelPhoto('slide-1', 'slides/slide-1/', { fetch: fetchMock([]), labelPath, edgeKey: '', cloudApiUrl: 'https://cloud.example' }), null);
  });
});
