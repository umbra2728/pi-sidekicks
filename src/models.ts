import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function resolveModel(query: string | undefined, ctx: ExtensionContext): Model<any> | undefined {
  if (!query) return ctx.model;

  const registry = ctx.modelRegistry;
  const slash = query.indexOf("/");
  if (slash > 0) {
    const exact = registry.find(query.slice(0, slash), query.slice(slash + 1));
    if (exact) return exact;
  }

  const available = registry.getAvailable();
  const needle = query.toLowerCase();
  const match =
    available.find((model) => model.id.toLowerCase() === needle) ??
    available.find((model) => `${model.provider}/${model.id}`.toLowerCase().includes(needle)) ??
    available.find((model) => (model.name ?? "").toLowerCase().includes(needle));
  if (match) return match;

  throw new Error(`Unknown model "${query}". Use provider/id of an available model.`);
}

export function modelLabel(model: Model<any> | undefined): string {
  return model ? model.id : "default";
}
