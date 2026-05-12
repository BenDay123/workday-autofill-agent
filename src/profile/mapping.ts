// Field mapping config — Workday field → profile path.
//
// The fill logic walks scanned fields, asks `findMapping` for each one, and
// uses the resulting `path` to read/write a value in the UserProfile.
//
// Pattern matching is by signals: each mapping has one or more signals, and
// matches if ANY signal matches the field. Each signal can constrain by
// label, context, automationId, ariaLabel, or `text` (which matches against
// either label OR context — convenient for fields where the meaning lives
// in different places across renderings).
//
// Path notation:
//   - Plain dotted path: `identity.firstName`, `contact.address.city`
//   - Bracketed-empty for indexed repeated entries: `workExperience[].jobTitle`
//     means "list at workExperience, current index supplied at fill time"
//   - `websites[label=X].url` for keyed lookup in a list
//   - `$dateMonth` / `$dateYear` are sentinels: a workExperience or education
//     block has multiple date inputs (start month/year, optionally end
//     month/year), all sharing the same automationId. Fill logic walks them
//     in DOM order and assigns to startMonth / startYear / endMonth / endYear.
//
// Transformers (e.g., "Yes"/"No" → boolean) are NOT in the mapping; fill
// logic handles them per widget type.
//
// Patterns that aren't matched here fall through to customAnswers — those
// are Workday-tenant-specific or company-specific Q&A handled separately.

export interface FieldSignal {
  /** Substring or regex match against the field's `label`. */
  label?: string | RegExp;
  /** Substring or regex match against the field's `context`. */
  context?: string | RegExp;
  /** Match against either `label` or `context`. */
  text?: string | RegExp;
  /** Exact match against `data-automation-id`. */
  automationId?: string;
  /** Substring or regex match against `aria-label`. */
  ariaLabel?: string | RegExp;
}

export interface FieldMapping {
  /** Mapping matches the field if ANY signal matches. */
  signals: FieldSignal[];
  /** Where this field's value lives in the profile. */
  path: string;
}

/** Subset of FieldInfo needed for mapping lookup. */
export interface MappingInput {
  label: string | null;
  context: string | null;
  automationId: string | null;
  ariaLabel: string | null;
}

function matchString(haystack: string | null, needle: string | RegExp): boolean {
  if (haystack == null) return false;
  if (needle instanceof RegExp) return needle.test(haystack);
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function matchSignal(field: MappingInput, signal: FieldSignal): boolean {
  if (signal.label != null && !matchString(field.label, signal.label)) return false;
  if (signal.context != null && !matchString(field.context, signal.context)) return false;
  if (signal.text != null) {
    const labelHit = matchString(field.label, signal.text);
    const contextHit = matchString(field.context, signal.text);
    if (!labelHit && !contextHit) return false;
  }
  if (signal.automationId != null && field.automationId !== signal.automationId) return false;
  if (signal.ariaLabel != null && !matchString(field.ariaLabel, signal.ariaLabel)) return false;
  return true;
}

export function findMapping(field: MappingInput): FieldMapping | null {
  for (const m of FIELD_MAPPINGS) {
    if (m.signals.some((s) => matchSignal(field, s))) return m;
  }
  return null;
}

// ----- Mappings -----
//
// Order matters: the first match wins. More specific patterns should appear
// before more generic ones (e.g., "Country / Territory Phone Code" before
// the bare "Country / Territory").

export const FIELD_MAPPINGS: FieldMapping[] = [
  // ---- Identity ----
  { signals: [{ label: 'First Name' }], path: 'identity.firstName' },
  { signals: [{ label: 'Middle Name' }], path: 'identity.middleName' },
  { signals: [{ label: 'Last Name' }], path: 'identity.lastName' },
  // Anchored so it doesn't match the "I have a preferred name" toggle checkbox.
  { signals: [{ label: /^preferred (first |middle |last )?name/i }], path: 'identity.preferredName' },
  { signals: [{ label: 'Pronouns' }], path: 'identity.pronouns' },

  // The "I have a preferred name" toggle gates the Preferred Name input.
  // No profile field needed; fill logic infers from `identity.preferredName` presence.

  // ---- Contact ----
  { signals: [{ label: /^email/i }], path: 'contact.email' },

  // Address. Phone-Code Country comes BEFORE bare Country / Territory
  // because the bare one would otherwise match the phone-code field first.
  { signals: [{ label: /phone code/i }], path: 'contact.phone.countryCode' },
  { signals: [{ label: /^country/i }], path: 'contact.address.country' },
  { signals: [{ label: 'Address Line 1' }], path: 'contact.address.line1' },
  { signals: [{ label: 'Address Line 2' }], path: 'contact.address.line2' },
  // Word-boundary anchored so it doesn't match "Ethnicity" via substring
  // (matchString uses .includes() for plain strings — "ethni-city" contains
  // "city"). Verified live 2026-05-12 on Nvidia's Voluntary Disclosures
  // step where the Race/Ethnicity button stole the City fill of "Medina".
  { signals: [{ label: /\bCity\b/i }], path: 'contact.address.city' },
  { signals: [{ label: 'State' }], path: 'contact.address.state' },
  { signals: [{ label: 'Postal Code' }, { label: 'Zip Code' }], path: 'contact.address.postalCode' },

  // ---- Phone ----
  { signals: [{ label: 'Phone Device Type' }], path: 'contact.phone.deviceType' },
  { signals: [{ label: 'Phone Number' }], path: 'contact.phone.number' },
  { signals: [{ label: 'Phone Extension' }, { label: 'Extension' }], path: 'contact.phone.extension' },
  { signals: [{ automationId: 'phone-sms-opt-in' }], path: 'contact.phone.smsOptIn' },

  // ---- Work Experience ----
  { signals: [{ label: 'Job Title' }], path: 'workExperience[].jobTitle' },
  { signals: [{ label: 'Company' }], path: 'workExperience[].company' },
  { signals: [{ label: 'Location' }], path: 'workExperience[].location' },
  { signals: [{ label: 'I currently work here' }], path: 'workExperience[].currentlyHere' },
  { signals: [{ label: 'Role Description' }, { label: 'Description' }], path: 'workExperience[].description' },

  // ---- Education ----
  { signals: [{ label: 'School or University' }, { label: 'School' }], path: 'education[].school' },
  { signals: [{ label: 'Degree' }], path: 'education[].degree' },
  { signals: [{ label: 'Field of Study' }, { label: 'Major' }], path: 'education[].fieldOfStudy' },
  { signals: [{ label: 'GPA' }], path: 'education[].gpa' },

  // ---- Skills ----
  { signals: [{ label: 'Type to Add Skills' }, { label: 'Skills' }], path: 'skills' },

  // ---- Websites ----
  // Workday's generic URL field uses `label: "URL"`; specific platforms get
  // their own labels (LinkedIn, Twitter, etc.). Fill logic looks up the
  // matching website entry by label.
  { signals: [{ label: 'LinkedIn' }], path: 'websites[label=LinkedIn].url' },
  { signals: [{ label: 'GitHub' }], path: 'websites[label=GitHub].url' },
  { signals: [{ label: 'Portfolio' }], path: 'websites[label=Portfolio].url' },
  { signals: [{ label: 'Twitter' }, { label: 'X.com' }], path: 'websites[label=Twitter].url' },
  // Generic URL — must come last so it doesn't shadow the labeled ones.
  { signals: [{ label: /^url\*?$/i }], path: 'websites[label=URL].url' },

  // ---- Date inputs (work experience and education share the same
  // automationIds; fill logic dispatches based on the surrounding block). ----
  { signals: [{ automationId: 'dateSectionMonth-input' }], path: '$dateMonth' },
  { signals: [{ automationId: 'dateSectionYear-input' }], path: '$dateYear' },

  // ---- Source / How Did You Hear About Us ----
  { signals: [{ label: /how did you hear/i }], path: 'preferences.preferredSource' },

  // ---- Application Questions ----
  // These are semantic matches against the question text in `context`
  // (button widgets show "Select One" until answered, so context is the
  // only signal). Patterns are intentionally loose.
  {
    signals: [{ text: /relocat/i }],
    path: 'preferences.willingToRelocate',
  },
  {
    signals: [{ text: /non-compete|non.solicitation/i }],
    path: 'preferences.hasNonCompeteRestrictions',
  },
  {
    signals: [{ text: /authorized to work/i }],
    path: 'workAuthorization.authorizedToWorkInUS',
  },
  {
    signals: [{ text: /visa sponsorship|require any immigration/i }],
    path: 'workAuthorization.requiresUSSponsorship',
  },
  {
    signals: [{ text: /(united states|u\.?s\.?) government/i }],
    path: 'workAuthorization.currentOrFormerUSGovEmployee',
  },
  {
    signals: [{ text: /iran|cuba|north korea|syria|crimea|sanctioned|export control/i }],
    path: 'workAuthorization.sanctionedCountryCitizenOrResident',
  },

  // ---- Voluntary Disclosures (EEO) ----
  // Workday tenants use varying labels; patterns cover the common ones.
  { signals: [{ label: 'Gender' }, { label: 'Sex' }], path: 'voluntaryDisclosures.gender' },
  {
    signals: [{ text: /hispanic.*latino/i }],
    path: 'voluntaryDisclosures.hispanicOrLatino',
  },
  {
    signals: [{ label: /race|ethnicity/i }],
    path: 'voluntaryDisclosures.raceEthnicity',
  },
  {
    signals: [{ text: /veteran/i }],
    path: 'voluntaryDisclosures.veteranStatus',
  },
  {
    signals: [{ text: /disability/i }],
    path: 'voluntaryDisclosures.disabilityStatus',
  },
  {
    // Workday's recruitment-policy / VIBE Philosophy acknowledgment.
    signals: [
      { text: /privacy statement/i },
      { text: /vibe philosophy/i },
      { text: /recruitment privacy/i },
    ],
    path: 'voluntaryDisclosures.acknowledgedRecruitmentPolicy',
  },
];
