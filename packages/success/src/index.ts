/**
 * @ops/success — o domínio da ferramenta de Customer Success.
 *
 * O que mora aqui é a regra que decide o que aparece para quem: o recorte da
 * fila, o modo sombra, o fechamento com desfecho. Está fora do app Next de
 * propósito — é lógica de domínio, testável contra Postgres real sem subir uma
 * tela, e a mesma regra vai servir a uma API antes de servir a um segundo app.
 *
 * O cálculo (drivers, score, gatilhos) fica em `@ops/metrics`; a persistência,
 * em `@ops/db`. Este pacote é a leitura e a escrita que a interface faz.
 */

export * from './fila.js'
export * from './calibracao.js'
export * from './conta.js'
