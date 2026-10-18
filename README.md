# OrdaX Gratis 0.4.11

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

**Rascunhos por projeto:** o texto ainda não enviado fica em `tasks.draft` no SQLite, separado por Task, com revisão monotônica (`draft_revision`) para que gravações atrasadas não restaurem texto já enviado. Alternar projetos ou reiniciar o aplicativo recupera o rascunho correspondente. Ele não se torna mensagem, evento ou memória canônica até ser enviado; a confirmação de envio registra primeiro a mensagem local e só então limpa o rascunho.

## Continuidade e memória

O OrdaX separa **projeto persistente (Task)** de **conversa descartável do provider**. Um projeto pode ser software, pesquisa, planejamento, criação de conteúdo ou qualquer trabalho de longa duração. Quando a conversa interna acaba, sua memória, checkpoints, decisões e artefatos continuam pertencendo à mesma Task local.

- a coluna esquerda representa Tasks/conversas persistentes do OrdaX, com nomes de projeto editáveis no cabeçalho do chat;
- o chat central mostra o histórico canônico da Task;
- a coluna direita mostra memória, artefatos e segmentos internos do ChatGPT;
- a rotação automática pode trocar de chat técnico após 24 respostas concluídas no mesmo segmento, sem criar outra Task ou alterar o histórico exibido;
- na próxima mensagem, o OrdaX abre um novo chat e injeta contexto de continuidade construído do checkpoint e das mensagens/artefatos recentes;
- o contexto enviado ao novo chat é derivado do estado local, não da memória implícita do ChatGPT.

### Memória estruturada de projeto

A camada seguinte preserva conhecimento canônico da Task sem depender de inferência implícita do provider. Cada item tem categoria, chave, conteúdo, status e proveniência, e pode ser revisado manualmente no painel Contexto.

Categorias canônicas atuais: `entity`, `structure`, `fact`, `decision`, `constraint`, `goal`, `open_loop` e `reference`. Elas descrevem, respectivamente, entidades/componentes, estrutura, fatos, decisões, restrições, objetivos, pendências e referências. Nenhuma categoria depende do domínio do projeto.

Itens ativos são incluídos no pacote de continuidade antes do histórico recente. Um item com a mesma categoria+chave é atualizado em vez de duplicado; arquivar remove o item do contexto ativo sem apagar o registro. Extração semântica automática fica para uma camada posterior e deverá reutilizar o mesmo SSOT, sempre com proveniência explícita.

### Sugestões de memória (0.4.6)

A conversa pode gerar **candidatos**, nunca fatos canônicos automaticamente. O detector local reconhece declarações explícitas e identificadas, como `Objetivo MVP: ...`, `Decisão Persistência: ...`, `Restrição Privacidade: ...`, `Pendência Autenticação: ...` e `Estrutura Serviços: ...`. Sinônimos antigos continuam aceitos por compatibilidade, mas não definem o produto. O detector não faz chamadas adicionais ao ChatGPT nem interpreta livremente o diálogo. Ações no painel Contexto: **Aprovar**, **Editar** antes de aprovar, **Descartar** e **Analisar** mensagens anteriores.

Os candidatos ficam em `project_memory_candidates`, com mensagem de origem, versão do detector, evidência, decisão e horário de revisão. Uma rejeição não reaparece ao reanalisar a mesma mensagem; aprovações atualizam `project_memory_items` com proveniência da mensagem e transação SQLite. O pacote de continuidade inclui **somente memórias aprovadas**, jamais sugestões pendentes ou recusadas. Nesta fase não há extração semântica livre nem aprovação silenciosa.

**Proteção de conflitos:** quando uma sugestão aponta para a mesma categoria+chave de uma memória já aprovada, a UI mostra os valores **atual** e **proposto**. Substituir exige abrir a revisão e marcar confirmação explícita. O backend confere dentro da transação o ID e conteúdo canônico esperado; se alguém atualizou o item enquanto ele estava aberto, a aprovação falha sem sobrescrever o valor novo.

### Montagem do contexto de continuidade (0.4.7)

O provedor recebe um **pacote limitado e determinístico**, construído pela Task local. A seleção prioriza objetivos, restrições, decisões, pendências, estrutura, entidades, fatos e referências; mensagens recentes entram como histórico, não como cânone. Nenhum item pendente ou arquivado é promovido automaticamente.

O OrdaX **não corta mais o pacote no meio de um registro** e sinaliza quantitativamente memórias e mensagens que não couberam. A íntegra continua no SQLite e no painel de Contexto. O pedido atual do usuário é preservado sem truncamento, mesmo quando a mensagem é maior que o orçamento disponível para continuidade. O ChatGPT não deve supor o conteúdo dos itens omitidos; em projetos extensos, o usuário pode revisar e atualizar o checkpoint e os itens prioritários.

Esta base independe do tipo de projeto e não tenta simular memória infinita do ChatGPT: memória persistente, versões e decisões pertencem ao OrdaX.

### Sessões automáticas por projeto (0.4.8)

A interface principal apresenta **um único histórico do projeto**. O ChatGPT fica oculto como provider; seus segmentos internos são visíveis somente em **Contexto → Detalhes das sessões internas**, recolhido por padrão.

Após **24 respostas concluídas com sucesso** no mesmo segmento, o OrdaX prepara uma nova conversa interna **antes do próximo envio**, injetando o contexto canônico e o histórico limitado da Task. Essa contagem é mantida no SQLite por Run de forma idempotente e preservada após reiniciar o app. A nova conversa só é associada à Task quando uma resposta é concluída e devolve sua URL; o histórico visual não reinicia.

A identidade das conversas internas é validada por URL canônica de chat, sem parâmetros ou fragmentos. Se o provider retornar uma página de início, login ou compartilhamento, o OrdaX não a registra como conversa: mantém a resposta já observada, arquiva o vínculo anterior e prepara nova conversa na próxima mensagem, sem reenvio automático. Alterações de parâmetros na mesma URL não criam segmentos fictícios.

A troca é uma política preventiva de organização do contexto, não um detector garantido de janela cheia. Limites de uso, verificação, autenticação ou erros do ChatGPT não são contornados: nenhuma mensagem é reenviada automaticamente, e uma Run não confirmada permanece falha ou interrompida. A opção manual fica nos detalhes técnicos e não pode ser usada durante uma execução ativa. Não há limite fixo para o número de segmentos internos, mas a qualidade da continuidade depende dos checkpoints e memórias aprovadas.

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

Veja `docs/SSOT.md` para contratos canônicos, projeções de leitura e invariantes contra duplicação; `docs/BENCHMARK.md` para medições e `REFERENCIAS.md` para os projetos estudados.

### Leitura escalável do SQLite (0.4.10–0.4.11)

A lista lateral entrega só metadados, sem replicar rascunhos/checkpoints/URLs internos. A interface mostra uma página de até 50 mensagens por vez, com botões para navegar entre páginas antigas e recentes; a Task completa permanece no mesmo SQLite. A navegação usa cursor estável `(created_at,id)`, não OFFSET nem cache paralelo. O painel de imagens exibe apenas os artefatos da página atual. O envio de uma mensagem usa um snapshot mínimo para planejamento do provider, sem buscar o histórico inteiro. O pacote de continuidade continua derivado do SQLite e lê apenas as oito mensagens recentes e a memória estruturada aprovada. Imagens são consultadas em lote, não uma por mensagem, com índice em `(task_id, created_at, id)`. A abertura do projeto reaproveita dados já lidos no resumo de continuidade. Nada é copiado para um segundo banco ou cache persistente.
