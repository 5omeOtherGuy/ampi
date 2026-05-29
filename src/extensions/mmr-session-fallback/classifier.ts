export type MmrSessionFallbackQuotaKind =
  | "openai-usage-limit"
  | "anthropic-rate-limit"
  | "copilot-quota"
  | "generic-hard-quota"
  | "not-quota";

export interface MmrSessionFallbackErrorInput {
  provider?: string;
  errorMessage?: string;
}

export interface MmrSessionFallbackErrorClassification {
  kind: MmrSessionFallbackQuotaKind;
  shouldPrompt: boolean;
  friendlyMessage: string;
}

const SUBSCRIPTION_PROVIDERS = new Set(["claude-subscription", "openai-codex", "github-copilot"]);

function normalize(value: string | undefined): string {
  return value ?? "";
}

function includesHardQuota(message: string): boolean {
  return /usage[_ -]?limit[_ -]?reached|usage[_ -]?not[_ -]?included|insufficient[_ -]?quota|quota exceeded|billing quota|out of quota/i.test(message);
}

function includesRateLimit(message: string): boolean {
  return /rate[_ -]?limit|too many requests|\b429\b/i.test(message);
}

function includesOverloadOnly(message: string): boolean {
  return /overloaded/i.test(message) && !includesRateLimit(message) && !includesHardQuota(message);
}

export function classifyMmrSessionFallbackError(input: MmrSessionFallbackErrorInput): MmrSessionFallbackErrorClassification {
  const provider = normalize(input.provider);
  const message = normalize(input.errorMessage);
  const lowerProvider = provider.toLowerCase();

  if (!message || includesOverloadOnly(message)) {
    return { kind: "not-quota", shouldPrompt: false, friendlyMessage: "No subscription quota condition detected." };
  }

  if (lowerProvider === "openai-codex" || /You have hit your ChatGPT usage limit/i.test(message)) {
    const prompt = /You have hit your ChatGPT usage limit|rate[_ -]?limit[_ -]?exceeded/i.test(message)
      || includesRateLimit(message)
      || includesHardQuota(message);
    return {
      kind: prompt ? "openai-usage-limit" : "not-quota",
      shouldPrompt: prompt,
      friendlyMessage: prompt ? "The active subscription-backed route reported a usage limit." : "No subscription quota condition detected.",
    };
  }

  if (lowerProvider === "github-copilot") {
    const prompt = includesRateLimit(message) || includesHardQuota(message);
    return {
      kind: prompt ? "copilot-quota" : "not-quota",
      shouldPrompt: prompt,
      friendlyMessage: prompt ? "The active subscription-backed route reported a quota or rate limit." : "No subscription quota condition detected.",
    };
  }

  if (lowerProvider === "claude-subscription") {
    const prompt = includesRateLimit(message) || includesHardQuota(message);
    return {
      kind: prompt ? "anthropic-rate-limit" : "not-quota",
      shouldPrompt: prompt,
      friendlyMessage: prompt ? "The active subscription-backed route reported a rate limit." : "No subscription quota condition detected.",
    };
  }

  if (includesHardQuota(message)) {
    return {
      kind: "generic-hard-quota",
      shouldPrompt: true,
      friendlyMessage: "The active route reported a hard quota limit.",
    };
  }

  if (SUBSCRIPTION_PROVIDERS.has(lowerProvider) && includesRateLimit(message)) {
    return {
      kind: "generic-hard-quota",
      shouldPrompt: true,
      friendlyMessage: "The active subscription-backed route reported a rate limit.",
    };
  }

  return { kind: "not-quota", shouldPrompt: false, friendlyMessage: "No subscription quota condition detected." };
}
