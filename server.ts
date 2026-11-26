import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  ARMING_DELAY_MS,
  DEFAULT_FALLBACK_TTL_BY_PROVIDER,
  evaluateEligibility,
  isUnsupportedCompactionError,
  latestActivitySequence,
  parseProviderList,
  parseProviderTtlOverrides,
  resolveCompactionMethod,
  type CacheCompactConfig,
  type CompactionMethodKind,
  type ThreadInspection,
} from "./policy.js";
import {
  createCacheCompactStore,
  type TrackedThreadRecord,
} from "./store.js";

const trackedThreadSchema = z.object({
  threadId: z.string(),
  providerId: z.string(),
  title: z.string(),
  state: z.enum([
    "scheduled",
    "compacting",
    "compacted",
    "skipped",
    "active",
    "expired",
    "failed",
  ]),
  ttlSource: z
    .enum([
      "compaction-offer",
      "provider-ttl",
      "provider-fallback-ttl",
      "fallback-ttl",
    ])
    .nullable(),
  method: z.enum(["native", "slash-command"]).nullable(),
  usedTokens: z.number().nullable(),
  latestEventSeq: z.number().nullable(),
  compactedForSeq: z.number().nullable(),
  expiresAtMs: z.number().nullable(),
  compactAtMs: z.number().nullable(),
  compactionStartedAtMs: z.number().nullable(),
  lastCompactedAtMs: z.number().nullable(),
  lastReason: z.string().nullable(),
  optedOut: z.boolean(),
  updatedAtMs: z.number(),
  compactInMs: z.number().nullable(),
  expiresInMs: z.number().nullable(),
});

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({
      config: z.object({
        enabled: z.boolean(),
        minTokens: z.number(),
        leadMinutes: z.number(),
        providers: z.array(z.string()),
        fallbackTtlMinutes: z.number(),
        fallbackTtlMinutesByProvider: z.record(z.string(), z.number()),
        cooldownMinutes: z.number(),
        skipWithActiveChildren: z.boolean(),
      }),
      tracked: z.array(trackedThreadSchema),
    }),
  },
  reconcile: {
    input: z.null(),
    output: z.object({
      scanned: z.number(),
      scheduled: z.number(),
    }),
  },
  compact_now: {
    input: z.object({
      threadId: z.string().trim().min(1),
      force: z.boolean().optional(),
    }),
    output: z.object({
      threadId: z.string(),
      compacted: z.boolean(),
      method: z.enum(["native", "slash-command"]).nullable(),
      reason: z.string(),
    }),
  },
  set_opt_out: {
    input: z.object({
      threadId: z.string().trim().min(1),
      optedOut: z.boolean(),
    }),
    output: z.object({
      threadId: z.string(),
      optedOut: z.boolean(),
    }),
  },
});

const CHANGED_CHANNEL = "changed";

type ThreadEventRow = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>
>[number];
type ThreadGetResponse = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["get"]>
>;
type ThreadListItem = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["list"]>
>[number];
type ThreadSummary = ThreadGetResponse | ThreadListItem;
type PendingInteractionRow = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["interactions"]["list"]>
>[number];

const MAX_SLEEP_MS = 60_000;
const STALE_COMPACTING_MS = 10 * 60_000;
const RECONCILE_PAGE_LIMIT = 100;
const STATUS_DISPLAY_LIMIT = 50;

/** Providers inspected for pre-expiry compaction on a fresh install. */
export const DEFAULT_PROVIDERS =
  "claude-code,pi,antigravity-cli,acp-opencode,acp-omp";

function extractPromptCacheTtlMs(row: ThreadEventRow): number | null {
  if (row.type !== "thread/tokenUsage/updated") return null;
  const ttl = row.data.tokenUsage.promptCacheTtlMs;
  return typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0 ? ttl : null;
}

function isSlashCompactInput(row: ThreadEventRow): boolean {
  if (row.type !== "client/turn/requested") return false;
  const blocks = row.data.input;
  if (!Array.isArray(blocks) || blocks.length !== 1) return false;
  const first = blocks[0];
  if (first === undefined || first.type !== "text") return false;
  return first.text.trim() === "/compact";
}

function parseIsoTimestampMs(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDurationMs(ms: number): string {
  const absSec = Math.max(0, Math.round(Math.abs(ms) / 1000));
  if (absSec < 60) return `${absSec}s`;
  const mins = Math.floor(absSec / 60);
  const secs = absSec % 60;
  if (mins < 60) return secs === 0 ? `${mins}m` : `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins === 0 ? `${hours}h` : `${hours}h ${remMins}m`;
}

/**
 * Name a tracked thread's TTL source and, when the lifetime is an assumption,
 * the minutes in play. A measured hour and a guessed 5 minutes must not read
 * with the same confidence.
 */
function describeTtlSource(
  record: Pick<TrackedThreadRecord, "ttlSource" | "providerId">,
  config: Pick<
    CacheCompactConfig,
    "fallbackTtlMinutes" | "fallbackTtlMinutesByProvider"
  >,
): string | null {
  if (record.ttlSource === null) return null;
  if (record.ttlSource === "provider-fallback-ttl") {
    const assumedMinutes = config.fallbackTtlMinutesByProvider.get(
      record.providerId.toLowerCase(),
    );
    return assumedMinutes === undefined
      ? "via=provider-fallback-ttl"
      : `via=provider-fallback-ttl ${assumedMinutes}m assumed`;
  }
  if (record.ttlSource === "fallback-ttl") {
    return `via=fallback-ttl ${config.fallbackTtlMinutes}m assumed (global)`;
  }
  return `via=${record.ttlSource}`;
}

/**
 * Expand a machine-readable skip reason for the human `status` listing. Only
 * reasons whose token is not self-explanatory are rewritten; `lastReason`
 * itself stays exactly as stored for `status --json`.
 */
function describeSkipReason(reason: string): string {
  return reason === "discovered-late"
    ? `discovered late (met inside the ${Math.round(ARMING_DELAY_MS / 1000)}s arming window)`
    : reason;
}

function displayThreadTitle(
  thread: Pick<ThreadSummary, "title" | "titleFallback" | "id">,
): string {
  const candidate =
    (thread.title ?? "").trim() || (thread.titleFallback ?? "").trim() || thread.id;
  return candidate.length > 80 ? `${candidate.slice(0, 77)}...` : candidate;
}

function normalizeQueuedWork(thread: ThreadSummary): string {
  if ("queuedWork" in thread) {
    return thread.queuedWork;
  }
  return thread.queuedMessageCount > 0 ? "queued" : "none";
}

function normalizeActivity(thread: ThreadSummary) {
  if ("activity" in thread) {
    return thread.activity;
  }
  return {
    activeBackgroundAgentCount: thread.activeBackgroundAgentCount,
    activeBackgroundCommandCount: 0,
    activePlanModeCount: 0,
    activeWorkflowCount: 0,
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export default async function plugin(bb: BbPluginApi) {
  const store = createCacheCompactStore(bb);

  const settings = bb.settings.define({
    enabled: {
      type: "boolean",
      label: "Enable proactive cache compaction",
      description:
        "Automatically compact eligible idle threads shortly before their prompt cache expires.",
      default: true,
    },
    minTokens: {
      type: "number",
      label: "Minimum context tokens",
      description:
        "Only compact idle threads whose recorded context usage is at least this many tokens.",
      experimental_schema: z.number().int().min(1000).max(2_000_000),
      default: 100_000,
    },
    leadMinutes: {
      type: "number",
      label: "Compact before expiry (minutes)",
      description:
        "How many minutes before the prompt cache expires to trigger compaction.",
      experimental_schema: z.number().int().min(1).max(30),
      default: 3,
    },
    providers: {
      type: "string",
      label: "Providers",
      description:
        "Comma-separated provider IDs eligible for proactive pre-expiry compaction (for example: claude-code,pi,antigravity-cli,acp-opencode,acp-omp).",
      experimental_schema: z
        .string()
        .max(512, "Provider list must be at most 512 characters."),
      default: DEFAULT_PROVIDERS,
    },
    fallbackTtlMinutes: {
      type: "number",
      label: "Fallback cache TTL (minutes)",
      description:
        "Assumed prompt cache lifetime for providers that do not report promptCacheTtlMs (such as Antigravity CLI). Providers that report a TTL always use their exact value.",
      experimental_schema: z.number().int().min(0).max(1440),
      default: 60,
    },
    fallbackTtlMinutesByProvider: {
      type: "string",
      label: "Per-provider fallback TTL (minutes)",
      description:
        "Comma-separated provider=minutes assumptions for providers that report no cache lifetime, for example acp-opencode=5,acp-omp=60. These are documented guesses, not measurements. A listed provider uses this value instead of the global fallback; 0 disables the assumption for that provider.",
      experimental_schema: z
        .string()
        .max(1024, "Per-provider TTL list must be at most 1024 characters.")
        .superRefine((value, ctx) => {
          try {
            parseProviderTtlOverrides(value);
          } catch (error) {
            ctx.addIssue({ code: "custom", message: formatError(error) });
          }
        }),
      default: DEFAULT_FALLBACK_TTL_BY_PROVIDER,
    },
    cooldownMinutes: {
      type: "number",
      label: "Per-thread cooldown (minutes)",
      description:
        "Minimum interval between automatic compactions on the same thread.",
      experimental_schema: z.number().int().min(1).max(1440),
      default: 10,
    },
    skipWithActiveChildren: {
      type: "boolean",
      label: "Wait for active child threads",
      description:
        "Skip compacting a parent thread while any of its child threads are still running.",
      default: true,
    },
  });

  const unsupportedNativeProviders = new Set<string>();
  const inFlightThreads = new Set<string>();
  const wakeWaiters = new Set<() => void>();

  function wakeScheduler(): void {
    for (const wake of wakeWaiters) {
      wake();
    }
    wakeWaiters.clear();
  }

  function notifyChanged(): void {
    bb.realtime.publish(CHANGED_CHANNEL, { updatedAtMs: Date.now() });
  }

  async function readStatusPayload() {
    const config = await readConfig();
    const records = store.listAll(STATUS_DISPLAY_LIMIT);
    const nowMs = Date.now();
    return {
      config: {
        enabled: config.enabled,
        minTokens: config.minTokens,
        leadMinutes: config.leadMinutes,
        providers: [...config.providers],
        fallbackTtlMinutes: config.fallbackTtlMinutes,
        fallbackTtlMinutesByProvider: Object.fromEntries(
          config.fallbackTtlMinutesByProvider,
        ),
        cooldownMinutes: config.cooldownMinutes,
        skipWithActiveChildren: config.skipWithActiveChildren,
      },
      tracked: records.map((rec) => ({
        ...rec,
        compactInMs: rec.compactAtMs === null ? null : rec.compactAtMs - nowMs,
        expiresInMs: rec.expiresAtMs === null ? null : rec.expiresAtMs - nowMs,
      })),
    };
  }

  function sleepUntil(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        wakeWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      wakeWaiters.add(done);
    });
  }

  async function readConfig(): Promise<CacheCompactConfig> {
    const raw = await settings.get();
    return {
      enabled: raw.enabled,
      minTokens: raw.minTokens,
      leadMinutes: raw.leadMinutes,
      providers: parseProviderList(raw.providers),
      fallbackTtlMinutes: raw.fallbackTtlMinutes,
      fallbackTtlMinutesByProvider: parseProviderTtlOverrides(
        raw.fallbackTtlMinutesByProvider,
      ),
      cooldownMinutes: raw.cooldownMinutes,
      skipWithActiveChildren: raw.skipWithActiveChildren,
    };
  }

  async function withThreadLock<T>(
    threadId: string,
    fn: () => Promise<T>,
  ): Promise<T | null> {
    if (inFlightThreads.has(threadId)) return null;
    inFlightThreads.add(threadId);
    try {
      return await fn();
    } finally {
      inFlightThreads.delete(threadId);
    }
  }

  async function inspectThread(
    thread: ThreadSummary,
    signal?: AbortSignal,
  ): Promise<ThreadInspection> {
    const threadId = thread.id;
    const [
      headState,
      tokenEvents,
      turnCompletedEvents,
      compactedEvents,
      inputEvents,
      pendingInteractions,
      childThreads,
    ] = await Promise.all([
      bb.sdk.threads.experimental_headState({ threadId, signal }),
      bb.sdk.threads.events
        .list({
          threadId,
          types: ["thread/tokenUsage/updated"],
          order: "desc",
          limit: "1",
          signal,
        })
        .catch(() => [] as ThreadEventRow[]),
      bb.sdk.threads.events
        .list({
          threadId,
          types: ["turn/completed"],
          order: "desc",
          limit: "1",
          signal,
        })
        .catch(() => [] as ThreadEventRow[]),
      bb.sdk.threads.events
        .list({
          threadId,
          types: ["thread/compacted"],
          order: "desc",
          limit: "1",
          signal,
        })
        .catch(() => [] as ThreadEventRow[]),
      bb.sdk.threads.events
        .list({
          threadId,
          types: ["client/turn/requested"],
          order: "desc",
          limit: "1",
          signal,
        })
        .catch(() => [] as ThreadEventRow[]),
      bb.sdk.threads.interactions
        .list({ threadId, signal })
        .catch(() => [] as PendingInteractionRow[]),
      bb.sdk.threads
        .list({ parentThreadId: threadId, includeHidden: true, limit: 20, signal })
        .catch(() => [] as ThreadListItem[]),
    ]);

    const latestTokenRow = tokenEvents[0] ?? null;
    const latestTurnRow = turnCompletedEvents[0] ?? null;
    const latestCompactedRow = compactedEvents[0] ?? null;
    const latestInputRow = inputEvents[0] ?? null;

    const usage = headState.contextWindowUsage;
    const advertisesCompactCommand =
      headState.providerCommands?.some((command) => command.name === "compact") ??
      false;
    const hasPendingInteractions = pendingInteractions.some(
      (interaction) => interaction.status === "pending",
    );
    const hasActiveChildren = childThreads.some(
      (child) =>
        child.archivedAt === null &&
        child.deletedAt === null &&
        (child.status === "active" ||
          child.status === "starting" ||
          child.status === "pending"),
    );

    return {
      threadId,
      providerId: thread.providerId,
      title: displayThreadTitle(thread),
      status: thread.status,
      archivedAt: thread.archivedAt,
      deletedAt: thread.deletedAt,
      queuedWork: normalizeQueuedWork(thread),
      updatedAt: thread.updatedAt,
      activity: normalizeActivity(thread),
      usedTokens: usage?.usedTokens ?? null,
      modelContextWindow: usage?.modelContextWindow ?? null,
      compactionOfferAtMs: parseIsoTimestampMs(usage?.compactionOfferAt),
      tokenUsageEvent:
        latestTokenRow === null
          ? null
          : {
              seq: latestTokenRow.seq,
              createdAtMs: latestTokenRow.createdAt,
              promptCacheTtlMs: extractPromptCacheTtlMs(latestTokenRow),
            },
      latestTurnCompleted:
        latestTurnRow === null
          ? null
          : {
              seq: latestTurnRow.seq,
              createdAtMs: latestTurnRow.createdAt,
            },
      latestCompactedSeq: latestCompactedRow?.seq ?? null,
      latestUserInputWasCompact:
        latestInputRow !== null && isSlashCompactInput(latestInputRow),
      latestUserInputSeq: latestInputRow?.seq ?? null,
      hasPendingInteractions,
      hasActiveChildren,
      advertisesCompactCommand,
      nativeCompactionUnsupported: unsupportedNativeProviders.has(
        thread.providerId.toLowerCase(),
      ),
    };
  }

  async function evaluateAndRecordThread(
    thread: ThreadSummary,
    signal?: AbortSignal,
  ): Promise<{
    readonly inspection: ThreadInspection;
    readonly record: TrackedThreadRecord;
    readonly eligibility: ReturnType<typeof evaluateEligibility>;
  }> {
    const nowMs = Date.now();
    const config = await readConfig();
    const existing = store.get(thread.id);
    const inspection = await inspectThread(thread, signal);
    const latestSeq = latestActivitySequence(inspection);

    // If our plugin initiated a compaction and the thread just landed back in idle,
    // seal it as compacted so the /compact turn itself never triggers another schedule.
    if (
      existing !== null &&
      existing.state === "compacting" &&
      thread.status === "idle" &&
      (existing.compactionStartedAtMs === null ||
        nowMs - existing.compactionStartedAtMs < STALE_COMPACTING_MS)
    ) {
      const sealed: TrackedThreadRecord = {
        ...existing,
        providerId: thread.providerId,
        title: inspection.title,
        state: "compacted",
        usedTokens: inspection.usedTokens,
        latestEventSeq: latestSeq,
        compactedForSeq: Math.max(latestSeq, existing.compactedForSeq ?? 0),
        compactAtMs: null,
        compactionStartedAtMs: null,
        lastCompactedAtMs: nowMs,
        lastReason: "compacted-before-cache-expiry",
        updatedAtMs: nowMs,
      };
      store.upsert(sealed);
      notifyChanged();
      bb.log.info(
        `compaction completed for ${thread.id} (${thread.providerId}); now ${inspection.usedTokens ?? "unknown"} tokens`,
      );
      return {
        inspection,
        record: sealed,
        eligibility: {
          kind: "skip",
          reason: "already-compacted",
          detail: "Completed automatic pre-expiry compaction.",
          expiresAtMs: sealed.expiresAtMs,
          ttlSource: sealed.ttlSource,
          method: sealed.method,
          usedTokens: inspection.usedTokens,
          latestEventSeq: latestSeq,
        },
      };
    }

    const eligibility = evaluateEligibility({
      config,
      inspection,
      prior: {
        compactedForSeq: existing?.compactedForSeq ?? null,
        lastCompactedAtMs: existing?.lastCompactedAtMs ?? null,
        optedOut: existing?.optedOut ?? false,
        firstSeenAtMs: existing?.firstSeenAtMs ?? null,
      },
      nowMs,
      explicitCompaction: false,
    });

    const record: TrackedThreadRecord =
      eligibility.kind === "schedule"
        ? {
            threadId: thread.id,
            providerId: thread.providerId,
            title: inspection.title,
            state: "scheduled",
            ttlSource: eligibility.ttlSource,
            method: eligibility.method,
            usedTokens: eligibility.usedTokens,
            latestEventSeq: eligibility.latestEventSeq,
            compactedForSeq: existing?.compactedForSeq ?? null,
            expiresAtMs: eligibility.expiresAtMs,
            compactAtMs: eligibility.compactAtMs,
            compactionStartedAtMs: null,
            lastCompactedAtMs: existing?.lastCompactedAtMs ?? null,
            lastReason: null,
            optedOut: existing?.optedOut ?? false,
            firstSeenAtMs: existing?.firstSeenAtMs ?? nowMs,
            updatedAtMs: nowMs,
          }
        : {
            threadId: thread.id,
            providerId: thread.providerId,
            title: inspection.title,
            state:
              eligibility.reason === "already-expired"
                ? "expired"
                : eligibility.reason === "already-compacted"
                  ? "compacted"
                  : "skipped",
            ttlSource: eligibility.ttlSource,
            method: eligibility.method,
            usedTokens: eligibility.usedTokens,
            latestEventSeq: eligibility.latestEventSeq,
            compactedForSeq: existing?.compactedForSeq ?? null,
            expiresAtMs: eligibility.expiresAtMs,
            compactAtMs: null,
            compactionStartedAtMs: null,
            lastCompactedAtMs: existing?.lastCompactedAtMs ?? null,
            lastReason: eligibility.reason,
            optedOut: existing?.optedOut ?? false,
            firstSeenAtMs: existing?.firstSeenAtMs ?? nowMs,
            updatedAtMs: nowMs,
          };

    store.upsert(record);
    notifyChanged();
    if (eligibility.kind === "schedule") {
      bb.log.info(
        `scheduled ${thread.id} (${thread.providerId}, ${eligibility.method}, ${eligibility.ttlSource}) to compact in ${formatDurationMs(eligibility.compactAtMs - nowMs)} (cache expires in ${formatDurationMs(eligibility.expiresAtMs - nowMs)}, ${eligibility.usedTokens} tokens)`,
      );
      wakeScheduler();
    }

    return { inspection, record, eligibility };
  }

  async function dispatchCompaction(input: {
    readonly threadId: string;
    readonly providerId: string;
    readonly method: CompactionMethodKind;
    readonly advertisesCompactCommand: boolean;
    readonly signal?: AbortSignal;
  }): Promise<CompactionMethodKind> {
    if (input.method === "native") {
      try {
        await bb.sdk.threads.compact({
          threadId: input.threadId,
          signal: input.signal,
        });
        return "native";
      } catch (error) {
        if (
          isUnsupportedCompactionError(error) &&
          input.advertisesCompactCommand
        ) {
          unsupportedNativeProviders.add(input.providerId.toLowerCase());
          bb.log.info(
            `provider ${input.providerId} refused native compaction; falling back to /compact slash command for ${input.threadId}`,
          );
          await bb.sdk.threads.send({
            threadId: input.threadId,
            mode: "auto",
            input: [{ type: "text", text: "/compact", mentions: [] }],
          });
          return "slash-command";
        }
        throw error;
      }
    }

    await bb.sdk.threads.send({
      threadId: input.threadId,
      mode: "auto",
      input: [{ type: "text", text: "/compact", mentions: [] }],
    });
    return "slash-command";
  }

  async function runCompactionForThread(
    threadId: string,
    options: {
      readonly force?: boolean;
      readonly explicitCompaction?: boolean;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<{
    readonly compacted: boolean;
    readonly method: CompactionMethodKind | null;
    readonly reason: string;
  }> {
    const locked = await withThreadLock(threadId, async () => {
      const nowMs = Date.now();
      const thread = await bb.sdk.threads.get({
        threadId,
        signal: options.signal,
      });
      const existing = store.get(threadId);
      const inspection = await inspectThread(thread, options.signal);
      const latestSeq = latestActivitySequence(inspection);

      let chosenMethod: CompactionMethodKind;

      if (options.force === true) {
        if (thread.archivedAt !== null || thread.deletedAt !== null) {
          return {
            compacted: false,
            method: null,
            reason: "Thread is archived or deleted.",
          };
        }
        if (thread.status !== "idle" && thread.status !== "error") {
          return {
            compacted: false,
            method: null,
            reason: `Thread status is "${thread.status}"; wait until it is idle.`,
          };
        }
        const resolved = resolveCompactionMethod({
          providerId: thread.providerId,
          advertisesCompactCommand: inspection.advertisesCompactCommand,
          nativeCompactionUnsupported: inspection.nativeCompactionUnsupported,
        });
        if (resolved.kind === "unsupported") {
          return {
            compacted: false,
            method: null,
            reason: resolved.reason,
          };
        }
        chosenMethod = resolved.kind;
      } else {
        const config = await readConfig();
        const eligibility = evaluateEligibility({
          config,
          inspection,
          prior: {
            compactedForSeq: existing?.compactedForSeq ?? null,
            lastCompactedAtMs: existing?.lastCompactedAtMs ?? null,
            optedOut: existing?.optedOut ?? false,
            firstSeenAtMs: existing?.firstSeenAtMs ?? null,
          },
          nowMs,
          explicitCompaction: options.explicitCompaction === true,
        });

        if (eligibility.kind === "skip") {
          store.upsert({
            threadId,
            providerId: thread.providerId,
            title: inspection.title,
            state:
              eligibility.reason === "already-expired"
                ? "expired"
                : eligibility.reason === "already-compacted"
                  ? "compacted"
                  : "skipped",
            ttlSource: eligibility.ttlSource,
            method: eligibility.method,
            usedTokens: eligibility.usedTokens,
            latestEventSeq: eligibility.latestEventSeq,
            compactedForSeq: existing?.compactedForSeq ?? null,
            expiresAtMs: eligibility.expiresAtMs,
            compactAtMs: null,
            compactionStartedAtMs: null,
            lastCompactedAtMs: existing?.lastCompactedAtMs ?? null,
            lastReason: eligibility.reason,
            optedOut: existing?.optedOut ?? false,
            firstSeenAtMs: existing?.firstSeenAtMs ?? nowMs,
            updatedAtMs: nowMs,
          });
          bb.log.info(
            `skipping due compaction for ${threadId}: ${eligibility.reason} (${eligibility.detail})`,
          );
          return {
            compacted: false,
            method: eligibility.method,
            reason: eligibility.detail,
          };
        }

        if (eligibility.compactAtMs > nowMs + 1000) {
          store.upsert({
            threadId,
            providerId: thread.providerId,
            title: inspection.title,
            state: "scheduled",
            ttlSource: eligibility.ttlSource,
            method: eligibility.method,
            usedTokens: eligibility.usedTokens,
            latestEventSeq: eligibility.latestEventSeq,
            compactedForSeq: existing?.compactedForSeq ?? null,
            expiresAtMs: eligibility.expiresAtMs,
            compactAtMs: eligibility.compactAtMs,
            compactionStartedAtMs: null,
            lastCompactedAtMs: existing?.lastCompactedAtMs ?? null,
            lastReason: null,
            optedOut: existing?.optedOut ?? false,
            firstSeenAtMs: existing?.firstSeenAtMs ?? nowMs,
            updatedAtMs: nowMs,
          });
          return {
            compacted: false,
            method: eligibility.method,
            reason: `Rescheduled for ${formatDurationMs(eligibility.compactAtMs - nowMs)} from now.`,
          };
        }

        chosenMethod = eligibility.method;
      }

      // Mark "compacting" BEFORE dispatching so the ensuing thread.active/thread.idle
      // transition is recognized as our own compaction turn.
      const compactingRecord: TrackedThreadRecord = {
        threadId,
        providerId: thread.providerId,
        title: inspection.title,
        state: "compacting",
        ttlSource: existing?.ttlSource ?? null,
        method: chosenMethod,
        usedTokens: inspection.usedTokens,
        latestEventSeq: latestSeq,
        compactedForSeq: Math.max(latestSeq, existing?.compactedForSeq ?? 0),
        expiresAtMs: existing?.expiresAtMs ?? null,
        compactAtMs: null,
        compactionStartedAtMs: nowMs,
        lastCompactedAtMs: existing?.lastCompactedAtMs ?? null,
        lastReason: "compacting",
        optedOut: existing?.optedOut ?? false,
        firstSeenAtMs: existing?.firstSeenAtMs ?? nowMs,
        updatedAtMs: nowMs,
      };
      store.upsert(compactingRecord);

      try {
        const usedMethod = await dispatchCompaction({
          threadId,
          providerId: thread.providerId,
          method: chosenMethod,
          advertisesCompactCommand: inspection.advertisesCompactCommand,
          signal: options.signal,
        });

        store.upsert({
          ...compactingRecord,
          method: usedMethod,
          // Native `threads.compact()` resolves once compaction is requested/completed;
          // if the thread never emits another thread.idle, lastCompactedAtMs still protects cooldown.
          lastCompactedAtMs: nowMs,
          updatedAtMs: Date.now(),
        });
        notifyChanged();
        bb.log.info(
          `triggered pre-expiry compaction for ${threadId} (${thread.providerId}) via ${usedMethod}`,
        );
        return {
          compacted: true,
          method: usedMethod,
          reason: `Triggered compaction via ${usedMethod}.`,
        };
      } catch (error) {
        const message = formatError(error);
        if (isUnsupportedCompactionError(error)) {
          unsupportedNativeProviders.add(thread.providerId.toLowerCase());
        }
        store.upsert({
          ...compactingRecord,
          state: "failed",
          compactionStartedAtMs: null,
          lastReason: message,
          updatedAtMs: Date.now(),
        });
        bb.log.warn(`compaction failed for ${threadId}: ${message}`);
        return {
          compacted: false,
          method: chosenMethod,
          reason: message,
        };
      }
    });

    if (locked === null) {
      return {
        compacted: false,
        method: null,
        reason: "Compaction check is already in flight for this thread.",
      };
    }
    return locked;
  }

  async function reconcileIdleThreads(signal?: AbortSignal): Promise<{
    readonly scanned: number;
    readonly scheduled: number;
  }> {
    const config = await readConfig();
    if (!config.enabled) {
      for (const scheduled of store.listScheduled()) {
        store.upsert({
          ...scheduled,
          state: "skipped",
          compactAtMs: null,
          lastReason: "plugin-disabled",
          updatedAtMs: Date.now(),
        });
      }
      return { scanned: 0, scheduled: 0 };
    }

    let offset = 0;
    let scanned = 0;
    let scheduled = 0;

    while (!(signal?.aborted ?? false)) {
      const threads = await bb.sdk.threads.list({
        archived: false,
        includeHidden: false,
        limit: RECONCILE_PAGE_LIMIT,
        offset,
        signal,
      });
      if (threads.length === 0) break;

      for (const thread of threads) {
        if (signal?.aborted) break;
        if (thread.status !== "idle") continue;
        if (!config.providers.has(thread.providerId.toLowerCase())) continue;
        scanned += 1;
        try {
          const outcome = await withThreadLock(thread.id, () =>
            evaluateAndRecordThread(thread, signal),
          );
          if (outcome?.eligibility.kind === "schedule") {
            scheduled += 1;
          }
        } catch (error) {
          bb.log.warn(
            `reconcile failed for ${thread.id}: ${formatError(error)}`,
          );
        }
      }

      if (threads.length < RECONCILE_PAGE_LIMIT) break;
      offset += threads.length;
    }

    return { scanned, scheduled };
  }

  // Register lifecycle handlers FIRST before starting background reconciliation.
  bb.events.on("thread.idle", async ({ thread }) => {
    try {
      await withThreadLock(thread.id, () => evaluateAndRecordThread(thread));
    } catch (error) {
      bb.log.warn(
        `failed to evaluate idle thread ${thread.id}: ${formatError(error)}`,
      );
    }
  });

  bb.events.on("thread.active", ({ thread }) => {
    const existing = store.get(thread.id);
    if (existing === null) return;
    if (existing.state === "compacting") return;
    if (existing.state === "scheduled") {
      store.upsert({
        ...existing,
        title: displayThreadTitle(thread),
        state: "active",
        compactAtMs: null,
        lastReason: "thread-became-active",
        updatedAtMs: Date.now(),
      });
      wakeScheduler();
    }
  });

  bb.events.on("thread.failed", ({ thread, error }) => {
    const existing = store.get(thread.id);
    if (existing === null) return;
    if (existing.state === "compacting" || existing.state === "scheduled") {
      store.upsert({
        ...existing,
        title: displayThreadTitle(thread),
        state: "failed",
        compactAtMs: null,
        compactionStartedAtMs: null,
        lastReason: error ?? "thread-failed",
        updatedAtMs: Date.now(),
      });
      wakeScheduler();
    }
  });

  bb.events.on("thread.archived", ({ thread }) => {
    store.delete(thread.id);
    wakeScheduler();
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    store.delete(thread.id);
    wakeScheduler();
  });

  settings.onChange(() => {
    bb.log.info("settings changed; re-reconciling idle threads");
    void reconcileIdleThreads().catch((error) => {
      bb.log.warn(`settings reconcile failed: ${formatError(error)}`);
    });
    wakeScheduler();
  });

  bb.background.service("cache-compact-scheduler", {
    async start(signal) {
      try {
        const result = await reconcileIdleThreads(signal);
        bb.log.info(
          `startup reconciliation scanned ${result.scanned} idle threads, scheduled ${result.scheduled}`,
        );
      } catch (error) {
        if (!signal.aborted) {
          bb.log.warn(`startup reconciliation failed: ${formatError(error)}`);
        }
      }

      while (!signal.aborted) {
        const nowMs = Date.now();
        const due = store.listDue(nowMs);
        for (const item of due) {
          if (signal.aborted) break;
          await runCompactionForThread(item.threadId, { signal });
        }

        if (signal.aborted) break;
        const nextAtMs = store.nextCompactAtMs();
        const waitMs =
          nextAtMs === null
            ? MAX_SLEEP_MS
            : Math.min(MAX_SLEEP_MS, Math.max(250, nextAtMs - Date.now()));
        await sleepUntil(waitMs, signal);
      }
    },
  });

  function resolveThreadId(
    positional: string | undefined,
    ctxThreadId: string | undefined,
  ): string {
    const candidate = positional ?? ctxThreadId;
    if (candidate === undefined || candidate.trim() === "") {
      throw new PluginCliError("missing thread id", {
        code: "missing_thread_id",
        hint: "Pass a thread ID explicitly or run inside a BB thread.",
      });
    }
    return candidate.trim();
  }

  bb.rpc.register(rpcContract, {
    status: () => readStatusPayload(),
    reconcile: async (_input, { experimental_signal }) => {
      const result = await reconcileIdleThreads(experimental_signal);
      notifyChanged();
      return result;
    },
    compact_now: async ({ threadId, force }, { experimental_signal }) => {
      const outcome = await runCompactionForThread(threadId, {
        force: force === true,
        explicitCompaction: true,
        signal: experimental_signal,
      });
      notifyChanged();
      return { threadId, ...outcome };
    },
    set_opt_out: async ({ threadId, optedOut }, { experimental_signal }) => {
      store.setOptOut(threadId, optedOut, Date.now());
      if (!optedOut) {
        try {
          const thread = await bb.sdk.threads.get({
            threadId,
            signal: experimental_signal,
          });
          await withThreadLock(threadId, () =>
            evaluateAndRecordThread(thread, experimental_signal),
          );
        } catch (error) {
          bb.log.warn(
            `failed to re-evaluate opted-in thread ${threadId}: ${formatError(error)}`,
          );
        }
      }
      wakeScheduler();
      notifyChanged();
      return { threadId, optedOut };
    },
  });

  bb.cli.register(
    defineCli({
      name: "cache-compact",
      summary: "Proactive pre-cache-expiry thread compaction",
      commands: {
        status: cliCommand({
          summary: "Show Cache Compact settings and scheduled/recent threads",
          options: {
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input) {
            const config = await readConfig();
            const records = store.listAll(STATUS_DISPLAY_LIMIT);
            const nowMs = Date.now();
            const payload = {
              config: {
                enabled: config.enabled,
                minTokens: config.minTokens,
                leadMinutes: config.leadMinutes,
                providers: [...config.providers],
                fallbackTtlMinutes: config.fallbackTtlMinutes,
                fallbackTtlMinutesByProvider: Object.fromEntries(
                  config.fallbackTtlMinutesByProvider,
                ),
                cooldownMinutes: config.cooldownMinutes,
                skipWithActiveChildren: config.skipWithActiveChildren,
              },
              tracked: records.map((rec) => ({
                ...rec,
                compactInMs:
                  rec.compactAtMs === null ? null : rec.compactAtMs - nowMs,
                expiresInMs:
                  rec.expiresAtMs === null ? null : rec.expiresAtMs - nowMs,
              })),
            };
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify(payload, null, 2) };
            }
            const assumedTtls = [...config.fallbackTtlMinutesByProvider]
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([providerId, minutes]) => `${providerId}=${minutes}m`)
              .join(", ");
            const lines = [
              `Cache Compact: ${config.enabled ? "enabled" : "disabled"}`,
              `  Providers: ${[...config.providers].join(", ") || "(none)"}`,
              `  Min tokens: ${config.minTokens.toLocaleString("en-US")} | Lead: ${config.leadMinutes}m | Fallback TTL: ${config.fallbackTtlMinutes}m | Cooldown: ${config.cooldownMinutes}m`,
              `  Assumed TTLs: ${assumedTtls || "(none)"}`,
              "",
            ];
            if (records.length === 0) {
              lines.push("No tracked threads yet.");
            } else {
              lines.push(`Tracked threads (${records.length}):`);
              for (const rec of records) {
                const tokens =
                  rec.usedTokens === null
                    ? "?"
                    : `${Math.round(rec.usedTokens / 1000)}k`;
                const timing =
                  rec.state === "scheduled" &&
                  rec.compactAtMs !== null &&
                  rec.expiresAtMs !== null
                    ? `compact in ${formatDurationMs(rec.compactAtMs - nowMs)} (cache expires in ${formatDurationMs(rec.expiresAtMs - nowMs)})`
                    : describeSkipReason(rec.lastReason ?? rec.state);
                const opt = rec.optedOut ? " [opted-out]" : "";
                const ttl = describeTtlSource(rec, config);
                const ttlField = ttl === null ? "" : `  ${ttl}`;
                lines.push(
                  `  ${rec.threadId}  [${rec.state}]${opt}  ${rec.providerId}  ${tokens}${ttlField}  ${timing}`,
                );
              }
            }
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        check: cliCommand({
          summary: "Inspect a thread's cache TTL and compaction eligibility",
          positionals: [
            {
              name: "thread-id",
              description: "Thread ID (defaults to current BB thread)",
              required: false,
            },
          ],
          options: {
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input, ctx) {
            const threadId = resolveThreadId(
              input.positionals["thread-id"],
              ctx.threadId,
            );
            const thread = await bb.sdk.threads.get({
              threadId,
              signal: ctx.signal,
            });
            const nowMs = Date.now();
            const config = await readConfig();
            const existing = store.get(threadId);
            const inspection = await inspectThread(thread, ctx.signal);
            const eligibility = evaluateEligibility({
              config,
              inspection,
              prior: {
                compactedForSeq: existing?.compactedForSeq ?? null,
                lastCompactedAtMs: existing?.lastCompactedAtMs ?? null,
                optedOut: existing?.optedOut ?? false,
                firstSeenAtMs: existing?.firstSeenAtMs ?? null,
              },
              nowMs,
              explicitCompaction: false,
            });
            const result = {
              threadId,
              providerId: thread.providerId,
              status: thread.status,
              usedTokens: inspection.usedTokens,
              modelContextWindow: inspection.modelContextWindow,
              advertisesCompactCommand: inspection.advertisesCompactCommand,
              optedOut: existing?.optedOut ?? false,
              eligibility,
            };
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
            }
            const lines = [
              `Thread: ${threadId} (${thread.providerId}, status=${thread.status})`,
              `Context: ${inspection.usedTokens?.toLocaleString("en-US") ?? "unknown"} / ${inspection.modelContextWindow?.toLocaleString("en-US") ?? "unknown"} tokens`,
              `Advertises /compact: ${inspection.advertisesCompactCommand ? "yes" : "no"}`,
            ];
            if (eligibility.kind === "schedule") {
              lines.push(
                `Decision: SCHEDULE via ${eligibility.method} (${eligibility.ttlSource})`,
              );
              lines.push(
                `Compact in: ${formatDurationMs(eligibility.compactAtMs - nowMs)} (expires in ${formatDurationMs(eligibility.expiresAtMs - nowMs)})`,
              );
            } else {
              lines.push(`Decision: SKIP (${eligibility.reason}) — ${eligibility.detail}`);
            }
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        now: cliCommand({
          summary: "Compact a thread immediately using its resolved compaction method",
          positionals: [
            {
              name: "thread-id",
              description: "Thread ID (defaults to current BB thread)",
              required: false,
            },
          ],
          options: {
            force: {
              type: "boolean",
              description: "Bypass minTokens, TTL, and opt-out checks",
            },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input, ctx) {
            const threadId = resolveThreadId(
              input.positionals["thread-id"],
              ctx.threadId,
            );
            const outcome = await runCompactionForThread(threadId, {
              force: input.options.force === true,
              explicitCompaction: true,
              signal: ctx.signal,
            });
            if (input.options.json) {
              return {
                exitCode: outcome.compacted ? 0 : 1,
                stdout: JSON.stringify({ threadId, ...outcome }, null, 2),
              };
            }
            return {
              exitCode: outcome.compacted ? 0 : 1,
              stdout: `${threadId}: ${outcome.reason}`,
            };
          },
        }),
        "opt-out": cliCommand({
          summary: "Disable automatic pre-expiry compaction for one thread",
          positionals: [
            {
              name: "thread-id",
              description: "Thread ID (defaults to current BB thread)",
              required: false,
            },
          ],
          options: {
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input, ctx) {
            const threadId = resolveThreadId(
              input.positionals["thread-id"],
              ctx.threadId,
            );
            const updated = store.setOptOut(threadId, true, Date.now());
            wakeScheduler();
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify(updated, null, 2) };
            }
            return {
              exitCode: 0,
              stdout: `Opted ${threadId} out of automatic pre-expiry compaction.`,
            };
          },
        }),
        "opt-in": cliCommand({
          summary: "Re-enable automatic pre-expiry compaction for one thread",
          positionals: [
            {
              name: "thread-id",
              description: "Thread ID (defaults to current BB thread)",
              required: false,
            },
          ],
          options: {
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input, ctx) {
            const threadId = resolveThreadId(
              input.positionals["thread-id"],
              ctx.threadId,
            );
            store.setOptOut(threadId, false, Date.now());
            const thread = await bb.sdk.threads.get({
              threadId,
              signal: ctx.signal,
            });
            const result = await withThreadLock(threadId, () =>
              evaluateAndRecordThread(thread, ctx.signal),
            );
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify(
                  { threadId, optedOut: false, eligibility: result?.eligibility ?? null },
                  null,
                  2,
                ),
              };
            }
            return {
              exitCode: 0,
              stdout: `Opted ${threadId} back in to automatic pre-expiry compaction.`,
            };
          },
        }),
        reconcile: cliCommand({
          summary: "Re-scan idle threads and refresh scheduled compaction timers",
          options: {
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input, ctx) {
            const result = await reconcileIdleThreads(ctx.signal);
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
            }
            return {
              exitCode: 0,
              stdout: `Scanned ${result.scanned} idle threads; scheduled ${result.scheduled}.`,
            };
          },
        }),
      },
    }),
  );

  bb.onDispose(() => {
    wakeScheduler();
    bb.log.info("disposed");
  });

  bb.log.info("loaded");
}
