export type PromptCapturedTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown> | null;
};

export type PromptTierKey =
  | "identity"
  | "base_mode"
  | "curated_memory"
  | "structured_facts"
  | "retrieved_history"
  | "capabilities_tools"
  | "current_input"
  | "output_contract";

export type PromptTierSnapshot = {
  key: PromptTierKey | string;
  label: string;
  present: boolean;
  sources: string[];
  details: Record<string, unknown> | null;
};

export type PromptCapture = {
  systemPrompt: string;
  initialUserPrompt: string;
  followupUserPrompts: string[];
  tools: PromptCapturedTool[];
  promptTiers: PromptTierSnapshot[];
};

export type LoggedPromptBundle = {
  hiddenByDefault: boolean;
  systemPrompt: string;
  initialUserPrompt: string;
  followupUserPrompts: string[];
  followupSteps: number;
  tools: PromptCapturedTool[];
  promptTiers: PromptTierSnapshot[];
};

type PromptTierDefinition = {
  key: PromptTierKey;
  label: string;
  sources: string[];
  systemPatterns?: RegExp[];
  userPatterns?: RegExp[];
  details?: (input: {
    systemPrompt: string;
    userPrompt: string;
    followupUserPrompts: string[];
    tools: PromptCapturedTool[];
  }) => Record<string, unknown> | null;
};

type StandardPromptTierInput = {
  identity?: boolean;
  baseMode?: boolean;
  curatedMemory?: boolean;
  structuredFacts?: boolean;
  retrievedHistory?: boolean;
  capabilitiesTools?: boolean;
  currentInput?: boolean;
  outputContract?: boolean;
  systemPromptChars?: number;
  userPromptChars?: number;
  toolCount?: number;
  details?: Partial<Record<PromptTierKey, Record<string, unknown> | null>>;
};

const PROMPT_TIER_DEFINITIONS: PromptTierDefinition[] = [
  {
    key: "identity",
    label: "Identity",
    sources: ["system"],
    systemPatterns: [/=== IDENTITY ===/i, /=== PERSONA ===/i, /^Identity:/im],
    details: ({ systemPrompt }) => ({ systemPromptChars: systemPrompt.length })
  },
  {
    key: "base_mode",
    label: "Base Mode Guidance",
    sources: ["system"],
    systemPatterns: [/=== BASE (?:TEXT|VOICE) MODE ===/i, /=== CAPABILITIES ===/i, /Base live voice mode:/i],
    details: ({ systemPrompt }) => ({ systemPromptChars: systemPrompt.length })
  },
  {
    key: "curated_memory",
    label: "Curated Always-On Memory",
    sources: ["system", "user"],
    systemPatterns: [/Curated always-on memory:/i],
    userPatterns: [/=== CURATED ALWAYS-ON MEMORY ===/i, /Curated always-on memory:/i, /Relevant task memory bundle:/i]
  },
  {
    key: "structured_facts",
    label: "Scoped Structured Facts",
    sources: ["user"],
    userPatterns: [
      /=== PEOPLE IN THIS CONVERSATION ===/i,
      /^People in this conversation:/im,
      /=== USER FACTS ===/i,
      /=== DURABLE MEMORY ===/i,
      /=== BEHAVIOR GUIDANCE ===/i,
      /^Behavior guidance:/im,
      /=== RELEVANT BEHAVIORAL MEMORY ===/i,
      /^Behavioral memory/im
    ]
  },
  {
    key: "retrieved_history",
    label: "Retrieved History",
    sources: ["user"],
    userPatterns: [
      /=== RECENT MESSAGES ===/i,
      /=== RECENT CONVERSATION CONTINUITY ===/i,
      /=== RECENT VOICE SESSION CONTEXT ===/i,
      /^Recent conversation continuity:/im,
      /^Past conversation:/im,
      /^Session conversation summary:/im,
      /^Earlier in this session:/im
    ]
  },
  {
    key: "capabilities_tools",
    label: "Capability And Tool State",
    sources: ["system", "user", "tools"],
    systemPatterns: [/=== TOOLS ===/i, /Tooling policy:/i],
    userPatterns: [/=== CAPABILITIES ===/i, /^Tools:/im, /Memory lookup:/i, /Web search:/i, /Browser:/i],
    details: ({ tools }) => ({ toolCount: tools.length })
  },
  {
    key: "current_input",
    label: "Current User/Event Input",
    sources: ["user"],
    userPatterns: [
      /=== LATEST MESSAGE \(TURN ANCHOR\) ===/i,
      /Incoming live voice transcript/i,
      /Voice runtime event cue:/i,
      /=== AUTOMATION TASK ===/i,
      /=== AMBIENT TEXT MODE ===/i,
      /Worker assignment:/i
    ],
    details: ({ userPrompt }) => ({ userPromptChars: userPrompt.length })
  },
  {
    key: "output_contract",
    label: "Output Contract",
    sources: ["system", "user"],
    systemPatterns: [/=== OUTPUT ===/i],
    userPatterns: [/=== OUTPUT FORMAT ===/i, /Return strict JSON/i, /Output exactly \[SKIP\]/i, /update_task\(done\)/i]
  }
];

export function createPromptCapture({
  systemPrompt = "",
  initialUserPrompt = "",
  tools = [],
  promptTiers = []
}: {
  systemPrompt?: string;
  initialUserPrompt?: string;
  tools?: PromptCapturedTool[];
  promptTiers?: PromptTierSnapshot[];
} = {}): PromptCapture {
  return {
    systemPrompt: String(systemPrompt || ""),
    initialUserPrompt: String(initialUserPrompt || ""),
    followupUserPrompts: [],
    tools: Array.isArray(tools) ? tools : [],
    promptTiers: normalizePromptTiers(promptTiers)
  };
}

export function appendPromptFollowup(
  capture: PromptCapture | null = null,
  userPrompt = ""
) {
  if (!capture || typeof capture !== "object") return;
  if (!Array.isArray(capture.followupUserPrompts)) {
    capture.followupUserPrompts = [];
  }
  capture.followupUserPrompts.push(String(userPrompt || ""));
}

export function buildLoggedPromptBundle(
  capture: PromptCapture | null = null,
  followupSteps = 0
): LoggedPromptBundle | null {
  if (!capture || typeof capture !== "object") return null;
  const systemPrompt = String(capture.systemPrompt || "");
  const initialUserPrompt = String(capture.initialUserPrompt || "");
  const followupUserPrompts = Array.isArray(capture.followupUserPrompts)
    ? capture.followupUserPrompts.map((prompt) => String(prompt || ""))
    : [];
  const resolvedFollowupSteps = Math.max(
    0,
    Number.isFinite(Number(followupSteps))
      ? Math.floor(Number(followupSteps))
      : followupUserPrompts.length
  );

  const tools = Array.isArray(capture.tools)
    ? capture.tools.map((t) => ({
      name: String(t?.name || ""),
      description: String(t?.description || ""),
      parameters: t?.parameters && typeof t.parameters === "object" ? t.parameters : null
    })).filter((t) => t.name)
    : [];
  const explicitPromptTiers = normalizePromptTiers(capture.promptTiers);
  const promptTiers = explicitPromptTiers.length
    ? explicitPromptTiers
    : inferPromptTiersFromPromptText({
      systemPrompt,
      initialUserPrompt,
      followupUserPrompts,
      tools
    });

  return {
    hiddenByDefault: true,
    systemPrompt,
    initialUserPrompt,
    followupUserPrompts,
    followupSteps: resolvedFollowupSteps,
    tools,
    promptTiers
  };
}

export function buildSingleTurnPromptLog({
  systemPrompt = "",
  userPrompt = "",
  promptTiers = []
}: {
  systemPrompt?: string;
  userPrompt?: string;
  promptTiers?: PromptTierSnapshot[];
} = {}): LoggedPromptBundle {
  return buildLoggedPromptBundle(
    createPromptCapture({
      systemPrompt,
      initialUserPrompt: userPrompt,
      promptTiers
    }),
    0
  ) as LoggedPromptBundle;
}

export function normalizePromptTiers(value: unknown): PromptTierSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const record = entry as Record<string, unknown>;
      const key = String(record.key || "").trim();
      if (!key) return null;
      const label = String(record.label || key).trim() || key;
      const sources = Array.isArray(record.sources)
        ? record.sources.map((source) => String(source || "").trim()).filter(Boolean)
        : [];
      const details = record.details && typeof record.details === "object" && !Array.isArray(record.details)
        ? record.details as Record<string, unknown>
        : null;
      return {
        key,
        label,
        present: record.present !== false,
        sources,
        details
      } satisfies PromptTierSnapshot;
    })
    .filter((entry): entry is PromptTierSnapshot => entry !== null);
}

export function buildStandardPromptTiers({
  identity = false,
  baseMode = false,
  curatedMemory = false,
  structuredFacts = false,
  retrievedHistory = false,
  capabilitiesTools = false,
  currentInput = false,
  outputContract = false,
  systemPromptChars = 0,
  userPromptChars = 0,
  toolCount = 0,
  details = {}
}: StandardPromptTierInput = {}): PromptTierSnapshot[] {
  const presentByKey: Record<PromptTierKey, boolean> = {
    identity: Boolean(identity),
    base_mode: Boolean(baseMode),
    curated_memory: Boolean(curatedMemory),
    structured_facts: Boolean(structuredFacts),
    retrieved_history: Boolean(retrievedHistory),
    capabilities_tools: Boolean(capabilitiesTools),
    current_input: Boolean(currentInput),
    output_contract: Boolean(outputContract)
  };

  return PROMPT_TIER_DEFINITIONS.map((definition) => {
    const tierDetails: Record<string, unknown> = {
      ...(details[definition.key] || {})
    };
    if ((definition.key === "identity" || definition.key === "base_mode") && systemPromptChars > 0) {
      tierDetails.systemPromptChars = Math.floor(systemPromptChars);
    }
    if (definition.key === "capabilities_tools") {
      tierDetails.toolCount = Math.max(0, Math.floor(Number(toolCount) || 0));
    }
    if (definition.key === "current_input" && userPromptChars > 0) {
      tierDetails.userPromptChars = Math.floor(userPromptChars);
    }
    return {
      key: definition.key,
      label: definition.label,
      present: presentByKey[definition.key],
      sources: definition.sources,
      details: Object.keys(tierDetails).length ? tierDetails : null
    } satisfies PromptTierSnapshot;
  });
}

export function inferPromptTiersFromPromptText({
  systemPrompt = "",
  initialUserPrompt = "",
  followupUserPrompts = [],
  tools = []
}: {
  systemPrompt?: string;
  initialUserPrompt?: string;
  followupUserPrompts?: string[];
  tools?: PromptCapturedTool[];
} = {}): PromptTierSnapshot[] {
  const normalizedSystemPrompt = String(systemPrompt || "");
  const normalizedInitialUserPrompt = String(initialUserPrompt || "");
  const normalizedFollowups = Array.isArray(followupUserPrompts)
    ? followupUserPrompts.map((prompt) => String(prompt || ""))
    : [];
  const userPrompt = [normalizedInitialUserPrompt, ...normalizedFollowups].join("\n\n");
  const normalizedTools = Array.isArray(tools) ? tools : [];

  return PROMPT_TIER_DEFINITIONS.map((definition) => {
    const systemPresent = matchesAny(normalizedSystemPrompt, definition.systemPatterns);
    // User prompt captures include raw user/transcript content, so fallback
    // inference must not trust user-visible section markers. Prompt builders
    // should pass explicit promptTiers when user-section visibility matters.
    const userPresent = false;
    const toolPresent = definition.key === "capabilities_tools" && normalizedTools.length > 0;
    const present = Boolean(systemPresent || userPresent || toolPresent);
    const details = present ? definition.details?.({
      systemPrompt: normalizedSystemPrompt,
      userPrompt,
      followupUserPrompts: normalizedFollowups,
      tools: normalizedTools
    }) || null : null;
    return {
      key: definition.key,
      label: definition.label,
      present,
      sources: definition.sources,
      details
    } satisfies PromptTierSnapshot;
  });
}

function matchesAny(text: string, patterns: RegExp[] = []) {
  if (!text || !patterns.length) return false;
  return patterns.some((pattern) => pattern.test(text));
}
