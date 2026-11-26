import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import {
  computeCompactAtMs,
  DEFAULT_FALLBACK_TTL_BY_PROVIDER,
  evaluateEligibility,
  parseProviderList,
  parseProviderTtlOverrides,
  resolveCacheTtl,
  resolveCompactionMethod,
  type CacheCompactConfig,
  type FallbackTtlSettings,
  type ThreadInspection,
} from "./policy.js";
import plugin, { DEFAULT_PROVIDERS } from "./server.js";

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));

function makeTtlSettings(
  overrides: Partial<FallbackTtlSettings> = {},
): FallbackTtlSettings {
  return {
    fallbackTtlMinutes: 60,
    fallbackTtlMinutesByProvider: parseProviderTtlOverrides(
      DEFAULT_FALLBACK_TTL_BY_PROVIDER,
    ),
    ...overrides,
  };
}

function makeConfig(overrides: Partial<CacheCompactConfig> = {}): CacheCompactConfig {
  return {
    enabled: true,
    minTokens: 100_000,
    leadMinutes: 3,
    providers: parseProviderList(
      "claude-code,pi,antigravity-cli,acp-opencode,acp-omp",
    ),
    fallbackTtlMinutes: 60,
    fallbackTtlMinutesByProvider: makeTtlSettings().fallbackTtlMinutesByProvider,
    cooldownMinutes: 10,
    skipWithActiveChildren: true,
    ...overrides,
  };
}

function makeInspection(overrides: Partial<ThreadInspection> = {}): ThreadInspection {
  return {
    threadId: "thr_test",
    providerId: "claude-code",
    title: "Test thread",
    status: "idle",
    archivedAt: null,
    deletedAt: null,
    queuedWork: "none",
    updatedAt: 1_000_000,
    activity: {
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 0,
      activeWorkflowCount: 0,
    },
    usedTokens: 150_000,
    modelContextWindow: 1_000_000,
    compactionOfferAtMs: null,
    tokenUsageEvent: {
      seq: 20,
      createdAtMs: 1_000_000,
      promptCacheTtlMs: 60 * 60_000,
    },
    latestTurnCompleted: {
      seq: 21,
      createdAtMs: 1_000_500,
    },
    latestCompactedSeq: null,
    latestUserInputWasCompact: false,
    latestUserInputSeq: 18,
    hasPendingInteractions: false,
    hasActiveChildren: false,
    advertisesCompactCommand: false,
    nativeCompactionUnsupported: false,
    ...overrides,
  };
}

describe("policy", () => {
  it("resolves exact provider-ttl before compactionOfferAt and fallback", () => {
    const res = resolveCacheTtl(
      {
        providerId: "claude-code",
        compactionOfferAtMs: 9_999_999,
        tokenUsageEvent: { seq: 10, createdAtMs: 1_000_000, promptCacheTtlMs: 300_000 },
        latestTurnCompleted: { seq: 11, createdAtMs: 1_001_000 },
        updatedAt: 1_002_000,
      },
      makeTtlSettings(),
    );
    expect(res).toEqual({
      kind: "resolved",
      source: "provider-ttl",
      expiresAtMs: 1_300_000,
      ttlMs: 300_000,
      anchorAtMs: 1_000_000,
    });
  });

  it("falls back to compactionOfferAt when promptCacheTtlMs is absent", () => {
    const res = resolveCacheTtl(
      {
        providerId: "claude-code",
        compactionOfferAtMs: 4_600_000,
        tokenUsageEvent: null,
        latestTurnCompleted: null,
        updatedAt: 1_000_000,
      },
      makeTtlSettings(),
    );
    expect(res).toEqual({
      kind: "resolved",
      source: "compaction-offer",
      expiresAtMs: 4_600_000,
      ttlMs: null,
      anchorAtMs: null,
    });
  });

  it("uses fallback-ttl for antigravity-cli when no TTL is reported", () => {
    const res = resolveCacheTtl(
      {
        providerId: "antigravity-cli",
        compactionOfferAtMs: null,
        tokenUsageEvent: null,
        latestTurnCompleted: { seq: 12, createdAtMs: 2_000_000 },
        updatedAt: 2_500_000,
      },
      makeTtlSettings(),
    );
    expect(res).toEqual({
      kind: "resolved",
      source: "fallback-ttl",
      expiresAtMs: 2_000_000 + 3_600_000,
      ttlMs: 3_600_000,
      anchorAtMs: 2_000_000,
    });
  });

  it("uses a documented per-provider TTL anchored to the latest completed turn", () => {
    const res = resolveCacheTtl(
      {
        providerId: "acp-opencode",
        compactionOfferAtMs: null,
        tokenUsageEvent: null,
        latestTurnCompleted: { seq: 12, createdAtMs: 2_000_000 },
        updatedAt: 2_500_000,
      },
      makeTtlSettings(),
    );
    expect(res).toEqual({
      kind: "resolved",
      source: "provider-fallback-ttl",
      expiresAtMs: 2_000_000 + 5 * 60_000,
      ttlMs: 5 * 60_000,
      anchorAtMs: 2_000_000,
    });
  });

  it("uses the global fallback when the provider has no per-provider override", () => {
    const res = resolveCacheTtl(
      {
        providerId: "acp-omp",
        compactionOfferAtMs: null,
        tokenUsageEvent: null,
        latestTurnCompleted: { seq: 12, createdAtMs: 2_000_000 },
        updatedAt: 2_500_000,
      },
      makeTtlSettings({ fallbackTtlMinutesByProvider: new Map() }),
    );
    expect(res).toEqual({
      kind: "resolved",
      source: "fallback-ttl",
      expiresAtMs: 2_000_000 + 60 * 60_000,
      ttlMs: 60 * 60_000,
      anchorAtMs: 2_000_000,
    });
  });

  it("prefers a per-provider override over the global fallback", () => {
    const res = resolveCacheTtl(
      {
        providerId: "acp-opencode",
        compactionOfferAtMs: null,
        tokenUsageEvent: null,
        latestTurnCompleted: null,
        updatedAt: 1_000_000,
      },
      makeTtlSettings({
        fallbackTtlMinutes: 60,
        fallbackTtlMinutesByProvider: new Map([["acp-opencode", 90]]),
      }),
    );
    expect(res).toEqual({
      kind: "resolved",
      source: "provider-fallback-ttl",
      expiresAtMs: 1_000_000 + 90 * 60_000,
      ttlMs: 90 * 60_000,
      anchorAtMs: 1_000_000,
    });
  });

  it("rejects malformed per-provider TTL overrides", () => {
    const cases: ReadonlyArray<{ readonly raw: string; readonly offending: string }> = [
      { raw: "acp-omp", offending: "acp-omp" },
      { raw: "=5", offending: "=5" },
      { raw: "acp-omp=", offending: "acp-omp=" },
      { raw: "acp-omp=abc", offending: "acp-omp=abc" },
      { raw: "acp-omp=-5", offending: "acp-omp=-5" },
      { raw: "acp-omp=1441", offending: "acp-omp=1441" },
      { raw: "acp-omp=5,acp-omp=7", offending: "acp-omp=7" },
    ];
    for (const { raw, offending } of cases) {
      expect(() => parseProviderTtlOverrides(raw)).toThrow(Error);
      expect(() => parseProviderTtlOverrides(raw)).toThrow(offending);
    }
  });

  it("treats a per-provider override of 0 as no assumed TTL", () => {
    const res = resolveCacheTtl(
      {
        providerId: "acp-opencode",
        compactionOfferAtMs: null,
        tokenUsageEvent: null,
        latestTurnCompleted: { seq: 12, createdAtMs: 2_000_000 },
        updatedAt: 2_500_000,
      },
      makeTtlSettings({
        fallbackTtlMinutes: 60,
        fallbackTtlMinutesByProvider: new Map([["acp-opencode", 0]]),
      }),
    );
    expect(res.kind).toBe("none");
    if (res.kind === "none") {
      expect(res.reason).toContain("acp-opencode");
    }
  });

  it("lets an exact promptCacheTtlMs win over a per-provider override", () => {
    const res = resolveCacheTtl(
      {
        providerId: "acp-opencode",
        compactionOfferAtMs: null,
        tokenUsageEvent: { seq: 10, createdAtMs: 1_000_000, promptCacheTtlMs: 300_000 },
        latestTurnCompleted: null,
        updatedAt: 1_000_000,
      },
      makeTtlSettings({
        fallbackTtlMinutesByProvider: new Map([["acp-opencode", 90]]),
      }),
    );
    expect(res).toEqual({
      kind: "resolved",
      source: "provider-ttl",
      expiresAtMs: 1_300_000,
      ttlMs: 300_000,
      anchorAtMs: 1_000_000,
    });
  });

  it("clamps lead time when leadMinutes >= ttlMs (e.g. 5m cache with 5m lead)", () => {
    const res = computeCompactAtMs({
      nowMs: 1_000_000,
      expiresAtMs: 1_000_000 + 300_000,
      ttlMs: 300_000,
      leadMs: 300_000,
    });
    expect(res).toEqual({
      kind: "schedule",
      compactAtMs: 1_000_000 + 225_000,
      effectiveLeadMs: 75_000,
    });
  });

  it("refuses to compact an already-expired cache", () => {
    const res = evaluateEligibility({
      config: makeConfig(),
      inspection: makeInspection({
        tokenUsageEvent: { seq: 20, createdAtMs: 1_000_000, promptCacheTtlMs: 300_000 },
      }),
      prior: {
        compactedForSeq: null,
        lastCompactedAtMs: null,
        optedOut: false,
        firstSeenAtMs: null,
      },
      nowMs: 1_400_000,
      explicitCompaction: false,
    });
    expect(res.kind).toBe("skip");
    if (res.kind === "skip") {
      expect(res.reason).toBe("already-expired");
    }
  });

  it("selects slash-command compaction for antigravity-cli when /compact is advertised", () => {
    expect(
      resolveCompactionMethod({
        providerId: "antigravity-cli",
        advertisesCompactCommand: true,
        nativeCompactionUnsupported: false,
      }),
    ).toEqual({ kind: "slash-command", command: "/compact" });

    expect(
      resolveCompactionMethod({
        providerId: "antigravity-cli",
        advertisesCompactCommand: false,
        nativeCompactionUnsupported: false,
      }).kind,
    ).toBe("unsupported");
  });

  it("selects native compaction for OpenCode and Oh My Pi regardless of the /compact command", () => {
    for (const providerId of ["acp-opencode", "acp-omp"]) {
      expect(
        resolveCompactionMethod({
          providerId,
          advertisesCompactCommand: true,
          nativeCompactionUnsupported: false,
        }),
      ).toEqual({ kind: "native" });

      expect(
        resolveCompactionMethod({
          providerId,
          advertisesCompactCommand: false,
          nativeCompactionUnsupported: false,
        }),
      ).toEqual({ kind: "native" });
    }
  });

  it("includes OpenCode and Oh My Pi in the default provider list", () => {
    const providers = parseProviderList(DEFAULT_PROVIDERS);
    for (const providerId of [
      "claude-code",
      "pi",
      "antigravity-cli",
      "acp-opencode",
      "acp-omp",
    ]) {
      expect(providers.has(providerId)).toBe(true);
    }
  });

  it("skips threads below minTokens, excluded providers, active children, or recent /compact turns", () => {
    const baseNow = 1_010_000;
    const basePrior = {
      compactedForSeq: null,
      lastCompactedAtMs: null,
      optedOut: false,
      firstSeenAtMs: null,
    };

    const below = evaluateEligibility({
      config: makeConfig({ minTokens: 100_000 }),
      inspection: makeInspection({ usedTokens: 99_999 }),
      prior: basePrior,
      nowMs: baseNow,
      explicitCompaction: false,
    });
    expect(below.kind === "skip" && below.reason).toBe("below-min-tokens");

    const excluded = evaluateEligibility({
      config: makeConfig(),
      inspection: makeInspection({ providerId: "codex" }),
      prior: basePrior,
      nowMs: baseNow,
      explicitCompaction: false,
    });
    expect(excluded.kind === "skip" && excluded.reason).toBe("provider-excluded");

    const childActive = evaluateEligibility({
      config: makeConfig(),
      inspection: makeInspection({ hasActiveChildren: true }),
      prior: basePrior,
      nowMs: baseNow,
      explicitCompaction: false,
    });
    expect(childActive.kind === "skip" && childActive.reason).toBe("active-children");

    const alreadySlashCompacted = evaluateEligibility({
      config: makeConfig(),
      inspection: makeInspection({ latestUserInputWasCompact: true }),
      prior: basePrior,
      nowMs: baseNow,
      explicitCompaction: false,
    });
    expect(alreadySlashCompacted.kind === "skip" && alreadySlashCompacted.reason).toBe(
      "already-compacted",
    );
  });
});

describe("server plugin integration", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("imports only public SDK surfaces", async () => {
    const scan = await experimental_scanPublicSdkOnly(PACKAGE_ROOT, {
      allow: [/^react$/, /^sonner$/],
    });
    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
  });

  it("schedules and natively compacts a claude-code thread 3m before 1h cache expiry", async () => {
    vi.useFakeTimers();
    const startMs = Date.UTC(2026, 10, 20, 22, 0, 0);
    vi.setSystemTime(startMs);

    const claudeThread = makeThreadResponse({
      id: "thr_claude_1",
      providerId: "claude-code",
      status: "idle",
      updatedAt: startMs,
    });

    const compactFn = vi.fn(async () => ({ ok: true as const }));
    const { bb, harness } = createFakePluginHost({
      pluginId: "cache-compact",
      sdk: {
        threads: {
          list: async (args) =>
            args?.parentThreadId !== undefined ? [] : [claudeThread],
          get: async () => claudeThread,
          compact: compactFn,
          experimental_headState: async () => ({
            activePromptMode: null,
            contextWindowUsage: {
              estimated: false,
              modelContextWindow: 1_000_000,
              usedTokens: 160_000,
            },
            extensionStates: {},
            modelFallback: null,
            pendingTodos: null,
            providerCommands: null,
            sessionOptions: null,
          }),
          events: {
            list: async (args) => {
              if (args.types?.includes("thread/tokenUsage/updated")) {
                return [
                  {
                    id: "evt_1",
                    scope: { kind: "thread" as const },
                    threadId: claudeThread.id,
                    seq: 10,
                    createdAt: startMs,
                    type: "thread/tokenUsage/updated" as const,
                    data: {
                      providerThreadId: "pt_1",
                      tokenUsage: {
                        last: {
                          cachedInputTokens: 120_000,
                          inputTokens: 160_000,
                          outputTokens: 1_000,
                          reasoningOutputTokens: 0,
                          totalTokens: 161_000,
                        },
                        modelContextWindow: 1_000_000,
                        promptCacheTtlMs: 60 * 60_000,
                        total: {
                          cachedInputTokens: 120_000,
                          inputTokens: 160_000,
                          outputTokens: 1_000,
                          reasoningOutputTokens: 0,
                          totalTokens: 161_000,
                        },
                      },
                    },
                  },
                ];
              }
              return [];
            },
          },
          interactions: {
            list: async () => [],
          },
        },
      },
    });

    await plugin(bb);
    const service = harness.behavior.runService("cache-compact-scheduler");

    // Let startup reconcile settle
    await vi.advanceTimersByTimeAsync(1_000);
    expect(compactFn).not.toHaveBeenCalled();

    const statusBefore = await harness.behavior.runCli(["status", "--json"]);
    expect(statusBefore.exitCode).toBe(0);
    const parsedBefore = JSON.parse(statusBefore.stdout ?? "{}");
    expect(parsedBefore.tracked).toHaveLength(1);
    expect(parsedBefore.tracked[0].state).toBe("scheduled");
    expect(parsedBefore.tracked[0].method).toBe("native");
    expect(parsedBefore.tracked[0].ttlSource).toBe("provider-ttl");

    // Advance to 56m 59s (still 1s before the 57m mark) -> not yet compacted
    await vi.advanceTimersByTimeAsync(56 * 60_000 + 58_000);
    expect(compactFn).not.toHaveBeenCalled();

    // Cross 57m (3m before 60m expiry) -> compacts!
    await vi.advanceTimersByTimeAsync(5_000);
    expect(compactFn).toHaveBeenCalledTimes(1);
    expect(compactFn).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thr_claude_1" }),
    );

    service.controller.abort();
    await service.done;
    await harness.lifecycle.dispose();
  });

  it("schedules an acp-opencode thread with the shipped assumed TTL and no advertised /compact", async () => {
    vi.useFakeTimers();
    const startMs = Date.UTC(2026, 10, 20, 22, 0, 0);
    vi.setSystemTime(startMs);

    const openCodeThread = makeThreadResponse({
      id: "thr_opencode_1",
      providerId: "acp-opencode",
      status: "idle",
      updatedAt: startMs,
    });

    const compactFn = vi.fn(async () => ({ ok: true as const }));
    const { bb, harness } = createFakePluginHost({
      pluginId: "cache-compact",
      sdk: {
        threads: {
          list: async (args) =>
            args?.parentThreadId !== undefined ? [] : [openCodeThread],
          get: async () => openCodeThread,
          compact: compactFn,
          experimental_headState: async () => ({
            activePromptMode: null,
            contextWindowUsage: {
              estimated: false,
              modelContextWindow: 1_000_000,
              usedTokens: 160_000,
            },
            extensionStates: {},
            modelFallback: null,
            pendingTodos: null,
            providerCommands: null,
            sessionOptions: null,
          }),
          events: { list: async () => [] },
          interactions: { list: async () => [] },
        },
      },
    });

    await plugin(bb);
    const service = harness.behavior.runService("cache-compact-scheduler");

    // Let startup reconcile settle
    await vi.advanceTimersByTimeAsync(1_000);
    expect(compactFn).not.toHaveBeenCalled();

    const statusBefore = await harness.behavior.runCli(["status", "--json"]);
    expect(statusBefore.exitCode).toBe(0);
    const parsedBefore = JSON.parse(statusBefore.stdout ?? "{}");
    expect(parsedBefore.config.providers).toContain("acp-opencode");
    expect(parsedBefore.config.fallbackTtlMinutesByProvider["acp-opencode"]).toBe(5);
    expect(parsedBefore.tracked).toHaveLength(1);
    const record = parsedBefore.tracked[0];
    expect(record.state).toBe("scheduled");
    expect(record.method).toBe("native");
    expect(record.ttlSource).toBe("provider-fallback-ttl");
    // No token event and no completed turn, so the anchor is the thread's updatedAt.
    expect(record.expiresAtMs - startMs).toBe(5 * 60_000);

    // 5m TTL minus the 3m lead leaves a 2m target.
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 5_000);
    expect(compactFn).toHaveBeenCalledTimes(1);
    expect(compactFn).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thr_opencode_1" }),
    );

    // The compaction turn lands back in idle while usage is still above minTokens.
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: openCodeThread,
      lastAssistantText: "Compacted.",
    });

    // Advance another 30m -> the sealed compaction must not reschedule itself.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(compactFn).toHaveBeenCalledTimes(1);

    const statusAfter = await harness.behavior.runCli(["status", "--json"]);
    const parsedAfter = JSON.parse(statusAfter.stdout ?? "{}");
    expect(parsedAfter.tracked[0].state).toBe("compacted");

    service.controller.abort();
    await service.done;
    await harness.lifecycle.dispose();
  });

  it("refuses to compact a thread it has only just met, on the first scan and the second", async () => {
    vi.useFakeTimers();
    const startMs = Date.UTC(2026, 10, 20, 22, 0, 0);
    vi.setSystemTime(startMs);

    // Idle four minutes: the assumed 5m lifetime leaves 1m, and the 3m lead
    // puts the due time two minutes in the past, inside the arming window.
    const openCodeThread = makeThreadResponse({
      id: "thr_opencode_first_scan",
      providerId: "acp-opencode",
      status: "idle",
      updatedAt: startMs - 4 * 60_000,
    });

    const compactFn = vi.fn(async () => ({ ok: true as const }));
    const { bb, harness } = createFakePluginHost({
      pluginId: "cache-compact",
      sdk: {
        threads: {
          list: async (args) =>
            args?.parentThreadId !== undefined ? [] : [openCodeThread],
          get: async () => openCodeThread,
          compact: compactFn,
          experimental_headState: async () => ({
            activePromptMode: null,
            contextWindowUsage: {
              estimated: false,
              modelContextWindow: 1_000_000,
              usedTokens: 160_000,
            },
            extensionStates: {},
            modelFallback: null,
            pendingTodos: null,
            providerCommands: null,
            sessionOptions: null,
          }),
          events: { list: async () => [] },
          interactions: { list: async () => [] },
        },
      },
    });

    await plugin(bb);
    const service = harness.behavior.runService("cache-compact-scheduler");

    // Startup reconcile meets the thread for the first time; its due time is
    // already in the past, so the arming delay holds it back.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(compactFn).not.toHaveBeenCalled();

    const guardedStatus = await harness.behavior.runCli(["status", "--json"]);
    expect(guardedStatus.exitCode).toBe(0);
    const guarded = JSON.parse(guardedStatus.stdout ?? "{}");
    expect(guarded.tracked).toHaveLength(1);
    expect(guarded.tracked[0].state).toBe("skipped");
    expect(guarded.tracked[0].lastReason).toBe("discovered-late");

    const humanStatus = await harness.behavior.runCli(["status"]);
    expect(humanStatus.exitCode).toBe(0);
    expect(humanStatus.stdout ?? "").toContain(
      "discovered late (met inside the 60s arming window)",
    );

    // A second scan finds the row it wrote, and by now the assumed lifetime
    // has elapsed, so the honest reason is `already-expired`, not the guard.
    await vi.advanceTimersByTimeAsync(90_000);
    const secondScan = await harness.behavior.runCli(["reconcile"]);
    expect(secondScan.exitCode).toBe(0);
    expect(compactFn).not.toHaveBeenCalled();

    const afterStatus = await harness.behavior.runCli(["status", "--json"]);
    const after = JSON.parse(afterStatus.stdout ?? "{}");
    expect(after.tracked[0].state).toBe("expired");
    expect(after.tracked[0].lastReason).toBe("already-expired");

    service.controller.abort();
    await service.done;
    await harness.lifecycle.dispose();
  });

  it("compacts on schedule a thread whose due time falls outside the arming window", async () => {
    vi.useFakeTimers();
    const startMs = Date.UTC(2026, 10, 20, 22, 0, 0);
    vi.setSystemTime(startMs);

    // Idle 30s: the 5m lifetime leaves 4m30s, and the 3m lead puts the due
    // time 90s out, which is after the 60s arming delay.
    const openCodeThread = makeThreadResponse({
      id: "thr_opencode_armed",
      providerId: "acp-opencode",
      status: "idle",
      updatedAt: startMs - 30_000,
    });

    const compactFn = vi.fn(async () => ({ ok: true as const }));
    const { bb, harness } = createFakePluginHost({
      pluginId: "cache-compact",
      sdk: {
        threads: {
          list: async (args) =>
            args?.parentThreadId !== undefined ? [] : [openCodeThread],
          get: async () => openCodeThread,
          compact: compactFn,
          experimental_headState: async () => ({
            activePromptMode: null,
            contextWindowUsage: {
              estimated: false,
              modelContextWindow: 1_000_000,
              usedTokens: 160_000,
            },
            extensionStates: {},
            modelFallback: null,
            pendingTodos: null,
            providerCommands: null,
            sessionOptions: null,
          }),
          events: { list: async () => [] },
          interactions: { list: async () => [] },
        },
      },
    });

    await plugin(bb);
    const service = harness.behavior.runService("cache-compact-scheduler");

    // Startup reconcile schedules the thread rather than skipping it.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(compactFn).not.toHaveBeenCalled();
    const statusBefore = await harness.behavior.runCli(["status", "--json"]);
    const before = JSON.parse(statusBefore.stdout ?? "{}");
    expect(before.tracked[0].state).toBe("scheduled");

    // Still short of the due time.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(compactFn).not.toHaveBeenCalled();

    // Cross the due time -> compacts exactly once.
    await vi.advanceTimersByTimeAsync(35_000);
    expect(compactFn).toHaveBeenCalledTimes(1);
    expect(compactFn).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thr_opencode_armed" }),
    );

    service.controller.abort();
    await service.done;
    await harness.lifecycle.dispose();
  });

  it("compacts immediately when the operator asks for it explicitly", async () => {
    vi.useFakeTimers();
    const startMs = Date.UTC(2026, 10, 20, 22, 0, 0);
    vi.setSystemTime(startMs);

    // Never seen before, past due, and inside the arming window: the scan
    // path would skip this thread, but `now` is an operator acting on it.
    const openCodeThread = makeThreadResponse({
      id: "thr_opencode_explicit",
      providerId: "acp-opencode",
      status: "idle",
      updatedAt: startMs - 4 * 60_000,
    });

    const compactFn = vi.fn(async () => ({ ok: true as const }));
    const { bb, harness } = createFakePluginHost({
      pluginId: "cache-compact",
      sdk: {
        threads: {
          list: async (args) =>
            args?.parentThreadId !== undefined ? [] : [openCodeThread],
          get: async () => openCodeThread,
          compact: compactFn,
          experimental_headState: async () => ({
            activePromptMode: null,
            contextWindowUsage: {
              estimated: false,
              modelContextWindow: 1_000_000,
              usedTokens: 160_000,
            },
            extensionStates: {},
            modelFallback: null,
            pendingTodos: null,
            providerCommands: null,
            sessionOptions: null,
          }),
          events: { list: async () => [] },
          interactions: { list: async () => [] },
        },
      },
    });

    await plugin(bb);

    const result = await harness.behavior.runCli(["now", "thr_opencode_explicit"]);
    expect(result.exitCode).toBe(0);
    expect(compactFn).toHaveBeenCalledTimes(1);
    expect(compactFn).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thr_opencode_explicit" }),
    );

    const status = await harness.behavior.runCli(["status", "--json"]);
    const parsed = JSON.parse(status.stdout ?? "{}");
    expect(parsed.tracked).toHaveLength(1);
    expect(parsed.tracked[0].state).toBe("compacting");
    expect(parsed.tracked[0].lastReason).not.toBe("discovered-late");

    await harness.lifecycle.dispose();
  });

  it("skips an acp-opencode thread whose assumed cache lifetime already elapsed", async () => {
    vi.useFakeTimers();
    const startMs = Date.UTC(2026, 10, 20, 22, 0, 0);
    vi.setSystemTime(startMs);

    // No token event and no completed turn, so the anchor is updatedAt, which
    // already sits 6m in the past: one minute past the assumed 5m lifetime.
    const openCodeThread = makeThreadResponse({
      id: "thr_opencode_cold",
      providerId: "acp-opencode",
      status: "idle",
      updatedAt: startMs - 6 * 60_000,
    });

    const compactFn = vi.fn(async () => ({ ok: true as const }));
    const { bb, harness } = createFakePluginHost({
      pluginId: "cache-compact",
      sdk: {
        threads: {
          list: async (args) =>
            args?.parentThreadId !== undefined ? [] : [openCodeThread],
          get: async () => openCodeThread,
          compact: compactFn,
          experimental_headState: async () => ({
            activePromptMode: null,
            contextWindowUsage: {
              estimated: false,
              modelContextWindow: 1_000_000,
              usedTokens: 160_000,
            },
            extensionStates: {},
            modelFallback: null,
            pendingTodos: null,
            providerCommands: null,
            sessionOptions: null,
          }),
          events: { list: async () => [] },
          interactions: { list: async () => [] },
        },
      },
    });

    await plugin(bb);
    const service = harness.behavior.runService("cache-compact-scheduler");

    // Let startup reconcile settle
    await vi.advanceTimersByTimeAsync(1_000);
    expect(compactFn).not.toHaveBeenCalled();

    const status = await harness.behavior.runCli(["status", "--json"]);
    expect(status.exitCode).toBe(0);
    const parsed = JSON.parse(status.stdout ?? "{}");
    expect(parsed.tracked).toHaveLength(1);
    expect(parsed.tracked[0].ttlSource).toBe("provider-fallback-ttl");
    expect(parsed.tracked[0].state).toBe("expired");
    expect(parsed.tracked[0].lastReason).toBe("already-expired");

    // Nothing can schedule that thread later, even well past the assumed lifetime.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(compactFn).not.toHaveBeenCalled();

    service.controller.abort();
    await service.done;
    await harness.lifecycle.dispose();
  });

  it("names the TTL source and assumed minutes in the human-readable status output", async () => {
    vi.useFakeTimers();
    const startMs = Date.UTC(2026, 10, 20, 22, 0, 0);
    vi.setSystemTime(startMs);

    const openCodeThread = makeThreadResponse({
      id: "thr_opencode_status",
      providerId: "acp-opencode",
      status: "idle",
      updatedAt: startMs,
    });

    const { bb, harness } = createFakePluginHost({
      pluginId: "cache-compact",
      sdk: {
        threads: {
          list: async (args) =>
            args?.parentThreadId !== undefined ? [] : [openCodeThread],
          get: async () => openCodeThread,
          compact: async () => ({ ok: true as const }),
          experimental_headState: async () => ({
            activePromptMode: null,
            contextWindowUsage: {
              estimated: false,
              modelContextWindow: 1_000_000,
              usedTokens: 160_000,
            },
            extensionStates: {},
            modelFallback: null,
            pendingTodos: null,
            providerCommands: null,
            sessionOptions: null,
          }),
          events: { list: async () => [] },
          interactions: { list: async () => [] },
        },
      },
    });

    await plugin(bb);
    const service = harness.behavior.runService("cache-compact-scheduler");

    // Let startup reconcile schedule the thread
    await vi.advanceTimersByTimeAsync(1_000);

    const status = await harness.behavior.runCli(["status"]);
    expect(status.exitCode).toBe(0);
    const stdout = status.stdout ?? "";
    expect(stdout).toContain("thr_opencode_status");
    expect(stdout).toContain("provider-fallback-ttl");
    expect(stdout).toContain("5m assumed");
    expect(stdout).toMatch(/Assumed TTLs: .*acp-opencode=5m/u);

    service.controller.abort();
    await service.done;
    await harness.lifecycle.dispose();
  });

  it("compacts an antigravity-cli thread via /compact and does not loop on subsequent idle", async () => {
    vi.useFakeTimers();
    const startMs = Date.UTC(2026, 10, 20, 22, 0, 0);
    vi.setSystemTime(startMs);

    const agyThread = makeThreadResponse({
      id: "thr_agy_1",
      providerId: "antigravity-cli",
      status: "idle",
      updatedAt: startMs,
    });

    let currentUsedTokens = 210_000;
    let latestInputIsCompact = false;
    let latestTurnSeq = 15;
    let latestTurnAtMs = startMs;
    const sendFn = vi.fn(async () => {
      latestInputIsCompact = true;
      latestTurnSeq = 18;
      latestTurnAtMs = Date.now();
      currentUsedTokens = 115_000;
      return { delivery: "sent" as const, ok: true as const };
    });

    const { bb, harness } = createFakePluginHost({
      pluginId: "cache-compact",
      sdk: {
        threads: {
          list: async () => [],
          get: async () => agyThread,
          send: sendFn,
          experimental_headState: async () => ({
            activePromptMode: null,
            contextWindowUsage: {
              estimated: false,
              modelContextWindow: 1_048_576,
              usedTokens: currentUsedTokens,
            },
            extensionStates: {},
            modelFallback: null,
            pendingTodos: null,
            providerCommands: [
              {
                name: "compact",
                source: "command" as const,
                origin: "builtin" as const,
                description: "Compact the conversation now.",
                argumentHint: null,
              },
            ],
            sessionOptions: null,
          }),
          events: {
            list: async (args) => {
              if (args.types?.includes("turn/completed")) {
                return [
                  {
                    id: `evt_turn_${latestTurnSeq}`,
                    scope: { kind: "thread" as const },
                    threadId: agyThread.id,
                    seq: latestTurnSeq,
                    createdAt: latestTurnAtMs,
                    type: "turn/completed" as const,
                    data: {
                      providerThreadId: "pt_agy",
                      turnId: `t_${latestTurnSeq}`,
                      status: "completed" as const,
                    },
                  },
                ];
              }
              if (
                latestInputIsCompact &&
                args.types?.includes("client/turn/requested")
              ) {
                return [
                  {
                    id: "evt_compact_in",
                    scope: { kind: "thread" as const },
                    threadId: agyThread.id,
                    seq: latestTurnSeq - 1,
                    createdAt: latestTurnAtMs,
                    type: "client/turn/requested" as const,
                    data: {
                      initiator: "system" as const,
                      input: [{ type: "text" as const, text: "/compact", mentions: [] }],
                      requestId: "req_1",
                      mode: { kind: "start" as const },
                    },
                  },
                ];
              }
              return [];
            },
          },
          interactions: {
            list: async () => [],
          },
        },
      },
    });

    await plugin(bb);
    const service = harness.behavior.runService("cache-compact-scheduler");

    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: agyThread,
      lastAssistantText: "finished",
    });

    // Advance 57m -> triggers /compact via threads.send
    await vi.advanceTimersByTimeAsync(57 * 60_000 + 2_000);
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thr_agy_1",
        mode: "auto",
        input: [{ type: "text", text: "/compact", mentions: [] }],
      }),
    );

    // Compaction turn completes and emits thread.idle again (even while still > 100k tokens)
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: agyThread,
      lastAssistantText: "Compacted.",
    });

    // Advance another 2 hours -> must NOT loop!
    await vi.advanceTimersByTimeAsync(120 * 60_000);
    expect(sendFn).toHaveBeenCalledTimes(1);

    const status = await harness.behavior.runCli(["status", "--json"]);
    const parsed = JSON.parse(status.stdout ?? "{}");
    expect(parsed.tracked[0].state).toBe("compacted");

    service.controller.abort();
    await service.done;
    await harness.lifecycle.dispose();
  });

  it("cancels scheduled compaction when the thread becomes active or opts out", async () => {
    vi.useFakeTimers();
    const startMs = Date.UTC(2026, 10, 20, 22, 0, 0);
    vi.setSystemTime(startMs);

    const piThread = makeThreadResponse({
      id: "thr_pi_1",
      providerId: "pi",
      status: "idle",
      updatedAt: startMs,
    });
    const compactFn = vi.fn(async () => ({ ok: true as const }));

    const { bb, harness } = createFakePluginHost({
      pluginId: "cache-compact",
      sdk: {
        threads: {
          list: async () => [],
          get: async () => piThread,
          compact: compactFn,
          experimental_headState: async () => ({
            activePromptMode: null,
            contextWindowUsage: {
              estimated: true,
              modelContextWindow: 1_000_000,
              usedTokens: 140_000,
              compactionOfferAt: new Date(startMs + 60 * 60_000).toISOString(),
            },
            extensionStates: {},
            modelFallback: null,
            pendingTodos: null,
            providerCommands: null,
            sessionOptions: null,
          }),
          events: { list: async () => [] },
          interactions: { list: async () => [] },
        },
      },
    });

    await plugin(bb);
    const service = harness.behavior.runService("cache-compact-scheduler");

    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: piThread,
      lastAssistantText: "done",
    });

    // Opt out via RPC before timer fires
    const optOut = await harness.behavior.callRpc("set_opt_out", {
      threadId: "thr_pi_1",
      optedOut: true,
    });
    expect(optOut).toEqual({ threadId: "thr_pi_1", optedOut: true });

    const rpcStatus = (await harness.behavior.callRpc("status", null)) as {
      tracked: Array<{ threadId: string; optedOut: boolean }>;
    };
    expect(rpcStatus.tracked[0]?.optedOut).toBe(true);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(compactFn).not.toHaveBeenCalled();

    service.controller.abort();
    await service.done;
    await harness.lifecycle.dispose();
  });
});
