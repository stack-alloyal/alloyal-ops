/**
 * `@ops/config` — o que o admin muda sem chamar o dev.
 *
 * Três coisas, separadas de propósito: ajuste operacional (legível), segredo de
 * integração (cifrado, nunca devolvido à tela) e papel de pessoa. As três escrevem na
 * mesma trilha `ops.mudanca`, porque "quando isso mudou e por quê" é a pergunta que
 * aparece sempre depois, nunca antes.
 */
export * from './catalogo.js'
export * from './loja.js'
export * from './papeis.js'
