# Benchmark — OrdaX Gratis

Medições executadas em 2026-10-17 no PC autorizado, usando E2E que opera exclusivamente a interface `desktop/ui.html` do OrdaX. O ChatGPT Web permanece oculto durante os gates normais.

## Princípios do gate

O benchmark mede o caminho que o usuário realmente utiliza:

`UI OrdaX → Task → worker ChatGPT → observer → UI OrdaX`

Uma feature não é considerada aprovada apenas porque funcionou diretamente em `chatgpt.com`.

Os dois observers acompanham a mesma geração:

- **Fast experimental:** observa a rede do próprio Chromium/Electron.
- **Beta estável:** observa a resposta renderizada no DOM.

Não há segundo envio quando um observer perde a corrida. O primeiro conteúdo válido vence e o outro permanece como safety net.

## Baseline 0.4.2

### Texto — Fast

Prompt: `Responda exatamente: ORDAX_UI_FAST_OK`

- TTFV pela UI: **6.132 ms**
- total pela UI: **8.566 ms**
- preparação interna: **1.638 ms**
- confirmação de submit: **427 ms**
- primeiro byte de rede: **3.581 ms** após tentativa de submit
- primeiro delta Fast: **4.181 ms**
- primeiro delta Beta: **5.154 ms**
- vantagem Fast: **973 ms**

### Texto — Beta

Prompt: `Responda exatamente: ORDAX_UI_BETA_OK`

- TTFV pela UI: **7.695 ms**
- total pela UI: **10.012 ms**
- resposta entregue exclusivamente pelo observer Beta

### Imagem

Prompt: `Gere uma imagem simples de um cubo azul sobre fundo branco. Não pesquise imagens; crie uma imagem.`

- progresso visível dentro do OrdaX
- asset final persistido localmente e renderizado por `ordax-asset://`
- dimensão validada: **1254 × 1254**
- primeira imagem local visível: **44.425 ms** desde o submit da UI
- total do gate: **44.536 ms**
- após restart, a mesma imagem voltou a renderizar a partir do estado local

## Candidate 0.4.3

O lote 0.4.3 adiciona métricas por estágio, isolamento de E2E, compatibilidade com o DOM atual do ChatGPT e vínculo de cada Run ao ID real da mensagem assistant.

### Confiabilidade adicionada

- `Store.close()` idempotente e fechamento no `will-quit`.
- E2E com lock exclusivo em `%LOCALAPPDATA%\OrdaX\Gratis\e2e.lock`.
- provider readiness baseado em `window.ordax.providerStatus()`, sem depender de texto localizado da UI.
- suporte ao DOM atual por `data-chatgpt-selection-message-id` e `data-user-message-bubble`.
- cada Run guarda `currentAssistantMessageId`; IDs de respostas anteriores são rejeitados.
- gate explícito `crossRunLeak` impede uma resposta da Task anterior de aparecer na nova execução.
- respostas Fast curtas deixaram de ser descartadas por tamanho mínimo artificial.
- `ttfs_ms` passou a medir tentativa de submit → primeiro delta, evitando zero falso quando a confirmação do submit chega depois do stream.
- Fast e Beta permanecem observers substituíveis; Task, mensagens e assets continuam sendo o SSOT local.

## Benchmark estatístico 0.4.3

Rodada executada com:

- `ORDAX_BENCH_RUNS=3`
- `ORDAX_BENCH_MODES=fast,beta`
- 3 amostras por modo
- percentis por interpolação linear
- 6/6 execuções aprovadas
- streaming visível em 100% das execuções
- `crossRunLeak=false` nos gates consecutivos Fast → Beta

> Com apenas 3 amostras, p95 e p99 são exploratórios. Para gate de release, executar uma rodada maior.

### Fast

| Métrica | min | p50 | p95 | p99 | max | média |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| UI TTFV | 6.204 ms | **6.439 ms** | 9.107 ms | 9.344 ms | 9.403 ms | 7.349 ms |
| UI total | 7.682 ms | **8.791 ms** | 11.422 ms | 11.656 ms | 11.714 ms | 9.396 ms |
| preparação | 1.157 ms | **1.747 ms** | 1.815 ms | 1.821 ms | 1.823 ms | 1.576 ms |
| submit confirm | 1.103 ms | **1.311 ms** | 1.975 ms | 2.034 ms | 2.049 ms | 1.488 ms |
| primeiro delta Fast | 4.206 ms | **5.104 ms** | 6.981 ms | 7.147 ms | 7.189 ms | 5.500 ms |
| primeiro delta Beta | 4.571 ms | **5.606 ms** | 7.948 ms | 8.156 ms | 8.208 ms | 6.128 ms |
| vantagem Fast | 365 ms | **502 ms** | 967 ms | 1.009 ms | 1.019 ms | **629 ms** |

Taxas nesta rodada:

- Fast visto na rede: **100%**
- Fast entregue: **100%**
- Beta também observado como safety net: **100%**
- Fast venceu a corrida: **100%**
- fallback Beta em modo Fast: **0%**

### Beta

| Métrica | min | p50 | p95 | p99 | max | média |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| UI TTFV | 8.682 ms | **8.791 ms** | 9.249 ms | 9.290 ms | 9.300 ms | 8.924 ms |
| UI total | 9.941 ms | **9.954 ms** | 11.190 ms | 11.300 ms | 11.327 ms | 10.407 ms |
| preparação | 1.483 ms | **1.929 ms** | 2.330 ms | 2.366 ms | 2.375 ms | 1.929 ms |
| submit confirm | 1.672 ms | **1.876 ms** | 1.937 ms | 1.943 ms | 1.944 ms | 1.831 ms |
| primeiro delta Beta | 6.538 ms | **6.696 ms** | 6.711 ms | 6.713 ms | 6.713 ms | 6.649 ms |

Taxas nesta rodada:

- streaming Beta: **100%**
- Fast utilizado: **0%**
- Beta observado: **100%**

## Leitura dos resultados

Na rodada 0.4.3, Fast reduziu o p50 de TTFV visível de **8,791 s para 6,439 s**, cerca de **2,352 s** nessa amostra pequena. Internamente, quando ambos observaram a mesma geração, Fast chegou em média **629 ms** antes do Beta.

O ganho não deve ser tratado como constante: latência do provider, navegação de conversa e estado da página variam. Por isso o produto registra `first_observer`, `fast_seen`, `beta_seen`, `fast_delivered` e `fast_lead_ms` por Run e usa Beta como safety net da mesma geração.

## Runner canônico

Use:

```text
npm run benchmark:live
```

Configuração:

- `ORDAX_BENCH_RUNS`: amostras por modo, de 1 a 50; padrão 5.
- `ORDAX_BENCH_MODES`: modos separados por vírgula, por exemplo `fast,beta`.
- `ORDAX_REQUIRE_STREAM=1`: exige streaming incremental no smoke longo.
- `ORDAX_REQUIRE_FAST=1`: gate estrito que exige entrega Fast, útil para diagnóstico do observer; não é necessário para provar o fallback do produto.

O runner reporta min, média, p50, p95, p99, taxa de streaming, taxa de Fast visto/entregue, taxa de vitória Fast e taxa de fallback Beta.


## Crash recovery e persistencia visual - 0.4.3

O boot do Store foi endurecido para um caso observado em teste de crash: apos encerramento forcado do processo principal, o SQLite podia devolver `disk I/O error` durante a liberacao transitória dos arquivos WAL/SHM. O recovery agora:

- mantem `busy_timeout=5000`, `foreign_keys=ON` e `synchronous=FULL`;
- nao reaplica `journal_mode=WAL` quando o banco ja esta em WAL;
- faz retry limitado somente para erros transitórios de abertura (`IOERR`, `BUSY`, `LOCKED`), sem apagar, recriar ou substituir o banco;
- fecha qualquer handle parcial antes da tentativa seguinte.

Gate reproduzindo o caso real: processo Electron principal encerrado com `Stop-Process -Force` e reaberto imediatamente, sem intervalo de seguranca. Foram executados **3 ciclos consecutivos**, todos com runtime pronto e sem `disk I/O error`.

`PRAGMA integrity_check` do banco persistente retornou `ok`.

### Imagem e restart

O caminho visual foi separado da identidade textual da mensagem. Assets novos gerados pelo ChatGPT, inclusive previews `blob:` sob `data-testid="generated-image-preview"`, sao comparados contra o baseline de assets anterior a Run e podem progredir sem reutilizar texto de uma mensagem assistant antiga.

Gate de imagem aprovado:

- progresso visivel na UI OrdaX durante a geracao (`Criando imagem`, com percentual);
- PNG final persistido como `ordax-asset://local/...`;
- dimensoes: **1254 x 1254**;
- primeira imagem local visivel: **37.275 ms** desde o submit da UI;
- apos restart e os ciclos de crash recovery, o mesmo `assetId` foi renderizado novamente em **1.285 ms**, com as mesmas dimensoes.

### Streaming longo

`npm run test:live:stream` aprovado apos as correcoes de identidade:

- `requireStream=true`;
- `sawFast=true`;
- `monotonic=true`;
- `crossRunLeak=false`;
- resposta final com as 40 linhas esperadas;
- TTFV da amostra: **17.606 ms**;
- total da amostra: **25.566 ms**.


## Build portatil 0.4.3

`npm run build:win` concluiu com sucesso usando `electron-builder 26.15.3`, Electron 44.8.0, alvo `portable` x64.

Artefato final:

- arquivo: `dist/OrdaX-Gratis-0.4.3.exe`;
- tamanho: **100.280.164 bytes** (**95,63 MB**);
- SHA-256: `1D7A557BBCD2304B89F4C1BE15446BA0766E6D2FDCF3E451FCC25FE6DC05C7B0`.

Smoke do pacote aprovado: o executavel portatil foi iniciado com debug habilitado e carregou a pagina `OrdaX Gratis` diretamente de `resources/app.asar/desktop/ui.html`, confirmando que o pacote final inicia com o runtime empacotado, e nao apenas a arvore de fonte.
