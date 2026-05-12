## 2026-05-12 — Five bug-fix versions in one session, and "Ethni-city"

Came in this morning with one item on the punch list: "test v0.0.17 on a
fresh-start flow (non-useMyLastApplication)." Closed the laptop tonight
having shipped **v0.0.18 → v0.0.22** — five tagged versions, five
distinct bug classes, all surfaced by running the agent against a real
Nvidia application I haven't touched before. None of these were on
yesterday's "what's next" list. They didn't exist in my head until I
saw them fail.

This is, I think, the most productive session I've had on this project.
It's also the one where I learned the most about how fragile the line
is between "the tool works" and "the tool quietly does the wrong thing
in a way no one notices until it's embarrassing."

**v0.0.18 — respect existing manual choices.**

I'd manually picked NVIDIA.COM in the "How Did You Hear About Us?"
dropdown before running the agent (because I was applying through
Eightfold and didn't want the agent to wipe that). The agent ran, saw
the chip showing "NVIDIA.COM", didn't recognize it as matching the
profile's "Internet Advertisement", and tried to overwrite. The
hierarchical drill ate the popup state and the agent gave up. End
result was right by accident — my manual NVIDIA.COM survived because
the overwrite failed — but the design was wrong.

The fix is a policy change as much as a code change: when a field
already shows a non-default value that doesn't match the profile
target, respect the existing value. Don't try to write over it. Skip,
log distinctly. The check sits in two places:

- **Combobox typeaheads**: main-world pre-flight chip readback (fresh
  DOM, not the stale `field.context` from scan time). New
  `'skip-preselected'` status threads back to the content script.
- **All other widgets** (text inputs, button-selects, radios,
  checkboxes, native selects): a `hasUnmatchedExistingValue` helper
  inspects the live element and decides whether to fill or respect.

This change ended up saving me from worse bugs later in the same
session. Specifically: when I manually clicked "Yes" to correct the
work-authorization screw-up (more on that below) BEFORE updating the
profile, the agent's next run respected my manually-clicked Yes
instead of re-writing No on top. That's belt-and-suspenders behavior I
hadn't planned for but was very glad to have.

**v0.0.19 — boolean values can't find Yes/No options.**

Hit the work-auth step. Agent log:

```
fillButtonWidget: no option matched "false". Searched variants:
  ["false"]. Listbox has 3 option(s): ['Select One', 'Yes', 'No']
```

The profile had `authorizedToWorkInUS: false` (boolean). The agent
stringified it to literally `"false"` and looked for that string. No
match. Workday's listbox uses Yes/No labels — the radio path handles
booleans because the HTML `value` attribute on Workday radios is
literally `"true"`/`"false"`, but button-selects don't have that escape
hatch. Cross-widget gap I'd never noticed because I'd only tested
booleans on radio Yes/No questions until now.

Fix: extend `searchVariants` to add Yes/No alternatives when the input
is `"true"`/`"false"`. One-line change. Covers buttons, comboboxes, and
native selects in one place.

**v0.0.20 — the silent-false-default catastrophe.**

Same step, after the v0.0.19 fix. Agent ran. Log:

```
fillButtonWidget: clicking option "No" for target "false"
```

I noticed it had filled "No" for "Are you legally authorized to work in
the United States?" I'm a US citizen. The answer is Yes. **The agent
had just answered a federally-significant employment question wrong.**

The chain of failure: `createEmptyProfile()` defaults
`authorizedToWorkInUS: false`. My capture flow had never visited a
page with this question, so the field stayed at its default. Profile
says `false`. Agent reads `false`, looks up "No" via the v0.0.19 fix,
clicks it. Everything worked perfectly — and produced an exactly-wrong
answer.

This is the bug class that would kill product trust in a beat. It's
also the bug class that's most invisible: the agent doesn't know
anything is wrong. The user has to spot it. If you're tabbing through
a 20-step application at speed, you don't.

The structural fix: make `WorkAuthorization` fields `boolean | null`,
default `null` in `createEmptyProfile`. The fill path already skips
`value == null`, so uncaptured legal questions now stay alone until
the user explicitly captures an answer. **Schema represents "we don't
know yet" as distinct from "user said No."**

Same fix applied to all four work-auth fields — `requiresUSSponsorship`,
`sanctionedCountryCitizenOrResident`, `currentOrFormerUSGovEmployee`.
Same risk profile.

For my own profile, I manually clicked Yes, opened the popup, clicked
Save as Profile. v0.0.18's respect-existing-value policy meant the
stale `false` in my profile didn't overwrite the Yes I'd just clicked.
The capture then read my Yes and wrote `authorizedToWorkInUS: true`.
Self-correcting through two layers of policy. Pleasant.

**v0.0.21 — the "Ethni-city" bug.**

This one is going in the LinkedIn post.

Pushed past Work Auth. Next step (Voluntary Disclosures, I think — the
URL didn't change, Workday's SPA was being inscrutable). Ran the agent.
Log:

```
fillByWidget: path=contact.address.city tag=button type=button
  uxi=null value="Medina"
fillButtonWidget: no option matched "Medina". Listbox has 9 option(s):
  ['Select One', 'American Indian or Alaska Native (Not Hispanic or
  Latino) (United States of America)', 'Asian (Not Hispanic or Latino)
  (United States of America)', 'Black or African American...']
```

The agent thought a Race/Ethnicity button was the City field. It tried
to fill "Medina" into a race dropdown.

Why? Because the mapping table at line 109 says
`{ label: 'City' }` for `contact.address.city`. And the matcher uses
`.toLowerCase().includes()`. And **"ethnicity" contains "city" as the
last four letters.** Ethni-**city**.

Mapping order put City before Race/Ethnicity, so the City mapping won
the field. The agent stringified my "Medina" and went looking for it
in a list of races.

Surgical fix: anchor the City pattern with a word boundary regex
(`/\bCity\b/i`). Still matches "City", "City*", "City Required". Stops
matching "Ethnicity". Latent variants of this bug exist for other
plain-string mappings — "First Name" would substring-match "Preferred
First Name", for instance — but those aren't firing today because of
mapping order. Left them in for a broader audit pass.

This is the bug I'll lead the LinkedIn post with. It's funny, it's
self-explanatory, and it makes the build-in-public point honestly:
**a senior PM with no engineering background can absolutely catch
production-level bugs with a debugger and a lot of squinting. Some of
them are the funny kind.**

**v0.0.22 — Self-Identify of Disability had two issues, neither
expected.**

Manually filled in Voluntary Disclosures (gender, race, veteran) and
captured. Profile looked clean. Then advanced to Self-Identify of
Disability, filled it manually, captured again. Pulled the profile
dump:

```json
"voluntaryDisclosures": {
  "gender": "Male",
  "raceEthnicity": "White (Not Hispanic or Latino) (United States of America)",
  "veteranStatus": "I AM NOT A VETERAN",
  "disabilityStatus": false
}
```

`disabilityStatus: false`. Schema says `disabilityStatus?: string`.
Runtime got a boolean. The capture's `readValue()` returns
`field.checked` for radios, and the disability question's "No, I do
not have a disability" radio was the checked one — so capture wrote
`field.checked` (boolean true, I think, or maybe false from a later
radio overwriting earlier — radio capture has order-of-scan bugs I
didn't unpack today) into a string-typed slot. TypeScript doesn't
enforce at runtime. The bad data persisted.

Same dump had this beauty in customAnswers:

```json
{ "pattern": "05/12/2026", "answer": "12" }
```

The Disability form has a "Today's Date" field. Workday auto-prefills
it. The capture saw a field with no useful label/context/ariaLabel and
fell back to using the rendered date as the pattern. Then captured
only the day-of-month "12" as the answer. Pattern-keyed customAnswers
never match future applications because the date changes every day.
This entry will sit in my profile forever, harmless but ugly.

Two fixes in v0.0.22:

1. **VD radios capture option text.** When a field's mapping path
   starts with `voluntaryDisclosures.` and it's a radio with a
   `"Question → Option"` label, write the Option text (string) instead
   of the checked boolean. Unchecked radios in the group are skipped
   — the matched one carries the answer for the whole question. This
   matches what the customAnswers fallback was already doing for
   unmapped radios.
2. **Date-shaped patterns rejected from customAnswers.** Regex check
   in the unmapped-field fallback: if the pattern matches MM/DD/YYYY
   or similar, skip and don't write the customAnswer. Stops the date
   garbage from polluting the profile.

WorkAuthorization radios still capture booleans because those types
are `boolean | null` on purpose. Special-cased VD only.

**The session's three cross-tenant catalog mismatches.**

This wasn't a bug to fix, but it was a pattern that kept showing up
and is worth naming. My profile values came from workday-corp
(Workday's own careers tenant), and three times today I watched the
agent correctly identify that a profile value didn't exist in Nvidia's
catalog:

- `preferredSource: "Internet Advertisement"` — Nvidia's source
  dropdown doesn't have this value.
- `contact.phone.deviceType: "Mobile"` — Nvidia's listbox is
  `['Select One', 'Home', 'Home Cellular']`.
- `education[0].degree: "Associate of Arts"` — Nvidia's listbox has
  17 options including "Associates" but not "Associate of Arts".

In every case the agent skipped rather than picking a wrong-but-close
option. That's the right default behavior — the alternative is the
v0.0.20 silent-false-default class of bug, transplanted to dropdowns.
Cross-tenant catalog drift is a real product limitation, not an agent
bug, and it's worth naming honestly in the LinkedIn post: tenant
configurability is the dominant source of partial fills, not anything
in the agent's code.

**What I learned the hard way today.**

- **Substring matching is a footgun, even when the matched substrings
  are short and obvious.** "Ethni-city" was hiding in plain sight in
  a config file I'd read dozens of times. Pattern-matching code in
  production should default to anchored matches unless there's a
  specific reason to be permissive.
- **Schema types are aspirational without runtime enforcement.** Three
  separate places in my profile turned out to have data that violated
  the declared TypeScript types — disabilityStatus stored as boolean
  where string was expected, raceEthnicity stored as single string
  where `string[]` was expected, workAuthorization stored false-by-
  default where the semantic was "no answer." The TypeScript compiler
  was happy. The data was wrong.
- **Default false is dangerous.** "Defaulting to false" is the
  programmer's lazy version of "unknown." In legal/employment
  contexts, the consequence of the laziness is silently mis-answering
  a question that has actual real-world stakes. Nullable booleans
  cost almost nothing in code and remove a whole class of bug.
- **Building in public means showing the bugs too.** The Ethni-city
  bug, the silent-false work-auth bug, the schema-violation
  disability bug — these are exactly the things a LinkedIn-post-with-
  a-pretty-demo would gloss over. They're also the texture that
  makes the build narrative interesting to read. I want to lead with
  them.
- **The v2-deferred fresh-start gap is actually a single-click gap.**
  Yesterday's CLAUDE.md said work-experience and education sections
  on fresh-start applications need "Add Another" automation to fill
  multiple blocks. True. But the gap before the FIRST block is also
  there: on Nvidia, fresh-start renders zero work blocks until you
  click Add. The v2 scope clarifies to: "click Add N times before
  filling blocks 0..N-1." Less terrifying than I'd thought.

**Ship readiness assessment.**

The tool fills end-to-end on a real Nvidia application with 0 errors.
The catalog-mismatch skips are explainable, not bugs. The
workAuthorization fix removes the biggest "would have been
embarrassing in production" risk I knew about. The respect-existing-
value policy means the agent now plays nice with manual edits.

Five versions of demonstrable progress in one session is enough
material to write the LinkedIn post. The remaining "what's next" is:

1. **A 30-second screen capture demo** showing the agent fill a
   contact-info step end-to-end. Win+Alt+G or Loom. Probably the
   single highest-leverage thing left to produce.
2. **README + install instructions** for anyone who wants to clone
   and try it. Currently doesn't exist.
3. **The post itself.** I think it writes itself now. Opening hook is
   Ethni-city. Middle is the React-fiber + main-world hybrid
   architecture from the v0.0.10-v0.0.17 arc. Closer is the
   silent-false work-auth bug as the punchline of "things you don't
   know your tool is doing wrong until you watch it run."

If I keep my head down, I can ship the post **tomorrow night**.
Realistic plan: tomorrow morning I record the demo, write the
README in the afternoon, draft the post in the evening, sleep on it,
post Thursday.

**Untouched today, deferred.**

- v2 multi-block "Add Another" automation. Single-click-gap clarified
  but still v2.
- The latent substring-matching bugs in firstName / middleName /
  lastName mappings. Will audit before next session.
- The date-input handling — currently silently skipped, would be
  nice to have an explicit "$dateMonth"/"$dateYear"-style sentinel
  for free-standing date fields like "Today's Date" or "Signature
  Date."
- The 16-vs-12 logging gap in fillByWidget — some skip paths don't
  print a per-field log. Minor diagnostic issue.
- Email mapping. My profile has `contact.email: ""` because the
  capture flow never visited a page that exposed an email input.
  Need a mapping signal for it, or a way to capture from the
  candidate-account-level fields.

Nothing on this deferred list blocks the post. They're all the kind of
thing I'll fix as they surface on subsequent applications.

## 2026-05-11 — Turns out yesterday's wall was diagnosing the wrong thing

Going into today I had a one-line punch list: "DevTools spike on
`onSelectInputClick.toString()`, then either confirm it needs focus, or
needs `isTrusted`, or needs `stateNode` dispatch, or some
`preventDefault`-able arg shape." Those were the four hypotheses
yesterday's journal entry locked in. Three sessions later, I can say
with confidence: **all four were wrong**, and the actual problem was
somewhere I wasn't looking.

**The MCP detour that turned out to matter.**

Today I tried something new — drove a Chromium browser via the
Playwright MCP server directly from Claude. The idea: skip the
"Ben-at-the-keyboard-with-DevTools-open" handoff and let the agent run
the spike itself. Setup was zero (already configured in this session)
and there was useful friction worth journaling: the Playwright browser
runs its own fresh profile, so my extension wasn't loaded in it. We
agreed to use Playwright purely as remote DevTools for the spike, then
hand the fix back to my real Chrome for end-to-end verification. That
turned out to be the right split — the spike phase needed fast,
iterable JavaScript evaluation against live React fibers; the verify
phase needed the actual bundled extension running.

Auth wall came up early. Workday's app pages need a candidate account,
so I pointed it at a job I'd already applied to on Nvidia's tenant.
Real PII was visible to the agent during the snapshots. Worth keeping
in mind for the LinkedIn-post version: redact, or use a dummy tenant.

**The spike data, condensed.**

First experiment: dump `onSelectInputClick.toString()` on the empty
source-dropdown input. Answer:

> `() => { U() }`

Takes no arguments. So `isTrusted`, focus state, arg shape — all dead.
The handler just calls a closure variable `U` (probably
`setMultiSelectDisplayState`, based on reading the depth-10 component
source). Second experiment: actually invoke it in isolation. The
listbox opened. With the six top-level categories visible.

That's when I realized v0.0.16 had been WORKING for openers all along.
The "empty combobox doesn't open" diagnosis from yesterday was a
correlation, not a causation.

Third experiment: try the v0.0.16 full sequence in the spike sandbox —
open + filter + DOM-click on the option. The option click DID NOTHING.
That's the actual wall. Workday's listbox options have no `onClick` on
the option element itself. The selection wiring is at depth 2 of the
option's fiber, on a parent `t` component, prop name `onSelect`,
signature `(item, evt, undefined)` where `item = { index }` and `evt`
must have a callable `preventDefault` (the inner
`handleSelectionEvent` calls it).

I verified the recipe end-to-end against the live Nvidia page:
opener → onSelect on "Social Media" (index 3) → category expanded to
8 sub-options including Facebook → onSelect on "Facebook" (index 1)
→ chip indicator updated to `"1 item selected, Facebook"`. Done. The
last screenshot showed the Workday form with the chip filled in by
JavaScript I'd written 90 seconds earlier.

**The implementation pass, and three regressions caught by real-Chrome
verify.**

Wrote v0.0.17. Replaced `dispatchClickSequence` in main.ts with
`invokeReactOnSelect` (walks option's fiber for onSelect, calls with
the right shape). Added a hierarchical walker that drills via
`onSelect` and resets between attempts by calling `onAutoHidePopup`
then `onSelectInputClick`. Refactored `findOptionMatch` to take a
listbox directly so the hierarchical phase can match within drilled
sub-lists. Removed `tryHierarchicalSelect` from content.ts entirely
— ~120 lines of dead code that had used `dispatchClickSequence` and
therefore never actually expanded a category.

Then I handed off to my own Chrome. Three rounds of "doesn't quite
work" before it shipped, each round revealing something I hadn't
predicted:

1. **First retest: no listbox after opener.** Same problem the journal
   had described. But this time I could see the bigger picture:
   content.ts had typed "Internet Advertisement" into the input as
   part of Step 3 (the per-character typing path). That typing put
   Workday's combobox into a state where calling `onSelectInputClick`
   afterward no longer opened the picker. Step 3 had been documented
   as "doesn't trigger Workday's filter, kept for forward-compat"
   since v0.0.8 — but nobody had noticed it was ACTIVELY breaking the
   v2 path by polluting input state. Removed it. Also removed
   `typeIntoCombobox`, `filterQueryFor`, and a local
   `setInputValueViaProto` that was no longer used.

2. **Second retest: drilling into "Advertisement" but no sub-list
   found.** The picker found the right category by name priority, but
   after the drill there was no listbox we recognized. Added a
   diagnostic that dumps option counts + visibility for each listbox
   in the DOM when `findListboxFor` returns null.

3. **Third retest: the diagnostic revealed the real shape.** The
   3-listboxes-after-drill state included a 1-option listbox with
   text "Internet Advertisement" — i.e., the chip indicator showing
   the selection had ALREADY COMMITTED. We just didn't recognize it,
   because my chip-detection only matched the "N items selected, X"
   wrapper text pattern from Nvidia's tenant. Workday-corporate's
   tenant doesn't put that prefix anywhere — the chip is JUST a
   1-option listbox. So I broadened chip-detection to also accept
   1-option listboxes within ~10 hops of the input in DOM tree.

4. **Plus: filter-primed onSelect.** While I was at it, I added a
   Phase D2 that invokes `onSelect` on the first visible option even
   when no flat match exists, then checks the chip. On the Workday
   tenant, Workday's internal state apparently maps `index: 0` of the
   filtered top-level list to the actual matching leaf, so clicking
   "Advertisement" at index 0 (after onSearch("Internet
   Advertisement") primed the filter) commits "Internet
   Advertisement" directly without needing the drill. This is the
   path that ended up winning in the final run.

5. **Defensive final chip-check.** Before returning `no-match`, I
   added one last chip-readback. If anything along the way committed
   the selection — even by an unintended pathway like an
   `onAutoHidePopup` triggering Workday's CLICK_OUTSIDE-best-match
   commit during a hierarchical reset — the chip is ground truth.
   Report `filled`.

**Final live result.**

```
[WorkdayAgent main-world] filter-primed onSelect committed "Internet Advertisement"
status:"filled" ... chosenOption:"Internet Advertisement"
fill complete — 15 filled, 2 skipped, 0 errors
```

Up from 14/3 in v0.0.16. The two skipped are the correctly pre-filled
combos (Country and Country Phone Code). Zero errors. Zero false
positives. The empty source dropdown — yesterday's "deferred to a
future session" item — now fills end-to-end.

**What I learned the hard way today.**

- **Yesterday's hypotheses were wrong because they pattern-matched to
  what I expected, not what I actually saw.** All four were variations
  on "the opener needs special treatment." The real failure was at the
  option-click level, two steps later in the flow. A spike that reads
  the handler source — not just enumerates handler names — surfaced
  the truth in 90 seconds.
- **`<function>.toString()` is the most underused debugging primitive
  in this whole project.** Minified code, sure, but it's intelligible.
  Reading `() => { U() }` was more informative than reading the
  handler's prop name a thousand times.
- **Per-tenant variation is real, even on the same Workday platform.**
  Nvidia's source dropdown drills inline into sub-options with the
  same listbox. Workday-corp's commits the matching leaf directly
  when you click the first filtered option. Same platform, same
  CSS-in-JS components, different tenant configuration → different
  behavior. Multi-tenant test-matrix is going to matter eventually.
- **Removing broken code can fix things.** The Step 3 typing path had
  been "harmlessly" running for sessions. It was actively breaking
  the v2 fallback. The fact that I'd labeled it "forward-compat" in
  a comment made it socially harder to delete. Worth noting for the
  LinkedIn post: "I removed 120 lines of dead-but-labeled-load-bearing
  code and the actual bug went away."
- **Browser-driven MCP is genuinely useful for spikes that need
  in-page JS evaluation.** Not a substitute for end-to-end verify in
  the real extension environment — but for "what's actually in this
  React fiber chain on a live page?" it's better than the
  Ben-at-keyboard handoff. Split the work: spike via MCP, verify via
  real Chrome.

**What's next.**

- Test v0.0.17 on a fresh-start (non-"useMyLastApplication") flow to
  confirm work-experience and education sections behave. v0.0.17 only
  fixed combobox typeaheads; the repeated-block "click Add Another"
  limitation is still v2-deferred.
- Test on Voluntary Disclosures step if I can find a tenant that
  exposes those.
- Decide if the LinkedIn post writes itself yet. Current narrative
  arc: "I'm a PM, I built a Chrome extension in a weekend, here's
  what I learned about React's internals and Workday's DOM and the
  gap between what code looks like it's doing and what it's actually
  doing." With v0.0.17 shipped, the demo is real.

## 2026-05-10 — Fixed the merge bug, then hit the wall I'd been warned about

Two bugs going in. One fixed and verified, one diagnosed and deferred to v2.
That second one is where the session got interesting.

**Bug 1: the merge architecture was overwriting captured data.**

Last session ended with `preferences.preferredSource` disappearing mid-session.
The cause was section-level merge — when a capture touched any field inside
a top-level section (say `preferences`), `mergeWithExisting` replaced the
whole section. The new section came from a fresh `createEmptyProfile()` plus
whatever the current step actually filled in. So a fresh contact-info capture
would write `preferences = { willingToRelocate: false (default),
hasNonCompeteRestrictions: false (default), preferredSource: "Job Alert" }`,
and an Application Questions capture immediately after would overwrite that
with `preferences = { willingToRelocate: true, hasNonCompeteRestrictions:
false, /* no preferredSource */ }` — nuking the source value.

Fix: granular path tracking. Capture now records every dotted path it
actually wrote (`preferences.preferredSource`, `contact.address.line1`, etc.)
plus markers for array sections (`workExperience[]`) and keyed entries
(`websites[label=LinkedIn]`, `customAnswers[pattern=...]`). `mergeWithExisting`
deep-clones the existing profile and applies each touched path individually
— object leaves get deep-set, arrays get replaced wholesale, keyed entries
match-replace-or-append. Bonus: `customAnswers` now merges by pattern key, so
re-capturing a step no longer duplicates Q&A.

Verified live: captured contact-info step (preferredSource = "Internet
Advertisement" landed), navigated to Application Questions, captured again,
preferredSource survived. Shipped as v0.0.6.

**Bug 2: the combobox typeahead bug, where I hit the architectural wall.**

The captured chip text for Country Phone Code is "United States of America
(+1)" but the listbox option is presumably "United States (+1)". So I built
a diagnostic that, on match failure, dumps the actual option labels Workday
is showing. That was v0.0.7.

The diagnostic immediately surfaced two distinct combobox failures:

1. **Source dropdown ("How Did You Hear About Us?") is hierarchical.** The
   five top-level options are categories: Advertisement, Partnership,
   Socially, Website, Workday. "Internet Advertisement" lives inside the
   Advertisement category. Our flat-list search can never reach it.

2. **Phone Code combobox is alphabetical and lazy-loaded.** Even AFTER
   typing the target value, the listbox showed the alphabetical first
   page (Afghanistan through Benin — 23 options). My filter wasn't firing.

So I iterated on the typing. Added `keydown`/`keyup` events on the theory
that Workday's filter listens for keystrokes, not just `input` events. No
change. Added `beforeinput`. Trimmed the filter query to first 2 words after
stripping the parenthetical ("United States of America" instead of "United
States of America (+1)"). No change. Added a mid-typing diagnostic that logs
`el.value` after the typing loop finishes.

That last diagnostic was the key. The log read:

> typeIntoCombobox: input value after typing is "United States"

The input's value is correct. The native setter trick works. The events
fire. The listbox still shows A–B alphabetical.

**The wall:** Workday's React combobox filter handler is not responding to
any synthetic DOM event I can dispatch from a content script. Either it's
wired to React-internal mechanisms I can't reach, or it checks `isTrusted`
and rejects synthetic events outright. This is exactly the widget class
CLAUDE.md predicted I'd hit — the one that motivates the two-script (content
+ injected) architecture. The fix isn't "one more event type." The fix is
running code in the page's main JS world, traversing React fibers to find
the combobox component, and calling its onChange handler directly. That's
v2 work.

Practically: v1 fills 13/15 fields on this contact-info step (87%) — text
inputs, button widgets, radios, checkboxes, customAnswers all work. The two
that fail are both Workday combobox typeahead widgets. Same widget class on
later steps (School, Field of Study, Skills typeahead) will also fail until
v2.

**Why this is actually good for the build narrative.**

The LinkedIn post needs a "what I learned about agent architecture" beat,
and this is it. Chrome extensions have two JS worlds: the isolated content
script world (sees the DOM, doesn't see the page's JS variables) and the
page's main world (sees React, but can't talk to the extension directly).
For most of v1, I got away with content-script-only because the native value
setter trick is just JavaScript. But the moment I hit a widget that's
controlled by React internals (not just DOM state), the worlds matter. The
fix is to inject a script tag into the page that runs in the main world,
and pipe messages between it and the content script via `window.postMessage`
or DOM events. That's an architectural step, not a bug fix.

Shipped v0.0.8 with the iteration (it doesn't fix the bug but ratchets out
the easy hypotheses), and documented the combobox-typing limitation in
CLAUDE.md as the explicit v1/v2 boundary.

**What I learned the hard way today.**

- "Add more event types" only works if the issue is event types. When the
  underlying app is controlled by React internals, no DOM event dance gets
  you there.
- Diagnostics that print what the system is actually doing (not what you
  hope it's doing) are the single best debugging investment. The
  `el.value after typing` log took 30 seconds to write and saved me from
  burning the rest of the session adding more event types.
- The decision to ship v1 with a known limitation is often the right one,
  especially when the limitation has a clear v2 path AND is itself a
  story worth telling.

**What's next:**

- Decide whether v1 is "done enough" for the LinkedIn post. With 13/15 fill
  on contact-info, all of identity / contact / work experience / education
  / radio Q&A working, this is already a real demo. The combobox gap is a
  narrated limitation.
- If continuing: v2 injected-script architecture for combobox + skills
  typeahead. Hierarchical click-walking for the source dropdown. Optional:
  LLM-based field matching for tenants whose label phrasing breaks our
  regex map.
- Either way, an end-to-end screen recording on a real Workday application
  is the next concrete step — captures the v1 win and the v2 backlog
  honestly.

**Same-day autonomous chunk (Ben away from keyboard):**

Ben handed me the keyboard with "spin up agents if needed, less involvement
by me." I shipped two more commits autonomously, plus a planning sub-agent.

What I built:

1. **v0.0.9 — content-script-only follow-ups.** Two fixes that didn't
   need the v2 architecture. (a) Hierarchical fallback in fillCombobox:
   when the flat-list match fails and the listbox has ≤10 options, treat
   it as a tree picker. Walk each top-level option, click to expand,
   check the latest listbox for a match. Prioritize categories whose
   name appears in the target value ("Internet Advertisement" → try
   "Advertisement" first). Backs out cleanly when no match. (b) Fixed
   the result counting: fillCombobox and fillButtonWidget now return
   booleans; the fill loop counts skipped vs filled correctly. Previous
   "15 filled, 2 skipped" lines were overstating success by treating
   combobox failures as successes.

2. **v0.0.10 — v2 architecture scaffolding.** Three new files under
   src/injected/:
   - `protocol.ts` — types only, shared between worlds. Two request
     kinds: `fiber-inspect` (diagnostic, no mutation) and
     `combobox-fill` (the real path). Namespaced `'wa-v2'` so unrelated
     page postMessage chatter doesn't collide.
   - `main.ts` — the main-world script. Walks React fibers from a
     target element, finds an ancestor with a handler matching the
     `CANDIDATE_HANDLER_NAMES` allowlist (onChange, onInputChange,
     onFilterChange, onSearch, etc.), uses the native value setter,
     invokes the handler with a synthetic React-shaped event, scans
     the resulting listbox for matches, clicks one. Reports rich
     diagnostics back: handler name found, ancestor depth, options
     seen, chosen option, error message.
   - `bridge.ts` — content-script-side postMessage helpers with
     request-id correlation and 4s timeout.
   - `vite.config.ts` updated: second content_scripts entry with
     `world: 'MAIN' run_at: 'document_start'`. @crxjs/vite-plugin
     supports this directly. Manifest output verified clean — both
     scripts non-zero, web_accessible_resources lists the bundled
     main and protocol modules.

Designed the whole thing diagnostic-first. Every combobox fill attempt
sends a fiber-inspect FIRST and logs the response — so the first time
Ben tests this live, the page console shows every on-prefixed prop
visible on the combobox's ancestor fibers. That data drives whether
the allowlist needs new entries (e.g., if Workday uses a Workday-
specific name like `onWdComboboxChange`).

I learned something useful by spawning the Plan agent: it called out
that Step 1 of the v2 architecture is a DevTools spike on a live
Workday page — which only Ben can do. So I designed around that by
making the first run itself the spike. The fiber-inspect path is
"what would the spike find?" baked into runtime.

What I deliberately did NOT do:

- Verify any of v0.0.10 on a live Workday page (can't — no browser).
- Push to remote. Local commits only.
- Pre-write handler-specific logic. Without seeing Workday's actual
  React component shape, every guess is a guess. The diagnostic data
  comes back, then we wire the specific handler.

Known risks Ben should watch for during verification:

- **Main-world script doesn't load at all.** @crxjs/vite-plugin emits
  it via a loader that uses dynamic `import()`. If Workday's CSP
  blocks that import, the page console will NOT show the
  `[WorkdayAgent main-world] injected on ...` startup log. Bridge
  requests will time out after 4s with "bridge timeout after 4000ms"
  in the content-script console. Documented fallback: switch to an
  IIFE-built bundle + manual script-tag injection from content script.
- **Fiber walks but no handler matches the allowlist.** The
  fiber-inspect output (logged on every combobox attempt) will show
  every on-prefixed prop on each ancestor. Pick whichever looks like
  the filter handler, add it to CANDIDATE_HANDLER_NAMES in
  src/injected/main.ts, rebuild, retest.
- **Handler call fires but no filter happens.** Likely a signature
  mismatch — the handler might take `(value, event)` instead of
  `(event)`. Rebuild the synthetic event shape based on what Workday's
  expecting; sometimes that's revealed by reading the handler's
  function body via `handler.toString()` in DevTools.
- **Handler signature is fine but listbox doesn't match.** Means
  Workday's filter ran and excluded the target. Different problem
  (back to existing searchVariants logic in content-script-side
  findOptionMatchInLatestListbox).

Each of those failure modes has a clear next action and the diagnostics
should pinpoint which one we're in. Worst case, v0.0.10 turns out to
need a different bundling strategy and we revert to v0.0.9's known-good
state.

Build state at this handoff:
- Local commits only: v0.0.9 c0d29e2, v0.0.10 7468c58 (plus the v0.0.8
  iteration and docs commit already on main from this morning).
- `npm run build` clean. `npx tsc --noEmit` clean.
- One warning, expected: `[crx:content-scripts] Some content-scripts
  don't support HMR because the world is MAIN: /src/injected/main.ts`.
  This is documented behavior, not a build failure.



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
**Status:** v0.0.17 — verified end-to-end on contact-info step at 15 filled / 2 skipped / 0 errors (workday.wd5 Engagement Manager tenant). Empty hierarchical source dropdown ("How Did You Hear About Us?" → "Internet Advertisement") fills correctly via filter-primed onSelect; v0.0.16's "remaining limitation" turned out to be misdiagnosed — opener was working all along; the real gap was option-clicks. Workday's listbox options don't fire on real DOM events; selection goes through React's `onSelect` at depth 2 of the option's fiber, signature `(item, evt, undefined)`. v0.0.17 invokes that path directly. Chip-detection now supports both Nvidia-style (`"N items selected, X"` wrapper text) and Workday-corp-style (1-option listbox near input) tenants. Removed dead code: content-script's `tryHierarchicalSelect` (used DOM clicks, never actually worked) and `typeIntoCombobox` (was actively breaking the v2 path by polluting input state before opener invocation).

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
- [x] Implement storage adapter — `src/profile/storage.ts` written: `getProfile()` / `saveProfile()` / `clearProfile()` / `hasProfile()` / `createEmptyProfile()`. All five functions go through `chrome.storage.local` under key `workdayAgent.profile`. `saveProfile` always stamps `meta.schemaVersion` and `meta.updatedAt`. Resume blob lives inside the profile as base64 (no OPFS yet — moves to OPFS only if 5 MB quota becomes a problem in practice).
- [x] Implement label-pattern → profile-field mapping config — `src/profile/mapping.ts` written. ~30 mappings covering identity, contact, work experience, education, skills, websites, dates, source, application questions, and voluntary disclosures (full federal-standard EEO set, not just what this Workday tenant showed). Signals support match by label / context / text (either) / automationId / aria-label, with `string | RegExp` patterns. Path notation: dotted paths plus bracket-empty for repeated entries (`workExperience[].jobTitle`), keyed lookup for websites (`websites[label=LinkedIn].url`), and sentinels (`$dateMonth` / `$dateYear`) for date inputs that share automationIds across start/end. Order-sensitive — first match wins; phone-code Country comes before bare Country / Territory.
- [x] Implement capture-from-Workday flow — `src/profile/capture.ts` written + popup wiring. Walks scanned fields in DOM order, looks up each via `findMapping`, transforms widget-specific values (Yes/No buttons → boolean, button widgets → `displayText`, comboboxes → context selection-chip), writes to profile. Block-walking for repeated structures: `jobTitle` starts a new `workExperience[]`; `school` starts a new `education[]`. Date inputs are paired by encounter order within a block (first pair = start, second pair = end). Unmatched fields with values fall through to `customAnswers`. New "Save as Profile" button in the popup runs the full pipeline (scan → capture → save → display saved profile JSON for review). Build clean (popup 2.94 kB → 10.26 kB; profile module joined the bundle). Not yet verified on a live page.
- [~] Verify capture flow on a live Workday page — partially verified. Contact-info step capture is correct: identity (first/middle/last), full address, phone (countryCode/number/deviceType/smsOptIn), preferences.preferredSource, and the Workday-employee question landed in customAnswers as expected. Two bugs surfaced and fixed in the first verification run:
  - `'Preferred Name'` substring pattern incorrectly matched the "I have a preferred name" toggle checkbox, writing boolean `false` into a string field. Fixed by anchoring to `/^preferred (first |middle |last )?name/i`.
  - Custom-answer pattern derivation favored `context` over `label`, so the Workday-employee radio recorded as `{ pattern: "YesNo", answer: true }`. Fixed by preferring label first, and for radios with `Q → Option` labels, splitting the question and option so we get `{ pattern: "Have you previously worked for...?", answer: "No" }`.
- [x] Verify capture on later steps — verified on a `useMyLastApplication` URL: all 5 work experiences captured with correct dates and `currentlyHere` flag (block walking and date sentinel pairing both work), education captured (no dates because Workday's tenant config doesn't ask), websites captured into the keyed `websites[label=X].url` lookup. Skills empty (typeahead chips not visible to scanner — known limitation). voluntaryDisclosures still empty because we didn't capture from that step in this session — would need either capture on Voluntary Disclosures step OR a separate fresh `/apply` flow that surfaces it.
- [x] Implement and verify capture merge — single capture only sees the currently-rendered step, but the wedge requires building a complete profile across steps. Switched capture from overwrite to **merge by touched section**: capture tracks which top-level sections it actually wrote to (`identity`, `contact`, `workExperience`, etc.) via path-prefix detection, then `mergeWithExisting` replaces only those sections in the existing stored profile and preserves the rest. `meta.createdAt` is held from the original first capture; `meta.updatedAt` bumps each save. Verified on a real two-step sequence: My Experience capture (workExperience + education + websites populated, identity/contact empty) followed by contact-info capture from a different `useMyLastApplication` URL — result kept the original 5 work experiences and education/websites while populating identity and contact freshly.
- [x] Implement fill logic — `src/profile/fill.ts` written. `fillFromProfile(profile, fields)` walks scanned fields, dispatches per widget type: text/textarea (native setter + input/change/blur events), checkbox/radio (click if state differs; radio matches by HTML value or extracted "Question → Option" label), combobox typeahead (focus + type + click match), button widget (click + wait for listbox + click match), date sentinels (per-block month/year queues). CustomAnswers fallback for fields without a canonical mapping (Workday-tenant-specific Q&A). Architectural choice: content-script-only with native-setter trick instead of CLAUDE.md's two-script pattern. Wired `FILL_FROM_PROFILE` message in content.ts and "Fill from Profile" button in popup. Built, not yet verified on a live page.
- [x] v1 nice-to-have: fill-time visual cue for voluntary disclosures — `highlightFields()` in fill.ts applies a 3px amber outline + scrolls into view for 5s after fill completes. Triggered automatically for any field whose mapping path starts with `voluntaryDisclosures.`. Built, not yet verified.
- [x] Investigate empty `tsconfig.json` — populated with strict mode, ES2022, bundler resolution, `@types/chrome`. First `tsc --noEmit` run caught two real type errors in `capture.ts` (unsafe casts to `Record<string, unknown>` from typed schemas); fixed by casting through `unknown`. Type-checking now runs clean.
- [ ] Verify fill logic end-to-end on a live Workday page: load v0.0.5 build, navigate to a `useMyLastApplication` URL with rendered form, click "Fill from Profile", confirm text inputs populate (incl. native-setter trick works for React's value tracking), button widgets click+select correctly, radios match, checkboxes toggle. Watch for: combobox typing not opening listbox, button-widget timing issues, voluntary-disclosure highlight visible.
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

### Session 7.5 — Autonomous fill-logic chunk (Ben away from keyboard)

Ben asked me (Claude) to keep working while he stepped away. Mandate
was: ship as much as possible, commit locally only, document
everything as built-not-verified, have a clean handoff ready for him
to test on return.

**What I built:**

1. **`tsconfig.json` populated.** The file had been 0 bytes since
   scaffolding, so no actual type-checking was running anywhere. New
   config enables strict mode, ES2022 target, bundler module
   resolution, and pulls in `@types/chrome`. First `npx tsc --noEmit`
   run caught two real type errors in `capture.ts` — the
   `(last as Record<string, unknown>)` casts were unsafe because
   `WorkExperience` and `Education` lack index signatures. Fixed by
   casting through `unknown` first. tsc passes clean now.

2. **`src/profile/fill.ts`.** The fill engine:
   - `fillFromProfile(profile, fields)` walks scanned fields in DOM
     order, looks up each via `findMapping`, resolves the target value
     from the profile, and dispatches to a per-widget-type handler.
   - **Plain text inputs / textareas**: uses
     `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set`
     to bypass React's per-instance value-tracking monkey patch, then
     dispatches `input` / `change` / `blur` events.
   - **Checkbox**: clicks if `.checked !== shouldBeChecked`.
   - **Radio**: matches by HTML value (`"true"` / `"false"`) OR by
     extracting the option label from `Question → Option` format.
   - **Combobox typeahead** (Workday's `selectinput-*` UUID pattern):
     focus → fill input → wait for `[role="listbox"]` → click matching
     option.
   - **Button widget** (paired button-listbox): click button → wait
     for listbox → click option matching `displayText`.
   - **Date inputs** (`$dateMonth` / `$dateYear` sentinels): consumed
     from per-block month/year queues that get refilled when a new
     `workExperience` or `education` block starts. Same block-walking
     state machine as capture, mirrored.
   - **CustomAnswers fallback**: when a field doesn't map to a
     canonical profile path, walk `profile.customAnswers` and match
     by pattern substring against the field's label/context/aria-label.
     Lets us fill the Workday-employee Yes/No question and similar
     tenant-specific Q&A.
   - **`highlightFields(elements, durationMs)`**: applies a 3px amber
     outline + scrolls into view for 5 seconds, used after fill to
     draw attention to voluntary-disclosure fields.

3. **Architectural decision: content-script-only fill, NOT the
   two-script (content + injected) pattern from CLAUDE.md.**
   Reasoning: the React-input-tracking issue that motivates the
   two-script architecture is solved by using the prototype's native
   value setter from any JS context that holds the element reference.
   Content scripts can read the prototype, get the setter, and call
   it on the live DOM element — no separate page-world execution
   needed. Saves the complexity of script injection, message channels
   between worlds, and timing coordination. Documented as a v1 choice;
   if we hit a Workday widget where this fails (Shadow DOM, React
   internals deeper than we expect), the fallback is to add the
   injected script as a second script entry. CLAUDE.md updated to
   reflect this choice. Made this call autonomously per Ben's
   "make architectural calls and document" instruction.

4. **Wired `FILL_FROM_PROFILE` into content.ts.** Receives profile
   from popup, scans current page, builds `FillField[]` (zips fields
   with their live elements), runs `fillFromProfile`, logs result to
   page console, calls `highlightFields` for voluntary disclosures,
   and reports counts back to popup. Returns `true` from the message
   listener so the channel stays open for the async fill.

5. **"Fill from Profile" button in popup.** Reads stored profile,
   sends `FILL_FROM_PROFILE` to content script, displays counts in
   status (`✓ Filled N, skipped M, K errors. X voluntary-disclosure
   field(s) highlighted on page for review.`). If errors are
   reported, the textarea fills with the error JSON for inspection.

**What I did NOT do:**

- Verify any of this on a live Workday page. Can't — I don't have
  browser access. Everything in this chunk is "built, not yet
  verified" until Ben tests it.
- Push to remote. Per instructions, committed locally only.
- Touch the file-upload widget — known browser-security limitation;
  silently skipped in fill logic with a comment.

**Known risks Ben should look for during verification:**

- **Combobox typing**: Workday's typeahead may need a real focus event
  before `input` events register. If the listbox doesn't open after
  fill writes the search text, this is the cause and we'd add an
  explicit `focus()` plus a small delay before typing.
- **Button-widget timing**: 2-second `waitForElement` for the listbox
  may not be enough on slow connections. Bump to 3-5s if listboxes
  routinely don't appear in time.
- **Sequential vs parallel async fills**: I made fill fully `await`-ed
  per field so button-widget listboxes don't overlap. This is slow
  for forms with many button widgets, but correct. Might want a
  progress indicator in the popup if a full-page fill takes >5s.
- **Yes/No customAnswer matching**: relies on the radio's `Question →
  Option` label format being preserved. If a Workday tenant renders
  radios differently (no group label, or label only carries the
  option), this breaks and falls through to skipped.
- **Repeated structures**: fill assumes Workday has rendered the right
  number of `workExperience` blocks (and ditto `education`). If the
  user is on a fresh `/apply` flow with only one block rendered, only
  `workExperience[0]` fills. Documented as a v1 limitation; v2 needs
  to click "Add Another" to expand.

**Build state at handoff:**
- All TypeScript type-checks pass under strict mode (`npx tsc --noEmit`)
- `npm run build` clean: 13 modules, content.ts 10.07 kB, popup 8.47 kB
- Local commit pending (do not push without Ben's review)

### Session 7.6 — Live fill verification + combobox iteration

Ben tested the fill build (`v0.0.5`) on real Workday application pages.
Result: **most of the fill logic works**, with two real bugs surfaced and
diagnosed.

**What's confirmed working from `fillByWidget` logs:**

- Text inputs (First Name, Middle Name, Last Name, Address Line 1, City,
  Postal Code, Phone Number) — all dispatched correctly
- Button widgets (Country / Territory, State, Phone Device Type) — listbox
  opened and matching options clicked via the new pointer+mouse+click
  sequence
- Checkboxes / radios (SMS opt-in, Workday-employee Yes/No) — toggled to
  the correct state via `customAnswer` fallback for the radio Q&A
- Native value setter trick on `HTMLInputElement.prototype` works in
  content-script context (no injected script needed) — confirmed by text
  inputs sticking with values that React tracks

**Bug 1 — Merge architecture too aggressive (in capture.ts):**

Each capture only sees fields rendered on the current Workday step. The
current `mergeWithExisting` replaces an entire top-level section if any
field in it was touched. Problem: when a contact-info capture touches
`preferences.preferredSource`, the new `preferences` object only has
that field set to a value — `willingToRelocate` and
`hasNonCompeteRestrictions` are at their `createEmptyProfile` defaults
(both `false`). Section-replace then writes the defaults over any
previously-captured `true` values from an Application Questions step.

Same pattern can happen the other way: an Application Questions capture
touches `preferences.willingToRelocate` but has no `preferredSource`
set — section-replace would drop the `"Job Alert"` we'd previously
captured. **This is exactly what happened to Ben.** His profile lost
`preferredSource` mid-session, which is why fill silently skipped
"How Did You Hear About Us" on the next test (no `fillByWidget`
log for that path).

**Fix path (deferred):** track touched paths at field-level granularity
during capture, not just touched sections. Merge replaces only the
paths that were actually written. Or alternatively, deep-merge object
sections preferring captured values only when non-empty (with a known
limitation that boolean `false` from a default can't be distinguished
from a captured `false`).

**Bug 2 — Country / Territory Phone Code combobox option mismatch:**

Profile stores the value as captured: `"United States of America (+1)"`.
But Workday's option list in the listbox apparently doesn't have any
option containing that exact string. My `searchVariants` helper tries
`"United States of America (+1)"`, then `"United States of America"`
(parens stripped) — neither matches. Likely Workday renders the option
as just `"United States"` or a flag + abbreviation.

**Fix path (deferred):** when a combobox match fails, log the actual
option labels in the listbox so we can see what Workday offers, then
either store a more match-friendly value in the profile OR widen the
search variants further.

**Build / Chrome cache gotcha encountered:**

Each Vite build produces new content-hashed filenames and deletes the
prior ones from `dist/`. Chrome's content-script registration is keyed
by the hashed filename in the manifest; if you reload the page but
not the extension, Chrome tries to fetch the previous-build file
which no longer exists, producing a `net::ERR_FILE_NOT_FOUND` error
on the dynamic import. Ben hit this exactly during testing today.
**Always reload extension AND page after each build.** The
extension off/on toggle is more reliable than the reload icon when
the manifest paths have changed.

**What got committed in this chunk:**
- Fill iteration: combobox click-before-type, no-blur, polled match,
  pointer+mouse+click event sequences for option clicks (synthetic
  `.click()` alone wasn't enough for Workday option handlers),
  search variants stripping parenthetical suffixes
- `fillByWidget` entry-point logging so each dispatch is traced
- Diagnostic logs in `fillCombobox` and `fillButtonWidget` that name
  exactly which option was matched and clicked

**What's open for next session:**
- Re-capture profile from a `useMyLastApplication` URL with the source
  dropdown populated, so `preferences.preferredSource` is restored
- Implement field-level path tracking in capture + merge (the real fix
  for Bug 1)
- Add "log all options in listbox" diagnostic when a combobox match
  fails (helps fix Bug 2)
- Verify whether button-widget option clicks are actually changing
  Workday's selection or whether Workday's `autofillWithResume` flow
  was just pre-populating those — try a clean `useMyLastApplication`
  URL where the fields are blank, then fill from profile, see what
  actually changes
- Voluntary-disclosure fill-time visual cue — wasn't testable today
  because the test URLs don't have voluntary disclosures rendered on
  the contact-info step

### Session 6 — Full survey, detection cleanup, data model architecture
- Worked through all 5 steps of the live Workday application; catalogued 76 unique fields and every Workday widget pattern we're likely to see (paired button+listbox, combobox-with-chip-state, dateSection split inputs, multi-select skills, file upload, categorical question buttons).
- Hit and resolved the clipboard-from-popup unreliability: scrapped `navigator.clipboard.writeText` after async round-trip and shipped a textarea inside the popup that auto-selects on populate. User presses Ctrl+C manually.
- The two-step extension reload bit me three separate times in one day. Pattern locked into muscle memory now: edit → build → reload extension → reload page.
- Added `getContext` (walks up to 8 ancestors, grabs nearby text 5–1500 chars). Resolved 10/10 Application Questions, and as a bonus surfaces combobox selection state ("1 item selected, Job Alert").
- Shipped detection cleanup batch in one pass: MutationObserver-based initial scan, conditional `displayText`/`checked` keys, `getContext` tune, popup diagnostic split into three branches. Verified on contact-info re-scan.
- Locked profile data model decisions (see "Architectural decisions made so far" in CLAUDE.md and the data-model section in this entry).
- Wrapped session here with architecture in hand, ready for implementation work next time.

### Session 7.8 — Autonomous chunk: from "v2 scaffold ready to test" to "v2 verified live, one edge case left"
- Ben handed me the keyboard ("spin up agents if needed, less involvement by me"). I shipped eight commits (v0.0.9 through v0.0.16) over the session, with Ben running each live test and pasting the page console back. Spawned one Plan sub-agent to draft the v2 architecture upfront.
- v0.0.9: hierarchical click-walking fallback in fillCombobox (content-script-only path for tree-style pickers like "How Did You Hear About Us?"), plus correct skipped-vs-filled counting. Deferred wins from session 7.7.
- v0.0.10: v2 architecture scaffolding. New `src/injected/{protocol.ts,main.ts,bridge.ts}` with diagnostic-first design — every combobox fill attempt also sends a `fiber-inspect` request that dumps every `onXxx` prop on the input's ancestor fibers. Idea was: first live run produces the data the plan called for as a DevTools spike. It worked.
- v0.0.11: text-dumpable diagnostic output. The fiber-inspect and combobox-fill response objects were collapsing to "Object" when copy-pasted from DevTools. Switched logs to `JSON.stringify(response)` and added a flat per-ancestor log so the data was usable without expanding nested objects.
- v0.0.12: the breakthrough. v0.0.11's fiber dump revealed Workday's typeahead component (`t` at depth 7 and 10) exposes `onSearch` — that's Workday's filter handler. We'd been calling `onChange` at depth 0 (the input's React form-control wiring), which doesn't trigger filtering. Updated CANDIDATE_HANDLER_NAMES to put `onSearch` first, added VALUE_FIRST_HANDLERS for the `(value)` signature, added SKIP_HANDLER_DEPTHS to skip the input + Styled wrapper. Also added closeOpenListboxes() in content script: Escape on body before fillCombobox, so the previous widget's listbox doesn't leak into "latest listbox" detection.
- v0.0.13: listbox lookup scoped to the source input. v0.0.12 wired the handler correctly but the post-fill listbox detection was still reading the country phone code's listbox when filling the source dropdown. New findListboxFor: aria-controls / aria-owns first, then visible multi-option listboxes nearest the input in the DOM tree. Mirrored in main.ts.
- v0.0.14: skip-if-already-filled. The diagnostic eventually surfaced that the source dropdown's listbox **wasn't even opening** when its chip already had a value — Workday treats already-filled combos as "done" and a plain click doesn't reopen them. New comboboxAlreadyShowsTarget() compares scanned `field.context` against the target value, short-circuits with a skip+success. Applied to both comboboxes and button widgets. Huge UX win — no more pointless re-opening listboxes for the 4 already-filled fields.
- v0.0.15: open the listbox via React handler instead of DOM click. With v0.0.14 in place, the source dropdown was now the ONLY actually-broken field (empty, needs to be opened+filled fresh). Added OPENER_HANDLER_NAMES and a separate Phase A in handleComboboxFill: call onSelectInputClick / onPromptIconClick / onClick before the filter handler. Also cleaned up findListboxFor to return null instead of falling back to "latest in DOM order" (which was poisoning the source attempts with the country chip indicator).
- v0.0.16: priority-order bugfix. v0.0.15 was calling `onClick` at depth 5 instead of `onSelectInputClick` at depth 10 — because my walk iterated by depth first, then name. So the first ancestor with ANY candidate name won. Inverted the loops (outer on handler name, inner on depth). Verified live: v0.0.16 correctly calls `onSelectInputClick` at depth 10.
- And then we hit the wall. Calling `onSelectInputClick` on an empty combobox does NOT open Workday's listbox. The listbox count in DOM stays at 1 (the country chip indicator) after the call. So `onSelectInputClick` is the right prop name in concept but Workday's actual implementation must require something we're not providing — event.isTrusted, a `preventDefault`-able arg, prior focus state, or invocation via `stateNode` rather than the prop. Each is a 30-min investigation requiring `onSelectInputClick.toString()` source from DevTools on Workday's actual page. Not feasible without Ben at the keyboard.

**What I learned the hard way today (autonomous edition):**

- **Diagnostic-first design is the killer pattern for this kind of work.** I couldn't do the "Step 1 DevTools spike" the Plan agent prescribed. Instead I baked the spike INTO runtime: send a fiber-inspect on every fill, log everything seen, ship to Ben, iterate. Three iterations got us from "no idea what handler" → "onSearch at depth 7" → "onSelectInputClick at depth 10" with no DevTools time required.
- **JSON.stringify your console logs.** Console "Object" copy-paste cost an entire iteration. Should have written the diagnostic output as plain strings from the start.
- **Loop order matters when you have priority + breadth.** The opener-priority bug (v0.0.15) was a 5-second fix that I had to ship + test + see live + diagnose before the right inversion was obvious. If I'd written the walk as "for each priority name, scan all depths" from the start, v0.0.15 would have worked. Saved an iteration.
- **Skip-if-already-filled is the underrated combobox win.** It turns out most of the "combobox fill" cases in practice are "the field is already correct from a prior pass" — skipping cleanly is the right behavior. The actually-hard case (empty combobox, need to open) is a small slice of total field volume.
- **Synthetic events vs real events is a hard ceiling.** Workday's combobox open logic appears to gate on something that distinguishes our calls from real user clicks. The v1/v2 architecture line was crossed, but there's a v2/v3 line beyond that (Workday-specific reverse-engineering) we'd hit eventually anyway.

### Session 7.7 — Path-level merge, combobox diagnostic, hit the v1/v2 wall
- Bug 1 (merge architecture): replaced section-level `mergeWithExisting` with granular path-level merge. CaptureResult now records every touched dotted path; object leaves get deep-set, array sections get replaced wholesale, keyed entries (websites, customAnswers) match-replace-or-append. Verified end-to-end: captured `preferences.preferredSource = "Internet Advertisement"` from contact-info, then captured Application Questions (touches `preferences.willingToRelocate`), preferredSource survived. Shipped as v0.0.6.
- Bug 2 (combobox typing): built a listbox-mismatch diagnostic that dumps actual option labels on match failure. Immediately surfaced two distinct combobox failures — Source dropdown is hierarchical (5 categories at top level, "Internet Advertisement" lives inside "Advertisement"), Phone Code is alphabetical and lazy-loaded (~200 countries, only 23 rendered). Shipped diagnostic as v0.0.7.
- Iterated on combobox typing (v0.0.8): added `keydown` / `beforeinput` / `keyup` events, trimmed filter query to first 2 words after stripping parentheticals, added mid-typing diagnostic logging `el.value` after the typing loop. The diagnostic was the breakthrough — it confirmed our value writes are landing (`el.value` correctly reads back as "United States" after typing) but the listbox still shows A–B unfiltered. Conclusion: Workday's React combobox filter doesn't respond to any synthetic DOM event from the content-script world.
- Hit the exact widget class CLAUDE.md predicted would force the two-script (content + injected) architecture. Documented in CLAUDE.md as the explicit v1/v2 boundary. Real fix is page-main-world injected script + React fiber traversal — deferred to v2.
- End-state on contact-info step: 13/15 fields filled (87%). All fail-cases are Workday combobox typeaheads.

### Tomorrow / next session
- **The empty-combobox open problem.** v0.0.16 verified live: we successfully invoke `onSelectInputClick` on the depth-10 Workday SelectInput component, but it doesn't open the listbox for an EMPTY combobox. To close this in a next session: open DevTools on a live Workday page, grab the combobox input, walk up its fiber to the depth-10 ancestor, and `console.log(fiber.memoizedProps.onSelectInputClick.toString())`. The source code will reveal what arg shape / state the handler actually expects. Likely paths from there: pass a more complete synthetic event (with `nativeEvent` populated correctly), set focus on the input first, or call a method on `stateNode` instead of the prop.
- **Decide whether v1 is "done enough" for the LinkedIn post.** Final v0.0.16 live result on contact-info step: 14 filled, 3 skipped, 0 errors. All identity / contact / work experience / education / button-widgets / radio Q&A / pre-filled combos work. The one outright failure (an EMPTY source dropdown) is a single field. Honest framing for the post: "v1 fills everything except an empty combobox typeahead; the v2 main-world architecture (injected script + React fiber traversal) is in place, plumbing works, one Workday-specific handler signature is the remaining puzzle."
- **Record an end-to-end screen capture** on a real Workday application: capture from multiple steps, then fill on a fresh `useMyLastApplication` URL. Document what fills and what doesn't. The "0 errors, 14 filled" footer is a strong demo asset.
- Defer further: LLM-based semantic mapping for tenants whose label phrasing breaks the regex map. Fresh-start (one-block, click-Add-Another) Workday flows for work experience / education. Skills typeahead chip capture/fill. Hierarchical drill-in for tree-style comboboxes (the content-script walker is in place but never gets triggered because v0.0.13's listbox lookup correctly returns null when the source listbox isn't open).
