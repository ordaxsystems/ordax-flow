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
8. **Nova conversa versus rascunho antigo:** criar uma Task nova/segmento novo deve preparar um novo chat do provedor e confirmar o composer vazio **antes** de inserir o pedido. Só essa transição explícita pode descartar o texto transitório no composer antigo; o rascunho da Task permanece persistido e separado no SQLite. Retomar um chat existente nunca apaga texto manual do provedor. Falha na limpeza interrompe a Run e não gera reenvio automático.
9. O worker ChatGPT Web é um laboratório de compatibilidade com a sessão pessoal do usuário, não infraestrutura do Flow Hub multiusuário. Testes unitários da transição não comprovam envio/resposta real; a validação do ChatGPT Web exige teste de navegador, autenticação oficial e confirmação da resposta.

## Gates

`npm run validate` valida módulos, integridade, contratos e persistência. Os testes específicos de projeção verificam equivalência com o estado completo, índice SQLite, mensagens de mesma data, vínculos de imagens e rotação depois de respostas concluídas. Os testes ao vivo do Electron/ChatGPT são um gate separado e não são substituídos pelos testes unitários.

## Confirmação de envio via ChatGPT Web — gate 18/10/2026

- Um único evento de envio por execução, pela interface pública do navegador (sem endpoints privados). **Nunca** encadear click/requestSubmit/mouse/Enter para a mesma mensagem após resultado incerto.
- A limpeza do editor **não prova envio**. Confirmação requer observação de mensagem do usuário correspondente ou novo permalink canônico de conversa; timeout com editor vazio é `send_confirmation_unknown`, não sucesso nem permissão para reenviar.
- Uma execução com aceite incerto permanece auditável e exige reconciliação humana antes de nova tentativa. Não transformar em `succeeded` e não ressuscitar automaticamente a mesma mensagem.
- O ChatGPT Web é somente laboratório. O envio em produção do Hub deve usar provedor autorizado por API com receipts/idempotência do servidor.

## Diagnóstico e latência do worker ChatGPT Web — 18/10/2026

- **Diferenciar geração da IA de falha de envio**: o tempo de primeira resposta depende do provedor. Tempos de preparação, editor, reconhecimento do envio, primeiro delta e conclusão devem ser observados em fases separadas. Não afirmar que o app é mais rápido só porque os testes unitários passaram.
- O aplicativo desktop deve publicar fases concretas (`health`, `prepare`, `baseline`, `submit`, `await-response`, `assets`) no painel da Task atual. A interface só atualiza o cartão da Run e nunca substitui uma resposta já em streaming por uma etapa antiga.
- A telemetria durável também precisa abranger **Runs que falharam**, incluindo `failed_stage` e tempos parciais, sem guardar cookies, tokens, payloads de rede nem credenciais. Erros persistidos não tornam um envio incerto elegível a reenvio automático.
- Um provedor já aberto exatamente em `https://chatgpt.com/`, com composer íntegro e vazio, pode atender a uma solicitação explícita de nova conversa sem reload. Um permalink de chat, URL parametrizada, rascunho não vazio ou composer incompleto **nunca** habilita esse atalho.
- O laboratório Jarvis e o OrdaX Grátis podem ter estados diferentes por sessão e viewport. O sucesso de um não prova o E2E do outro. Gate obrigatório: mensagem do usuário observada, resposta do provedor confirmada, sem duplicação, com streaming e latências por fase.
- Testes: suite de contrato de novo chat, persistência SQLite para failed-run, proteção de envio exatamente uma vez, E2E de navegação/status do renderer e smoke real (somente com sessão autorizada). Nenhuma API interna não documentada do ChatGPT é pré-requisito.

### Envio compatível com Electron oculto — gate de regressão

A validação real do Grátis confirmou que um `WebContentsView` pode receber `Input.insertText` mas ignorar eventos simulados de ponteiro. O envio canônico usa **um único** `HTMLFormElement.requestSubmit(button)` no formulário oficial da página, depois de verificar editor e botão `type=submit` habilitado. Esse mecanismo é parte da API HTML padrão; não chama endpoint privado, não modifica o conteúdo da mensagem e não faz retries implícitos. Sucesso só existe após recibo observável (permalink canônico de chat ou mensagem correspondente) e resposta de IA verificada. O Jarvis e o Grátis reutilizam esse mesmo worker.

Os testes de aceitação incluem: contrato de envio único, proteção de rascunho, estados visuais de preparação, streaming progressivo real e contagem SQLite de uma mensagem de usuário e uma de assistente por Task de teste. Evitar contabilizar textos de status como streaming. Números de latência de uma ou duas mensagens não equivalem a benchmark estatístico; usar `npm run benchmark:live` em sessões autorizadas para p50/p95 quando for necessário comparar desempenho.

### Benchmark histórico seguro — outubro/2026

- `npm run benchmark` **não envia prompts**: lê até 100 execuções recentes do SQLite em modo somente leitura; `ORDAX_BENCH_HISTORY_LIMIT` permite de 1 a 1000 registros.
- Resultados concluídos e falhas são apurados separadamente por observador, com distribuição por etapa (`prepare_ms`, `submit_confirm_ms`, `total_ms`) e códigos de erro reduzidos, sem expor conteúdo de mensagens, tokens ou conversas. Ausência de métrica jamais equivale a zero.
- Percentis p95 com menos de cinco amostras e p99 com menos de vinte **não são apresentados** como números representativos; `npm run benchmark:live` continua sendo o teste ativo específico, sempre com sessão autorizada.
- O relatório histórico não promete melhoria de performance por si só: exige comparação entre execuções com mesmos critérios de tamanho de resposta, modelo e modo observador antes de qualquer conclusão.
