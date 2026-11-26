# bb-plugin-cache-compact

Compact idle [BB](https://getbb.app) threads minutes before their prompt cache expires, keeping compaction on a warm cache instead of paying cold re-input rates when you return.

![How Cache Compact works: comparing cold-cache eviction vs. proactive warm-cache compaction at TTL minus 3 minutes](docs/screenshots/how-it-works.png)

## Live schedule in BB Settings

![Cache Compact live schedule in BB Settings showing warm idle threads with countdowns across Claude Code, Pi, and Antigravity CLI](docs/screenshots/schedule.png)

## Features

- **Exact provider TTL support** — reads `promptCacheTtlMs` from `thread/tokenUsage/updated` events (and `compactionOfferAt` when BB's `compactExpiredCache` experiment is enabled) for **Claude Code** (`claude-code`) and **Pi** (`pi`), invoking native `threads.compact()`.
- **Antigravity CLI support** — supports `antigravity-cli` in the same plugin using a configurable `fallbackTtlMinutes` and its advertised `/compact` slash command, sealing the compaction turn in SQLite so it never loops.
- **OpenCode and Oh My Pi support** — detects `acp-opencode` and `acp-omp` by default and compacts them natively. Both runtimes report no cache lifetime, so their schedules rest on a documented assumption rather than a measurement (see [Cache lifetime assumptions](#cache-lifetime-assumptions)).
- **Cold-cache protection** — if a thread's prompt cache has already expired (for example after your machine slept), Cache Compact skips it rather than burning uncached input tokens.
- **Safety guards** — enforces a minimum token count (`100,000`), per-thread cooldown (`10m`), per-thread opt-out, and skips threads that are active, archived, have queued work, pending interactions, or active child threads.
- **Live Settings UI & CLI** — view countdowns, trigger compaction, or opt out threads from **Settings → Cache Compact** or with `bb cache-compact`.

## Install

```sh
bb plugin install git:https://github.com/AdzeB/bb-plugin-cache-compact.git@^0.1.0
```

## Settings

Configure in **Settings → Installed plugins → Cache Compact** or via CLI (`bb plugin config cache-compact set <key> <value>`):

![Cache Compact configuration panel in BB Settings](docs/screenshots/settings.png)

| Setting | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Turn proactive pre-expiry compaction on or off |
| `minTokens` | `100000` | Minimum recorded context tokens required before scheduling |
| `leadMinutes` | `3` | Minutes before cache expiry to trigger compaction |
| `providers` | `claude-code,pi,antigravity-cli,acp-opencode,acp-omp` | Comma-separated eligible provider IDs |
| `fallbackTtlMinutes` | `60` | Assumed cache TTL for providers that do not emit `promptCacheTtlMs` and have no per-provider entry |
| `fallbackTtlMinutesByProvider` | `acp-opencode=5,acp-omp=60` | Per-provider assumed cache TTL as `provider=minutes` pairs, overriding the global fallback. Malformed entries are rejected |
| `cooldownMinutes` | `10` | Minimum minutes between automatic compactions on one thread |
| `skipWithActiveChildren` | `true` | Skip parent threads while any child thread is still running |

### Cache lifetime assumptions

OpenCode and Oh My Pi report no cache lifetime, and neither emits the token usage event that BB turns into a compaction offer. Their schedules therefore rest on a documented assumption, not a measurement. Both runtimes compact natively.

| Provider | Assumed TTL | What the value rests on |
| --- | --- | --- |
| `acp-opencode` | 5m | Anthropic's default cache lifetime, chosen as the shortest common case, so a wrong guess compacts early instead of after the cache is already cold |
| `acp-omp` | 60m | BB declares manual compaction for omp, omp advertises the `compact` command, and BB has a dedicated omp compaction-outcome parser. Verified live: `bb thread compact` on bb 0.50.1 with omp 19.1.1 returned `Compaction complete. Tokens: 35814 -> 34714` and emitted `thread/compacted` |

Override any entry with `fallbackTtlMinutesByProvider`, for example `acp-opencode=10,acp-omp=60`. A per-provider value of `0` turns the assumption off for that provider.

> **First scan and the arming window.** A thread must be known to the plugin for 60 seconds before its due time can trigger a compaction. A fresh install therefore compacts nothing immediately: a thread first met inside its lead window is recorded as `discovered late` and left to expire, and normal scheduling resumes from that thread's next idle period. Manual compaction from `bb cache-compact now` or the Settings **Compact now** button is exempt, because that is an operator acting on a thread in front of them.

> **Tip:** BB releases idle provider processes after `idleProviderSessionTimeoutMinutes` (default `30`). For 1-hour caches, setting `bb settings general idleProviderSessionTimeoutMinutes 60` avoids restarting the local provider process right before compaction runs.

## CLI

```sh
bb cache-compact status [--json]
bb cache-compact check [thread-id] [--json]
bb cache-compact now [thread-id] [--force] [--json]
bb cache-compact opt-out [thread-id] [--json]
bb cache-compact opt-in [thread-id] [--json]
bb cache-compact reconcile [--json]
```

## Development

```sh
npm install
npm run check
npm test
bb plugin build .
```

## License

MIT — see [LICENSE](./LICENSE).
