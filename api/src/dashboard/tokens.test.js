import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const css = () => readFileSync(join(here, 'tokens.css'), 'utf8');

function hex(css, name) {
  const m = css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(m, `token ${name} missing or not a 6-digit hex`);
  return m[1];
}
function luminance(h) {
  const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

describe('tokens.css', () => {
  it('defines the brand palette from the logo', () => {
    const s = css();
    assert.equal(hex(s, '--sn-petroleo'), '#003858');
    assert.equal(hex(s, '--sn-azul'), '#3890D0');
    assert.equal(hex(s, '--sn-grafite'), '#304048');
    assert.equal(hex(s, '--sn-prata'), '#B8B8C0');
  });

  it('keeps text readable on the card surface (WCAG 7:1 primary, 4.5:1 secondary)', () => {
    const s = css();
    assert.ok(contrast(hex(s, '--sn-texto'), hex(s, '--sn-cartao')) >= 7);
    assert.ok(contrast(hex(s, '--sn-texto-2'), hex(s, '--sn-cartao')) >= 4.5);
    assert.ok(contrast(hex(s, '--sn-texto'), hex(s, '--sn-fundo')) >= 7);
  });

  it('keeps state colors legible as text on the panel', () => {
    const s = css();
    for (const t of ['--sn-ok', '--sn-atencao', '--sn-falha', '--sn-azul']) {
      assert.ok(contrast(hex(s, t), hex(s, '--sn-painel')) >= 3, `${t} on painel`);
    }
  });

  it('self-hosts the three Atkinson Hyperlegible Next faces', () => {
    const s = css();
    for (const w of [400, 500, 700]) {
      const f = join(here, 'fonts', `atkinson-hyperlegible-next-${w}.woff2`);
      assert.ok(statSync(f).size > 10_000, `${f} too small`);
      assert.match(s, new RegExp(`url\\("/fonts/atkinson-hyperlegible-next-${w}\\.woff2"\\)`));
    }
    assert.doesNotMatch(s, /fonts\.googleapis|gstatic/);
  });
});
