import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Exercises the built guard, which `npm install` produces via `prepare`.
const built = join(process.cwd(), 'dist', 'utils', 'writeGuard.js');
const skip = existsSync(built) ? false : 'dist not built; run `npm run build` first';

const ENV_KEYS = ['SFDC_ALLOWED_WRITES', 'SFDC_ALLOW_ADMIN_WRITES', 'SFDC_EXPECTED_ORG_ID'];

// Runs fn with exactly the given guard env vars set, then restores the originals.
async function withEnv(env, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    const guard = await import('../dist/utils/writeGuard.js');
    guard.resetOrgVerification();
    return await fn(guard);
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function fakeConn(orgId) {
  const conn = {
    calls: 0,
    identity: async () => {
      conn.calls += 1;
      if (orgId instanceof Error) throw orgId;
      return { organization_id: orgId };
    }
  };
  return conn;
}

// --- DML allowlist ---------------------------------------------------------

test('DML is refused when SFDC_ALLOWED_WRITES is unset', { skip }, () =>
  withEnv({}, ({ assertDmlAllowed }) => {
    assert.throws(() => assertDmlAllowed('Task', 'insert'), /SFDC_ALLOWED_WRITES is not set/);
  }));

test('DML is refused when SFDC_ALLOWED_WRITES is empty', { skip }, () =>
  withEnv({ SFDC_ALLOWED_WRITES: ' ' }, ({ assertDmlAllowed }) => {
    assert.throws(() => assertDmlAllowed('Task', 'insert'), /SFDC_ALLOWED_WRITES is not set/);
  }));

test('Task:insert permits Task insert only', { skip }, () =>
  withEnv({ SFDC_ALLOWED_WRITES: 'Task:insert' }, ({ assertDmlAllowed }) => {
    assert.doesNotThrow(() => assertDmlAllowed('Task', 'insert'));
    assert.throws(() => assertDmlAllowed('Task', 'update'), /update on Task is not permitted/);
    assert.throws(() => assertDmlAllowed('Task', 'delete'), /not permitted/);
    assert.throws(() => assertDmlAllowed('Task', 'upsert'), /not permitted/);
    assert.throws(() => assertDmlAllowed('Account', 'insert'), /insert on Account is not permitted/);
    assert.throws(() => assertDmlAllowed('Opportunity', 'insert'), /not permitted/);
  }));

test('object and operation matching is case-insensitive', { skip }, () =>
  withEnv({ SFDC_ALLOWED_WRITES: 'MOM__c:Insert' }, ({ assertDmlAllowed }) => {
    assert.doesNotThrow(() => assertDmlAllowed('mom__c', 'insert'));
    assert.doesNotThrow(() => assertDmlAllowed('MOM__C', 'INSERT'));
  }));

test('several entries combine', { skip }, () =>
  withEnv({ SFDC_ALLOWED_WRITES: 'Task:insert, Task:upsert ,Event:insert' }, ({ assertDmlAllowed }) => {
    assert.doesNotThrow(() => assertDmlAllowed('Task', 'insert'));
    assert.doesNotThrow(() => assertDmlAllowed('Task', 'upsert'));
    assert.doesNotThrow(() => assertDmlAllowed('Event', 'insert'));
    assert.throws(() => assertDmlAllowed('Event', 'update'), /not permitted/);
  }));

test('malformed SFDC_ALLOWED_WRITES entries refuse every write', { skip }, async () => {
  for (const bad of ['Task', 'Task:merge', ':insert', 'Task:insert:extra']) {
    await withEnv({ SFDC_ALLOWED_WRITES: bad }, ({ assertDmlAllowed }) => {
      assert.throws(() => assertDmlAllowed('Task', 'insert'), /Invalid SFDC_ALLOWED_WRITES entry/, bad);
    });
  }
});

// --- Admin tools -----------------------------------------------------------

test('admin write tools are refused unless SFDC_ALLOW_ADMIN_WRITES is true', { skip }, async () => {
  for (const value of [undefined, '', 'false', '1', 'yes']) {
    const env = value === undefined ? {} : { SFDC_ALLOW_ADMIN_WRITES: value };
    await withEnv(env, ({ assertAdminWriteAllowed, adminWritesEnabled }) => {
      assert.equal(adminWritesEnabled(), false, String(value));
      assert.throws(() => assertAdminWriteAllowed('salesforce_execute_anonymous'), /is disabled/, String(value));
    });
  }
});

test('SFDC_ALLOW_ADMIN_WRITES=true enables admin write tools', { skip }, async () => {
  for (const value of ['true', 'TRUE', ' true ']) {
    await withEnv({ SFDC_ALLOW_ADMIN_WRITES: value }, ({ assertAdminWriteAllowed, adminWritesEnabled }) => {
      assert.equal(adminWritesEnabled(), true, value);
      assert.doesNotThrow(() => assertAdminWriteAllowed('salesforce_execute_anonymous'));
    });
  }
});

test('every tool that can bypass the allowlist is classed as an admin write tool', { skip }, () =>
  withEnv({}, ({ ADMIN_WRITE_TOOLS }) => {
    for (const tool of [
      'salesforce_execute_anonymous',
      'salesforce_write_apex',
      'salesforce_write_apex_trigger',
      'salesforce_manage_object',
      'salesforce_manage_field',
      'salesforce_manage_field_permissions'
    ]) {
      assert.ok(ADMIN_WRITE_TOOLS.includes(tool), tool);
    }
    assert.ok(!ADMIN_WRITE_TOOLS.includes('salesforce_dml_records'));
  }));

// --- Org pin ---------------------------------------------------------------

test('org pin is skipped when SFDC_EXPECTED_ORG_ID is unset', { skip }, () =>
  withEnv({}, async ({ assertExpectedOrg }) => {
    const conn = fakeConn('00DOTHER000000000');
    await assertExpectedOrg(conn);
    assert.equal(conn.calls, 0);
  }));

test('org pin passes when the 15-char prefix matches an 18-char id', { skip }, () =>
  withEnv({ SFDC_EXPECTED_ORG_ID: '00D5i00000DQioa' }, async ({ assertExpectedOrg }) => {
    await assertExpectedOrg(fakeConn('00D5i00000DQioaEAD'));
  }));

test('org pin refuses a different org', { skip }, () =>
  withEnv({ SFDC_EXPECTED_ORG_ID: '00D5i00000DQioaEAD' }, async ({ assertExpectedOrg }) => {
    await assert.rejects(assertExpectedOrg(fakeConn('00De10000013wq5EAA')), /connected to org 00De10000013wq5EAA/);
  }));

test('org pin refuses when identity fails or returns no org id', { skip }, async () => {
  await withEnv({ SFDC_EXPECTED_ORG_ID: '00D5i00000DQioaEAD' }, async ({ assertExpectedOrg }) => {
    await assert.rejects(assertExpectedOrg(fakeConn(new Error('session expired'))), /could not confirm/);
  });
  await withEnv({ SFDC_EXPECTED_ORG_ID: '00D5i00000DQioaEAD' }, async ({ assertExpectedOrg }) => {
    await assert.rejects(assertExpectedOrg(fakeConn('')), /no organization_id/);
  });
});

test('org pin caches a match but does not reuse it for a different expected org', { skip }, () =>
  withEnv({ SFDC_EXPECTED_ORG_ID: '00D5i00000DQioaEAD' }, async ({ assertExpectedOrg }) => {
    const conn = fakeConn('00D5i00000DQioaEAD');
    await assertExpectedOrg(conn);
    await assertExpectedOrg(conn);
    assert.equal(conn.calls, 1, 'second check should use the cache');

    process.env.SFDC_EXPECTED_ORG_ID = '00De10000013wq5EAA';
    await assert.rejects(assertExpectedOrg(conn), /connected to org 00D5i00000DQioaEAD/);
  }));
