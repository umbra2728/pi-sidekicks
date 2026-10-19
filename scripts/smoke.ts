import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import sideAgents from "../src/index.ts";

const cwd = process.argv[2] ?? process.cwd();
const modelQuery = process.argv[3] ?? "claude-haiku-5-5";

const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir: getAgentDir(),
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  extensionFactories: [{ name: "side-agents", factory: sideAgents }],
});
await resourceLoader.reload();

const { session } = await createAgentSession({ cwd, resourceLoader, sessionManager: SessionManager.inMemory(cwd) });
const model = (await session.modelRuntime.getAvailable()).find((candidate) => candidate.id === modelQuery);
if (model) await session.setModel(model);
await session.bindExtensions({});

session.subscribe((event) => {
  if (event.type === "tool_execution_start") console.log(`[parent tool] ${event.toolName} ${JSON.stringify(event.args).slice(0, 160)}`);
  if (event.type === "message_end" && event.message.role === "custom") console.log(`[custom message]\n${JSON.stringify(event.message.content).slice(0, 400)}`);
  if (event.type === "message_end" && event.message.role === "assistant") {
    const text = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
    if (text) console.log(`[parent says] ${text}`);
  }
});

await session.prompt(
  `Call subagent exactly once with task "Read data.txt in ${cwd} and reply with its exact contents only." and model "${modelQuery}". Then end your turn. When the subagent result message arrives, reply "GOT: <value>".`,
);

const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  const done = session.messages.some(
    (message) => message.role === "assistant" && message.content.some((part) => part.type === "text" && part.text.includes("GOT:")),
  );
  if (done && !session.isStreaming) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
await session.waitForIdle?.();
session.dispose();
process.exit(0);
