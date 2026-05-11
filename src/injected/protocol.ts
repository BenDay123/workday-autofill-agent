// Wire protocol shared between the content script (isolated world) and the
// injected main-world script. Types only — no runtime code — so this file
// is safe to import from both worlds without dragging in chrome.* refs.
//
// All v2 traffic is namespaced with `MESSAGE_NAMESPACE` so unrelated page
// postMessage chatter is filtered out by the listeners on both sides.

export const MESSAGE_NAMESPACE = 'wa-v2';

/** Marker attribute used to address a specific element across worlds when
 *  the regular selector isn't unique. Content script sets it, main world
 *  reads it. */
export const ELEMENT_MARKER_ATTR = 'data-wa-target';

// ---- Requests: content → main ----

export interface ComboboxFillRequest {
  namespace: typeof MESSAGE_NAMESPACE;
  kind: 'combobox-fill';
  id: string;
  /** CSS selector that should resolve to the target input. Pre-checked
   *  for uniqueness in the content script. */
  selector: string;
  /** The captured value we're trying to write (e.g., "United States of
   *  America (+1)"). */
  targetValue: string;
  /** Pre-computed search variants the main world should try when
   *  matching options after the filter fires. */
  searchVariants: string[];
}

/** Pure-diagnostic request — asks the main world to inspect the React
 *  fiber for a target element and report what it sees, without modifying
 *  anything. Used for spike data when we don't yet know the handler name
 *  or signature. */
export interface FiberInspectRequest {
  namespace: typeof MESSAGE_NAMESPACE;
  kind: 'fiber-inspect';
  id: string;
  selector: string;
}

export type WARequest = ComboboxFillRequest | FiberInspectRequest;

// ---- Responses: main → content ----

export type ComboboxFillStatus =
  | 'filled'        // matched and clicked an option
  | 'no-match'      // filter fired but no option matched
  | 'no-fiber'      // couldn't find a React fiber on the element
  | 'no-handler'    // fiber found but no known handler prop on any ancestor
  | 'no-element'    // selector didn't resolve in the main world
  | 'error';        // unexpected exception (see diagnostics.errorMessage)

export interface ComboboxFillResponse {
  namespace: typeof MESSAGE_NAMESPACE;
  kind: 'combobox-fill-response';
  id: string;
  status: ComboboxFillStatus;
  diagnostics: {
    fiberFound: boolean;
    handlerPropName?: string;
    handlerOwnerDepth?: number;
    optionsSeen?: string[];
    chosenOption?: string;
    errorMessage?: string;
  };
}

export interface FiberInspectResponse {
  namespace: typeof MESSAGE_NAMESPACE;
  kind: 'fiber-inspect-response';
  id: string;
  /** True if at least one `__reactFiber$*` key was found on the element. */
  fiberFound: boolean;
  /** The full key (e.g., `__reactFiber$abc123`) if found. */
  fiberKey?: string;
  /** Walk-up dump: one entry per ancestor fiber, up to a bounded depth.
   *  Includes the component type name (if available) and the names of
   *  props that look like event handlers (start with `on`, value is a
   *  function). */
  ancestors: Array<{
    depth: number;
    typeName: string;
    handlerPropNames: string[];
  }>;
  errorMessage?: string;
}

export type WAResponse = ComboboxFillResponse | FiberInspectResponse;

// ---- Type guards ----

export function isWAMessage(data: unknown): data is WARequest | WAResponse {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { namespace?: unknown }).namespace === MESSAGE_NAMESPACE
  );
}
