# pi-side-agents

Minimal background subagents for [pi](https://pi.dev).

- **Background only.** Spawning returns an id immediately; the result arrives later as a message that wakes the parent.
- **Fresh context.** A subagent sees only its task text, plus the usual project context files, skills and extensions.
- **No roles, no workflows.** One generic agent. Pick a model per task if you want.
- **Tiny footprint.** Four tools with one-sentence descriptions.
- **In-process.** Each subagent is an SDK session inside the running pi process. No tmux, no subprocesses.

## Install

```bash
pi install /path/to/pi-side-agents
```

Or try it without installing:

```bash
pi -e /path/to/pi-side-agents/src/index.ts
```

## Tools

| Tool | Purpose |
|---|---|
| `subagent({ task, model?, thinking? })` | Start a background agent; returns an id |
| `subagent_message({ id, message })` | Steer a running agent or continue a finished one |
| `subagent_stop({ id })` | Stop an agent |
| `subagent_list()` | List agents with status, tokens, cost and time |

`model` accepts `provider/id` or a fuzzy id (`haiku`, `gpt-5`); it defaults to the parent's current model. `thinking` defaults to the parent's level.

## UI

- A compact widget above the editor shows one line per active or recently finished agent: status, current tool, tokens, cost, elapsed time, task.
- `/subagents` lists all agents and lets you view the live transcript, send a message, or stop one.
- Result messages render collapsed (first lines); expand them to see the full output.

## Behavior

- Up to 10 agents run at once; extra spawns queue. Override with `PI_SIDE_AGENTS_CONCURRENCY`.
- Subagents cannot spawn subagents.
- Stopping via the tool is silent; stopping from `/subagents` posts a non-triggering result message with any partial output.
- The last 8 finished sessions stay alive for continuation; older ones are released.
- Subagents share your working directory and permissions. Nothing is sandboxed.

## Development

```bash
npm install
npm run typecheck
node scripts/smoke.ts /tmp/some-dir      # end-to-end: parent spawns, result is delivered
node scripts/lifecycle.ts /tmp/some-dir  # queueing, stop, continue
```

The `@earendil-works/*` and `typebox` peers are provided by pi; for local typechecking, symlink them into `node_modules` from your pi installation.
