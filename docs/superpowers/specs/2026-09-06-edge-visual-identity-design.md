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

> **Revisão de 2026-09-06, tarde.** A primeira versão desta spec propunha um
> sistema próprio, com fundo petróleo e a Atkinson Hyperlegible em toda a
> interface. Depois de ver aquilo rodando, Ivan pediu a direção Apple-like com
> opção de claro e escuro, valendo para o edge e para o viewer, mantendo o azul
> da marca como acento. Esta seção descreve o sistema que está no código; a
> proposta anterior fica registrada no histórico do git.

O idioma é o do macOS: fundo agrupado, conteúdo em cartões sem sombra, linhas
separadas por fio recuado, barra e trilho translúcidos, tipografia do sistema,
cor usada com função e não como decoração. O que torna isto SuperNavi, e não um
app de sistema genérico, são três escolhas:

1. Os cinzas neutros da Apple são puxados alguns graus para o petróleo do logo.
2. O acento é o azul da marca, na profundidade que cada fundo aguenta.
3. A única cor saturada da janela vem das fotos das etiquetas.

### 3.1 Cores

Marca, igual nos dois temas: `--sn-petroleo` `#003858` e `--sn-azul-marca`
`#3890D0`.

| Token | Claro | Escuro | Uso |
|---|---|---|---|
| `--sn-fundo` | `#F1F3F6` | `#17191C` | janela |
| `--sn-superficie` | `#FFFFFF` | `#202329` | grupos, cartões, campos |
| `--sn-superficie-2` | `#F7F9FB` | `#2A2E35` | hover, trilho do segmentado |
| `--sn-separador` | `rgba(22,32,42,.12)` | `rgba(160,175,190,.16)` | fio entre linhas |
| `--sn-texto` | `#16202A` | `#FFFFFF` | texto principal |
| `--sn-texto-2` | `#556571` | `#9AA0A9` | secundário |
| `--sn-texto-3` | `#67757F` | `#8A9099` | metadados |
| `--sn-azul` | `#1F6FA8` | `#4FA3E0` | ação, link, seleção |
| `--sn-sobre-azul` | `#FFFFFF` | `#17191C` | texto sobre o botão primário |
| `--sn-verde` | `#17805A` | `#32D583` | pronta, conectado |
| `--sn-ambar` | `#9A6212` | `#F5A524` | aguardando |
| `--sn-vermelho` | `#C2352C` | `#FF6B6B` | erro |

Todo par de texto sobre superfície fica acima de 4,5:1, e o texto principal
acima de 7:1. O teste de tokens mede isso nos dois temas e falha se alguém
mexer numa cor sem olhar o contraste.

O azul claro `#1F6FA8` é o azul da marca escurecido até passar em contraste
sobre branco; no escuro ele é clareado para `#4FA3E0`. É o mesmo movimento que a
Apple faz entre `#007AFF` e `#0A84FF`.

Materiais: barra e trilho usam `--sn-material`, um branco ou cinza a 72% com
`backdrop-filter`, e caem para uma cor sólida onde o navegador não suporta.
Sombra existe só em modal e aviso.

### 3.2 Temas

Claro é o padrão. O escuro entra pela preferência do sistema ou por escolha
explícita, e a escolha vence a preferência:

1. Sem escolha gravada, vale `prefers-color-scheme`, e mudar a preferência do
   sistema muda a janela na hora.
2. A escolha é gravada em `localStorage`, chave `supernavi_tema`.
3. Um script no `<head>` aplica o tema antes da primeira pintura, para a janela
   não piscar branca.

Dois controles: um botão na barra superior, que alterna claro e escuro, e um
segmentado em Configurações → Aparência com Sistema, Claro e Escuro.

### 3.3 Tipografia

Duas famílias, com papéis separados por regra, não por gosto:

- **Interface**: a pilha do sistema (`-apple-system`, `BlinkMacSystemFont`,
  `Segoe UI`, `system-ui`). No Mac isso é a San Francisco de verdade.
- **Identificadores**: Atkinson Hyperlegible Next, hospedada no edge, só em
  número de caso, nome de arquivo e contagem. A fonte separa I, l, 1, O e 0, e
  um erro de leitura aqui troca de paciente.

Escala: título de página 28/600, título de grupo 20/600, destaque 15/600, corpo
14/400, menor 13, mini 12. Peso máximo 600, nunca 700: a Apple usa semibold em
títulos, e negrito pesado denuncia outro sistema. Frase normal em tudo, sem
caixa alta, sem itálico.

### 3.4 Forma e componentes

Raio 10 em grupos e 7 em controles. Linha de 44 px com fio recuado 16 px da
borda, como nas listas do macOS. Botão primário preenchido no azul; secundário
com borda; ação dentro de linha é texto azul, e destrutiva é texto vermelho, sem
borda. Ação destrutiva dentro de um diálogo é preenchida em vermelho. Chip de
estado em cápsula com a cor a 12%. Segmentado com trilho cinza e item ativo
elevado. Foco de teclado com anel de 3 px no azul.

Nada de gradiente, de sombra sob cartão, nem de rótulo em caixa alta acima de
conteúdo.

### 3.5 Sem diálogos do navegador

`alert`, `confirm` e `prompt` estão proibidos: travam a página, ignoram o tema e
não têm foco tratado. No lugar existem `confirmar()`, um diálogo com foco preso,
Esc para cancelar e verbo próprio no botão, e `avisar()`, um aviso que aparece no
canto e some sozinho. Um teste falha se alguém reintroduzir os nativos.

### 3.6 Voz

Nomes de ação iguais aos do viewer: Confirmar, Renomear, Confirmar todas,
Rescanear, Publicar, Republicar, Salvar configuração. O verbo do botão volta na
confirmação. Estados vazios dizem o que esperar. Erros dizem o que aconteceu e o
que fazer.

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
