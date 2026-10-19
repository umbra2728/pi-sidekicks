import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { formatCost, formatDuration, formatTokens, oneLine, renderTranscript } from "./format.ts";
import type { AgentManager, AgentRecord, AgentStatus } from "./manager.ts";
import { modelLabel } from "./models.ts";

const RECENT_MS = 30_000;

const STATUS_ICON: Record<AgentStatus, string> = {
  queued: "○",
  running: "●",
  done: "✓",
  failed: "✗",
  stopped: "■",
};

const STATUS_COLOR: Record<AgentStatus, "dim" | "accent" | "success" | "error" | "warning"> = {
  queued: "dim",
  running: "accent",
  done: "success",
  failed: "error",
  stopped: "warning",
};

export function elapsed(record: AgentRecord): number {
  if (!record.startedAt) return 0;
  return (record.endedAt ?? Date.now()) - record.startedAt;
}

export function statsLine(record: AgentRecord): string {
  return [modelLabel(record.model), `${formatTokens(record.tokens)} tok`, formatCost(record.cost), formatDuration(elapsed(record))].join(" · ");
}

export function summaryLine(record: AgentRecord): string {
  const detail = record.status === "running" && record.activity ? ` [${record.activity}]` : "";
  return `${record.id} ${record.status}${detail} · ${statsLine(record)} · ${oneLine(record.task)}`;
}

export function visibleInWidget(record: AgentRecord, now = Date.now()): boolean {
  if (record.status === "queued" || record.status === "running") return true;
  return now - (record.endedAt ?? 0) < RECENT_MS;
}

export class AgentWidget implements Component {
  private readonly manager: AgentManager;
  private readonly theme: Theme;

  constructor(manager: AgentManager, theme: Theme) {
    this.manager = manager;
    this.theme = theme;
  }

  render(width: number): string[] {
    return this.manager
      .list()
      .filter((record) => visibleInWidget(record))
      .map((record) => {
        const icon = this.theme.fg(STATUS_COLOR[record.status], STATUS_ICON[record.status]);
        const activity = record.status === "running" && record.activity ? this.theme.fg("muted", ` ${record.activity}`) : "";
        const stats = this.theme.fg("dim", ` ${statsLine(record)} `);
        const task = this.theme.fg("muted", oneLine(record.task));
        return truncateToWidth(`${icon} ${this.theme.bold(record.id)}${activity}${stats}${task}`, width);
      });
  }

  invalidate(): void {}
}

export class TranscriptView implements Component {
  private offset = 0;
  private follow = true;
  private lastHeight = 0;
  private lastTotal = 0;
  private readonly record: AgentRecord;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly close: () => void;

  constructor(record: AgentRecord, tui: TUI, theme: Theme, close: () => void) {
    this.record = record;
    this.tui = tui;
    this.theme = theme;
    this.close = close;
  }

  render(width: number): string[] {
    const header = truncateToWidth(
      `${this.theme.fg(STATUS_COLOR[this.record.status], STATUS_ICON[this.record.status])} ${this.theme.bold(this.record.id)} ${this.theme.fg("dim", statsLine(this.record))}`,
      width,
    );
    const footer = this.theme.fg("dim", truncateToWidth("↑↓ PgUp PgDn g G scroll · Esc/q close", width));
    const messages = this.record.session?.messages ?? [];
    const markdown = messages.length > 0 ? renderTranscript(messages) : `## Task\n\n${this.record.task}\n\n_${this.record.error ?? "No transcript available."}_`;
    const body = new Markdown(markdown, 1, 0, getMarkdownTheme()).render(width);

    this.lastHeight = Math.max(3, this.tui.terminal.rows - 4);
    this.lastTotal = body.length;
    const maxOffset = Math.max(0, body.length - this.lastHeight);
    if (this.follow) this.offset = maxOffset;
    this.offset = Math.min(this.offset, maxOffset);
    return [header, ...body.slice(this.offset, this.offset + this.lastHeight), footer];
  }

  handleInput(data: string): void {
    const page = Math.max(1, this.lastHeight - 2);
    if (matchesKey(data, "escape") || data === "q") return this.close();
    if (matchesKey(data, "up") || data === "k") this.scroll(-1);
    else if (matchesKey(data, "down") || data === "j") this.scroll(1);
    else if (matchesKey(data, "pageUp")) this.scroll(-page);
    else if (matchesKey(data, "pageDown") || data === " ") this.scroll(page);
    else if (data === "g") this.scroll(-Infinity);
    else if (data === "G") this.scroll(Infinity);
    else return;
    this.tui.requestRender();
  }

  invalidate(): void {}

  private scroll(lines: number): void {
    const maxOffset = Math.max(0, this.lastTotal - this.lastHeight);
    this.offset = Math.max(0, Math.min(maxOffset, this.offset + lines));
    this.follow = this.offset >= maxOffset;
  }
}
