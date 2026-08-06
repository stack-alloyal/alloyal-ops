#!/usr/bin/env bash
#
# Remove do kickoff SÓ os registros das identidades de teste.
#
# ┌───────────────────────────────────────────────────────────────────────────┐
# │ POR QUE EXISTE: em 05/08/2026 eu limpei entre execuções de teste com         │
# │ `DELETE FROM ops.kickoff_registro` — sem WHERE, contra a produção. Apagou 17  │
# │ registros que o time de Operações havia acabado de preencher.               │
# │                                                                            │
# │ O erro não foi de conhecimento: eu sabia que a base era a de produção. Foi   │
# │ de PROCESSO — o comando destrutivo era mais curto de escrever que o seguro.  │
# │ Este script inverte isso. A lista de identidades é FECHADA: qualquer e-mail   │
# │ fora dela faz o script recusar, em vez de apagar "só esse também".           │
# └───────────────────────────────────────────────────────────────────────────┘
#
# Uso:  ./limpar-registros-de-teste.sh            (limpa e mostra o que sobrou)
#       ./limpar-registros-de-teste.sh --conferir (só mostra, não toca)
set -euo pipefail

CONTEINER=${PULSE_PG_CONTEINER:-postgres-pulse}
BANCO=${PULSE_PG_BANCO:-pulse}

# Identidades que EU crio em teste. Nenhuma delas é pessoa da Alloyal.
IDENTIDADES_DE_TESTE=(
  'gabriel.absi@alloyal.com.br'
  'luis.rezende@alloyal.com.br'
  'mariana.freitas@alloyal.com.br'
  'ruben.dias@alloyal.com.br'
  'teste@alloyal.com.br'
)

lista_sql=$(printf "'%s'," "${IDENTIDADES_DE_TESTE[@]}")
lista_sql="${lista_sql%,}"

psql() { docker exec -i "$CONTEINER" psql -U postgres -d "$BANCO" -v ON_ERROR_STOP=1 "$@"; }

echo "── quem tem registro no kickoff hoje:"
psql -tAc "SELECT autor_email||' → '||count(*)||' registro(s)'
             FROM ops.kickoff_registro GROUP BY autor_email ORDER BY 1" | sed 's/^/   /'

if [[ "${1:-}" == "--conferir" ]]; then
  exit 0
fi

# ┌───────────────────────────────────────────────────────────────────────────┐
# │ A TRAVA: se houver registro de alguém FORA da lista de teste, o script      │
# │ recusa apagar qualquer coisa sem antes dizer de quem é. Não é para impedir   │
# │ a limpeza — é para a limpeza nunca acontecer às cegas.                      │
# └───────────────────────────────────────────────────────────────────────────┘
DE_GENTE=$(psql -tAc "SELECT count(*) FROM ops.kickoff_registro
                       WHERE autor_email NOT IN ($lista_sql)" | tr -d ' ')
if (( DE_GENTE > 0 )); then
  echo
  echo "ATENÇÃO: $DE_GENTE registro(s) de autor que NÃO é identidade de teste."
  psql -tAc "SELECT '  · '||autor_email||' — '||tipo||' — '||left(coalesce(dados->>'dor', dados->>'nome',
                     dados->>'campo', dados->>'titulo', dados->>'metrica', '(sem rótulo)'), 60)
               FROM ops.kickoff_registro WHERE autor_email NOT IN ($lista_sql)
              ORDER BY autor_email LIMIT 40" | sed 's/^/   /'
  echo
  echo "Estes NÃO serão tocados. Prosseguindo só com as identidades de teste."
fi

# O gatilho da 0027 recusa DELETE. Aqui a intenção é apagar de verdade — registro de
# identidade que não existe não deve virar linha inativa acumulando no banco — então a
# declaração é explícita, por transação, como a migration exige.
# `grep` do número e não `head -1`: com várias instruções, o psql imprime também
# "BEGIN" e "COMMIT", e o `head -1` pegava a palavra em vez da contagem.
APAGADOS=$(psql -tAc "BEGIN;
  SET LOCAL pulse.banco_descartavel = 'sim';
  WITH ido AS (
    DELETE FROM ops.kickoff_registro
     WHERE autor_email IN ($lista_sql)
    RETURNING 1
  ) SELECT count(*) FROM ido;
  COMMIT;" | tr -d ' ' | grep -E '^[0-9]+$' | head -1)

echo
echo "removidos: $APAGADOS registro(s) de identidade de teste"
psql -tAc "SELECT 'ficaram: '||count(*)||' registro(s) de '||count(DISTINCT autor_email)||' autor(es)'
             FROM ops.kickoff_registro" | sed 's/^/   /'
