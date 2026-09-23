export type TransferStatus = "queued" | "starting" | "running" | "paused" | "cancelling" | "completed" | "cancelled" | "failed";
export interface TransferInput { sid: string; direction: "upload" | "download"; name: string; local: string; remote: string; overwrite: boolean }
export interface Transfer extends TransferInput { id: string; status: TransferStatus; done: number; total: number; speed: number; error?: string; busy?: boolean }
export interface TransferProgress { id: string; sid: string; done: number; total: number; speed: number }
export interface TransferBackend {
  run(task: Transfer): Promise<number>;
  control(task: Transfer, action: "pause" | "resume" | "cancel"): Promise<void>;
}
export class TransferQueue {
  readonly tasks: Transfer[] = [];
  private active = 0;
  constructor(private backend: TransferBackend, private changed: () => void, private finished: (task: Transfer) => void = () => {}, private concurrency = 2) {}
  add(input: TransferInput): Transfer {
    const task: Transfer = { ...input, id: crypto.randomUUID(), status: "queued", done: 0, total: 0, speed: 0 };
    this.tasks.push(task); this.changed(); this.pump(); return task;
  }
  progress(event: TransferProgress): void {
    const task = this.tasks.find(task => task.id === event.id && task.sid === event.sid);
    if (!task || !["starting", "running", "paused", "cancelling"].includes(task.status)) return;
    task.done = event.done; task.total = event.total; task.speed = event.speed;
    if (task.status === "starting") task.status = "running";
    this.changed();
  }
  async control(id: string, action: "pause" | "resume" | "cancel"): Promise<void> {
    const task = this.tasks.find(task => task.id === id);
    if (!task || task.busy || ["completed", "failed", "cancelled", "cancelling"].includes(task.status)) return;
    if (task.status === "queued") {
      if (action === "cancel") task.status = "cancelled";
      this.changed(); return;
    }
    if (task.status === "starting") return;
    task.busy = true; this.changed();
    try {
      await this.backend.control(task, action);
      // Completion can race with a control acknowledgement; never undo a final state.
      if (["running", "paused"].includes(task.status)) {
        task.status = action === "pause" ? "paused" : action === "resume" ? "running" : "cancelling";
        task.error = undefined;
      }
    } catch (error) { task.error = String(error); }
    finally { task.busy = false; this.changed(); }
  }
  retry(id: string): Transfer | undefined {
    const task = this.tasks.find(task => task.id === id);
    if (!task || !["failed", "cancelled"].includes(task.status)) return;
    return this.add({ sid: task.sid, direction: task.direction, name: task.name, local: task.local, remote: task.remote, overwrite: true });
  }
  cancelSession(sid: string): void {
    for (const task of this.tasks.filter(task => task.sid === sid)) {
      if (task.status === "queued") task.status = "cancelled";
      else if (["running", "paused"].includes(task.status)) void this.control(task.id, "cancel");
    }
    this.changed();
  }
  clearFinished(sid?: string): void {
    for (let i = this.tasks.length - 1; i >= 0; i--) if ((!sid || this.tasks[i].sid === sid) && ["completed", "cancelled", "failed"].includes(this.tasks[i].status)) this.tasks.splice(i, 1);
    this.changed();
  }
  private pump(): void {
    while (this.active < this.concurrency) {
      const task = this.tasks.find(task => task.status === "queued" && !this.tasks.some(other =>
        ["starting", "running", "paused", "cancelling"].includes(other.status) &&
        (task.direction === "download" ? other.direction === "download" && other.local === task.local :
          other.direction === "upload" && other.sid === task.sid && other.remote === task.remote)));
      if (!task) break;
      this.active++; task.status = "starting"; this.changed();
      void this.execute(task);
    }
  }
  private async execute(task: Transfer): Promise<void> {
    try {
      task.done = await this.backend.run(task); task.status = "completed"; task.error = undefined;
      this.finished(task);
    } catch (error) {
      task.status = task.status === "cancelling" || String(error).includes("传输已取消") ? "cancelled" : "failed";
      task.error = String(error);
    } finally { task.speed = 0; this.active--; this.changed(); this.pump(); }
  }
}
