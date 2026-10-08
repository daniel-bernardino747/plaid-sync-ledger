# Original proposal (spec)

Verbatim copy of the brief this repository was built from (in Portuguese, as written).
Decisions that later changed parts of it are recorded in `docs/adr/`.

---

Sincronização com o Plaid que aguenta falha no meio

## Contexto

Vou me candidatar a uma vaga de Senior Full-Stack Engineer numa fintech que conecta contas bancárias pelo Plaid. A stack deles:

- monorepo TypeScript com Next.js 16 (web e API), um app Expo e um Cloudflare Worker;
- PostgreSQL com Prisma;
- webhooks do Plaid, Stripe e de SMS, além de jobs agendados;
- tokens bancários cifrados e escopo de dados por usuário.

A vaga pede experiência real com idempotência, retries, deduplicação de webhooks, jobs que falham no meio do caminho, migrations seguras em dados vivos e um instinto de segurança com PII. Quero construir em um fim de semana um sistema pequeno que prove isso a quem escreveu a vaga. Não é um produto, é uma demonstração de engenharia. O repositório vai ser lido por um engenheiro sênior, que vai olhar a corretude sob falha, não a interface.

## Antes de escrever código

- Confira na documentação oficial do Plaid cada endpoint, header e código de erro citado aqui. Não confie na memória. Se algo divergir do que está aqui, a documentação vence; me avise da diferença.
- Me mostre um plano curto (estrutura do monorepo, schema do Prisma e fluxo de um webhook até a gravação) e espere minha aprovação.

## Stack

- Monorepo com pnpm workspaces e Turborepo.
- apps/web: Next.js 16 com App Router, para o Plaid Link e as rotas de API.
- apps/webhooks: Cloudflare Worker.
- apps/worker: processo Node que consome a fila.
- packages/db: Prisma e PostgreSQL, compartilhado entre os apps.
- packages/crypto: criptografia.
- Plaid em modo Sandbox. Postgres local com Docker Compose. Testes com Vitest, com integração rodando contra um Postgres real, não mockado.
- Sem infraestrutura extra: a fila é uma tabela no Postgres consumida com SELECT ... FOR UPDATE SKIP LOCKED. Se o Worker não alcançar o Postgres local, ele pode fazer POST para uma rota interna autenticada do apps/web, que grava o evento.

## O que construir

### 1. Conexão da conta

- O usuário conecta um banco pelo Plaid Link (pode usar /sandbox/public_token/create nos testes).
- O public_token é trocado pelo access_token no servidor.
- O access_token nunca é gravado em claro (ver item 5).

### 2. Recebimento de webhooks no Cloudflare Worker

- Verificar o header Plaid-Verification:
  - o JWT é ES256 e a chave pública é buscada por kid em /webhook_verification_key/get, com cache;
  - rejeitar iat com mais de 5 minutos;
  - comparar o SHA-256 do corpo bruto com o claim request_body_sha256.
- Deduplicar com uma chave derivada (item_id + webhook_code + hash do corpo) sob constraint UNIQUE e enfileirar.
- Responder 200 rápido e nunca processar dentro do request.
- Deixar explícito no README e no código: a deduplicação é otimização, a corretude vem de o sync ser idempotente.

### 3. Sync de transações por cursor

- SYNC_UPDATES_AVAILABLE dispara /transactions/sync.
- added, modified e removed são aplicados por upsert no transaction_id do Plaid.
- O cursor novo é gravado na mesma transação do Postgres que as mudanças.
- Em TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION, descartar as páginas acumuladas e recomeçar do cursor que estava salvo no início do loop.
- Lock por item, para que dois workers nunca sincronizem o mesmo item ao mesmo tempo (advisory lock ou SKIP LOCKED).
- Retry com backoff exponencial e jitter. Depois de N tentativas, o job vai para um estado dead visível.

### 4. Re-autenticação

- ITEM_LOGIN_REQUIRED, seja como erro ou como webhook ERROR/PENDING_EXPIRATION, leva o item ao estado needs_reauth e para de sincronizá-lo.
- O Plaid Link em update mode recupera o item e retoma o sync do cursor salvo.
- Testar provocando o erro com /sandbox/item/reset_login.

### 5. Criptografia em repouso

- Envelope encryption com AES-256-GCM:
  - uma chave de dados por usuário, embrulhada por uma master key vinda de variável de ambiente (simulando um KMS);
  - versão da chave gravada junto com o dado, para permitir rotação.
- Um script que rotaciona a master key sem downtime.
- Nada de token ou PII nos logs. Um teste deve garantir isso.

### 6. Script de caos (pnpm chaos), a peça central

Rodar contra o Sandbox ou contra um fake do Plaid com o mesmo contrato, provando que o ledger final é idêntico ao de uma execução limpa. Comparar por hash das transações ordenadas.

Cenários:

- matar o worker no meio de uma página (flag FAIL_AFTER_N_UPSERTS) e reiniciar;
- reenviar cada webhook 10 vezes;
- rodar dois workers em paralelo;
- injetar MUTATION_DURING_PAGINATION na segunda página;
- injetar 500 e timeout do Plaid.

Saída: uma tabela no terminal e no README com cenário, resultado e o hash do ledger.

### 7. Bônus, se sobrar tempo: migration segura em dados vivos

- Popular cerca de 5 milhões de transações fake.
- Fazer uma mudança expand/contract:
  - coluna nova nullable;
  - backfill em lotes com pausa;
  - CREATE INDEX CONCURRENTLY;
  - por fim, NOT NULL via CHECK ... NOT VALID seguido de VALIDATE.
- Mostrar EXPLAIN ANALYZE antes e depois e o tempo de lock medido.
- Verificar como o Prisma Migrate lida com CONCURRENTLY fora de transação, e documentar.

## Entregáveis

- README em inglês, nesta ordem:
  - o que o sistema garante, em uma frase cada;
  - um diagrama do fluxo do webhook até o ledger;
  - a tabela do caos;
  - as decisões e o que ficou de fora (e por quê);
  - "Where the AI got it wrong": bugs concretos que o assistente introduziu e como foram pegos. Mantenha esse log durante o trabalho; não invente entradas.
- docs/rca-001.md: o RCA de um incidente simulado (por exemplo, o cursor avançou sem as transações gravadas), no formato timeline, impacto, causa raiz, correção e ações. Em inglês, claro o bastante para não gerar pergunta de volta.
- Histórico em commits pequenos, com mensagens em inglês.

## Restrições

- Fim de semana. Sábado: itens 1 a 3 e os testes de idempotência. Domingo: itens 4 a 6, README e RCA. Bônus só se sobrar tempo.
- Corretude sob falha vale mais que a interface. A UI pode ser um botão de conectar e uma lista de transações.
- Toda garantia escrita no README precisa de um teste que a prove.
- Não use bibliotecas que escondam o problema central (fila gerenciada, SDK de sync pronto). O ponto é mostrar que eu sei fazer.
