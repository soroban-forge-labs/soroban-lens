// The documentation site (#100), built from the markdown already in the repo.
// srcDir is the repo root and nothing is copied: the module READMEs and docs/
// are the pages, so there is one source for every word. `rewrites` only changes
// where a README is served (README.md -> a directory index), not what it says.
//
// A plain object, not defineConfig(): VitePress runs through a pinned npx, so
// it is not a package this repo can import from.
export default {
  title: 'soroban-lens',
  description: 'A self-hosted indexer and explorer for Soroban contract events.',
  base: process.env.LENS_DOCS_BASE ?? '/soroban-lens/',
  srcDir: '..',
  outDir: './dist',
  srcExclude: [
    '**/node_modules/**',
    '**/dist/**',
    'site/**',
    'fixtures/**',
    'bench/**',
    '.github/**',
    'apps/web/test/**',
    'packages/*/test/**',
    'packages/*/integration/**',
    'docs/adr/template.md',
    // Notes about the screenshots, referring to files that are generated, not committed.
    'docs/assets/**',
  ],
  rewrites: {
    'README.md': 'index.md',
    'packages/:pkg/README.md': 'packages/:pkg/index.md',
    'apps/web/README.md': 'apps/web/index.md',
    'deploy/README.md': 'deploy/index.md',
  },
  // The READMEs link to source files (src/virtual.ts, openapi.json) that are
  // not pages; on GitHub those links work, here they would fail the build.
  ignoreDeadLinks: true,
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    // Built-in local search indexes every page above, module READMEs included.
    search: { provider: 'local' },
    nav: [
      { text: 'Guide', link: '/docs/index-your-first-contract' },
      { text: 'Modules', link: '/packages/ingest/' },
      { text: 'API reference', link: '/api/', target: '_self' },
    ],
    sidebar: [
      {
        text: 'Start here',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Index your first contract', link: '/docs/index-your-first-contract' },
          { text: 'Architecture', link: '/docs/architecture' },
          { text: 'Contributing', link: '/CONTRIBUTING' },
        ],
      },
      {
        text: 'Modules',
        items: [
          { text: '1 · Ingestion & RPC', link: '/packages/ingest/' },
          { text: '2 · Decoding & Storage', link: '/packages/store/' },
          { text: '3 · Query API', link: '/packages/api/' },
          { text: '4 · Web UI', link: '/apps/web/' },
          { text: '5 · CLI', link: '/packages/cli/' },
          { text: '5 · Deployment', link: '/deploy/' },
        ],
      },
      {
        text: 'Operating it',
        items: [
          { text: 'Troubleshooting', link: '/docs/troubleshooting' },
          { text: 'Backup and restore', link: '/docs/backup' },
          { text: 'Metrics', link: '/docs/metrics' },
          { text: 'Typed events', link: '/docs/typed-events' },
          { text: 'Benchmarks', link: '/docs/benchmarks' },
        ],
      },
      { text: 'API reference (OpenAPI)', link: '/api/', target: '_self' },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/soroban-forge-labs/soroban-lens' }],
    editLink: {
      pattern: 'https://github.com/soroban-forge-labs/soroban-lens/edit/main/:path',
    },
  },
};
