# OrdaX Flow — arquitetura canônica e limites de produto


## Direção atual de integração com IA — 2026-10-19 (prioridade)

**Objetivo definido pelo proprietário:** o mecanismo existente de conexão direta com uma sessão pessoal de chat (demonstrado no Electron OrdaX Grátis 0.4.12) deve ser a base a **reutilizar, por contrato**, no aplicativo principal, no Studio, no Flow desktop e em outros aplicativos compatíveis. **Eles não dependem de uma API paga de modelo para a funcionalidade básica.** Não copiar o worker/DOM/WebContents do Electron para cada app, não criar um servidor concorrente e não declarar suporte a provedores que ainda não passaram por integração e testes.

**Uma única integração a API de modelo é considerada para esta fase:** a inteligência supervisora/planejadora do aplicativo principal (nome provisório OrdaX Pilot), por exemplo Groq para distribuição de tarefas. Esse modelo planeja; não substitui o ChatGPT Web do usuário, não concede ações MCP, não habilita automaticamente execução do Runtime e não torna todos os aplicativos dependentes da sua chave. A configuração e o custeio são explícitos; sem chave, a experiência de chat existente deve continuar funcionando.

| Superfície | Canal atual/pretendido | API de modelo obrigatória? |
| --- | --- | --- |
| OrdaX Grátis / futuro Pilot desktop | Sessão de chat pessoal via integração desktop existente; Supervisor API somente quando ativado | Não para chat básico |
| OrdaX Studio desktop | Conector de chat pessoal por contrato de host com sessão própria e escopo autorizado | Não |
| OrdaX Flow desktop | Integração de chat pessoal reutilizada da base existente | Não |
| Outros apps desktop compatíveis | Adaptador/contrato compartilhado de chat; sem herdar credenciais de outro app | Não |
| Flow Client + Hub multiusuário (projeto anterior) | **Arquitetura futura distinta:** backend central de APIs de modelos autorizadas, usuários e cotas individuais | Sim **somente se esse produto central for efetivamente lançado**; não é requisito dos apps desktop agora |

**Não confundir os dois projetos:** o Flow desktop local 0.4.12 já funciona como laboratório com sessão pessoal, enquanto os diretórios apps/flow-client e apps/flow-hub implementam contratos iniciais para outra proposta multiusuário. A decisão de 18/10/2026, preservada abaixo, descreve **essa proposta central futura**, não uma obrigação de instalar o Hub, fornecer chave de modelo ou usar API de inferência para abrir o Grátis, Studio ou Flow desktop. Nenhuma instância compartilhada de ChatGPT Web deve ser usada para prestar serviço multiusuário.

**Boundary do sistema compartilhado:** o conector do chat é específico do host/provedor, não SSOT de modelo, autorização ou execução. Sessões, cookies e credenciais não são compartilhados entre usuários/aplicativos sem consentimento. Na fase atual o worker real somente conhece ChatGPT Web; Grok, Claude e outros chats exigem adaptações próprias, comprovação de compatibilidade e uso permitido. O laboratório Web atual não equivale a API oficial, confiabilidade contratual ou suporte de produção. O OrdaX MCP permanece genérico; OrdaX Platform fornece grants/identidade e o Runtime executa ações autorizadas com auditoria. O agente não recebe privilégios porque um chat foi conectado.

**Política de evolução:** consolidar primeiro as capacidades verificadas do desktop, especificar um único contrato cliente para a interação com chats e implementar adapters de host sem duplicação. API de modelos no planejador é capacidade isolada e opt-in. O futuro Flow Central multiusuário fica fora desse corte até uma decisão explícita de ativação, com testes próprios de identidade, cotas e custos.


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
