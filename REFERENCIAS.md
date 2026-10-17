# Referências — OrdaX Gratis

## Escopo

Estas referências servem para benchmark técnico e de produto. O OrdaX Gratis permanece um repositório independente do `ordax-gpt` e não incorpora automaticamente código ou mecanismos dessas bases.

## Projetos estudados

### `s5treak/reverse-chatgpt`

Pontos úteis estudados:
- streaming incremental de baixa latência;
- parser de eventos/chunks;
- importância de medir time-to-first-stream.

O que não é incorporado ao produto:
- fabricação direta de requests privados do ChatGPT;
- impersonação de navegador;
- obtenção/solução de Sentinel, proof-of-work ou Turnstile;
- qualquer bypass de autenticação ou anti-bot.

O modo Fast do OrdaX observa a resposta que o próprio WebContents autenticado já recebeu; ele não replica o cliente reverse como mecanismo de envio.

### `guberm/chatgpt-web-provider`

Pontos úteis estudados:
- worker Web persistente;
- abstração de provider;
- health/status e fila.

Melhorias buscadas no OrdaX:
- streaming visível enquanto a geração acontece, em vez de esperar idle para extrair a resposta final;
- Task local durável independente da sessão Web;
- recuperação de Run e persistência de assets;
- E2E na interface final do usuário.

### `Rextrad/chatgpt-web-share`

Pontos úteis estudados:
- UI própria;
- streaming para frontend;
- fila/serialização;
- separação visual de conversas.

Melhorias buscadas no OrdaX:
- estado local orientado a Task, não apenas conversation id upstream;
- Fast/Beta observando a mesma geração;
- recuperação após restart;
- imagens persistidas localmente;
- desktop próprio sem reverse proxy como dependência estrutural.

## Princípio de comparação

O objetivo não é declarar superioridade abstrata. Cada gate deve ser mensurável em pelo menos uma destas dimensões:

- TTFV/TTFS;
- tempo total;
- taxa de sucesso;
- tolerância a mudança de UI;
- recuperação de falha/restart;
- persistência de texto/imagens;
- ausência de duplicação de envio;
- experiência do usuário na UI OrdaX.

Os resultados atuais estão em `docs/BENCHMARK.md`.
