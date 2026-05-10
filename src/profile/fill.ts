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
      await fillCombobox(el as HTMLInputElement, String(value));
      if (isVoluntaryDisclosure) result.voluntaryDisclosureFieldsFilled.push(el);
      result.filled++;
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
    await fillButtonWidget(el as HTMLButtonElement, String(value));
    if (isVoluntaryDisclosure) result.voluntaryDisclosureFieldsFilled.push(el);
    result.filled++;
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

async function fillButtonWidget(buttonEl: HTMLButtonElement, targetValue: string): Promise<void> {
  // Open the dropdown with full click sequence.
  dispatchClickSequence(buttonEl);
  const listbox = await waitForElement('[role="listbox"]', 2000);
  if (!listbox) {
    console.log(`[WorkdayAgent] fillButtonWidget: listbox didn't appear for "${targetValue}"`);
    return;
  }

  const match = findOptionMatchInLatestListbox(targetValue);
  if (match) {
    console.log(`[WorkdayAgent] fillButtonWidget: clicking option "${match.textContent?.trim()}" for target "${targetValue}"`);
    dispatchClickSequence(match);
  } else {
    console.log(`[WorkdayAgent] fillButtonWidget: no option matched "${targetValue}"`);
  }
}

// Workday's combobox typeahead is finicky:
//   - Needs a click to open the listbox (focus alone isn't enough)
//   - Listbox closes if the input dispatches `blur` mid-flow
//   - Workday filters on `input` events but may need a moment to render
//   - Sometimes the option you want is in the initial unfiltered list, so
//     we should look for it before typing
async function fillCombobox(inputEl: HTMLInputElement, targetValue: string): Promise<void> {
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
    return;
  }

  // Step 3: type to filter. Set value via prototype + dispatch input/change
  // ONLY (no blur — that'd close the listbox).
  setInputValueViaProto(inputEl, targetValue);
  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  inputEl.dispatchEvent(new Event('change', { bubbles: true }));

  // Step 4: give Workday up to 1.5s to filter, polling for a match.
  for (let i = 0; i < 6; i++) {
    await sleep(250);
    match = findOptionMatchInLatestListbox(targetValue);
    if (match) {
      console.log(`[WorkdayAgent] fillCombobox: clicking filtered match for "${targetValue}":`, match.textContent?.trim());
      dispatchClickSequence(match);
      return;
    }
  }

  console.log(`[WorkdayAgent] fillCombobox: no option matched "${targetValue}"`);
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
