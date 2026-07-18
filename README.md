# Mastering Urdu Shayari

A personal learning-session engine for Urdu shayari, built as an offline-first PWA. Vanilla JS/HTML/CSS, no framework, IndexedDB for storage, deployed on Cloudflare Pages with a Cloudflare Worker (Pages Functions) proxying the Anthropic API.

**Core principle:** the app owns all state. The Claude API is stateless and receives a freshly assembled context payload each call. Plans are data files, never code.

## Architecture

```
public/               the PWA (static, deployed as-is)
  js/db.js            IndexedDB storage layer (plans, nodes, categories, artifacts, sessions, queue)
  js/schema.js        plan validation with exact JSON-path error messages
  js/ledger.js        skill nodes: status, accuracy, confidence decay, spaced repetition, plateau flags
  js/checkers.js      deterministic checkers + pluggable registry (behr-engine slot)
  js/assembler.js     session assembly: standing elements → lesson drills → interleaved review → flags
  js/context.js       generator payload (~3k tokens) and minimal evaluator payload
  js/api.js           Worker client + offline queue with retry
  js/session.js       session runtime: deterministic-first grading, ledger deltas, artifacts
  js/views/           today (default), progress, portfolio, settings
  plans/urdu-shayari-plan.json   seed plan #1
functions/api/        the Cloudflare Worker (Pages Functions)
  generate.js         generator call — full context, returns prose
  evaluate.js         evaluator call — drill + answer + response only, strict JSON via json_schema
```

### Two-call architecture

- **Generator** (`/api/generate`) teaches, hints, explains. Gets the full context payload: current lesson + objective, exercised skill nodes with status/accuracy, matched error categories with real instances, the last 2–3 artifacts with revision chains, calibration examples, and the plan's tutor instructions verbatim.
- **Evaluator** (`/api/evaluate`) gets only the drill, the correct answer, and the user's response — no teaching context — and returns strict JSON (`correct`, `errorCategoryId` / `newCategory`, `confidenceDelta`, `note`) enforced with structured outputs (`output_config.format` json_schema). Pedagogy is never parsed out of prose.

### Deterministic-first

Drills marked `deterministic` are graded by local code, never the API: scansion pattern diffs, matra totals, exact-word matching. `hybrid` drills are scanned by code and only the semantic axis is judged by the API. The scansion checker is a pluggable slot — wire in the ShayriWorkshop behr engine via `registerChecker('behr-engine', fn)` in `public/js/checkers.js` to scan raw Urdu text instead of comparing typed patterns.

### Offline

Everything works offline except generation and judgment calls. Judgment calls are queued in IndexedDB and retried when the connection returns; deterministic grading never needs a connection. The service worker caches the full app shell.

## Deploying

1. Create a Cloudflare Pages project pointed at this repo.
   - Build command: *(none)*
   - Build output directory: `public`
   - The `functions/` directory is picked up automatically as Pages Functions (the Worker).
2. In the Pages project settings → Environment variables, add:
   - `ANTHROPIC_API_KEY` — **only here, never in the browser.**
   - `ANTHROPIC_MODEL` — optional, defaults to `claude-opus-4-8`.
3. Open the deployed URL on the tablet and "Add to Home Screen". The manifest requests fullscreen display for kiosk use.

Local development: `npx wrangler pages dev public` (serves the static site and the Functions together; pass the key with `--binding ANTHROPIC_API_KEY=...` or a `.dev.vars` file).

## Plans

Plans are user-authored JSON, imported in Settings and validated against the schema (`public/js/schema.js`) with per-field error paths. A plan declares: phases → weeks → lessons (id, title, objective, mastery criteria, drill types, skill nodes), standing elements (recurring blocks that open every session — this plan has a 5-minute behr rep), skill nodes, drill types with evaluation modes (`deterministic` / `judgment` / `hybrid`), error categories with real instances, calibration examples, an item bank, and the tutor instructions as a verbatim text block — the method is per-plan data, not app logic.

The bundled seed plan (`public/plans/urdu-shayari-plan.json`) is imported automatically on first run. **Its item-bank answers (taqti patterns, matra totals) are plan data authored for seeding — verify them or replace the file with your own plan export.**

## Non-negotiables held

- API key lives only in the Worker environment.
- Full JSON export (and restore) of all data in Settings.
- Offline for everything except generation/judgment; those queue and retry.
- Plan import validates against the schema and reports errors with exact paths.
- One screen shows today's session only; "sessions completed" is displayed nowhere.
