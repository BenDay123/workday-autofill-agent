// Profile storage adapter.
//
// Reads/writes the UserProfile to chrome.storage.local. Per the v1
// architecture (CLAUDE.md), the entire profile — including the resume
// as base64 — lives in chrome.storage.local. The 5 MB quota fits a
// typical PDF resume; oversized resumes will surface as a quota error
// at write time, which is fine for v1.
//
// First-run semantics: getProfile() returns null when no profile has
// been saved. The capture-from-Workday flow is responsible for creating
// the first profile from a scan; createEmptyProfile() exists for tests
// and "force reset" scenarios.

import type { UserProfile } from './types';
import { PROFILE_SCHEMA_VERSION } from './types';

const STORAGE_KEY = 'workdayAgent.profile';

export async function getProfile(): Promise<UserProfile | null> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const stored = result[STORAGE_KEY];
  if (!stored) return null;
  return stored as UserProfile;
}

export async function saveProfile(profile: UserProfile): Promise<void> {
  const toStore: UserProfile = {
    ...profile,
    meta: {
      ...profile.meta,
      schemaVersion: PROFILE_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
    },
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: toStore });
}

export async function clearProfile(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}

export async function hasProfile(): Promise<boolean> {
  const profile = await getProfile();
  return profile !== null;
}

export function createEmptyProfile(): UserProfile {
  const now = new Date().toISOString();
  return {
    meta: {
      schemaVersion: PROFILE_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    },
    identity: {
      firstName: '',
      lastName: '',
    },
    contact: {
      email: '',
      address: {
        line1: '',
        city: '',
        state: '',
        postalCode: '',
        country: '',
      },
      phone: {
        countryCode: '',
        number: '',
        deviceType: 'Mobile',
        smsOptIn: false,
      },
    },
    workExperience: [],
    education: [],
    skills: [],
    websites: [],
    workAuthorization: {
      // null = "not captured yet" so the fill path's `value == null` guard
      // skips these legal questions until a capture writes a real answer.
      // Defaulting to `false` silently mis-filled "Are you authorized to
      // work in the US?" with No for every uncaptured user — verified
      // 2026-05-12 on Nvidia's application.
      authorizedToWorkInUS: null,
      requiresUSSponsorship: null,
      sanctionedCountryCitizenOrResident: null,
      currentOrFormerUSGovEmployee: null,
    },
    voluntaryDisclosures: {},
    preferences: {
      willingToRelocate: false,
      hasNonCompeteRestrictions: false,
    },
    customAnswers: [],
  };
}
