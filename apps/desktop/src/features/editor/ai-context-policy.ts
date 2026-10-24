import type { PageAiMemoryEntry, PageContextContainer } from "./page-ai-context";
import { buildPageAiContext } from "./page-ai-context.ts";

export type AiContextScope = "note" | "chosen" | "page" | "none";
export type AiContextOptions = {
  scope: AiContextScope;
  includeHistory: boolean;
  reviewBeforeSend: boolean;
};

export const DEFAULT_AI_CONTEXT_OPTIONS: AiContextOptions = {
  scope: "note",
  includeHistory: false,
  reviewBeforeSend: true,
};
export const AI_CONTEXT_PREFERENCE_KEY = "lenota:ai-context-options:v1";
export const AI_CONTEXT_MAX_CHARACTERS = 120_000;
export const AI_PROMPT_MAX_CHARACTERS = 20_000;

export function parseAiContextOptions(raw: string | null): AiContextOptions {
  if (!raw) return { ...DEFAULT_AI_CONTEXT_OPTIONS };
  try {
    const obj: unknown = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return { ...DEFAULT_AI_CONTEXT_OPTIONS };
    const v = obj as Partial<AiContextOptions>;
    return {
      scope: v.scope === "note" || v.scope === "chosen" || v.scope === "page" || v.scope === "none" ? v.scope : "note",
      includeHistory: v.includeHistory === true,
      reviewBeforeSend: v.reviewBeforeSend !== false,
    };
  } catch { return { ...DEFAULT_AI_CONTEXT_OPTIONS }; }
}

export function buildScopedAiContext({
  title, containers, memory = [], scope, anchorId, chosenIds = [], includeHistory = false, question = "",
}: {
  title: string;
  containers: PageContextContainer[];
  memory?: PageAiMemoryEntry[];
  scope: AiContextScope;
  anchorId?: string;
  chosenIds?: readonly string[];
  includeHistory?: boolean;
  question?: string;
}): { context: string; containerCount: number; truncated: boolean } {
  if (scope === "none") return { context: "", containerCount: 0, truncated: false };
  const chosen = new Set(chosenIds);
  const matches = containers.filter(container =>
    scope === "page" || (scope === "note" && container.id === anchorId) || (scope === "chosen" && chosen.has(container.id))
  );
  const relevantMemory = includeHistory ? memory : [];
  // The note with /ask is already the command source. Do not echo the command
  // as source material when the request is also transmitted separately.
  const context = buildPageAiContext(title, matches, relevantMemory, AI_CONTEXT_MAX_CHARACTERS);
  const duplicateCommand = question.trim() ? `/ask ${question.trim()}` : "";
  const output = duplicateCommand
    ? context.split("\n").filter(line => line.trim() !== duplicateCommand).join("\n")
    : context;
  return {
    context: output,
    containerCount: matches.length,
    truncated: context.includes("[Page context truncated because it exceeded the safety limit.]"),
  };
}
