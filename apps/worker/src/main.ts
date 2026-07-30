/**
 * Worker de ingestão e consolidação.
 *
 * Doc 00, 4.1. Processo separado das superfícies web de propósito: um ciclo
 * noturno de reconciliação de 90 dias não pode competir por event loop com a
 * fila que o CSM está usando.
 *
 * Na Fase 0 ele apenas registra os ciclos e expõe o inventário — a execução
 * entra depois do spike de dados (doc 02, B.2).
 */

import { todosOsCiclos } from './cycle.js'
import './cycles/index.js'

function inventario(): void {
  process.stdout.write(`ciclos declarados: ${todosOsCiclos().length}\n`)
  for (const c of todosOsCiclos()) {
    process.stdout.write(
      `  ${c.id.padEnd(4)} ${c.fase.padEnd(3)} ${c.metodo.padEnd(22)} ${c.agenda ?? 'webhook'}  ${c.descricao}\n`,
    )
  }
}

inventario()
