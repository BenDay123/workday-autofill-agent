# WorkdayAgent — Build Journal

**Working name:** `workday-autofill-agent` (GitHub repo) / "WorkdayAgent" (referential)
**Started:** May 2026
**Status:** v0.0.1 fully functional — popup working, content script logging on Workday pages

## What this is

A Chrome extension that auto-fills Workday job applications, built in public as an exercise in agent architecture and AI-era PM building. The tool is the artifact; the build narrative is the asset.

## Why this exists

- I'm a senior PM (20+ years) who's been job hunting since January 2026
- Workday's application UX is universally hated; I want to feel that pain less
- I want to build my first agent and learn the craft
- Shipping a working AI-era tool during an active job search is strong positioning, regardless of whether the tool itself catches on

## Key decisions made so far

### Project framing: build-in-public, not competing tool
**Decision:** Position this as "I built a Workday autofill agent with Claude in a weekend — here's what I learned" rather than "use my new product."
**Rationale:** Initial scan showed the autofill space is crowded (Simplify Copilot, SpeedyApply, Anthropos 1-click Apply, Apply4Me). Competing on features is a losing game. But "PM, not engineer, building an agent in public" is a fresh angle and stronger personal-brand content. The tool is evidence; the story is the value.

### Workday-specific wedge
**Decision:** Build for Workday only. Don't try to support multiple ATS platforms.
**Rationale:** Most existing tools go broad and shallow. Going deep on Workday's specific quirks (bad resume parser, weird date pickers, custom-question patterns) is a real wedge — and a tighter scope to actually ship.

### Architecture: extension-first, LLM later
**Decision:** v1 is a deterministic Chrome extension with no LLM dependency. v2 (later) adds opt-in LLM features (custom-question drafting) using a user-supplied API key.
**Rationale:** v1 ships fast, has no API-key adoption friction, keeps all data local (privacy by default). v2 is where the genuine "agent" learning happens and becomes a follow-up content piece.

### Stack: TypeScript + Vite 8 + @crxjs/vite-plugin
**Decision:** Use TypeScript, Vite 8, and the crxjs plugin (currently the modern standard for Chrome extensions with TS).
**Rationale:** TS reads as more professional on GitHub. Vite + crxjs handles the manifest/build orchestration so we can focus on actual logic. Type safety also helps catch bugs in form-field-mapping logic.

### Manifest defined in TS, not JSON
**Decision:** Use crxjs's `defineManifest()` helper inside `vite.config.ts` instead of a separate `manifest.json` file.
**Rationale:** Forced into this after fighting JSON-import issues with ESM mode for an hour, but it turns out to be the recommended modern pattern: type-checked, version-syncable with package.json, supports dev/prod variants. We arrived at the right answer the hard way.

### Name: NOT ApplyAssist
**Decision:** Use a descriptive developer-flavored name (`workday-autofill-agent`) rather than a polished consumer brand.
**Rationale:** ApplyAssist conflicted with applyassist.com (an Australian education-application platform). More importantly, since this isn't positioned as a consumer product, brand polish matters less than clarity.

## Narrative hook (draft for LinkedIn post)

> "I'm a senior PM, not an engineer, and I've been job hunting since January. I got tired of Workday. So I sat down with Claude and built my first agent in a weekend. Here's what I learned about agent architecture — and the working open-source result."

## Setup progress

- [x] Decided on stack: TypeScript Chrome extension
- [x] Decided on dev environment: Windows (Surface Laptop)
- [x] Node.js LTS installed (v24.15.0) + Chocolatey + build tools
- [x] VS Code installed
- [x] Git installed and configured
- [x] GitHub account confirmed (BenDay123)
- [x] Repo created at https://github.com/BenDay123/workday-autofill-agent
- [x] Cloned locally to `C:\Users\Benday\dev\workday-autofill-agent`
- [x] Project scaffolded (manifest, vite.config.ts, tsconfig.json, content script, popup)
- [x] First successful build (`npm run build` → `dist/` folder)
- [x] Extension loaded into Chrome — WorkdayAgent v0.0.1 visible in chrome://extensions
- [x] Popup verified showing correct status on non-Workday tabs
- [x] Content script verified logging on real Workday pages (`*.myworkdayjobs.com`)
- [x] Popup verified showing "Workday page detected" status on Workday tabs
- [x] First commit + push to GitHub (in progress)
- [ ] Start v1 work: form field detection and autofill logic

## Open questions / future decisions

- Demo strategy for LinkedIn post (screen recording? GIF? live demo?)
- v2 LLM integration — Anthropic API direct, or a thin proxy?
- Marketing the post: timing, who to tag, where else to share
- Icons for the extension (currently using Chrome's auto-generated default)
- Whether to refactor popup into project-root structure (currently nested under `src/popup/`, official templates put it at root)

## Notes for the LinkedIn post (capture as we go)

- "Aha" moments where the agent surprised me
- Tricky Workday-specific quirks discovered
- Architectural decisions and tradeoffs
- Where Claude was helpful vs. where I had to think for myself
- Honest assessments of how much I (a non-engineer) actually understood vs. trusted the AI

### Build-setup lessons (Sessions 2–3 — gold for the post)

**The setup phase ate way more time than the actual code.** Almost no feature code yet, but 7+ distinct errors solved during scaffolding. This is the texture of modern JS tooling that PMs underestimate when scoping engineering work. A non-exhaustive list of what bit me:

1. **PowerShell execution policy blocked npm scripts.** `npm.ps1` can't run by default on Windows. Had to set `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser`. First "this is Windows" moment.
2. **npm audit screamed "high severity" — but it didn't apply.** The vulnerability was in a build-time tool processing my own source code. Lesson: severity ratings don't account for whether a vulnerability is actually exploitable in your specific context.
3. **VS Code's "New File" path UX created `src/src/popup/popup.html`.** Had to clean up nested folders. The button creates files relative to the selected folder — typing a full path inside it gets you a duplicated parent.
4. **`"type": "commonjs"` in package.json silently broke the entire build pipeline.** Vite + crxjs needs ESM. The error message ("Cannot resolve entry module index.html") gave zero hint that the root cause was a single string in package.json.
5. **Switching to `"type": "module"` then broke the JSON manifest import.** ESM is stricter about importing JSON. Tried a runtime `readFileSync` workaround, which then broke because Vite bundles the config to a temp directory before executing it, so relative paths resolve to the wrong place.
6. **Finally switched to `defineManifest()` inline in vite.config.ts.** Eliminated the JSON file entirely, which turned out to be the recommended modern pattern anyway. Arrived at the right answer the hard way.
7. **The build silently produced an empty popup.html.** Worst kind of bug — `npm run build` succeeded with no errors. The output even reported file sizes. But `dist/src/popup/popup.html` was 0 bytes. The popup loaded in Chrome as a blank rectangle. Took inspecting the popup with DevTools to confirm the HTML body was completely empty. Root cause: my script tag was `<script src="popup.ts">` (no path prefix). Vite couldn't resolve it as a TypeScript entry point and silently failed HTML processing. Tried `./popup.ts` — got a loud error this time ("Failed to resolve /popup.ts"). The fix was the absolute-from-project-root form `/src/popup/popup.ts` — which is what every official crxjs template uses, but I wouldn't have known to look. Total time on this one bug: ~45 minutes.

**The meta-lesson:** every layer of abstraction in the modern JS toolchain is solving a real problem, but the error messages rarely point you at the layer that's actually broken. Debugging is mostly pattern recognition — figuring out which layer smells like the failure mode. And the worst bugs are the silent ones that produce a "successful" build with broken output.

**The PM lesson:** I structured my project the way that felt logical to me as a PM (popup files nested under `src/popup/`), and immediately collided with framework conventions I didn't know existed. The official crxjs templates put `index.html` at the project root. My structure technically works, but every path resolution edge case I hit was downstream of that early "logical to me" decision. Convention exists for a reason — even when you don't know the reason yet.

## Session log

### Session 1 — Project framing
- Confirmed the problem: Workday application form pain
- Researched competitive landscape; pivoted from "competing product" to "build-in-public artifact"
- Rejected ApplyAssist (name taken); landed on `workday-autofill-agent` as working name
- Chose TS + Chrome extension + Windows dev environment

### Session 2 — Setup and v0.0.1 alive
- Installed Node.js, VS Code, Git on Surface laptop (first time setting up dev env on this machine)
- Created GitHub repo, cloned locally
- Scaffolded project: manifest, vite config, tsconfig, content script, popup HTML+TS
- Hit and resolved 6 build/setup errors (see "Build-setup lessons" above, items 1–6)
- First successful `npm run build` — `dist/` folder generated
- Loaded unpacked extension into Chrome — WorkdayAgent v0.0.1 visible and active
- Stopped before functional verification

### Session 3 — Verification, the empty-popup saga, first commit
- Started morning with verification: popup clicked from toolbar showed empty rectangle
- Realized the build had been silently producing an empty `dist/src/popup/popup.html` (item 7 above)
- Diagnosed via DevTools "Inspect popup" — confirmed HTML body was literally empty
- Walked through several wrong fixes (`./popup.ts` got rewritten to `/popup.ts`, errored)
- Found right answer in official crxjs templates: absolute path from project root (`/src/popup/popup.ts`)
- Build succeeded with proper popup output
- All three verification steps passed:
  - Popup shows correct default status on non-Workday tabs
  - Content script logs on `*.myworkdayjobs.com` pages (verified in DevTools console)
  - Popup status changes to "✓ Workday page detected" on Workday tabs
- First commit: `v0.0.1: initial scaffold with working popup and content script`
- Pushed to GitHub — repo is live

### Tomorrow / next session
- Migrate this build work into a Claude Project for cleaner ongoing context
- Sketch v1 architecture: form field detection strategy
- Decide on profile data model (what fields to store, how, where)
- Start writing the first real form-detection logic on a known Workday application page
