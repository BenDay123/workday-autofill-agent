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
  `[WorkdayAgent main-world] injected on ${location.href} (build: v0.0.22)`,
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
      // Fire-and-forget — handleComboboxFill resolves by calling respond()
      // when done. The bridge enforces its own timeout, so we don't track
      // these promises here.
      void handleComboboxFill(msg);
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
//
// Verified live (2026-05-11 on nvidia.wd5 tenant):
//   - Workday's listbox options do NOT fire on real DOM clicks. The
//     option-click selection goes through React's onSelect prop at
//     depth ~2 of the option's fiber, signature `(item, evt, undef)`
//     where `item = { index }` and `evt` must have a callable
//     `preventDefault` (handleSelectionEvent calls it).
//   - Hierarchical pickers ("How Did You Hear About Us?") drill in by
//     invoking onSelect on the category; the listbox then replaces its
//     contents with the children. No back-arrow; we reset by calling
//     onAutoHidePopup followed by onSelectInputClick.
//   - onSearch does nothing for hierarchical pickers but still filters
//     flat lists, so we keep it in the flow — it's free when not
//     applicable.

async function handleComboboxFill(req: ComboboxFillRequest): Promise<void> {
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

  const fiber = (el as unknown as Record<string, unknown>)[fiberKey] as Fiber | null;

  // Locate the three handlers we'll need from the input's fiber chain.
  // (Skip depths 0–1: the raw input + Styled(input) carry React form-control
  // onChange wiring, not the combobox handlers.)
  const filterInfo = findFilterHandler(fiber);
  if (!filterInfo) {
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
  const opener = findOpenerInFiberTree(fiber);
  const autoHide = findAutoHidePopupInFiberTree(fiber);

  const baseDiag = {
    fiberFound: true,
    handlerPropName: filterInfo.name,
    handlerOwnerDepth: filterInfo.depth,
  };

  // Pre-flight chip check. If the input already shows a chip, ground-truth
  // it against the target BEFORE we touch any handler. Two outcomes:
  //   - Chip matches the target → nothing to do, treat as filled.
  //   - Chip differs from target → respect the user's existing selection
  //     and skip. This is the "manual choice wins" policy. Without this
  //     pre-flight, the opener+filter sequence would attempt to overwrite,
  //     and on catalog-mismatch cases (target value absent from this
  //     tenant's option list) the overwrite would fail and the page would
  //     be left in a transient half-open popup state.
  // Uses fresh DOM (readChipCandidates), not the stale scan-time
  // field.context that fill.ts uses — the content-script's
  // comboboxAlreadyShowsTarget can miss chips selected between scan and
  // fill, this can't.
  const preflightChips = readChipCandidates(el);
  if (preflightChips.length > 0) {
    const matching = chipMatchesAnyVariant(el, req.searchVariants);
    if (matching) {
      console.log(
        `[WorkdayAgent main-world] pre-flight chip-check: chip already matches "${matching}" — no fill needed`,
      );
      respond<ComboboxFillResponse>({
        namespace: MESSAGE_NAMESPACE,
        kind: 'combobox-fill-response',
        id: req.id,
        status: 'filled',
        diagnostics: { ...baseDiag, optionsSeen: preflightChips, chosenOption: matching },
      });
      return;
    }
    console.log(
      `[WorkdayAgent main-world] pre-flight chip-check: existing chip(s) ${JSON.stringify(preflightChips)} differ from target "${req.targetValue}" — respecting user's manual selection`,
    );
    respond<ComboboxFillResponse>({
      namespace: MESSAGE_NAMESPACE,
      kind: 'combobox-fill-response',
      id: req.id,
      status: 'skip-preselected',
      diagnostics: { ...baseDiag, optionsSeen: preflightChips, chosenOption: preflightChips[0] },
    });
    return;
  }

  // Phase A: open the listbox via React opener. Clear the input first —
  // if any prior content-script step left text in there, Workday's
  // combobox transitions into a "search-active" popup state where
  // calling onSelectInputClick / U() no longer opens the picker
  // (verified live 2026-05-12 on workday.wd5: a typed value of
  // "Internet Advertisement" caused this exact failure).
  try { setInputValueViaProto(el, ''); } catch (err) { /* ignore */ }

  if (opener) {
    console.log(
      `[WorkdayAgent main-world] invoking opener handler=${opener.name} at depth=${opener.depth}`,
    );
    try {
      opener.handler(makeSyntheticMouseEvent(el));
    } catch (err) {
      console.log(
        `[WorkdayAgent main-world] opener handler ${opener.name} threw: ${(err as Error).message ?? String(err)}`,
      );
    }
    await sleep(150);
  }

  // Phase B: set the input value and invoke the filter handler. For flat
  // typeahead lists this narrows the listbox to the matching option. For
  // hierarchical pickers (source dropdown), this is a no-op — we'll fall
  // through to the hierarchical phase.
  try {
    setInputValueViaProto(el, req.targetValue);
  } catch (err) {
    respond<ComboboxFillResponse>({
      namespace: MESSAGE_NAMESPACE,
      kind: 'combobox-fill-response',
      id: req.id,
      status: 'error',
      diagnostics: { ...baseDiag, errorMessage: `setter call failed: ${(err as Error).message ?? String(err)}` },
    });
    return;
  }

  try {
    if (VALUE_FIRST_HANDLERS.has(filterInfo.name)) {
      filterInfo.handler(req.targetValue);
    } else {
      filterInfo.handler(makeSyntheticChangeEvent(el));
    }
  } catch (err) {
    respond<ComboboxFillResponse>({
      namespace: MESSAGE_NAMESPACE,
      kind: 'combobox-fill-response',
      id: req.id,
      status: 'error',
      diagnostics: { ...baseDiag, errorMessage: `filter handler threw: ${(err as Error).message ?? String(err)}` },
    });
    return;
  }
  await sleep(300);

  // Phase C: find the listbox associated with this input.
  const listbox = findListboxFor(el);
  if (!listbox) {
    respond<ComboboxFillResponse>({
      namespace: MESSAGE_NAMESPACE,
      kind: 'combobox-fill-response',
      id: req.id,
      status: 'no-match',
      diagnostics: {
        ...baseDiag,
        errorMessage: 'no listbox associated with input after opener + filter',
      },
    });
    return;
  }

  // Phase D: try flat match (works for filtered typeaheads).
  const flat = findFlatMatchInListbox(listbox, req.searchVariants);
  if (flat.option) {
    const chosenText = flat.option.textContent?.trim() ?? '';
    if (invokeReactOnSelect(flat.option, listbox)) {
      respond<ComboboxFillResponse>({
        namespace: MESSAGE_NAMESPACE,
        kind: 'combobox-fill-response',
        id: req.id,
        status: 'filled',
        diagnostics: { ...baseDiag, optionsSeen: flat.optionsSeen, chosenOption: chosenText },
      });
      return;
    }
    console.log(
      `[WorkdayAgent main-world] flat match "${chosenText}" found but onSelect invocation failed — trying hierarchical`,
    );
  }

  // Phase D2: filter-primed onSelect. On some Workday tenants, after
  // `onSearch(target)` runs the visible listbox still shows top-level
  // category labels — but invoking onSelect at index 0 of the filtered
  // listbox actually commits the matching LEAF (e.g., the chip ends up
  // as "Internet Advertisement" even though we clicked "Advertisement"
  // visually). The chip indicator is the only way to detect this. Try
  // it before falling into the slower hierarchical walk.
  if (listbox.querySelectorAll('[role="option"]').length > 0) {
    const firstOption = listbox.querySelector('[role="option"]') as HTMLElement | null;
    if (firstOption && invokeReactOnSelect(firstOption, listbox)) {
      await sleep(300);
      const chipMatch = chipMatchesAnyVariant(el, req.searchVariants);
      if (chipMatch) {
        console.log(
          `[WorkdayAgent main-world] filter-primed onSelect committed "${chipMatch}"`,
        );
        respond<ComboboxFillResponse>({
          namespace: MESSAGE_NAMESPACE,
          kind: 'combobox-fill-response',
          id: req.id,
          status: 'filled',
          diagnostics: { ...baseDiag, optionsSeen: flat.optionsSeen, chosenOption: chipMatch },
        });
        return;
      }
      console.log(
        `[WorkdayAgent main-world] filter-primed onSelect did not commit; chip=${JSON.stringify(readChipCandidates(el))} — trying hierarchical`,
      );
    }
  }

  // Phase E: hierarchical drill-in. For pickers whose top-level options
  // are categories (source dropdown), invoke onSelect on each category
  // and search the resulting sub-list.
  const hier = await tryHierarchicalInMainWorld(
    el,
    listbox,
    req.searchVariants,
    opener,
    autoHide,
  );
  if (hier.option) {
    respond<ComboboxFillResponse>({
      namespace: MESSAGE_NAMESPACE,
      kind: 'combobox-fill-response',
      id: req.id,
      status: 'filled',
      diagnostics: {
        ...baseDiag,
        optionsSeen: flat.optionsSeen,
        chosenOption: hier.option.textContent?.trim() ?? '',
      },
    });
    return;
  }

  // Last-chance defensive check: it's possible something along the way
  // (autoHide → CLICK_OUTSIDE commit, an intermediate React re-render,
  // etc.) actually selected the target value but we never caught it.
  // The chip indicator is ground truth — if it shows our target now,
  // report success rather than asking the user to re-fill manually.
  const finalChip = chipMatchesAnyVariant(el, req.searchVariants);
  if (finalChip) {
    console.log(
      `[WorkdayAgent main-world] final chip-check rescued the fill — chip="${finalChip}"`,
    );
    respond<ComboboxFillResponse>({
      namespace: MESSAGE_NAMESPACE,
      kind: 'combobox-fill-response',
      id: req.id,
      status: 'filled',
      diagnostics: { ...baseDiag, optionsSeen: flat.optionsSeen, chosenOption: finalChip },
    });
    return;
  }

  respond<ComboboxFillResponse>({
    namespace: MESSAGE_NAMESPACE,
    kind: 'combobox-fill-response',
    id: req.id,
    status: 'no-match',
    diagnostics: { ...baseDiag, optionsSeen: flat.optionsSeen },
  });
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

// ---- Listbox option matching ----

/** Find an option in a SPECIFIC listbox whose text matches any of the
 *  search variants. Exact match wins over substring match. Returns the
 *  option element and the full list of option texts it saw (for diagnostics).
 *  Takes the listbox directly (rather than resolving from the input) so
 *  callers like the hierarchical walker can match within a drilled-in
 *  sub-list, not the top-level listbox. */
function findFlatMatchInListbox(
  listbox: Element,
  searchVariants: string[],
): { option: HTMLElement | null; optionsSeen: string[] } {
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
  // didn't open. Dump per-listbox state to make the next-step
  // diagnosis cheap when this fires.
  const dump = all.map((lb) => {
    const rect = lb.getBoundingClientRect();
    const optionTexts = Array.from(lb.querySelectorAll('[role="option"]'))
      .map((o) => o.textContent?.trim() ?? '')
      .slice(0, 6);
    return {
      n: lb.querySelectorAll('[role="option"]').length,
      ariaHidden: lb.getAttribute('aria-hidden'),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      options: optionTexts,
    };
  });
  console.log(
    `[WorkdayAgent main-world] findListboxFor: no match. ${all.length} listbox(es) in DOM: ${JSON.stringify(dump)}`,
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

// ---- Fiber-based handler lookup ----

/** Walk the input's fiber chain to find the FILTER handler — the one
 *  that narrows the listbox when the user types. Workday names this
 *  `onSearch` on the SelectInput at depth ~7. Skips depths 0–1 (raw
 *  input + Styled(input)) since those carry React form-control wiring
 *  rather than the combobox handler. */
function findFilterHandler(
  fiber: Fiber | null,
): { handler: (...args: unknown[]) => unknown; name: string; depth: number } | null {
  let current: Fiber | null = fiber;
  let depth = 0;
  while (current && depth < MAX_FIBER_DEPTH) {
    if (!SKIP_HANDLER_DEPTHS.has(depth)) {
      const props = getProps(current);
      for (const name of CANDIDATE_HANDLER_NAMES) {
        const candidate = props[name];
        if (typeof candidate === 'function') {
          return { handler: candidate as (...args: unknown[]) => unknown, name, depth };
        }
      }
    }
    current = current.return ?? null;
    depth++;
  }
  return null;
}

/** Find Workday's popup-close handler, used to reset the picker between
 *  hierarchical drill attempts. Sits at the same depth as the opener
 *  (~10) on the SelectInput's parent. */
function findAutoHidePopupInFiberTree(
  fiber: Fiber | null,
): { handler: () => void; depth: number } | null {
  let current: Fiber | null = fiber;
  let depth = 0;
  while (current && depth < MAX_FIBER_DEPTH) {
    if (!SKIP_HANDLER_DEPTHS.has(depth)) {
      const props = getProps(current);
      if (typeof props.onAutoHidePopup === 'function') {
        return { handler: props.onAutoHidePopup as () => void, depth };
      }
    }
    current = current.return ?? null;
    depth++;
  }
  return null;
}

// ---- React event invocation primitives ----

function setInputValueViaProto(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function makeSyntheticChangeEvent(el: HTMLInputElement): SyntheticChangeEvent {
  return {
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
}

/** React-shaped synthetic event for an option click. Workday's
 *  `handleSelectionEvent` calls `evt.preventDefault()` so this MUST be a
 *  callable function — passing a plain `{type: 'click'}` blows up with
 *  "preventDefault is not a function". Keyboard-modifier flags are
 *  needed too (the handler reads `shiftKey`/`ctrlKey`/`metaKey` to decide
 *  multi-select behavior). */
function makeSyntheticOptionClickEvent(target: HTMLElement): unknown {
  return {
    type: 'click',
    target,
    currentTarget: target,
    button: 0,
    buttons: 1,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    preventDefault() {},
    stopPropagation() {},
    persist() {},
    nativeEvent: new MouseEvent('click', { bubbles: true, cancelable: true }),
  };
}

/** Invoke Workday's React `onSelect` for an option element. Verified
 *  live (2026-05-11): real DOM clicks on options do NOT fire selection
 *  on Workday's virtualized listbox; only React-level invocation works.
 *  Signature is `(item, evt, undef)` where `item.index` is the option's
 *  position. */
function invokeReactOnSelect(option: HTMLElement, listbox: Element): boolean {
  const opts = Array.from(listbox.querySelectorAll('[role="option"]'));
  const index = opts.indexOf(option);
  if (index < 0) {
    console.log('[WorkdayAgent main-world] invokeReactOnSelect: option not in listbox');
    return false;
  }

  const fiberKey = findFiberKey(option);
  if (!fiberKey) {
    console.log('[WorkdayAgent main-world] invokeReactOnSelect: no fiber key on option');
    return false;
  }

  let fiber = (option as unknown as Record<string, unknown>)[fiberKey] as Fiber | null;
  let depth = 0;
  let onSelect: ((...args: unknown[]) => unknown) | null = null;
  while (fiber && depth < 10) {
    const props = getProps(fiber);
    if (typeof props.onSelect === 'function') {
      onSelect = props.onSelect as (...args: unknown[]) => unknown;
      break;
    }
    fiber = fiber.return ?? null;
    depth++;
  }
  if (!onSelect) {
    console.log('[WorkdayAgent main-world] invokeReactOnSelect: no onSelect found in option fiber chain');
    return false;
  }

  const evt = makeSyntheticOptionClickEvent(option);
  try {
    onSelect({ index }, evt, undefined);
    return true;
  } catch (err) {
    console.log(
      `[WorkdayAgent main-world] invokeReactOnSelect: onSelect threw — ${(err as Error).message ?? String(err)}`,
    );
    return false;
  }
}

// ---- Selection-verified helpers ----

/** Maximum DOM distance for a chip-indicator listbox to be considered
 *  part of this input's widget. The chip listbox is typically 5–7 hops
 *  away; the country-phone-code chip on the same page is much further. */
const CHIP_DOM_DISTANCE = 10;

/** Read all candidate chip-indicator texts near the input. Two sources:
 *  1) Wrapper text matching "N items selected, X" (Nvidia-style tenant)
 *  2) A 1-option listbox close to the input in the DOM (Workday-corporate
 *     tenant uses this exclusively — no "items selected" prefix anywhere)
 *  Returns deduped texts. */
function readChipCandidates(input: HTMLElement): string[] {
  const out = new Set<string>();

  // Method 1: regex on wrapper text chain
  let p: Element | null = input.parentElement;
  for (let i = 0; i < 6 && p; i++) {
    const t = p.textContent ?? '';
    const m = t.match(/\d+ item[s]? selected[^\n]*/);
    if (m) out.add(m[0].slice(0, 200));
    p = p.parentElement;
  }

  // Method 2: 1-option listboxes near the input
  const all = Array.from(document.querySelectorAll('[role="listbox"]'));
  for (const lb of all) {
    const opts = lb.querySelectorAll('[role="option"]');
    if (opts.length !== 1) continue;
    const text = opts[0].textContent?.trim();
    if (!text) continue;
    if (domDistance(input, lb) > CHIP_DOM_DISTANCE) continue;
    out.add(text);
  }
  return Array.from(out);
}

/** True if any of the chip candidate texts match any search variant.
 *  Used to detect that a selection actually committed (regardless of
 *  which onSelect path triggered it — flat match, filter-primed index 0,
 *  hierarchical drill, or even an accidental autoHide-CLICK_OUTSIDE
 *  commit during the picker reset). */
function chipMatchesAnyVariant(input: HTMLElement, searchVariants: string[]): string | null {
  const chips = readChipCandidates(input);
  for (const chip of chips) {
    const cl = chip.toLowerCase();
    for (const v of searchVariants) {
      const vl = v.toLowerCase();
      if (cl.includes(vl) || vl.includes(cl)) return chip;
    }
  }
  return null;
}

// ---- Hierarchical drill-in ----

/** Top-level options exceeding this count are treated as a flat list,
 *  not a hierarchical picker, and the walker bails out. Trees in
 *  practice have <10 top-level categories. */
const HIERARCHICAL_TOP_LEVEL_THRESHOLD = 10;
/** Cap the number of category drill attempts so a misconfigured picker
 *  can't burn the bridge's 8s timeout walking through 50 options. */
const HIERARCHICAL_MAX_ATTEMPTS = 6;

/** For pickers whose top-level options are categories (source dropdown
 *  "How Did You Hear About Us?"), drill into each category and search
 *  its sub-list. Categories are tried in priority order — names that
 *  appear in the target value go first. Resets the picker between
 *  attempts by closing + reopening, since Workday replaces (not
 *  appends) the listbox contents when a category is selected. */
async function tryHierarchicalInMainWorld(
  input: HTMLInputElement,
  initialListbox: Element,
  searchVariants: string[],
  opener: { handler: (...args: unknown[]) => unknown; name: string; depth: number } | null,
  autoHide: { handler: () => void; depth: number } | null,
): Promise<{ option: HTMLElement | null; category?: string }> {
  const initialLabels = Array.from(initialListbox.querySelectorAll('[role="option"]'))
    .map((o) => o.textContent?.trim() ?? '');
  if (initialLabels.length === 0) return { option: null };
  if (initialLabels.length > HIERARCHICAL_TOP_LEVEL_THRESHOLD) {
    console.log(
      `[WorkdayAgent main-world] tryHierarchical: ${initialLabels.length} options > threshold; treating as flat list and bailing`,
    );
    return { option: null };
  }

  console.log(
    `[WorkdayAgent main-world] tryHierarchical: ${initialLabels.length} categories: ${JSON.stringify(initialLabels)}`,
  );

  // Priority sort: categories whose name matches a search variant first.
  const variantsLower = searchVariants.map((v) => v.toLowerCase());
  const score = (label: string): number => {
    const ll = label.toLowerCase();
    for (const v of variantsLower) {
      if (ll === v) return 3;
      if (v.includes(ll) || ll.includes(v)) return 2;
    }
    return 0;
  };
  const sortedLabels = [...initialLabels].sort((a, b) => score(b) - score(a));
  const maxAttempts = Math.min(sortedLabels.length, HIERARCHICAL_MAX_ATTEMPTS);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const categoryLabel = sortedLabels[attempt];

    // Reset state between attempts: close popup, clear input value, reopen.
    // After a drill-in, the listbox contents are the sub-options — we need
    // to be back at top-level before invoking the next category.
    if (attempt > 0) {
      if (autoHide) {
        try { autoHide.handler(); } catch (err) {
          console.log(`[WorkdayAgent main-world] tryHierarchical: autoHide threw — ${(err as Error).message ?? String(err)}`);
        }
        await sleep(150);
      }
      try { setInputValueViaProto(input, ''); } catch (err) { /* ignore */ }
      if (opener) {
        try { opener.handler(makeSyntheticMouseEvent(input)); } catch (err) {
          console.log(`[WorkdayAgent main-world] tryHierarchical: reopen threw — ${(err as Error).message ?? String(err)}`);
        }
        await sleep(250);
      }
    }

    const currentListbox = findListboxFor(input);
    if (!currentListbox) {
      console.log(`[WorkdayAgent main-world] tryHierarchical: no listbox at attempt ${attempt}, aborting`);
      break;
    }
    const options = Array.from(currentListbox.querySelectorAll('[role="option"]')) as HTMLElement[];
    const category = options.find((o) => (o.textContent ?? '').trim() === categoryLabel);
    if (!category) {
      console.log(
        `[WorkdayAgent main-world] tryHierarchical: category "${categoryLabel}" not in current listbox; skipping`,
      );
      continue;
    }

    console.log(`[WorkdayAgent main-world] tryHierarchical: drilling into "${categoryLabel}"`);
    if (!invokeReactOnSelect(category, currentListbox)) continue;
    await sleep(300);

    // Check chip indicator first — on some tenants invoking onSelect on
    // a category actually commits a matching leaf rather than expanding
    // (the filter-primed selection pattern). If the chip now matches
    // our target, we're done regardless of whether a sub-list appeared.
    const earlyChipMatch = chipMatchesAnyVariant(input, searchVariants);
    if (earlyChipMatch) {
      console.log(
        `[WorkdayAgent main-world] tryHierarchical: drill into "${categoryLabel}" committed "${earlyChipMatch}" (no sub-list expansion needed)`,
      );
      return { option: category, category: categoryLabel };
    }

    const drilledListbox = findListboxFor(input);
    if (!drilledListbox) {
      console.log(
        `[WorkdayAgent main-world] tryHierarchical: drill into "${categoryLabel}" produced no listbox and no chip update; chips=${JSON.stringify(readChipCandidates(input))}`,
      );
      continue;
    }
    const drilledLabels = Array.from(drilledListbox.querySelectorAll('[role="option"]'))
      .map((o) => o.textContent?.trim() ?? '');

    // Verify the drill actually changed the listbox — if Workday left
    // us at top-level (e.g., a non-hierarchical leaf was clicked), skip.
    const sameAsInitial =
      drilledLabels.length === initialLabels.length &&
      drilledLabels.every((l) => initialLabels.includes(l));
    if (sameAsInitial) {
      console.log(
        `[WorkdayAgent main-world] tryHierarchical: drill into "${categoryLabel}" produced no change`,
      );
      continue;
    }

    const leaf = findFlatMatchInListbox(drilledListbox, searchVariants);
    if (leaf.option) {
      const leafText = leaf.option.textContent?.trim() ?? '';
      console.log(
        `[WorkdayAgent main-world] tryHierarchical: matched "${leafText}" under "${categoryLabel}"`,
      );
      if (invokeReactOnSelect(leaf.option, drilledListbox)) {
        return { option: leaf.option, category: categoryLabel };
      }
    }
    console.log(
      `[WorkdayAgent main-world] tryHierarchical: no leaf match under "${categoryLabel}" (saw: ${JSON.stringify(drilledLabels.slice(0, 12))})`,
    );
  }

  return { option: null };
}

// ---- Misc ----

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Response helper ----

function respond<T extends { namespace: typeof MESSAGE_NAMESPACE }>(payload: T): void {
  window.postMessage(payload, '*');
}
