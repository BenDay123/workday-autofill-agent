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
- Architecture is hybrid as of v0.0.10+. Most widgets (text inputs,
  radios, checkboxes, button-style selects, pre-filled comboboxes)
  fill from the content script using the native-setter trick:
  `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set`
  bypasses React's per-instance value tracking, then dispatch
  `input` / `change` / `blur` from the isolated world.
  Combobox typeaheads use the two-script pattern: a main-world
  injected script (`src/injected/main.ts`) walks React fibers and
  invokes Workday's component handlers directly (`onSelectInputClick`,
  `onSearch`, `onSelect`), communicating with the content script via
  `window.postMessage` (namespaced `wa-v2`). The hybrid split is
  load-bearing: option clicks specifically don't fire on real DOM
  events on Workday's virtualized listbox, so the main-world
  invocation isn't optional.
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
- **Combobox typeahead fill: end-to-end working as of v0.0.17,
  including empty hierarchical pickers.**
  Last session's "empty combobox doesn't open" diagnosis was wrong.
  The opener (`onSelectInputClick` at depth 10) is just `() => { U() }`
  — takes no args, calls an internal popup-open. It DID open the
  listbox; we just couldn't see the result because the REAL gap was
  option-clicks, not opening. Workday's listbox options don't fire on
  real DOM clicks (no onClick on the option element itself); selection
  goes through React's `onSelect` prop at depth 2 of the option's
  fiber, signature `(item, evt, undefined)` where `item = { index }`
  and `evt` MUST have a callable `preventDefault` (handleSelectionEvent
  invokes it).
  v0.0.17 architecture:
  - Opener: `onSelectInputClick` at depth 10, invoked with no args
  - Filter: `onSearch` at depth 7, value-first signature `(query)` —
    flat-list combos filter to a 1-2-option subset; hierarchical
    combos ignore it
  - Match: `findFlatMatchInListbox` against current listbox
    (Phase D). If found, invoke `onSelect` on the matched option.
  - Filter-primed onSelect (Phase D2): if flat match fails, invoke
    `onSelect` on the FIRST visible option anyway — on some tenants
    (workday.wd5), Workday's internal state maps `index: 0` to the
    matching leaf even though the visible label is the parent
    category. Detect success via chip-indicator readback.
  - Hierarchical drill (Phase E): for category-tree pickers, invoke
    `onSelect` on each top-level category (priority-sorted by name
    match against target), look for a leaf match in the expanded
    sub-list, invoke `onSelect` on the leaf. Reset state between
    attempts via `onAutoHidePopup` + clear input + re-open.
  - Final defensive chip-check: before returning `no-match`, scan
    the chip indicator one more time — selections sometimes commit
    via unintended pathways (e.g., `autoHide` triggering Workday's
    CLICK_OUTSIDE-best-match commit when input has a query). The
    chip is ground truth.
  Per-tenant variation observed:
  - Nvidia (nvidia.wd5): clicking a category onSelect EXPANDS it
    inline, listbox replaced with sub-options. Chip text appears in
    parent wrapper as `"1 item selected, <value>"`.
  - Workday-corp (workday.wd5): clicking the first visible option
    after filter commits the matching leaf directly. Chip is
    rendered as a 1-option listbox near the input, no "items
    selected" prefix anywhere.
  Chip detection handles both: regex pattern in parent text chain
  OR a 1-option listbox within ~10 hops of the input in DOM tree.
  Removed in v0.0.17:
  - `tryHierarchicalSelect` in content.ts — used dispatchClickSequence
    which doesn't fire onSelect; never actually worked
  - `typeIntoCombobox` per-character typing — verified v0.0.8 to
    not trigger Workday's React filter, AND actively broke the v2
    path by polluting input state so subsequent `onSelectInputClick`
    didn't open the picker
  - The two are correlated: with typing gone, the v2 opener works
    reliably, no defensive re-clear needed in normal flow (kept as
    belt-and-suspenders).
  Live results (workday.wd5 contact-info step): 15 filled, 2 skipped,
  0 errors — up from 14/3 in v0.0.16. The 2 skipped are correctly
  pre-filled (Country button and Country Phone Code combobox).
- **Respect-existing-value policy (v0.0.18+).** When a widget already
  shows a non-default value that doesn't match the profile target,
  skip the fill rather than overwrite. Applies across all widget types:
  - Combobox typeaheads: main-world pre-flight chip-readback (fresh
    DOM, not stale scan-time `field.context`). Returns new
    `'skip-preselected'` status if chip ≠ target. Treats chip = target
    as already-filled.
  - Text inputs / textareas: skip if `el.value` non-empty and differs.
  - Button-style selects: skip if displayText non-empty, not a
    placeholder ("Select One"/"Choose..."), and differs from target.
  - Checkboxes: only block "uncheck what's already checked" — still
    allows checking unchecked boxes. Asymmetric on purpose because
    checkbox default state has no manual-vs-Workday distinction.
  - Radios: skip if any radio in the group is checked but isn't the
    one being processed.
  - Native `<select>`: skip if selected value/text non-empty, not a
    placeholder, and differs.
  Counts as `result.skipped++` with distinct `respecting existing
  value at <path>` log. This policy is load-bearing for graceful
  recovery from other bugs: when the v0.0.20 nullable-WorkAuth fix
  needed the user to manually re-click Yes, respect-existing-value
  prevented the still-stale profile from overwriting the correction.
- **Boolean → Yes/No translation (v0.0.19).** `searchVariants` adds
  "Yes"/"No" as alternates when the input is the literal string
  "true"/"false". Profile booleans get stringified by the caller; this
  closes the gap for button-selects and comboboxes whose listbox
  options use Yes/No labels. Radio fill already handles booleans
  natively (Workday radios have HTML `value="true"`/`"false"`).
- **Nullable WorkAuthorization (v0.0.20).** Schema fields
  (`authorizedToWorkInUS`, `requiresUSSponsorship`,
  `sanctionedCountryCitizenOrResident`, `currentOrFormerUSGovEmployee`)
  are typed `boolean | null`, default `null` in `createEmptyProfile()`.
  The fill path's existing `value == null` guard skips uncaptured
  legal questions. **Never default these to `false` again** — that
  silently mis-filled "Are you legally authorized to work in the US?"
  with No for every uncaptured user. Same risk profile likely applies
  to any future legal-disclosure boolean.
- **Mapping patterns must be anchored, not raw-substring (v0.0.21).**
  `matchString` uses `.includes()` for plain-string label signals.
  Raw substrings can match unintended fields: the canonical example
  is `{ label: 'City' }` matching "Ethnicity" because "ethni-CITY"
  contains "city". Use word-boundary regex (`/\bCity\b/i`) or anchored
  regex (`/^City\b/i`) instead. Latent variants likely exist in other
  plain-string mappings (e.g., `'First Name'` would substring-match
  "Preferred First Name" but mapping-order currently masks it). Audit
  when touching the mapping table.
- **Voluntary-disclosures radio capture (v0.0.22).** When a radio's
  mapping path starts with `voluntaryDisclosures.` AND its label has
  `"Question → Option"` format, capture writes the Option text
  (string) rather than the `checked` boolean. The schema slots are
  string-typed; without this, capture wrote `false`/`true` into a
  string field. Unchecked radios in the same group are skipped — the
  matched (checked) one carries the answer. WorkAuthorization radio
  capture stays boolean because those schema slots are explicitly
  typed `boolean | null`.
- **Date-shaped customAnswer patterns are rejected (v0.0.22).**
  Workday date-picker inputs sometimes carry the rendered date as
  aria-label, producing junk customAnswers like
  `{ pattern: "05/12/2026", answer: "12" }`. Regex check in the
  unmapped-field fallback skips patterns matching MM/DD/YYYY shapes.
  Explicit date-field handling (sentinels for "Today's Date" /
  signature dates) is a v2 nice-to-have, not in v1.