// Main-world injected script for WorkdayAgent v2.
//
// Runs in the PAGE'S OWN JS world (not the content-script isolated world)
// so it can see React's runtime objects — fibers, props, internal
// handlers — for widgets the content script can't drive via synthetic
// DOM events (Workday's combobox typeaheads, primarily).
//
// Communicates with the content script via `window.postMessage`,
// filtered by `MESSAGE_NAMESPACE` so unrelated page traffic is ignored.
//
// First-run behavior is intentionally diagnostic-heavy. We don't yet
// know the exact handler name Workday's combobox uses (could be
// `onChange`, `onFilter`, `onSearch`, `onInputChange`, or a Workday-
// internal name). The `fiber-inspect` request type lets the content
// script ask "what's on this element?" and dump every onXxx prop seen
// across ancestor fibers, so we can pick the right one. After we have
// real data, the handler-name allowlist below gets pruned and the
// combobox-fill path becomes the workhorse.
//
// IMPORTANT: this file must never import chrome.* APIs. It runs in the
// page world. Only imports allowed: type-only imports from protocol.ts.

import type {
  ComboboxFillRequest,
  ComboboxFillResponse,
  FiberInspectRequest,
  FiberInspectResponse,
  WARequest,
} from './protocol';
import { MESSAGE_NAMESPACE, isWAMessage } from './protocol';

// ---- Constants ----

/** Bounded ancestor walk so we never loop on cycles (shouldn't happen,
 *  but be defensive). */
const MAX_FIBER_DEPTH = 30;

/** Likely React-handler prop names to look for when walking up the
 *  fiber chain for a combobox. The actual name in Workday's case is
 *  unknown until first live spike — see fiber-inspect path. Order
 *  matters: first match wins. */
const CANDIDATE_HANDLER_NAMES = [
  'onChange',
  'onInputChange',
  'onFilterChange',
  'onSearch',
  'onSearchChange',
  'onQueryChange',
  'onFilter',
  'onValueChange',
  'onSelect',
  'onOptionSelect',
];

// ---- Boot ----

console.log(
  `[WorkdayAgent main-world] injected on ${location.href} (build: v0.0.10-scaffold)`,
);

window.addEventListener('message', onMessage);

function onMessage(event: MessageEvent): void {
  // Tight filter: same window, namespaced payload.
  if (event.source !== window) return;
  if (!isWAMessage(event.data)) return;
  const msg = event.data as WARequest;

  try {
    if (msg.kind === 'fiber-inspect') {
      handleFiberInspect(msg);
      return;
    }
    if (msg.kind === 'combobox-fill') {
      handleComboboxFill(msg);
      return;
    }
  } catch (err) {
    console.error('[WorkdayAgent main-world] unexpected handler error:', err);
  }
}

// ---- Fiber-inspect: pure diagnostic, no DOM mutation ----

function handleFiberInspect(req: FiberInspectRequest): void {
  const el = document.querySelector(req.selector);
  if (!el) {
    respond<FiberInspectResponse>({
      namespace: MESSAGE_NAMESPACE,
      kind: 'fiber-inspect-response',
      id: req.id,
      fiberFound: false,
      ancestors: [],
      errorMessage: `no element matches selector ${req.selector}`,
    });
    return;
  }

  const fiberKey = findFiberKey(el);
  if (!fiberKey) {
    respond<FiberInspectResponse>({
      namespace: MESSAGE_NAMESPACE,
      kind: 'fiber-inspect-response',
      id: req.id,
      fiberFound: false,
      ancestors: [],
      errorMessage: 'no __reactFiber$* key on element',
    });
    return;
  }

  const fiber = (el as unknown as Record<string, unknown>)[fiberKey] as Fiber | null;
  const ancestors: FiberInspectResponse['ancestors'] = [];
  let current: Fiber | null = fiber;
  let depth = 0;
  while (current && depth < MAX_FIBER_DEPTH) {
    const props = getProps(current);
    const handlerNames = Object.keys(props).filter((k) => {
      if (!k.startsWith('on')) return false;
      return typeof props[k] === 'function';
    });
    ancestors.push({
      depth,
      typeName: typeName(current),
      handlerPropNames: handlerNames,
    });
    current = current.return ?? null;
    depth++;
  }

  respond<FiberInspectResponse>({
    namespace: MESSAGE_NAMESPACE,
    kind: 'fiber-inspect-response',
    id: req.id,
    fiberFound: true,
    fiberKey,
    ancestors,
  });
}

// ---- Combobox-fill: actual write path ----

function handleComboboxFill(req: ComboboxFillRequest): void {
  const el = document.querySelector(req.selector) as HTMLInputElement | null;
  if (!el) {
    respond<ComboboxFillResponse>({
      namespace: MESSAGE_NAMESPACE,
      kind: 'combobox-fill-response',
      id: req.id,
      status: 'no-element',
      diagnostics: { fiberFound: false, errorMessage: `selector ${req.selector} resolved to no element` },
    });
    return;
  }

  const fiberKey = findFiberKey(el);
  if (!fiberKey) {
    respond<ComboboxFillResponse>({
      namespace: MESSAGE_NAMESPACE,
      kind: 'combobox-fill-response',
      id: req.id,
      status: 'no-fiber',
      diagnostics: { fiberFound: false, errorMessage: 'no __reactFiber$* key on element' },
    });
    return;
  }

  // Walk up looking for an ancestor whose props expose a callable handler
  // matching the allowlist.
  const fiber = (el as unknown as Record<string, unknown>)[fiberKey] as Fiber | null;
  let owner: Fiber | null = null;
  let handlerName: string | undefined;
  let handler: ((...args: unknown[]) => unknown) | undefined;
  let depth = 0;
  let current: Fiber | null = fiber;
  while (current && depth < MAX_FIBER_DEPTH) {
    const props = getProps(current);
    for (const name of CANDIDATE_HANDLER_NAMES) {
      const candidate = props[name];
      if (typeof candidate === 'function') {
        owner = current;
        handlerName = name;
        handler = candidate as (...args: unknown[]) => unknown;
        break;
      }
    }
    if (handler) break;
    current = current.return ?? null;
    depth++;
  }

  if (!handler || !handlerName) {
    respond<ComboboxFillResponse>({
      namespace: MESSAGE_NAMESPACE,
      kind: 'combobox-fill-response',
      id: req.id,
      status: 'no-handler',
      diagnostics: {
        fiberFound: true,
        errorMessage:
          'walked fiber tree but no ancestor exposes any of the candidate handler names; rerun fiber-inspect for this element to extend the allowlist',
      },
    });
    return;
  }

  // Set the input's value via the native prototype setter and invoke the
  // handler with a synthetic event whose target is the live element.
  // The native setter trick bypasses React's per-instance value tracker
  // so React's internal onChange registers the new value.
  try {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, req.targetValue);
    else el.value = req.targetValue;
  } catch (err) {
    respond<ComboboxFillResponse>({
      namespace: MESSAGE_NAMESPACE,
      kind: 'combobox-fill-response',
      id: req.id,
      status: 'error',
      diagnostics: {
        fiberFound: true,
        handlerPropName: handlerName,
        handlerOwnerDepth: depth,
        errorMessage: `setter call failed: ${(err as Error).message ?? String(err)}`,
      },
    });
    return;
  }

  const syntheticEvent: SyntheticChangeEvent = {
    target: el,
    currentTarget: el,
    type: 'change',
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    preventDefault() {},
    stopPropagation() {},
    persist() {},
    nativeEvent: new Event('change', { bubbles: true }),
  };

  try {
    handler(syntheticEvent);
  } catch (err) {
    respond<ComboboxFillResponse>({
      namespace: MESSAGE_NAMESPACE,
      kind: 'combobox-fill-response',
      id: req.id,
      status: 'error',
      diagnostics: {
        fiberFound: true,
        handlerPropName: handlerName,
        handlerOwnerDepth: depth,
        errorMessage: `handler invocation threw: ${(err as Error).message ?? String(err)}`,
      },
    });
    return;
  }

  // Give the React filter a moment to render, then scan the latest
  // listbox for matches against any search variant.
  void owner; // silence unused — we'll need it for hierarchical phase 6b
  setTimeout(() => {
    const matchResult = findOptionMatch(req.searchVariants);
    if (matchResult.option) {
      dispatchClickSequence(matchResult.option);
      respond<ComboboxFillResponse>({
        namespace: MESSAGE_NAMESPACE,
        kind: 'combobox-fill-response',
        id: req.id,
        status: 'filled',
        diagnostics: {
          fiberFound: true,
          handlerPropName: handlerName,
          handlerOwnerDepth: depth,
          optionsSeen: matchResult.optionsSeen,
          chosenOption: matchResult.option.textContent?.trim() ?? '',
        },
      });
    } else {
      respond<ComboboxFillResponse>({
        namespace: MESSAGE_NAMESPACE,
        kind: 'combobox-fill-response',
        id: req.id,
        status: 'no-match',
        diagnostics: {
          fiberFound: true,
          handlerPropName: handlerName,
          handlerOwnerDepth: depth,
          optionsSeen: matchResult.optionsSeen,
        },
      });
    }
  }, 300);
}

// ---- Fiber utilities ----

interface Fiber {
  return?: Fiber | null;
  stateNode?: unknown;
  type?: unknown;
  memoizedProps?: Record<string, unknown> | null;
  pendingProps?: Record<string, unknown> | null;
}

interface SyntheticChangeEvent {
  target: HTMLInputElement;
  currentTarget: HTMLInputElement;
  type: 'change';
  bubbles: true;
  cancelable: true;
  defaultPrevented: false;
  preventDefault(): void;
  stopPropagation(): void;
  persist(): void;
  nativeEvent: Event;
}

function findFiberKey(el: Element): string | undefined {
  return Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
}

function getProps(fiber: Fiber): Record<string, unknown> {
  return fiber.memoizedProps ?? fiber.pendingProps ?? {};
}

function typeName(fiber: Fiber): string {
  const t = fiber.type;
  if (typeof t === 'string') return t;
  if (typeof t === 'function') return (t as { displayName?: string; name?: string }).displayName ?? (t as { name?: string }).name ?? 'Anonymous';
  if (t && typeof t === 'object') {
    const obj = t as { displayName?: string; render?: { displayName?: string; name?: string } };
    if (obj.displayName) return obj.displayName;
    if (obj.render?.displayName) return obj.render.displayName;
    if (obj.render?.name) return obj.render.name;
  }
  return '?';
}

// ---- Listbox option matching (mirrors content-script logic for v2 path) ----

function findOptionMatch(searchVariants: string[]): {
  option: HTMLElement | null;
  optionsSeen: string[];
} {
  const listboxes = document.querySelectorAll('[role="listbox"]');
  if (listboxes.length === 0) {
    return { option: null, optionsSeen: [] };
  }
  const listbox = listboxes[listboxes.length - 1];
  const options = Array.from(listbox.querySelectorAll('[role="option"]')) as HTMLElement[];
  const optionsSeen = options.map((o) => o.textContent?.trim() ?? '');

  for (const variant of searchVariants) {
    const v = variant.toLowerCase();
    for (const opt of options) {
      if (opt.textContent?.trim().toLowerCase() === v) return { option: opt, optionsSeen };
    }
  }
  for (const variant of searchVariants) {
    const v = variant.toLowerCase();
    for (const opt of options) {
      if (opt.textContent?.trim().toLowerCase().includes(v)) return { option: opt, optionsSeen };
    }
  }
  return { option: null, optionsSeen };
}

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

// ---- Response helper ----

function respond<T extends { namespace: typeof MESSAGE_NAMESPACE }>(payload: T): void {
  window.postMessage(payload, '*');
}
