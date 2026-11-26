# Extension plan: OpenCode and Oh My Pi

Status: implemented and verified on a live bb 0.50.1 install, then withdrawn from upstream review pending a week of real use. The assumed cache lifetimes are still assumptions, and the point of that week is to turn at least some of them into observations. omp compaction itself is no longer unproven: see the resolved open question at the end.

## What the evidence says

BB 0.50.1 already treats both runtimes as manually compactable. `plugins/provider-acp/src/known-agents.ts` declares `supportsManualCompaction: true` for `acp-opencode` (line 97) and `acp-omp` (line 123) at tag `desktop-v0.50.1`, and `apps/server/src/services/threads/dispatch-attempt.ts:1058` refuses compaction only when that flag is false. Compaction for an ACP thread dispatches the literal text `/compact` through `session/prompt` (`packages/provider-bridge-acp/src/bridge/bridge.ts:3640-3647`).

Both agents accept that prompt. OpenCode advertises a `compact` command with the description "Compact the session", and its ACP code maps the name to a compaction start (`Mt = new Map([["compact", { description: "Compact the session", start: "compaction" }]])` in the `opencode` binary). omp advertises `compact` in its command list and BB has a dedicated omp compaction-outcome parser that reads "compaction failed", "nothing to compact" and "already compacted" (`packages/provider-bridge-acp/src/dialect.ts:384-402`). On this machine 1,057 OpenCode threads and 64 omp threads advertise the command, and 5 `thread/compacted` events exist on 4 OpenCode threads, the most recent from 2026-11-25.

Neither runtime reports a cache lifetime. `promptCacheTtlMs` is emitted only by `plugins/provider-claude-code` and `plugins/provider-pi`. No ACP provider emits `thread/tokenUsage/updated` at all, and BB derives `compactionOfferAt` from that same field (`apps/server/src/services/threads/compaction-offer.ts:47-52`), so both exact-TTL paths are permanently inert for OpenCode and omp.

The plugin therefore fails them in two ways, both in `policy.ts` and `server.ts`, and neither is a missing host capability:

1. `DEFAULT_PROVIDERS = "claude-code,pi,antigravity-cli"` (`server.ts:123`) excludes them, so a fresh install never inspects an OpenCode or omp thread.
2. Once added, `resolveCacheTtl` (`policy.ts:182-235`) falls through to `fallback-ttl` anchored on the last activity, which is a guess.

## What the change is

### 1. Provider detection

`resolveCompactionMethod` (`policy.ts:161-180`) already defaults to `native` for every provider not on `KNOWN_SLASH_ONLY_PROVIDERS`, so no branch is needed for either runtime. Add `acp-opencode`, `acp-omp` and `acp-opencode-nono` to `DEFAULT_PROVIDERS`, and add a regression test asserting each resolves to `{ kind: "native" }` with `advertisesCompactCommand` both true and false. The false case matters: native compaction must not depend on the advertised command, because BB's own path sends `/compact` directly.

### 2. TTL source per runtime

There is no exact source available and none can be added from a plugin. The only honest options are operator-declared values. Replace the single `fallbackTtlMinutes` with a per-provider table plus the global default:

- New setting `fallbackTtlMinutesByProvider`, a comma-separated `provider=minutes` string, parsed by a new `parseProviderTtlOverrides` beside `parseProviderList` (`policy.ts:153`).
- Resolution order in `resolveCacheTtl` becomes: `provider-ttl`, then `compaction-offer`, then per-provider override, then the global `fallbackTtlMinutes`, then disabled.
- Ship defaults of `acp-opencode=5` and `acp-omp=60` in a `KNOWN_FALLBACK_TTL_PROVIDERS` map, documented as assumptions rather than measurements.

Five minutes for OpenCode is the Anthropic default cache lifetime and the shortest common case. Choosing short is deliberate: an over-long guess fires compaction after the cache has really expired, which is the exact cost the plugin exists to avoid, while a short guess only compacts earlier than necessary. omp inherits Pi's behaviour and gets 60 minutes to match its sibling provider.

### 3. Make the guess visible

`skip` reasons already distinguish `no-ttl` from `already-expired`. Add a `ttlSource` of `fallback-ttl` to the schedule row in `bb cache-compact status` and the Settings countdown, so an operator can see that a thread is being timed on an assumption. Without this, the dashboard implies the same confidence for a measured 1-hour cache and a guessed one.

### 4. Rejected alternatives

- Model-level TTL inference (Anthropic routes get 5m, others get none) would be more accurate but needs a model-to-route mapping the plugin does not have, and BB stores model per thread only through provider events. Deferred until a thread shows a per-model split worth the complexity.
- Treating both runtimes as slash-only and reusing the Antigravity path would be wrong. They support native compaction, and the slash path exists only for providers that do not.
- A `minTokens`-only mode with no TTL at all would compact on every idle transition and churn the cache. Rejected.

## What shipped differently

Three points diverge from the proposal and are recorded here rather than folded back into it:

- The proposal named `acp-opencode-nono` as a third provider. The implementation shipped it, and it has since been removed from both the default provider list and the TTL table: `acp-opencode-nono` is a local experiment with a sandbox wrapper, not a runtime this plugin should claim to support upstream. Anyone running it can add the id to `providers` and `fallbackTtlMinutesByProvider` themselves.
- The plan's single `fallback-ttl` source became two: `provider-fallback-ttl` for a documented per-provider assumption, and `fallback-ttl` for the global default. A documented assumption and a blanket default deserve different labels in the status output and Settings.
- The plan had no guard against acting on a thread the plugin had only just met. Live verification showed why one is needed: widening the default provider list put the new provider ids on the path of the first scan, and that scan compacts a thread whose due time has already passed, because the target clamps to now. A thread must now be known for 60 seconds before its due time can fire. Explicit compaction from `bb cache-compact now` or the Settings button is exempt. This is scope the plan did not cover.

## Tests that would prove it

In `server.test.ts`, following the existing shapes:

- `resolveCompactionMethod` returns native for `acp-opencode`, `acp-omp` and `acp-opencode-nono`.
- `resolveCacheTtl` returns `fallback-ttl` with the per-provider override when one exists, and with the global default when it does not.
- The override beats the global, and a malformed `provider=minutes` entry is rejected rather than silently dropped.
- End to end, in the style of the antigravity test at `server.test.ts:342`: an idle `acp-opencode` thread above `minTokens` schedules at `anchor + override - leadMinutes` and calls `threads.compact` once, then does not reschedule on the following idle.
- A thread whose anchor already passed expiry is skipped, proving the cold-cache guard still wins over the guessed TTL.

## Open question for the reviewer

Resolved. omp had never been compacted on this machine, so its support rested on the declared capability, the advertised command and BB's parser rather than on an observed event. It was verified on 2026-11-25 with one `bb thread compact` on a disposable `acp-omp` thread, bb 0.50.1, omp 19.1.1. omp reported `Compaction complete. Tokens: 35814 -> 34714 (saved 1100).` and BB recorded a `thread/compacted` event. The plugin reaches the same server-side path, so the claim now rests on an observation rather than on an inference.
