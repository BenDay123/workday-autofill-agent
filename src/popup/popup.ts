// Popup script for WorkdayAgent
import { captureFromScan, mergeWithExisting } from '../profile/capture';
import type { ScannedField } from '../profile/capture';
import { getProfile, saveProfile } from '../profile/storage';

console.log('WorkdayAgent popup loaded');

const statusEl = document.getElementById('status');
const scanBtn = document.getElementById('scanBtn') as HTMLButtonElement | null;
const captureBtn = document.getElementById('captureBtn') as HTMLButtonElement | null;
const outputEl = document.getElementById('output') as HTMLTextAreaElement | null;

function setOutput(text: string) {
  if (!outputEl) return;
  outputEl.value = text;
  outputEl.focus();
  outputEl.select();
}

function setStatus(text: string) {
  if (statusEl) statusEl.textContent = text;
}

interface ScanResponse {
  count?: number;
  json?: string;
}

function requestScan(tabId: number): Promise<ScanResponse | null> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'SCAN_FIELDS' }, (response: ScanResponse | undefined) => {
      if (chrome.runtime.lastError) {
        console.warn('Scan failed:', chrome.runtime.lastError.message);
        resolve(null);
        return;
      }
      resolve(response ?? null);
    });
  });
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const currentTab = tabs[0];
  if (!currentTab?.url) {
    setStatus('No active tab detected.');
    return;
  }

  const isWorkday = currentTab.url.includes('myworkdayjobs.com');
  setStatus(
    isWorkday
      ? '✓ Workday page detected. Ready to assist.'
      : 'Navigate to a Workday application page to use WorkdayAgent.',
  );

  if (scanBtn) scanBtn.disabled = !isWorkday;
  if (captureBtn) captureBtn.disabled = !isWorkday;
  if (!isWorkday || currentTab.id == null) return;

  const tabId = currentTab.id;

  // ---- Scan button: dump JSON for diagnostics ----
  scanBtn?.addEventListener('click', async () => {
    scanBtn.disabled = true;
    if (captureBtn) captureBtn.disabled = true;
    setStatus('Scanning...');

    const response = await requestScan(tabId);
    scanBtn.disabled = false;
    if (captureBtn) captureBtn.disabled = false;

    if (!response) {
      setStatus('Scan failed — see console.');
      return;
    }

    const count = response.count ?? 0;
    const json = response.json ?? '';
    const trimmed = json.trim();

    if (trimmed && trimmed !== '[]') {
      setOutput(json);
      setStatus(`✓ Scanned ${count} fields. Press Ctrl+C to copy, then paste in chat.`);
      return;
    }

    if (trimmed === '[]') {
      setOutput([
        '// Scan ran successfully but found 0 form fields on this page.',
        '// Normal on Review steps, loading pages, or confirmation pages.',
      ].join('\n'));
      setStatus('Scan ran but found 0 fields.');
      return;
    }

    setOutput(`// Malformed scan response.\n${JSON.stringify(response, null, 2)}`);
    setStatus('Scan returned malformed data — see box.');
  });

  // ---- Save as Profile: scan, capture, persist ----
  captureBtn?.addEventListener('click', async () => {
    if (captureBtn) captureBtn.disabled = true;
    if (scanBtn) scanBtn.disabled = true;
    setStatus('Capturing profile...');

    const response = await requestScan(tabId);
    if (!response || !response.json) {
      setStatus('Capture failed — scan returned nothing. See console.');
      if (captureBtn) captureBtn.disabled = false;
      if (scanBtn) scanBtn.disabled = false;
      return;
    }

    let fields: ScannedField[];
    try {
      fields = JSON.parse(response.json) as ScannedField[];
    } catch (err) {
      console.error('Failed to parse scan JSON:', err);
      setStatus('Capture failed — could not parse scan. See console.');
      if (captureBtn) captureBtn.disabled = false;
      if (scanBtn) scanBtn.disabled = false;
      return;
    }

    if (!Array.isArray(fields) || fields.length === 0) {
      setStatus('Capture failed — no fields detected. Try on a populated Workday step.');
      if (captureBtn) captureBtn.disabled = false;
      if (scanBtn) scanBtn.disabled = false;
      return;
    }

    const result = captureFromScan(fields, currentTab.url);

    let merged;
    try {
      const existing = await getProfile();
      merged = mergeWithExisting(existing, result.profile, result.touchedSections);
      await saveProfile(merged);
    } catch (err) {
      console.error('saveProfile failed:', err);
      setStatus(`Save failed: ${(err as Error).message ?? 'unknown error'}`);
      if (captureBtn) captureBtn.disabled = false;
      if (scanBtn) scanBtn.disabled = false;
      return;
    }

    const sections = Array.from(result.touchedSections).join(', ') || 'none';
    setOutput(JSON.stringify(merged, null, 2));
    setStatus(
      `✓ Merged. ${result.matched} matched, ${result.unmatched} unmatched, ${result.capturedCustomAnswers} custom answers. Updated: ${sections}.`,
    );

    if (captureBtn) captureBtn.disabled = false;
    if (scanBtn) scanBtn.disabled = false;
  });
});
