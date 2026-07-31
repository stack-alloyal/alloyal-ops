import 'server-only'

import { notFound } from 'next/navigation'

/**
 * Valida o formato do id ANTES de consultar.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ O pen test achou 500 em `/contas/' OR 1=1--`. Não havia injeção — a consulta │
 * │ é parametrizada e o Postgres recusou o cast para `uuid`. Mas o 500 é errado  │
 * │ por dois motivos:                                                          │
 * │                                                                            │
 * │   1. Ruído de monitoramento. Um 500 que qualquer URL torta provoca é um 500 │
 * │      que ninguém investiga — e é no meio dele que o 500 de verdade passa.   │
 * │   2. Oráculo. 500 para id malformado e 404 para id válido-mas-inexistente   │
 * │      dizem ao atacante que a entrada chegou até o banco.                    │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * `notFound()` e não `forbidden()`: um id que não é sequer um uuid não identifica
 * registro nenhum, e "sem permissão" afirmaria que existe algo do outro lado.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function uuidOu404(valor: string): string {
  if (!UUID.test(valor)) notFound()
  return valor
}

/**
 * Chave de playbook: minúsculas, dígitos e hífen.
 *
 * Não é uuid, mas tem formato — e validar aqui poupa a consulta e mantém a mesma
 * resposta (404) que um id inexistente daria.
 */
const CHAVE = /^[a-z0-9-]{1,60}$/

export function chaveOu404(valor: string): string {
  if (!CHAVE.test(valor)) notFound()
  return valor
}
