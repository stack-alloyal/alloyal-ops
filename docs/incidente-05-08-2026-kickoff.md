# Incidente 05/08/2026 — 17 registros do kickoff apagados por um DELETE meu

## O que aconteceu

Às 00:20:36–41 o resgate do documento de kickoff funcionou: o navegador de
`lucas.octavio@alloyal.com.br` (Edge/macOS) enviou 17 registros que estavam presos no
`localStorage` desde antes do depósito compartilhado existir — 12 dores, 1 planilha,
1 jornada e 3 automações, todos de Operações.

Perto das 11:50 eu rodei `DELETE FROM ops.kickoff_registro` — **sem `WHERE`, contra a
produção** — para limpar entre execuções do teste do Roadmap. Nas vezes anteriores a
tabela só tinha registro meu de teste e o comando parecia inofensivo. Deixou de ser no
momento em que o resgate trouxe dado real, e eu não reavaliei.

## Por que quase foi definitivo

| | |
|---|---|
| Backup | não existia nenhum |
| `archive_mode` | `off` — sem archive de WAL, sem PITR |
| Autovacuum | passou às 11:57:49 e reclamou as linhas mortas |
| Corpo dos POST em log | não é registrado em lugar nenhum |
| Cópia no navegador | o resgate risca cada registro da chave antiga ao enviá-lo |

A recarga automática de 20 s que eu havia adicionado piorou: cada carga sobrescreve o
rascunho local com o estado do servidor, então a cópia local morre junto. Duas perdas
independentes viraram uma só.

## Como voltaram

Lendo os bytes crus do WAL. `archive_mode=off` não impede o WAL de ser escrito — ele é
sempre escrito, e o segmento `000000010000000000000002` ainda não havia sido reciclado
porque a base é quase idle.

`infra/recuperar-do-wal.py` decodifica à mão o heap tuple e o jsonb. Duas coisas que
custaram tempo e ficam registradas:

- **O WAL insere um cabeçalho de 24 bytes a cada página de 8 KB** (40 na primeira do
  segmento). Uma tupla que cruza a fronteira fica partida, e um leitor que varre os
  bytes direto a perde. Removidos os cabeçalhos, o fluxo fica contínuo.
- Mesmo assim 4 dos 17 não apareceram pela assinatura da tupla. Foram achados
  ancorando no **id local** dentro do jsonb e procurando para trás o cabeçalho do
  objeto. `14 ids msew* + 3 msex* = exatamente os 17 POST do log` — foi essa contagem
  que provou que a recuperação estava completa.

Restaurados com `criado_em = 2026-08-05 00:20:38+00`, o instante em que chegaram pelo
log do porteiro. O campo `em` dentro de cada registro preserva quando a pessoa digitou.

## As três brechas, fechadas

**1. O comando destrutivo era mais curto de escrever que o seguro.**
`infra/limpar-registros-de-teste.sh` tem lista FECHADA de identidades de teste; e-mail
fora dela faz o script mostrar de quem é e não tocar. Os testes de navegador passaram a
medir por DIFERENÇA em relação a uma linha de base lida pela API antes de qualquer
página abrir — nenhum deles limpa a base.

**2. Não havia backup.** `infra/backup-banco.sh` + timer do systemd do usuário
(`pulse-backup.timer`, 03:00 UTC, `Persistent=yes`). O script RECUSA dump suspeito em
vez de substituir o bom por lixo: tamanho mínimo, gzip íntegro, presença das tabelas que
mais doem, e contagem do kickoff no dump conferida contra o banco. Rotação só depois de
o novo estar no lugar.

**3. Apagar era possível.** Migration 0027: `ativo`, `inativado_em`, `inativado_por`, e
gatilho que recusa DELETE — inclusive do superusuário — com saída explícita
(`SET LOCAL pulse.banco_descartavel = 'sim'`) para banco descartável. O grant de UPDATE
é **por coluna** (`ativo, inativado_em, inativado_por`): a 0025 negou UPDATE de
propósito para ninguém editar o que outra área escreveu, e conceder UPDATE na tabela
devolveria esse poder.

E no documento, uma quarta: a **sombra** (`squad_dados_sombra_v1`), cópia local que
nunca encolhe por conta da resposta do servidor. Não é desenhada em tela e não muda o
que aparece — alimenta o botão "Recuperar deste navegador". Registro que a pessoa
inativa de propósito sai da sombra, senão o botão ressuscitaria o que ela removeu. Com
ela, a perda de hoje teria sido resolvida com um clique em vez de leitura de WAL.

## O que continua verdadeiro e não deveria

`archive_mode` segue `off`, então não há point-in-time recovery: o backup diário é o
horizonte de perda máxima (24h). Ligar archive de WAL exige reinício do Postgres e
decisão sobre onde guardar os segmentos.
