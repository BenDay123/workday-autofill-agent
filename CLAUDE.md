# Project: Workday Autofill Agent

A Chrome extension that fills Workday job applications. Build-in-public.

## Tech Stack
- TypeScript + Vite 8 + @crxjs/vite-plugin
- Windows (Surface Laptop), PowerShell

## About the user
- Ben Day — senior PM, 20+ years. NOT an engineer.
- Calibrate technical explanations accordingly.
- Walk through commands and code with full context.
- Catch silent build failures early (e.g., 0-byte output files) instead
  of celebrating "no errors" alone.

## Project rules
- Workday-only is the wedge. Don't suggest broadening to other ATS platforms.
- The build narrative is the asset; the working tool is the artifact.
- End goal: a LinkedIn post showcasing the build journey, with the tool
  as proof of work.

## Conventions
- Update JOURNAL.md at session end with what was decided, what worked,
  what broke, and what's next.
- Keep the journal in Ben's voice (first person, authentic, includes
  "I learned the hard way" texture).
- "QQ" from Ben means "quick question" — answer briefly and plainly.

## Architectural decisions made so far
- Two-script architecture (content script + injected script with message
  passing) was originally documented as required for Workday's
  React-controlled inputs, but v1 fill logic actually uses
  content-script-only with the native-setter trick (use
  `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set`
  to bypass React's per-instance value tracking, then dispatch
  `input` / `change` / `blur`). This works because the prototype's
  setter is callable from any JS context that has a reference to the
  DOM element. The two-script pattern is the documented fallback if
  we hit a widget where content-script-only fails (e.g., Shadow DOM
  or deeper React internals).
- Selector priority: data-automation-id > data-uxi-element-id >
  aria-label/role. Never rely on class names or wd-prefixed IDs.
- Fill technique: dispatch React's events (input/change/blur), don't
  set .value directly.
- Workday's custom selects (Country, State, Phone Device Type, etc.)
  are paired widgets: a `<button>` (visible text, `aria-label`, the
  click target) plus a sibling hidden `<input>` holding a UUID-style
  internal value. Treat the button as the field; filter the paired
  input as noise during detection. Filling these requires
  `click button → search popup listbox → click option`, not
  `setValue()`.
- Profile data entry (v1): capture-from-Workday. Read the user's
  already-filled Workday application as the seed profile, instead of
  making them fill out a separate profile UI first. This is the
  product wedge — every other autofill tool front-loads data entry,
  we skip it.
- Profile storage: `chrome.storage.local` for the profile object;
  resume PDF in OPFS (or chunked storage). Local-only, no cloud, no
  sync. Privacy by default.
- Compliance answers (v1): auto-fill ALL fields, including voluntary
  disclosures (gender, race, veteran, disability). Single canonical
  profile, no per-application override layer. Set-it-and-forget-it.
  Nice-to-have for v1: a fill-time visual cue when voluntary-disclosure
  fields are populated, so the user can spot-check before Submit.
- Capture-from-Workday is multi-step: each capture only sees fields
  rendered on the currently-visible Workday step. To build a complete
  profile, the user clicks "Save as Profile" on each step they navigate
  through. The popup uses `mergeWithExisting` to apply only the
  granular paths the current capture actually wrote — object leaves
  (e.g., `preferences.preferredSource`), array sections all-or-nothing
  (`workExperience[]`), and keyed entries (`websites[label=LinkedIn]`,
  `customAnswers[pattern=...]`). Fields not visible on the current step
  are preserved from the prior stored profile, including sibling fields
  in the same section that capture didn't touch. `meta.createdAt` is
  held at the first-ever capture; `meta.updatedAt` bumps on each save.
- Field mapping (v1): hardcoded label-pattern matchers (Map of regex
  → profile field). Unmatched fields are skipped and left for manual
  entry. Circle back to LLM semantic matching for v2 — that's the
  planned content beat for the LinkedIn post.
- Repeated structures (work experience, education): flat detection,
  fill-time index-based matching. v1 supports only flows where
  Workday has already rendered the right number of blocks (e.g.,
  "use my last application"). Fresh-start flows where Workday renders
  one block and the user must click "Add Another" to expand are
  explicitly out of scope for v1; deferred to v2.
- **Combobox typeahead fill: v1 limitation + v0.0.10 v2 scaffold in
  place, awaiting first live test.** Text inputs, button widgets
  (Country, State, Phone Device Type), radios, checkboxes, and
  customAnswers all fill correctly via content-script-only logic.
  But Workday's combobox typeahead widgets (the `selectinput-*`
  `data-uxi-element-id` pattern — e.g., "How Did You Hear About Us?",
  "Country / Territory Phone Code", "School", "Field of Study") don't
  respond to synthetic DOM events from the content script. We verified
  the native value setter writes the input correctly (`el.value` reads
  back as expected after typing), but Workday's React filter handler
  never fires — regardless of which event types we dispatch (`keydown`,
  `beforeinput`, `input`, `keyup`).
  Two sub-categories observed:
  - **Flat-but-virtualized** lists (e.g., Country Phone Code): ~200
    countries, only ~23 rendered at a time, alphabetically.
  - **Hierarchical** lists (e.g., "How Did You Hear About Us?"): top
    level is categories ("Advertisement", "Partnership"); leaves like
    "Internet Advertisement" live inside. The hierarchical fallback in
    `fillCombobox` (v0.0.9) walks top-level options for tree pickers
    of ≤10 categories, prioritizing categories whose name appears in
    the target value — content-script-only, works without main-world
    access.
  v0.0.10 added the v2 architecture scaffold:
  `src/injected/{protocol.ts,main.ts,bridge.ts}` plus a second
  `content_scripts` entry with `world: 'MAIN'` `run_at: 'document_start'`
  in `vite.config.ts`. The main-world script walks the React fiber for
  a target combobox input, finds the first ancestor exposing a callable
  handler matching the `CANDIDATE_HANDLER_NAMES` allowlist, uses the
  prototype value setter, and invokes the handler with a synthetic
  React-shaped event. Diagnostic-first: every combobox fill attempt
  also sends a `fiber-inspect` request whose response logs every
  on-prefixed handler prop visible on ancestor fibers — so the first
  live test produces the data needed to refine the allowlist if
  Workday's combobox uses a non-standard handler name. Open unknown:
  the @crxjs/vite-plugin emits the main-world script as a loader with
  dynamic `import()`. If Workday's page CSP blocks that, the failure
  mode is silent (no `[WorkdayAgent main-world] injected` log + 4-second
  bridge timeouts on each combobox); fallback would be inlining the
  bundle as an IIFE and injecting via `<script>` tag from the content
  script.