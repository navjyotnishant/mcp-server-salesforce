/**
 * Write guard.
 *
 * This server's write surface is one generic tool (salesforce_dml_records) plus
 * several admin tools. The generic tool takes objectName and operation as
 * arguments, so enabling it at the MCP layer enables every object and every
 * operation. The admin tools are worse: salesforce_execute_anonymous runs
 * arbitrary Apex, which can perform DML on any object and therefore routes
 * around any object-level allowlist.
 *
 * This module gates both, and pins the connection to an expected org so a
 * change of Salesforce CLI default org cannot silently retarget writes.
 *
 * Fails closed: with no configuration, no write is permitted.
 *
 * Environment:
 *   SFDC_ALLOWED_WRITES     e.g. "Task:insert" or "Task:insert,Task:upsert"
 *                           Unset or empty: all DML is refused.
 *   SFDC_ALLOW_ADMIN_WRITES "true" to permit schema/Apex/anonymous-Apex tools.
 *                           Unset: those tools are refused and unlisted.
 *   SFDC_EXPECTED_ORG_ID    15- or 18-character org id. When set, every write
 *                           is refused unless the live connection reports it.
 */

export type DmlOp = 'insert' | 'update' | 'delete' | 'upsert';

const DML_OPS: readonly DmlOp[] = ['insert', 'update', 'delete', 'upsert'];

/** Tools that change schema or run arbitrary code. Each can bypass an object allowlist. */
export const ADMIN_WRITE_TOOLS: readonly string[] = [
  'salesforce_manage_object',
  'salesforce_manage_field',
  'salesforce_manage_field_permissions',
  'salesforce_write_apex',
  'salesforce_write_apex_trigger',
  'salesforce_execute_anonymous',
];

export class WriteBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WriteBlockedError';
  }
}

function parseAllowlist(raw: string | undefined): Map<string, Set<DmlOp>> {
  const allow = new Map<string, Set<DmlOp>>();
  for (const entry of (raw ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const parts = entry.split(':');
    if (parts.length !== 2) {
      throw new WriteBlockedError(
        `Invalid SFDC_ALLOWED_WRITES entry "${entry}". Expected "Object:operation", e.g. "Task:insert".`
      );
    }
    const object = parts[0].trim();
    const op = parts[1].trim().toLowerCase();
    if (!object) {
      throw new WriteBlockedError(`Invalid SFDC_ALLOWED_WRITES entry "${entry}": empty object name.`);
    }
    if (!(DML_OPS as readonly string[]).includes(op)) {
      throw new WriteBlockedError(
        `Invalid SFDC_ALLOWED_WRITES entry "${entry}": unknown operation "${parts[1].trim()}". ` +
        `Expected one of ${DML_OPS.join(', ')}.`
      );
    }
    // Salesforce API names are case-insensitive; normalise so mom__c matches MOM__c.
    const key = object.toLowerCase();
    if (!allow.has(key)) allow.set(key, new Set<DmlOp>());
    allow.get(key)!.add(op as DmlOp);
  }
  return allow;
}

function describeAllowlist(allow: Map<string, Set<DmlOp>>): string {
  return [...allow.entries()]
    .map(([object, ops]) => `${object}:${[...ops].sort().join('|')}`)
    .sort()
    .join(', ');
}

export function adminWritesEnabled(): boolean {
  return (process.env.SFDC_ALLOW_ADMIN_WRITES ?? '').trim().toLowerCase() === 'true';
}

/**
 * Refuses an admin write tool unless SFDC_ALLOW_ADMIN_WRITES is exactly "true".
 */
export function assertAdminWriteAllowed(toolName: string): void {
  if (!adminWritesEnabled()) {
    throw new WriteBlockedError(
      `Write blocked: ${toolName} is disabled. It can change schema or run arbitrary Apex, ` +
      `which bypasses SFDC_ALLOWED_WRITES. Set SFDC_ALLOW_ADMIN_WRITES=true to enable it.`
    );
  }
}

/**
 * Refuses a DML operation unless SFDC_ALLOWED_WRITES names that exact object and operation.
 */
export function assertDmlAllowed(objectName: string, operation: string): void {
  const allow = parseAllowlist(process.env.SFDC_ALLOWED_WRITES);
  if (allow.size === 0) {
    throw new WriteBlockedError(
      'Write blocked: SFDC_ALLOWED_WRITES is not set, so all DML is refused. ' +
      'Set it to the objects and operations this server may write, e.g. "Task:insert".'
    );
  }
  const ops = allow.get((objectName ?? '').trim().toLowerCase());
  const op = (operation ?? '').trim().toLowerCase();
  if (!ops || !ops.has(op as DmlOp)) {
    throw new WriteBlockedError(
      `Write blocked: ${operation} on ${objectName} is not permitted. ` +
      `Allowed: ${describeAllowlist(allow)}.`
    );
  }
}

let verifiedOrgId: string | null = null;

/**
 * Pins writes to one org.
 *
 * The Salesforce_CLI connection type resolves whichever org the CLI currently
 * treats as default, so the org behind this server can change without any
 * change to its configuration. When SFDC_EXPECTED_ORG_ID is set, this refuses
 * every write against any other org. Compares on the 15-character prefix, since
 * Salesforce returns both 15- and 18-character forms of the same id.
 */
export async function assertExpectedOrg(conn: any): Promise<void> {
  const expected = (process.env.SFDC_EXPECTED_ORG_ID ?? '').trim();
  if (!expected) return;

  if (verifiedOrgId && verifiedOrgId.slice(0, 15) === expected.slice(0, 15)) return;

  let actual: string;
  try {
    const identity = await conn.identity();
    actual = identity?.organization_id ?? '';
  } catch (error) {
    throw new WriteBlockedError(
      'Write blocked: could not confirm which Salesforce org this connection is for, ' +
      `so the SFDC_EXPECTED_ORG_ID check cannot pass. Cause: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!actual) {
    throw new WriteBlockedError(
      'Write blocked: the Salesforce identity response carried no organization_id, ' +
      'so the SFDC_EXPECTED_ORG_ID check cannot pass.'
    );
  }

  if (actual.slice(0, 15) !== expected.slice(0, 15)) {
    throw new WriteBlockedError(
      `Write blocked: connected to org ${actual}, but SFDC_EXPECTED_ORG_ID is ${expected}. ` +
      'Writes are refused. If the Salesforce CLI default org changed, set it back before retrying.'
    );
  }

  verifiedOrgId = actual;
}

/** Test seam: forget the cached org check. */
export function resetOrgVerification(): void {
  verifiedOrgId = null;
}
