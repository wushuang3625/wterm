import { Channel, invoke } from "@tauri-apps/api/core";

interface HostKeyChallenge {
  request_id: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  changed: boolean;
}

export function createHostKeyChannel(endpoint: string) {
  const channel = new Channel<HostKeyChallenge>();
  let dismiss: (() => void) | undefined;
  channel.onmessage = challenge => {
    dismiss?.();
    const dialog = document.createElement("dialog");
    dialog.className = "auth-dialog host-key-dialog";
    const form = document.createElement("form");
    const title = document.createElement("h3");
    title.textContent = challenge.changed ? "SSH 主机密钥已变更" : "确认 SSH 主机密钥";
    const target = document.createElement("div");
    target.className = "auth-endpoint";
    target.textContent = challenge.host ? challenge.host + ":" + challenge.port : endpoint;
    const warning = document.createElement("p");
    warning.className = "auth-instructions";
    warning.textContent = challenge.changed
      ? "known_hosts 中已有同算法密钥，但当前服务器返回了不同密钥。可能是服务器重装，也可能存在中间人攻击。"
      : "这是首次连接到该主机。请核对管理员提供的指纹后再继续。";
    const details = document.createElement("div");
    details.className = "host-key-details";
    const algo = document.createElement("div");
    algo.textContent = `算法：${challenge.algorithm}`;
    const fingerprint = document.createElement("code");
    fingerprint.textContent = challenge.fingerprint;
    details.append(algo, fingerprint);
    const hint = document.createElement("p");
    hint.className = "auth-hint";
    hint.textContent = challenge.changed
      ? "密钥变更时不会自动覆盖 known_hosts。确认原因前建议取消连接。"
      : "“信任并保存”会写入系统 ~/.ssh/known_hosts，后续连接将自动校验。";
    const actions = document.createElement("div");
    actions.className = "dialog-actions auth-actions";
    const reject = document.createElement("button");
    reject.type = "button"; reject.className = "btn"; reject.textContent = "取消连接";
    const once = document.createElement("button");
    once.type = "button"; once.className = "btn"; once.textContent = challenge.changed ? "仅本次继续（风险）" : "仅本次信任";
    actions.append(reject, once);
    let save: HTMLButtonElement | undefined;
    if (!challenge.changed) {
      save = document.createElement("button");
      save.type = "button"; save.className = "btn primary"; save.textContent = "信任并保存";
      actions.append(save);
    }
    form.append(title, target, warning, details, hint, actions);
    let finished = false;
    const finish = (decision: "once" | "save" | null) => {
      if (finished) return;
      finished = true;
      void invoke("respond_ssh_host_key", { requestId: challenge.request_id, decision }).catch(() => {});
      dialog.close();
      dialog.remove();
    };
    dismiss = () => finish(null);
    reject.onclick = () => finish(null);
    once.onclick = () => finish("once");
    if (save) save.onclick = () => finish("save");
    dialog.oncancel = event => { event.preventDefault(); finish(null); };
    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
    reject.focus();
  };
  return { channel, dispose: () => dismiss?.() };
}
