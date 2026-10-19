import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  type LoadExtensionsResult,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export const OWN_TOOL_NAMES = new Set(["subagent", "subagent_message", "subagent_stop", "subagent_list"]);

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ChildSessionOptions {
  cwd: string;
  model: Model<any> | undefined;
  thinkingLevel: ThinkingLevel | undefined;
}

const builtinExtensions = () => [
  { name: "codemode", factory: createCodemodeExtension(), builtin: true as const, replaceable: true },
  { name: "tool-search", factory: createToolSearchExtension(), builtin: true as const, replaceable: true },
  { name: "mcp", factory: createMcpExtension(), builtin: true as const, replaceable: true },
];

const withoutSubagentExtensions = (base: LoadExtensionsResult): LoadExtensionsResult => ({
  ...base,
  extensions: base.extensions.filter((extension) => ![...extension.tools.keys()].some((name) => OWN_TOOL_NAMES.has(name))),
});

export async function createChildSession(options: ChildSessionOptions): Promise<AgentSession> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(options.cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    extensionFactories: builtinExtensions(),
    noPromptTemplates: true,
    noThemes: true,
    extensionsOverride: withoutSubagentExtensions,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(options.cwd),
  });

  try {
    await session.bindExtensions({ onError: () => {} });
  } catch (error) {
    session.dispose();
    throw error;
  }
  return session;
}
