# OrdaX Flow — arquitetura canônica e limites de produto


## SSOT atual — um motor, dois ambientes de orquestração (19/10/2026)

**Correção de escopo do proprietário (prioridade sobre as decisões datadas abaixo):** não existem dois motores de agentes ou duas soluções de IA independentes. A proposta é **um único núcleo de tarefas/agentes/continuidade**, reutilizado por dois **ambientes de operação com autoridade e dados isolados**. O nome comercial "OrdaX Pilot" e o nome de trabalho "OrdaX Evolution" são provisórios; nenhum implica criar repositório, segundo banco ou segundo executor.

### Ambiente interno — evolução do OrdaX

- **Finalidade:** um ambiente de trabalho próprio, permanente e restrito ao proprietário, dedicado a investigar, construir, testar, revisar e evoluir OrdaX OS, Studio, Flow, MCP, Runtime, Apps e demais projetos autorizados.
- **Origem das tarefas:** objetivos internos, backlog, decisões, dependências, resultados de testes e checkpoints do próprio ambiente, não requisições externas de clientes. O supervisor planeja, prioriza, distribui trabalho a agentes por projeto/área, reconcilia efeitos e sugere ou inicia próximas ações elegíveis dentro de políticas predefinidas.
- **Integração de IA:** o sistema atual de interação com chats pessoais, hoje implementado no Electron Grátis, é a base a adaptar e reutilizar por contrato. **A integração inicial prevista com API de modelo (ex.: Groq) pertence ao supervisor/orquestrador interno** e não substitui todos os provedores de chat nem obriga Studio/Flow desktop a ter uma chave de API de modelo.
- **Execução:** ChatGPT/outros chats compatíveis e ferramentas autorizadas via GitHub, OrdaX MCP e Runtime. A inteligência que planeja **não ganha grants** por gerar instruções. Falhas, limite de contexto, envio incerto, cancelamento ou desconexão mantêm Task/checkpoint/evidência até reconciliação, sem repetição cega.
- **Autonomia:** tarefas podem continuar automaticamente **somente enquanto existe executor conectado e autorizado**, com limites explícitos de custo, ferramentas, concorrência, políticas, escopo, revisão de PR e segurança. Não prometer trabalho em background sem runtime/serviço disponível.

### Ambiente externo — orquestração multiusuário

- **Finalidade:** aceitar demandas externas de usuários, empresas, outros aplicativos e integrações e executá-las pelo **mesmo motor lógico de tarefas/agentes/continuidade**, mas sob políticas de produto e autorização específicas.
- **Origem das tarefas:** requisições autenticadas, APIs de entrada, UI cliente ou eventos externos; isso **não** significa necessariamente consumir uma API paga de modelo. **API de entrada de solicitações != API de inferência de IA**. O plano de provedores de IA deve ser escolhido pelo produto/usuário quando implementado e autorizado.
- **Isolamento:** identidade, tenant, workspace, permissões, orçamento/cota, credenciais, dados, filas e resultados são vinculados ao sujeito verificado, sem acesso aos repositórios ou ao contexto privilegiado do ambiente interno. Jamais compartilhar a sessão pessoal ChatGPT do proprietário para executar tarefas de clientes.
- **Integração de chats:** adaptar o mesmo contrato para provedores/sessões legitimamente autorizados por cliente, **se** as capacidades e termos de uso permitirem; onde isso não for viável, oferecer integração oficial por API de modelo, com custos e credenciais adequados. O laboratório ChatGPT Web existente **não** comprova um backend SaaS multiusuário.
- **Flow Client/Hub:** as telas e o relay existentes são *superfícies de entrada/operação* que devem convergir ao motor compartilhado, e não constituir um segundo supervisor ou banco concorrente. A documentação de 18/10/2026 representa a primeira proposta de transporte multiusuário, não a obrigação de manter arquitetura de inferência separada.

### Núcleo compartilhado e fronteiras canônicas

| Responsabilidade | Único owner ou contrato |
| --- | --- |
| Task, Run, agente, fila, checkpoint, continuidade, reconciliação, evidência e auditoria de trabalho | **Um motor de orquestração** a consolidar a partir das implementações existentes no repositório Flow/Grátis, aproveitando invariantes realmente ausentes do GPT; nunca dois Task writers para o mesmo escopo |
| Entrada e configuração do ambiente interno | Aplicativo desktop completo derivado do Grátis; configurações restritas ao owner |
| Entrada externa, autenticação, RBAC, cota e roteamento de solicitante | Flow Client/Hub e contratos/autoridade da Platform, sem duplicar conta ou grants |
| Chat por conta, sessão, transporte e integração de provedor | Contrato compartilhável com adapters por host e provedor, isolamento por usuário/aplicativo; o executor Electron/DOM é um laboratório existente, não backend universal |
| Modelo do supervisor (quando habilitado) | Adapter de API de modelo do orquestrador; separado da API HTTP de solicitações |
| Permissões, dispositivo, execução real e resultados de ferramentas | Platform/OrdaX MCP + Runtime; o orquestrador consome grants/recibos, não executa por autoridade de prompt |
| OrdaX Intelligence/OS | Inteligência e memória sistêmicas do OS; os apps não copiam esse owner nem fazem o OS depender de Flow |

**Sem conflitos de nomes:** agente interno é um papel operacional, **não um Space** de perfil do OrdaX OS. Projeto, Task, Run, segmento de chat, Space de perfil, dispositivo alvo e sessão de provedor são identidades distintas. O aplicativo principal poderá expor agentes "OS", "Studio", "MCP" etc. como configurações, não produtos ou serviços separados.

**Política de implantação e SSOT:** primeiro fechar o núcleo e o ambiente interno sem regressão do Grátis; depois habilitar entrada externa isolada sobre o mesmo contrato. Reutilizar contratos entre repositórios via versões/adapters, sem exigir que Studio/Flow desktop importem o executável principal ou um banco SQLite específico. Uma futura versão multiusuário pode usar armazenamento central autorizado sem duplicar a autoridade de identidade/memória da Platform. Antes de anunciar qualquer provedor de chat como suportado, validar legalidade de uso, autenticação, recuperação, revogação, envio, streaming e testes reais.

**Efeito desta decisão:** o modelo central multiusuário com apenas API oficial de inferência, descrito nas seções históricas abaixo, torna-se **uma possível configuração de provedores**, não outro motor nem pré-requisito imposto aos aplicativos. O ponto único de verdade para decisões posteriores é esta seção.

## Decisão canônica — fluxo de conversas e MCP (18/10/2026)

**Modelo mental obrigatório em conversas futuras:** o Flow Client é o chat do usuário; o Flow Hub é a central que **recebe** a solicitação, **encaminha** ao provedor de IA autorizado, **recebe** a resposta e **a distribui ao cliente certo**. A central mantém roteamento, identidade, cotas, histórico, memória e continuidade. Não exigir Studio, MCP, Runtime ou OrdaX OS para um chat normal.

```text
Flow Client A/B/C -> Flow API / Hub -> Model Router -> GPT (API oficial) / outro provedor
Flow Client A/B/C <- Flow API / Hub <- Model Router <- resposta
```

- **Flow Client:** aplicativo de conversa e projetos; utiliza API HTTPS do Flow (com streaming quando suportado). **Não é cliente MCP** e não conversa diretamente com o GPT.
- **Flow Hub:** designa central de operação e orquestração; o painel `apps/flow-hub/` é sua UI administrativa com RBAC. O Hub **não** é um robô que compartilha uma única conta ChatGPT entre todos os clientes. O serviço `src/relay/` implementa a entrada API comum; o painel não é um intermediário obrigatório no caminho das mensagens.
- **GPT:** no produto central multiusuário é um provedor por **API oficialmente autorizada**, chamado pelo Model Router no backend. A assinatura ChatGPT Web não substitui credenciais/cotas de API. O Electron 0.4.12 com ChatGPT Web oculto é **laboratório legado**, não a infraestrutura de produção para múltiplos usuários; não automatizar sessão compartilhada ou contornar limites do serviço.
- **MCP:** **não é necessário ao Flow básico**. Futuramente, se uma tarefa pedir ferramentas externas, o Hub poderá atuar como **cliente MCP** com credenciais delegadas e grants explícitos, sem incorporar MCP ao Flow Client e sem criar um segundo servidor MCP sem necessidade.
- **OrdaX Studio:** produto independente de desenvolvimento. O usuário pode usar o ChatGPT pessoal através do **OrdaX MCP** para acessar o Runtime e projetos autorizados; isso não transfere a sessão ChatGPT ao Flow, nem o Studio vira o Flow Hub.
- **OrdaX MCP:** servidor MCP canônico de integração externa, mantido em `ordaxsystems/ordax-platform` (endpoint `https://mcp.ordax.com.br/mcp`). **OrdaX Runtime** em `ordaxsystems/ordax-runtime` executa ações autorizadas em computadores; nenhum deles é requisito para chats normais do Flow.
- **OrdaX Platform:** conta única e autorização; **Flow** é o proprietário das conversas e da lógica específica de projetos Flow. Não duplicar identidade, memória, banco, quotas ou executores. Flow e Studio não dependem do OrdaX OS.

**Fronteira de estado:** o contrato de roteamento, API e testes com provider simulado não comprova conexão de produção com GPT, autenticação web real, banco central implantado ou execução de MCP. Documentar cada gate como testado, pendente ou implantado; nunca confundir desenho aprovado com entrega concluída.

**Aceite final esperado:** Cliente autenticado A envia `requestId`/Task autorizada -> Hub valida identidade, projeto, cota e idempotência -> modelo autorizado responde -> Hub salva e entrega somente ao A; B não acessa nada de A. Continuidade entre conversas preserva projeto e memória canônicos. Opcionais MCP/tool calls seguem autorizações próprias.

**Divisão operacional aprovada:** [Flow Client + Flow Hub](FLOW-CLIENT-HUB.md), dois aplicativos visíveis sobre um único gateway e contratos canônicos. O Hub é um painel administrativo, não uma segunda IA, um segundo banco ou uma sessão ChatGPT compartilhada.

Decisão de produto: 17/10/2026. Repositório oficial: `ordaxsystems/ordax-flow` (privado). O histórico local de desenvolvimento migra para este repositório; novos commits devem ser enviados ao remoto, sem clones divergentes como fonte de verdade.

## Produtos independentes

- **Flow:** chat/memória/projetos para vários usuários e computadores. Conta OrdaX. A central provê a IA via API oficialmente autorizada, com credenciais no servidor, limites financeiros e cotas por usuário/tenant. **Não** utiliza conta compartilhada do ChatGPT Web. Usuário não precisa possuir uma conta pessoal ChatGPT.
- **Studio:** aplicativo/Runtime individual, usa a conta ChatGPT do próprio usuário via MCP suportado. Capacidade de arquivos, Git e processos somente por permissões explícitas. A memória do projeto é obtida por contratos canônicos da Intelligence/Platform, não por automação sobre a interface do ChatGPT.
- **OrdaX OS:** nenhum dos produtos acima depende do sistema operacional OrdaX para compilar, iniciar, autenticar, atualizar ou desinstalar. Nenhum módulo importado de `ordax-os`; o OS não importa Flow/Studio. Marcas e releases separados.

**SSOT de identidade/quotas:** OrdaX Platform; **SSOT de Runtime:** `ordax-runtime`; **SSOT de projeto, chat e lógica exclusiva de Flow:** este repositório. Integrações por contratos versionados e autorização, nunca cópia de tabelas, identidade, código ou armazenamento de outros produtos.

## Fluxo canônico de mensagens

1. Cliente envia token OrdaX, `taskId`, `requestId` único e texto. A identidade **não** vem do payload; o servidor valida o token por adapter da identidade canônica.
2. Autoriza o projeto para o principal autenticado; falha fechada (sem revelar se pertence a outra pessoa).
3. Reserva de cota na central, trilha de auditoria e idempotência **durável** por (usuário, projeto, requestId). O mesmo ID e texto não devem executar duas vezes; trocar texto com ID antigo falha.
4. Somente após autorização, o modelo roteia para uma API autorizada. A resposta retorna apenas ao remetente e projeto verificados pelo servidor. Nunca usar `userId`, `taskId` ou `requestId` ecoados pelo provedor para decidir o destino.
5. O armazenamento central do projeto preserva histórico, memórias e checkpoints do usuário, com políticas de retenção e acesso. Não confundir cache local do aplicativo com SSOT central.

## Implementado vs. pendente

- **Implementado:** protótipo `src/relay/relay.mjs` com autenticação, autorização, idempotência por contrato, resposta vinculada à identidade verificada, limites de payload e isolamento. Testes HTTP com 12 usuários/computadores, duas Tasks por usuário, oito mensagens por Task (192 simultâneas), respostas fora de ordem, spoofing, acesso negado e retransmissão idempotente.
- **Pendente para produção:** adapters reais de identidade, quotas, banco durável distribuído, roteador/modelo autorizado, autenticação de dispositivos, implantação central e clientes Flow consumindo o endpoint. Os testes usam provider determinístico simulado; NÃO provam o uso real de IA central multiusuário.
- **Legado 0.4.12:** Electron desktop com ChatGPT Web oculto, histórico SQLite e observadores Fast/Beta; este modo é laboratório de compatibilidade e NÃO é a arquitetura final de Flow central multiusuário. Não aumentar seu alcance para contas compartilhadas nem ocultar automação para evitar detecção.

## Aceite e privacidade

- `npm run validate`: testes de lógica, isolamento e contratos.
- `npm run test:live:typing`: teste de teclado/draft somente na UI OrdaX, sem enviar mensagens ao ChatGPT; não tenta simular pessoa para contornar controles externos.
- E2Es reais do aplicativo legado são documentados em `docs/E2E-2026-10-17.md`; requerem sessão autorizada.
- Qualquer teste com múltiplos usuários exige marcadores identificáveis, resultados vinculados a identidade e ausência de vazamento entre projetos. As fixtures devem ser removidas.


## Consolidação do desktop e do motor de agentes — decisão 2026-10-19

**Status: decisão de ownership; migração e provas de paridade ainda pendentes.** Esta seção pertence ao mesmo documento canônico de arquitetura do Flow. Não criar outro SSOT, banco, sistema de agentes ou repositório para repetir esta responsabilidade.

### Identidades de produto e implementação

| Nome | Papel e owner | Regra de compatibilidade |
| --- | --- | --- |
| OrdaX Grátis | Nome e identidade de instalação do laboratório desktop 0.4.12 existente em `desktop/`, **neste repositório** | Preservar `br.com.ordax.gratis`, userData e SQLite até migração explícita e reversível; não declarar renomeação do binário já instalada |
| OrdaX Pilot (nome de produto proposto) | Experiência desktop completa de projetos, chat e orquestração, a evoluir a partir do desktop atual, **neste repositório** | O nome não constitui app, banco, serviço, release ou novo repositório. A marca pública só muda com migração de dados, installer, shortcuts, testes e rollback |
| OrdaX Flow Client | Proposta de cliente multiusuário em `apps/flow-client/`, **não requisito do Flow desktop atual** | Consome API/contratos autorizados do projeto central futuro, se ativado; não importa o worker Electron nem exige Studio/OS |
| OrdaX Flow Hub | Operação/RBAC em `apps/flow-hub/` | UI administrativa, não outro executor, IA, model router ou banco |
| OrdaX GPT | **Candidato à retirada como produto standalone**; código histórico em `ordaxsystems/ordax-gpt` | Não adicionar dependência de runtime nem abrir novo motor concorrente; preservar fontes até avaliação e transferência dos invariantes exclusivos |
| OrdaX Studio | Experiência de desenvolvimento em `ordaxsystems/ordax-apps`, host Windows no Runtime | Cliente de capacidades públicas; não absorver dono de tarefas Flow, identidade ou executor |
| Intelligence/OS, Platform, Runtime | Ownership sistêmico já publicado nos respectivos repositórios | Flow não recria identidade, grants, MCP, execução do dispositivo ou o router sistêmico do OS; integração entre produtos por contrato versionado |

**Prova de origem:** em 2026-10-19, `package.json`, `desktop/main.mjs`, `desktop/embedded-worker.mjs`, `src/store.mjs`, `src/continuation-context.mjs`, `docs/SSOT.md` e `README.md` do diretório Windows `OrdaX Gratis` foram comparados byte a byte em texto com a `main` deste repositório: sete de sete idênticos. Isso demonstra mesma implementação para essas amostras, não paridade de todos os artefatos distribuídos ou dados SQLite existentes.

### Decisão: não promover OrdaX GPT a segundo aplicativo principal

O desktop legado já dispõe de Task, Run, SQLite, mensagens, checkpoints, histórico paginado, memória aprovada e segmentos de conversas do usuário. `ordax-gpt` tem um MVP mais limitado de desktop e apenas cliente Runtime/MCP **read-only**, sem submissão de ações. Ele não substitui o desktop funcional. Porém suas implementações de event-store com versão/lease/integridade, Supervisor/worker leases, effect ledger com idempotência e reconciliação, contexto neutro a provedor, APIs de modelo e provas de recuperação são **candidatos exclusivos a avaliar**, não licença para exclusão imediata.

Matriz de tratamento dos pacotes de `ordax-gpt`:
- `task-engine`, `sqlite-event-store` e `context-engine`: comparar invariantes com `src/store.mjs` e `src/continuation-context.mjs`; adotar somente lacunas reais mediante migração de schema/teste, sem segundo Task writer.
- `supervisor` e `sqlite-supervisor-store`: avaliar leases, worker evidence, ledger de efeitos incertos, cancelamento, aprovações e testes de crash; integrar no mesmo owner de tarefas antes de habilitar multiagentes, sem criar segunda fila autoritativa.
- `model-gateway`: avaliar streaming/provider adapters; não substituir indevidamente o router canônico do OS nem o modelo de API autorizada do Flow Hub.
- `runtime-client`: consumir exclusivamente MCP/Platform/Runtime autorizados, sem segundo executor e sem confundir client read-only com execução E2E.
- `contracts` e `apps/windows-mvp`: comparar contratos; manter exemplos/provas históricos apenas enquanto necessários; não criar segundo produto instalável.

### Critérios de retirada / remoção

1. Inventariar consumidores, instalações, branches, dados, migrações e referências (incluindo OS, Apps, Platform, Runtime e CI), além dos pacotes acima; código encontrado apenas em documentação não é prova de ausência de consumidores.
2. Registrar para cada recurso de GPT decisão `ADOPT`, `ALREADY_COVERED`, `REFERENCE_ONLY` ou `REJECT`, com origem, commit, destino, owner e teste. Não transplantar dois bancos ou dois executores.
3. Para `ADOPT`, demonstrar testes de paridade com falha/crash, reentrada, efeitos incertos, conflito de escritores, cancelamento, idempotência e dados legados. Um plano ou um teste simulado não é substituto de integração.
4. Garantir exportação/migração de qualquer Task e artefato de GPT que existam em instalação real, com backup, prova de leitura, reversão e preservação de proveniência.
5. Verificar integrações/dependências remanescentes e gates de segurança, releases e CI; somente então arquivar/despublicar o aplicativo anterior. Exclusão definitiva do repositório, dados, credenciais ou releases é **operação separada** que exige inventário conclusivo e confirmação específica.

### Fronteira de autorização e modelos

A amplitude funcional do aplicativo é configurável, mas não revoga autorizações do sistema. O laboratório ChatGPT Web permanece experimental, usa sessão pessoal e não se torna backend de produção multiusuário. Se o Flow Hub **multiusuário futuro** for ativado, deverá usar APIs oficiais, autenticação própria do produto, cotas por identidade e idempotência. Essa exigência do produto central não se aplica ao Flow desktop, Pilot ou Studio usando suas sessões pessoais; um plano ChatGPT Web não substitui chaves/API em serviços multiusuário. Ferramentas reais são executadas pelo OrdaX Runtime/MCP com grants, alvo e recibos válidos, jamais por texto gerado pelo modelo.

**Ponto único de decisão de produto:** este arquivo. Em `ordax-gpt`, a documentação deve apontar para esta seção e identificar seu roteiro próprio como histórico/em transição, sem manter outra decisão conflitante.
