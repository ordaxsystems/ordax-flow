# OrdaX Flow — arquitetura canônica e limites de produto

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
