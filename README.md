# SuperNavi EDGE v1.0

**Status: Pronto para Produção**

Agente local para patologia digital com arquitetura edge-first.

---

## Arquitetura Edge-First

O SuperNavi EDGE implementa uma arquitetura **edge-first** otimizada para patologia digital:

```
┌─────────────────────────────────────────────────────────────────┐
│                      SuperNavi EDGE v1.0                         │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────┐    ┌───────────┐    ┌──────┐    ┌───────┐         │
│  │   API   │◄──►│ Processor │◄──►│Redis │    │  Sync │         │
│  │ Fastify │    │  Worker   │    │Queue │    │Service│         │
│  └────┬────┘    └───────────┘    └──────┘    └───────┘         │
│       │                                                          │
│       ▼                                                          │
│  ┌──────────┐                                                    │
│  │PostgreSQL│                                                    │
│  └──────────┘                                                    │
├─────────────────────────────────────────────────────────────────┤
│  ./data/inbox/  →  ./data/raw/  →  ./data/derived/              │
│  (entrada)         (originais)      (tiles/thumbs)               │
└─────────────────────────────────────────────────────────────────┘
```

### Componentes

| Componente | Descrição | Porta |
|------------|-----------|-------|
| **API** | Fastify server, file watcher, tile serving | 3000 |
| **Processor** | Worker para processamento de imagens | - |
| **PostgreSQL** | Banco de dados para metadados | 5432 |
| **Redis** | Fila de jobs assíncrona | 6379 |
| **Sync** | Sincronização com a nuvem | - |

---

## Formatos Suportados

| Formato | Extensões | Pipeline | Tiles |
|---------|-----------|----------|-------|
| JPEG | .jpg, .jpeg | Sharp (Node.js) | Pré-gerados |
| PNG | .png | Sharp (Node.js) | Pré-gerados |
| **SVS** | **.svs** | **OpenSlide + libvips** | **On-demand** |
| TIFF | .tif, .tiff | OpenSlide + libvips | On-demand |
| NDPI | .ndpi | OpenSlide + libvips | On-demand |
| MRXS | .mrxs | OpenSlide + libvips | On-demand |

### Pipeline Edge-First (SVS/WSI)

**Abertura instantânea de lâminas digitais!**

- **P0 (~1 segundo)**: Extrai metadados + gera thumbnail + cria manifest
- **Tiles on-demand**: Gerados apenas quando o viewer solicita
- **Cache em disco**: Tiles gerados são armazenados para reuso

```
Fluxo de Ingestão:
1. Arquivo colocado em ./data/inbox/
2. Watcher detecta e calcula hash SHA256 (slideId)
3. Move para ./data/raw/{slideId}_{filename}
4. Cria registro no banco com status "queued"
5. P0 executa: thumbnail + manifest (~1s para SVS)
6. Status "ready" - viewer pode abrir imediatamente
7. Tiles gerados on-demand quando requisitados
```

---

## API Endpoints

### Health Check
```bash
curl http://localhost:3000/health
```

### Listar Slides
```bash
curl http://localhost:3000/v1/slides
```
```json
{
  "items": [
    {
      "slideId": "f41fa55d4f24...",
      "status": "ready",
      "width": 10961,
      "height": 12499,
      "maxLevel": 14,
      "levelReadyMax": 0,
      "format": "svs",
      "onDemand": true
    }
  ]
}
```

### Obter Info do Slide
```bash
curl http://localhost:3000/v1/slides/{slideId}
```

### Obter Manifest (DeepZoom)
```bash
curl http://localhost:3000/v1/slides/{slideId}/manifest
```
```json
{
  "protocol": "dzi",
  "tileSize": 256,
  "overlap": 0,
  "format": "jpg",
  "width": 10961,
  "height": 12499,
  "levelMin": 0,
  "levelMax": 14,
  "tilePathPattern": "tiles/{z}/{x}_{y}.jpg",
  "tileUrlTemplate": "/v1/slides/{slideId}/tiles/{z}/{x}/{y}.jpg",
  "onDemand": true
}
```

### Obter Thumbnail
```bash
curl http://localhost:3000/v1/slides/{slideId}/thumb -o thumb.jpg
```

### Obter Tile (On-Demand)
```bash
curl http://localhost:3000/v1/slides/{slideId}/tiles/{z}/{x}/{y}.jpg -o tile.jpg
```

**Respostas:**
- `200 OK` + imagem: Tile pronto (gerado ou do cache)
- `202 Accepted`: Tile em geração (retry em 1s)
- `404 Not Found`: Tile fora dos limites ou slide não encontrado

### Verificar Disponibilidade
```bash
curl http://localhost:3000/v1/slides/{slideId}/availability
```
```json
{
  "slideId": "f41fa55d4f24...",
  "levelMax": 14,
  "levelReadyMax": 10,
  "tilesOnDisk": 3,
  "tilesComplete": false,
  "onDemand": true,
  "pendingGenerations": 0
}
```

---

## Desenvolvimento Local

### Pré-requisitos
- Docker e Docker Compose
- Git

### Subir os Serviços
```bash
git clone <repo>
cd supernavi_edge
docker compose up -d --build
```

### Verificar Status
```bash
docker compose ps
docker compose logs -f api processor
```

### Importar uma Lâmina
```bash
cp /path/to/slide.svs ./data/inbox/
```

### Verificar Processamento
```bash
# Listar slides
curl http://localhost:3000/v1/slides | jq

# Obter tile on-demand
curl -o tile.jpg http://localhost:3000/v1/slides/{slideId}/tiles/10/0/0.jpg
```

### Limpar Dados (Reset)
```bash
docker compose down -v
rm -rf ./data/raw/* ./data/derived/*
docker compose up -d --build
```

---

## Testes Realizados

### Ambiente de Teste
- **OS**: Linux 6.14.0-37-generic (Ubuntu)
- **Docker**: Docker Compose v2
- **Arquivo de teste**: `_20250912165026.svs` (38.5 MB, 10961x12499 pixels)

### Teste 1: Ingestão e Processamento P0

**Objetivo**: Verificar que P0 completa rapidamente para arquivos SVS.

```bash
cp samples/_20250912165026.svs data/inbox/
```

**Resultado**:
```
Processing SVS P0 (edge-first): f41fa55d4f24...__20250912165026.svs
Slide dimensions: 10961x12499
Max level: 14
Generated thumbnail: /data/derived/f41fa55d4f24.../thumb.jpg
Generated manifest: /data/derived/f41fa55d4f24.../manifest.json
SVS P0 complete - viewer ready (tiles on-demand)
P0 complete for f41fa55d4f24: 10961x12499, maxLevel=14
```

**Status**: ✅ PASSOU - P0 completa em ~1 segundo

### Teste 2: Geração de Tiles On-Demand

**Objetivo**: Verificar geração de tiles quando requisitados.

```bash
# Tile nível 0 (menor resolução)
curl -o tile0.jpg http://localhost:3000/v1/slides/{slideId}/tiles/0/0/0.jpg

# Tile nível 5
curl -o tile5.jpg http://localhost:3000/v1/slides/{slideId}/tiles/5/0/0.jpg

# Tile nível 10 (256x256)
curl -o tile10.jpg http://localhost:3000/v1/slides/{slideId}/tiles/10/0/0.jpg
```

**Resultados**:

| Tile | HTTP | Tamanho | Dimensões |
|------|------|---------|-----------|
| 0/0/0 | 200 | 803 bytes | 1x1 px |
| 5/0/0 | 200 | 1217 bytes | 21x24 px |
| 10/0/0 | 200 | 7531 bytes | 256x256 px |

**Status**: ✅ PASSOU - Todos os tiles gerados corretamente

### Teste 3: Cache de Tiles

**Objetivo**: Verificar que tiles são cacheados em disco.

```bash
# Primeira requisição (gera tile)
time curl -o tile.jpg http://localhost:3000/v1/slides/{slideId}/tiles/10/0/0.jpg
# real: ~300ms

# Segunda requisição (do cache)
time curl -o tile_cached.jpg http://localhost:3000/v1/slides/{slideId}/tiles/10/0/0.jpg
# real: ~11ms
```

**Resultados**:
- **Primeira requisição**: ~300ms (geração on-demand)
- **Segunda requisição**: ~11ms (servido do cache)
- **Tiles em disco**: `./data/derived/{slideId}/tiles/{level}/`

**Status**: ✅ PASSOU - Cache funcionando corretamente

### Teste 4: Endpoint de Disponibilidade

**Objetivo**: Verificar formato do endpoint `/availability`.

```bash
curl http://localhost:3000/v1/slides/{slideId}/availability | jq
```

**Resultado**:
```json
{
  "slideId": "f41fa55d4f2478bbff5e9192b1031fcc19f9513b24708961121012492e0bfe3b",
  "levelMax": 14,
  "levelReadyMax": 10,
  "tilesOnDisk": 3,
  "tilesComplete": false,
  "onDemand": true,
  "pendingGenerations": 0
}
```

**Status**: ✅ PASSOU - Formato correto

### Teste 5: Estrutura de Arquivos Derivados

**Objetivo**: Verificar estrutura de saída após P0.

```bash
ls -la data/derived/{slideId}/
```

**Resultado após P0**:
```
manifest.json   # Metadados DeepZoom
thumb.jpg       # Thumbnail (max 256x256)
tiles/          # Diretório vazio (tiles on-demand)
```

**Resultado após requisições de tiles**:
```
tiles/
├── 0/
│   └── 0_0.jpg
├── 5/
│   └── 0_0.jpg
└── 10/
    └── 0_0.jpg
```

**Status**: ✅ PASSOU - Estrutura correta

### Resumo dos Testes

| Teste | Descrição | Status |
|-------|-----------|--------|
| 1 | Ingestão e P0 rápido | ✅ PASSOU |
| 2 | Geração tiles on-demand | ✅ PASSOU |
| 3 | Cache de tiles em disco | ✅ PASSOU |
| 4 | Endpoint /availability | ✅ PASSOU |
| 5 | Estrutura de arquivos | ✅ PASSOU |

### Métricas de Performance

| Operação | Tempo |
|----------|-------|
| P0 SVS (38.5 MB) | ~1s |
| Tile on-demand (primeira vez) | ~300ms |
| Tile cached (segunda vez) | ~11ms |
| Hash SHA256 (38.5 MB) | ~1s |

---

## O que é o SuperNavi EDGE?

O **SuperNavi EDGE** é o componente local da plataforma SuperNavi para **patologia digital**.

Ele roda **diretamente na máquina do patologista**, permitindo:

- Abertura imediata de lâminas digitais (SVS, NDPI, etc.)
- Navegação com zoom máximo desde o início
- Processamento local, sem depender da internet
- Armazenamento local como fonte principal dos dados
- Sincronização automática com a nuvem para acesso remoto e colaboração

A experiência é a **mesma** no modo local e no modo remoto.

---

## Requisitos do Sistema

### Sistema Operacional
- **Windows 10 ou Windows 11 (64 bits)**

### Hardware Mínimo Recomendado
- Processador: Intel i5 / Ryzen 5 ou superior
- Memória RAM: **16 GB** (32 GB recomendado)
- Armazenamento:
  - SSD obrigatório
  - Espaço livre mínimo: **500 GB**
- Internet:
  - Necessária apenas para ativação e sincronização
  - O sistema funciona localmente mesmo sem conexão contínua

> ⚠️ Quanto maior o volume de lâminas, maior deve ser o espaço em disco disponível.

---

## Download

👉 **Baixe o instalador oficial do SuperNavi EDGE:**

🔗 **[Download SuperNavi EDGE v1.0 – Windows](#)**
*(link será disponibilizado na aba Releases)*

Arquivo:
SuperNavi_EDGE_Setup.exe


---

## Instalação

1. Faça o download do arquivo `SuperNavi_EDGE_Setup.exe`
2. Clique duas vezes para iniciar o instalador
3. Siga os passos na tela (Avançar → Avançar → Concluir)
4. Ao final da instalação, o agente será iniciado automaticamente

Durante a instalação:
- Os componentes necessários são configurados automaticamente
- Não é necessário conhecimento técnico
- Não é necessário configurar servidores ou bancos de dados

---

## Primeira Execução

Após a instalação:

1. Abra o **SuperNavi EDGE**
2. Informe sua **chave de licença** (fornecida após a assinatura)
3. Escolha a pasta onde o scanner salva as lâminas digitais
4. Conclua a configuração inicial

Pronto.  
O SuperNavi já estará operando localmente.

---

## Como acessar o SuperNavi

### Na própria máquina
Abra seu navegador (Chrome, Edge ou Firefox) e acesse:

https://app.supernavi.app


O sistema utiliza a nuvem apenas quando o agente local não está disponível.

> 💡 A interface é exatamente a mesma.  
> O usuário não precisa escolher “modo local” ou “modo remoto”.

---

## Funcionamento Offline

- O SuperNavi continua funcionando mesmo sem internet
- As lâminas permanecem acessíveis localmente
- A sincronização é retomada automaticamente quando a conexão voltar

---

## Atualizações

- As atualizações são automáticas
- O sistema verifica novas versões periodicamente
- As atualizações não interrompem o uso em andamento
- Em caso de falha, o sistema retorna automaticamente à versão anterior

---

## Backup e Armazenamento

- As lâminas e dados ficam armazenados localmente
- O SuperNavi alerta quando o espaço em disco estiver baixo
- É possível configurar backups locais (HD externo ou rede)

> Recomenda-se manter uma rotina de backup do ambiente local.

---

## Suporte

Em caso de dúvidas ou necessidade de suporte:

- Utilize a opção **“Exportar Diagnóstico”** no Agent Manager
- Envie o arquivo gerado para a equipe de suporte
- Nenhum dado clínico é enviado automaticamente

---

## Importante Saber

- O SuperNavi **não substitui** o sistema de laudos
- O diagnóstico e laudo continuam sendo responsabilidade do patologista
- O SuperNavi atua como ferramenta de visualização, navegação e colaboração

---

## Licença

O SuperNavi EDGE é um **software proprietário**.

- Uso permitido apenas mediante assinatura ativa
- É proibida a redistribuição, cópia ou engenharia reversa
- O código-fonte não é disponibilizado ao usuário final

---

© SuperNavi – Todos os direitos reservados
