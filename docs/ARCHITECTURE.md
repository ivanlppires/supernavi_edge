# SuperNavi Local Agent - Arquitetura

## Visão Geral

O SuperNavi Local Agent é o componente edge da plataforma SuperNavi para patologia digital. Ele executa localmente na máquina do patologista, processando lâminas digitais (WSI) sem dependência de conexão com a internet.

## Princípio Fundamental: Edge-First

O agente local é a **fonte primária de dados e processamento**. A nuvem atua apenas como extensão para:
- Sincronização de metadados
- Acesso remoto
- Colaboração entre usuários

A experiência do usuário é **idêntica** independentemente de estar acessando via agente local ou cloud.

## Componentes

```
┌─────────────────────────────────────────────────────────────┐
│                    SuperNavi Local Agent                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────┐    ┌─────────────┐    ┌──────────────────┐    │
│  │   API   │◄───│   Redis     │───►│    Processor     │    │
│  │ Fastify │    │   (Queue)   │    │ OpenSlide+libvips│    │
│  └────┬────┘    └─────────────┘    └────────┬─────────┘    │
│       │                                      │              │
│       └──────────────┬───────────────────────┘              │
│                      ▼                                      │
│              ┌───────────────┐                              │
│              │  PostgreSQL   │                              │
│              │   (Local DB)  │                              │
│              └───────────────┘                              │
│                      │                                      │
│                      ▼                                      │
│              ┌───────────────┐                              │
│              │     Sync      │◄────── Cloud API            │
│              │    Engine     │                              │
│              └───────────────┘                              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### API (Fastify)

Responsável por:
- Expor endpoints HTTP locais (porta 3000, apenas localhost)
- Contrato de API **idêntico** ao cloud
- Servir tiles de imagens para o viewer
- Gerenciar anotações
- Status e capabilities do agente

Endpoints base:
- `GET /v1/health` - Status do agente
- `GET /v1/capabilities` - Capacidades disponíveis

### Processor (OpenSlide + libvips)

Responsável por:
- Ingestão de arquivos WSI (SVS, NDPI, TIFF, MRXS)
- Geração de tiles para visualização
- Extração de metadados das lâminas
- Processamento em background via fila Redis

Características:
- Processa arquivos de vários GB de forma eficiente
- Usa streaming/tiling para não sobrecarregar memória
- Cache local de tiles processados

### Sync Engine

Responsável por:
- Sincronização bidirecional com a nuvem
- Resolução de conflitos (local sempre prevalece em dados críticos)
- Upload de metadados e thumbnails
- Download de anotações remotas

Características:
- Non-blocking (nunca trava a operação local)
- Resumable (retoma de onde parou após falhas de rede)
- Graceful degradation (funciona 100% offline)

### PostgreSQL

Banco de dados local contendo:
- Catálogo de lâminas (`slides`, `jobs`)
- Organização de casos (`cases`, `case_slides`)
- Anotações geométricas (`annotations`)
- Threads e mensagens (`threads`, `messages`)
- Histórico de sincronização (`outbox_events`)
- Configurações do usuário

### Redis

Fila de jobs para:
- Processamento de novas lâminas
- Tarefas de sincronização pendentes
- Cache de sessão

## Fluxo Principal

```
1. INGESTÃO
   Scanner salva arquivo WSI → Agente detecta novo arquivo

2. PROCESSAMENTO
   Job enfileirado → Processor extrai metadados e gera tiles → Registro no PostgreSQL

3. VISUALIZAÇÃO
   Browser acessa app.supernavi.app → API local serve tiles → Viewer renderiza

4. SINCRONIZAÇÃO
   Sync Engine detecta alterações → Upload para cloud → Cloud disponibiliza para acesso remoto
```

## API Idêntica Local/Cloud

O frontend (SPA) não sabe se está consumindo a API local ou cloud. O roteamento é transparente:

- Se agente local disponível → requisições vão para `localhost:3000`
- Se agente indisponível → requisições vão para cloud API

Isso permite:
- Mesma experiência em qualquer contexto
- Transição seamless entre modos
- Código frontend único

## Camada de Colaboração Local-First

O agente implementa uma camada de colaboração completa que funciona 100% offline:

### Entidades

```
Cases ──< Case_Slides >── Slides
                            │
                 ┌──────────┼──────────┐
                 │          │          │
           Annotations   Threads ── Messages
```

### Características

- **Cases**: Agrupam slides em casos diagnósticos
- **Annotations**: Marcações geométricas com versionamento otimista
- **Threads/Messages**: Discussões ancoradas em slides ou anotações
- **Outbox**: Toda operação é registrada para sincronização futura

### SSE (Server-Sent Events)

Eventos em tempo real via `/v1/events`:

| Evento | Descrição |
|--------|-----------|
| `slide:import` | Nova lâmina detectada |
| `slide:ready` | Processamento P0 completo |
| `tile:pending/generated` | Tiles on-demand |
| `case.created` | Novo caso |
| `case.slide_linked/unlinked` | Vinculação de slides |
| `annotation.created/updated/deleted` | Anotações |
| `thread.created` | Novo thread |
| `message.created` | Nova mensagem |

### Documentação Detalhada

Ver [COLLAB_LOCAL.md](./COLLAB_LOCAL.md) para:
- Modelo de dados completo
- Todos os endpoints de API
- Exemplos de uso
- Fluxo de sincronização futura

## Segurança

- API exposta apenas em `127.0.0.1` (não acessível externamente)
- Dados clínicos nunca saem automaticamente para a nuvem
- Diagnósticos de suporte são opt-in e anonimizados
