import { useCallback, useState, type FormEvent } from 'react';
import { BalancePanel, QueuePanel, UsagePanel } from './Panels';

/**
 * The API key lives in this component's state: in memory only. It is never written to localStorage,
 * sessionStorage, a cookie or the URL, so reloading the page signs you out. Entering the key is a
 * form with a password-type field that the browser is told not to autofill or remember.
 */
export function App() {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);
  const signOut = useCallback(() => {
    setApiKey(null);
    setRejected(false);
  }, []);

  if (apiKey === null) {
    return (
      <main>
        <h1>Ledgerline admin</h1>
        <KeyForm
          onSubmit={(k) => {
            setRejected(false);
            setApiKey(k);
          }}
        />
      </main>
    );
  }
  return (
    <main>
      <header className="top">
        <h1>Ledgerline admin</h1>
        <button type="button" onClick={signOut}>
          Sign out
        </button>
      </header>
      {rejected && (
        <p role="alert" className="banner">
          <span aria-hidden="true">🔒 </span>The API key was not accepted. Sign out and enter a
          valid key.
        </p>
      )}
      <div className="grid">
        <UsagePanel apiKey={apiKey} onUnauthorized={() => setRejected(true)} />
        <BalancePanel apiKey={apiKey} onUnauthorized={() => setRejected(true)} />
        <QueuePanel apiKey={apiKey} onUnauthorized={() => setRejected(true)} />
      </div>
    </main>
  );
}

function KeyForm({ onSubmit }: { onSubmit: (key: string) => void }) {
  const [value, setValue] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const key = value.trim();
    if (key) onSubmit(key);
  };
  return (
    <form onSubmit={submit} aria-labelledby="key-form-title">
      <h2 id="key-form-title">Sign in with a tenant API key</h2>
      <p>
        The key is kept in this tab&apos;s memory only: it is not stored, and reloading the page
        signs you out. You will see only that tenant&apos;s data.
      </p>
      <label htmlFor="api-key">Tenant API key</label>
      <input
        id="api-key"
        name="api-key"
        type="password"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        required
      />
      <button type="submit">Sign in</button>
    </form>
  );
}
