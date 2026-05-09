// Profile data model for WorkdayAgent.
// Designed against the field set observed across 5 steps of a real
// Workday application (76 fields). See JOURNAL.md 2026-05-09 for the
// survey results that informed this schema.
//
// v1 architectural rules (see CLAUDE.md):
//   - Capture-from-Workday: profile is seeded by reading an already-filled
//     Workday application, not via a separate options UI.
//   - Storage: chrome.storage.local for the profile object; resume stays
//     embedded as base64 inside the profile for v1 (chrome.storage.local
//     has a 5MB quota — enough for a typical PDF).
//   - Auto-fill scope: every field, including voluntary disclosures.
//   - Mapping: hardcoded label-pattern matchers (separate file).
//   - Repeated entries: flat detection + fill-time index-based matching.

export const PROFILE_SCHEMA_VERSION = 1;

export interface UserProfile {
  meta: ProfileMeta;

  identity: Identity;
  contact: Contact;

  workExperience: WorkExperience[];
  education: Education[];
  skills: string[];
  websites: Website[];
  resume?: ResumeData;

  workAuthorization: WorkAuthorization;
  voluntaryDisclosures: VoluntaryDisclosures;
  preferences: Preferences;

  customAnswers: CustomAnswer[];
}

export interface ProfileMeta {
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  lastSeededFromWorkdayUrl?: string;
  lastSeededAt?: string;
}

export interface Identity {
  firstName: string;
  middleName?: string;
  lastName: string;
  preferredName?: string;
  pronouns?: string;
}

export interface Contact {
  email: string;
  alternateEmails?: string[];
  address: Address;
  phone: Phone;
}

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  // Stored as Workday renders the label ("Washington") so fill logic can
  // match it against the Country/State button widget's `displayText`.
  state: string;
  postalCode: string;
  country: string;
}

export interface Phone {
  countryCode: string;
  number: string;
  extension?: string;
  deviceType: PhoneDeviceType;
  smsOptIn: boolean;
}

export type PhoneDeviceType = 'Mobile' | 'Home' | 'Work' | 'Fax' | 'Pager';

export interface WorkExperience {
  jobTitle: string;
  company: string;
  location?: string;
  startMonth: number;
  startYear: number;
  endMonth?: number;
  endYear?: number;
  currentlyHere: boolean;
  description?: string;
}

export interface Education {
  school: string;
  degree?: string;
  fieldOfStudy?: string;
  startYear?: number;
  endYear?: number;
  gpa?: number;
}

export interface Website {
  // "LinkedIn", "Portfolio", "GitHub", or "URL" (Workday's generic field).
  label: string;
  url: string;
}

export interface ResumeData {
  filename: string;
  mimeType: string;
  base64: string;
  uploadedAt: string;
}

// Factual / legal disclosures, US-centric for v1. Non-US work auth is v2.
export interface WorkAuthorization {
  authorizedToWorkInUS: boolean;
  requiresUSSponsorship: boolean;
  // US export-control disclosure: citizen/national/resident of any
  // sanctioned region (Iran, Cuba, North Korea, Syria, Crimea, DNR, LNR).
  sanctionedCountryCitizenOrResident: boolean;
  // Anti-corruption disclosure.
  currentOrFormerUSGovEmployee: boolean;
}

// EEO self-identification. Tenant labels vary; values store as whatever
// label the user's source Workday application presented, so fill logic
// can match against the rendered listbox options exactly.
export interface VoluntaryDisclosures {
  gender?: string;
  // Some tenants ask Hispanic/Latino as a separate yes/no from race.
  hispanicOrLatino?: boolean;
  raceEthnicity?: string[];
  veteranStatus?: string;
  disabilityStatus?: string;
  acknowledgedRecruitmentPolicy?: boolean;
}

// User preferences and common employer-relationship facts that aren't
// strictly compliance-coded.
export interface Preferences {
  willingToRelocate: boolean;
  hasNonCompeteRestrictions: boolean;
  preferredSource?: string;
}

// Application-specific Q&A that doesn't fit any canonical category
// (e.g., company-specific questions like "Have you previously worked
// for Workday?"). The pattern is matched against a field's label or
// context using a substring/regex check at fill time.
export interface CustomAnswer {
  pattern: string;
  answer: string | boolean;
  note?: string;
}
