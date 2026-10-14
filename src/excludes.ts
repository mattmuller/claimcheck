// Paths that never hold the code that sets a value: dependencies, build output, generated and
// vendored files, docs, lock files, manifests, snapshots, images, and tests. Git pathspec syntax.
// JSON and YAML configuration files are NOT excluded: they are where many limits live.
const PATTERNS = [
  ':!**/node_modules/**', ':!node_modules/**', ':!**/dist/**', ':!**/build/**', ':!**/out/**', ':!**/.next/**',
  ':!**/coverage/**', ':!**/vendor/**', ':!**/third_party/**', ':!**/.git/**',
  ':!**/*.min.js', ':!**/*.min.css', ':!**/*.map', ':!**/*.bundle.js',
  ':!**/*.md', ':!**/*.mdx', ':!**/*.rst', ':!**/docs/**', ':!**/doc/**',
  ':!**/*.lock', ':!**/package-lock.json', ':!**/pnpm-lock.yaml', ':!**/yarn.lock', ':!**/bun.lockb',
  ':!**/package.json', ':!**/tsconfig*.json', ':!**/jsconfig*.json',
  ':!**/*.snap', ':!**/__snapshots__/**', ':!**/*.svg',
  ':!**/__tests__/**', ':!**/__fixtures__/**', ':!**/__mocks__/**', ':!**/*.test.*', ':!**/*.spec.*',
  ':!**/tests/**', ':!**/test/**', ':!**/spec/**', ':!**/e2e/**',
  ':!**/*.jsonl', ':!**/*.bak', ':!**/*.old',
];

// `:!**/x` in git's default pathspec mode needs a slash before `x`, so it misses a file at the repository root.
// The glob form lets `**/` match zero directories.
export const EXCLUDE = PATTERNS.map((p) => `:(exclude,glob)${p.slice(2)}`);
