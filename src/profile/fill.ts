// Fill logic. Given a profile and a set of scanned Workday fields (with live
// DOM element refs), walks the fields and writes profile values into the
// page using widget-appropriate techniques.
//
// Architecture: hybrid. Most widgets use content-script-only fills with the
// native value setter trick (Object.getOwnPropertyDescriptor on
// HTMLInputElement.prototype → setter call → dispatch input/change/blur)
// to bypass React's per-instance value tracker. This works from the
// isolated world because the prototype's setter is callable from any JS
// context with a reference to the element.
//
// Combobox typeahead is the exception. Verified live: Workday's option
// selection doesn't fire on real DOM clicks — selection goes through
// React's onSelect prop on the option's fiber, and the empty-state
// opener goes through onSelectInputClick on the input's fiber. Neither
// is reachable from the isolated world. So fillCombobox falls through
// to a main-world injected script (src/injected/main.ts via
// src/injected/bridge.ts) that walks React fibers and invokes the
// handlers directly. See JOURNAL.md (2026-05-11) for the spike that
// established the contract.
//
// Widget dispatch:
//   - input[type="text|email|tel|...]" / textarea  → fillTextInput
//   - input[type="checkbox"]                       → fillCheckable (toggle if state differs)
//   - input[type="radio"]                          → fillCheckable (match by option value/label)
//   - input[role="combobox"] / uxiElementId="selectinput-*"
//                                                  → fillCombobox → main-world for empty/hierarchical
//   - button[aria-haspopup="listbox"]              → fillButtonWidget (click + wait + click match)
//   - select                                       → fillSelect
//
// Repeated structures: walked in DOM order with instance counters
// (workExpIndex, eduIndex). Date inputs ($dateMonth/$dateYear sentinels)
// consume from per-block month/year queues that get refilled when a new
// block starts (jobTitle for workExperience, school for education).
//
// File-upload: not supported — browsers block programmatic file input
// assignment for security. The relevant field is silently skipped.

import type { UserProfile, CustomAnswer } from './types';
import { findMapping, type MappingInput } from './mapping';
import { requestComboboxFill, requestFiberInspect } from '../injected/bridge';

export interface FillField extends MappingInput {
  tagName: string;
  type: string;
  uxiElementId: string | null;
  placeholder: string | null;
  value: string;
  displayText?: string | null;
  checked?: boolean;
  required: boolean;
  bestSelector: string | null;
  el: Element;
}

export interface FillError {
  path: string;
  reason: string;
}

export interface FillResult {
  filled: number;
  skipped: number;
  errors: FillError[];
  voluntaryDisclosureFieldsFilled: Element[];
}

export async function fillFromProfile(
  profile: UserProfile,
  fields: FillField[],
): Promise<FillResult> {
  const result: FillResult = {
    filled: 0,
    skipped: 0,
    errors: [],
    voluntaryDisclosureFieldsFilled: [],
  };

  let workExpIndex = -1;
  let eduIndex = -1;
  let monthQueue: number[] = [];
  let yearQueue: number[] = [];

  for (const field of fields) {
    const mapping = findMapping(field);
    if (!mapping) {
      // Fall through to customAnswers — application-specific Q&A captured
      // from prior Workday applications (e.g., "Have you previously worked
      // for Workday?" → "No").
      const ca = findCustomAnswerForField(profile.customAnswers, field);
      if (ca && ca.answer !== '' && ca.answer !== false) {
        try {
          await fillByWidget(field, ca.answer, 'customAnswer', result);
        } catch (err) {
          result.errors.push({
            path: 'customAnswer',
            reason: (err as Error).message ?? 'unknown error',
          });
        }
        continue;
      }
      result.skipped++;
      continue;
    }
    const path = mapping.path;

    try {
      // Date sentinels — consume from current block's queue.
      if (path === '$dateMonth') {
        const value = monthQueue.shift();
        if (value != null) {
          fillTextInput(field.el as HTMLInputElement, String(value));
          result.filled++;
        } else {
          result.skipped++;
        }
        continue;
      }
      if (path === '$dateYear') {
        const value = yearQueue.shift();
        if (value != null) {
          fillTextInput(field.el as HTMLInputElement, String(value));
          result.filled++;
        } else {
          result.skipped++;
        }
        continue;
      }

      // workExperience[]
      if (path.startsWith('workExperience[].')) {
        const fieldName = path.slice('workExperience[].'.length);
        if (fieldName === 'jobTitle') {
          workExpIndex++;
          const exp = profile.workExperience[workExpIndex];
          if (exp) {
            monthQueue = [exp.startMonth];
            yearQueue = [exp.startYear];
            if (!exp.currentlyHere && exp.endMonth != null && exp.endYear != null) {
              monthQueue.push(exp.endMonth);
              yearQueue.push(exp.endYear);
            }
          } else {
            monthQueue = [];
            yearQueue = [];
          }
        }
        const exp = profile.workExperience[workExpIndex];
        if (!exp) { result.skipped++; continue; }
        const value = (exp as unknown as Record<string, unknown>)[fieldName];
        if (value == null) { result.skipped++; continue; }
        await fillByWidget(field, value, path, result);
        continue;
      }

      // education[]
      if (path.startsWith('education[].')) {
        const fieldName = path.slice('education[].'.length);
        if (fieldName === 'school') {
          eduIndex++;
          const edu = profile.education[eduIndex];
          monthQueue = [];
          yearQueue = [];
          if (edu) {
            // Most Workday tenants only ask years for education
            if (edu.startYear != null) yearQueue.push(edu.startYear);
            if (edu.endYear != null) yearQueue.push(edu.endYear);
          }
        }
        const edu = profile.education[eduIndex];
        if (!edu) { result.skipped++; continue; }
        const value = (edu as unknown as Record<string, unknown>)[fieldName];
        if (value == null) { result.skipped++; continue; }
        await fillByWidget(field, value, path, result);
        continue;
      }

      // Skills typeahead — chips not currently supported.
      if (path === 'skills') {
        result.skipped++;
        continue;
      }

      // websites[label=X].url
      const websiteMatch = path.match(/^websites\[label=([^\]]+)\]\.url$/);
      if (websiteMatch) {
        const label = websiteMatch[1];
        const site = profile.websites.find((w) => w.label === label);
        if (!site || !site.url) { result.skipped++; continue; }
        await fillByWidget(field, site.url, path, result);
        continue;
      }

      // Plain dotted path
      const value = getByPath(profile, path);
      if (value == null || value === '') { result.skipped++; continue; }
      await fillByWidget(field, value, path, result);
    } catch (err) {
      result.errors.push({
        path,
        reason: (err as Error).message ?? 'unknown error',
      });
    }
  }

  return result;
}

async function fillByWidget(
  field: FillField,
  value: unknown,
  path: string,
  result: FillResult,
): Promise<void> {
  const el = field.el;
  const tag = field.tagName;
  const type = field.type;
  console.log(`[WorkdayAgent] fillByWidget: path=${path} tag=${tag} type=${type} uxi=${field.uxiElementId} value=${JSON.stringify(value).slice(0, 60)}`);

  // Track voluntary-disclosure fields for the visual cue.
  const isVoluntaryDisclosure = path.startsWith('voluntaryDisclosures.');

  // Respect-existing-value policy: if the widget already shows a
  // non-default value that doesn't match the profile target, don't
  // overwrite — preserve whatever's there (manual entry, Workday
  // auto-prefill, or a prior fill the user kept). Counts as skipped
  // with a distinct log so the user can audit which fields were
  // respected vs which weren't fillable for other reasons.
  // Combobox typeaheads are gated by the main-world pre-flight instead;
  // hasUnmatchedExistingValue returns null for them so we still bridge
  // out and let main-world ground-truth the chip.
  const existing = hasUnmatchedExistingValue(field, String(value));
  if (existing) {
    console.log(
      `[WorkdayAgent] respecting existing value at ${path}: ${existing.reason}, current="${existing.current}"; skipping fill of "${String(value).slice(0, 60)}"`,
    );
    result.skipped++;
    return;
  }

  if (tag === 'input') {
    if (type === 'checkbox') {
      fillCheckable(el as HTMLInputElement, !!value);
      if (isVoluntaryDisclosure) result.voluntaryDisclosureFieldsFilled.push(el);
      result.filled++;
      return;
    }
    if (type === 'radio') {
      // Match this radio's value against the desired profile value.
      // Workday radios have HTML value "true" / "false" for Yes/No, and
      // labels like "Question → Yes" / "Question → No".
      const radioInput = el as HTMLInputElement;
      const radioVal = radioInput.value?.toLowerCase() || '';
      const optionLabel = extractRadioOptionLabel(field.label).toLowerCase();
      let shouldBeChecked: boolean;
      if (typeof value === 'boolean') {
        const radioBool = radioVal === 'true';
        shouldBeChecked = radioBool === value;
      } else {
        const target = String(value).toLowerCase();
        shouldBeChecked = radioVal === target || optionLabel === target;
      }
      fillCheckable(radioInput, shouldBeChecked);
      if (isVoluntaryDisclosure) result.voluntaryDisclosureFieldsFilled.push(el);
      result.filled++;
      return;
    }

    // Combobox typeahead: input with role="combobox" or Workday's selectinput-* uxiElementId
    if (
      field.uxiElementId?.startsWith('selectinput-') ||
      el.getAttribute('role') === 'combobox'
    ) {
      // Skip-if-already-filled (scan-time). Catches the common case
      // where scanning captured the chip text in field.context — saves
      // a round-trip to the main world. The main-world pre-flight
      // chip-check handles the harder case where the chip appeared
      // between scan and fill.
      if (comboboxAlreadyShowsTarget(field, String(value))) {
        console.log(
          `[WorkdayAgent] fillCombobox: chip already shows "${value}" (context="${field.context}"); skipping`,
        );
        if (isVoluntaryDisclosure) result.voluntaryDisclosureFieldsFilled.push(el);
        result.filled++;
        return;
      }
      const outcome = await fillCombobox(el as HTMLInputElement, String(value));
      if (outcome === 'filled') {
        if (isVoluntaryDisclosure) result.voluntaryDisclosureFieldsFilled.push(el);
        result.filled++;
      } else {
        // 'skip-preselected' (main-world ground-truth: chip differs from
        // target → respect manual choice) and 'failed' both count as
        // skipped. The distinct log already fired in main.ts; suppress
        // a redundant content-script log here for the skip-preselected
        // case.
        result.skipped++;
      }
      return;
    }

    // Plain text input (and date inputs which behave like text)
    fillTextInput(el as HTMLInputElement, String(value));
    if (isVoluntaryDisclosure) result.voluntaryDisclosureFieldsFilled.push(el);
    result.filled++;
    return;
  }

  if (tag === 'textarea') {
    fillTextInput(el as HTMLTextAreaElement, String(value));
    if (isVoluntaryDisclosure) result.voluntaryDisclosureFieldsFilled.push(el);
    result.filled++;
    return;
  }

  if (tag === 'button') {
    // Workday's paired button-listbox custom select.
    // Skip-if-already-shown: button widgets carry their visible label in
    // displayText. If it already matches our target, don't reopen the
    // listbox — wastes a few hundred ms per button and risks unwanted
    // state changes if the click handler is finicky.
    if (comboboxAlreadyShowsTarget(field, String(value))) {
      console.log(
        `[WorkdayAgent] fillButtonWidget: button already displays "${value}"; skipping`,
      );
      if (isVoluntaryDisclosure) result.voluntaryDisclosureFieldsFilled.push(el);
      result.filled++;
      return;
    }
    const ok = await fillButtonWidget(el as HTMLButtonElement, String(value));
    if (ok) {
      if (isVoluntaryDisclosure) result.voluntaryDisclosureFieldsFilled.push(el);
      result.filled++;
    } else {
      result.skipped++;
    }
    return;
  }

  if (tag === 'select') {
    fillSelect(el as HTMLSelectElement, String(value));
    if (isVoluntaryDisclosure) result.voluntaryDisclosureFieldsFilled.push(el);
    result.filled++;
    return;
  }

  result.skipped++;
}

// React tracks `value` via per-instance property descriptors; setting `.value`
// directly is ignored. Use the prototype's native setter to bypass React's
// monkey-patch, then dispatch input/change/blur so React's listeners fire.
function fillTextInput(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
}

function fillCheckable(el: HTMLInputElement, shouldBeChecked: boolean): void {
  if (el.checked === shouldBeChecked) return;
  el.click();
}

function fillSelect(el: HTMLSelectElement, value: string): void {
  for (const opt of Array.from(el.options)) {
    if (opt.value === value || opt.textContent?.trim() === value) {
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
  }
}

async function fillButtonWidget(buttonEl: HTMLButtonElement, targetValue: string): Promise<boolean> {
  // Open the dropdown with full click sequence.
  dispatchClickSequence(buttonEl);
  const listbox = await waitForElement('[role="listbox"]', 2000);
  if (!listbox) {
    console.log(`[WorkdayAgent] fillButtonWidget: listbox didn't appear for "${targetValue}"`);
    return false;
  }

  const match = findOptionMatchInLatestListbox(targetValue, buttonEl);
  if (match) {
    console.log(`[WorkdayAgent] fillButtonWidget: clicking option "${match.textContent?.trim()}" for target "${targetValue}"`);
    dispatchClickSequence(match);
    return true;
  }
  logListboxMismatch('fillButtonWidget', targetValue);
  return false;
}

// Workday's combobox typeahead is finicky:
//   - Needs a click to open the listbox (focus alone isn't enough)
//   - Listbox closes if the input dispatches `blur` mid-flow
//   - The filter handler appears to listen on keystroke events; setting
//     the whole value and dispatching a single `input` event leaves the
//     listbox unfiltered (verified via diagnostic — listbox stayed on
//     A–B countries after we'd "typed" the full target value)
//   - Lists may be virtualized/lazy-loaded — only ~23 options visible
//     at a time, so we have to filter to surface the option we want
//   - Option text often differs from the chip text (chip "United States
//     of America (+1)" → option "United States (+1)"); strip
//     parenthetical suffix from the filter query, but keep the original
//     captured value as a search variant for matching after filter
type FillOutcome = 'filled' | 'skip-preselected' | 'failed';

async function fillCombobox(inputEl: HTMLInputElement, targetValue: string): Promise<FillOutcome> {
  // Step 0: close any listboxes left open by previous fills. Workday
  // doesn't always close the previous widget's listbox before the next
  // one opens, which causes `findOptionMatchInLatestListbox` (DOM-order
  // last-wins) to read the wrong listbox (e.g., the phone-device-type
  // listbox while filling the country-phone-code combobox).
  closeOpenListboxes();
  await sleep(80);

  // Step 1: open the dropdown via full click sequence (synthetic .click()
  // alone may not register with Workday's pointer-event handlers).
  dispatchClickSequence(inputEl);
  inputEl.focus();
  await sleep(150);

  // Step 2: try matching against the initial (unfiltered) listbox first.
  let match = findOptionMatchInLatestListbox(targetValue, inputEl);
  if (match) {
    console.log(`[WorkdayAgent] fillCombobox: clicking unfiltered match for "${targetValue}":`, match.textContent?.trim());
    dispatchClickSequence(match);
    return 'filled';
  }

  // Step 2b removed in v0.0.17: hierarchical drill-in moved to the
  // main-world v2 path. The previous content-script implementation
  // used dispatchClickSequence to "expand" category options, but
  // Workday's options don't fire on real DOM clicks — selection goes
  // through React's onSelect, which only the main-world script can
  // invoke. The v2 path handles both flat AND hierarchical pickers.

  // Steps 3 & 4 removed in v0.0.17: per-character typing never actually
  // triggered Workday's React filter (verified v0.0.8) AND it actively
  // breaks the v2 main-world path. After typing, the combobox's internal
  // state lands in a mode where `onSelectInputClick()` no longer opens
  // the picker, so the v2 fallback found no listbox and gave up. Going
  // straight from "no flat match" to the v2 path keeps the input
  // pristine when main-world walks the fibers.

  // Step 3 (v2 path): delegate to the main-world injected script. It can
  // see React fibers and invoke the combobox's React handler directly,
  // which the content-script's synthetic DOM events can't reach.
  const outcome = await tryMainWorldFill(inputEl, targetValue);
  if (outcome !== 'failed') return outcome;

  logListboxMismatch('fillCombobox', targetValue);
  return 'failed';
}

async function tryMainWorldFill(
  inputEl: HTMLInputElement,
  targetValue: string,
): Promise<FillOutcome> {
  const selector = buildSelectorForElement(inputEl);
  if (!selector) {
    console.log('[WorkdayAgent] tryMainWorldFill: could not build a stable selector for element');
    return 'failed';
  }

  // First-run mode: also send a fiber-inspect so the page console shows
  // what handler props are visible on the element's ancestors. Free
  // debugging data on every attempt — costs almost nothing.
  try {
    const inspect = await requestFiberInspect(selector);
    console.log('[WorkdayAgent] fiber-inspect (raw JSON):', JSON.stringify(inspect));
    if (inspect.fiberFound) {
      // One flat line per ancestor — easy to copy/paste without expanding objects.
      for (const a of inspect.ancestors) {
        console.log(
          `[WorkdayAgent] fiber-inspect ancestor d=${a.depth} type=${a.typeName} handlers=${JSON.stringify(a.handlerPropNames)}`,
        );
      }
    }
  } catch (err) {
    console.log(
      '[WorkdayAgent] fiber-inspect failed (main-world script may not be loaded):',
      (err as Error).message,
    );
    // Don't return false — still try the fill. If the fill itself
    // times out, we'll know main world isn't responsive.
  }

  try {
    const variants = searchVariants(targetValue);
    // 8s timeout: hierarchical walking can do up to 6 category attempts
    // × ~500ms reopen + drill = ~3s in the worst case. The default 4s
    // bridge timeout is too tight.
    const response = await requestComboboxFill(selector, targetValue, variants, 8000);
    console.log('[WorkdayAgent] main-world combobox-fill (raw JSON):', JSON.stringify(response));
    if (response.status === 'filled') return 'filled';
    if (response.status === 'skip-preselected') return 'skip-preselected';
    return 'failed';
  } catch (err) {
    console.log('[WorkdayAgent] main-world combobox-fill failed:', (err as Error).message);
    return 'failed';
  }
}

/** Build a CSS selector that resolves the element in the main world.
 *  Workday combobox inputs always have a unique `data-uxi-element-id`
 *  in the `selectinput-<uuid>` pattern, so use that when present.
 *  Otherwise fall back to a tagged data attribute. */
function buildSelectorForElement(el: HTMLInputElement): string | null {
  const uxi = el.getAttribute('data-uxi-element-id');
  if (uxi) return `[data-uxi-element-id="${cssEscape(uxi)}"]`;
  const id = el.id;
  if (id) return `#${cssEscape(id)}`;
  // Last resort: mark the element with a one-shot attribute.
  const marker = `wa-marker-${Math.random().toString(36).slice(2)}`;
  el.setAttribute('data-wa-target', marker);
  return `[data-wa-target="${marker}"]`;
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

// Hierarchical / tree-picker fallback. Workday's "How Did You Hear About
// Us?" surfaces top-level CATEGORIES ("Advertisement", "Partnership",
// "Socially", "Website", "Workday") and the user drills in to find leaf
// options like "Internet Advertisement". This walks each top-level
// option, clicks it to expand, checks if the latest listbox contains a
// Dump the actual options visible in the latest listbox when a match fails,
// alongside the search variants we tried. Helps diagnose why a captured
// value (e.g., "United States of America (+1)") doesn't match Workday's
// rendered options (which may be shorter, abbreviated, or formatted
// differently).
function logListboxMismatch(callerName: string, targetValue: string): void {
  const variants = searchVariants(targetValue);
  const listboxes = document.querySelectorAll('[role="listbox"]');
  if (listboxes.length === 0) {
    console.log(
      `[WorkdayAgent] ${callerName}: no option matched "${targetValue}". Listbox is closed/missing. Searched variants: ${JSON.stringify(variants)}`,
    );
    return;
  }
  const listbox = listboxes[listboxes.length - 1];
  const options = Array.from(listbox.querySelectorAll('[role="option"]'));
  const optionLabels = options.map((o) => o.textContent?.trim() ?? '');
  console.log(
    `[WorkdayAgent] ${callerName}: no option matched "${targetValue}". Searched variants: ${JSON.stringify(variants)}. Listbox has ${options.length} option(s):`,
    optionLabels,
  );
}

// Workday option handlers often need a full pointer/mouse event sequence
// rather than just `.click()`. Synthetic .click() events have
// isTrusted=false and may be ignored by handlers that distinguish real
// user input.
function dispatchClickSequence(el: HTMLElement | Element): void {
  const opts: PointerEventInit & MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
  };
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
}

// Strip parenthetical suffixes ("United States of America (+1)" → "United States of America")
// so search can fall back to a cleaner version when Workday's option text
// doesn't include the suffix that the chip displays.
function searchVariants(targetValue: string): string[] {
  const variants = new Set<string>();
  variants.add(targetValue);
  const stripped = targetValue.replace(/\s*\([^)]*\)\s*/g, '').trim();
  if (stripped) variants.add(stripped);
  const firstChunk = targetValue.split(/[(,]/)[0].trim();
  if (firstChunk) variants.add(firstChunk);
  // Profile booleans get stringified to "true"/"false" by the caller.
  // Workday button-selects and comboboxes commonly render Yes/No labels
  // instead — match through both. Verified live on Nvidia's
  // workAuthorization.authorizedToWorkInUS button-select where the
  // listbox options were ['Select One', 'Yes', 'No'].
  if (targetValue === 'true') variants.add('Yes');
  if (targetValue === 'false') variants.add('No');
  return Array.from(variants);
}

function findOptionMatchInLatestListbox(
  targetValue: string,
  sourceEl?: Element,
): HTMLElement | null {
  const listbox = sourceEl ? findListboxFor(sourceEl) : latestListbox();
  if (!listbox) return null;
  const options = Array.from(listbox.querySelectorAll('[role="option"]'));
  if (options.length === 0) return null;

  // Try each search variant: exact match wins, then substring.
  for (const variant of searchVariants(targetValue)) {
    const v = variant.toLowerCase();
    for (const opt of options) {
      if (opt.textContent?.trim().toLowerCase() === v) return opt as HTMLElement;
    }
  }
  for (const variant of searchVariants(targetValue)) {
    const v = variant.toLowerCase();
    for (const opt of options) {
      if (opt.textContent?.trim().toLowerCase().includes(v)) return opt as HTMLElement;
    }
  }
  return null;
}

function latestListbox(): Element | null {
  const all = document.querySelectorAll('[role="listbox"]');
  return all.length > 0 ? all[all.length - 1] : null;
}

// Mirror of main.ts findListboxFor. See that file for the full rationale.
// Workday pre-renders multiple listboxes; "latest in DOM order" gives the
// wrong one when filling combobox A while combobox B's chip indicator
// happens to be later in the DOM.
function findListboxFor(input: Element): Element | null {
  for (const attr of ['aria-controls', 'aria-owns', 'aria-activedescendant']) {
    const id = input.getAttribute(attr);
    if (id) {
      const referenced = document.getElementById(id);
      if (referenced) {
        if (referenced.getAttribute('role') === 'listbox') return referenced;
        const ancestor = referenced.closest('[role="listbox"]');
        if (ancestor) return ancestor;
      }
    }
  }

  const all = Array.from(document.querySelectorAll('[role="listbox"]'));
  const visibleMulti = all.filter((lb) => {
    if (lb.getAttribute('aria-hidden') === 'true') return false;
    const rect = lb.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return lb.querySelectorAll('[role="option"]').length > 1;
  });

  if (visibleMulti.length === 1) return visibleMulti[0];
  if (visibleMulti.length > 1) {
    let best: Element | null = null;
    let bestDistance = Infinity;
    for (const lb of visibleMulti) {
      const d = domDistance(input, lb);
      if (d < bestDistance) {
        best = lb;
        bestDistance = d;
      }
    }
    if (best) return best;
  }
  // No good candidate — don't fall back to latest-in-DOM-order. That
  // path previously poisoned source-dropdown attempts by matching them
  // against the country phone code's chip indicator.
  return null;
}

function domDistance(a: Element, b: Element): number {
  let depth = 0;
  let current: Element | null = a;
  while (current) {
    if (current.contains(b)) {
      let down = 0;
      let cursor: Element | null = b;
      while (cursor && cursor !== current) {
        cursor = cursor.parentElement;
        down++;
      }
      return depth + down;
    }
    current = current.parentElement;
    depth++;
  }
  return Number.POSITIVE_INFINITY;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// True if the scanned field's surrounding context already shows the
// target value as a selected chip. Workday combobox typeaheads render
// the chip as a "1 item selected, <label>" string in the parent
// element's textContent (we picked this up during scanning as
// field.context). Match on the chip's label content rather than the
// raw context string, with some forgiveness on whitespace.
function comboboxAlreadyShowsTarget(
  field: { context?: string | null; displayText?: string | null },
  targetValue: string,
): boolean {
  const target = targetValue.trim().toLowerCase();
  if (!target) return false;
  const ctx = (field.context ?? '').trim().toLowerCase();
  if (!ctx) return false;
  const m = ctx.match(/^1 items? selected,\s*(.+)$/i);
  if (m && m[1]?.trim() === target) return true;
  // Also accept the case where displayText itself is the captured value
  // (some Workday widgets don't expose the chip-style context).
  const display = (field.displayText ?? '').trim().toLowerCase();
  if (display && display === target) return true;
  return false;
}

// True when the widget's current visible value is non-empty, isn't a
// placeholder, and doesn't match the target. "Respect the user's manual
// choice" policy: when a value is already there, don't overwrite — even
// if the user picked it manually OR Workday auto-pre-filled it from a
// prior application / candidate account. Caller skips the fill and
// logs a clear distinct line.
//
// Combobox typeaheads are NOT handled here — their fresh chip-readback
// lives in the main-world script and is reported via the
// 'skip-preselected' response status.
function hasUnmatchedExistingValue(
  field: FillField,
  targetValue: string,
): { reason: string; current: string } | null {
  const el = field.el;
  const tag = field.tagName;
  const type = field.type;
  const target = targetValue.trim().toLowerCase();

  if (tag === 'input') {
    if (type === 'checkbox') {
      // Only block "uncheck what's currently checked". Checking an
      // unchecked box is still allowed — the box has no "manual choice"
      // indication when its state matches the form default (unchecked).
      const input = el as HTMLInputElement;
      const targetBool = !!(targetValue === 'true' || targetValue === '1' || (targetValue as unknown) === true);
      if (input.checked && !targetBool) {
        return { reason: 'checkbox already checked', current: 'checked' };
      }
      return null;
    }
    if (type === 'radio') {
      // Look for ANY checked radio in this group whose value/label
      // doesn't match the target. The fillByWidget loop processes each
      // radio individually, so we need to peek at the group state.
      const input = el as HTMLInputElement;
      const name = input.name;
      if (!name) return null;
      const root = input.form ?? document;
      const group = Array.from(
        root.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${cssEscape(name)}"]`),
      );
      const checked = group.find((r) => r.checked);
      if (!checked) return null;
      const checkedVal = (checked.value ?? '').toLowerCase();
      // The target radio is `el` itself; we want to allow filling it iff
      // no other radio in the group is checked. If a different radio is
      // already on, block.
      if (checked !== input) {
        return { reason: 'a different radio is already selected', current: checkedVal || 'unknown' };
      }
      return null;
    }
    // Combobox typeahead — handled by the main-world pre-flight, not
    // here. Skip the input-level check for these so we still reach the
    // main-world bridge.
    if (
      field.uxiElementId?.startsWith('selectinput-') ||
      el.getAttribute('role') === 'combobox'
    ) {
      return null;
    }
    // Plain text input (and date inputs which behave like text). Read
    // the live DOM value rather than the scan-time field.value — between
    // scan and fill the page can mutate.
    const live = ((el as HTMLInputElement).value ?? '').trim();
    if (!live) return null;
    if (live.toLowerCase() === target) return null;
    return { reason: 'text input already has a value', current: live };
  }

  if (tag === 'textarea') {
    const live = ((el as HTMLTextAreaElement).value ?? '').trim();
    if (!live) return null;
    if (live.toLowerCase() === target) return null;
    return { reason: 'textarea already has a value', current: live };
  }

  if (tag === 'button') {
    // Workday button-listbox custom select. displayText carries the
    // visible label. Treat the common placeholder phrases as "empty"
    // (Select / Choose / leading dash) so first-time fills aren't
    // blocked. Anything else is treated as a real selection.
    const display = (field.displayText ?? '').trim();
    if (!display) return null;
    if (PLACEHOLDER_LABEL.test(display)) return null;
    if (display.toLowerCase() === target) return null;
    return { reason: 'button select already shows a value', current: display };
  }

  if (tag === 'select') {
    const sel = el as HTMLSelectElement;
    const v = (sel.value ?? '').trim();
    if (!v) return null;
    const optText = sel.options[sel.selectedIndex]?.text?.trim() ?? '';
    if (PLACEHOLDER_LABEL.test(optText)) return null;
    if (v.toLowerCase() === target || optText.toLowerCase() === target) return null;
    return { reason: 'select already has a non-default value', current: optText || v };
  }

  return null;
}

// Phrases Workday uses for the "no choice yet" sentinel in button-style
// selects and native <select>s. Order doesn't matter; the regex covers
// the common patterns observed across Nvidia/Workday-corp tenants.
const PLACEHOLDER_LABEL = /^(select(\s|$)|choose(\s|$)|please\s|--|-\s)/i;

// Dispatch Escape to dismiss any currently-open listboxes. Workday
// occasionally leaves them in the DOM after a fill, which makes
// "latest listbox" detection grab the wrong widget's options for the
// next combobox attempt.
function closeOpenListboxes(): void {
  const escInit: KeyboardEventInit = {
    key: 'Escape',
    code: 'Escape',
    keyCode: 27,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  document.body.dispatchEvent(new KeyboardEvent('keydown', escInit));
  document.body.dispatchEvent(new KeyboardEvent('keyup', escInit));
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', escInit));
    document.activeElement.dispatchEvent(new KeyboardEvent('keyup', escInit));
    document.activeElement.blur();
  }
}

function waitForElement(selector: string, timeoutMs = 2000): Promise<Element | null> {
  return new Promise((resolve) => {
    const existing = document.querySelector(selector);
    if (existing) {
      resolve(existing);
      return;
    }
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
  });
}

// Pull "Yes" out of a radio label like "Have you previously worked... → Yes".
function extractRadioOptionLabel(label: string | null): string {
  if (!label) return '';
  const m = label.match(/→\s*(.+)$/);
  return m ? m[1].trim() : label.trim();
}

function findCustomAnswerForField(
  customAnswers: CustomAnswer[],
  field: FillField,
): CustomAnswer | null {
  const haystacks: string[] = [];
  if (field.label) haystacks.push(field.label.toLowerCase());
  if (field.context) haystacks.push(field.context.toLowerCase());
  if (field.ariaLabel) haystacks.push(field.ariaLabel.toLowerCase());
  if (haystacks.length === 0) return null;
  for (const ca of customAnswers) {
    const pattern = ca.pattern.toLowerCase().trim();
    if (!pattern) continue;
    if (haystacks.some((h) => h.includes(pattern))) {
      return ca;
    }
  }
  return null;
}

function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let cursor: unknown = obj;
  for (const part of parts) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/**
 * Apply a brief visual highlight to a list of elements (used after fill to
 * draw attention to voluntary-disclosure fields the agent populated).
 */
export function highlightFields(elements: Element[], durationMs = 5000): void {
  for (const el of elements) {
    if (!(el instanceof HTMLElement)) continue;
    const originalOutline = el.style.outline;
    const originalOffset = el.style.outlineOffset;
    const originalTransition = el.style.transition;
    el.style.transition = 'outline 0.25s ease-out';
    el.style.outline = '3px solid #f59e0b';
    el.style.outlineOffset = '2px';
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => {
      el.style.outline = originalOutline;
      el.style.outlineOffset = originalOffset;
      el.style.transition = originalTransition;
    }, durationMs);
  }
}
