// Stdout mirror for audit decisions. Shape matches the supervisor's opts.log for easy future
// consolidation; call sites compose lines from the identifiers-only field whitelist.

export type AuditLog = (line: Record<string, unknown>) => void;

export const defaultAuditLog: AuditLog = (line) => console.log(JSON.stringify(line));
