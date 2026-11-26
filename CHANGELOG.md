# Changelog

## Unreleased

- Detect `acp-opencode` and `acp-omp` threads by default, compacting them natively.
- Ship a per-provider fallback TTL table (`fallbackTtlMinutesByProvider`) with assumed lifetimes of 5 minutes for OpenCode and 60 minutes for Oh My Pi.
- Show the `provider-fallback-ttl` source, with the minutes in play, in `bb cache-compact status` and the Settings countdown.
- Never compact a thread on first sight: a thread must be known for 60 seconds before its due time can fire, so a fresh install cannot compact a batch of recently active threads at once. Manual compaction is exempt.

## 0.1.0

- Proactive pre-cache-expiry compaction scheduler for idle BB threads.
- Exact `promptCacheTtlMs` / `compactionOfferAt` tracking with native `threads.compact()` for Claude Code and Pi.
- Configurable fallback TTL and `/compact` slash-command compaction with loop protection for Antigravity CLI (`antigravity-cli`).
- Cold-cache skip guard (never compacts threads whose prompt cache has already expired), minimum token threshold, active child thread check, pending interaction guard, and per-thread cooldown.
- Live **Settings → Cache Compact** schedule view with countdowns, manual compaction, per-thread opt-out, and manual re-scan.
- `bb cache-compact` CLI (`status`, `check`, `now`, `opt-out`, `opt-in`, `reconcile`) and bundled `cache-compact` agent skill.
