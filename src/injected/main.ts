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

/** React-handler prop names to look for when walking up the fiber chain
 *  for a combobox. Order is significant: first match wins. We prefer
 *  filter-specific names (onSearch is Workday's choice — verified via
 *  fiber-inspect on a real Workday tenant, where `onSearch` appears at
 *  depths 7 and 10 on the typeahead components) over generic `onChange`,
 *  which on combobox inputs is just the React form-control wiring and
 *  doesn't trigger Workday's filter logic. */
const CANDIDATE_HANDLER_NAMES = [
  'onSearch',
  'onFilter',
  'onFilterChange',
  'onQueryChange',
  'onSearchChange',
  'onInputChange',
  'onValueChange',
  'onSelect',
  'onOptionSelect',
  'onChange', // generic — fallback only
];

/** Handler-prop names that expect a `(value: string)` signature rather
 *  than the React `(event)` signature of onChange. */
const VALUE_FIRST_HANDLERS = new Set([
  'onSearch',
  'onFilter',
  'onFilterChange',
  'onQueryChange',
  'onSearchChange',
  'onInputChange',
  'onValueChange',
]);

/** Handlers that should open Workday's combobox listbox. Tried in
 *  priority order BEFORE the filter handler runs. Plain DOM clicks on
 *  the input don't always open the listbox when the combobox starts
 *  empty (Workday gates it through React click handlers higher up). */
const OPENER_HANDLER_NAMES = [
  'onSelectInputClick',
  'onPromptIconClick',
  'onClick',
];

/** Fiber depths to skip when looking for the combobox handler. Depths
 *  0–1 are the input element itself and its `Styled(input)` wrapper —
 *  those carry React form-control onChange, not Workday's filter
 *  handler. The real combobox component sits a few levels higher. */
const SKIP_HANDLER_DEPTHS = new Set([0, 1]);

// ---- Boot ----

console.log(
  `[WorkdayAgent main-world] injected on ${location.href} (build: v0.0.16)`,
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
  // matching the allowlist. Depths in SKIP_HANDLER_DEPTHS (the input
  // element itself and its Styled() wrapper) are walked through but
  // their handlers are ignored — those have React form-control wiring,
  // not the combobox filter handler.
  const fiber = (el as unknown as Record<string, unknown>)[fiberKey] as Fiber | null;
  let owner: Fiber | null = null;
  let handlerName: string | undefined;
  let handler: ((...args: unknown[]) => unknown) | undefined;
  let depth = 0;
  let current: Fiber | null = fiber;
  while (current && depth < MAX_FIBER_DEPTH) {
    if (!SKIP_HANDLER_DEPTHS.has(depth)) {
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
    }
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

  // Phase A: open the listbox via React handlers if it isn't already.
  // Workday's combobox doesn't always open on a plain DOM click — for
  // empty fields, the opener gates on a React click handler at depth ~10
  // (onSelectInputClick / onPromptIconClick). Invoke whichever we find,
  // then give the listbox a moment to render before filtering.
  const opener = findOpenerInFiberTree(fiber);
  if (opener) {
    console.log(
      `[WorkdayAgent main-world] invoking opener handler=${opener.name} at depth=${opener.depth}`,
    );
    try {
      const syntheticClick = makeSyntheticMouseEvent(el);
      opener.handler(syntheticClick);
    } catch (err) {
      console.log(
        `[WorkdayAgent main-world] opener handler ${opener.name} threw: ${(err as Error).message ?? String(err)}`,
      );
    }
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

  // Workday's onSearch et al. take `(value: string)`; React's onChange
  // convention takes `(event)`. Match the signature to the handler so
  // the filter actually fires.
  const useValueSignature = VALUE_FIRST_HANDLERS.has(handlerName);

  try {
    if (useValueSignature) {
      handler(req.targetValue);
    } else {
      handler(syntheticEvent);
    }
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

  // Give the React filter a moment to render, then scan the listbox
  // associated with THIS input for matches against any search variant.
  void owner; // silence unused — we'll need it for hierarchical phase 6b
  setTimeout(() => {
    const matchResult = findOptionMatch(req.searchVariants, el);
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

function findOpenerInFiberTree(
  fiber: Fiber | null,
): { handler: (...args: unknown[]) => unknown; name: string; depth: number } | null {
  // Outer loop on NAME (priority), inner on depth. We want
  // onSelectInputClick anywhere in the tree to beat onClick at a
  // shallower depth — name priority matters more than "first ancestor
  // we hit." Previous version (depth-outer) accidentally picked
  // onClick at d=5 because it stopped at the first depth with ANY
  // matching name, never reaching d=10's onSelectInputClick.
  for (const name of OPENER_HANDLER_NAMES) {
    let current: Fiber | null = fiber;
    let depth = 0;
    while (current && depth < MAX_FIBER_DEPTH) {
      if (!SKIP_HANDLER_DEPTHS.has(depth)) {
        const props = getProps(current);
        const candidate = props[name];
        if (typeof candidate === 'function') {
          return {
            handler: candidate as (...args: unknown[]) => unknown,
            name,
            depth,
          };
        }
      }
      current = current.return ?? null;
      depth++;
    }
  }
  return null;
}

function makeSyntheticMouseEvent(el: HTMLElement): unknown {
  return {
    target: el,
    currentTarget: el,
    type: 'click',
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    button: 0,
    buttons: 1,
    preventDefault() {},
    stopPropagation() {},
    persist() {},
    nativeEvent: new MouseEvent('click', { bubbles: true, cancelable: true }),
  };
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

function findOptionMatch(
  searchVariants: string[],
  sourceInput: HTMLElement,
): {
  option: HTMLElement | null;
  optionsSeen: string[];
} {
  const listbox = findListboxFor(sourceInput);
  if (!listbox) {
    console.log('[WorkdayAgent main-world] findOptionMatch: no listbox found for input');
    return { option: null, optionsSeen: [] };
  }
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

// Find the listbox associated with a specific input element. Workday
// pre-renders multiple listboxes (chip indicators, hidden popups, etc.)
// so "latest in DOM order" is unreliable. Priority:
//   1) Input's aria-controls / aria-owns points to an explicit listbox id
//   2) Visible (bounding rect > 0, not aria-hidden) listbox nearest to
//      the input in DOM tree
//   3) Most-recent visible listbox with > 1 option
//   4) Last resort: latest listbox in DOM order
function findListboxFor(input: HTMLElement): Element | null {
  // 1) Explicit ARIA reference
  for (const attr of ['aria-controls', 'aria-owns', 'aria-activedescendant']) {
    const id = input.getAttribute(attr);
    if (id) {
      // aria-activedescendant points to an OPTION; walk up to find its listbox.
      const referenced = document.getElementById(id);
      if (referenced) {
        if (referenced.getAttribute('role') === 'listbox') {
          console.log(`[WorkdayAgent main-world] findListboxFor: matched via ${attr}=#${id}`);
          return referenced;
        }
        const ancestor = referenced.closest('[role="listbox"]');
        if (ancestor) {
          console.log(`[WorkdayAgent main-world] findListboxFor: matched via ${attr}=#${id} → ancestor listbox`);
          return ancestor;
        }
      }
    }
  }

  // 2-3) Visible, multi-option listbox(es)
  const all = Array.from(document.querySelectorAll('[role="listbox"]'));
  const visibleMulti = all.filter((lb) => {
    if (lb.getAttribute('aria-hidden') === 'true') return false;
    const rect = lb.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return lb.querySelectorAll('[role="option"]').length > 1;
  });

  if (visibleMulti.length === 1) {
    console.log('[WorkdayAgent main-world] findListboxFor: matched the sole visible multi-option listbox');
    return visibleMulti[0];
  }
  if (visibleMulti.length > 1) {
    // Prefer the listbox nearest the input in the DOM tree.
    let best: Element | null = null;
    let bestDistance = Infinity;
    for (const lb of visibleMulti) {
      const distance = domDistance(input, lb);
      if (distance < bestDistance) {
        best = lb;
        bestDistance = distance;
      }
    }
    if (best) {
      console.log(
        `[WorkdayAgent main-world] findListboxFor: matched nearest visible multi-option listbox (distance=${bestDistance})`,
      );
      return best;
    }
  }

  // 4) No good candidate. Don't fall back to "latest in DOM order" —
  // that's how the source dropdown attempts ended up matching against
  // the country phone code's chip indicator and producing junk
  // diagnostics. Better to fail cleanly so callers know the picker
  // didn't open.
  console.log(
    `[WorkdayAgent main-world] findListboxFor: no listbox associated with the input (none aria-controls'd, none visible multi-option). Total listboxes in DOM: ${all.length}`,
  );
  return null;
}

// DOM tree distance: number of "up" steps from `a` until an ancestor
// contains `b`, plus number of "down" steps to reach `b`. Cheap proxy
// for "is this listbox part of the same widget as my input?"
function domDistance(a: Element, b: Element): number {
  let depth = 0;
  let current: Element | null = a;
  while (current) {
    if (current.contains(b)) {
      // Now count downward from `current` to `b`.
      let down = 0;
      let cursor: Element | null = b;
      while (cursor && cursor !== current) {
        cursor = cursor.parentElement;
        down++;
      }
      return depth + down;
    }
    current = current.parentElement;
    depth++;
  }
  return Number.POSITIVE_INFINITY;
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
