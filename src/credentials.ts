import { configStorage } from './config-storage';
import { invoke } from "@tauri-apps/api/core";

export type CredentialKind = "password" | "passphrase" | "api_key";

export async function loadCredential(kind: CredentialKind, key: string): Promise<string | undefined> {
  if (!key || configStorage.getItem("wterm_keychain_enabled") === "false") return;
  try {
    return (await invoke<string | null>("credential_get", { kind, key })) ?? undefined;
  } catch (error) {
    console.warn("读取系统凭据失败", error);
    return;
  }
}

export async function saveCredential(kind: CredentialKind, key: string, value: string): Promise<void> {
  if (!key || !value || configStorage.getItem("wterm_keychain_enabled") === "false") return;
  await invoke("credential_set", { kind, key, value });
}

export async function deleteCredential(kind: CredentialKind, key: string): Promise<void> {
  if (!key) return;
  await invoke("credential_delete", { kind, key }).catch(() => {});
}

export function passwordCredentialKey(username: string, host: string, port: number): string {
  return `${username}@${host}:${port}`;
}
