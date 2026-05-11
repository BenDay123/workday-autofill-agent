// Bridge: lets the content script send requests to the main-world
// injected script and await responses, despite living in different JS
// worlds. Uses window.postMessage with the shared MESSAGE_NAMESPACE for
// routing, request ids for correlation, and a timeout to avoid hung
// promises if the main world isn't actually responding.
//
// Runs in the CONTENT SCRIPT world. The main-world side is in main.ts.

import type {
  ComboboxFillRequest,
  ComboboxFillResponse,
  FiberInspectRequest,
  FiberInspectResponse,
  WAResponse,
} from './protocol';
import { MESSAGE_NAMESPACE, isWAMessage } from './protocol';

const DEFAULT_TIMEOUT_MS = 4000;

interface Pending {
  resolve: (value: WAResponse) => void;
  reject: (err: Error) => void;
  timer: number;
}

const pending = new Map<string, Pending>();
let listenerAttached = false;

function ensureListener(): void {
  if (listenerAttached) return;
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    if (!isWAMessage(event.data)) return;
    const data = event.data as WAResponse | { kind?: string; id?: string };
    // Only handle responses (have `-response` kind suffix). Requests pass through.
    const kind = (data as { kind?: string }).kind;
    if (!kind || !kind.endsWith('-response')) return;
    const id = (data as { id?: string }).id;
    if (!id) return;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(data as WAResponse);
  });
  listenerAttached = true;
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function postAndAwait<T extends WAResponse>(
  request: { id: string },
  payload: unknown,
  timeoutMs: number,
): Promise<T> {
  ensureListener();
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(request.id);
      reject(new Error(`bridge timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(request.id, {
      resolve: resolve as (v: WAResponse) => void,
      reject,
      timer,
    });
    window.postMessage(payload, '*');
  });
}

/** Ask the main world to inspect a target element's React fiber and
 *  report what handler props are visible on its ancestors. Pure
 *  diagnostic — does not mutate the page. */
export async function requestFiberInspect(
  selector: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<FiberInspectResponse> {
  const id = generateId();
  const payload: FiberInspectRequest = {
    namespace: MESSAGE_NAMESPACE,
    kind: 'fiber-inspect',
    id,
    selector,
  };
  return postAndAwait<FiberInspectResponse>({ id }, payload, timeoutMs);
}

/** Ask the main world to fill a combobox typeahead by invoking the
 *  underlying React handler directly. */
export async function requestComboboxFill(
  selector: string,
  targetValue: string,
  searchVariants: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ComboboxFillResponse> {
  const id = generateId();
  const payload: ComboboxFillRequest = {
    namespace: MESSAGE_NAMESPACE,
    kind: 'combobox-fill',
    id,
    selector,
    targetValue,
    searchVariants,
  };
  return postAndAwait<ComboboxFillResponse>({ id }, payload, timeoutMs);
}
