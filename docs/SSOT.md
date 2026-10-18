# SSOT e limites de leitura — OrdaX Grátis (legado desktop)

A arquitetura central futura e a separação de produtos são canônicas em [FLOW-ARCHITECTURE.md](FLOW-ARCHITECTURE.md). Esta página documenta apenas o armazenamento local legado Electron; não representa a base central multiusuário.

## Autoridade dos dados

O banco `%LOCALAPPDATA%\OrdaX\Gratis\data\ordax-gratis.sqlite` é a fonte única de verdade da Task local. O ChatGPT Web é um provedor de execução e cada URL é um segmento técnico; nunca vira a identidade do projeto.

| Estado | Fonte canônica | Projeção / uso |
| --- | --- | --- |
| Projeto, nome, estado, rascunho | `tasks` | Coluna esquerda, composer e título |
| Histórico enviado e recebido | `messages` | Chat central; ordem `created_at,id` |
| Imagens: metadados e vínculo | `message_assets` | Arquivos em `data/assets`; URLs locais são derivadas |
| Checkpoints versionados | `checkpoints` | `tasks.checkpoint` é campo legado espelhado, não prioridade de leitura |
| Conhecimento aprovado | `project_memory_items` ativos | Pacote de continuidade |
| Sugestões ainda não aprovadas | `project_memory_candidates` | Somente revisão; **nunca** injetar como fato |
| Segmentos técnicos | `task_conversations` | Um projeto pode possuir vários segmentos |
| Respostas concluídas por segmento | `conversation_completed_runs` | Contagem idempotente; não armazenar contador paralelo |
| Execuções, auditoria e decisões | `runs`, `events`, `action_ledger`, `approval_ledger` | Rastreamento e recovery |

## Projeções, não novos bancos

- `Store.listTasks()` fornece somente metadados para a navegação lateral; nunca transporta rascunhos, checkpoints ou URLs internas de todas as Tasks.
- `Store.getTask(id, { messageLimit })` fornece uma janela paginada à interface (50 mensagens por página), sem duplicar o histórico. O modo sem limite permanece apenas para consumidores internos legados e testes; a Surface não o utiliza.
- `Store.messagesPage()` usa cursor imutável sobre `(created_at,id)`, índice SQLite existente, leitura ordenada e metadados de total. Não usa OFFSET, cache de páginas nem segunda tabela.
- `Store.getTask()` monta o resumo usando as mesmas leituras daquela Task; só o SQLite persiste.
- `Store.getTaskExecutionSnapshot()` entrega o mínimo para planejar um envio: vínculo ativo, existência de mensagens, versão do checkpoint e respostas concluídas. Não lê histórico completo.
- `Store.buildContinuationPrompt()` consulta os itens aprovados e **somente as oito mensagens recentes**. A ordenação, os vínculos de imagens e o orçamento de contexto usam o construtor puro `buildProjectContinuation()`, sem cache paralelo.
- `Store.messages(taskId)` mantém a ordem canônica do histórico. Seu modo limitado compartilha a mesma consulta-base e carrega as imagens em lote. Uma Task com milhares de mensagens não gera uma consulta por imagem/mensagem no SQLite.
- `Store.continuationSummary()` conta mensagens com SQL sem reidratar o histórico e pode reutilizar o snapshot de `getTask()`.

## Invariantes obrigatórios

1. Rascunho não é mensagem enviada. Seu controle de revisão monotônica impede gravação atrasada de sobrescrever o estado mais recente; o cache do renderer é temporário, não uma segunda persistência.
2. A mensagem do usuário é persistida antes da tentativa de envio, mesmo se o provedor falhar; a resposta do assistente só é gravada após observação. Falhas de comunicação não reenviam automaticamente a mesma pergunta.
3. Só conhecimento explicitamente aprovado entra na memória canônica; um candidato pendente não tem esse privilégio.
4. A troca preventiva de segmento não cria uma Task nem altera o chat visível. Respostas concluídas são contabilizadas uma única vez por Run.
5. O contexto é limitado e indica omissões; a Task **inteira** continua no SQLite. Não confundir pacote limitado com perda de memória.
6. Qualquer nova camada de UI/API deve consultar uma projeção de `Store`; não duplicar estado em JSON, localStorage, outro arquivo SQLite ou memória do ChatGPT. O renderer exibe somente a página selecionada; avançar/voltar no histórico solicita uma nova projeção, sem acumular milhares de elementos DOM.
7. Migrar campos legados requer teste de leitura de dados antigos e reversão segura; não apagar checkpoints antigos nem imagens durante atualização.

## Gates

`npm run validate` valida módulos, integridade, contratos e persistência. Os testes específicos de projeção verificam equivalência com o estado completo, índice SQLite, mensagens de mesma data, vínculos de imagens e rotação depois de respostas concluídas. Os testes ao vivo do Electron/ChatGPT são um gate separado e não são substituídos pelos testes unitários.
