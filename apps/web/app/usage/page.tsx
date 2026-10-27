'use client';
import { useEffect, useRef, useState } from 'react';
type Summary = {
  day: string;
  limits: {
    maxConcurrent: number;
    maxDailyRuns: number;
    maxDailyModelCostCents: number;
  };
  acceptedRuns: number;
  pendingReservations: number;
  committedModelCostCents: number;
  recent: {
    runId: string;
    reservedAt: string;
    settledAt: string | null;
    reservedModelCostCents: number;
    actual: {
      runSeconds: number;
      browserSeconds: number;
      apiRequests: number;
      browserSteps: number;
      modelCalls: number;
      modelTokens: number;
      modelCostCents: number;
      artifactBytes: number;
    } | null;
  }[];
};
export default function Usage() {
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>(
    [],
  );
  const [tenant, setTenant] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [message, setMessage] = useState('Loading workspaces…');
  const [signedOut, setSignedOut] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/auth/onboarding', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) {
          setSignedOut(true);
          throw Error('Sign in to see usage.');
        }
        if (!response.ok)
          throw Error('Workspace loading failed. Reload to retry.');
        const data = await response.json();
        if (!controller.signal.aborted) {
          setWorkspaces(data.workspaces);
          setMessage(
            data.workspaces.length
              ? 'Choose a workspace.'
              : 'Create or join a workspace to see usage.',
          );
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setMessage(error.message);
      });
    return () => {
      controller.abort();
      generation.current++;
    };
  }, []);
  async function load(id: string) {
    const current = ++generation.current;
    setTenant(id);
    setSummary(null);
    setMessage('Loading usage…');
    if (!id) {
      setMessage('Choose a workspace.');
      return;
    }
    try {
      const response = await fetch(`/auth/tenants/${id}/usage`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok)
        throw Error(
          response.status === 404 || response.status === 401
            ? 'Usage is unavailable for this session or workspace.'
            : 'Could not load usage. Try refresh.',
        );
      const data = await response.json();
      if (current === generation.current) {
        setSummary(data);
        setMessage('');
      }
    } catch (error) {
      if (current === generation.current) setMessage((error as Error).message);
    }
  }
  return (
    <main>
      <a className="eyebrow" href="/runs">
        DogWatch · Runs
      </a>
      <h1>Usage and quotas.</h1>
      <p className="intro">
        Budgets are reserved before work is accepted. Reported usage appears
        after a trusted supervisor settles the run.
      </p>
      {signedOut ? (
        <a className="button" href="/auth/github">
          Sign in with GitHub
        </a>
      ) : (
        <>
          <label htmlFor="usage-workspace">Workspace</label>
          <select
            id="usage-workspace"
            value={tenant}
            onChange={(e) => void load(e.target.value)}
          >
            <option value="">Choose a workspace</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          {tenant && (
            <button onClick={() => void load(tenant)}>Refresh usage</button>
          )}
        </>
      )}
      {message && <p role="status">{message}</p>}
      {summary && (
        <>
          <section>
            <h2>Quota accounting · {summary.day} UTC</h2>
            <dl>
              <dt>Unsettled reservations (all days)</dt>
              <dd>
                {summary.pendingReservations} / {summary.limits.maxConcurrent}
              </dd>
              <dt>Runs accepted today</dt>
              <dd>
                {summary.acceptedRuns} / {summary.limits.maxDailyRuns}
              </dd>
              <dt>Model cost committed today (reserved or settled cents)</dt>
              <dd>
                {summary.committedModelCostCents} /{' '}
                {summary.limits.maxDailyModelCostCents}
              </dd>
            </dl>
            <p>
              These figures are quota accounting, not a billing invoice. Limits
              are managed by your administrator.
            </p>
          </section>
          <section>
            <h2>Latest 50 reservations</h2>
            {summary.recent.length === 0 ? (
              <p>
                No usage reservations recorded yet. Historical runs may predate
                this ledger.
              </p>
            ) : (
              <ul className="run-list">
                {summary.recent.map((record) => (
                  <li key={record.runId}>
                    <code style={{ overflowWrap: 'anywhere' }}>
                      {record.runId}
                    </code>
                    <p>
                      Reserved: {record.reservedModelCostCents} model cost cents
                    </p>
                    {record.actual ? (
                      <>
                        <p>
                          Reported: {record.actual.modelCostCents} model cost
                          cents · {record.actual.modelTokens} tokens ·{' '}
                          {record.actual.modelCalls} model calls
                        </p>
                        <p>
                          {record.actual.runSeconds} run seconds ·{' '}
                          {record.actual.browserSeconds} browser seconds ·{' '}
                          {record.actual.browserSteps} browser steps ·{' '}
                          {record.actual.apiRequests} API requests ·{' '}
                          {record.actual.artifactBytes} artifact bytes
                        </p>
                      </>
                    ) : (
                      <p>Pending measurement — actual usage is unknown.</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="note">
              Cancelled or failed work can still consume resources. Reservations
              remain held until usage is explicitly settled.
            </p>
          </section>
        </>
      )}
    </main>
  );
}
