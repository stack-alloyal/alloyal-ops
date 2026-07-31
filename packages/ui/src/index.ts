/**
 * @ops/ui — design system do Alloyal Ops.
 *
 * Doc 00, seção 9. Os tokens e os componentes base são os MESMOS do
 * alloyal-publi — ver `estilo.css` e `base.tsx`. Divergir do Publi exige anotar
 * o porquê no próprio arquivo.
 *
 * Este pacote é consumido como FONTE, via `transpilePackages` do Next, e por
 * isso resolve módulos como bundler — sem a extensão `.js` nos imports. Os
 * pacotes de servidor (@ops/metrics, @ops/db, @ops/auth, @ops/contracts) são
 * NodeNext e exigem a extensão. As duas convenções coexistem de propósito: cada
 * uma é a correta para o seu alvo.
 */
export * from './base'
export * from './AlloyalLogo'
export * from './Metric'
export * from './Vazio'
export * from './RelatorioCliente'
