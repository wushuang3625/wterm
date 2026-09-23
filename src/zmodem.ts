import * as ZModem from "zmodem.js/src/zmodem";
import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";

export interface ZmodemHandler {
  consume(data: Uint8Array): void;
  dispose(): void;
  cancel(): void;
  isActive(): boolean;
}
interface Transfer {
  session: any;
  ended: boolean;
  stopped: Promise<never>;
  reject: (reason: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}
interface Options {
  onState?: (active: boolean) => void;
  restorePointer?: () => void | Promise<void>;
  idleTimeoutMs?: number;
}
const STOPPED = new Error("ZMODEM stopped");

/** Sentry alone owns detection. Protocol lifetime must not depend on unsettled library promises. */
export function createZmodemHandler(term: Terminal, sendData: (data: number[]) => void, options: Options = {}): ZmodemHandler {
  let current: Transfer | null = null;
  let dialogOpen = false;
  let disposed = false;
  const revealPointer = () => Promise.resolve(options.restorePointer?.()).catch(() => {});
  const restore = () => {
    if (disposed) return;
    void revealPointer();
    term.write("\x1b[?25h", () => {
      if (disposed) return;
      if (term.element?.closest(".term-pane")?.classList.contains("active")) {
        term.focus();
        term.refresh(0, term.rows - 1);
      }
    });
  };
  const message = (text: string) => { if (!disposed) term.writeln(`\r\n[ZMODEM] ${text}`); };
  function finish(transfer: Transfer) {
    if (transfer.ended) return;
    transfer.ended = true;
    clearTimeout(transfer.timer);
    transfer.reject(STOPPED);
    if (current === transfer) {
      current = null;
      options.onState?.(false);
      if (!dialogOpen) restore();
    }
  }
  function stop(transfer: Transfer, reason?: string) {
    try { transfer.session.abort(); } catch { /* Still release keyboard and cursor. */ }
    finish(transfer);
    if (reason) message(reason);
  }
  function touch(transfer: Transfer) {
    clearTimeout(transfer.timer);
    transfer.timer = setTimeout(() => stop(transfer, "等待远端超时，传输已终止，可重新输入命令"), options.idleTimeoutMs ?? 120_000);
  }
  function wait<T>(transfer: Transfer, operation: Promise<T>): Promise<T> {
    return Promise.race([operation, transfer.stopped]);
  }
  async function choose<T>(transfer: Transfer, show: () => Promise<T>): Promise<T> {
    dialogOpen = true;
    // Wait for the native cursor to be visible before opening the OS dialog. Do not
    // focus xterm here: doing so can steal focus from (or cover) the native dialog.
    const pending = wait(transfer, revealPointer())
      .then(() => { check(transfer); term.write("\x1b[?25h"); return show(); })
      .finally(() => { dialogOpen = false; restore(); });
    return wait(transfer, pending);
  }
  function check(transfer: Transfer) { if (disposed || transfer.ended) throw STOPPED; }

  async function upload(transfer: Transfer) {
    const session = transfer.session;
    const path = await choose(transfer, () => open({ multiple: false, title: "选择上传文件 (rz)" }));
    check(transfer);
    if (!path) { stop(transfer, "上传已取消"); return; }
    const bytes = new Uint8Array(await wait(transfer, invoke<number[]>("read_local_binary_file", { path })));
    check(transfer);
    const file = await wait<any>(transfer, session.send_offer({ name: path.split(/[/\\]/).pop(), size: bytes.length, mode: 0o644, mtime: new Date() }));
    if (file) {
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        check(transfer);
        file.send(bytes.subarray(offset, offset + 8192));
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      await wait(transfer, file.end());
    }
    // close emits session_end synchronously before resolving: that event releases input.
    await Promise.race([session.close(), transfer.stopped.catch(() => {})]);
    if (!session.aborted()) message(file ? "上传完成" : "远端跳过了文件");
  }

  async function receive(transfer: Transfer) {
    const session = transfer.session;
    session.on("offer", (file: any) => {
      void (async () => {
        const name = String(file.get_details().name).split(/[/\\]/).pop() || "download.bin";
        const path = await choose(transfer, () => save({ defaultPath: name, title: "保存远程文件 (sz)" }));
        check(transfer);
        if (!path) { await wait(transfer, file.skip()); return; }
        const chunks = await wait<any[]>(transfer, file.accept());
        const data: number[] = [];
        for (const chunk of chunks) for (const byte of new Uint8Array(chunk)) data.push(byte);
        if (!disposed) {
          await invoke("write_local_binary_file", { path, data });
          message(`已保存 ${name}`);
        }
      })().catch(error => { if (error !== STOPPED) stop(transfer, `接收失败: ${error}`); });
    });
    session.start();
  }

  const sentry = new (ZModem as any).Sentry({
    to_terminal: (bytes: number[]) => { if (!disposed) term.write(new Uint8Array(bytes)); },
    sender: (bytes: number[]) => {
      if (!disposed) {
        if (current) touch(current);
        sendData(Array.from(bytes));
      }
    },
    on_retract() {},
    on_detect(detection: any) {
      if (disposed || current || dialogOpen) { detection.deny(); return; }
      const session = detection.confirm();
      let reject!: (error: Error) => void;
      const stopped = new Promise<never>((_, r) => { reject = r; });
      void stopped.catch(() => {});
      const transfer: Transfer = { session, stopped, reject, ended: false };
      current = transfer;
      session.on("session_end", () => finish(transfer));
      options.onState?.(true);
      touch(transfer);
      void revealPointer();
      term.write("\x1b[?25h");
      void (session.type === "send" ? upload(transfer) : receive(transfer))
        .catch(error => { if (error !== STOPPED) stop(transfer, `传输失败: ${error}`); });
    },
  });
  return {
    isActive: () => current !== null,
    cancel() {
      if (current) {
        stop(current, "传输已取消");
        sendData([3]); // Interrupt remote rz/sz as well, not just its local protocol parser.
      }
    },
    consume(data) {
      if (disposed) return;
      if (current) touch(current);
      try { sentry.consume(data); }
      catch (error) {
        if (current) stop(current, `协议错误，传输已终止: ${error}`);
        restore();
      }
    },
    dispose() {
      if (current) stop(current);
      disposed = true;
    },
  };
}
