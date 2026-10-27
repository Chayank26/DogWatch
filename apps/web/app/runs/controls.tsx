'use client';
import { useEffect, useRef, useState } from 'react';
type Settings = {
  revision: number;
  enabled: boolean;
  budget: Record<string, number>;
};
const labels: Record<string, string> = {
  maxRunSeconds: 'Run duration (seconds)',
  maxApiRequests: 'API requests',
  maxBrowserSteps: 'Browser steps',
  maxModelCalls: 'Model calls',
  maxModelTokens: 'Model tokens',
  maxModelCostCents: 'Model cost (cents)',
};
export default function Controls({
  tenantId,
  runId,
}: {
  tenantId: string;
  runId: string;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [message, setMessage] = useState('Loading owner controls…');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const requestId = useRef<string | null>(null);
  const base = `/auth/tenants/${tenantId}/runs/${runId}`;
  useEffect(() => {
    const controller = new AbortController();
    fetch(base + '/configuration', {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw Error(
            'Owner controls are unavailable. Refresh after checking your access.',
          );
        const data = await response.json();
        if (!controller.signal.aborted) {
          setSettings(data);
          setMessage('');
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setMessage(error.message);
      });
    return () => controller.abort();
  }, [base]);
  async function act(kind: 'configuration' | 'rerun') {
    if (!settings) return;
    setBusy(true);
    setMessage('');
    if (!requestId.current) requestId.current = crypto.randomUUID();
    try {
      const response = await fetch(base + '/' + kind, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          kind === 'configuration'
            ? {
                expectedRevision: settings.revision,
                enabled: settings.enabled,
                budget: settings.budget,
              }
            : { requestId: requestId.current },
        ),
        signal: AbortSignal.timeout(15000),
      });
      const data = await response.json();
      if (!response.ok) {
        const messages: Record<string, string> = {
          quota_concurrent:
            'Workspace capacity is reserved. Ask an administrator to settle finished runs or wait for capacity.',
          quota_daily_runs: 'This workspace has reached its daily run limit.',
          quota_daily_model_cost:
            'This request exceeds the workspace’s daily model budget.',
          control_revision_conflict:
            'Settings changed. Refresh the run before trying again.',
          control_run_active:
            'This pull request already has active work. Wait for it to finish.',
          control_disabled: 'Save enabled settings before requesting a rerun.',
          control_pr_unavailable:
            'The current pull request or installation is not eligible for a rerun.',
        };
        setMessage(
          messages[data.error] ??
            'The action was not confirmed. Check your access and try again.',
        );
        return;
      }
      if (kind === 'configuration') {
        setSettings(data);
        setDirty(false);
        setMessage('Manual rerun settings saved.');
      } else
        setMessage(
          `Rerun ${data.runId} ${data.status === 'duplicate' ? 'was already accepted' : 'accepted'}. Execution has not been confirmed. Refresh the run list to follow its state.`,
        );
    } catch {
      setMessage(
        'The response was lost or unavailable. Retry uses the same rerun request ID.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Owner run controls">
      <h2>Manual rerun settings</h2>
      <p>
        These repository settings apply to manual owner requests. Webhook
        policies are configured separately. Reruns use the current open pull
        request commit and start with fresh readiness checks.
      </p>
      {settings && (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void act('configuration');
            }}
          >
            <label>
              <input
                type="checkbox"
                checked={settings.enabled}
                disabled={busy}
                onChange={(e) => {
                  setDirty(true);
                  setSettings({ ...settings, enabled: e.target.checked });
                }}
              />{' '}
              Allow manual reruns
            </label>
            {Object.entries(labels).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  min={1}
                  required
                  step={1}
                  disabled={busy}
                  value={settings.budget[key]}
                  onChange={(e) => {
                    setDirty(true);
                    setSettings({
                      ...settings,
                      budget: {
                        ...settings.budget,
                        [key]: Number(e.target.value),
                      },
                    });
                  }}
                />
              </label>
            ))}
            <button disabled={busy} type="submit">
              Save rerun settings
            </button>
          </form>
          <p>
            Revision {settings.revision}. Save changes before requesting a
            rerun.
          </p>
          <button
            disabled={
              busy || dirty || !settings.enabled || settings.revision === 0
            }
            onClick={() => void act('rerun')}
          >
            Request rerun
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
