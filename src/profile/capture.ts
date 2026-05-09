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
   * Top-level profile sections this capture actually touched. Used by
   * `mergeWithExisting` to selectively replace sections instead of
   * blowing away the entire profile on each capture.
   */
  touchedSections: Set<ProfileSection>;
}

export type ProfileSection =
  | 'identity'
  | 'contact'
  | 'workExperience'
  | 'education'
  | 'skills'
  | 'websites'
  | 'resume'
  | 'workAuthorization'
  | 'voluntaryDisclosures'
  | 'preferences'
  | 'customAnswers';

const KNOWN_SECTIONS: ReadonlySet<ProfileSection> = new Set([
  'identity',
  'contact',
  'workExperience',
  'education',
  'skills',
  'websites',
  'resume',
  'workAuthorization',
  'voluntaryDisclosures',
  'preferences',
  'customAnswers',
]);

function sectionFromPath(path: string): ProfileSection | null {
  // "workExperience[].jobTitle" → "workExperience"
  // "contact.address.line1"     → "contact"
  // "$dateMonth"                → null (sentinel; handled by flushBlock)
  if (path.startsWith('$')) return null;
  const head = path.split('[')[0].split('.')[0];
  return KNOWN_SECTIONS.has(head as ProfileSection)
    ? (head as ProfileSection)
    : null;
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
  const touchedSections = new Set<ProfileSection>();

  const block: BlockState = { type: null, months: [], years: [] };

  function touch(path: string): void {
    const section = sectionFromPath(path);
    if (section) touchedSections.add(section);
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
        profile.customAnswers.push({
          pattern: pattern.slice(0, 200),
          answer,
        });
        capturedCustomAnswers++;
        touchedSections.add('customAnswers');
      }
      unmatched++;
      continue;
    }

    matched++;
    const path = mapping.path;
    touch(path);

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
          (last as Record<string, unknown>)[fieldName] = value;
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
          (last as Record<string, unknown>)[fieldName] = value;
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

  return { profile, matched, unmatched, capturedCustomAnswers, touchedSections };
}

/**
 * Merge a freshly-captured profile into the existing stored profile,
 * replacing only the top-level sections that this capture actually touched.
 * If there's no existing profile, returns the captured profile as-is.
 *
 * meta.createdAt is preserved from the existing profile so we don't lose
 * the original "first capture" timestamp.
 */
export function mergeWithExisting(
  existing: UserProfile | null,
  captured: UserProfile,
  touched: Set<ProfileSection>,
): UserProfile {
  if (!existing) return captured;

  const merged: UserProfile = { ...existing };

  merged.meta = {
    ...captured.meta,
    createdAt: existing.meta.createdAt,
  };

  // Explicit per-section dispatch so TypeScript can verify shapes.
  if (touched.has('identity')) merged.identity = captured.identity;
  if (touched.has('contact')) merged.contact = captured.contact;
  if (touched.has('workExperience')) merged.workExperience = captured.workExperience;
  if (touched.has('education')) merged.education = captured.education;
  if (touched.has('skills')) merged.skills = captured.skills;
  if (touched.has('websites')) merged.websites = captured.websites;
  if (touched.has('resume')) merged.resume = captured.resume;
  if (touched.has('workAuthorization')) merged.workAuthorization = captured.workAuthorization;
  if (touched.has('voluntaryDisclosures')) merged.voluntaryDisclosures = captured.voluntaryDisclosures;
  if (touched.has('preferences')) merged.preferences = captured.preferences;
  if (touched.has('customAnswers')) merged.customAnswers = captured.customAnswers;

  return merged;
}
