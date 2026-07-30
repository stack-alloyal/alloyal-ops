/**
 * Estado vazio que ENSINA (requisito D5).
 *
 * "Nenhum item na fila" com uma ilustração e ponto final é a forma mais barata
 * de fazer alguém achar que a ferramenta está quebrada. Todo vazio diz três
 * coisas: o que aconteceu, por que, e o que fazer agora.
 */
export interface VazioProps {
  readonly titulo: string
  readonly porque: string
  readonly acao?: { readonly texto: string; readonly href: string }
}

export function Vazio({ titulo, porque, acao }: VazioProps) {
  return (
    <div className="ops-vazio" role="status">
      <p className="ops-vazio__titulo">{titulo}</p>
      <p className="ops-vazio__porque">{porque}</p>
      {acao ? (
        <a className="ops-vazio__acao" href={acao.href}>
          {acao.texto}
        </a>
      ) : null}
    </div>
  )
}
