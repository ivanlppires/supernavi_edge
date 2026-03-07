# Design: Modal OCR com conferência e edição manual

**Data:** 2026-03-06
**Problema:** O técnico precisa conferir o resultado do OCR visualmente, poder regerar, e também corrigir manualmente o nome da lâmina para mitigar erros.
**Solução:** Expandir o modal OCR existente com abas de imagem (slide2.jpg + label.jpg), campo de edição manual com validação em tempo real, e novo endpoint de rename.

## Layout do modal

```
┌──────────────────────────────────────────────┐
│  Verificação OCR                          ✕  │
├──────────────────────────────────────────────┤
│  [ Lâmina ]  [ Label ]     ← abas de imagem │
│  ┌──────────────────────────────────────┐    │
│  │        (imagem da aba ativa)         │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  Leitura OCR          AP26000388A1           │
│  Arquivo              AP26000388A1.svs       │
│  Status               Concluído              │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │ Corrigir manualmente:               │    │
│  │ [ AP26000388A1_____________ ] [✓]   │    │
│  │ → AP26000388 + A1 (válido)          │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  [mensagem de status]                        │
├──────────────────────────────────────────────┤
│              [ Re-ler OCR ]  [ Fechar ]      │
└──────────────────────────────────────────────┘
```

## Abas de imagem

- **"Lâmina"** (aba padrão): mostra `GET /v1/slides/:id/slide2` (novo endpoint, serve slide2.jpg)
- **"Label"**: mostra `GET /v1/slides/:id/label` (endpoint existente, serve label.jpg)
- Placeholder se arquivo não existir

## Campo de edição manual

- Input pré-preenchido com leitura OCR atual (ou vazio se pendente)
- Parse em tempo real via `parseOcrResponse()` com preview (ex: "→ AP26000388 + A1 (válido)")
- Botão salvar habilitado apenas quando parse é válido
- Ao salvar: `POST /v1/slides/:id/rename` com `{ name: "AP26000388A1" }`

## Mudanças no backend

### Novo endpoint: `POST /v1/slides/:id/rename`
- Recebe `{ name: string }`
- Valida com `parseOcrResponse(name)`
- Atualiza via `updateSlideOcr()` com ocrStatus = 'done'
- Re-emite outbox event se tilegen done
- Retorna mesmo formato do `/reocr`

### Novo endpoint: `GET /v1/slides/:id/slide2`
- Serve slide2.jpg do diretório .dsmeta
- Similar ao endpoint `/label` existente

## Sem mudanças
- Parser (`parseOcrResponse`) — reutilizado
- Schema do banco — mesmas colunas
- Fluxo OCR automático — não muda
