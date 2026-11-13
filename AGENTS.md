# AGENTS.md — OrdaX Flow

## Regra transversal de execução e integração

Flow é owner do seu cliente/hub e contratos de chat. Ele não é compositor do OrdaX OS e não deve duplicar Surface, Runtime, MCP, Platform, Apps ou identidade.

- Implementar mudanças locais primeiro e validar proporcionalmente.
- Consumir apenas contratos/capacidades públicas dos owners; não importar source transitivo.
- Uma mudança compatível em Flow não exige PR em OS/Desktop/Surface/Apps.
- Integração cross-repo só ocorre quando existe dependência direta real e um novo contrato/artefato precisa ser adotado.
- Não usar snapshots/SHAs históricos do README como instrução operacional quando a main/contrato atual divergir.

Regra canônica: https://github.com/ordaxsystems/ordax-os/blob/main/docs/DEVELOPMENT-WORKFLOW.md#integração-multi-repositório--composição-do-produto-2026-11-13 (ADR-031).

## Escopo

Preservar a distinção entre Flow Task/Projeto e Space/Projeto canônicos do restante do ecossistema. Chat normal não exige MCP/Runtime/OS. Se uma capacidade externa for necessária, usar a interface autorizada do owner correspondente; não criar uma segunda autoridade no Flow.
