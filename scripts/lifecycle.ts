import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentManager, type AgentRecord } from "../src/manager.ts";

const cwd = process.argv[2] ?? process.cwd();
const runtime = await ModelRuntime.create();
const model = (await runtime.getAvailable()).find((candidate) => candidate.id === (process.argv[3] ?? "claude-haiku-5-5"));

const settled: AgentRecord[] = [];
const manager = new AgentManager(1, { onChange: () => {}, onSettled: (record) => settled.push({ ...record }) });
const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 120_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
};
const options = { cwd, model, thinkingLevel: "off" as const };

const slow = manager.spawn("Run `sleep 30` with bash, then reply DONE.", options);
const queued = manager.spawn("Reply with the word QUEUED only.", options);
await waitFor(() => slow.activity === "bash");
console.log("concurrency:", slow.status, queued.status);

await manager.stop(slow.id);
await waitFor(() => queued.status === "done");
console.log("stop:", slow.status, "| queued result:", queued.result);

console.log("continue:", await manager.message(queued.id, "Now reply with the word AGAIN only."));
await waitFor(() => queued.status === "done" && settled.length >= 3);
console.log("continued result:", queued.result);
console.log("settled order:", settled.map((record) => `${record.id}:${record.status}`).join(", "));

manager.dispose();
process.exit(0);
