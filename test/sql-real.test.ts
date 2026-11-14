// Runs only when CLAIMCHECK_TEST_PG_URL names a LOCAL scratch database, for example
//   docker run --rm -d -p 127.0.0.1:55988:5432 -e POSTGRES_PASSWORD=x postgres:17
// and a plain role that may create schemas in it (no superuser, CREATEROLE, BYPASSRLS or REPLICATION).
// The stand-in connection in sql.test.ts cannot see the two defects below, so they are pinned here.
import { describe, expect, it } from 'vitest';
import { buildStatements, parseLocalUrl, pgRunner } from '../src/sql';

const url = process.env.CLAIMCHECK_TEST_PG_URL;

describe.skipIf(!url)('sql: a real server', () => {
  const conn = (() => { const c = parseLocalUrl(url ?? ''); if ('error' in c) throw new Error(c.error); return c; })();
  const run = (statements: string[]) => pgRunner(conn)(statements);
  async function query(text: string) {
    const pg = (await import('pg')).default;
    const c = new pg.Client({ host: conn.host, port: conn.port, user: conn.user, password: conn.password, database: conn.database });
    await c.connect();
    try { return (await c.query(text)).rows; } finally { await c.end(); }
  }
  const clean = () => query('drop schema if exists cc_real cascade');

  it('rolls back an ordinary run', async () => {
    await clean();
    const out = await run(['create schema cc_real', 'create table cc_real.t(i int)', 'insert into cc_real.t values (1)']);
    expect(out.status).toBe('pass');
    expect(await query("select 1 from pg_namespace where nspname = 'cc_real'")).toHaveLength(0);
  });

  it('ignores PG* environment variables, which the driver would otherwise read', async () => {
    await clean();
    process.env.PGOPTIONS = '-c default_transaction_read_only=on';
    try {
      const out = await run(['create schema cc_real']);
      expect(out.status).toBe('pass'); // a read-only default would make this crash
    } finally { delete process.env.PGOPTIONS; }
  });

  it('detects a COMMIT hidden behind a comment that ends at a carriage return, and the scanner refuses it first', async () => {
    await clean();
    // the scanner reads the comment as ending at \r: the COMMIT is seen (and dropped), and a ROLLBACK there is refused
    const sql = 'create table a(i int);\n-- note\rcommit;\ninsert into a values (2);';
    expect(buildStatements([{ label: 'm', sql }])).toEqual({ statements: ['create table a(i int);', 'insert into a values (2);'] });
    expect(buildStatements([{ label: 'm', sql: '-- note\rrollback;' }])).toHaveProperty('error');
    // sent raw, as if the scanner had missed it: the probe still notices
    const out = await run(['create schema cc_real', 'create table cc_real.a(i int)', '-- note\rcommit']);
    expect(out.status).toBe('crash');
    expect(out.output).toMatch(/ended the transaction/);
    await clean();
  });

  it('cannot be blinded by a function that shadows the probe through search_path', async () => {
    await clean();
    const shadow = [
      'create schema cc_real',
      'set search_path = cc_real, pg_catalog',
      `do $$ begin execute format('create function cc_real.pg_current_xact_id() returns xid8 language sql as %L', format('select %L::xid8', pg_catalog.pg_current_xact_id()::text)); end $$`,
      'create table cc_real.b(i int)',
      '-- hidden\rcommit',
      'insert into cc_real.b values (43)',
    ];
    expect(buildStatements([{ label: 'm', sql: `${shadow.join(';\n')};` }])).toHaveProperty('error'); // SET search_path is refused
    const out = await run(shadow);
    expect(out.status).toBe('crash');
    expect(out.output).toMatch(/ended the transaction/);
    await clean();
  });
});
