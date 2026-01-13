# SuperNavi Local Pipeline

## Visão Geral

O pipeline local processa imagens e lâminas digitais (WSI) em tiles DeepZoom para visualização no viewer.

### Formatos Suportados

| Formato | Extensões | Pipeline |
|---------|-----------|----------|
| JPEG | .jpg, .jpeg | Sharp (Node.js) |
| PNG | .png | Sharp (Node.js) |
| **SVS** | **.svs** | **OpenSlide + libvips** |
| TIFF | .tif, .tiff | OpenSlide + libvips |
| NDPI | .ndpi | OpenSlide + libvips |
| MRXS | .mrxs | OpenSlide + libvips |

### Fases de Processamento

**Para JPG/PNG:**
- **P0**: Níveis 0-4 (preview rápido)
- **P1**: Níveis restantes (zoom completo)

**Para SVS/WSI:**
- **P0**: Todos os níveis de uma vez via `vips dzsave`
- **P1**: Não necessário (dzsave gera tudo)

## Fluxo de Ingestão

```
1. Coloque um arquivo em ./data/inbox/
   - Suportados: .jpg, .jpeg, .png, .svs, .tif, .tiff, .ndpi, .mrxs
2. O watcher detecta o arquivo
3. Calcula hash SHA256 como slideId
4. Move para ./data/raw/{slideId}_{filename}
5. Cria registro no banco com status "queued" e formato
6. Enfileira job P0 no Redis
7. Processor consome job e roteia para pipeline apropriado
8. Slide fica com status "ready"
```

## Processamento SVS (Whole Slide Image)

### Como funciona

1. **Leitura de metadados**: `openslide-show-properties` ou `vipsheader`
2. **Geração de thumbnail**: `vips thumbnail`
3. **Geração de tiles**: `vips dzsave` com parâmetros:
   - `--tile-size 256`
   - `--overlap 0`
   - `--suffix .jpg[Q=90]`
4. **Normalização**: Renomeia `dzi_files/` para `tiles/`

### Estrutura de saída

```
./data/derived/{slideId}/
├── thumb.jpg           # Thumbnail (max 256x256)
├── manifest.json       # Metadados DeepZoom
└── tiles/
    ├── 0/              # Nível 0 (menor resolução)
    │   └── 0_0.jpg
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
  "maxLevel": 15,
  "width": 50000,
  "height": 40000,
  "tileUrlTemplate": "/v1/slides/{slideId}/tiles/{z}/{x}/{y}.jpg"
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
      "format": "svs"
    }
  ]
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
# Nível 0 (menor resolução)
curl http://localhost:3000/v1/slides/{slideId}/tiles/0/0/0.jpg -o tile.jpg

# Nível máximo (maior resolução)
curl http://localhost:3000/v1/slides/{slideId}/tiles/15/100/80.jpg -o tile.jpg
```

### Obter info do slide
```bash
curl http://localhost:3000/v1/slides/{slideId}
```

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

### 4. Acompanhar processamento
```bash
# Ver logs do processor
docker compose logs -f processor

# Verificar slides
curl http://localhost:3000/v1/slides | jq
```

### 5. Verificar resultado
```bash
SLIDE_ID=$(curl -s http://localhost:3000/v1/slides | jq -r '.items[0].slideId')

# Manifest
curl http://localhost:3000/v1/slides/$SLIDE_ID/manifest | jq

# Thumbnail
curl http://localhost:3000/v1/slides/$SLIDE_ID/thumb -o thumb.jpg

# Tile do nível 0
curl http://localhost:3000/v1/slides/$SLIDE_ID/tiles/0/0/0.jpg -o tile.jpg
```

## Troubleshooting

### Slide não aparece na lista
- Verifique se a extensão é suportada: `.jpg`, `.jpeg`, `.png`, `.svs`, `.tif`, `.tiff`, `.ndpi`
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

### Tiles não carregam
- Verifique se o status é "ready"
- Verifique estrutura: `ls -la ./data/derived/{slideId}/tiles/`
- Verifique se os tiles foram normalizados corretamente

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

O `vips dzsave` gera níveis no padrão DeepZoom:
- Nível 0: Resolução mais baixa (1 tile ou poucos)
- Nível N (maxLevel): Resolução original

### Cálculo de maxLevel

```
maxDim = max(width, height)
maxLevel = ceil(log2(maxDim / tileSize))
```

Exemplo: Imagem 50000x40000 com tileSize=256:
```
maxDim = 50000
maxLevel = ceil(log2(50000/256)) = ceil(7.6) = 8
```

### Formato do nome dos tiles

```
tiles/{level}/{col}_{row}.jpg

Onde:
- level: 0 a maxLevel
- col: coluna (x) do tile
- row: linha (y) do tile
```
