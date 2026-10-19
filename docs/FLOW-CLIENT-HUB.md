# Flow Client e Flow Hub — superfícies externas sobre orquestração compartilhada

> **Decisão canônica de 19/10/2026:** a Central multiusuário NÃO possui um segundo sistema de chats. Ela **reutiliza o sistema existente no Flow/OrdaX Grátis**, consumido por contrato e isolado por usuário/tenant, e adiciona um **supervisor por API de modelo** que administra automaticamente conversas, tarefas e continuidade após receber solicitações externas. O **OrdaX interno** usa a mesma composição técnica — conector de chat + supervisor API — mas recebe metas internas em vez de pedidos externos; **Studio, Grátis/Flow desktop e outros apps** usam apenas o conector de chats, com **operação manual pelo usuário**, sem API supervisora obrigatória. Flow Client/Hub são entradas/interfaces e controle de RBAC, não executores de chat distintos. Uma API HTTP para receber solicitações não equivale à API do supervisor. **Não compartilhar sessão pessoal ChatGPT entre clientes**; só integrar sessões/provedores por meios permitidos e com testes E2E, oferecendo APIs oficiais quando necessário. Os detalhes legados abaixo referem-se a uma proposta anterior de backend de inferência central e devem ser interpretados conforme a [SSOT atual](FLOW-ARCHITECTURE.md). A implementação multiusuário completa permanece pendente.

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

**Novo contrato de histórico:** [FLOW-CENTRAL-HISTORY.md](FLOW-CENTRAL-HISTORY.md). Flow usa uma única fonte de verdade para chats individuais no PostgreSQL central, sem substituir o SSOT de projetos/Spaces/memória já existente. Ainda requer implantação/autorização real do banco.

**Autenticação unificada:** o Flow Client e o Hub reutilizam a Conta OrdaX, sem segundo cadastro nem senha; a sessão web e o registro SSO canônico estão descritos em [FLOW-SSO-BOUNDARY.md](FLOW-SSO-BOUNDARY.md). Login não concede automaticamente permissão de operador, e um navegador em outro computador deve ter sua própria sessão autorizada.

Decisão (18/10/2026): **duas aplicações visíveis**, com responsabilidades distintas, suportadas por **um serviço de API canônico**. Este repositório continua como SSOT do código específico Flow. Nenhum import, configuração ou dependência operacional em `ordax-os` ou `ordax-runtime`.

## 1. Flow Client — usuário final

Fonte: `apps/flow-client/`, acessível no preview de servidor em `/client`.

- Acessa com **conta OrdaX**, sem conta pessoal ChatGPT obrigatória.
- Lista apenas projetos autorizados do titular, envia solicitações à central e recebe respostas associadas a `taskId` e `requestId` verificados.
- Deverá evoluir para histórico completo, memória estruturada, artefatos, streaming, sincronização entre dispositivos e painel de cota. Não depende de OrdaX Studio.
- Nesta entrega a interface cliente é um **shell funcional de envio e retorno**, ainda sem histórico central persistido ou identidade real conectada. Mostra explicitamente essa limitação.

## 2. Flow Hub — central de operações

Fonte: `apps/flow-hub/`, acessível no preview em `/hub`.

- Operadores autorizados, acesso **RBAC** por capacidade `flow:hub:read` determinada pela identidade canônica, nunca por valores de `role` ou `userId` enviados pelo navegador.
- Painel inicial **somente leitura**: usuários/dispositivos ativos, projetos, requisições concluídas, falhas e fila. Os números vêm exclusivamente do adapter do backend; nunca são inventados.
- **Não** visualiza conteúdo de conversas, prompts, respostas, emails, tokens, arquivos ou memórias pessoais no painel geral.
- Expansão posterior: cotas, custos, rate limit, quotas tenant, incidentes, auditoria, faturamento e saúde dos provedores, cada ação sujeita a RBAC específico e autorização do servidor.
- O Hub não é uma instalação necessária para o usuário final. Em produção, preferir domínio, sessão e release próprios, com rotas administrativas e rede protegidas.

## 3. Serviço único — sem duplicação

- `src/relay/relay.mjs`: identidade, autorização de projetos, isolamento, recibos/idempotência, vínculo de respostas e projeções de leitura (não replica auth, quotas, IA ou DB).
- `src/relay/web-apps.mjs`: mapeamento explícito dos arquivos públicos dos dois aplicativos e CSP restritiva; para testes pode servi-los na mesma origem. Publicar em origens separadas é um trabalho posterior.
- `apps/shared/`: estilo e transporte HTTP reutilizados; nenhuma credencial persistida no browser ou em `localStorage`.
- **SSOT da conta/quotas/contratos de memória:** OrdaX Platform/Intelligence, por adapters oficiais ainda pendentes.
- **SSOT de conversas/projetos/estado central:** serviço central autorizado (pendente); legado SQLite do Electron não vira banco compartilhado.
- **Studio:** outro produto, usa conta ChatGPT do próprio usuário via MCP e Runtime autorizado; não herda a sessão/cota do Flow.
- **OS:** nenhum acoplamento, dependência de boot ou import. OrdaX Flow e Studio podem ser instalados e removidos sem OrdaX OS.

## Endpoints de contrato inicial

| Método | Rota | Autorização | Estado |
| --- | --- | --- | --- |
| GET | `/v1/projects` | Conta OrdaX, projetos do principal | Porta/adaptação, não conectada à base real |
| POST | `/v1/messages` | Conta OrdaX + ownership da Task + idempotência durável | Protótipo testado; adapters de IA/DB/quotas reais pendentes |
| GET | `/v1/hub/overview` | Capacidade `flow:hub:read` | Projeção limitada e testada; adapter de métricas reais pendente |
| GET | `/health` | Status mínimo sem dados pessoais | Implementado |

Os apps da web necessitam de uma sessão segura de conta OrdaX fornecida por `authenticateRequest`. O adapter de produção deve validar cookie HttpOnly, expiração, origem, CSRF para mutações e sessão; sem ele, rotas protegidas falham como não autenticadas. Acesso por Bearer segue possível para testes/cliente nativo com `authenticate` oficial. Não inserir conta ChatGPT ou API key de modelos no navegador.

## Identidade canônica da Platform — integração P0

O Flow agora possui o adaptador `src/relay/platform-account.mjs`, que consulta **somente** `GET /v3/product/session` da OrdaX Platform para verificar um token Bearer. É o endpoint de identidade do proprietário já existente em `ordax-platform/control-plane/cloudflare/src/product_auth.ts`; o Flow não valida JWT de modo paralelo e não usa tokens OAuth delegados de MCP para conceder ações ou funções administrativas. O adaptador requer origem HTTPS configurada, nega redirects, valida a resposta e expiração, limita o payload e **falha fechado** em erros de rede, JSON inválido e token recusado. HTTP loopback é permitido exclusivamente em testes explicitamente habilitados.

A composição única `src/relay/platform-composition.mjs` une autenticação, RBAC do Hub, projetos, dispatch, recibos idempotentes e arquivos Client/Hub. Todos os adaptadores de sessão web, autorização, projetos, métricas, roteador de modelos e persistência precisam ser fornecidos pela autoridade canônica; **não existem defaults fictícios de produção**. Uma identidade autenticada é apenas um usuário, nunca prova de propriedade de um projeto nem autorização de operador. A sessão de navegador real, com cookie HttpOnly, SameSite, Origin, CSRF e renovação, **continua pendente**: o HTML não cria credenciais ou sessões por conta própria.

### Provas P0

- `node --test test/platform-account.test.mjs test/platform-composition.test.mjs` cobre assinaturas aceitas ou recusadas pela Platform simulada, expiração, falhas de rede, contrato HTTPS, 20 contas/140 mensagens concorrentes, ausência de acesso ao Hub e bloqueio de montagem quando ports obrigatórios faltam.
- O endpoint proprietário da Platform foi inspecionado no código real; **não foi feita uma chamada credenciada a produção**, nem implantado um novo Worker. O simulador atesta apenas a composição e o isolamento. Para o Flow central, o roteador de IA precisa permanecer independente do runtime Intelligence pertencente ao OrdaX OS; somente identidade e contratos Platform neutros são reutilizados.

## Gates executados

- `node --test test/flow-apps.test.mjs test/relay.test.mjs`: 8 testes HTTP de separação, RBAC, projeção restrita, roteamento, acesso cruzado e idempotência. Todos aprovados em 18/10/2026.
- Lote anterior: 12 computadores/identidades, 2 Tasks cada, 8 mensagens cada = 192 mensagens intercaladas e encaminhadas corretamente usando provedor determinístico de teste.
- **Ainda não homologado em produção:** autenticação real, sincronização, isolamento com múltiplas réplicas, rate limiting, cobrança, roteador de modelos, UI end-to-end em navegador real e hosting. Não confundir testes com simulador com infraestrutura implantada.
- **CI GitHub:** workflow ainda não publicado: o push foi rejeitado por falta de escopo OAuth `workflow`. Não contornar essa proteção; ativar a CI somente com credencial ou integração oficialmente autorizada. Até lá, executar `npm run validate` localmente antes de cada push.

**Regra de arquitetura:** nenhum segundo broker, serviço de autenticação, mecanismo de cotas, tabela de memória ou MCP paralelo dentro dos frontends.
