# Flow — conversas e histórico central canônico

Decisão de arquitetura: 18/10/2026. Repositório SSOT: `ordaxsystems/ordax-flow`. **Estado: contrato e esquema propostos; NÃO aplicados à produção.**

## Fontes de verdade sem duplicação

- **Conta/identidade:** Supabase Auth e contratos da OrdaX Platform; sem contas, senhas ou tokens paralelos.
- **Spaces e projetos compartilháveis:** `public.ordax_spaces` / `public.ordax_projects` e autorizações oficiais, já existentes na plataforma. Um projeto da Platform sempre pertence a um Space, portanto **não** criar Spaces fictícios para cada conversa Flow.
- **Conversas individuais do Flow:** `flow_private.conversations` e `flow_private.messages`, no **mesmo PostgreSQL da Platform**, como SSOT exclusivo do domínio de chat. Cada conversa é privada por proprietário `auth.users.id`. Esta entrega não afirma integração automática a Space/projeto de equipe; compartilhamento e projetos vinculados exigirão gates próprios, sem duplicação de nomes ou permissões.
- **Memória estruturada:** continua na autoridade `public.ordax_memory_items` e contratos da Intelligence/Platform. Não foi criada tabela de memória Flow.
- **Studio:** produto independente via MCP/Runtime autorizado; não é backend do Flow. **OrdaX OS:** nenhuma dependência de instalação, boot, conteúdo ou release.

## Contratos adicionados

- `src/relay/conversation-store.mjs`: cria conversa privada com UUID gerado pelo servidor, lista conversas do proprietário, autoriza por `owner_user_id`, lê histórico de mensagens por cursor e registra solicitação + resposta juntas em uma instrução SQL atômica. Todos os SQLs usam parâmetros; a identidade **vem do principal autenticado**, nunca de parâmetros no navegador. Os resultados retornam no máximo 50 mensagens por página HTTP.
- `src/relay/relay.mjs`: `POST /v1/conversations`, `GET /v1/projects` (projeção de conversas autorizadas), `POST /v1/messages` e `GET /v1/history/:taskId?before=<seq>`. Os endpoints somente ficam disponíveis quando o port canônico correspondente foi configurado. Antes de responder sucesso, `POST /v1/messages` aguarda a persistência do par de mensagens dentro do recibo idempotente.
- `apps/flow-client/`: entrada para nova conversa é exibida apenas quando o servidor declara capacidades reais. Ao selecionar conversa, carrega histórico do backend; página anterior é acrescentada preservando posição de rolagem. `epoch` e taskId impedem que uma leitura atrasada substitua o histórico de outra conversa. O estado do histórico do navegador não é fonte de verdade.
- `src/relay/platform-composition.mjs`: quando é fornecida a conexão transacional canônica, utiliza **somente** ela para projetos/ownership/histórico. Não cria outro broker, SQLite remoto, cache de autenticação ou modelo próprio de permissões.

## Banco e isolamento

Arquivo `sql/flow-conversation-history.sql` é **migração proposta para revisão**, não aplicada. A tabela de conversas referencia `auth.users(id)`; mensagens referenciam a conversa. Ordenação por `seq` estável, unicidade `(task_id,request_id,role)`, restrição de tamanhos, índices de listagem/leitura, chaves estrangeiras e exclusão em cascata. O banco já possui tabelas `ordax_projects` e `ordax_memory_items`, que NÃO são recriadas.

A migração implementa RLS obrigatório em ambas as tabelas, sem acesso `PUBLIC`, `anon` ou `authenticated`. Um role `ordax_flow_gateway NOLOGIN` possui somente SELECT/INSERT, sem UPDATE/DELETE. O serviço central deve conectar-se por um principal de banco **especificamente autorizado** a assumir esse papel; não conceder a um cliente web. `createFlowOwnerScopedQuery` executa `SET LOCAL ROLE ordax_flow_gateway`, estabelece `flow.owner_user_id` **somente do usuário autenticado** e executa a consulta na mesma transação PostgreSQL, com rollback em falha. A Platform deve prover o adapter `withTransaction(fn)` usando uma conexão fixada; `pool.query` avulso não satisfaz esse contrato.

Em produção, um `conversationQuery` genérico é rejeitado; só `conversationTransaction` pode habilitar essas capacidades. Em fixtures loopback o teste usa um executor determinístico em memória, claramente separado de produção.

## Garantias testadas

- 12 usuários/criadores, 96 solicitações e 192 mensagens ordenadas; resposta e leitura sempre associadas à identidade e Task corretas, com acesso cruzado negado.
- 120 mensagens da mesma conversa paginadas em lotes de 50/50/20, ordem estável, sem mistura entre usuários.
- Replay do mesmo `requestId` não duplica a mensagem; texto conflitante falha.
- Falha de assumir role ou de escopo impede a consulta comercial.
- Os frontends **ainda não passaram por E2E em navegador com PostgreSQL real**. Os testes de backend usam um simulador de queries. Não anunciar sincronização real entre computadores antes de prova em servidor central implantado.

## Pendências (não concluídas)

1. Revisão e aplicação oficial da migração no PostgreSQL existente, com papel da central e teste de RLS real (usuários diferentes e tentativas diretas de SQL), sem permissão privilegiada indevida.
2. Implementar `withTransaction` com o driver da Platform e garantir que o receipt de idempotência/quotas e a persistência do resultado têm consistência transacional e recuperação de falhas.
3. Publicar domínio HTTPS do Flow, registrar cliente OAuth distinto do Studio, ligar emissão/revogação de sessão da OrdaX Platform.
4. Conectar roteador de IA/cotas e histórico real no navegador em duas máquinas diferentes; testar perda de conexão, resposta atrasada, duplicação e reabertura.
5. Adicionar criação, renomeação, arquivamento e vínculo a projeto de equipe **somente por APIs autorizadas da Platform**, sem fabricar Space ou duplicar memória.

Nenhuma configuração de produção, tabela, domínio ou cliente OAuth foi criado nesta entrega.
