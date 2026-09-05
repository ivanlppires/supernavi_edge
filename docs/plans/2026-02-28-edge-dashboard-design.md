# Edge Dashboard — Design

**Data:** 2026-02-28
**Status:** Aprovado

## Objetivo

Interface web local para monitorar e configurar o SuperNavi Edge sem depender de logs ou terminal. Acesso via `localhost:3000` no próprio PC do laboratório.

## Usuários

- **Técnico do laboratório**: precisa ver se está funcionando, acompanhar processamento
- **Admin/Dev**: diagnóstico avançado, configuração, troubleshooting

## Stack

- HTML/CSS/JS puro servido pelo Fastify (zero dependências extras, sem build step)
- SSE (`/v1/events`) para updates em tempo real
- API existente do edge como backend (`/v1/health`, `/v1/slides`, `/v1/admin/config`)

## Arquitetura

Single-page dashboard com 4 tabs navegáveis. Arquivos estáticos em `api/src/dashboard/`. Fastify serve via `@fastify/static` na rota `/`.

## Seções

### 1. Status (tela inicial)

Cards com indicadores visuais:

- **Tunnel Cloud** — conectado/desconectado, agentId, uptime
- **Watcher** — rodando/parado, pasta monitorada, permissões OK
- **Banco de dados** — conectado, contagem de slides
- **Redis/Fila** — conectado, jobs pendentes/rodando
- **Processador** — ativo/inativo, job atual (se houver)
- **Disco** — espaço usado em raw/, derived/, inbox/

Fonte de dados: `GET /v1/health` + query de contagem

### 2. Slides

Lista de slides com:

- Thumbnail (`/v1/slides/:id/thumb`)
- Filename original
- Status visual: queued (amarelo), processing (azul pulsante), ready (verde), failed (vermelho)
- Barra de progresso para P0/TILEGEN/cloud upload
- Metadata: formato, dimensões, magnificação, tamanho
- Case ID (se extraído)
- Timestamp de criação

Ordenação: mais recente primeiro. Filtro por status. SSE atualiza automaticamente.

### 3. Atividade

Feed cronológico de eventos em linguagem simples (português):

- Eventos do SSE traduzidos para texto legível
- Ícones e cores por tipo
- Ring buffer de ~100 eventos na tela
- Atualização em tempo real

### 4. Configurações

Formulário editável com campos do `edge-config.json`:

- **Pasta de slides** (slidesDirHost) — input + botão para testar acesso
- **Tipo de scanner** — dropdown (unknown, leica, hamamatsu, 3dhistech)
- **Tempo de estabilidade** (stableSeconds) — slider 5-60s
- **Regex de caso** (caseBaseRegex) — input com preview de match
- **Cloud upload** — toggle on/off
- **Remote preview** — toggle on/off
- **OCR de label** — toggle on/off

Salva via `POST /v1/admin/config`. Validação client-side.

## Decisões técnicas

- **Sem framework frontend** — o escopo é pequeno e definido, HTML/CSS/JS basta
- **SSE em vez de polling** — infraestrutura já existe, mais responsivo
- **Mesma porta (3000)** — rota `/` serve dashboard, `/v1/` serve API
- **Interface em português** — usuários são brasileiros
- **Visual operacional/industrial** — painel de monitoramento, não SaaS marketing
