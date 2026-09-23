import { invoke } from "@tauri-apps/api/core";

interface KnownHostEntry {
  line: number;
  hosts: string;
  algorithm: string;
  fingerprint: string;
  comment: string;
}
interface KnownHostsFile { path: string; entries: KnownHostEntry[]; }

export async function showKnownHostsManager(): Promise<void> {
  const mask = document.createElement("div");
  mask.className = "dialog-mask";
  const dialog = document.createElement("div");
  dialog.className = "dialog known-hosts-dialog";
  const title = document.createElement("h2"); title.textContent = "已知 SSH 主机";
  const path = document.createElement("div"); path.className = "known-hosts-path";
  const list = document.createElement("div"); list.className = "known-hosts-list";
  const footer = document.createElement("div"); footer.className = "dialog-actions";
  const status = document.createElement("span"); status.className = "dialog-error";
  const close = document.createElement("button"); close.className = "btn"; close.textContent = "关闭";
  footer.append(status, close); dialog.append(title, path, list, footer); mask.append(dialog); document.body.append(mask);

  const refresh = async () => {
    status.textContent = "";
    list.replaceChildren();
    try {
      const data = await invoke<KnownHostsFile>("list_known_hosts");
      path.textContent = data.path;
      if (!data.entries.length) {
        const empty = document.createElement("div"); empty.className = "favorites-empty"; empty.textContent = "known_hosts 中暂无条目"; list.append(empty); return;
      }
      for (const entry of data.entries) {
        const row = document.createElement("div"); row.className = "known-host-row";
        const meta = document.createElement("div"); meta.className = "known-host-meta";
        const host = document.createElement("div"); host.className = "known-host-name"; host.textContent = entry.hosts;
        const algo = document.createElement("div"); algo.className = "known-host-detail"; algo.textContent = entry.algorithm + (entry.comment ? " · " + entry.comment : "");
        const fp = document.createElement("code"); fp.textContent = entry.fingerprint;
        meta.append(host, algo, fp);
        const remove = document.createElement("button"); remove.className = "btn known-host-remove"; remove.textContent = "删除";
        remove.onclick = async () => {
          if (!confirm("确认从 known_hosts 删除该主机密钥？\n\n" + entry.hosts + "\n" + entry.fingerprint)) return;
          remove.disabled = true;
          try { await invoke("remove_known_host", { line: entry.line }); await refresh(); }
          catch (error) { status.textContent = String(error); remove.disabled = false; }
        };
        row.append(meta, remove); list.append(row);
      }
    } catch (error) { status.textContent = String(error); }
  };
  close.onclick = () => mask.remove();
  mask.onclick = event => { if (event.target === mask) mask.remove(); };
  await refresh();
}
