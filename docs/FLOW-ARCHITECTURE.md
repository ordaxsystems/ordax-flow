# OrdaX Flow — arquitetura canônica e limites de produto

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
