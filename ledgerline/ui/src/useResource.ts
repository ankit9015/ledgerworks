import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, getJson } from './api';

export type ResourceState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'unauthorized' }
  | { status: 'error'; message: string };

/**
 * Loads `path` with the API key and exposes loading / ready / unauthorized / error. "Empty" is a
 * panel decision about `data`, not a transport state. `reload` refetches (showing loading again).
 */
export function useResource<T>(
  path: string,
  apiKey: string,
  onUnauthorized?: () => void,
): { state: ResourceState<T>; reload: () => void } {
  const [state, setState] = useState<ResourceState<T>>({ status: 'loading' });
  const [tick, setTick] = useState(0);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;

  useEffect(() => {
    const ctl = new AbortController();
    setState({ status: 'loading' });
    getJson<T>(path, apiKey, ctl.signal)
      .then((data) => setState({ status: 'ready', data }))
      .catch((err: unknown) => {
        if (ctl.signal.aborted) return;
        if (err instanceof ApiRequestError && err.unauthorized) {
          setState({ status: 'unauthorized' });
          unauthorized.current?.();
        } else {
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : 'Something went wrong',
          });
        }
      });
    return () => ctl.abort();
  }, [path, apiKey, tick]);

  return { state, reload: useCallback(() => setTick((t) => t + 1), []) };
}
