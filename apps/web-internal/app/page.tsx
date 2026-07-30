import { Vazio } from '@ops/ui'

/**
 * A tela inicial é TRABALHO A FAZER, não painel (requisito D1).
 *
 * Verificação de aceite: três CSMs identificam a primeira ação em menos de 10
 * segundos. A fila real entra na F2 — e só depois de 14 dias de modo sombra
 * aprovados pela liderança (doc 00, seção 7).
 */
export default function Page() {
  return (
    <section>
      <h1>Minha fila</h1>
      <Vazio
        titulo="A fila entra em operação na Fase 2."
        porque="Os gatilhos precisam de 14 dias em modo sombra, revisados pela liderança de CS, antes de rotear item para alguém. Fila que nasce com centenas de itens não é recuperada."
        acao={{ texto: 'Ver o catálogo de gatilhos', href: '/docs/01-PRD-Alloyal-Success.md' }}
      />
    </section>
  )
}
