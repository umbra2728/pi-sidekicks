import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type ChildSessionOptions, createChildSession, type ThinkingLevel } from "./child.ts";
import { lastAssistantOutcome } from "./format.ts";

export type AgentStatus = "queued" | "running" | "done" | "failed" | "stopped";

export interface AgentRecord {
  id: string;
  task: string;
  model: Model<any> | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  cwd: string;
  status: AgentStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  activity?: string;
  tokens: number;
  cost: number;
  result?: string;
  error?: string;
  session?: AgentSession;
  pendingPrompt: string;
  stopRequested: boolean;
}

export interface ManagerHooks {
  onChange(): void;
  onSettled(record: AgentRecord): void;
}

const RETAINED_SESSIONS = 8;

export class AgentManager {
  private readonly records = new Map<string, AgentRecord>();
  private readonly queue: string[] = [];
  private nextId = 1;
  private running = 0;
  private disposed = false;
  private readonly maxConcurrent: number;
  private readonly hooks: ManagerHooks;

  constructor(maxConcurrent: number, hooks: ManagerHooks) {
    this.maxConcurrent = maxConcurrent;
    this.hooks = hooks;
  }

  list(): AgentRecord[] {
    return [...this.records.values()];
  }

  get(id: string): AgentRecord {
    const record = this.records.get(id.trim());
    if (!record) throw new Error(`No subagent "${id}".`);
    return record;
  }

  spawn(task: string, options: ChildSessionOptions): AgentRecord {
    const record: AgentRecord = {
      id: `a${this.nextId++}`,
      task,
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      cwd: options.cwd,
      status: "queued",
      createdAt: Date.now(),
      tokens: 0,
      cost: 0,
      pendingPrompt: task,
      stopRequested: false,
    };
    this.records.set(record.id, record);
    this.enqueue(record);
    return record;
  }

  async message(id: string, text: string): Promise<"steered" | "queued" | "continued"> {
    const record = this.get(id);
    if (record.status === "running" && record.session) {
      await record.session.steer(text);
      return "steered";
    }
    if (record.status === "queued" || record.status === "running") {
      record.pendingPrompt = `${record.pendingPrompt}\n\n${text}`;
      return "queued";
    }
    if (!record.session) throw new Error(`Subagent ${id} has no live session to continue.`);
    record.pendingPrompt = text;
    record.stopRequested = false;
    record.result = undefined;
    record.error = undefined;
    record.status = "queued";
    this.enqueue(record);
    return "continued";
  }

  async stop(id: string): Promise<AgentRecord> {
    const record = this.get(id);
    if (record.status === "queued") {
      this.queue.splice(this.queue.indexOf(record.id), 1);
      this.settle(record, "stopped");
      return record;
    }
    if (record.status === "running") {
      record.stopRequested = true;
      await record.session?.abort();
    }
    return record;
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    for (const record of this.records.values()) {
      record.stopRequested = true;
      record.session?.dispose();
      record.session = undefined;
    }
  }

  private enqueue(record: AgentRecord): void {
    this.queue.push(record.id);
    this.hooks.onChange();
    this.drain();
  }

  private drain(): void {
    while (!this.disposed && this.running < this.maxConcurrent && this.queue.length > 0) {
      const record = this.records.get(this.queue.shift()!);
      if (!record || record.status !== "queued") continue;
      this.running++;
      void this.run(record).finally(() => {
        this.running--;
        this.drain();
      });
    }
  }

  private async run(record: AgentRecord): Promise<void> {
    record.status = "running";
    record.startedAt = Date.now();
    record.endedAt = undefined;
    record.activity = "starting";
    this.hooks.onChange();

    let unsubscribe = () => {};
    try {
      record.session ??= await createChildSession({
        cwd: record.cwd,
        model: record.model,
        thinkingLevel: record.thinkingLevel,
      });
      const session = record.session;
      if (record.stopRequested || this.disposed) throw new Error("Stopped before start.");
      record.model = session.model;
      unsubscribe = session.subscribe((event) => this.track(record, session, event));

      const prompt = record.pendingPrompt;
      record.pendingPrompt = "";
      const messageStart = session.messages.length;
      await session.prompt(prompt);
      while (record.pendingPrompt && !record.stopRequested && !this.disposed) {
        const followUp = record.pendingPrompt;
        record.pendingPrompt = "";
        await session.prompt(followUp);
      }

      const outcome = lastAssistantOutcome(session.messages.slice(messageStart));
      this.refreshUsage(record, session);
      if (record.stopRequested) {
        record.result = outcome.text || undefined;
        this.settle(record, "stopped");
      } else if (outcome.stopReason === "error" || (outcome.error && !outcome.text)) {
        record.error = outcome.error ?? "Model error";
        this.settle(record, "failed");
      } else {
        record.result = outcome.text || "(no output)";
        this.settle(record, "done");
      }
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      this.settle(record, record.stopRequested ? "stopped" : "failed");
    } finally {
      unsubscribe();
      if (this.disposed) {
        record.session?.dispose();
        record.session = undefined;
      }
    }
  }

  private track(record: AgentRecord, session: AgentSession, event: { type: string; toolName?: string }): void {
    if (event.type === "tool_execution_start") record.activity = event.toolName;
    else if (event.type === "message_update") record.activity = "thinking";
    else if (event.type === "message_end" || event.type === "turn_end") this.refreshUsage(record, session);
    else return;
    this.hooks.onChange();
  }

  private refreshUsage(record: AgentRecord, session: AgentSession): void {
    const stats = session.getSessionStats();
    record.tokens = stats.tokens.total;
    record.cost = stats.cost;
  }

  private settle(record: AgentRecord, status: AgentStatus): void {
    record.status = status;
    record.endedAt = Date.now();
    record.activity = undefined;
    this.releaseOldSessions();
    this.hooks.onChange();
    if (!this.disposed) this.hooks.onSettled(record);
  }

  private releaseOldSessions(): void {
    const settled = this.list()
      .filter((record) => record.session && record.status !== "running" && record.status !== "queued")
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    for (const record of settled.slice(RETAINED_SESSIONS)) {
      record.session?.dispose();
      record.session = undefined;
    }
  }
}
