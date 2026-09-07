import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, f), 'utf8');

/** Variáveis de um bloco de regra, escolhido por um trecho do seletor. */
function bloco(css, marcador) {
  const i = css.indexOf(marcador);
  assert.ok(i >= 0, `bloco ${marcador} não encontrado`);
  const abre = css.indexOf('{', i);
  const fecha = css.indexOf('}', abre);
  const corpo = css.slice(abre + 1, fecha);
  const vars = {};
  for (const m of corpo.matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}
function luminancia(hex) {
  const h = hex.replace('#', '');
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contraste(a, b) {
  const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

describe('tokens.css', () => {
  const css = read('tokens.css');
  const claro = bloco(css, ':root {');
  const escuro = bloco(css, ':root[data-theme="escuro"]');

  it('guarda as cores da marca, iguais nos dois temas', () => {
    assert.equal(claro['--sn-petroleo'], '#003858');
    assert.equal(claro['--sn-azul-marca'], '#3890D0');
  });

  it('tem os dois temas com o mesmo conjunto de variáveis', () => {
    for (const nome of Object.keys(escuro)) {
      assert.ok(nome in claro, `${nome} existe só no escuro`);
    }
    for (const nome of ['--sn-fundo', '--sn-superficie', '--sn-texto', '--sn-texto-2', '--sn-texto-3', '--sn-azul', '--sn-verde', '--sn-ambar', '--sn-vermelho']) {
      assert.ok(nome in escuro, `${nome} falta no tema escuro`);
      assert.notEqual(escuro[nome], claro[nome], `${nome} não muda entre os temas`);
    }
  });

  it('aplica o escuro por preferência do sistema e por escolha explícita', () => {
    assert.match(css, /@media \(prefers-color-scheme: dark\)/);
    assert.match(css, /:root:not\(\[data-theme="claro"\]\)/);
    assert.match(css, /:root\[data-theme="escuro"\]/);
    const porSistema = bloco(css, ':root:not([data-theme="claro"])');
    for (const nome of Object.keys(escuro)) {
      assert.equal(porSistema[nome], escuro[nome], `${nome} difere entre preferência do sistema e escolha`);
    }
  });

  for (const [nome, tema] of [['claro', null], ['escuro', null]]) {
    it(`mantém o texto legível no tema ${nome}`, () => {
      const t = nome === 'claro' ? claro : escuro;
      assert.ok(contraste(t['--sn-texto'], t['--sn-fundo']) >= 7, 'texto principal sobre o fundo');
      assert.ok(contraste(t['--sn-texto'], t['--sn-superficie']) >= 7, 'texto principal sobre a superfície');
      assert.ok(contraste(t['--sn-texto-2'], t['--sn-superficie']) >= 4.5, 'texto secundário');
      assert.ok(contraste(t['--sn-texto-3'], t['--sn-superficie']) >= 4.5, 'texto terciário');
      assert.ok(tema === null);
    });

    it(`mantém as cores de estado legíveis no tema ${nome}`, () => {
      const t = nome === 'claro' ? claro : escuro;
      for (const chave of ['--sn-azul', '--sn-verde', '--sn-ambar', '--sn-vermelho']) {
        assert.ok(contraste(t[chave], t['--sn-superficie']) >= 4.5, `${chave} como texto`);
      }
      assert.ok(contraste(t['--sn-sobre-azul'], t['--sn-azul']) >= 4.5, 'texto sobre o botão primário');
    });
  }

  it('usa a pilha do sistema na interface e a Atkinson só nos identificadores', () => {
    assert.match(claro['--sn-fonte'], /-apple-system/);
    assert.match(claro['--sn-fonte-id'], /Atkinson Hyperlegible Next/);
    for (const w of [400, 500, 700]) {
      const f = join(here, 'fonts', `atkinson-hyperlegible-next-${w}.woff2`);
      assert.ok(statSync(f).size > 10_000, `${f} pequeno demais`);
      assert.match(css, new RegExp(`url\\("/fonts/atkinson-hyperlegible-next-${w}\\.woff2"\\)`));
    }
    assert.doesNotMatch(css, /fonts\.googleapis|gstatic/);
  });

  it('ships the real SuperNavi mark, not a hand-drawn stand-in', () => {
    const svg = read('logo-mark.svg');
    assert.equal((svg.match(/<path/g) || []).length, 6);
    assert.ok(svg.length > 20_000, 'mark looks like a simplified redraw');
    const html = read('index.html');
    assert.match(html, /<img class="brand-mark" id="brandMark"/);
    assert.doesNotMatch(html, /<svg class="brand-mark"/);
    // Colorida no claro, branca no escuro: a troca é do app.js.
    assert.ok(statSync(join(here, 'logo-mark-claro.png')).size > 5_000);
    assert.match(read('app.js'), /marca\.src = escuro \? '\/logo-mark\.svg' : '\/logo-mark-claro\.png'/);
  });
});

describe('dashboard.js', () => {
  const js = read('app.js');

  it('não usa alert, confirm nem prompt do navegador', () => {
    // Diálogos nativos travam a página e ignoram o tema; o painel tem os seus.
    // Comentários saem antes da busca: eles citam os nomes de propósito.
    const codigo = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const chamadas = codigo.match(/(?<![\w.])(alert|confirm|prompt)\s*\(/g) || [];
    assert.deepEqual(chamadas, [], `encontrado: ${chamadas.join(', ')}`);
  });

  it('tem diálogo de confirmação e avisos próprios', () => {
    assert.match(js, /function confirmar\(/);
    assert.match(js, /function avisar\(/);
    const html = read('index.html');
    assert.match(html, /id="confirmDialog"/);
    assert.match(html, /id="avisos"/);
  });

  it('lembra o tema escolhido e oferece a opção sistema', () => {
    assert.match(js, /supernavi_tema/);
    assert.match(js, /prefers-color-scheme: dark/);
    const html = read('index.html');
    assert.match(html, /id="btnTema"/);
    assert.match(html, /data-tema="sistema"/);
    assert.match(html, /data-tema="claro"/);
    assert.match(html, /data-tema="escuro"/);
  });
});
