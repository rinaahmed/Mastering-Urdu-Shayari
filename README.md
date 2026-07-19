# Bayaz

A domain-agnostic, offline-first personal learning-session engine, built as a PWA. Vanilla JS/HTML/CSS, no framework, IndexedDB for storage, Cloudflare Pages plus a Worker (Pages Functions) proxying the Anthropic API.

**Core principles:**
- The app owns all state. The Claude API is stateless and receives a freshly assembled context payload each call.
- Plans are data files, never code. The plan supplies all vocabulary, teaching content, checker configuration, and tutor method — a French, math, or music-theory plan loads with no code changes. The seed plan happens to teach Urdu prosody; the app doesn't know that.
- Designed E Ink-first for a Boox Palma (6.13" Carta, greyscale, 300ppi); colour is additive only.

## Architecture

```
public/                    the PWA
  plans/plan.schema.json   JSON Schema (draft 2020-12) for plans — schema v2
  plans/seed-plan.json     seed plan #1 (Urdu prosody — replaceable data)
  js/schema.js             runtime validator (exact JSON-path errors) + teaching-order audit
  js/migrate.js            v1 → v2 plan migration with hand-authoring report
  js/db.js                 IndexedDB layer (plans, nodes, categories, artifacts, sessions, lesson state, queue)
  js/ledger.js             skill nodes: status, confidence decay, spaced repetition, taughtIn gate, plateau flags
  js/checkers.js           checker engine — generic strategies only; plans declare instances
  js/assembler.js          session assembly into paginated screens
  js/context.js            generator payload (~3k tokens) and minimal evaluator payload
  js/api.js                Worker client + offline queue with retry
  js/session.js            screen runtime: grading, ledger deltas, artifacts, lesson completion
  js/views/                today (paginated session), progress, portfolio, settings
functions/api/             the Cloudflare Worker
  generate.js              generator call — full context, returns prose
  evaluate.js              evaluator call — prompt + answer + response only, strict JSON via json_schema
```

## Plan schema v2

Validated on import against `public/plans/plan.schema.json` (structure) plus runtime cross-reference checks, every error with its JSON path. Key concepts:

- **Lessons carry content.** `content[]` is an ordered array of blocks: `prose` (markdown teaching text), `example` (worked example + commentary), `generate` (a prompt the tutor expands into fresh material at session time), `reflect` (a question; the answer is stored), `drill` (a drillType reference, optionally with specific item ids). A `study` lesson with only prose/generate blocks and no drills is valid. Blocks may declare `direction: "rtl"` and `lang` — the app assumes nothing about script. A `generate` block is one-shot (shown once, no reply) unless it sets `expectsResponse: true`, in which case it becomes an open-ended exchange: after each tutor turn the learner gets both a reply box and a "Done — move on" button, and can go back and forth as many times as they want — the screen only counts done, and `Next` only unlocks, once the learner explicitly says Done. Each reply resends the full transcript so far (the API is stateless) so the tutor has continuity. Use this for exercises phrased as a question to the learner, not for material meant only to be read. A generate block calls the tutor live every session — never cached across sessions, never a static fallback — and `Next` stays disabled until it actually succeeds, so a lesson whose only content is a generate block (meant to be authored adaptively, with no pre-written material to fall back on) can't be silently skipped past a failed call. A failure shows a plain error and a Retry button.
- **Checkers are plan-declared plugins.** The app implements only generic strategies: `exact`, `normalized-exact`, `set-match`, `sequence-diff`, `numeric`, `external`, `judgment`. `external` POSTs `{prompt, answer, userResponse, config}` to a plan-supplied URL expecting `{correct, detail}` — this is how a domain engine (e.g. a scansion engine) is wired in with no code changes. Unreachable external checkers fall back per `fallback` (typically a judgment checker) and the result is marked **provisional**.
- **`taughtIn` is a hard gate.** Every skill node names the lesson that teaches it. Until that lesson is complete, the node is ineligible for drills and review — prerequisite satisfaction alone never makes a node eligible. The only exception: a lesson's own drill blocks may exercise the nodes it is currently teaching. Enforced in the scheduler.
- **`missingData` / `blockedOn`.** A plan can declare data it needs; a lesson `blockedOn` one of those ids shows why it can't start instead of starting. Resolved in Settings.
- **Teaching-order audit.** After validation, any drill or item that exercises a node whose `taughtIn` lesson comes later in plan order refuses the import, with the lesson, item, and both positions named.

`Settings → Convert v1 plan` migrates a v1 file: structure converts automatically; teaching content and external checker URLs are reported as items to author by hand, with a downloadable v2 draft.

Importing (including re-importing an update to the same plan id) always abandons any in-progress session first. A session's screens are assembled once, at start; without this, re-importing an edited plan while a session was already active would silently keep showing the old, pre-edit content until that specific session happened to end on its own.

## Session engine

Assembled locally into an ordered screen list before any API call: standing elements (skipped while their nodes are untaught) → the current lesson content block by block (or its blocker) → interleaved review of due, *eligible* nodes weighted toward low confidence and capped per `settings.reviewNodeCap` → flat-progress flags ("this isn't moving, change approach") instead of more reps → summary. Completing every lesson screen marks the lesson complete, which is what opens its nodes for future scheduling.

Two API calls only: the **generator** teaches with full context (lesson, node states, error categories with real instances, artifact revision chains, calibration examples, tutor instructions verbatim); the **evaluator** receives prompt + expected answer + user response — no teaching context — and returns strict JSON enforced by `output_config.format` json_schema. Deterministic checkers run locally and never hit the API. Offline judgment calls queue, retry, and stay provisional until applied.

## Display

One content block or drill per screen with explicit Back/Next — no long scroll in the session flow (Progress and Portfolio may scroll). Pure `#000` on `#fff`, 2px+ borders, no CSS transitions or animations anywhere, state distinguished by weight/border-style/icon rather than hue. Serif for teaching prose, sans for chrome; Noto Naskh Arabic is self-hosted for RTL blocks. Portrait: single column, 68ch max, bottom tab bar. Landscape phone (`max-height: 500px`): left nav rail and a two-column screen — content left, response right — so input never scrolls out of view. **E Ink mode** (Settings) forces pure greyscale, kills the accent, and thickens borders; defaults on when `(update: slow)` matches. On colour LCDs a single accent appears via `@media (color)`, never as the sole carrier of meaning.

## Deploying

1. Cloudflare Pages project → build command none, output directory `public`; `functions/` is picked up automatically as the Worker.
2. Pages → Settings → Variables: `ANTHROPIC_API_KEY` (secret — only here, never the browser), optional `ANTHROPIC_MODEL` (default `claude-opus-4-8`). Retry the deployment after adding secrets.
3. Local dev: `npx wrangler pages dev public` with a `.dev.vars` file.

## Versioning

There is no build step, so there's no git SHA or build number available at runtime to derive a version from automatically. Instead `public/version.json` is a plain committed file, bumped by hand as the **last step of every push**:

```json
{
  "version": "N",
  "builtAt": "<ISO 8601 UTC timestamp>"
}
```

`version` is a short, monotonically increasing build counter (just increment by 1 each push) — kept short so the topbar badge stays a glance-able `vN` rather than a long timestamp. `builtAt` carries the full detail and is shown alongside it in the Settings → About card.

`js/version.js` fetches it with `cache: 'no-store'` (and the service worker fetches it network-first) so the badge always reflects the deployed file, not a stale cache. It's shown in the topbar (links to Settings) and in the Settings → About card, so a quick glance confirms whether the tab is showing the latest deploy.

**Every push bumps two things in lockstep:** `version.json`'s `version` field, and `sw.js`'s `CACHE` constant (`'bayaz-vN'`, same N). Browsers only reinstall a service worker — and thus refresh everything it caches — when `sw.js`'s own bytes change. `version.json` is fetched network-first regardless, so if only it is bumped, the badge silently goes ahead of the actual cached app shell (users see a new version number but stale JS/HTML underneath). Keeping the counter embedded directly in `sw.js` guarantees the two can't drift apart.

**A new service worker installing does not update an already-open tab by itself** — `skipWaiting`/`clients.claim` make it take over new *requests*, but JS already loaded into memory keeps running until the page actually reloads. A PWA left open for days (never fully closed, just backgrounded) can sit on old code indefinitely even though the deploy behind it is current. `app.js` watches the registration for this and shows a plain "An update is ready — Reload" bar the moment a new worker finishes installing, rather than relying on someone noticing the version badge changed.

## Non-negotiables held

- API key lives only in the Worker environment.
- Full JSON export and restore of all data (Settings).
- Offline for everything except generator/judgment calls and external checkers; queued, retried, marked provisional.
- Plan import validates against the schema with per-path errors, then runs the teaching-order audit and refuses violating imports.
- No domain vocabulary in app code, UI strings, or schema field names (`migrate.js` alone references v1's historical wire-format ids, by necessity).

## Seed plan note

`public/plans/seed-plan.json` teaches Urdu prosody with hand-authored lesson content. Its item answers and teaching claims are plan data authored for seeding — verify them or replace the file with your own plan. Its `ck-scan-engine` external checker points at a placeholder URL; set your engine's real endpoint or leave the judgment fallback in place.
