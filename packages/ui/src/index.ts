/**
 * @ops/ui — design system do Alloyal Ops.
 *
 * Doc 00, seção 9.
 *
 * Este pacote é consumido como FONTE, via `transpilePackages` do Next, e por
 * isso resolve módulos como bundler — sem a extensão `.js` nos imports. Os
 * pacotes de servidor (@ops/metrics, @ops/db, @ops/auth, @ops/contracts) são
 * NodeNext e exigem a extensão. As duas convenções coexistem de propósito: cada
 * uma é a correta para o seu alvo.
 */
export * from './Metric'
export * from './Vazio'
