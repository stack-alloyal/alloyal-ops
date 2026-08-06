import assert from "node:assert/strict";
import test from "node:test";

import {
  classificarVinculo,
  ehIdDeHubspotValido,
  nomeComparavel,
  precisaDeDecisao,
  raizDoCnpj,
  sufixoEntreParenteses,
  type ContaParaVinculo,
} from "./hubspot-vinculo.js";

const ALLOYAL = "26989697";
const conta = (
  brandId: string,
  razaoSocial: string,
  cnpj: string,
  ativo = true,
): ContaParaVinculo => ({ brandId, razaoSocial, cnpj, ativo });

test("id do HubSpot é inteiro positivo — zero e vazio são ausência", () => {
  // Estava na base real: 2 contas com hubspot_company_id = '0'. Tratar zero como id
  // junta empresas que nada têm em comum, e a receita de uma vai para a outra.
  assert.equal(ehIdDeHubspotValido("21489878103"), true);
  assert.equal(ehIdDeHubspotValido("0"), false);
  assert.equal(ehIdDeHubspotValido(""), false);
  assert.equal(ehIdDeHubspotValido("  "), false);
  assert.equal(ehIdDeHubspotValido("abc"), false);
  assert.equal(ehIdDeHubspotValido("12.3"), false);
  assert.equal(ehIdDeHubspotValido(null), false);
});

test('a raiz do CNPJ são os 8 primeiros dígitos, e é ela que diz "mesma empresa"', () => {
  assert.equal(raizDoCnpj("26989697000170"), "26989697");
  assert.equal(raizDoCnpj("26.989.697/0001-71"), "26989697");
  // Duas filiais têm CNPJ diferente e MESMA raiz: comparar o CNPJ inteiro faria as 38
  // contas de filial parecerem conflito.
  assert.equal(raizDoCnpj("26989697000170"), raizDoCnpj("26989697000189"));
});

test("o canal é o sufixo entre parênteses no FIM do nome", () => {
  assert.equal(sufixoEntreParenteses("Barra Net (Playhub)"), "playhub");
  assert.equal(sufixoEntreParenteses("Netbox Internet (PLAYHUB)"), "playhub");
  assert.equal(
    sufixoEntreParenteses("Atena PV (Hinova Mobile)"),
    "hinova mobile",
  );
  assert.equal(sufixoEntreParenteses("MG Card"), "");
  // Parêntese no MEIO não é canal — "[Ultramed] Saúde Mais" e nomes com aposto sobrariam
  // classificados como carteira de parceiro.
  assert.equal(sufixoEntreParenteses("Cash (antigo) e Life"), "");
});

test("uma conta para um id não é ambiguidade", () => {
  const r = classificarVinculo(
    "123",
    [conta("1", "Cliente Só", "11111111000100")],
    ALLOYAL,
  );
  assert.equal(r[0]?.vinculo, "unico");
  assert.equal(precisaDeDecisao(r), false);
});

test("as 14 contas da própria Alloyal saem como internas, não como cliente", () => {
  const contas = [
    conta("1252", "Alloyal - ISP Fidelidade", "26989697000170"),
    conta("1778", "Alloyal - Club Loyalty", "26989697000171"),
    conta("3436", "Alloyal - FC", "26989697000190"),
  ];
  const r = classificarVinculo("21489878103", contas, ALLOYAL);
  assert.ok(r.every((x) => x.vinculo === "interna"));
  assert.match(r[0]!.motivo, /própria Alloyal/);
  assert.equal(precisaDeDecisao(r), false);
});

test("o CNPJ da Alloyal vem de fora: sem ele as contas internas não são reconhecidas", () => {
  // O dia em que a Alloyal trocar de CNPJ, um número cravado no código faria 14 contas
  // internas voltarem a contar como cliente sem ninguém entender por quê.
  const contas = [
    conta("1252", "Alloyal - ISP Fidelidade", "26989697000170"),
    conta("1778", "Alloyal - Club Loyalty", "26989697000171"),
  ];
  const semConfig = classificarVinculo("21489878103", contas, "");
  assert.equal(
    semConfig[0]?.vinculo,
    "filial",
    "sem o CNPJ configurado, cai em filial",
  );
  const comConfig = classificarVinculo("21489878103", contas, ALLOYAL);
  assert.equal(comConfig[0]?.vinculo, "interna");
});

test("filiais do mesmo CNPJ são uma empresa — e o motivo diz o CNPJ", () => {
  const r = classificarVinculo(
    "49562099871",
    [
      conta("10", "Rede Matriz", "11222333000100"),
      conta("11", "Rede Filial SP", "11222333000288"),
      conta("12", "Rede Filial RJ", "11222333000377"),
    ],
    ALLOYAL,
  );
  assert.ok(r.every((x) => x.vinculo === "filial"));
  assert.match(r[0]!.motivo, /11222333/);
  assert.equal(precisaDeDecisao(r), false);
});

test("uma só ativa entre inativas: a ativa é a dona, e a inativa APONTA para ela", () => {
  const r = classificarVinculo(
    "19384528407",
    [
      conta("50", "Clube Salt (NÃO USAR)", "40941635813000", false),
      conta("51", "Club Salt", "54404459000180", true),
    ],
    ALLOYAL,
  );
  const dona = r.find((x) => x.brandId === "51");
  const velha = r.find((x) => x.brandId === "50");
  assert.equal(dona?.vinculo, "dono");
  assert.equal(velha?.vinculo, "historico");
  // O motivo da inativa NOMEIA a dona: quem abrir o histórico não precisa cruzar tabela
  // para descobrir para onde a receita foi.
  assert.match(velha!.motivo, /Club Salt/);
  assert.equal(precisaDeDecisao(r), false);
});

test("nenhuma ativa: não há receita a atribuir, e isso não é pendência", () => {
  const r = classificarVinculo(
    "10435018036",
    [
      conta("60", "Cash&Life (Antigo)", "34897481000100", false),
      conta("61", "CASH E LIFE SERVICOS", "44939313000185", false),
    ],
    ALLOYAL,
  );
  assert.ok(r.every((x) => x.vinculo === "encerrado"));
  assert.equal(precisaDeDecisao(r), false);
});

test("canal de venda: todas com o MESMO sufixo entre parênteses", () => {
  const r = classificarVinculo(
    "8128512068",
    [
      conta("1687", "Barra Net (Playhub)", "02884366900016"),
      conta("2174", "LINK NET INFORMATICA  - (PlayHub)", "09178684000190"),
      conta("1846", "Netbox Internet (PLAYHUB)", "25356470000113"),
    ],
    ALLOYAL,
  );
  assert.ok(r.every((x) => x.vinculo === "canal"));
  assert.match(r[0]!.motivo, /playhub/);
  // Canal NÃO é pendência: o vínculo N:1 é o certo, e forçar um dono ligaria a receita
  // do parceiro a um cliente da carteira dele.
  assert.equal(precisaDeDecisao(r), false);
});

test("sufixos DIFERENTES não são canal — viram pendência", () => {
  const r = classificarVinculo(
    "999",
    [
      conta("70", "Empresa A (Canal X)", "11111111000100"),
      conta("71", "Empresa B (Canal Y)", "22222222000100"),
    ],
    ALLOYAL,
  );
  assert.ok(r.every((x) => x.vinculo === "pendente"));
});

test("mais de uma ativa em CNPJs diferentes e sem padrão: PENDENTE, não palpite", () => {
  const r = classificarVinculo(
    "22496123939",
    [
      conta("80", "Ben Mais Familiar", "39349079000104"),
      conta("81", "Brasil Medicina Saúde Preventiva", "47767552000193"),
    ],
    ALLOYAL,
  );
  assert.ok(r.every((x) => x.vinculo === "pendente"));
  assert.match(r[0]!.motivo, /decisão/);
  assert.equal(precisaDeDecisao(r), true);
});

test("id inválido é pendência com a razão dita, e nunca vira vínculo", () => {
  const r = classificarVinculo(
    "0",
    [
      conta("90", "MEGA PROTEGE", "45671639000137"),
      conta("91", "ASSOCIACAO DE SOCORRO", "55115358000151"),
    ],
    ALLOYAL,
  );
  assert.ok(r.every((x) => x.vinculo === "pendente"));
  assert.match(r[0]!.motivo, /não é id do HubSpot/);
});

test("interna vence filial: as contas da Alloyal também dividem a raiz do CNPJ", () => {
  // A ordem das regras importa. Se `filial` fosse testada antes, as 14 contas internas
  // sairiam como filiais e entrariam na contagem de cliente.
  const r = classificarVinculo(
    "21489878103",
    [
      conta("1252", "Alloyal - ISP Fidelidade", "26989697000170"),
      conta("1778", "Alloyal - Club Loyalty", "26989697000171"),
    ],
    ALLOYAL,
  );
  assert.equal(r[0]?.vinculo, "interna");
});

test("canal com a conta DO PARCEIRO no grupo — caso ABR DIGITAL", () => {
  // A regra do sufixo em todas não pegava este, e ficar pendente aqui manda uma pessoa
  // decidir algo que o dado já diz.
  const r = classificarVinculo(
    "20555032128",
    [
      conta("100", "ABR DIGITAL", "33175814000116"),
      conta("101", "Escola Modelar Cambaúba (ABR Digital)", "33646449000180"),
    ],
    ALLOYAL,
  );
  assert.ok(r.every((x) => x.vinculo === "canal"));
  // A frase distingue o parceiro da carteira: quem lê precisa saber qual é qual.
  assert.match(r.find((x) => x.brandId === "100")!.motivo, /é o próprio canal/);
  assert.match(r.find((x) => x.brandId === "101")!.motivo, /carteira do canal/);
  assert.equal(precisaDeDecisao(r), false);
});

test("nome parecido NÃO basta: sem igualdade com o sufixo, segue pendente", () => {
  // "share uma palavra no nome" juntaria empresas sem relação nenhuma — é a diferença
  // entre reconhecer um canal e inventar um.
  const r = classificarVinculo(
    "999",
    [
      conta("110", "ABR Serviços Digitais", "33175814000116"),
      conta("111", "Escola Modelar (ABR Digital)", "33646449000180"),
    ],
    ALLOYAL,
  );
  assert.ok(r.every((x) => x.vinculo === "pendente"));
});

test("nomeComparavel ignora acento, caixa e pontuação", () => {
  assert.equal(nomeComparavel("ABR DIGITAL"), "abr digital");
  assert.equal(nomeComparavel("ABR Digital"), "abr digital");
  assert.equal(nomeComparavel("Cambaúba  -  Ltda."), "cambauba ltda");
});

test("duas empresas ativas sem relação no dado continuam PENDENTES", () => {
  // Ultramed e MG Card/MULTIBET: nomes que sugerem relação para um humano e não provam
  // nada para uma regra. Chutar aqui ligaria receita à conta errada.
  const r = classificarVinculo(
    "22496123939",
    [
      conta("120", "Ben Mais Familiar", "39349079000104"),
      conta("121", "Brasil Medicina Saúde Preventiva", "47767552000193"),
    ],
    ALLOYAL,
  );
  assert.ok(r.every((x) => x.vinculo === "pendente"));
});
