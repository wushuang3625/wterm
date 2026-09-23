import type { SshProfile } from "./main";

/** Reuse only the same server account. Display aliases are not identities. */
export function sameSshAccount(a: SshProfile, b: SshProfile): boolean {
  const host = (value: string) => value.trim().replace(/^\[|\]$/g, "").toLowerCase();
  return host(a.host) === host(b.host) && a.port === b.port && a.username === b.username && (a.proxy_jump?.trim() || "none") === (b.proxy_jump?.trim() || "none");
}
