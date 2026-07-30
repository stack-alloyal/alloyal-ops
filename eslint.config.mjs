// Configuração de lint da plataforma.
//
// Além das regras de estilo, este arquivo implementa o PORTÃO DE FRONTEIRA do CI
// (doc 00, seção 11): as barreiras arquiteturais que precisam falhar o merge, não
// depender de revisão humana. Cada bloco `no-restricted-imports` abaixo existe
// porque a violação correspondente é uma falha de segurança ou de governança de
// dados, não uma preferência de organização.

import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/*.d.ts'],
  },

  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // FRONTEIRA 1 — A superfície do cliente conecta como `ops_portal` e nada mais.
  //
  // Doc 00, 5.4 camada 2 · ADR-017.
  //
  // A defesa primária é o próprio banco: `ops_portal` tem USAGE em exatamente um
  // esquema, então nem um import errado nem uma query solta alcançam `core` ou
  // `metrics`. Esta regra é a segunda linha, e existe para transformar o erro em
  // falha de merge em vez de erro de permissão em produção — que apareceria como
  // um 500 na cara de um cliente.
  //
  // `poolApi` é o alvo nomeado porque é o jeito exato de errar: importar o pool
  // interno dentro do portal, com credencial que não sofre RLS por não ter grant.
  // ─────────────────────────────────────────────────────────────────────────────
  {
    files: ['apps/web-portal/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@ops/db',
              importNames: ['poolApi'],
              message:
                'A superfície do cliente usa poolPortal (papel ops_portal). poolApi é da superfície interna e não sofre a política de tenant (ADR-017).',
            },
          ],
          patterns: [
            {
              group: ['@ops/web-internal*', '../../web-internal/**', '**/modules/**'],
              message:
                'O portal não reusa código de tela interna. Compartilhamento se faz por @ops/ui e @ops/metrics.',
            },
          ],
        },
      ],
    },
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // FRONTEIRA 2 — O dicionário de métricas não importa aplicação.
  //
  // Doc 00, 6.5 / ADR-010. `@ops/metrics` é a única implementação de cada número
  // e é importado pelas duas superfícies, pelo worker, pelo PDF e pelo fechamento.
  // Se ele passar a depender de uma dessas camadas, a dependência inverte e o
  // "um número, uma implementação" se desfaz na primeira necessidade de reuso.
  // ─────────────────────────────────────────────────────────────────────────────
  {
    files: ['packages/metrics/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@ops/web-*', '@ops/worker*', '@ops/ui*', 'next*', 'react*'],
              message:
                'O dicionário de métricas é independente de aplicação e de framework (ADR-010).',
            },
          ],
        },
      ],
    },
  },
)
