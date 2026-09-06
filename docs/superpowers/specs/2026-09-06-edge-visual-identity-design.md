# Identidade visual SuperNavi e dashboard do edge

Data: 2026-09-06. Aprovado por Ivan em conversa (partes 1, 2 e 3).

## 1. Contexto e objetivo

O dashboard do edge (`supernavi_edge/api/src/dashboard/`) é HTML, CSS e JS estáticos
servidos pela API Fastify no notebook da clínica. Hoje ele usa fundo quase preto com
grade, roxo como acento, ícone genérico no cabeçalho, rótulos em caixa alta e texto
monoespaçado. Nada vem da marca. O viewer usa o tema padrão do Vuetify com paleta
"Apple" e Roboto, e o `logo.svg` dentro do app é o logo de exemplo do Vuetify. O logo
real (blocos em azul-marinho, azul e cinza) existe em `supernavi_frontend/public/images/`.

Objetivo deste ciclo: definir um sistema visual do SuperNavi derivado do logo e
refazer o dashboard do edge com ele. O viewer fica para o próximo ciclo, mas os
tokens já nascem para ele.

Quem usa o edge: Marcos, técnico do laboratório, num notebook ao lado do scanner
Motic, tela de 1366 px. O trabalho dele ali: confirmar os nomes lidos pelo OCR,
ver se as lâminas estão chegando à nuvem, resolver falhas, ajustar configuração.

## 2. Escopo

Dentro:
- Tokens do sistema (`tokens.css`): cores, tipografia, espaçamento, raio, sombra, movimento.
- Dashboard do edge refeito por completo: cabeçalho, trilho lateral, visão geral com
  fila de revisão e blocos de serviços, lâminas, revisão, falhas, atividade,
  configurações, modais de revisão e de timeline, estados vazios e de erro.
- Fontes hospedadas dentro do edge.
- Servidor local de mentira para verificação visual.

Fora (próximo ciclo):
- Viewer: tema Vuetify mapeado nos tokens, cabeçalho, login, lista de casos, chrome do viewer.
- Landing page e extensão.
- Qualquer mudança de comportamento do edge (rotas, fluxo de revisão, OCR).

## 3. Identidade

### 3.1 Cores

Todas derivadas do logo (amostragem do `logosupernavi.png`: `#003858`, `#3890D0`,
`#304048`, `#B8B8C0`).

| Token | Valor | Papel |
|---|---|---|
| `--sn-petroleo` | `#003858` | Cor da marca. Base das superfícies escuras. |
| `--sn-azul` | `#3890D0` | Único acento: ação, foco, seleção, "processando". |
| `--sn-grafite` | `#304048` | Bordas e superfícies secundárias. |
| `--sn-prata` | `#B8B8C0` | Texto de apoio, estados inativos. |
| `--sn-papel` | `#F4F7FA` | Fundo claro. Reservado ao viewer. |
| `--sn-ok` | `#35B37A` | Pronto, conectado, confirmado. |
| `--sn-atencao` | `#E0A33A` | Aguardando pessoa, degradado. |
| `--sn-falha` | `#E25C5C` | Erro, desconectado. |

Escala escura do edge (petróleo escurecido em três degraus mais um de realce):

| Token | Valor | Uso |
|---|---|---|
| `--sn-fundo` | `#071A28` | Página. |
| `--sn-painel` | `#0B2436` | Trilho, cabeçalho, áreas de agrupamento. |
| `--sn-cartao` | `#10334A` | Cartões, linhas em foco, modais. |
| `--sn-realce` | `#1A4460` | Hover, bordas fortes, separadores. |
| `--sn-borda` | `rgba(184, 184, 192, 0.14)` | Borda padrão. |
| `--sn-texto` | `#E6EEF5` | Texto principal. |
| `--sn-texto-2` | `#9FB3C4` | Texto secundário. |
| `--sn-texto-3` | `#6E8496` | Texto terciário, metadados. |

Cada cor de estado tem uma variante de fundo a 14% de opacidade (`--sn-ok-bg` etc.)
para chips e blocos. Não existem gradientes, brilhos, sombras coloridas nem grade de
fundo. A única sombra é `--sn-sombra: 0 8px 24px rgba(0, 0, 0, 0.35)`, em modais.

Contraste mínimo: texto principal e secundário sobre `--sn-cartao` acima de 7:1 e
4.5:1 respectivamente. Cores de estado nunca são o único sinal: sempre acompanham
forma (bloco cheio ou vazado) ou texto.

### 3.2 Tipografia

Uma família: **Atkinson Hyperlegible Next**, pesos 400, 500 e 700, arquivos woff2
em `dashboard/fonts/` com `@font-face` e `font-display: swap`. Fallback
`system-ui, "Segoe UI", sans-serif`. Nada de CDN: o notebook precisa renderizar
sem rede.

Motivo: a fonte foi desenhada para distinguir I, l, 1, O e 0. O produto vive de ler
identificadores como `AP26000388A1` e `RE26000003`, e o incidente de 2026-09-04 nasceu
de uma leitura ambígua.

Escala (px / line-height):

| Papel | Tamanho | Peso |
|---|---|---|
| Número grande da fila | 32 / 1.1 | 700 |
| Título de página | 22 / 1.25 | 700 |
| Título de seção e de modal | 18 / 1.3 | 700 |
| Identificador de lâmina | 15 / 1.4 | 700, `font-variant-numeric: tabular-nums` |
| Corpo | 14 / 1.5 | 400 |
| Listas, metadados, trilho | 13 / 1.5 | 400 e 500 |
| Contadores e horas | herdam o tamanho, `tabular-nums` | |

Regras: frase normal em tudo (sem caixa alta, sem `letter-spacing` aberto), sem
monoespaçado, sem itálico. Um único peso forte por linha.

### 3.3 Espaçamento, raio, forma

- Escala de espaçamento: 4, 8, 12, 16, 24, 32, 48 (`--sn-esp-1` a `--sn-esp-7`).
- Raio: 6 px em controles, 10 px em cartões e modais, 12 px nos blocos de serviço.
  Nada de raio uniforme em tudo: linhas de lista não têm raio.
- Bordas de 1 px em `--sn-borda`. Sem sombra fora dos modais.
- Ícones: traço único de 1.5 px, 18 px em linha e 20 px no trilho, sempre na cor do
  texto ao lado (SVG inline, conjunto Lucide, já usado hoje). Ícone nunca fica sozinho
  sem rótulo, exceto botão de fechar.

### 3.4 O elemento memorável: blocos de serviço

Os sete serviços do edge (Túnel, Scanner, Entrada, Banco, Fila, Processador, Disco)
aparecem como blocos quadrados de 44 px com a silhueta dos blocos do logo: quadrado de raio 12 com
um entalhe retangular numa borda (o "colchete" do logo, entalhe de 1/3 do lado).
Estados:

- Pronto: bloco preenchido em `--sn-ok`, entalhe na cor do painel.
- Processando: preenchido em `--sn-azul`.
- Aguardando ou degradado: só contorno de 2 px em `--sn-atencao`, interior vazio.
- Falha: preenchido em `--sn-falha`.
- Desconhecido (ainda sem dado): contorno em `--sn-prata` a 40%.

Ao lado de cada bloco, nome do serviço em 14/500 e uma linha de detalhe em 13
(`Agente MAC01`, `Motic`, `/data/inbox`, `119 lâminas`, `3 na fila`, `Ocioso`,
`104 prontas`). Os sete blocos ficam numa única linha de 150 px cada, como uma
fatia da grade do logo; abaixo de 1100 px quebram em duas linhas.
"Scanner" é o adaptador Motic, "Entrada" é a pasta de inbox (watcher), "Banco" é o
PostgreSQL local. É o único lugar da
interface que "desenha"; todo o resto é linha, texto e espaço.

Mudança de estado de um bloco anima a cor em 240 ms. Nenhuma outra animação de
entrada. `prefers-reduced-motion` desliga tudo.

### 3.5 Voz e texto

- Nomes de ação iguais aos do viewer: Confirmar, Renomear, Confirmar todas,
  Rescanear, Publicar etiquetas, Republicar previews, Salvar configuração.
- Verbo no botão diz o que acontece. A confirmação repete o verbo:
  "Publicar etiquetas" gera "Etiquetas publicadas: 104 lâminas".
- Estados vazios orientam: "Nenhuma lâmina com falha. O scanner segue sendo
  monitorado." / "Nenhuma lâmina aguardando confirmação." / "Nenhuma lâmina
  encontrada com este filtro."
- Erros dizem o que aconteceu e o que fazer: "Não foi possível ler a fila.
  A API do edge não respondeu. Tentando de novo em 5 s."
- Sem jargão de sistema para o técnico: "Fila" em vez de "Redis", "Banco" em vez de
  "PostgreSQL", "Entrada" em vez de "Watcher". Detalhes técnicos ficam na linha
  secundária.

## 4. Dashboard do edge

### 4.1 Estrutura

```
┌──────────────────────────────────────────────────────────────────┐
│ ▦ SuperNavi Edge    Agente MAC01              ● Túnel  ● Scanner │
├──────────┬───────────────────────────────────────────────────────┤
│ Visão    │ Aguardando sua confirmação      17     [Confirmar todas]│
│ geral    │ ┌────┬────┬────┬────┬────┐                             │
│ Lâminas  │ │foto│foto│foto│foto│ +12│  nome lido, foto ao lado     │
│ Revisão 17│ └────┴────┴────┴────┴────┘                             │
│ Falhas   │ Serviços                                                │
│ Atividade│ ▣ Túnel ▣ Scanner ▣ Entrada ▣ Banco ▣ Fila ▣ Proc. ▣ Disco│
│ Config.  │ Lâminas recentes                                        │
│          │ AP26002643   _20260904085830.svs   pronta   há 2 h       │
│          │ RE26000003   RE26000003.svs        pronta   há 30 min    │
└──────────┴───────────────────────────────────────────────────────┘
```

- **Cabeçalho** (56 px, `--sn-painel`): marca de blocos do logo em 28 px, "SuperNavi
  Edge" em 15/700, o agente em 13 (`--sn-texto-2`; o edge não guarda nome de
  laboratório, então só o agente), à direita dois
  indicadores de saúde sempre visíveis (Túnel, Scanner) com ponto de 8 px e rótulo.
  Some o "Desconectado" solto.
- **Trilho** (200 px, `--sn-painel`): seis destinos com ícone e rótulo. Ativo com fundo
  `--sn-cartao` e barra de 3 px em `--sn-azul` na borda esquerda. "Revisão" leva um
  contador em `--sn-atencao` quando há pendentes. Abaixo de 1100 px o trilho
  recolhe para 56 px só com ícones e `title`.
- **Conteúdo**: largura máxima 1180 px, alinhado à esquerda, padding 24.

### 4.2 Telas

**Visão geral.** Três faixas, nesta ordem:
1. *Aguardando sua confirmação*: título 18, número grande 32 em `--sn-atencao`,
   botão "Confirmar todas" (secundário) e "Abrir revisão" (primário). Abaixo, até
   cinco miniaturas da foto da etiqueta (64 px) com o nome lido; a última mostra
   "+N". Clique abre o modal de revisão naquela lâmina. Quando não há pendentes, a
   faixa reduz a uma linha: "Nenhuma lâmina aguardando confirmação".
2. *Serviços*: os sete blocos (3.4) e, à direita, "Manutenção" com os botões
   Republicar previews e Publicar etiquetas (secundários, 13).
3. *Lâminas recentes*: dez últimas, mesma linha da tela Lâminas, link "Ver todas".

**Lâminas.** Filtros como segmento (Todas, Prontas, Processando, Erro) e contagem
à direita em `tabular-nums`. Lista em linhas de 48 px: identificador 15/700,
arquivo original 13 em `--sn-texto-2`, chip de estado, tempo relativo, ação
"Timeline". Sem cartões, sem miniatura na lista. Estado vazio por filtro.

**Revisão.** A fila completa: cada item é um cartão horizontal com a foto da
etiqueta (160 px) à esquerda, nome lido pelo OCR em campo editável 15/700 (mesma
validação de hoje), botões Confirmar (primário), Rescanear, e link "foto da lâmina
inteira". "Confirmar todas" no topo. Este é o único lugar com cartões, porque a
foto é o objeto.

**Falhas.** Duas seções: "Falhas de processamento" e "Sincronização travada".
Linhas com identificador, etapa, mensagem de erro em 13 e botão Reprocessar. Estado
vazio: "Nenhuma lâmina com falha. O scanner segue sendo monitorado."

**Atividade.** Feed em linhas: hora em `tabular-nums`, ícone de tipo, texto.
Botão "Limpar" secundário.

**Configurações.** Formulário em uma coluna de 560 px: campos com rótulo em cima,
ajuda em 13 abaixo. Chave do edge com mostrar/ocultar. "Salvar configuração"
primário; a resposta repete o verbo. Bloco "Este edge" com agente, versão e URL da
nuvem em linhas rótulo/valor.

### 4.3 Modais

- Fundo `rgba(7, 26, 40, 0.7)`, caixa `--sn-cartao`, raio 10, sombra `--sn-sombra`,
  largura 720 (revisão) e 640 (timeline), título 18, botão de fechar no canto.
- **Revisão de uma lâmina**: foto grande (label.jpg, alternável para slide2.jpg),
  campo de nome com pré-visualização do nome normalizado, mensagem de validação em
  `--sn-falha` sob o campo, botões Confirmar, Rescanear, Fechar, navegação
  anterior/próxima.
- **Timeline da lâmina**: lista vertical com hora, etapa, nível (ponto colorido) e
  mensagem; erros expandem detalhes.

### 4.4 Componentes

- Botão primário: fundo `--sn-azul`, texto `--sn-fundo`, 36 px, raio 6, 14/500.
- Botão secundário: borda `--sn-borda`, texto `--sn-texto`, fundo transparente,
  hover `--sn-realce`.
- Botão perigoso (Excluir): borda e texto em `--sn-falha`.
- Chip de estado: 22 px, raio 6, fundo na variante 14%, texto na cor do estado,
  13/500. Texto: pronta, processando, na fila, erro, aguardando.
- Campo: 36 px, fundo `--sn-fundo`, borda `--sn-borda`, foco com anel de 2 px em
  `--sn-azul`. Erro com borda `--sn-falha`.
- Segmento de filtros: contêiner com borda, item ativo em `--sn-cartao` e texto
  `--sn-texto`.
- Foco de teclado visível em tudo: anel de 2 px `--sn-azul` deslocado 2 px.

### 4.5 Responsividade e acessibilidade

- Alvo: 1366 × 768. Funciona de 1024 a 1920. Abaixo de 1100 o trilho recolhe e os
  blocos de serviço quebram em duas linhas; abaixo de 900 a lista esconde a coluna
  de arquivo.
- Contraste conforme 3.1. Todos os controles alcançáveis por teclado, modais com
  `role="dialog"`, `aria-modal`, foco preso e Esc para fechar.
- `prefers-reduced-motion: reduce` remove transições.

## 5. Implementação

### 5.1 Arquivos

- `dashboard/tokens.css`: só variáveis, sem seletores além de `:root`. É o arquivo
  que o viewer vai consumir depois.
- `dashboard/dashboard.css`: componentes e telas. Substitui `style.css`, que é
  apagado. Seletores por classe, uma camada de especificidade, sem `!important`.
- `dashboard/fonts/`: `atkinson-hyperlegible-next-{400,500,700}.woff2` baixados da
  Google Fonts e versionados, com `@font-face` no `tokens.css`.
- `dashboard/index.html`: nova marcação. Mantém todos os `id`s que o `app.js` lê e
  escreve (`tabBar`, `panel-*`, `statusGrid`, `card-*`, `slidesList`, `filterButtons`,
  `failuresList`, `pipelineModal*`, `ocrModal*`, `reviewModal*`, `settingsForm`, etc.).
  Os botões do trilho continuam com `class="tab-btn"` e `data-tab`, para o roteamento
  de abas existente funcionar sem mudança.
- `dashboard/app.js`: ajustes pontuais: (a) render dos blocos de serviço no lugar
  dos cartões de status; (b) faixa de revisão na visão geral, reutilizando a lógica
  da fila; (c) contador no trilho; (d) textos dos estados vazios e das confirmações.
  Nenhuma mudança em chamadas de API.
- Os arquivos são servidos pelo `@fastify/static` já apontado para a pasta
  `dashboard` (`api/src/server.js`), então `tokens.css`, `dashboard.css` e `fonts/`
  não precisam de rota nova.

### 5.2 Verificação

- Servidor de mentira em `supernavi_edge/scripts/dashboard-mock.js`: serve a pasta
  do dashboard e responde `/v1/health`, `/v1/dashboard`, `/v1/slides`,
  `/v1/pending-slides`, `/v1/pending-slides/:id/image`, `/v1/dashboard/failures`,
  `/v1/admin/config` com dados de exemplo em três cenários (`?cenario=normal`,
  `fila`, `falhas`): fila com 17, túnel caído, três falhas.
- Screenshots em 1366 × 768 de cada tela e modal nos três cenários, revisados contra
  este documento antes do PR.
- Testes existentes do edge continuam verdes (`node --test` nas libs e rotas).
- Contraste conferido nos pares de 3.1 com uma checagem por script.

### 5.3 Entrega

Um PR no edge (`feat/visual-identity`), versão 0.4.0. Deploy no lab pelo mesmo
`git pull && docker compose up -d --build api`. O processor não muda.

## 6. Próximo ciclo (fora deste)

Viewer: mapear `tokens.css` no tema Vuetify (`medicalLight` vira a paleta papel,
petróleo, azul), trocar Roboto pela Atkinson Hyperlegible Next, substituir o
`logo.svg` do Vuetify pelo logo real, cabeçalho e login. Extensão e landing seguem
o mesmo sistema.
