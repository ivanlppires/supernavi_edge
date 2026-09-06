import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMock } from './dashboard-mock.js';

describe('dashboard-mock', () => {
  let srv; let base;
  before(async () => { srv = await startMock(0, 'normal'); base = `http://127.0.0.1:${srv.address().port}`; });
  after(() => srv.close());

  it('serves the dashboard index', async () => {
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /SuperNavi Edge/);
  });

  it('answers the dashboard, slides and pending routes', async () => {
    const d = await (await fetch(`${base}/v1/dashboard`)).json();
    assert.equal(d.tunnel.connected, true);
    assert.equal(d.slides.total, 119);
    const s = await (await fetch(`${base}/v1/slides`)).json();
    assert.ok(Array.isArray(s.slides) && s.slides.length >= 10);
    const p = await (await fetch(`${base}/v1/pending-slides`)).json();
    assert.equal(p.total, 17);
    assert.equal(p.slides.length, 17);
  });

  it('serves a label image for a pending slide', async () => {
    const p = await (await fetch(`${base}/v1/pending-slides`)).json();
    const r = await fetch(`${base}/v1/pending-slides/${p.slides[0].id}/image?which=label`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/svg+xml');
  });

  it('switches to the failure scenario with ?cenario=falhas', async () => {
    const d = await (await fetch(`${base}/v1/dashboard?cenario=falhas`)).json();
    assert.equal(d.tunnel.connected, false);
    const f = await (await fetch(`${base}/v1/dashboard/failures?cenario=falhas`)).json();
    assert.equal(f.failures.length, 3);
    assert.equal(f.stuckSync.length, 2);
  });
});
