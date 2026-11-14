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
  // SQL that never sets live behaviour: undo scripts, schema dumps, ad-hoc scripts and seed data
  ':!**/*.down.sql', ':!**/rollback/**/*.sql', ':!**/*schema_reference*.sql', ':!**/scripts/*.sql', ':!**/seed*.sql',
];

// `:!**/x` in git's default pathspec mode needs a slash before `x`, so it misses a file at the repository root.
// The glob form lets `**/` match zero directories.
const toPathspec = (p: string) => `:(exclude,glob)${p.slice(2)}`;
/** The built-in excludes, as git pathspecs. */
export const DEFAULT_EXCLUDE = PATTERNS.map(toPathspec);

let active = DEFAULT_EXCLUDE;

/**
 * Set the excludes for this run. `extra` globs (for example `legacy/**`) add to the defaults.
 * With `keepDefaults: false` only `extra` applies. A glob is a git glob pathspec without the `:!` prefix.
 */
export function configureExcludes(extra: string[] = [], keepDefaults = true): void {
  const added = extra.map((g) => toPathspec(`:!${g.replace(/^:!/, '')}`));
  active = keepDefaults ? [...DEFAULT_EXCLUDE, ...added] : added;
}

/** The excludes in force now. Read it at the point of use, not at import time. */
export const currentExclude = (): string[] => active;
