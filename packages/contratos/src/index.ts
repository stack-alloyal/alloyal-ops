/**
 * @ops/contratos — o domínio da ferramenta 2 (CLM).
 *
 * O que mora aqui é a taxonomia de cláusulas com a audiência declarada, e o ciclo
 * de vida da cláusula: propor, confirmar com procedência, substituir por aditivo.
 *
 * Fora do app Next pelo mesmo motivo de `@ops/success`: a regra de quem lê o quê é
 * lógica, não casca de tela, e é testável contra Postgres real sem subir nada.
 */

export * from './taxonomia.js'
export * from './clausula.js'
