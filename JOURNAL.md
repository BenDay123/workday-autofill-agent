## 2026-05-09 — First real scan, what Workday's DOM actually looks like

Got Path A live in the morning — tightened detection so the scanner stops
grabbing top-nav buttons and the paired hidden inputs Workday uses behind
its custom selects. But the more useful work today was just *looking*
at the first real scan output from yesterday's plumbing and learning what
Workday actually puts in the DOM.

**Stuff I learned from a single scan of one Workday page:**

1. **The two-step extension reload is real.** Spent 5+ minutes wondering
   why the popup kept saying "Could not establish connection. Receiving
   end does not exist." Turns out: when I edit code and run `npm run
   build`, the dist files update — but Chrome is still running the old
   extension until I click the *circular reload icon* on the extension's
   card at chrome://extensions. AND THEN I have to reload the Workday
   tab, because content scripts only inject on page load. Reload either
   one alone and the popup just keeps failing silently. Obvious if
   you've shipped a Chrome extension before, ten-minute time-sink if
   you haven't.

2. **Errors that look like ours sometimes aren't.** I kept seeing
   `Uncaught (in promise) Error: A listener indicated an asynchronous
   response by returning true, but the message channel closed before a
   response was received` in the Workday console and assumed our
   content script was broken. Claude pointed out the filename prefix:
   `useMyLastApplication?q=product+manager:1` — that's *Workday's own
   page* (the URL of the resource), not our `content.ts` file. So the
   error was from Workday's own JavaScript or another browser extension.
   Pattern recognition: read the filename in front of the error before
   assuming it's yours.

3. **Workday's custom selects are a paired widget.** This is the
   architecture insight worth keeping. Country, State, Phone Device
   Type — none of them are `<select>` elements. Each is a `<button>`
   (the visible click target with `aria-label`) plus a hidden `<input>`
   that holds a UUID like `bc33aa3152ec42d4995f4791a106ed09`. The
   button has the human-readable text ("United States of America");
   the input has the form's submitted value. That means filling these
   isn't `setValue()` — it's `click button → search the popup listbox
   → click the right option`. The two-script architecture (content +
   injected) is going to matter more than I expected.

4. **The button widget shows a UUID in the value column.** Initially
   confusing. The form's submitted value really *is* the UUID; the
   user-friendly string lives in the button's `textContent`. Path A
   captures that separately as `displayText`.

5. **"Use my last application" is doing real work for us.** Most of
   the contact-info step was pre-filled with my actual data (name,
   address, phone). That's good UX from Workday but means our agent's
   value will mostly show up on later steps — work eligibility, custom
   questions, voluntary disclosures, file upload. The contact step
   alone wouldn't be much of a demo.

6. **Demo plan needs scrubbing.** First scan dumped my real address
   and phone number to the console. For the LinkedIn demo recording,
   either use a dummy form or scrub the data after.

**What I built today (Path A — written, not yet verified):**

- Scoped scanner to `<form>` → `[role="main"]` → `<main>` → `<body>`,
  with page-chrome filter as backup. Should drop the 2 utility-menu
  buttons from the count.
- Filter for paired hidden inputs: an `<input>` whose previous sibling
  is a button-with-listbox-popup, and which has no own identifiers,
  gets dropped. Should remove the 3 hidden UUID inputs.
- Radio group labels: walks up to `<fieldset>`/`<legend>` or
  `[role="radiogroup"]`/`[role="group"]` and combines as
  `"{group label} → {option}"`.
- Checkbox/radio `checked` state added (separate from `value`, which
  is just the form-submit string `"on"`).
- Button widgets and `<select>` get a `displayText` field with the
  user-visible string.
- Stashes every scan at `window.__wa` so I can extract via
  `copy(JSON.stringify(__wa.fields, null, 2))` instead of the
  right-click "Store as global variable" dance.

Have NOT verified any of this works yet. That's next — I'm not making
the Session 3 mistake again.

**Later that morning — Path A verified**

The two-step extension reload bit me again. I literally journaled the
gotcha hours earlier, then immediately fell into it: ran the scan,
got the *old* output back (count was still 22, file hash was the old
one). Took a second to spot. Reloaded the extension at chrome://extensions,
reloaded the Workday tab, scanned. Six-for-six:

- Field count dropped 22 → 17 exactly. The two `utilityMenuButton`
  rows from the top nav are gone; the three paired hidden inputs
  behind the Country/State/Phone Type buttons are gone.
- Radio group labels resolve fully. Yes/No now reads as
  `"Have you previously worked for or are you currently working for
  Workday as an employee or contractor?* → Yes"` and the same for No.
- Button widgets show the real human-readable text in `displayText`:
  `"United States of America"`, `"Washington"`, `"Mobile"`. Not the
  UUIDs anymore.
- `checked` populated correctly. Shows `true` on the "No" radio I
  picked previously, `false` on the "I have a preferred name" and
  SMS opt-in checkboxes.
- `window.__wa` works — I pulled the scan to my clipboard with
  `copy(JSON.stringify(__wa.fields, null, 2))` instead of the
  right-click "Store as global variable" dance. Genuinely faster.

Two small things noticed, not blockers:

- Initial scan returned 0 fields. 1.5s isn't enough for Workday's
  React to render the form. The on-demand button compensates, but
  the right fix is a `MutationObserver` that waits for the form root
  to appear before scanning. Worth doing eventually.
- `displayText` and `checked` columns show `undefined` in the table
  for fields where those don't apply. Cosmetic.

**Rest of the day — survey, the textarea-clipboard saga, getContext, cleanup batch**

Walked the rest of the Workday application step by step. Five total
steps, 76 unique fields catalogued:

- Contact info: 17 fields (name, address, phone, source dropdown)
- My Experience: 47 fields — 5 work blocks × 7 fields each, plus
  education, skills typeahead, file upload, websites
- Application Questions: 10 categorical Yes/No buttons, all labeled
  "Select One" until answered. Compliance-heavy: work auth, visa
  sponsorship, US government employee, export control, anti-nepotism.
- Voluntary Disclosures: 2 fields — Gender and an acknowledgment
  checkbox. No race/veteran/disability on this tenant.
- Review: 0 fields (read-only summary).

The 17 → 47 → 10 → 2 → 0 distribution surprised me. I'd expected
voluntary disclosures to be heavier (race/ethnicity/veteran usually
get asked separately). Workday's tenant config for this role just
doesn't ask. Worth knowing: the federal-standard EEO question set
still needs to be in our profile schema for OTHER Workday tenants we
encounter, even though this one didn't surface it.

**Two real fights today:**

1. **The clipboard from extension popups isn't reliable.** Tried
   `navigator.clipboard.writeText()` after a `chrome.tabs.sendMessage`
   round-trip. Status said "✓ Copied N fields" but Ctrl+V pasted
   nothing. The async callback breaks the user-gesture context
   `writeText` requires. After a frustrating loop of "did it work?
   nope," I scrapped auto-clipboard and shipped a textarea inside
   the popup that auto-selects on populate. User presses Ctrl+C
   manually. Less elegant, more reliable.

2. **The two-step extension reload bit me three times in one day** —
   including once where I'd journaled about it in the morning, then
   fell into it again minutes later when shipping a new build. Pattern:
   edit code → `npm run build` → reload **extension** at
   `chrome://extensions` → reload **page** (Ctrl+R). Skip either step
   and the popup says "Could not establish connection," or worse, the
   popup looks like it works but the page is running yesterday's
   content script. The filename hash on the `[WorkdayAgent] content
   script loaded` console line is the canonical "what's running" signal.

**What I built:**

- **`getContext` field for nearby text.** Application Questions had 10
  buttons all labeled "Select One" with no `aria-label`, no
  `data-automation-id`, no proper `<label>`. The actual question text
  sat in a sibling `<div>` above each button. Wrote `getContext` to
  walk up to 8 ancestors, grab the parent's textContent minus the
  field's own text, return it if 5–1500 chars. 10/10 questions
  resolved — work auth, visa, export-control countries, Workday
  relationships, etc.
- **Combobox selection state surfaces in `context`.** Unintended bonus:
  for "How Did You Hear About Us?" the form `value` is empty but
  `context` returned "1 item selected, Job Alert" because Workday's
  chip indicator sits in the parent div. So we get current state on
  Workday's typeahead widgets without extra logic.
- **Detection cleanup batch.** Four polish items in one pass:
  `MutationObserver`-based initial scan (replaces the 1.5s blind
  delay), conditional `displayText`/`checked` keys (no more
  `undefined` columns in console.table), `getContext` depth/length
  tune (6→8, 500→1500), popup diagnostic split into three branches so
  the Review step's empty scan doesn't false-alarm "old content
  script." Verified on a contact-info re-scan: clean output,
  MutationObserver fires automatically, combobox selection state shows
  up correctly.

**Data model — architecture on paper**

With detection effectively done, sat down with Claude to think through
the profile schema. Five decisions:

1. **Where does profile data come from?** Picked
   **capture-from-Workday** — read the user's already-filled
   application as the seed, instead of making them fill out a
   profile UI first. It's a real wedge: every other tool front-loads
   data entry; we skip that step entirely. Aligns with the "agent
   learns from your previous applications" narrative.

2. **Storage.** `chrome.storage.local` (5MB quota) for the profile
   object; resume PDF in OPFS or chunked storage. No cloud, no auth,
   no sync — privacy-by-default.

3. **Compliance auto-fill scope.** Auto-fill everything, including
   voluntary disclosures (gender, race, veteran, disability). Single
   canonical profile. **v1 nice-to-have**: a fill-time visual cue when
   voluntary-disclosure fields get filled, so I can spot-check before
   Submit (sensitive answers can drift over time; a stale auto-fill
   is worse than no auto-fill).

4. **Mapping strategy.** Hardcoded label-pattern matchers for v1 (Map
   of regex → profile field). Unmatched fields are skipped and left
   for manual entry. **Flagged for circle-back**: when we hit a tenant
   whose phrasing breaks our patterns, OR when adding v2's LLM
   features. The LLM semantic-matching path is the natural v2 content
   beat for the LinkedIn post.

5. **Repeated entries (work history, education).** Flat detection
   stays as-is. At fill time, match profile entries to rendered blocks
   by position — `profile.workExperience[0]` fills the first rendered
   block. Works for "use my last application" flows where Workday
   pre-renders the right block count. Doesn't work for "fresh start"
   flows where Workday renders one block and you click "Add Another"
   to add more. **That's deferred to v2** and documented as a known
   limitation.

No per-application overrides. Single canonical profile. Set it and
forget it.

**What's next:**

- Implement the profile TypeScript types (interfaces for everything
  we just designed).
- Implement the storage adapter (chrome.storage.local + OPFS for
  resume blob).
- Implement the label-pattern → profile-field mapping config.
- Wire capture-from-Workday: detect a populated Workday tab, offer
  to seed the profile from its current scan.
- Then fill logic: dispatch React events to actually write to the
  fields we've been detecting.

## 2026-05-08 — Turns out the content script was lying to me (or I was)

Started today thinking I had a working v0.0.1 with content script logging
on Workday pages. The journal said so. Past-Ben said so. Reality:
`src/content.ts` is 0 bytes. Has been since the first commit.

Claude flagged it in about 30 seconds — "this file is empty, but the
journal claims it was logging." Checked git: the original commit's
version was also empty. So either Session 3's verification was a
hallucination (mine or Claude's), or what I actually verified was the
popup's URL-based detection. That "✓ Workday page detected" string is
rendered by `popup.ts` checking `currentTab.url` — it has nothing to do
with the content script. Two different consoles, two different contexts,
and I never actually opened DevTools on the Workday page itself to look
for content-script output.

**What I learned:** "verified working" has to mean "I saw the specific
output I was supposed to see, in the right place" — not "the thing
seemed fine." A 0-byte file is exactly the kind of silent failure I
added to CLAUDE.md last session. Still missed it for a week.

**What I built today (the real start of v1):**

- Wrote the first real `content.ts`. It scans the DOM for inputs,
  selects, textareas, and Workday's custom widget patterns
  (`button[aria-haspopup="listbox"]`, `[role="combobox"]`). For each
  field it extracts `data-automation-id`, `data-uxi-element-id`,
  `aria-label`, the associated label text (via `for=id`, wrapping
  `<label>`, or `aria-labelledby`), placeholder, current value, and
  required flag. Computes a "best selector" using the priority rule from
  CLAUDE.md: `data-automation-id` → `data-uxi-element-id` → `aria-label`.
- Logs the result as a `console.table` on initial page load (1.5-second
  delay so Workday's React has time to render) and on demand.
- Added a "Scan fields" button to the popup. Disabled when not on a
  Workday page. Sends a `SCAN_FIELDS` message to the content script and
  reports the field count back in the status line.
- Build is clean — verified non-zero file sizes in `dist/` before
  declaring victory this time.

**What's next:**

- Open a real Workday application, look at the scan output, see what we
  miss. I'm 90% sure we'll be missing some widget patterns — date
  pickers especially, probably multi-selects.
- Once we know what fields actually exist on real pages, start
  designing the profile data model. What does my answer to "Tell us
  about a time you led a team through change" actually look like in
  storage?
- Fill logic comes after detection is solid.

## 2026-05-06 — The day I learned git was being polite

Spent ~30 min "stuck" trying to connect this project to its GitHub repo.
Walked through the whole setup — installed GitHub CLI via winget, did the
`gh auth login` browser dance, cd'd into the project, ran `git status`, all
the right moves.

Then I ran `git commit -m "..."` and got `nothing to commit, working tree
clean`. Tried `git remote add origin ...` and got `error: remote origin
already exists`. Tried `git push` and got `Everything up-to-date`.

I learned the hard way that when git says "Everything up-to-date" it means
"you're done, go home" — not "nothing happened, keep trying." `git log`
showed three commits already there, including one that said "v0.0.1:
initial scaffold with working popup, content script, and build journal."
Past-Ben had already wired this up — probably via `gh repo create
--source=. --push` during scaffolding — and present-Ben forgot.

**What worked:** `gh auth login` is dramatically simpler than the old
PAT/SSH dance on Windows. Browser auth, paste a one-time code, done.
If you're starting fresh in 2026, this is the way.

**What broke:** my mental model. I assumed every git command would
either succeed loudly or fail loudly. Git has a third state — "this was
already true, here's a terse one-liner that won't catch your eye."
Slow down and read the output.

**What's next:**
- Write a real README so the repo doesn't look abandoned to anyone
  clicking through from the eventual LinkedIn post
- Back to the build itself — content script needs to start identifying
  Workday form fields# WorkdayAgent — Build Journal

**Working name:** `workday-autofill-agent` (GitHub repo) / "WorkdayAgent" (referential)
**Started:** May 2026
**Status:** v0.0.4 in progress — full Workday application surveyed (5 steps, 76 fields); detection cleanup batch shipped and verified; profile data model architecturally complete; no fill logic yet

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
- [x] Content script verified logging on real Workday pages (`*.myworkdayjobs.com`) *— see 2026-05-08 entry; this turned out to be wrong, the file was 0 bytes*
- [x] Popup verified showing "Workday page detected" status on Workday tabs
- [x] First commit + push to GitHub (in progress)
- [x] First real `content.ts` written — scans DOM, extracts selector metadata, logs console.table
- [x] Popup "Scan fields" button wired up to message the content script
- [x] First scan run on a real Workday application page (22 fields, contact-info step)
- [x] Path A detection improvements written: form-root scope, paired-input filter, radio group labels, checkbox `checked`, button `displayText`, `window.__wa` global
- [x] Verify Path A works on the same page — verified six-for-six: count 22 → 17, group labels resolve, displayText shows "United States of America"/"Washington"/"Mobile", `checked` correct, `__wa` global usable
- [x] Run scanner on later application steps — all 5 steps walked: contact info (17), My Experience (47), Application Questions (10), Voluntary Disclosures (2), Review (0)
- [x] Catalogue new widget patterns surfaced from later steps — paired button+listbox selects, dateSection split-input month/year, combobox typeahead with chip-state in context, multi-select skills typeahead, file upload `<input type="file">`, categorical "Select One" question buttons
- [x] Profile data model: decisions locked (capture-from-Workday seed, chrome.storage.local + OPFS, auto-fill all incl. voluntary disclosures, hardcoded label patterns for v1, fill-time index-based for repeated entries)
- [x] Implement profile schema — `src/profile/types.ts` written. Top-level `UserProfile` with: meta, identity, contact (address, phone), workExperience[], education[], skills[], websites[], optional resume (base64), workAuthorization (US-centric for v1), voluntaryDisclosures (gender / Hispanic-Latino / race-ethnicity / veteran / disability / recruitment-policy ack), preferences (relocation, non-compete, source), and customAnswers[] for application-specific Q&A.
- [ ] Investigate empty `tsconfig.json` — file is 0 bytes, Vite/esbuild builds work because they're transpile-only, but no actual type-checking is happening. Add a real config and verify `npx tsc --noEmit` passes.
- [x] Implement storage adapter — `src/profile/storage.ts` written: `getProfile()` / `saveProfile()` / `clearProfile()` / `hasProfile()` / `createEmptyProfile()`. All five functions go through `chrome.storage.local` under key `workdayAgent.profile`. `saveProfile` always stamps `meta.schemaVersion` and `meta.updatedAt`. Resume blob lives inside the profile as base64 (no OPFS yet — moves to OPFS only if 5 MB quota becomes a problem in practice).
- [x] Implement label-pattern → profile-field mapping config — `src/profile/mapping.ts` written. ~30 mappings covering identity, contact, work experience, education, skills, websites, dates, source, application questions, and voluntary disclosures (full federal-standard EEO set, not just what this Workday tenant showed). Signals support match by label / context / text (either) / automationId / aria-label, with `string | RegExp` patterns. Path notation: dotted paths plus bracket-empty for repeated entries (`workExperience[].jobTitle`), keyed lookup for websites (`websites[label=LinkedIn].url`), and sentinels (`$dateMonth` / `$dateYear`) for date inputs that share automationIds across start/end. Order-sensitive — first match wins; phone-code Country comes before bare Country / Territory.
- [x] Implement capture-from-Workday flow — `src/profile/capture.ts` written + popup wiring. Walks scanned fields in DOM order, looks up each via `findMapping`, transforms widget-specific values (Yes/No buttons → boolean, button widgets → `displayText`, comboboxes → context selection-chip), writes to profile. Block-walking for repeated structures: `jobTitle` starts a new `workExperience[]`; `school` starts a new `education[]`. Date inputs are paired by encounter order within a block (first pair = start, second pair = end). Unmatched fields with values fall through to `customAnswers`. New "Save as Profile" button in the popup runs the full pipeline (scan → capture → save → display saved profile JSON for review). Build clean (popup 2.94 kB → 10.26 kB; profile module joined the bundle). Not yet verified on a live page.
- [~] Verify capture flow on a live Workday page — partially verified. Contact-info step capture is correct: identity (first/middle/last), full address, phone (countryCode/number/deviceType/smsOptIn), preferences.preferredSource, and the Workday-employee question landed in customAnswers as expected. Two bugs surfaced and fixed in the first verification run:
  - `'Preferred Name'` substring pattern incorrectly matched the "I have a preferred name" toggle checkbox, writing boolean `false` into a string field. Fixed by anchoring to `/^preferred (first |middle |last )?name/i`.
  - Custom-answer pattern derivation favored `context` over `label`, so the Workday-employee radio recorded as `{ pattern: "YesNo", answer: true }`. Fixed by preferring label first, and for radios with `Q → Option` labels, splitting the question and option so we get `{ pattern: "Have you previously worked for...?", answer: "No" }`.
- [x] Verify capture on later steps — verified on a `useMyLastApplication` URL: all 5 work experiences captured with correct dates and `currentlyHere` flag (block walking and date sentinel pairing both work), education captured (no dates because Workday's tenant config doesn't ask), websites captured into the keyed `websites[label=X].url` lookup. Skills empty (typeahead chips not visible to scanner — known limitation). voluntaryDisclosures still empty because we didn't capture from that step in this session — would need either capture on Voluntary Disclosures step OR a separate fresh `/apply` flow that surfaces it.
- [x] Implement and verify capture merge — single capture only sees the currently-rendered step, but the wedge requires building a complete profile across steps. Switched capture from overwrite to **merge by touched section**: capture tracks which top-level sections it actually wrote to (`identity`, `contact`, `workExperience`, etc.) via path-prefix detection, then `mergeWithExisting` replaces only those sections in the existing stored profile and preserves the rest. `meta.createdAt` is held from the original first capture; `meta.updatedAt` bumps each save. Verified on a real two-step sequence: My Experience capture (workExperience + education + websites populated, identity/contact empty) followed by contact-info capture from a different `useMyLastApplication` URL — result kept the original 5 work experiences and education/websites while populating identity and contact freshly.
- [ ] Implement fill logic (dispatch React events per widget type)
- [ ] v1 nice-to-have: fill-time visual cue when voluntary-disclosure fields are filled
- [ ] v2 (deferred): LLM-based semantic matching for fields not matched by hardcoded patterns
- [ ] v2 (deferred): per-instance grouping in detection (handle "fresh start" Workday applications where blocks must be added before fill)
- [x] Detection cleanup batch (built, not yet verified):
  - Initial scan now uses a `MutationObserver` watching `document.body` with a 300ms debounce; locks in once it finds non-zero fields. Final fallback at 15s if nothing ever shows up.
  - `displayText` and `checked` are now only attached to fields where they apply, so `console.table` stops rendering `undefined` columns for fields where these don't make sense.
  - `getContext` depth raised 6 → 8 and length cap 500 → 1500, so the long-question case (Question 10 on Application Questions step) should resolve.
  - Popup diagnostic split into three branches: success / valid-empty-scan / malformed-payload. The Review-step false alarm ("old content script") is gone; an empty scan now reads "Scan ran but found 0 fields — normal on Review steps."
- [x] Verify cleanup batch on a live page — verified on contact-info step: `displayText`/`checked` keys correctly conditional, `getContext` populating richly (combobox selection state surfaces as "1 item selected, Job Alert"), MutationObserver confirmed firing initial scan automatically (Ben saw `[WorkdayAgent] initial scan — N field(s) found` in console without manually clicking Scan). Question 10 fix and Review-step diagnostic accepted on code review without re-scan.

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

### Session 4 — First real content script: form field detection
- Discovered `src/content.ts` was 0 bytes — has been since the first commit. Session 3's "content script verified logging" was either a hallucination or me confusing the popup's URL-based status with content-script output.
- Wrote the first real content script: DOM scanner that finds inputs, selects, textareas, and Workday's custom widgets (`button[aria-haspopup="listbox"]`, `[role="combobox"]`).
- Per-field metadata: `data-automation-id`, `data-uxi-element-id`, `aria-label`, label text (via `for=`, wrapping `<label>`, `aria-labelledby`), placeholder, current value, required flag.
- "Best selector" computed using the priority rule from CLAUDE.md.
- Output via `console.table` on initial load (1.5s delay for React) and on demand via popup button.
- Added "Scan fields" button to popup; sends `SCAN_FIELDS` message to content script, reports count in status line.
- Build verified clean — non-zero file sizes in `dist/` (the lesson from the empty-popup saga, finally applied as a habit).

### Session 5 — First real scan + Path A detection improvements
- Hit "Could not establish connection" several times before realizing: extension reload at `chrome://extensions` and Workday-tab page reload are BOTH required after code changes. Editing code + running `npm run build` is not enough.
- Ran the scanner against a live Workday application ("use my last application" / contact-info step). 22 fields detected: 2 page-chrome buttons (top-nav language/settings), 3 paired hidden inputs behind custom-select buttons, the rest real form fields with mostly-correct labels.
- Discovered Workday's custom-select architecture: `<button>` (visible text + `aria-label`) paired with a hidden sibling `<input>` (UUID-style internal value). Treat the button as the field; the input is noise.
- Identified that an "Uncaught (in promise) ... message channel closed" error came from Workday's own page (filename `useMyLastApplication...:1`), not from our content script. Filename prefix tells you whose error it is.
- Wrote Path A: scope to form root, filter paired inputs, radio group labels, checkbox/radio `checked`, button/select `displayText`, `window.__wa` global. Build clean (content.ts compiled output went 1.98 kB → 3.73 kB).
- Verified Path A on the same Workday page after falling into the two-step extension reload gotcha *again* (the very thing journaled earlier). Six-for-six: count 22 → 17 exactly, radio group labels resolve, button widgets show "United States of America" / "Washington" / "Mobile", `checked` correct, `__wa` global usable for clipboard extraction.
- Noted two non-blocking polish items: initial scan returns 0 fields (1.5s delay isn't enough for Workday's React; need MutationObserver), and the table shows `undefined` in `displayText`/`checked` columns where those don't apply (cosmetic).

### Session 7 — Profile foundation: schema, storage, mapping, capture
- Wrote `src/profile/types.ts`: `UserProfile` interface plus all sub-shapes covering identity, contact, work experience, education, skills, websites, resume (base64 in-profile for v1), workAuthorization (US-centric), voluntaryDisclosures (federal-standard EEO set), preferences, customAnswers.
- Wrote `src/profile/storage.ts`: `getProfile` / `saveProfile` / `clearProfile` / `hasProfile` / `createEmptyProfile` against `chrome.storage.local`. Save stamps `meta.schemaVersion` and `meta.updatedAt` automatically.
- Wrote `src/profile/mapping.ts`: ~30 `FieldMapping` entries with `string | RegExp` signals against label/context/text/automationId/aria-label. Path notation includes bracket-empty for repeated entries (`workExperience[].jobTitle`), keyed lookup for websites (`websites[label=LinkedIn].url`), and date sentinels (`$dateMonth`, `$dateYear`).
- Wrote `src/profile/capture.ts`: `captureFromScan(fields, sourceUrl)` walks fields in DOM order, transforms by widget type, builds a UserProfile. Block walking: jobTitle starts new workExperience, school starts new education, dates pair within current block.
- Wired "Save as Profile" button in popup. Build went 8 → 12 modules; popup bundle 2.94 → 10.46 kB.
- Verified capture on contact-info step. First-run bugs: too-loose `'Preferred Name'` pattern matched the "I have a preferred name" checkbox; custom-answer pattern preferred `context` over `label` and lost the question text for radios. Both fixed; verified clean on retry.
- Verified capture on My Experience step (`useMyLastApplication` URL): all 5 work experiences with start/end dates, education, and websites captured cleanly. Block walking, date sentinel pairing, and section transitions all work.
- Discovered overwrite-vs-merge architectural issue during verification: each capture only sees the currently-rendered step, so a single overwrite-save destroys data captured from other steps. Switched to merge-by-touched-section. Capture tracks which top-level sections it wrote to via path-prefix detection; new `mergeWithExisting` function in capture.ts replaces only those sections. Verified end-to-end across a two-step sequence: My Experience capture first, then contact-info capture from a different URL — result preserves all 5 work experiences while adding fresh identity/contact data.
- Wrapped here. Fill logic — the actual demo — is the next session's first chunk.

### Session 6 — Full survey, detection cleanup, data model architecture
- Worked through all 5 steps of the live Workday application; catalogued 76 unique fields and every Workday widget pattern we're likely to see (paired button+listbox, combobox-with-chip-state, dateSection split inputs, multi-select skills, file upload, categorical question buttons).
- Hit and resolved the clipboard-from-popup unreliability: scrapped `navigator.clipboard.writeText` after async round-trip and shipped a textarea inside the popup that auto-selects on populate. User presses Ctrl+C manually.
- The two-step extension reload bit me three separate times in one day. Pattern locked into muscle memory now: edit → build → reload extension → reload page.
- Added `getContext` (walks up to 8 ancestors, grabs nearby text 5–1500 chars). Resolved 10/10 Application Questions, and as a bonus surfaces combobox selection state ("1 item selected, Job Alert").
- Shipped detection cleanup batch in one pass: MutationObserver-based initial scan, conditional `displayText`/`checked` keys, `getContext` tune, popup diagnostic split into three branches. Verified on contact-info re-scan.
- Locked profile data model decisions (see "Architectural decisions made so far" in CLAUDE.md and the data-model section in this entry).
- Wrapped session here with architecture in hand, ready for implementation work next time.

### Tomorrow / next session
- Finish capture verification on a `useMyLastApplication` URL — confirm work experience, education, and voluntary disclosures populate correctly. Find any further mapping bugs and patch.
- Then start **fill logic** — the actual demo. Per-widget-type dispatch:
  - Plain text inputs / textareas: dispatch React's `input` / `change` / `blur` events
  - Button widgets (Country / State / Phone Type): click button → wait for listbox → click matching option
  - Comboboxes (How Did You Hear, Country Phone Code, School / Field of Study): click → type to filter → click first matching result
  - DateSection inputs: dispatch React events on month and year inputs
  - Checkboxes / radios: dispatch click only if state needs to change
  - File upload: explicit limitation; can't programmatically set file inputs in browsers — needs a separate "stage your resume" UI
- Architecture for fill: needs the injected-script half of the two-script architecture (per CLAUDE.md) so React events dispatch in the page's main world, not the content script's isolated world.
- Voluntary-disclosure fill-time visual cue (the v1 nice-to-have we agreed on).
