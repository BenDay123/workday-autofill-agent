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