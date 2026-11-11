# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) enviadas por
provedores de jogos, mantendo o saldo de cada wallet correto mesmo com mensagens duplicadas, fora de
ordem, várias instâncias concorrentes e quedas no meio do processamento.

- **Stack:** Bun 1.x · TypeScript estrito · NestJS · PostgreSQL · MikroORM · AWS SQS (MiniStack) · Docker Compose
- **Decisões, trade-offs e limitações:** [ARCHITECTURE.md](./ARCHITECTURE.md)

## Requisitos

- Docker com Docker Compose
- [Bun](https://bun.sh) 1.x (para desenvolvimento local e testes)

## Subir tudo com Docker Compose

```bash
docker compose up -d --build
```

Isso sobe PostgreSQL, MiniStack (SQS), aplica as migrations e inicia **3 instâncias** da aplicação em
`http://localhost:3000`, `:3001` e `:3002`, todas compartilhando o mesmo banco e as mesmas filas.

```bash
curl localhost:3000/health/ready     # PostgreSQL e SQS alcançáveis
docker compose logs -f app           # logs estruturados (JSON)
docker compose down                  # parar (adicione -v para apagar os dados)
```

## Desenvolvimento local

```bash
bun install
docker compose up -d postgres ministack   # apenas a infraestrutura
bun run migrate up                        # cria as tabelas
bun run start                             # aplicação em http://localhost:3000
```

A porta 3000 é a mesma usada pelo Compose completo: use um ou outro.
Todas as configurações têm valor padrão e estão descritas em [`.env.example`](./.env.example).

## Comandos

| Comando | O que faz |
| --- | --- |
| `bun run start` | Inicia a aplicação (HTTP + consumidor SQS + publisher da outbox + worker de referências) |
| `bun run start:dev` | Igual, reiniciando a cada alteração |
| `bun run migrate up` / `down` / `status` | Aplica, reverte ou lista migrations |
| `bun run test:unit` | Testes de unidade do domínio (não precisam de infraestrutura) |
| `bun run test:int` | Testes de integração e concorrência (PostgreSQL e MiniStack reais) |
| `bun run test` | Todos os testes |
| `bun run lint` | Lint |

## Testes

```bash
docker compose up -d postgres ministack
bun run test
```

Os testes de integração usam um banco separado (`wallet_test`, criado automaticamente) e filas próprias,
portanto não interferem nos dados de desenvolvimento. Nada é substituído por mock: PostgreSQL e SQS são reais.

| Arquivo | O que comprova |
| --- | --- |
| `src/domain/*.spec.ts` | Money, invariantes da Wallet, ledger, máquina de estados da transação |
| `test/integration/schema.spec.ts` | Migrations reversíveis e cada constraint do banco |
| `test/integration/wagering.spec.ts` | Regras de BET/WIN/LOSS/REFUND/ROLLBACK, idempotência, referências fora de ordem, atomicidade |
| `test/integration/concurrency.spec.ts` | Cenário obrigatório (2 × 80,00 sobre 100,00), mesma aposta 50× em paralelo, hot wallet, wallets em paralelo |
| `test/integration/messaging.spec.ts` | Inbox e redelivery, retry e DLQ, worker morto entre commit e ack, dois publishers na mesma outbox |
| `test/integration/http.spec.ts` | Contratos HTTP, códigos de status, health, métricas, reconciliação |
| `test/integration/multi-instance.spec.ts` | 3 processos reais simultâneos, instância morta sob carga, reinício e consistência final |

Invariante verificada ao final dos testes: `wallet.balance == saldo reconstruído pelo ledger`.

## API

| Método e rota | Descrição |
| --- | --- |
| `POST /wallets` | Cria wallet (saldo inicial gera transação `OPENING` + lançamento `CREDIT`) |
| `GET /wallets/:walletId` | Consulta wallet |
| `GET /wallets/:walletId/ledger?cursor=&limit=50` | Ledger paginado por cursor opaco |
| `POST /wallets/:walletId/reconciliation` | Compara saldo armazenado com o ledger |
| `POST /wagering/transactions` | Submete transação (header `Idempotency-Key` obrigatório) |
| `GET /wagering/transactions/:transactionId` | Consulta por id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta por id do provedor |
| `GET /health/live` · `GET /health/ready` | Liveness e readiness (sem autenticação) |
| `GET /metrics` | Métricas em formato Prometheus |

### Exemplo

```bash
# criar wallet
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# apostar (troque WALLET_ID pelo id retornado)
curl -i -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"player-1",
       "walletId":"WALLET_ID","roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'
```

Repetir a mesma requisição devolve a mesma resposta com `"idempotentReplay": true`.

### Códigos de status de `POST /wagering/transactions`

| Status | Situação | O provedor deve |
| --- | --- | --- |
| `200` | `PROCESSED`: transação aplicada | seguir em frente |
| `202` | `PENDING_REFERENCE`: aceita, aguardando a transação referenciada | consultar depois ou acompanhar os eventos |
| `422` | `REJECTED`: regra de negócio (ver `failureCode`) | não reenviar o mesmo payload |
| `400` | Payload inválido ou `Idempotency-Key` ausente | corrigir e reenviar |
| `409` | Mesma key (ou mesma transação do provedor) com payload diferente | não reenviar com essa key |
| `503` | Falha transitória de infraestrutura (`Retry-After`) | reenviar a mesma requisição |

Um replay devolve sempre o mesmo status da resposta original. Erros têm o formato
`{ "error": { "code": "...", "message": "..." } }`.

## Filas SQS

| Fila | Uso |
| --- | --- |
| `wager-transactions.fifo` | Entrada: mensagens `WagerTransactionRequested` |
| `wager-transactions-dlq.fifo` | Mensagens inválidas ou que esgotaram as tentativas (atributo `reason`) |
| `wallet-events.fifo` | Saída: eventos de integração publicados pela outbox |

Em ambiente local a aplicação cria as filas ao iniciar (`SQS_CREATE_QUEUES=true`).

## Estrutura

```
src/
  domain/          regras de negócio puras (Money, Wallet, WagerTransaction, ledger, eventos) — sem framework
  application/     casos de uso e portas (interfaces que a infraestrutura implementa)
  infrastructure/  MikroORM (records, adapter, migrations), SQS (filas, consumidor, publisher), workers
  http/            controllers, filtro de erros, guard de autenticação (ponto de extensão)
  shared/          configuração, logger JSON, métricas, geração de ids
test/integration/  testes com PostgreSQL e SQS reais
```
