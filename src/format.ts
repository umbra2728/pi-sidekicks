const TOOL_RESULT_PREVIEW_LINES = 12;
const ARGS_PREVIEW_CHARS = 200;

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

export function formatCost(cost: number): string {
  return `$${cost.toFixed(cost < 1 ? 3 : 2)}`;
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

type LooseContent = { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
type LooseMessage = { role?: string; content?: string | LooseContent[]; toolName?: string; isError?: boolean; errorMessage?: string };

function textOf(content: LooseMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n");
}

function previewArgs(args: unknown): string {
  const json = JSON.stringify(args ?? {});
  return json.length > ARGS_PREVIEW_CHARS ? `${json.slice(0, ARGS_PREVIEW_CHARS)}…` : json;
}

function previewLines(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= TOOL_RESULT_PREVIEW_LINES) return text;
  return [...lines.slice(0, TOOL_RESULT_PREVIEW_LINES), `… (${lines.length - TOOL_RESULT_PREVIEW_LINES} more lines)`].join("\n");
}

export function renderTranscript(messages: readonly unknown[]): string {
  const blocks: string[] = [];
  for (const raw of messages) {
    const message = raw as LooseMessage;
    if (message.role === "user") {
      blocks.push(`## User\n\n${textOf(message.content)}`);
    } else if (message.role === "assistant" && Array.isArray(message.content)) {
      const parts = message.content.flatMap((part) => {
        if (part.type === "text" && part.text) return [part.text];
        if (part.type === "thinking" && part.thinking) return [`> ${oneLine(part.thinking)}`];
        if (part.type === "toolCall") return [`\`→ ${part.name} ${previewArgs(part.arguments)}\``];
        return [];
      });
      if (message.errorMessage) parts.push(`**Error:** ${message.errorMessage}`);
      if (parts.length > 0) blocks.push(`## Assistant\n\n${parts.join("\n\n")}`);
    } else if (message.role === "toolResult") {
      const label = message.isError ? "error" : "result";
      blocks.push(`\`${message.toolName} ${label}\`\n\n\`\`\`\n${previewLines(textOf(message.content))}\n\`\`\``);
    }
  }
  return blocks.join("\n\n");
}

export function lastAssistantOutcome(messages: readonly unknown[]): { text: string; stopReason?: string; error?: string } {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as LooseMessage & { stopReason?: string };
    if (message.role !== "assistant") continue;
    return { text: textOf(message.content).trim(), stopReason: message.stopReason, error: message.errorMessage };
  }
  return { text: "" };
}
