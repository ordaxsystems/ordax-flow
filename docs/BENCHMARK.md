# Benchmark — OrdaX Gratis 0.4.2

Medições abaixo foram obtidas em 2026-10-17 no PC autorizado, usando E2E que opera a interface `desktop/ui.html` do OrdaX. O ChatGPT Web permaneceu oculto durante os gates de texto e imagem.

## Texto — Fast

Prompt: `Responda exatamente: ORDAX_UI_FAST_OK`

Resultado aprovado:
- TTFV pela UI OrdaX: **6.132 ms**
- tempo total pela UI: **8.566 ms**
- prepare interno: **1.638 ms**
- confirmação de submit: **427 ms**
- primeiro byte de rede: **3.581 ms** após tentativa de submit
- primeiro delta Fast: **4.181 ms** após tentativa de submit
- primeiro delta Beta da mesma geração: **5.154 ms**
- vantagem Fast nesta amostra: **973 ms**

## Texto — Beta

Prompt: `Responda exatamente: ORDAX_UI_BETA_OK`

Resultado aprovado:
- TTFV pela UI OrdaX: **7.695 ms**
- tempo total pela UI: **10.012 ms**
- Fast não foi usado
- resposta apareceu e finalizou somente pelo observer Beta

## Ganho da correção de preparação

Antes da correção de new-chat readiness e seleção do botão do mesmo form:
- TTFV Fast observado: **34,765 s**
- total: **58,136 s**
- `prepare_ms`: **19.267 ms**
- `submit_confirm_ms`: **7.693 ms**

Depois da correção:
- TTFV Fast: **6,132 s**
- total: **8,566 s**
- `prepare_ms`: **1.638 ms**
- `submit_confirm_ms`: **427 ms**

## Imagem

Prompt: `Gere uma imagem simples de um cubo azul sobre fundo branco. Não pesquise imagens; crie uma imagem.`

Resultado aprovado:
- progresso apareceu na UI OrdaX durante geração;
- primeiro texto/progresso Beta observado em aproximadamente **981 ms** após tentativa de envio;
- asset local final: PNG renderizado pelo protocolo `ordax-asset://`;
- dimensões validadas: **1254×1254**;
- primeira imagem local visível: **44.425 ms** desde o submit da UI;
- total do gate: **44.536 ms**;
- após restart, a mesma imagem foi renderizada novamente a partir do estado local.

## Interpretação

Fast reduz a latência percebida quando o stream de rede pode ser observado, mas Beta permanece o caminho estável da mesma geração. O maior ganho desta rodada veio da remoção de esperas/navegações desnecessárias antes do envio, não de atalhos no backend.

Próximos benchmarks devem usar várias amostras e reportar p50/p95, não apenas uma execução isolada.
