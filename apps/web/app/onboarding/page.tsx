'use client';
import { useEffect, useState } from 'react';
type Workspace = {
  id: string;
  name: string;
  role: string;
  installations: number;
  repositories: number;
};
export default function Onboarding() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [state, setState] = useState<
    'loading' | 'signed-out' | 'ready' | 'unavailable'
  >('loading');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function refresh() {
    try {
      const response = await fetch('/auth/onboarding', {
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      });
      if (response.status === 401) {
        setWorkspaces([]);
        setState('signed-out');
        return;
      }
      if (!response.ok) throw Error('unavailable');
      const data = await response.json();
      setWorkspaces(data.workspaces);
      setState('ready');
    } catch {
      setState('unavailable');
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/auth/onboarding/workspace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(10000),
      });
      if (response.status === 401) {
        setState('signed-out');
        return;
      }
      if (!response.ok) {
        setError(
          response.status === 409
            ? 'You already belong to a workspace. Refresh to view it.'
            : 'Workspace creation failed. Try again with a name of 1–80 characters.',
        );
        return;
      }
      await refresh();
    } catch {
      setError('We could not confirm creation. Refresh before trying again.');
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/auth/logout', {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw Error('logout');
      setWorkspaces([]);
      setState('signed-out');
    } catch {
      setError('Sign-out failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main>
      <a href="/" className="eyebrow">
        DogWatch
      </a>
      <h1>Set up your workspace.</h1>
      <p className="intro">
        Bring your team’s pull requests into one place. Start with your
        workspace, then connect an installation and prepare a repository.
      </p>
      <div aria-live="polite">
        {state === 'loading' && <p>Checking your session…</p>}
        {state === 'signed-out' && (
          <section>
            <h2>1. Sign in with GitHub</h2>
            <p>
              Sign in to create your first workspace or see the workspaces you
              already belong to.
            </p>
            <a className="button" href="/auth/github">
              Continue with GitHub
            </a>
          </section>
        )}
        {state === 'unavailable' && (
          <section>
            <h2>Setup is unavailable</h2>
            <p>
              We could not load your workspace. Try again, or ask your
              administrator to check that sign-in is enabled.
            </p>
            <button onClick={() => void refresh()}>Try again</button>
          </section>
        )}
        {state === 'ready' && (
          <>
            <div className="actions">
              <p>
                Signed in · {workspaces.length} workspace
                {workspaces.length === 1 ? '' : 's'}
              </p>
              <button disabled={busy} onClick={() => void logout()}>
                Sign out
              </button>
            </div>
            {workspaces.length === 0 ? (
              <section>
                <h2>2. Create your workspace</h2>
                <p>
                  You’ll become its owner. This creates a new workspace; it does
                  not join an existing organization.
                </p>
                <form onSubmit={create}>
                  <label htmlFor="workspace-name">Workspace name</label>
                  <input
                    id="workspace-name"
                    autoComplete="organization"
                    required
                    maxLength={80}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={busy}
                  />
                  <button disabled={busy || !name.trim()} type="submit">
                    {busy ? 'Creating…' : 'Create workspace'}
                  </button>
                </form>
                <p className="note">
                  Joining an existing team? Ask its owner to arrange membership
                  before creating a workspace.
                </p>
              </section>
            ) : (
              workspaces.map((workspace) => (
                <section key={workspace.id}>
                  <p className="eyebrow">
                    {workspace.role === 'owner' ? 'Owner' : 'Member'}
                  </p>
                  <h2>{workspace.name}</h2>
                  <ol className="checklist">
                    <li>
                      <strong>Workspace created</strong>
                      <p>Your membership is active.</p>
                    </li>
                    <li>
                      <strong>
                        {workspace.installations
                          ? `${workspace.installations} installation(s) linked`
                          : 'Link a GitHub installation'}
                      </strong>
                      <p>
                        {workspace.installations
                          ? 'A link is recorded. GitHub access is checked again when used.'
                          : 'Ask your administrator to verify and link your GitHub installation. Browser linking is not available yet.'}
                      </p>
                    </li>
                    <li>
                      <strong>
                        {workspace.repositories
                          ? `${workspace.repositories} repository record(s)`
                          : 'Prepare a repository'}
                      </strong>
                      <p>
                        Preview settings, test accounts and run policies still
                        require administrator configuration. A repository record
                        alone does not mean QA is ready.
                      </p>
                    </li>
                  </ol>
                  <p className="note">Setup does not start a QA run.</p>
                </section>
              ))
            )}
            <button disabled={busy} onClick={() => void refresh()}>
              Refresh setup status
            </button>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </main>
  );
}
