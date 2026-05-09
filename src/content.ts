// WorkdayAgent — content script
// Scans the page for form fields and logs a structured report to the console.
// No filling yet; this is observability only.

interface FieldInfo {
  tagName: string;
  type: string;
  automationId: string | null;
  uxiElementId: string | null;
  ariaLabel: string | null;
  label: string | null;
  context: string | null;
  placeholder: string | null;
  value: string;
  displayText?: string | null;
  checked?: boolean;
  required: boolean;
  bestSelector: string | null;
}

const FIELD_SELECTORS = [
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"])',
  'select',
  'textarea',
  'button[aria-haspopup="listbox"]',
  '[role="combobox"]',
].join(',');

const PAGE_CHROME_SELECTOR = 'header, nav, [role="banner"], [role="navigation"]';

// Prefer scanning inside the actual form/main region. Fall back to body, but
// also exclude page chrome (header/nav) defensively in case the fallback hits.
function getScanRoot(): Element {
  return (
    document.querySelector('form') ||
    document.querySelector('[role="main"]') ||
    document.querySelector('main') ||
    document.body
  );
}

function isInPageChrome(el: Element): boolean {
  return Boolean(el.closest(PAGE_CHROME_SELECTOR));
}

// Workday pairs custom-select buttons with a sibling text input that holds the
// UUID-style internal value. Those inputs are noise for users — filter them.
function isHiddenStateInput(el: Element): boolean {
  if (el.tagName !== 'INPUT') return false;
  if (el.getAttribute('aria-hidden') === 'true') return true;

  const prev = el.previousElementSibling;
  if (prev?.matches('button[aria-haspopup="listbox"], [role="combobox"]')) {
    const id = el.getAttribute('id');
    const hasIdentifier =
      el.getAttribute('data-automation-id') ||
      el.getAttribute('data-uxi-element-id') ||
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      (id && document.querySelector(`label[for="${CSS.escape(id)}"]`));
    if (!hasIdentifier) return true;
  }
  return false;
}

function getDirectLabel(el: Element): string | null {
  const id = el.getAttribute('id');
  if (id) {
    const forLabel = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    const text = forLabel?.textContent?.trim();
    if (text) return text;
  }

  const wrapping = el.closest('label');
  const wrapText = wrapping?.textContent?.trim();
  if (wrapText) return wrapText;

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((refId) => document.getElementById(refId)?.textContent?.trim())
      .filter((s): s is string => Boolean(s));
    if (parts.length) return parts.join(' ');
  }

  return null;
}

function getRadioGroupLabel(el: Element): string | null {
  const fieldset = el.closest('fieldset');
  if (fieldset) {
    const legend = fieldset.querySelector(':scope > legend');
    const text = legend?.textContent?.trim();
    if (text) return text;
  }

  const group = el.closest('[role="radiogroup"], [role="group"]');
  if (group) {
    const labelledBy = group.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((refId) => document.getElementById(refId)?.textContent?.trim())
        .filter((s): s is string => Boolean(s));
      if (parts.length) return parts.join(' ');
    }
    const ariaLabel = group.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;
  }

  return null;
}

function getLabel(el: Element): string | null {
  const tag = el.tagName.toLowerCase();
  const type = (el as HTMLInputElement).type;

  if (tag === 'input' && type === 'radio') {
    const groupLabel = getRadioGroupLabel(el);
    const optionLabel = getDirectLabel(el) || (el as HTMLInputElement).value || null;
    if (groupLabel && optionLabel) return `${groupLabel} → ${optionLabel}`;
    return groupLabel || optionLabel;
  }

  return getDirectLabel(el);
}

// Walk up the DOM looking for nearby text that gives semantic context for
// fields whose own label is sparse or missing (e.g., Workday "Select One"
// buttons where the question text lives in a sibling/parent element).
function getContext(el: Element): string | null {
  const ownText = (el.textContent || '').trim();
  let node: Element | null = el.parentElement;
  let depth = 0;
  while (node && depth < 8) {
    const full = (node.textContent || '').trim();
    let candidate = full;
    if (ownText && candidate.includes(ownText)) {
      candidate = candidate.replace(ownText, '').trim();
    }
    candidate = candidate.replace(/\s+/g, ' ');
    if (candidate.length >= 5 && candidate.length <= 1500) {
      return candidate;
    }
    node = node.parentElement;
    depth++;
  }
  return null;
}

function bestSelectorFor(el: Element): string | null {
  const automationId = el.getAttribute('data-automation-id');
  if (automationId) return `[data-automation-id="${automationId}"]`;
  const uxiId = el.getAttribute('data-uxi-element-id');
  if (uxiId) return `[data-uxi-element-id="${uxiId}"]`;
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return `[aria-label="${ariaLabel}"]`;
  return null;
}

function getDisplayText(el: Element, tag: string): string | null | undefined {
  if (tag === 'button' && el.matches('[aria-haspopup="listbox"], [role="combobox"]')) {
    return el.textContent?.trim() || null;
  }
  if (tag === 'select') {
    const selected = (el as HTMLSelectElement).selectedOptions[0];
    return selected?.textContent?.trim() || null;
  }
  return undefined;
}

function describe(el: Element): FieldInfo {
  const tag = el.tagName.toLowerCase();
  const inputLike = el as HTMLInputElement;
  const type = el.getAttribute('type') ?? (tag === 'textarea' ? 'textarea' : tag);
  const isCheckable = tag === 'input' && (type === 'checkbox' || type === 'radio');

  const result: FieldInfo = {
    tagName: tag,
    type,
    automationId: el.getAttribute('data-automation-id'),
    uxiElementId: el.getAttribute('data-uxi-element-id'),
    ariaLabel: el.getAttribute('aria-label'),
    label: getLabel(el),
    context: getContext(el),
    placeholder: el.getAttribute('placeholder'),
    value: inputLike.value ?? '',
    required:
      el.getAttribute('aria-required') === 'true' || inputLike.required === true,
    bestSelector: bestSelectorFor(el),
  };

  // Only attach displayText/checked when they apply, so console.table doesn't
  // render `undefined` columns for fields where these don't make sense.
  const dt = getDisplayText(el, tag);
  if (dt !== undefined) result.displayText = dt;
  if (isCheckable) result.checked = inputLike.checked;

  return result;
}

function scan(): { fields: FieldInfo[]; elements: Element[] } {
  const root = getScanRoot();
  const all = Array.from(root.querySelectorAll(FIELD_SELECTORS));
  const elements = all.filter((el) => !isInPageChrome(el) && !isHiddenStateInput(el));
  const fields = elements.map(describe);
  return { fields, elements };
}

function logScan(trigger: string): { count: number; fields: FieldInfo[] } {
  const { fields, elements } = scan();

  // Stash the latest scan on window for ad-hoc DevTools inspection.
  (window as unknown as { __wa: unknown }).__wa = {
    fields,
    elements,
    trigger,
    ts: new Date().toISOString(),
  };

  console.group(
    `%c[WorkdayAgent] ${trigger} — ${fields.length} field(s) found`,
    'color: #4a90e2; font-weight: bold',
  );
  if (fields.length === 0) {
    console.log('No fields detected. Workday may still be rendering — try the "Scan & Copy" button after the form loads.');
  } else {
    console.table(fields);
    console.log('Field elements (in same order):', elements);
  }
  console.groupEnd();
  return { count: fields.length, fields };
}

console.log('[WorkdayAgent] content script loaded on', window.location.href);

// Workday is React-rendered; the form fields appear well after window 'load'.
// Use a MutationObserver with debounce to scan as soon as fields are actually
// present, instead of guessing a fixed delay.
function scheduleInitialScan(): void {
  let scanned = false;
  let debounceTimer: number | null = null;

  const tryScanNow = () => {
    if (scanned) return;
    const { fields } = scan();
    if (fields.length > 0) {
      scanned = true;
      observer.disconnect();
      if (debounceTimer != null) clearTimeout(debounceTimer);
      logScan('initial scan');
    }
  };

  const triggerDebounced = () => {
    if (scanned) return;
    if (debounceTimer != null) clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(tryScanNow, 300);
  };

  const observer = new MutationObserver(triggerDebounced);
  observer.observe(document.body, { childList: true, subtree: true });

  // Try once immediately in case the form is already rendered.
  triggerDebounced();

  // Final fallback: stop watching after 15s. If we never found fields, log
  // the empty result so the user knows the initial scan completed.
  window.setTimeout(() => {
    if (!scanned) {
      observer.disconnect();
      if (debounceTimer != null) clearTimeout(debounceTimer);
      logScan('initial scan (no fields after 15s)');
    }
  }, 15000);
}

window.addEventListener('load', scheduleInitialScan);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'SCAN_FIELDS') {
    const { count, fields } = logScan('on-demand scan');
    sendResponse({ count, json: JSON.stringify(fields, null, 2) });
  }
});
