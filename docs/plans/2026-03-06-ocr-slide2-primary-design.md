# Design: OCR com slide2.jpg como fonte primária

**Data:** 2026-03-06
**Problema:** O scanner Motic gera label.jpg com recorte que corta o código manuscrito pela metade. O modelo adivinha os dígitos faltantes e retorna leituras erradas (~10-40% dos slides manuscritos).
**Solução:** Usar slide2.jpg (imagem da lâmina inteira, ~170kb, sempre presente) como fonte primária de OCR, pois o código manuscrito aparece completo na parte superior.

## Fluxo atual

```
label.jpg → Claude Vision → resultado
  └─ UNREADABLE? → label.jpg + slide.jpg → Claude Vision → resultado
```

## Novo fluxo

```
slide2.jpg → Claude Vision (prompt otimizado para parte superior) → resultado
  └─ falha? → label.jpg + slide2.jpg → Claude Vision (prompt cruzamento) → resultado
    └─ falha? → null (ocr_status = 'pending')
```

## Mudanças no código

### `api/src/lib/label-ocr.js`
1. Novo prompt `SLIDE_OVERVIEW_PROMPT` otimizado para slide2.jpg — foco na parte superior da imagem
2. Modificar `ocrLabel()` para aceitar o diretório `.dsmeta` e:
   - Tentar `slide2.jpg` primeiro com novo prompt
   - Fallback: `label.jpg` + `slide2.jpg` juntos com prompt de cruzamento
   - Fallback final: retornar null
3. Adaptar `LABEL_WITH_SLIDE_PROMPT` para referenciar slide2.jpg

### `api/src/services/scanner-adapter.js`
- Ajustar chamadas a `ocrLabel()` para passar diretório .dsmeta

### `api/src/routes/slides.js`
- Ajustar endpoint `/reocr` da mesma forma

## Sem mudanças
- Parser (`parseOcrResponse`) — mesma lógica
- Schema do banco — mesmas colunas
- Dashboard — mesmo comportamento
- Testes de parse — mesmos casos
