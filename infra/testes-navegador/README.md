# Testes de navegador do documento de kickoff

Rodam Chromium de verdade contra o contêiner, com os cabeçalhos que o porteiro
injetaria. Não estão no CI: precisam da pilha de pé e do Playwright, e o CI não tem
Postgres com o documento servido.

```bash
cd packages/ui                      # é onde o playwright está instalado
set -a; . ../../infra/.env; set +a
export BASE=http://$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' pulse-web-internal | awk '{print $1}'):3000
node ../../infra/testes-navegador/resgate.mjs
node ../../infra/testes-navegador/roadmap.mjs
../../infra/limpar-registros-de-teste.sh     # limpa SÓ as identidades de teste
```

## Duas regras que não são opcionais

**Nunca limpar a base entre execuções.** Estes testes rodam contra a PRODUÇÃO, que tem
o levantamento real dos times. Em 05/08/2026 um `DELETE FROM ops.kickoff_registro` sem
filtro, feito exatamente para "limpar entre execuções", apagou 17 registros que
Operações havia acabado de preencher. Só voltaram porque os bytes ainda estavam no WAL.
Hoje o gatilho da migration 0027 recusa DELETE, mas a regra vale de qualquer forma:
**medir por diferença, e limpar por escopo** com `limpar-registros-de-teste.sh`.

**Contagem é relativa à linha de base**, lida pela API antes de qualquer página abrir.
Medir com a página já aberta não serve: o resgate roda na carga, e a base sairia
contaminada pelos próprios registros do teste.

## O que a CSP obriga

A aplicação manda `upgrade-insecure-requests`, e está certa. Falando http com o
contêiner, o Chromium promove tudo para https e tudo falha com `ERR_SSL_PROTOCOL_ERROR`
— artefato do teste, não defeito. Os dois arquivos contornam com `ctx.route()`
devolvendo a requisição ao http, sem tocar na CSP servida.

## Recuperação de emergência

`infra/recuperar-do-wal.py` lê os bytes crus de um segmento de WAL e reconstrói as
linhas de `ops.kickoff_registro` (heap tuple + jsonb decodificados à mão). É o último
recurso, não o procedimento: o procedimento é `infra/backup-banco.sh`, agendado.
