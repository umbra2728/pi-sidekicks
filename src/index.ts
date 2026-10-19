import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatCost, formatDuration, formatTokens } from "./format.ts";
import { AgentManager, type AgentRecord } from "./manager.ts";
import { resolveModel } from "./models.ts";
import { AgentWidget, elapsed, statsLine, summaryLine, TranscriptView, visibleInWidget } from "./ui.ts";

const MAX_CONCURRENT = Number(process.env.PI_SIDE_AGENTS_CONCURRENCY) || 10;
const RESULT_TYPE = "subagent-result";
const WIDGET_KEY = "side-agents";
const COLLAPSED_PREVIEW_LINES = 3;

interface ResultDetails {
  id: string;
  status: AgentRecord["status"];
  stats: string;
  body: string;
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });

export default function sideAgents(pi: ExtensionAPI) {
  let latestCtx: ExtensionContext | undefined;
  let widgetTui: TUI | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  const silentStops = new Set<string>();

  const refresh = () => {
    widgetTui?.requestRender();
    const needsTicker = manager.list().some((record) => visibleInWidget(record));
    if (needsTicker && !ticker) ticker = setInterval(refresh, 1000);
    if (!needsTicker && ticker) {
      clearInterval(ticker);
      ticker = undefined;
    }
  };

  const deliver = (record: AgentRecord) => {
    if (silentStops.delete(record.id)) return;
    const body =
      record.status === "failed"
        ? `Error: ${record.error}`
        : record.status === "stopped"
          ? (record.result ?? "(stopped before any output)")
          : (record.result ?? "");
    const header = `[subagent ${record.id} ${record.status} · ${formatTokens(record.tokens)} tok · ${formatCost(record.cost)} · ${formatDuration(elapsed(record))}]`;
    const details: ResultDetails = { id: record.id, status: record.status, stats: statsLine(record), body };
    const triggerTurn = record.status !== "stopped";
    try {
      pi.sendMessage(
        { customType: RESULT_TYPE, content: `${header}\n\n${body}`, display: true, details },
        { triggerTurn, deliverAs: latestCtx?.isIdle() === false ? "steer" : "followUp" },
      );
    } catch {
      latestCtx?.ui.notify(`Subagent ${record.id} ${record.status}`, "info");
    }
  };

  const manager = new AgentManager(MAX_CONCURRENT, { onChange: refresh, onSettled: deliver });

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
      widgetTui = tui;
      return new AgentWidget(manager, theme);
    });
  });

  pi.on("session_shutdown", () => {
    if (ticker) clearInterval(ticker);
    ticker = undefined;
    widgetTui = undefined;
    manager.dispose();
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Start a background agent with a fresh context and return its id immediately. It has the same tools and working directory as you; its final answer arrives later as a message that wakes you.",
    promptSnippet: "Delegate an independent task to a background agent with fresh context; its result arrives as a message",
    promptGuidelines: [
      "Use subagent for self-contained work that would bloat your context or can run alongside yours: codebase recon, an independent review or second opinion, unrelated side tasks such as fetching or parsing a separate data source. Do small or tightly coupled work yourself.",
      "Write each task for a colleague with no context: goal, relevant paths, constraints, and what to report back. Ask for a concise report.",
      "After spawning, continue your work or end your turn; never wait, sleep, or poll. Use subagent_message to redirect or follow up instead of spawning a new agent.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Complete, self-contained instructions. The agent sees nothing else." }),
      model: Type.Optional(Type.String({ description: "provider/id or a fuzzy id like 'haiku'. Default: your current model." })),
      thinking: Type.Optional(
        StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, { description: "Default: your current level." }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      latestCtx = ctx;
      const record = manager.spawn(params.task, {
        cwd: ctx.cwd,
        model: resolveModel(params.model, ctx),
        thinkingLevel: params.thinking ?? ctx.thinkingLevel,
      });
      return text(`Started ${record.id}. Its result will arrive as a message.`);
    },
  });

  pi.registerTool({
    name: "subagent_message",
    label: "Subagent message",
    description:
      "Send a message to a subagent. A running agent receives it after its current step; a finished one resumes with its full context and reports again.",
    parameters: Type.Object({ id: Type.String({ description: "Subagent id, e.g. a1." }), message: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      latestCtx = ctx;
      const outcome = await manager.message(params.id, params.message);
      return text(`${params.id} ${outcome}.`);
    },
  });

  pi.registerTool({
    name: "subagent_stop",
    label: "Subagent stop",
    description: "Stop a running or queued subagent. No result message follows.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      latestCtx = ctx;
      const record = manager.get(params.id);
      if (record.status !== "queued" && record.status !== "running") return text(`${record.id} already ${record.status}.`);
      silentStops.add(record.id);
      await manager.stop(record.id);
      return text(`${record.id} stopped.`);
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "Subagent list",
    description: "List subagents with status, activity, tokens, cost, and elapsed time. Results are delivered automatically; don't use this to poll.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      latestCtx = ctx;
      const records = manager.list();
      return text(records.length ? records.map(summaryLine).join("\n") : "No subagents.");
    },
  });

  pi.registerMessageRenderer<ResultDetails>(RESULT_TYPE, (message, options, theme) => {
    const details = message.details;
    if (!details) return undefined;
    const color = details.status === "done" ? "success" : details.status === "failed" ? "error" : "warning";
    const container = new Container();
    container.addChild(new Text(`${theme.fg(color, `subagent ${details.id} ${details.status}`)} ${theme.fg("dim", details.stats)}`, 1, 0));
    if (options.expanded) {
      container.addChild(new Markdown(details.body, 1, 0, getMarkdownTheme()));
    } else {
      const lines = details.body.split("\n");
      const preview = lines.slice(0, COLLAPSED_PREVIEW_LINES).join("\n");
      const more = lines.length > COLLAPSED_PREVIEW_LINES ? `\n${theme.fg("dim", `… ${lines.length - COLLAPSED_PREVIEW_LINES} more lines`)}` : "";
      container.addChild(new Text(`${theme.fg("muted", preview)}${more}`, 1, 0));
    }
    return container;
  });

  pi.registerCommand("subagents", {
    description: "Inspect, message, or stop subagents",
    handler: async (_args, ctx) => {
      latestCtx = ctx;
      const records = manager.list().reverse();
      if (records.length === 0) return ctx.ui.notify("No subagents.", "info");

      const labels = records.map(summaryLine);
      const picked = await ctx.ui.select("Subagents", labels);
      const record = picked ? records[labels.indexOf(picked)] : undefined;
      if (!record) return;

      const active = record.status === "queued" || record.status === "running";
      const actions = ["View transcript", ...(active || record.session ? ["Message"] : []), ...(active ? ["Stop"] : [])];
      const action = await ctx.ui.select(`${record.id}`, actions);

      if (action === "View transcript") {
        if (ctx.mode !== "tui") return ctx.ui.notify("Transcript view needs the TUI.", "warning");
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
          const view = new TranscriptView(record, tui, theme, () => done());
          const timer = setInterval(() => tui.requestRender(), 500);
          return Object.assign(view, { dispose: () => clearInterval(timer) });
        });
      } else if (action === "Message") {
        const input = await ctx.ui.input(`Message ${record.id}`, "");
        if (input?.trim()) ctx.ui.notify(`${record.id} ${await manager.message(record.id, input.trim())}.`, "info");
      } else if (action === "Stop") {
        await manager.stop(record.id);
      }
    },
  });
}
