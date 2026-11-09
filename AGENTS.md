# AGENTS.md — Cadence AI Development Handoff

## 1. Project Context

Cadence is a Tauri v2 desktop music player with a React 19 renderer, SQLite/JSON library store, timed lyrics, translation, and romanization.

- Desktop: `src-tauri/` (Rust/Tauri v2)
- Renderer: `src/renderer/` (React 19, Vite, Zustand)
- Core/main services: `src/main/`
- Shared types: `src/shared/types.ts`
- Tauri bridge: `src/tauri/bridge.ts`

Primary commands:

```bash
npm test
npm run typecheck
npm run build
npm run dev
```

## 2. Current Branch

- Branch: `fix/translation-output`
- HEAD: `210bfc9` (version bump `1.1.0`)
- Remote tag `v1.1.0` points to this commit (force-updated).
- Working tree should be clean.

## 3. Major Work Completed on This Branch

### Translation
- Separated translation and romanization prompts.
- Fixed untranslated mixed-language segments by translating every segment into target language.
- Improved DevTools logging for cache, HTTP, request/response, parsing, and apply step.

### Romanization
- Added `romanizationMode: "line" | "word"` (`default: "line"`).
- Word mode aligns generated romanization to TTML spans/timings.
- AI returns `text` + `words`.
- Spans with spaces are preserved as timed parts.
- Non-Latin output is lowercased.
- Google legacy romanization also lowercases non-Latin output.

### Prompt / AI Cache
- AI prompt version bumped to `v: 14` (cache key version).
- Validation now accepts `text` and optional `words`.

### Settings / UI
- Added romanization display selector (Line / Word-by-word) in Settings → Appearance → Lyrics.
- Word-by-word mode gated by source `parts` and available AI words.

## 4. Files Most Likely Relevant for Next Work

- `src/main/lyrics/ai.ts`
- `src/main/lyrics/translation.ts`
- `src/tauri/bridge.ts`
- `src/renderer/features/lyrics/useLyrics.ts`
- `src/renderer/features/lyrics/parseLyrics.ts`
- `src/renderer/features/lyrics/BraccatoLyrics.tsx`
- `src/renderer/features/settings/SettingsView.tsx`
- `src/shared/types.ts`
- `src/main/settingsCore.ts`
- `tests/unit/lyricsAi.test.ts`

## 5. Verification Status

Last verified before push:

- `npm run typecheck` passed.
- `npm test` targeted `tests/unit/lyricsAi.test.ts`: 13/13 passed.
- Manual Cerebras tests for Japanese tracks succeeded:
  - word-by-word spacing fixed
  - span alignment works

Before larger changes, rerun:

```bash
npm run typecheck
npm test
npm run build
```

## 6. Known Caveats

- Remote history previously contained refactoring commits not present in this branch; this branch force-pushed over remote. Those changes (timed romanization refactor, thinking modes, `AGENTS.md`, robustness suite additions) may need cherry-pick if desired.
- `derivedCache` keeps older persisted keys; new cache key versions mitigate mismatches.
- Sidecar/file-supplied romanizations are not auto-lowercased.
- Word mode falls back to line when AI words do not align with source spans/parts.

## 7. Core Rules

- Inspect before editing.
- Make minimal surgical edits.
- Do not weaken tests.
- Never log secrets.
- Respect Windows paths/locking.