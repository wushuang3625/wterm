import { Channel, invoke } from "@tauri-apps/api/core";
interface Challenge {
  request_id: string;
  endpoint?: string;
  name: string;
  instructions: string;
  prompts: { prompt: string; echo: boolean }[];
}

/** Server prompts are text only; secrets never enter logs or storage. */
export function createAuthChannel(host: string) {
  const channel = new Channel<Challenge>();
  let dismiss: (() => void) | undefined;
  channel.onmessage = (challenge) => {
    dismiss?.();
    const dialog = document.createElement("dialog");
    dialog.className = "auth-dialog";
    const form = document.createElement("form");
    const title = document.createElement("h3");
    title.id = "auth-heading";
    title.textContent = challenge.name || "SSH 身份验证";
    dialog.setAttribute("aria-labelledby", title.id);
    const endpoint = document.createElement("div");
    endpoint.className = "auth-endpoint";
    endpoint.textContent = challenge.endpoint || host;
    const instructions = document.createElement("p");
    instructions.className = "auth-instructions";
    instructions.textContent = challenge.instructions || "请完成服务器要求的身份验证";
    form.append(title, endpoint, instructions);
    const fields = challenge.prompts.map(prompt => {
      const field = document.createElement("div");
      field.className = "field";
      const label = document.createElement("label");
      label.textContent = prompt.prompt;
      const input = document.createElement("input");
      input.type = prompt.echo ? "text" : "password";
      input.autocomplete = /otp|code|验证码/i.test(prompt.prompt) ? "one-time-code" : "off";
      input.spellcheck = false;
      input.id = `auth-field-${form.querySelectorAll("input").length}`;
      label.htmlFor = input.id;
      field.append(label, input);
      form.append(field);
      return input;
    });
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "btn primary";
    submit.textContent = "验证并继续";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn";
    cancel.textContent = "取消连接";
    const hint = document.createElement("p");
    hint.className = "auth-hint";
    hint.textContent = "验证码仅用于本次认证，不会保存。Enter 确认 · Esc 取消";
    const actions = document.createElement("div");
    actions.className = "dialog-actions auth-actions";
    actions.append(cancel, submit);
    form.append(hint, actions);
    let finished = false;
    const finish = (responses: string[] | null) => {
      if (finished) return;
      finished = true;
      void invoke("respond_ssh_auth", { requestId: challenge.request_id, responses }).catch(() => {});
      fields.forEach(field => { field.value = ""; });
      dialog.close();
      dialog.remove();
    };
    dismiss = () => finish(null);
    form.onsubmit = event => { event.preventDefault(); finish(fields.map(field => field.value)); };
    cancel.onclick = () => finish(null);
    dialog.oncancel = event => { event.preventDefault(); finish(null); };
    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
    fields[0]?.focus();
  };
  return { channel, dispose: () => dismiss?.() };
}
