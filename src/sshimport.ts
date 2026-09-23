import { invoke } from "@tauri-apps/api/core";
import { renderProfiles, showDialog } from "./profiles";
import type { SshProfile } from "./main";

interface ImportedHost {
  alias: string;
  host: string;
  port: number;
  username: string;
  identity_file: string | null;
  proxy_jump?: string | null;
}

const $sel = <T extends HTMLElement>(root: HTMLElement, sel: string) =>
  root.querySelector<T>(sel)!;

/** 侧栏底部「导入 ~/.ssh/config」入口 */
export function showImportDialog(): void {
  const { mask, close } = showDialog(
    "导入 ~/.ssh/config",
    `<div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;">选择要永久保存到快捷列表的 SSH 主机：</div>
    <div id="imp-body" class="imp-body"><div class="imp-loading">正在扫描...</div></div>
    <div class="dialog-actions">
      <span class="dialog-error" id="imp-err"></span>
      <div style="display:flex;gap:8px">
        <button class="btn" id="imp-cancel">取消</button>
        <button class="btn primary" id="imp-ok" disabled>导入选中</button>
      </div>
    </div>`
  );

  const $ = <T extends HTMLElement>(sel: string) => $sel<T>(mask, sel);

  (async () => {
    let hosts: ImportedHost[] = [];
    let existing: SshProfile[] = [];
    try {
      hosts = await invoke<ImportedHost[]>("scan_ssh_config");
      existing = await invoke<SshProfile[]>("list_ssh_profiles");
    } catch (e) {
      $("#imp-body").innerHTML = `<div class="imp-loading">${String(e)}</div>`;
      return;
    }

    if (hosts.length === 0) {
      $("#imp-body").innerHTML =
        `<div class="imp-loading">没有发现可导入的主机。<br/>
         支持 Host / HostName / User / Port / IdentityFile / ProxyJump 字段，
         通配符主机（如 <code>Host *</code>）会被跳过。</div>`;
      return;
    }

    const existNames = new Set(existing.map((p) => p.name));
    const body = $("#imp-body");
    body.innerHTML = hosts
      .map((h, i) => {
        const dup = existNames.has(h.alias);
        return `
        <label class="imp-item${dup ? " dup" : ""}">
          <input type="checkbox" data-idx="${i}" ${dup ? "disabled" : "checked"} />
          <div class="meta">
            <div class="name">${h.alias}${dup ? " <span class='dup-tag'>已存在</span>" : ""}</div>
            <div class="sub">${h.username}@${h.host}:${h.port}${h.identity_file ? " 🔑" : ""}</div>
          </div>
        </label>`;
      })
      .join("");

    const checkboxes = () =>
      [...body.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked")]
        .map((c) => hosts[parseInt(c.dataset.idx!)]);

    const syncBtn = () => {
      ($("#imp-ok") as HTMLButtonElement).disabled = checkboxes().length === 0;
    };
    body.addEventListener("change", syncBtn);
    syncBtn();

    $("#imp-cancel").onclick = close;
    $("#imp-ok").onclick = async () => {
      const picked = checkboxes();
      let ok = 0;
      const errs: string[] = [];
      for (const h of picked) {
        const profile: SshProfile = {
          name: h.alias,
          host: h.host,
          port: h.port,
          username: h.username,
          auth: h.identity_file ? "key" : "agent",
          identity_file: h.identity_file,
          proxy_jump: h.proxy_jump,
        };
        try {
          await invoke("save_ssh_profile", { profile });
          ok++;
        } catch (e) {
          errs.push(`${h.alias}: ${e}`);
        }
      }
      close();
      await renderProfiles();
      if (errs.length > 0) {
        // 有失败项时把错误写进终端区附近的日志即可，这里简单提示
        console.error("导入失败项", errs);
      }
    };
  })();
}
