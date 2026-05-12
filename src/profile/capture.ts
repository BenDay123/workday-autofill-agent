// Capture-from-Workday: turn a scan of an already-populated Workday
// application into a seeded UserProfile.
//
// Runs in the popup. Receives the scanned field array, walks each field,
// looks up its profile path via mapping.findMapping, and writes into a
// fresh profile object. Returns the profile plus a small set of stats so
// the popup can show "captured N fields, M unmatched."
//
// What gets captured:
//   - Identity, contact (address + phone), websites — direct mappings
//   - Work experience and education — repeated structures grouped by
//     "starting field" boundaries (jobTitle for workExperience, school
//     for education) walked in DOM order
//   - Date inputs — paired by encounter order within a block, written
//     as start{Month,Year} / end{Month,Year}
//   - Voluntary disclosures, work authorization, preferences — direct
//     mappings, transformed by widget type (Yes/No → boolean for button
//     widgets; checked boolean for checkboxes/radios; displayText for
//     button widgets that aren't yes/no)
//
// What does NOT get captured in v1:
//   - Resume file (browsers don't expose file inputs' content for security)
//   - Email (Workday usually prefills from the user's account, doesn't
//     surface as a form field)
//   - Skills typeahead chips (the field-level scan doesn't see chips yet)
//   - Tenant-specific custom questions are routed to profile.customAnswers
//     so they're available for fill on subsequent applications.

import type { UserProfile, WorkExperience, Education } from './types';
import { findMapping } from './mapping';
import type { MappingInput } from './mapping';
import { createEmptyProfile } from './storage';

export interface ScannedField extends MappingInput {
  tagName: string;
  type: string;
  uxiElementId: string | null;
  placeholder: string | null;
  value: string;
  displayText?: string | null;
  checked?: boolean;
  required: boolean;
  bestSelector: string | null;
}

export interface CaptureResult {
  profile: UserProfile;
  matched: number;
  unmatched: number;
  capturedCustomAnswers: number;
  /**
   * Granular path identifiers this capture actually wrote. Used by
   * `mergeWithExisting` to merge per-path into an existing profile
   * instead of replacing whole top-level sections (which would let
   * `createEmptyProfile` defaults overwrite previously-captured values
   * for fields not rendered on the current Workday step).
   *
   * Path forms:
   *   - Object leaf path: `"identity.firstName"`,
   *     `"contact.address.line1"`, `"preferences.preferredSource"`,
   *     `"voluntaryDisclosures.gender"`. Merged by deep-set of that one
   *     leaf into the existing profile.
   *   - Array-section marker (all-or-nothing replace):
   *     `"workExperience[]"`, `"education[]"`, `"skills[]"`,
   *     `"resume"`.
   *   - Keyed array entry (replace/append by key):
   *     `"websites[label=LinkedIn]"`,
   *     `"customAnswers[pattern=Have you previously...?]"`.
   */
  touchedPaths: Set<string>;
}

/**
 * Convert a mapping path (or sentinel) into the touched-path identifier
 * we record for later merge. Returns null for sentinels and skills (which
 * capture currently doesn't write).
 */
function touchedPathFor(path: string): string | null {
  if (path.startsWith('$')) return null;

  // Array sections — collapse to a single section marker. Capture writes
  // these as whole arrays per step, so merge replaces all-or-nothing.
  if (path.startsWith('workExperience[].') || path === 'workExperience[]') {
    return 'workExperience[]';
  }
  if (path.startsWith('education[].') || path === 'education[]') {
    return 'education[]';
  }
  if (path === 'skills') return 'skills[]';
  if (path === 'resume') return 'resume';

  // Keyed website entry: websites[label=X].url → websites[label=X]
  const websiteMatch = path.match(/^(websites\[label=[^\]]+\])\.url$/);
  if (websiteMatch) return websiteMatch[1];

  // Plain dotted leaf path — record as-is.
  return path;
}

/** Read the user-meaningful value from a scanned field. */
function readValue(field: ScannedField): string | boolean | '' {
  // Checkboxes and radios: use the `checked` boolean.
  if (field.tagName === 'input' && (field.type === 'checkbox' || field.type === 'radio')) {
    return field.checked ?? false;
  }

  // Button widgets (paired-button selects). DisplayText carries the
  // user-visible label. Yes/No transforms to boolean.
  if (field.tagName === 'button' && field.displayText != null) {
    if (field.displayText === 'Yes') return true;
    if (field.displayText === 'No') return false;
    // "Select One" means unanswered.
    if (field.displayText === 'Select One') return '';
    return field.displayText;
  }

  // Combobox typeahead. Workday surfaces the current selection as
  // "1 item selected, [label]" in the parent element's textContent,
  // which our scanner picked up as `context`.
  if (field.context && field.context.startsWith('1 item selected, ')) {
    return field.context.replace(/^1 item selected,\s*/, '');
  }

  return field.value || '';
}

/** Set a value at a dotted path on a target object, creating intermediate objects as needed. */
function setByPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (cursor[key] == null || typeof cursor[key] !== 'object') {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

interface BlockState {
  type: 'workExperience' | 'education' | null;
  months: number[];
  years: number[];
}

function flushBlock(profile: UserProfile, block: BlockState): void {
  if (block.type === 'workExperience') {
    const last = profile.workExperience[profile.workExperience.length - 1];
    if (last) {
      if (block.months[0] != null) last.startMonth = block.months[0];
      if (block.years[0] != null) last.startYear = block.years[0];
      if (block.months[1] != null) last.endMonth = block.months[1];
      if (block.years[1] != null) last.endYear = block.years[1];
    }
  } else if (block.type === 'education') {
    const last = profile.education[profile.education.length - 1];
    if (last) {
      // Education uses years; ignore months for now (most Workday education
      // forms only ask for years).
      if (block.years[0] != null) last.startYear = block.years[0];
      if (block.years[1] != null) last.endYear = block.years[1];
    }
  }
  block.months = [];
  block.years = [];
}

export function captureFromScan(
  fields: ScannedField[],
  sourceUrl?: string,
): CaptureResult {
  const now = new Date().toISOString();
  const profile = createEmptyProfile();
  profile.meta.lastSeededFromWorkdayUrl = sourceUrl;
  profile.meta.lastSeededAt = now;

  let matched = 0;
  let unmatched = 0;
  let capturedCustomAnswers = 0;
  const touchedPaths = new Set<string>();

  const block: BlockState = { type: null, months: [], years: [] };

  function touch(path: string): void {
    const id = touchedPathFor(path);
    if (id) touchedPaths.add(id);
  }

  for (const field of fields) {
    const mapping = findMapping(field);
    const value = readValue(field);

    if (!mapping) {
      // Unmapped — try to record as a custom answer if it has meaningful content.
      if (field.tagName === 'input' && field.type === 'radio' && field.checked === false) {
        // Skip unchecked radios; only the checked option is the "answer".
        unmatched++;
        continue;
      }
      if (value === '' || value === false) {
        unmatched++;
        continue;
      }

      // Prefer label (often has "Question → Option" form for radios), then
      // context, then ariaLabel. For radios where the label encodes
      // "{question} → {option}", split so the pattern is the question and
      // the answer is the option label.
      let pattern = field.label || field.context || field.ariaLabel || '';
      let answer: string | boolean = value;
      if (
        field.tagName === 'input' &&
        field.type === 'radio' &&
        field.label &&
        field.label.includes(' → ')
      ) {
        const idx = field.label.lastIndexOf(' → ');
        pattern = field.label.slice(0, idx).trim();
        answer = field.label.slice(idx + 3).trim();
      }

      if (pattern) {
        // Skip patterns that look like date values rather than question
        // text. Workday date-picker inputs sometimes carry the rendered
        // date as aria-label, producing junk customAnswers keyed by date
        // (e.g., pattern "05/12/2026", answer "12"). Future applications
        // would never re-match these. Verified live 2026-05-12 on
        // Nvidia's Self-Identify of Disability step.
        if (/^\s*\d{1,4}[\/\-.]\d{1,4}([\/\-.]\d{1,4})?\s*$/.test(pattern)) {
          unmatched++;
          continue;
        }
        const trimmedPattern = pattern.slice(0, 200);
        profile.customAnswers.push({
          pattern: trimmedPattern,
          answer,
        });
        capturedCustomAnswers++;
        touchedPaths.add(`customAnswers[pattern=${trimmedPattern}]`);
      }
      unmatched++;
      continue;
    }

    matched++;
    const path = mapping.path;
    touch(path);

    // Voluntary-disclosures radios: prefer the option text from
    // "Question → Option" labels over the raw `checked` boolean readValue
    // returns. The disabilityStatus / raceEthnicity / veteranStatus
    // schema slots are typed as string — without this special-case,
    // capture wrote `false`/`true` into string fields. Verified live
    // 2026-05-12 on Nvidia's Self-Identify of Disability step.
    if (
      path.startsWith('voluntaryDisclosures.') &&
      field.tagName === 'input' &&
      field.type === 'radio' &&
      field.label &&
      field.label.includes(' → ')
    ) {
      if (field.checked === true) {
        const idx = field.label.lastIndexOf(' → ');
        const optionLabel = field.label.slice(idx + 3).trim();
        setByPath(profile as unknown as Record<string, unknown>, path, optionLabel);
      }
      // Unchecked radios in the group don't contribute — the matched
      // one above carries the answer for the whole question.
      continue;
    }

    // Date sentinels: collected per block, flushed at block boundaries.
    // The block's section (workExperience or education) is touched when
    // its starting field (jobTitle or school) is processed, so sentinels
    // don't need explicit section tracking.
    if (path === '$dateMonth') {
      const m = parseInt(String(value), 10);
      if (!isNaN(m)) block.months.push(m);
      continue;
    }
    if (path === '$dateYear') {
      const y = parseInt(String(value), 10);
      if (!isNaN(y)) block.years.push(y);
      continue;
    }

    // workExperience[] — jobTitle starts a new block.
    if (path.startsWith('workExperience[].')) {
      const fieldName = path.slice('workExperience[].'.length);
      if (fieldName === 'jobTitle') {
        flushBlock(profile, block);
        block.type = 'workExperience';
        const newEntry: WorkExperience = {
          jobTitle: String(value || ''),
          company: '',
          startMonth: 1,
          startYear: 1900,
          currentlyHere: false,
        };
        profile.workExperience.push(newEntry);
      } else {
        const last = profile.workExperience[profile.workExperience.length - 1];
        if (last) {
          (last as unknown as Record<string, unknown>)[fieldName] = value;
        }
      }
      continue;
    }

    // education[] — school starts a new block.
    if (path.startsWith('education[].')) {
      const fieldName = path.slice('education[].'.length);
      if (fieldName === 'school') {
        flushBlock(profile, block);
        block.type = 'education';
        const newEntry: Education = {
          school: String(value || ''),
        };
        profile.education.push(newEntry);
      } else {
        const last = profile.education[profile.education.length - 1];
        if (last) {
          (last as unknown as Record<string, unknown>)[fieldName] = value;
        }
      }
      continue;
    }

    // Skills typeahead — chips aren't visible to scan yet, skip.
    if (path === 'skills') continue;

    // websites[label=X].url — find or create entry by label.
    const websiteMatch = path.match(/^websites\[label=([^\]]+)\]\.url$/);
    if (websiteMatch) {
      const label = websiteMatch[1];
      const url = String(value || '');
      if (url) {
        const existing = profile.websites.find((w) => w.label === label);
        if (existing) {
          existing.url = url;
        } else {
          profile.websites.push({ label, url });
        }
      }
      continue;
    }

    // Plain dotted path — write directly.
    // Skip empty values for boolean-typed paths to avoid writing '' where
    // schema expects boolean.
    if (value === '') continue;
    setByPath(profile as unknown as Record<string, unknown>, path, value);
  }

  // Flush the last block.
  flushBlock(profile, block);

  return { profile, matched, unmatched, capturedCustomAnswers, touchedPaths };
}

/**
 * Merge a freshly-captured profile into the existing stored profile,
 * applying only the paths this capture actually wrote. If there's no
 * existing profile, returns the captured profile as-is.
 *
 * Per-path semantics (see CaptureResult.touchedPaths for the path forms):
 *   - Object leaf path: deep-set just that one leaf in the existing
 *     profile. Avoids `createEmptyProfile` defaults overwriting fields
 *     that weren't on the current Workday step.
 *   - Array-section marker: replace the entire array (or set the whole
 *     resume blob) — these don't merge sensibly per-element across
 *     captures.
 *   - Keyed array entry: find an entry with the same key in the existing
 *     array; replace it if found, otherwise append.
 *
 * meta.createdAt is preserved from the existing profile so we don't lose
 * the original "first capture" timestamp.
 */
export function mergeWithExisting(
  existing: UserProfile | null,
  captured: UserProfile,
  touched: Set<string>,
): UserProfile {
  if (!existing) return captured;

  // Deep clone so we don't mutate the stored object.
  const merged: UserProfile = JSON.parse(JSON.stringify(existing));

  merged.meta = {
    ...captured.meta,
    createdAt: existing.meta.createdAt,
  };

  for (const path of touched) {
    applyTouchedPath(merged, captured, path);
  }

  return merged;
}

function applyTouchedPath(
  merged: UserProfile,
  captured: UserProfile,
  path: string,
): void {
  // Array sections — replace whole array / blob.
  if (path === 'workExperience[]') {
    merged.workExperience = captured.workExperience;
    return;
  }
  if (path === 'education[]') {
    merged.education = captured.education;
    return;
  }
  if (path === 'skills[]') {
    merged.skills = captured.skills;
    return;
  }
  if (path === 'resume') {
    merged.resume = captured.resume;
    return;
  }

  // Keyed websites: websites[label=X]
  const websiteMatch = path.match(/^websites\[label=([^\]]+)\]$/);
  if (websiteMatch) {
    const label = websiteMatch[1];
    const capturedEntry = captured.websites.find((w) => w.label === label);
    if (!capturedEntry) return;
    const idx = merged.websites.findIndex((w) => w.label === label);
    if (idx >= 0) merged.websites[idx] = capturedEntry;
    else merged.websites.push(capturedEntry);
    return;
  }

  // Keyed customAnswers: customAnswers[pattern=X]
  const customAnswerMatch = path.match(/^customAnswers\[pattern=(.+)\]$/);
  if (customAnswerMatch) {
    const pattern = customAnswerMatch[1];
    const capturedEntry = captured.customAnswers.find((a) => a.pattern === pattern);
    if (!capturedEntry) return;
    const idx = merged.customAnswers.findIndex((a) => a.pattern === pattern);
    if (idx >= 0) merged.customAnswers[idx] = capturedEntry;
    else merged.customAnswers.push(capturedEntry);
    return;
  }

  // Plain dotted leaf path — copy that one value from captured into merged.
  const value = getByPath(captured as unknown as Record<string, unknown>, path);
  if (value === undefined) return;
  setByPath(merged as unknown as Record<string, unknown>, path, value);
}

function getByPath(target: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cursor: unknown = target;
  for (const key of parts) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}
