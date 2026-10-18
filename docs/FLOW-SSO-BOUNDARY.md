# Flow e Conta OrdaX — SSO sem segundo login

Decisão de produto (18/10/2026): o Flow Client e o Flow Hub **não têm cadastro, senha, banco de usuários ou provedor de login próprios**. Reutilizam a Conta OrdaX, cujo owner atual é o Supabase Auth da OrdaX Platform. O OrdaX Studio e o OrdaX OS não são dependências operacionais do Flow.

## Comportamento esperado

1. O usuário já conectado ao ecossistema OrdaX abre o Flow. O aplicativo consulta `GET /v1/session` na mesma origem; se a sessão canônica for reconhecida, carrega seus projetos autorizados. Não pede senha novamente.
2. Sem sessão OrdaX válida, o Flow permanece sem acesso a projetos e mensagens. O futuro botão de entrada redirecionará **para a autorização oficial da Conta OrdaX** (OIDC/OAuth com PKCE, estado/callback e sessão segura gerenciados pela plataforma), nunca para um formulário duplicado do Flow.
3. No Hub, a mesma sessão de Conta OrdaX é verificada em `GET /v1/hub/session`, mas **somente** a permissão `flow:hub:read` concedida pelo owner de RBAC permite acessar métricas. Ser proprietário de uma conta OrdaX não concede autorização administrativa.
4. Outro computador requer uma sessão autenticada no dispositivo/navegador daquele usuário. A sincronização de projetos e mensagens dependerá do banco central canônico; login não é substituto para storage ou autorização.

## Contrato implementado nesta etapa

- `src/relay/browser-session.mjs`: adaptador de confiança para a sessão já verificada pela OrdaX Platform. `verifyAccountSession({request})` deve retornar **somente no backend** `{verified:true,session:{subject_id:UUID,expires_at_unix:int}}` após validar a sessão da Conta OrdaX no owner. Não aceita identidade apresentada pelo navegador, campos de mensagem, cabeçalhos X-User ou JWT sem verificação. Falha fechado em expiração, revogação, falha de rede ou consulta indisponível.
- Para operações com cookie, exige `Origin` exata conforme a origem HTTPS configurada do Flow; rejeita requisições cross-site mesmo quando trazem cookie. O backend ainda precisa fornecer cookies HttpOnly, Secure, SameSite e proteção de sessão conforme o emissor canônico.
- `src/relay/platform-composition.mjs` injeta esse adaptador no único gateway; não cria login próprio.
- `GET /v1/session`: informa apenas `authenticated:true/false`, sem devolver ID de conta, cookies, credenciais ou escopos.
- `GET /v1/hub/session`: exige conta válida **e** autorização `flow:hub:read`; caso contrário, 401 ou 403. A UI do Hub consulta esse endpoint antes das métricas.
- O Flow Client consulta a sessão antes dos projetos; quando não autenticado, não inventa URL de login nem abre um formulário local.

## O que ainda falta (não declarar concluído)

- Verificar o mecanismo SSO real de sessão web da OrdaX Platform em um **domínio autorizado** e conectar o port `verifyAccountSession`, inclusive logout/revogação e renovação.
- Registrar, no emissor canônico, o cliente web do Flow e seu callback/redirect URI de OAuth (ou outro fluxo SSO documentado), usando a interface existente da plataforma. Não transmitir tokens entre subdomínios via query strings, não copiar cookies entre apps nem armazenar credenciais no navegador em localStorage.
- Aplicar operador/grants reais do Hub, propriedades canônicas dos projetos, autorização de memória, cotas e roteador de IA. O código atual não implanta a autenticação nem inventa permissões.
- Provar dois navegadores autenticados com o mesmo usuário e um segundo usuário; cenários de conta errada, sessão revogada, CSRF, timeout, troca de dispositivo e escalada de operador.

## Testes

`node --test test/browser-session.test.mjs test/platform-composition.test.mjs` exercita sessões simuladas, expiração, origem, falsificação de claims, perfis de operador e acesso segregado. Os testes de simulação **não são prova de login real nem de SSO de produção**.

Regra de SSOT: os identitificadores de sujeito são emitidos pela OrdaX Platform; projetos, RBAC e memória também precisam provir dos respectivos owners canônicos. Nenhum sistema de contas Flow separado.
