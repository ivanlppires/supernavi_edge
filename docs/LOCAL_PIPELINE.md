# SuperNavi Local Pipeline

## Visão Geral

O pipeline local processa imagens e lâminas digitais (WSI) em tiles DeepZoom para visualização no viewer.

### Arquitetura Edge-First

**SVS/WSI agora abrem instantaneamente!**

- P0 gera apenas thumbnail + manifest em ~1 segundo
- Tiles são gerados sob demanda quando o viewer solicita
- Cache em disco: tiles gerados são armazenados para reuso

### Formatos Suportados

| Formato | Extensões | Pipeline | Tiles |
|---------|-----------|----------|-------|
| JPEG | .jpg, .jpeg | Sharp (Node.js) | Pré-gerados |
| PNG | .png | Sharp (Node.js) | Pré-gerados |
| **SVS** | **.svs** | **OpenSlide + libvips** | **On-demand** |
| TIFF | .tif, .tiff | OpenSlide + libvips | On-demand |
| NDPI | .ndpi | OpenSlide + libvips | On-demand |
| MRXS | .mrxs | OpenSlide + libvips | On-demand |

### Fases de Processamento

**Para JPG/PNG:**
- **P0**: Níveis 0-4 (preview rápido)
- **P1**: Níveis restantes (zoom completo)

**Para SVS/WSI (Edge-First):**
- **P0**: Apenas metadados + thumbnail (~1s)
- **Tiles**: Gerados on-demand pela API

## Fluxo de Ingestão

```
1. Coloque um arquivo em ./data/inbox/
   - Suportados: .jpg, .jpeg, .png, .svs, .tif, .tiff, .ndpi, .mrxs
2. O watcher detecta o arquivo
3. Calcula hash SHA256 como slideId
4. Move para ./data/raw/{slideId}_{filename}
5. Cria registro no banco com status "queued" e formato
6. Enfileira job P0 no Redis
7. Processor executa P0:
   - JPG/PNG: Gera thumbnail + tiles níveis 0-4
   - SVS/WSI: Gera apenas thumbnail + manifest (~1s)
8. Slide fica com status "ready" (viewer pode abrir)
```

## Pipeline SVS (Edge-First)

### Como funciona

**P0 (processamento inicial):**
1. **Leitura de metadados**: `openslide-show-properties` ou `vipsheader`
2. **Geração de thumbnail**: `vips thumbnail`
3. **Manifest**: Criado com `onDemand: true`
4. **Retorno**: Status "ready" em ~1 segundo

**On-demand (quando tile é solicitado):**
1. API recebe request para tile
2. Se tile existe em disco, serve diretamente
3. Se não existe e é WSI:
   - Gera tile usando vips crop + resize
   - Salva em disco para cache
   - Serve o tile gerado

### Request Coalescing

Para evitar geração duplicada de tiles:
- Lock in-memory por tile key
- Requisições simultâneas aguardam a primeira geração
- Se tile está pendente, retorna 503 + Retry-After: 1 (viewer retry)

### Estrutura de saída

```
./data/derived/{slideId}/
├── thumb.jpg           # Thumbnail (max 256x256)
├── manifest.json       # Metadados DeepZoom
└── tiles/
    ├── 0/              # Nível 0 (menor resolução)
    │   └── 0_0.jpg     # Gerado on-demand
    ├── 1/
    ├── ...
    └── {maxLevel}/     # Nível máximo (resolução original)
        ├── 0_0.jpg
        ├── 0_1.jpg
        └── ...
```

## Formato do Manifest

```json
{
  "protocol": "dzi",
  "tileSize": 256,
  "overlap": 0,
  "format": "jpg",
  "width": 50000,
  "height": 40000,
  "levelMin": 0,
  "levelMax": 15,
  "tilePathPattern": "tiles/{z}/{x}_{y}.jpg",
  "tileUrlTemplate": "/v1/slides/{slideId}/tiles/{z}/{x}/{y}.jpg",
  "onDemand": true
}
```

## Endpoints da API

### Listar slides
```bash
curl http://localhost:3000/v1/slides
```
Resposta:
```json
{
  "items": [
    {
      "slideId": "abc123...",
      "status": "ready",
      "width": 50000,
      "height": 40000,
      "maxLevel": 15,
      "levelReadyMax": 0,
      "format": "svs",
      "onDemand": true
    }
  ]
}
```

### Obter info do slide
```bash
curl http://localhost:3000/v1/slides/{slideId}
```
Resposta:
```json
{
  "slideId": "abc123...",
  "status": "ready",
  "format": "svs",
  "width": 50000,
  "height": 40000,
  "maxLevel": 15,
  "levelReadyMax": 0,
  "tileSize": 256,
  "onDemand": true,
  "createdAt": "..."
}
```

### Obter disponibilidade de tiles
```bash
curl http://localhost:3000/v1/slides/{slideId}/availability
```
Resposta:
```json
{
  "slideId": "abc123...",
  "levelMax": 15,
  "levelReadyMax": 14,
  "tilesOnDisk": 150,
  "tilesComplete": false,
  "onDemand": true,
  "pendingGenerations": 2
}
```

### Obter manifest
```bash
curl http://localhost:3000/v1/slides/{slideId}/manifest
```

### Obter thumbnail
```bash
curl http://localhost:3000/v1/slides/{slideId}/thumb -o thumb.jpg
```

### Obter tile
```bash
# Nível 0 (menor resolução) - gerado on-demand
curl http://localhost:3000/v1/slides/{slideId}/tiles/0/0/0.jpg -o tile.jpg

# Nível máximo (maior resolução) - gerado on-demand
curl http://localhost:3000/v1/slides/{slideId}/tiles/15/100/80.jpg -o tile.jpg
```

**Respostas possíveis:**
- `200 OK` + imagem: Tile pronto
- `503 Service Unavailable` + header `Retry-After: 1`: Tile em geração (retry em 1s)
- `404 Not Found`: Tile fora dos limites

## Server-Sent Events (SSE)

### Endpoint

```
GET /v1/events
```

### Conexão

```javascript
const eventSource = new EventSource('http://localhost:3000/v1/events');

eventSource.addEventListener('slide:import', (e) => {
  const data = JSON.parse(e.data);
  console.log('Slide importado:', data);
});

eventSource.addEventListener('slide:ready', (e) => {
  const data = JSON.parse(e.data);
  console.log('Slide pronto:', data);
});
```

### Eventos Disponíveis

| Evento | Descrição | Payload |
|--------|-----------|---------|
| `connected` | Conexão SSE estabelecida | `{ timestamp }` |
| `slide:import` | Novo slide detectado no inbox | `{ slideId, filename, format, timestamp }` |
| `slide:ready` | Processamento P0 completo | `{ slideId, width, height, maxLevel, timestamp }` |
| `tile:pending` | Geração de tile iniciada | `{ slideId, z, x, y, timestamp }` |
| `tile:generated` | Tile gerado com sucesso | `{ slideId, z, x, y, timestamp }` |

### Exemplo de Payload

**slide:import:**
```json
{
  "slideId": "abc123def456...",
  "filename": "sample.svs",
  "format": "svs",
  "timestamp": 1704067200000
}
```

**slide:ready:**
```json
{
  "slideId": "abc123def456...",
  "width": 50000,
  "height": 40000,
  "maxLevel": 15,
  "timestamp": 1704067201000
}
```

**tile:pending / tile:generated:**
```json
{
  "slideId": "abc123def456...",
  "z": 10,
  "x": 5,
  "y": 3,
  "timestamp": 1704067202000
}
```

### Arquitetura SSE

```
┌─────────────┐     Redis Pub/Sub    ┌─────────────┐
│  Processor  │─────────────────────►│    API      │
│  (Worker)   │  supernavi:events    │  EventBus   │
└─────────────┘                      └──────┬──────┘
                                            │
                                            ▼
                                     ┌─────────────┐
                                     │ SSE Clients │
                                     │  /v1/events │
                                     └─────────────┘
```

- **Processor**: Publica `slide:ready` via Redis
- **API Watcher**: Emite `slide:import` localmente
- **Tilegen**: Emite `tile:pending` e `tile:generated` localmente
- **EventBus**: Centraliza eventos e distribui para clientes SSE

## Viewer Test

Um viewer de teste está disponível em `infra/viewer-test/index.html`.

### Como usar

1. Inicie os serviços:
   ```bash
   docker compose up -d --build
   ```

2. Abra o arquivo no navegador:
   ```bash
   # Ou simplesmente abra o arquivo diretamente
   open infra/viewer-test/index.html

   # Ou use um servidor HTTP local
   npx serve infra/viewer-test -p 8080
   ```

3. O viewer irá:
   - Listar slides disponíveis via `/v1/slides`
   - Permitir colar um slideId manualmente
   - Abrir o viewer OpenSeadragon consumindo `/v1/slides/{slideId}/manifest`
   - Mostrar status/availability em tempo real (polling 1s)
   - Exibir eventos SSE na sidebar

### Funcionalidades

- **Lista de slides**: Atualiza automaticamente a cada 5s
- **Viewer OpenSeadragon**: Zoom, pan, navigator
- **Retry automático**: Tiles com 503 são re-solicitados após 1s
- **Availability polling**: Status do slide atualizado a cada 1s
- **SSE events**: Log de eventos em tempo real

## Como Testar

### 1. Subir os serviços
```bash
docker compose up -d --build
```

### 2. Verificar status
```bash
docker compose logs -f api processor
```

### 3. Importar um arquivo SVS
```bash
cp /path/to/slide.svs ./data/inbox/
```

### 4. Verificar processamento P0 (deve ser rápido!)
```bash
# Ver logs do processor
docker compose logs -f processor

# Verificar slides - deve aparecer "ready" em ~1s
curl http://localhost:3000/v1/slides | jq
```

### 5. Testar tiles on-demand
```bash
SLIDE_ID=$(curl -s http://localhost:3000/v1/slides | jq -r '.items[0].slideId')

# Primeiro request - gera o tile on-demand
time curl -o tile0.jpg http://localhost:3000/v1/slides/$SLIDE_ID/tiles/0/0/0.jpg

# Segundo request - serve do cache
time curl -o tile0_cached.jpg http://localhost:3000/v1/slides/$SLIDE_ID/tiles/0/0/0.jpg

# Verificar availability
curl http://localhost:3000/v1/slides/$SLIDE_ID/availability | jq
```

### 6. Verificar tiles em disco
```bash
# Ver tiles gerados
ls -la ./data/derived/$SLIDE_ID/tiles/

# Contar tiles por nível
for level in ./data/derived/$SLIDE_ID/tiles/*/; do
  echo "Level $(basename $level): $(ls $level | wc -l) tiles"
done
```

## Troubleshooting

### Slide não aparece na lista
- Verifique se a extensão é suportada
- Verifique logs: `docker compose logs api`
- Para arquivos grandes, aguarde mais tempo (hashing pode demorar)

### Status "failed" para SVS
- Verifique logs do processor: `docker compose logs processor`
- Verifique se OpenSlide reconhece o formato:
  ```bash
  docker compose exec processor openslide-show-properties /data/raw/{arquivo}.svs
  ```
- Verifique se vips consegue processar:
  ```bash
  docker compose exec processor vipsheader /data/raw/{arquivo}.svs
  ```

### Tiles retornam 503 frequentemente
- Geração on-demand pode demorar para tiles grandes
- Verifique logs da API: `docker compose logs api`
- Considere ajustar timeout em `tilegen-svs.js`

### Tiles retornam 404
- Verifique se coordenadas estão dentro dos limites
- Verifique maxLevel no manifest
- Para WSI, verifique se o raw file ainda existe

### Erro "Could not determine slide dimensions"
- O arquivo pode estar corrompido
- O formato pode não ser suportado pelo OpenSlide
- Tente com outro arquivo SVS para validar

## Limpeza

Para resetar completamente:
```bash
docker compose down -v
rm -rf ./data/raw/* ./data/derived/*
docker compose up -d --build
```

## Notas Técnicas

### Mapeamento de níveis DeepZoom

O formato DeepZoom usa níveis invertidos:
- Nível 0: Resolução mais baixa (1 tile ou poucos)
- Nível N (maxLevel): Resolução original

### Cálculo de maxLevel

```
maxDim = max(width, height)
maxLevel = ceil(log2(maxDim))
```

Exemplo: Imagem 50000x40000:
```
maxDim = 50000
maxLevel = ceil(log2(50000)) = ceil(15.6) = 16
```

### Formato do nome dos tiles

```
tiles/{level}/{col}_{row}.jpg

Onde:
- level: 0 a maxLevel
- col: coluna (x) do tile
- row: linha (y) do tile
```

### Geração de tile on-demand

Para um tile em `(z, x, y)`:
1. Scale factor: `2^(maxLevel - z)`
2. Source region no SVS:
   - srcX = x * tileSize * scale
   - srcY = y * tileSize * scale
   - srcWidth = tileSize * scale
   - srcHeight = tileSize * scale
3. Comando vips:
   ```bash
   vips crop input.svs - srcX srcY srcWidth srcHeight | \
   vips resize - output.jpg (1/scale)
   ```

### Performance

| Operação | Tempo esperado |
|----------|----------------|
| P0 SVS (thumbnail + manifest) | ~1s |
| Tile on-demand (primeira vez) | 100-500ms |
| Tile cached (segunda vez) | ~10ms |
