// Data-plane sibling of packages/control-plane/src/audit-log.ts; duplicated because
// control-plane is not a harness dep today.

export type AuditLog = (line: Record<string, unknown>) => void;

export const defaultAuditLog: AuditLog = (line) => console.log(JSON.stringify(line));
