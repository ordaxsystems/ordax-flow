# OrdaX Gratis 0.4.5

Aplicativo desktop Windows independente que usa a sessão normal do ChatGPT Web dentro do próprio processo Electron, com Tasks locais duráveis e uma interface OrdaX própria.

> Este repositório é separado do `ordax-gpt`. A meta atual é validar o produto isoladamente. Uma eventual integração futura poderá acontecer como app do OrdaX App, somente depois de os gates de qualidade, velocidade e confiabilidade passarem.

## Experiência principal

O usuário trabalha no **chat do OrdaX**. O ChatGPT Web fica oculto por padrão e funciona como worker autenticado.

```text
Usuário
  ↓
UI OrdaX
  ↓
Task / Run / SQLite
  ↓
ChatGPT Web oculto
  ├─ Fast observer experimental (rede recebida pelo próprio WebContents)
  └─ Beta observer estável (MutationObserver/DOM)
  ↓
stream de texto / imagens
  ↓
UI OrdaX
```

A interface original do ChatGPT só aparece quando o usuário escolhe **Modo direto** ou durante autenticação/verificação oficial que precise de interação humana.

## Modos de resposta

- **Automático**: tenta usar Fast quando disponível e mantém Beta como safety net da mesma geração.
- **Fast experimental**: prioriza a observação incremental da resposta recebida pelo próprio WebContents.
- **Beta estável**: observa incrementalmente a resposta renderizada no DOM do ChatGPT.

Fast e Beta não são dois chats separados e não reenviam automaticamente a mesma pergunta. Eles observam a mesma sessão e a mesma geração.

## Estado durável

Dados canônicos:

`%LOCALAPPDATA%\OrdaX\Gratis\data\ordax-gratis.sqlite`

Assets:

`%LOCALAPPDATA%\OrdaX\Gratis\data\assets\...`

A Task local é o SSOT. Uma Task pode atravessar várias conversas internas do ChatGPT: cada URL/chat é somente um segmento de execução. O app persiste Tasks, mensagens, Runs, eventos, checkpoints, memória estruturada canônica, métricas, approvals/actions, imagens locais e o histórico de conversas internas.

Runs deixados como `running` após encerramento inesperado são reconciliados no boot como `interrupted` e permanecem resumíveis.

## Continuidade e memória

A versão 0.4.5 mantém a separação explícita entre **tarefa/projeto** e **conversa do provider** e adiciona memória estruturada canônica sobre essa base. Isso permite trabalhos longos, como um livro, continuarem mesmo quando uma conversa do ChatGPT é encerrada ou precisa ser renovada.

- a coluna esquerda representa Tasks/conversas persistentes do OrdaX;
- o chat central mostra o histórico canônico da Task;
- a coluna direita mostra memória, artefatos e segmentos internos do ChatGPT;
- **Nova conversa interna** arquiva o chat atual, mas não encerra a Task;
- na próxima mensagem, o OrdaX abre um novo chat e injeta contexto de continuidade construído do checkpoint e das mensagens/artefatos recentes;
- o contexto enviado ao novo chat é derivado do estado local, não da memória implícita do ChatGPT.

### Memória estruturada de projeto

A camada seguinte preserva conhecimento canônico da Task sem depender de inferência implícita do provider. Cada item tem categoria, chave, conteúdo, status e proveniência, e pode ser revisado manualmente no painel Contexto.

Categorias canônicas atuais: `entity`, `structure`, `fact`, `decision`, `constraint`, `goal`, `open_loop` e `reference`. Elas são deliberadamente genéricas: em um livro, `entity` pode representar personagem e `structure` um capítulo; em software, podem representar componente e módulo.

Itens ativos são incluídos no pacote de continuidade antes do histórico recente. Um item com a mesma categoria+chave é atualizado em vez de duplicado; arquivar remove o item do contexto ativo sem apagar o registro. Extração semântica automática fica para uma camada posterior e deverá reutilizar o mesmo SSOT, sempre com proveniência explícita.

## Login e segurança

- login oficial ChatGPT/Google dentro do Electron;
- sessão persistente `persist:ordax-gratis-chatgpt`;
- sem importação/exportação de cookies do navegador;
- sem extensão Chrome/Edge;
- sem automação de navegador externo;
- sem OpenAI API para executar as conversas;
- sem chamada direta do app a endpoint privado do ChatGPT para enviar prompts;
- sem bypass de CAPTCHA, Turnstile, fingerprint ou anti-bot;
- renderer e worker com `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`;
- navegação do worker restrita a ChatGPT/OpenAI Auth/Google;
- assets locais expostos apenas via `ordax-asset://`.

## Qualidade e performance

O repo mede cada Run com timestamps persistidos para:

- preparação;
- tentativa e confirmação de submit;
- request observada;
- primeiro byte de rede;
- primeiro delta Fast;
- primeiro delta Beta;
- TTFS/TTFV;
- tempo total.

Os E2E de aceitação operam **somente pela UI do OrdaX** (`desktop/ui.html`). Manipulação direta do ChatGPT é permitida apenas para diagnóstico interno.

## Scripts

- `npm run validate` — check + testes locais.
- `npm run test:live:text` — E2E real de texto pela UI OrdaX.
- `npm run test:live:image` — E2E real de imagem pela UI OrdaX.
- `npm run test:live:continuity` — prova continuidade entre duas conversas internas diferentes usando memória local da mesma Task.
- `npm run test:live:restart` — valida persistência/reabertura pela UI OrdaX.
- `npm run benchmark` — lê as métricas recentes persistidas.
- `npm run benchmark:live` — executa várias amostras pela UI e calcula min/média/p50/p95/p99.
- `npm run test:live:stream` — exige streaming incremental longo e monotônico.
- `npm run build:win` — gera executável portátil Windows x64.

Os testes live requerem o app iniciado com `ORDAX_DESKTOP_DEBUG=1`.

## Gates comprovados nesta linha

- ChatGPT oculto por padrão;
- Modo direto explícito;
- sessão persistente autenticada;
- streaming incremental para a UI OrdaX;
- Fast e Beta funcionando separadamente e arbitrados por quem entrega primeiro;
- streaming monotônico: observer atrasado não reduz texto já mostrado;
- fallback DOM restrito à conversa (`main`), sem espelhar sidebar/chrome do ChatGPT;
- seleção de composer e Novo chat resiliente a layouts responsivos duplicados;
- worker oculto mantém viewport real de desktop;
- envio prioriza o botão visível e usa submit do form apenas como fallback;
- envio sem delay fixo de 1,8 s;
- imagem gerada pela UI OrdaX, persistida e renderizada localmente;
- imagem/Task sobrevivendo a restart;
- testes locais de contrato e persistência verdes, incluindo rotação de conversa com contexto de continuidade.

Veja `docs/BENCHMARK.md` para medições e `REFERENCIAS.md` para os projetos estudados.
