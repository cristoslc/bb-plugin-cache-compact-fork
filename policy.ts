export type TtlSource =
  | "provider-ttl" // exact, reported by the provider
  | "compaction-offer" // exact, derived by bb from a compaction offer
  | "provider-fallback-ttl" // documented per-provider assumption
  | "fallback-ttl"; // global assumption

export type CompactionMethodKind = "native" | "slash-command";

export type TrackedThreadState =
  | "scheduled"
  | "compacting"
  | "compacted"
  | "skipped"
  | "active"
  | "expired"
  | "failed";

export interface CacheCompactConfig {
  readonly enabled: boolean;
  readonly minTokens: number;
  readonly leadMinutes: number;
  readonly providers: ReadonlySet<string>;
  readonly fallbackTtlMinutes: number;
  readonly fallbackTtlMinutesByProvider: ReadonlyMap<string, number>;
  readonly cooldownMinutes: number;
  readonly skipWithActiveChildren: boolean;
}

export interface ThreadActivitySnapshot {
  readonly activeBackgroundAgentCount: number;
  readonly activeBackgroundCommandCount: number;
  readonly activePlanModeCount: number;
  readonly activeWorkflowCount: number;
}

export interface ThreadInspection {
  readonly threadId: string;
  readonly providerId: string;
  readonly title: string;
  readonly status: string;
  readonly archivedAt: number | null;
  readonly deletedAt: number | null;
  readonly queuedWork: string;
  readonly updatedAt: number;
  readonly activity: ThreadActivitySnapshot;
  readonly usedTokens: number | null;
  readonly modelContextWindow: number | null;
  readonly compactionOfferAtMs: number | null;
  readonly tokenUsageEvent: {
    readonly seq: number;
    readonly createdAtMs: number;
    readonly promptCacheTtlMs: number | null;
  } | null;
  readonly latestTurnCompleted: {
    readonly seq: number;
    readonly createdAtMs: number;
  } | null;
  readonly latestCompactedSeq: number | null;
  readonly latestUserInputWasCompact: boolean;
  readonly latestUserInputSeq: number | null;
  readonly hasPendingInteractions: boolean;
  readonly hasActiveChildren: boolean;
  readonly advertisesCompactCommand: boolean;
  readonly nativeCompactionUnsupported: boolean;
}

export interface PriorThreadState {
  readonly compactedForSeq: number | null;
  readonly lastCompactedAtMs: number | null;
  readonly optedOut: boolean;
  readonly firstSeenAtMs: number | null;
}

export type TtlResolution =
  | {
      readonly kind: "resolved";
      readonly source: TtlSource;
      readonly expiresAtMs: number;
      readonly ttlMs: number | null;
      readonly anchorAtMs: number | null;
    }
  | {
      readonly kind: "none";
      readonly reason: string;
    };

export type CompactionMethodResolution =
  | { readonly kind: "native" }
  | { readonly kind: "slash-command"; readonly command: "/compact" }
  | { readonly kind: "unsupported"; readonly reason: string };

export type ScheduleTimingResult =
  | {
      readonly kind: "schedule";
      readonly compactAtMs: number;
      readonly effectiveLeadMs: number;
    }
  | {
      readonly kind: "already-expired";
      readonly expiredAgoMs: number;
    }
  | {
      readonly kind: "too-close-to-expiry";
      readonly remainingMs: number;
    };

export type SkipReason =
  | "plugin-disabled"
  | "opted-out"
  | "provider-excluded"
  | "thread-not-idle"
  | "thread-archived-or-deleted"
  | "queued-work"
  | "background-activity"
  | "pending-interaction"
  | "active-children"
  | "no-usage"
  | "below-min-tokens"
  | "no-compaction-method"
  | "no-ttl"
  | "already-compacted"
  | "cooldown"
  | "already-expired"
  | "too-close-to-expiry"
  | "discovered-late";

export type EligibilityResult =
  | {
      readonly kind: "schedule";
      readonly compactAtMs: number;
      readonly expiresAtMs: number;
      readonly ttlSource: TtlSource;
      readonly method: CompactionMethodKind;
      readonly usedTokens: number;
      readonly latestEventSeq: number;
      readonly effectiveLeadMs: number;
    }
  | {
      readonly kind: "skip";
      readonly reason: SkipReason;
      readonly detail: string;
      readonly expiresAtMs: number | null;
      readonly ttlSource: TtlSource | null;
      readonly method: CompactionMethodKind | null;
      readonly usedTokens: number | null;
      readonly latestEventSeq: number;
    };

/** Known providers that do not declare BB's native `supportsManualCompaction`. */
const KNOWN_SLASH_ONLY_PROVIDERS: ReadonlySet<string> = new Set([
  "antigravity-cli",
]);

/**
 * Documented cache-lifetime assumptions for providers that report none.
 * OpenCode uses 5 minutes, the shortest common provider cache lifetime, so a
 * wrong guess fails early rather than compacting after the cache really died.
 * omp inherits Pi's behaviour and matches its sibling provider at 60 minutes.
 */
export const KNOWN_FALLBACK_TTL_PROVIDERS: ReadonlyMap<string, number> = new Map([
  ["acp-opencode", 5],
  ["acp-omp", 60],
]);

/** Default value for the `fallbackTtlMinutesByProvider` setting, derived from the map above. */
export const DEFAULT_FALLBACK_TTL_BY_PROVIDER = [...KNOWN_FALLBACK_TTL_PROVIDERS]
  .map(([providerId, minutes]) => `${providerId}=${minutes}`)
  .join(",");

/** Maximum per-provider assumed cache lifetime, matching the global setting's bound. */
const MAX_FALLBACK_TTL_MINUTES = 1440;

/** Minimum remaining TTL required to avoid racing an already-expiring cache. */
const MIN_REMAINING_BEFORE_EXPIRY_MS = 10_000;

/** Minimum lead window when clamping leadMinutes against a very short TTL. */
const MIN_CLAMPED_LEAD_MS = 30_000;

/** A thread must be known this long before its due time may trigger compaction. */
export const ARMING_DELAY_MS = 60_000;

export function parseProviderList(raw: string): ReadonlySet<string> {
  const entries = raw
    .split(/[\s,]+/u)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return new Set(entries);
}

export function parseProviderTtlOverrides(raw: string): ReadonlyMap<string, number> {
  const overrides = new Map<string, number>();
  const entries = raw
    .split(/[\s,]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  for (const entry of entries) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex === -1) {
      throw new Error(
        `Invalid per-provider TTL entry "${entry}": expected "provider=minutes".`,
      );
    }
    const provider = entry.slice(0, separatorIndex).trim().toLowerCase();
    const minutesRaw = entry.slice(separatorIndex + 1).trim();
    if (provider.length === 0) {
      throw new Error(
        `Invalid per-provider TTL entry "${entry}": missing provider id.`,
      );
    }
    if (minutesRaw.length === 0) {
      throw new Error(
        `Invalid per-provider TTL entry "${entry}": missing minutes value.`,
      );
    }
    if (!/^\d+$/u.test(minutesRaw)) {
      throw new Error(
        `Invalid per-provider TTL entry "${entry}": minutes must be a whole, non-negative number.`,
      );
    }
    const minutes = Number(minutesRaw);
    if (minutes > MAX_FALLBACK_TTL_MINUTES) {
      throw new Error(
        `Invalid per-provider TTL entry "${entry}": minutes must be at most ${MAX_FALLBACK_TTL_MINUTES}.`,
      );
    }
    if (overrides.has(provider)) {
      throw new Error(
        `Duplicate per-provider TTL entry "${entry}": provider "${provider}" is listed more than once.`,
      );
    }
    overrides.set(provider, minutes);
  }

  return overrides;
}

export function resolveCompactionMethod(input: {
  readonly providerId: string;
  readonly advertisesCompactCommand: boolean;
  readonly nativeCompactionUnsupported: boolean;
}): CompactionMethodResolution {
  const normalized = input.providerId.toLowerCase();
  const slashOnly =
    input.nativeCompactionUnsupported || KNOWN_SLASH_ONLY_PROVIDERS.has(normalized);

  if (!slashOnly) {
    return { kind: "native" };
  }
  if (input.advertisesCompactCommand) {
    return { kind: "slash-command", command: "/compact" };
  }
  return {
    kind: "unsupported",
    reason: `Provider "${input.providerId}" does not support native compaction and does not advertise a /compact command.`,
  };
}

export interface FallbackTtlSettings {
  readonly fallbackTtlMinutes: number;
  readonly fallbackTtlMinutesByProvider: ReadonlyMap<string, number>;
}

export function resolveCacheTtl(
  inspection: Pick<
    ThreadInspection,
    | "providerId"
    | "compactionOfferAtMs"
    | "tokenUsageEvent"
    | "latestTurnCompleted"
    | "updatedAt"
  >,
  settings: FallbackTtlSettings,
): TtlResolution {
  if (
    inspection.tokenUsageEvent !== null &&
    inspection.tokenUsageEvent.promptCacheTtlMs !== null &&
    inspection.tokenUsageEvent.promptCacheTtlMs > 0
  ) {
    const ttlMs = inspection.tokenUsageEvent.promptCacheTtlMs;
    const anchorAtMs = inspection.tokenUsageEvent.createdAtMs;
    return {
      kind: "resolved",
      source: "provider-ttl",
      expiresAtMs: anchorAtMs + ttlMs,
      ttlMs,
      anchorAtMs,
    };
  }

  if (inspection.compactionOfferAtMs !== null) {
    return {
      kind: "resolved",
      source: "compaction-offer",
      expiresAtMs: inspection.compactionOfferAtMs,
      ttlMs: null,
      anchorAtMs: inspection.tokenUsageEvent?.createdAtMs ?? null,
    };
  }

  const providerKey = inspection.providerId.toLowerCase();
  const providerTtlMinutes = settings.fallbackTtlMinutesByProvider.get(providerKey);
  if (providerTtlMinutes !== undefined) {
    if (providerTtlMinutes <= 0) {
      return {
        kind: "none",
        reason: `Provider "${inspection.providerId}" has a per-provider fallback TTL of 0, which disables the assumption.`,
      };
    }
    const ttlMs = providerTtlMinutes * 60_000;
    const anchorAtMs =
      inspection.tokenUsageEvent?.createdAtMs ??
      inspection.latestTurnCompleted?.createdAtMs ??
      inspection.updatedAt;
    return {
      kind: "resolved",
      source: "provider-fallback-ttl",
      expiresAtMs: anchorAtMs + ttlMs,
      ttlMs,
      anchorAtMs,
    };
  }

  const fallbackTtlMs = settings.fallbackTtlMinutes * 60_000;
  if (fallbackTtlMs <= 0) {
    return {
      kind: "none",
      reason: "Provider reported no prompt cache TTL and fallbackTtlMinutes is disabled.",
    };
  }

  const anchorAtMs =
    inspection.tokenUsageEvent?.createdAtMs ??
    inspection.latestTurnCompleted?.createdAtMs ??
    inspection.updatedAt;

  return {
    kind: "resolved",
    source: "fallback-ttl",
    expiresAtMs: anchorAtMs + fallbackTtlMs,
    ttlMs: fallbackTtlMs,
    anchorAtMs,
  };
}

export function computeCompactAtMs(input: {
  readonly nowMs: number;
  readonly expiresAtMs: number;
  readonly ttlMs: number | null;
  readonly leadMs: number;
}): ScheduleTimingResult {
  const remainingMs = input.expiresAtMs - input.nowMs;
  if (remainingMs <= 0) {
    return {
      kind: "already-expired",
      expiredAgoMs: -remainingMs,
    };
  }
  if (remainingMs < MIN_REMAINING_BEFORE_EXPIRY_MS) {
    return {
      kind: "too-close-to-expiry",
      remainingMs,
    };
  }

  const effectiveLeadMs =
    input.ttlMs !== null && input.leadMs >= input.ttlMs
      ? Math.max(MIN_CLAMPED_LEAD_MS, Math.floor(input.ttlMs * 0.25))
      : input.leadMs;

  const targetMs = input.expiresAtMs - effectiveLeadMs;
  return {
    kind: "schedule",
    compactAtMs: Math.max(input.nowMs, targetMs),
    effectiveLeadMs,
  };
}

export function latestActivitySequence(inspection: ThreadInspection): number {
  return Math.max(
    inspection.tokenUsageEvent?.seq ?? 0,
    inspection.latestTurnCompleted?.seq ?? 0,
    inspection.latestUserInputSeq ?? 0,
  );
}

export function evaluateEligibility(input: {
  readonly config: CacheCompactConfig;
  readonly inspection: ThreadInspection;
  readonly prior: PriorThreadState;
  readonly nowMs: number;
  readonly explicitCompaction: boolean;
}): EligibilityResult {
  const { config, inspection, prior, nowMs, explicitCompaction } = input;
  const latestSeq = latestActivitySequence(inspection);
  const methodRes = resolveCompactionMethod({
    providerId: inspection.providerId,
    advertisesCompactCommand: inspection.advertisesCompactCommand,
    nativeCompactionUnsupported: inspection.nativeCompactionUnsupported,
  });
  const method: CompactionMethodKind | null =
    methodRes.kind === "unsupported" ? null : methodRes.kind;
  const ttlRes = resolveCacheTtl(inspection, {
    fallbackTtlMinutes: config.fallbackTtlMinutes,
    fallbackTtlMinutesByProvider: config.fallbackTtlMinutesByProvider,
  });
  const expiresAtMs = ttlRes.kind === "resolved" ? ttlRes.expiresAtMs : null;
  const ttlSource = ttlRes.kind === "resolved" ? ttlRes.source : null;

  const skip = (reason: SkipReason, detail: string): EligibilityResult => ({
    kind: "skip",
    reason,
    detail,
    expiresAtMs,
    ttlSource,
    method,
    usedTokens: inspection.usedTokens,
    latestEventSeq: latestSeq,
  });

  if (!config.enabled) {
    return skip("plugin-disabled", "Cache Compact is disabled in plugin settings.");
  }
  if (prior.optedOut) {
    return skip("opted-out", "Thread is opted out of automatic cache compaction.");
  }
  if (!config.providers.has(inspection.providerId.toLowerCase())) {
    return skip(
      "provider-excluded",
      `Provider "${inspection.providerId}" is not in the configured providers list.`,
    );
  }
  if (inspection.archivedAt !== null || inspection.deletedAt !== null) {
    return skip("thread-archived-or-deleted", "Thread is archived or deleted.");
  }
  if (inspection.status !== "idle") {
    return skip("thread-not-idle", `Thread status is "${inspection.status}", not "idle".`);
  }
  if (inspection.queuedWork !== "none") {
    return skip("queued-work", `Thread has queued work (${inspection.queuedWork}).`);
  }
  if (
    inspection.activity.activeBackgroundAgentCount > 0 ||
    inspection.activity.activeBackgroundCommandCount > 0 ||
    inspection.activity.activeWorkflowCount > 0
  ) {
    return skip("background-activity", "Thread has running background tasks or workflows.");
  }
  if (inspection.hasPendingInteractions) {
    return skip("pending-interaction", "Thread has a pending user interaction or approval.");
  }
  if (config.skipWithActiveChildren && inspection.hasActiveChildren) {
    return skip("active-children", "Thread has an active child thread.");
  }
  if (inspection.usedTokens === null) {
    return skip("no-usage", "No recorded context token usage for this thread.");
  }
  if (inspection.usedTokens < config.minTokens) {
    return skip(
      "below-min-tokens",
      `Context usage (${inspection.usedTokens.toLocaleString("en-US")} tokens) is below minTokens (${config.minTokens.toLocaleString("en-US")}).`,
    );
  }
  if (methodRes.kind === "unsupported") {
    return skip("no-compaction-method", methodRes.reason);
  }
  if (inspection.latestUserInputWasCompact) {
    return skip(
      "already-compacted",
      "The most recent turn in this thread was already a /compact command.",
    );
  }
  if (
    inspection.latestCompactedSeq !== null &&
    latestSeq > 0 &&
    inspection.latestCompactedSeq >= latestSeq
  ) {
    return skip(
      "already-compacted",
      "Thread was already compacted after its latest activity.",
    );
  }
  if (
    prior.compactedForSeq !== null &&
    latestSeq > 0 &&
    latestSeq <= prior.compactedForSeq
  ) {
    return skip(
      "already-compacted",
      "No new turns since the last automatic compaction.",
    );
  }
  if (prior.lastCompactedAtMs !== null) {
    const cooldownMs = config.cooldownMinutes * 60_000;
    const elapsedMs = nowMs - prior.lastCompactedAtMs;
    if (elapsedMs < cooldownMs) {
      const remainingSec = Math.ceil((cooldownMs - elapsedMs) / 1000);
      return skip(
        "cooldown",
        `Compaction cooldown active (${remainingSec}s remaining).`,
      );
    }
  }
  if (ttlRes.kind === "none") {
    return skip("no-ttl", ttlRes.reason);
  }

  const timing = computeCompactAtMs({
    nowMs,
    expiresAtMs: ttlRes.expiresAtMs,
    ttlMs: ttlRes.ttlMs,
    leadMs: config.leadMinutes * 60_000,
  });

  switch (timing.kind) {
    case "already-expired":
      return skip(
        "already-expired",
        `Prompt cache expired ${Math.round(timing.expiredAgoMs / 1000)}s ago; skipping to avoid cold-cache compaction.`,
      );
    case "too-close-to-expiry":
      return skip(
        "too-close-to-expiry",
        `Only ${Math.round(timing.remainingMs / 1000)}s remain before cache expiry; skipping to avoid racing expiry.`,
      );
    case "schedule": {
      const armedAtMs = (prior.firstSeenAtMs ?? nowMs) + ARMING_DELAY_MS;
      if (!explicitCompaction && timing.compactAtMs <= armedAtMs) {
        return skip(
          "discovered-late",
          `Thread was first seen inside its arming delay; its due time (${Math.round((nowMs - timing.compactAtMs) / 1000)}s ago) precedes ${Math.round(ARMING_DELAY_MS / 1000)}s of acquaintance.`,
        );
      }
      return {
        kind: "schedule",
        compactAtMs: timing.compactAtMs,
        expiresAtMs: ttlRes.expiresAtMs,
        ttlSource: ttlRes.source,
        method: methodRes.kind,
        usedTokens: inspection.usedTokens,
        latestEventSeq: latestSeq,
        effectiveLeadMs: timing.effectiveLeadMs,
      };
    }
    default: {
      const _exhaustive: never = timing;
      return _exhaustive;
    }
  }
}

export function isUnsupportedCompactionError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : typeof error === "string"
        ? error.toLowerCase()
        : "";
  return (
    message.includes("not supported") ||
    message.includes("unsupported") ||
    message.includes("does not support") ||
    message.includes("cannot compact")
  );
}
