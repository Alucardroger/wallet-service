# Teste de carga

Experimento executado com `bun run test:load` (script em [`test/load/load-test.ts`](./test/load/load-test.ts)).

O objetivo não é anunciar uma capacidade, e sim observar como o sistema se comporta sob concorrência:
onde a latência cresce, se aparecem erros ou conflitos e quanto a publicação de eventos se atrasa.
Os números abaixo valem para um notebook com tudo na mesma máquina e **não** devem ser lidos como
capacidade de produção.

## Como reproduzir

```bash
docker compose up -d postgres ministack
bun run test:load
```

O script cria um banco próprio (`wallet_load`) e filas próprias, sobe os processos da aplicação, executa
os cenários, imprime o relatório e o grava em `load-test-results.md`. Termina com código de erro se a
verificação de consistência falhar.

| Variável | Padrão | Significado |
| --- | --- | --- |
| `LOAD_DURATION_SECONDS` | 20 | duração de cada cenário |
| `LOAD_CONCURRENCY` | 32 | usuários virtuais simultâneos |
| `LOAD_WALLETS` | 200 | wallets do cenário distribuído |
| `LOAD_INSTANCES` | 3 | processos da aplicação |

## Ambiente

| Item | Valor |
| --- | --- |
| Data | 2026-11-12 |
| CPU | 13th Gen Intel Core i5-1335U (12 núcleos lógicos) |
| Memória | 7,6 GB |
| Sistema | Linux 6.18 (WSL2 no Windows), PostgreSQL e MiniStack em contêineres do Docker Desktop |
| Bun | 1.4.4 |
| PostgreSQL | 17.11 |
| SQS | MiniStack (emulador), não o serviço real da AWS |
| Aplicação | 3 processos (`bun run src/main.ts`), configuração padrão, autenticação desligada |
| Topologia | gerador de carga, aplicação, banco e fila **na mesma máquina** |

## Metodologia

- **Modelo de carga fechado**: 32 usuários virtuais; cada um envia uma requisição
  `POST /wagering/transactions`, espera a resposta e envia a próxima, por 20 segundos. As requisições são
  distribuídas entre as 3 instâncias.
- **Operações**: 60% BET e 40% WIN de 1,00 BRL, cada uma com `Idempotency-Key` nova. As wallets começam
  com saldo alto, para medir o custo do processamento e não rejeições por saldo.
- **Cenário 1, distribuído**: 200 wallets escolhidas ao acaso; 10% das requisições são repetições exatas
  de uma requisição anterior (exercita o caminho de replay).
- **Cenário 2, hot wallet**: todos os usuários na mesma wallet, o pior caso para o lock por wallet.
- **Latência** medida no cliente, por requisição, incluindo a leitura da resposta. Percentis calculados
  sobre todas as amostras do cenário.
- **Erros**: respostas `5xx` e falhas de rede. Rejeições de negócio (`422`) seriam contadas à parte.
- **Conflitos de concorrência**: variação de `wager_lock_conflicts_total` (timeouts de lock, deadlocks e
  corridas de insert), somada entre as instâncias a partir de `GET /metrics`.
- **Outbox**: a cada 250 ms o script consulta quantos eventos estão pendentes e a idade do mais antigo.
  Depois da carga, mede quanto tempo os publishers levam para zerar a fila.
- **Consistência**: ao final, consultas SQL verificam saldo contra ledger em todas as wallets.

## Resultados

| Métrica | Distribuído (200 wallets) | Hot wallet (1 wallet) |
| --- | --- | --- |
| Requisições | 4.588 | 1.157 |
| Duração | 20,2 s | 20,5 s |
| Throughput | 227 req/s | 56 req/s |
| Latência p50 | 129,0 ms | 561,1 ms |
| Latência p95 | 271,1 ms | 831,2 ms |
| Latência p99 | 386,7 ms | 984,8 ms |
| Latência máxima | 542,8 ms | 1.078,4 ms |
| Status HTTP | 200: 4.588 | 200: 1.157 |
| Taxa de erro (5xx + rede) | 0 (0,00%) | 0 (0,00%) |
| Replays idempotentes | 476 | 0 |
| Conflitos de concorrência | 0 | 0 |
| Outbox: pico de eventos pendentes | 6.184 | 66 |
| Outbox: pico de lag | 33,6 s | 0,6 s |
| Outbox: tempo para esvaziar após a carga | 34,2 s | 0,3 s |

Consistência após a execução:

| Verificação | Resultado |
| --- | --- |
| Wallets com saldo diferente do ledger | 0 |
| Wallets com saldo negativo | 0 |
| Transações com mais de um lançamento | 0 |
| Linhas gravadas | 5.470 transações, 5.470 lançamentos, 10.940 eventos |

As contagens fecham: 4.112 transações novas no cenário distribuído (4.588 requisições menos 476 replays),
1.157 no cenário hot wallet e 201 aberturas de wallet somam 5.470, com exatamente dois eventos por transação.

## Análise

### Correção

Nenhum erro, nenhum conflito e nenhuma inconsistência em 5.745 requisições. Os 476 replays devolveram
`200` com `idempotentReplay: true` e nenhum gerou segundo lançamento. É o resultado que mais importa
neste serviço, e ele se manteve sob carga.

### Hot wallet: o custo do lock por wallet

Com todos os usuários na mesma wallet, o throughput cai para 56 req/s. Isso é esperado e intencional:
o lock de linha serializa a wallet, então só uma transação anda por vez. O número indica cerca de
**18 ms por transação com o lock em mãos** (1 / 56) nesta máquina.

A latência confirma a leitura: com 32 usuários em fila, cada um espera pelos outros, e 32 × 18 ms dá
aproximadamente 570 ms, muito próximo do p50 medido (561 ms). A latência de uma hot wallet cresce de
forma linear com o número de requisições simultâneas para ela.

Extrapolando (estimativa, **não medida**): por volta de 280 requisições simultâneas para a mesma wallet,
a espera chegaria aos 5 s do `lock_timeout` e parte delas passaria a receber `503`. Para um jogador real
isso está muito distante, mas uma wallet compartilhada por muitos atores atingiria esse limite.

### Cenário distribuído: o paralelismo rende menos do que poderia

Com 200 wallets não há disputa de lock (zero conflitos), mas o throughput foi de 227 req/s, só quatro
vezes o da hot wallet, apesar de 32 usuários e 3 instâncias. Cada requisição levou 129 ms na mediana,
contra os cerca de 18 ms de uma transação isolada. Ou seja, há um recurso compartilhado saturando.

**Não isolei qual.** As hipóteses, em ordem do que eu investigaria primeiro:

1. **CPU compartilhada.** Gerador de carga, três processos da aplicação, PostgreSQL, MiniStack, três
   consumidores e três publishers disputam os mesmos 12 núcleos lógicos de um processador de notebook
   (2 núcleos de desempenho e 8 de eficiência), dentro do WSL2.
2. **Idas e vindas ao banco por transação.** O adapter faz `flush` a cada escrita para manter a ordem
   explícita do SQL (ver ARCHITECTURE, seção 3). São cerca de dez comandos por transação. Agrupar as
   escritas reduziria esse número.
3. **Custo do commit.** Cada transação faz `fsync` em um volume do Docker Desktop sobre WSL2, que é
   sabidamente lento para escrita síncrona.
4. **Concorrência com os publishers da outbox**, que nesse cenário ficaram ocupados o tempo todo no
   mesmo banco.

Para decidir entre elas eu repetiria o teste com os publishers desligados, com o gerador em outra
máquina e com `pg_stat_statements` ligado.

### Outbox: o gargalo real encontrado

Este é o achado mais relevante do experimento. No cenário distribuído, as transações produziram cerca de
410 eventos por segundo (4.112 transações × 2 eventos em 20 s), mas os três publishers publicaram cerca de
100 por segundo durante a carga. O acúmulo chegou a 6.184 eventos e 33,6 s de atraso, e a fila só zerou
34,2 s depois do fim da carga (cerca de 180 eventos por segundo, já sem concorrência).

No cenário hot wallet a produção foi de cerca de 112 eventos por segundo, dentro da capacidade dos
publishers, e o lag ficou em 0,6 s. Os dois cenários contam a mesma história: **a capacidade de publicação
é de aproximadamente 100 a 180 eventos por segundo neste ambiente, e acima disso o atraso cresce sem limite
enquanto a carga durar.**

O que isso significa:

- **Não é um problema de correção.** Nenhum evento se perdeu e todos foram publicados; a outbox absorveu
  o pico e escoou depois, que é exatamente a função dela.
- **É um problema de atualidade dos eventos.** Um consumidor de `WalletBalanceChanged` veria saldos com
  dezenas de segundos de atraso sob carga sustentada.
- **Causa provável**: cada publisher envia um evento por chamada ao SQS, um de cada vez, dentro da
  transação que segura as linhas. Parte do tempo também é do emulador (MiniStack), que não representa a
  latência do SQS real.
- **Melhorias, em ordem de custo**: usar `SendMessageBatch` (até 10 eventos por chamada); enviar os
  eventos do lote em paralelo; aumentar o tamanho do lote; e medir contra o SQS real antes de qualquer
  conclusão sobre capacidade.

A métrica `wager_outbox_lag_seconds` já expõe esse atraso, então um alerta sobre ela detectaria a
situação em produção.

## Limitações do experimento

- **Uma execução por cenário**, de 20 segundos, sem repetições: não há medida de variação entre execuções
  e o aquecimento do runtime está incluído nas amostras.
- **Tudo na mesma máquina**: o gerador de carga compete por CPU com o sistema medido.
- **Modelo fechado**: quando o servidor fica lento, os usuários virtuais enviam menos, o que suaviza as
  latências altas (omissão coordenada). Um modelo aberto, com taxa de chegada fixa, mostraria caudas piores.
- **Notebook com WSL2 e Docker Desktop**: virtualização, disco e gerenciamento térmico afetam os números.
- **SQS emulado**: os resultados de outbox não se transferem diretamente para a AWS.
- **Autenticação desligada**: o custo de validar o JWT não está incluído.
- **Só a entrada HTTP**: o consumidor SQS não foi submetido a carga.
- **Tabelas quase vazias**: com milhões de linhas, índices e planos de consulta se comportariam de outra forma.
- **Sem rejeições**: os saldos altos evitam o caminho de saldo insuficiente.
