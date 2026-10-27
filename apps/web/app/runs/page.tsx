'use client';
import { useEffect, useRef, useState } from 'react';
type Run = {
  id: string;
  repository: string;
  pullRequestNumber: number;
  headSha: string;
  state: string;
  createdAt: string;
  previewReady: boolean;
  evidence?: { message: string };
};
export default function Runs() {
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>(
    [],
  );
  const [tenant, setTenant] = useState('');
  const [runs, setRuns] = useState<Run[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<Run | null>(null);
  const [status, setStatus] = useState('Loading workspaces…');
  const [busy, setBusy] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const generation = useRef(0);
  async function request(path: string) {
    const response = await fetch(path, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 401) {
      setSignedOut(true);
      throw Error('Please sign in to view runs.');
    }
    if (!response.ok)
      throw Error(
        response.status === 404
          ? 'This run or workspace is no longer available to you.'
          : 'Could not load runs. Please retry.',
      );
    return response.json();
  }
  useEffect(() => {
    let active = true;
    fetch('/auth/onboarding', {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    })
      .then(async (response) => {
        if (!active) return;
        if (response.status === 401) {
          setSignedOut(true);
          setStatus('Please sign in to view runs.');
          return;
        }
        if (!response.ok)
          throw Error('Workspace loading failed. Reload to retry.');
        const data = await response.json();
        if (active) {
          setWorkspaces(data.workspaces);
          setStatus(
            data.workspaces.length
              ? 'Choose a workspace to view its runs.'
              : 'No workspace memberships. Start with workspace setup.',
          );
        }
      })
      .catch(() => {
        if (active) setStatus('Workspace loading failed. Reload to retry.');
      });
    return () => {
      active = false;
      generation.current++;
    };
  }, []);
  async function load(id: string, after?: string) {
    const current = ++generation.current;
    setTenant(id);
    setDetail(null);
    setRuns([]);
    setCursor(null);
    if (!id) {
      setStatus('Choose a workspace.');
      setBusy(false);
      return;
    }
    setBusy(true);
    setStatus('Loading runs…');
    try {
      const data = await request(
        `/auth/tenants/${id}/runs${after ? '?after=' + after : ''}`,
      );
      if (current === generation.current) {
        setRuns(data.runs);
        setCursor(data.nextCursor);
        setStatus(
          data.runs.length ? '' : 'No runs recorded in this workspace yet.',
        );
      }
    } catch (error) {
      if (current === generation.current) setStatus((error as Error).message);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  async function open(runId: string) {
    const current = ++generation.current;
    setDetail(null);
    setBusy(true);
    setStatus('Loading run…');
    try {
      const data = await request(`/auth/tenants/${tenant}/runs/${runId}`);
      if (current === generation.current) {
        setDetail(data);
        setStatus('');
      }
    } catch (error) {
      if (current === generation.current) {
        setRuns([]);
        setCursor(null);
        setStatus((error as Error).message);
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  return (
    <main>
      <a className="eyebrow" href="/onboarding">
        DogWatch · Workspace setup
      </a>
      <h1>Runs and evidence.</h1>
      <p className="intro">
        Review recorded QA activity for your workspace. A completed run is a
        lifecycle state, not a passing verdict.
      </p>
      {signedOut ? (
        <a className="button" href="/auth/github">
          Sign in with GitHub
        </a>
      ) : (
        <>
          <label htmlFor="workspace">Workspace</label>
          <select
            id="workspace"
            value={tenant}
            onChange={(e) => void load(e.target.value)}
          >
            <option value="">Choose a workspace</option>
            {workspaces.map((w) => (
              <option value={w.id} key={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          {tenant && (
            <button disabled={busy} onClick={() => void load(tenant)}>
              Refresh latest runs
            </button>
          )}
          {status && <p role="status">{status}</p>}
          {runs.length > 0 && (
            <section aria-label="Run list">
              <h2>Recorded runs</h2>
              <ul className="run-list">
                {runs.map((run) => (
                  <li key={run.id}>
                    <button disabled={busy} onClick={() => void open(run.id)}>
                      {run.repository} · PR #{run.pullRequestNumber}
                    </button>
                    <p>
                      {run.state.replaceAll('_', ' ')} ·{' '}
                      {new Date(run.createdAt).toLocaleString()}
                    </p>
                    <code>{run.headSha.slice(0, 12)}</code>
                  </li>
                ))}
              </ul>
              {cursor && (
                <button
                  disabled={busy}
                  onClick={() => void load(tenant, cursor)}
                >
                  Older runs
                </button>
              )}
            </section>
          )}
          {detail && (
            <section aria-label="Run details">
              <h2>
                {detail.repository} · PR #{detail.pullRequestNumber}
              </h2>
              <dl>
                <dt>Run</dt>
                <dd>{detail.id}</dd>
                <dt>Commit</dt>
                <dd>{detail.headSha}</dd>
                <dt>State</dt>
                <dd>{detail.state.replaceAll('_', ' ')}</dd>
                <dt>Preview readiness recorded</dt>
                <dd>
                  {detail.previewReady
                    ? 'Yes — current availability is not verified here'
                    : 'Not recorded'}
                </dd>
              </dl>
              <h3>Findings and evidence</h3>
              <p>{detail.evidence?.message}</p>
              <p className="note">
                No passing or failing verdict is inferred from missing evidence.
              </p>
            </section>
          )}
        </>
      )}
    </main>
  );
}
