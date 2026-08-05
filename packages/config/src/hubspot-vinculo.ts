/**
 * Classifica o que significa um `hubspot_company_id` aparecer em mais de uma conta.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ MEDIDO NA BASE REAL em 05/08/2026, 3.172 contas, 34 ids repetidos. Olhar os │
 * │ dados desfez a premissa: "ambíguo" não era uma coisa, eram SEIS, e só uma    │
 * │ delas pede decisão humana.                                                  │
 * │                                                                            │
 * │  · `hubspot_company_id = '0'` em 2 contas. Zero não é id, é nulo disfarçado. │
 * │  · 14 contas com o CNPJ 26.989.697 — a PRÓPRIA ALLOYAL. São programas        │
 * │    internos apontando para o registro da Alloyal no HubSpot.                │
 * │  · 18 ids em contas que dividem a RAIZ do CNPJ: filiais da mesma empresa.    │
 * │    Uma empresa no HubSpot, várias filiais no core — não é conflito.          │
 * │  · 7 ids com exatamente UMA conta ativa e o resto inativo, com nomes como    │
 * │    "(Antigo)" e "(NÃO USAR)". A ativa é a dona; as outras são histórico.     │
 * │  · 2 ids sem nenhuma conta ativa: não há receita para atribuir.              │
 * │  · 5 ids com mais de uma conta ativa em CNPJs diferentes. DESTES, dois são   │
 * │    canal de venda (o nome de todas termina com o mesmo "(Parceiro)") e três  │
 * │    são genuinamente indecidíveis pelo dado.                                 │
 * │                                                                            │
 * │ POR QUE ISTO É FUNÇÃO PURA E NÃO UM `UPDATE` DE UMA VEZ: a carga é diária e  │
 * │ completa. Uma resolução gravada à mão hoje é sobrescrita amanhã pela próxima │
 * │ carga, ou pior, sobrevive desatualizada depois de a conta trocar de estado.  │
 * │ Regra que roda a cada carga não tem esse problema — e testável sem banco.    │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

/** Uma conta, no mínimo que a classificação precisa. */
export interface ContaParaVinculo {
  readonly brandId: string;
  readonly razaoSocial: string;
  readonly cnpj: string;
  readonly ativo: boolean;
}

export type Vinculo =
  /** Uma conta, um id: o caso comum, sem nada a decidir. */
  | "unico"
  /** Filiais da mesma empresa (mesma raiz de CNPJ). */
  | "filial"
  /** Conta da própria Alloyal, não de cliente. */
  | "interna"
  /** A conta ativa entre inativas: é ela que responde pelo id. */
  | "dono"
  /** Conta inativa que dividia o id com a dona. */
  | "historico"
  /** Todas inativas: não há a quem atribuir. */
  | "encerrado"
  /** Canal de venda: o id é do parceiro, e as contas são a carteira dele. */
  | "canal"
  /** Mais de uma ativa, sem padrão no dado. Só uma pessoa decide. */
  | "pendente";

export interface Classificacao {
  readonly brandId: string;
  readonly vinculo: Vinculo;
  readonly motivo: string;
}

/**
 * A raiz do CNPJ: os 8 primeiros dígitos identificam a EMPRESA; os 4 seguintes, a
 * filial. Comparar CNPJ inteiro trataria filial como empresa diferente, que é
 * exatamente o erro que faz 38 contas parecerem conflito.
 */
export function raizDoCnpj(cnpj: string): string {
  return cnpj.replace(/\D/g, "").slice(0, 8);
}

/**
 * O sufixo entre parênteses no fim do nome, minúsculo — é como o canal aparece no
 * cadastro do core: "Barra Net (Playhub)", "Netbox Internet (PLAYHUB)".
 *
 * Devolve string vazia quando não há sufixo. Não tenta adivinhar canal por outra
 * pista: nome é texto livre digitado por gente, e heurística frouxa aqui classificaria
 * empresa diferente como carteira de parceiro — erro que liga receita à conta errada.
 */
export function sufixoEntreParenteses(razaoSocial: string): string {
  const m = /\(([^()]{2,40})\)\s*$/.exec(razaoSocial.trim());
  return m ? m[1]!.trim().toLowerCase() : "";
}

/**
 * Reduz um nome a algo comparável: minúsculo, sem acento, sem pontuação, um espaço.
 *
 * Serve para reconhecer o parceiro quando A CONTA DELE está no mesmo grupo — "ABR
 * DIGITAL" e o sufixo "(ABR Digital)" são a mesma coisa escrita de dois jeitos.
 */
export function nomeComparavel(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Um id do HubSpot é um inteiro positivo. `'0'`, `''` e qualquer coisa não numérica
 * são ausência de vínculo, e tratá-los como id junta contas que nada têm em comum.
 */
export function ehIdDeHubspotValido(id: string | null | undefined): boolean {
  return typeof id === "string" && /^[1-9]\d*$/.test(id.trim());
}

/**
 * Classifica as contas que dividem UM `hubspot_company_id`.
 *
 * `cnpjRaizDaAlloyal` vem da configuração e não é cravado aqui: o dia em que a Alloyal
 * mudar de CNPJ, um número escondido no código faria 14 contas internas voltarem a
 * contar como cliente sem ninguém entender por quê.
 */
export function classificarVinculo(
  hubspotCompanyId: string,
  contas: readonly ContaParaVinculo[],
  cnpjRaizDaAlloyal: string,
): Classificacao[] {
  const marca = (vinculo: Vinculo, motivo: string): Classificacao[] =>
    contas.map((c) => ({ brandId: c.brandId, vinculo, motivo }));

  if (!ehIdDeHubspotValido(hubspotCompanyId)) {
    // Não entra em `core.account_hubspot`; quem chama descarta.
    return marca(
      "pendente",
      `"${hubspotCompanyId}" não é id do HubSpot (id é inteiro positivo)`,
    );
  }

  if (contas.length === 1) {
    return marca("unico", "um id, uma conta");
  }

  const raizes = new Set(contas.map((c) => raizDoCnpj(c.cnpj)));
  const raizAlloyal = cnpjRaizDaAlloyal.replace(/\D/g, "").slice(0, 8);

  if (raizAlloyal && contas.some((c) => raizDoCnpj(c.cnpj) === raizAlloyal)) {
    return marca(
      "interna",
      `conta da própria Alloyal (CNPJ ${raizAlloyal}) — fora de métrica de cliente`,
    );
  }

  if (raizes.size === 1) {
    return marca(
      "filial",
      `${contas.length} filiais do CNPJ ${[...raizes][0]} — uma empresa, não um conflito`,
    );
  }

  const ativas = contas.filter((c) => c.ativo);

  if (ativas.length === 0) {
    return marca(
      "encerrado",
      "nenhuma conta ativa — não há receita a atribuir",
    );
  }

  if (ativas.length === 1) {
    const dona = ativas[0]!;
    return contas.map((c) => ({
      brandId: c.brandId,
      vinculo: c.ativo ? ("dono" as const) : ("historico" as const),
      motivo: c.ativo
        ? `única conta ativa entre ${contas.length} — responde pelo id`
        : `inativa; o id responde por ${dona.brandId} (${dona.razaoSocial})`,
    }));
  }

  // Mais de uma ativa. Canal de venda tem uma assinatura clara: TODAS as contas com
  // sufixo entre parênteses, e o MESMO sufixo em todas.
  const sufixos = contas.map((c) => sufixoEntreParenteses(c.razaoSocial));
  const todosComSufixo = sufixos.every((s) => s !== "");
  const umSoSufixo = new Set(sufixos).size === 1;
  if (todosComSufixo && umSoSufixo) {
    return marca(
      "canal",
      `carteira do canal "${sufixos[0]}" — o id é do parceiro, não de um cliente`,
    );
  }

  // ┌───────────────────────────────────────────────────────────────────────────┐
  // │ O MESMO CANAL, mas com a conta DO PARCEIRO no grupo. Foi o caso da ABR       │
  // │ DIGITAL: uma conta chamada "ABR DIGITAL" e outra "Escola Modelar Cambaúba    │
  // │ (ABR Digital)". A regra acima exige sufixo em TODAS e não pega este — e ficar │
  // │ pendente aqui manda uma pessoa decidir algo que o dado já diz.               │
  // │                                                                            │
  // │ A condição é estreita de propósito: existe UM sufixo entre as contas, e a    │
  // │ conta sem sufixo tem o NOME igual a esse sufixo. Sem essa igualdade, "share  │
  // │ uma palavra no nome" juntaria empresas sem relação nenhuma.                  │
  // └───────────────────────────────────────────────────────────────────────────┘
  const sufixosDistintos = new Set(sufixos.filter((x) => x !== ""));
  if (sufixosDistintos.size === 1) {
    const canal = [...sufixosDistintos][0]!;
    const semSufixo = contas.filter((_, i) => sufixos[i] === "");
    const todasSemSufixoSaoOCanal =
      semSufixo.length > 0 &&
      semSufixo.every(
        (c) => nomeComparavel(c.razaoSocial) === nomeComparavel(canal),
      );
    if (todasSemSufixoSaoOCanal) {
      return contas.map((c, i) => ({
        brandId: c.brandId,
        vinculo: "canal" as const,
        motivo:
          sufixos[i] === ""
            ? `é o próprio canal "${canal}" — o id do HubSpot é dele`
            : `carteira do canal "${canal}" — o id é do parceiro, não de um cliente`,
      }));
    }
  }

  return marca(
    "pendente",
    `${ativas.length} contas ativas em CNPJs diferentes e sem padrão no dado — precisa de decisão`,
  );
}

/** Só o que precisa de gente. É este número que vale numa tela. */
export function precisaDeDecisao(cs: readonly Classificacao[]): boolean {
  return cs.some((c) => c.vinculo === "pendente");
}
