import type { ReactNode } from 'react';
import type { ResourceState } from './useResource';

export const fmt = (n: number): string => n.toLocaleString('en-US');
export const fmtDate = (iso: string): string => iso.slice(0, 16).replace('T', ' ') + ' UTC';

/**
 * A titled region that always shows exactly one of: loading, unauthorized, error (with retry),
 * empty, or its content. Every state has a text message and a symbol, so none of them depends on
 * colour; the live regions announce changes to screen readers.
 */
export function Panel<T>(props: {
  id: string;
  title: string;
  state: ResourceState<T>;
  isEmpty: (data: T) => boolean;
  emptyMessage: string;
  onRetry: () => void;
  actions?: ReactNode;
  children: (data: T) => ReactNode;
}): ReactNode {
  const { id, title, state } = props;
  let body: ReactNode;
  if (state.status === 'loading') {
    body = (
      <p role="status" className="state state-loading">
        <span aria-hidden="true">⏳ </span>Loading {title.toLowerCase()}…
      </p>
    );
  } else if (state.status === 'unauthorized') {
    body = (
      <p role="alert" className="state state-unauthorized">
        <span aria-hidden="true">🔒 </span>Unauthorized: the API key was not accepted. Enter a valid
        key to see this panel.
      </p>
    );
  } else if (state.status === 'error') {
    body = (
      <div role="alert" className="state state-error">
        <p>
          <span aria-hidden="true">⚠ </span>Could not load {title.toLowerCase()}: {state.message}
        </p>
        <button type="button" onClick={props.onRetry}>
          Try again
        </button>
      </div>
    );
  } else if (props.isEmpty(state.data)) {
    body = (
      <p role="status" className="state state-empty">
        <span aria-hidden="true">∅ </span>
        {props.emptyMessage}
      </p>
    );
  } else {
    body = props.children(state.data);
  }
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="panel"
      data-testid={id}
      data-state={state.status}
    >
      <header>
        <h2 id={`${id}-title`}>{title}</h2>
        <div className="actions">{props.actions}</div>
      </header>
      {body}
    </section>
  );
}
