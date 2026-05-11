// Fill logic. Given a profile and a set of scanned Workday fields (with live
// DOM element refs), walks the fields and writes profile values into the
// page using widget-appropriate techniques.
//
// Architecture decision: content-script-only rather than the two-script
// (content + injected) pattern documented in CLAUDE.md. Reasoning: the
// React-input-tracking issue is solved by using the native value setter from
// HTMLInputElement.prototype (skips React's instance-level monkey-patch) and
// dispatching standard events on the live element. That works from any JS
// context that holds a reference to the element. If we hit a Workday widget
// where this fails, the fallback is to add an injected script — but for v1
// we keep it simple. Documented in JOURNAL.md (2026-05-09).
//
// Widget dispatch:
//   - input[type="text|email|tel|...]" / textarea  → fillTextInput
//   - input[type="checkbox"]                       → fillCheckable (toggle if state differs)
//   - input[type="radio"]                          → fillCheckable (match by option value/label)
//   - input[role="combobox"] / uxiElementId="selectinput-*"
//                                                  → fillCombobox (focus + type + click match)
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
      const ok = await fillCombobox(el as HTMLInputElement, String(value));
      if (ok) {
        if (isVoluntaryDisclosure) result.voluntaryDisclosureFieldsFilled.push(el);
        result.filled++;
      } else {
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

  const match = findOptionMatchInLatestListbox(targetValue);
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
async function fillCombobox(inputEl: HTMLInputElement, targetValue: string): Promise<boolean> {
  // Step 1: open the dropdown via full click sequence (synthetic .click()
  // alone may not register with Workday's pointer-event handlers).
  dispatchClickSequence(inputEl);
  inputEl.focus();
  await sleep(150);

  // Step 2: try matching against the initial (unfiltered) listbox first.
  let match = findOptionMatchInLatestListbox(targetValue);
  if (match) {
    console.log(`[WorkdayAgent] fillCombobox: clicking unfiltered match for "${targetValue}":`, match.textContent?.trim());
    dispatchClickSequence(match);
    return true;
  }

  // Step 2b: hierarchical fallback — if the listbox is small and none of
  // the options match, try clicking each top-level option to see if it
  // expands into a sub-list containing the target (Workday's tree-style
  // pickers, e.g., "How Did You Hear About Us?" where the top level is
  // categories and "Internet Advertisement" lives inside "Advertisement").
  const hierarchical = await tryHierarchicalSelect(targetValue);
  if (hierarchical) return true;

  // Step 3: type a filter query character-by-character so Workday's
  // keystroke-listening filter fires (NOTE: as of v0.0.8 this does not
  // actually trigger Workday's React filter — kept here as the v2 entry
  // point once the injected-script architecture lands).
  const filterQuery = filterQueryFor(targetValue);
  console.log(`[WorkdayAgent] fillCombobox: typing filter "${filterQuery}" for target "${targetValue}"`);
  await typeIntoCombobox(inputEl, filterQuery);

  // Step 4: give Workday up to 1.5s after typing finishes to render the
  // filtered list, polling for a match against any search variant.
  for (let i = 0; i < 6; i++) {
    await sleep(250);
    match = findOptionMatchInLatestListbox(targetValue);
    if (match) {
      console.log(`[WorkdayAgent] fillCombobox: clicking filtered match for "${targetValue}":`, match.textContent?.trim());
      dispatchClickSequence(match);
      return true;
    }
  }

  logListboxMismatch('fillCombobox', targetValue);
  return false;
}

// Hierarchical / tree-picker fallback. Workday's "How Did You Hear About
// Us?" surfaces top-level CATEGORIES ("Advertisement", "Partnership",
// "Socially", "Website", "Workday") and the user drills in to find leaf
// options like "Internet Advertisement". This walks each top-level
// option, clicks it to expand, checks if the latest listbox contains a
// match for the target, and clicks the match if found. Backs out if
// no match by clicking the category again (to collapse) before moving
// to the next.
async function tryHierarchicalSelect(targetValue: string): Promise<boolean> {
  const listboxes = document.querySelectorAll('[role="listbox"]');
  if (listboxes.length === 0) return false;
  const listbox = listboxes[listboxes.length - 1];
  const topLevelOptions = Array.from(
    listbox.querySelectorAll('[role="option"]'),
  ) as HTMLElement[];
  if (topLevelOptions.length === 0 || topLevelOptions.length > 10) {
    // Tree pickers in practice have few top-level categories. If the list
    // is large, it's a flat list (or paginated) and hierarchical walking
    // would just be noisy and slow.
    return false;
  }

  // Snapshot the initial option labels so we can detect when clicking a
  // category replaces them (vs. expanding inline).
  const initialLabels = new Set(
    topLevelOptions.map((o) => o.textContent?.trim() ?? ''),
  );
  console.log(
    `[WorkdayAgent] tryHierarchicalSelect: attempting drill-in for "${targetValue}" across ${topLevelOptions.length} categories: ${JSON.stringify(Array.from(initialLabels))}`,
  );

  for (const category of topLevelOptions) {
    const categoryLabel = category.textContent?.trim() ?? '';
    // Heuristic: prioritize the category whose name is a prefix/substring
    // of the target. "Internet Advertisement" → try "Advertisement" first.
    // We'll still walk the rest if the prioritized one doesn't yield.
    // (Implemented below as a re-sort.)
    void categoryLabel; // silence unused warning in current pass
  }

  // Sort: categories whose name appears as a token in the target come first.
  const targetTokens = targetValue.toLowerCase().split(/\s+/);
  topLevelOptions.sort((a, b) => {
    const al = (a.textContent ?? '').toLowerCase().trim();
    const bl = (b.textContent ?? '').toLowerCase().trim();
    const aMatch = targetTokens.some((t) => t === al || al.includes(t) || t.includes(al));
    const bMatch = targetTokens.some((t) => t === bl || bl.includes(t) || t.includes(bl));
    return (bMatch ? 1 : 0) - (aMatch ? 1 : 0);
  });

  for (const category of topLevelOptions) {
    const categoryLabel = category.textContent?.trim() ?? '';
    console.log(`[WorkdayAgent] tryHierarchicalSelect: clicking category "${categoryLabel}"`);
    dispatchClickSequence(category);
    await sleep(300);

    const match = findOptionMatchInLatestListbox(targetValue);
    if (match) {
      const matchLabel = match.textContent?.trim() ?? '';
      // Don't re-click the same category we just opened (matches by self).
      if (matchLabel === categoryLabel) {
        // continue to back-out below
      } else {
        console.log(`[WorkdayAgent] tryHierarchicalSelect: matched "${matchLabel}" under "${categoryLabel}"`);
        dispatchClickSequence(match);
        return true;
      }
    }

    // No match under this category. Back out so the next category is
    // reachable. If the listbox went back to the same top-level labels,
    // the category click toggled rather than drilled — don't re-click
    // (would re-expand). Otherwise click the category again to collapse.
    const currentListboxes = document.querySelectorAll('[role="listbox"]');
    if (currentListboxes.length === 0) {
      console.log(`[WorkdayAgent] tryHierarchicalSelect: listbox closed after clicking "${categoryLabel}"; aborting`);
      return false;
    }
    const currentLabels = new Set(
      Array.from(
        currentListboxes[currentListboxes.length - 1].querySelectorAll('[role="option"]'),
      ).map((o) => o.textContent?.trim() ?? ''),
    );
    const stillAtTopLevel = setsEqual(currentLabels, initialLabels);
    if (!stillAtTopLevel) {
      // Drilled into a sub-list — click the category again to back out.
      dispatchClickSequence(category);
      await sleep(200);
    }
  }

  return false;
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// Build a SHORT filter query from the captured value. Workday's combobox
// option text often differs from the chip text — chip "United States of
// America (+1)" vs option "United States (+1)". Filtering by the full
// chip text matches zero options and Workday reverts to the unfiltered
// alphabetical first page. Trim heuristic:
//   1. Drop a trailing parenthetical suffix ("(+1)")
//   2. If multiple words remain, keep only the first 2 (so "United States
//      of America" → "United States")
// The full original value is still used for matching options after
// filter via searchVariants.
function filterQueryFor(targetValue: string): string {
  let q = targetValue.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (!q) return targetValue;
  const words = q.split(/\s+/);
  if (words.length > 2) q = words.slice(0, 2).join(' ');
  return q;
}

// Simulate per-character typing so Workday's combobox filter fires.
// Setting the whole value via prototype + dispatching `input` once isn't
// enough. Each char fires keydown → beforeinput → input → keyup.
async function typeIntoCombobox(el: HTMLInputElement, text: string): Promise<void> {
  // Clear any prior value first.
  setInputValueViaProto(el, '');
  el.dispatchEvent(
    new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }),
  );
  await sleep(30);

  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const keyInit: KeyboardEventInit = {
      key: ch,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    el.dispatchEvent(new KeyboardEvent('keydown', keyInit));
    el.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: ch,
        inputType: 'insertText',
      }),
    );
    current += ch;
    setInputValueViaProto(el, current);
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }),
    );
    el.dispatchEvent(new KeyboardEvent('keyup', keyInit));
    await sleep(20);
  }

  // Diagnostic: confirm the input's value reflects what we typed (debugging
  // whether typing is the gap, or whether filter just isn't firing).
  console.log(`[WorkdayAgent] typeIntoCombobox: input value after typing is "${el.value}"`);
}

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
  return Array.from(variants);
}

function findOptionMatchInLatestListbox(targetValue: string): HTMLElement | null {
  const listboxes = document.querySelectorAll('[role="listbox"]');
  if (listboxes.length === 0) return null;
  const listbox = listboxes[listboxes.length - 1];
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

function setInputValueViaProto(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
