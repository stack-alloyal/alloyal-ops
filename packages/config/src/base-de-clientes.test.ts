import assert from "node:assert/strict";
import test from "node:test";

import { corDoCliente, iniciaisDoCliente } from "./base-de-clientes.js";

test("as iniciais ignoram o que está entre colchetes e parênteses", () => {
  // Nomes reais da base: "[Ultramed] Saúde Mais", "Barra Net (Playhub)". O colchete e o
  // parêntese carregam canal e apelido — usá-los daria "US" e "BP", que não identificam
  // ninguém.
  assert.equal(iniciaisDoCliente("[Ultramed] Saúde Mais"), "SM");
  assert.equal(iniciaisDoCliente("Barra Net (Playhub)"), "BN");
});

test("as iniciais pulam partícula e sufixo societário", () => {
  assert.equal(iniciaisDoCliente("ASSOCIACAO DE SOCORRO MUTUO"), "AS");
  assert.equal(iniciaisDoCliente("VISTAME COMERCIO LTDA"), "VC");
  assert.equal(iniciaisDoCliente("BIG MIDIA EIRELI"), "BM");
});

test("nome de uma palavra devolve uma letra, e nome vazio não quebra", () => {
  assert.equal(iniciaisDoCliente("MULTIBET"), "M");
  assert.equal(iniciaisDoCliente(""), "?");
  assert.equal(iniciaisDoCliente("   "), "?");
  // Só pontuação: o filtro remove tudo e o retorno não pode ser string vazia, senão o
  // círculo aparece em branco na lista.
  assert.equal(iniciaisDoCliente("--- ///"), "?");
});

test('número no começo do nome conta — "99 AUTO CAR" existe na base', () => {
  assert.equal(iniciaisDoCliente("99 AUTO CAR"), "9A");
});

test("a cor é determinística: o mesmo cliente tem a mesma cor sempre", () => {
  // Cor sorteada faria o cliente mudar de cor a cada render, e a referência visual que a
  // cor existe para dar se perde.
  const a = corDoCliente("c0ffee-1234");
  const b = corDoCliente("c0ffee-1234");
  assert.equal(a, b);
  assert.ok(a >= 0 && a < 360);
});

test("ids diferentes tendem a cores diferentes", () => {
  const cores = new Set(
    ["1252", "1778", "1779", "1780", "1781", "2660", "3436"].map((x) =>
      corDoCliente(x),
    ),
  );
  // Não exijo unicidade absoluta — 360 matizes colidem em algum momento e forçar isso
  // seria um teste frágil. Exijo que a função espalhe.
  assert.ok(cores.size >= 6, `esperava dispersão, veio ${cores.size} cores`);
});
