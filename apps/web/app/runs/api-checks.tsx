export type ApiChecksView =
  | { status: 'unavailable' }
  | {
      status: 'recorded';
      finishedAt: string;
      result: {
        status: 'completed' | 'inconclusive';
        code: string;
        requests: number;
        results: {
          caseId: string;
          operationKey: string;
          status: 'passed' | 'failed' | 'inconclusive' | 'skipped';
          code: string;
          httpStatus?: number;
        }[];
        coverageGaps: { code: string; operationKey?: string }[];
      };
    };
export default function ApiChecks({ checks }: { checks?: ApiChecksView }) {
  if (!checks || checks.status !== 'recorded')
    return (
      <section aria-label="API checks">
        <h3>API checks</h3>
        <p>
          No API check result is available yet. The run may be pending,
          interrupted, or have no recorded API checks.
        </p>
      </section>
    );
  const result = checks.result;
  const counts = { passed: 0, failed: 0, inconclusive: 0, skipped: 0 };
  for (const item of result.results) counts[item.status]++;
  return (
    <section aria-label="API checks">
      <h3>API checks</h3>
      <p>
        {result.status === 'inconclusive'
          ? 'Coverage incomplete'
          : 'Check execution completed'}{' '}
        · {result.requests} requests
      </p>
      <p>
        {counts.passed} passed · {counts.failed} failed · {counts.inconclusive}{' '}
        inconclusive · {counts.skipped} skipped
      </p>
      <p>
        Recorded {new Date(checks.finishedAt).toLocaleString()} ·{' '}
        {result.code.replaceAll('_', ' ')}
      </p>
      <p className="note">
        These results describe the recorded checks for this commit. They do not
        establish that a failure was introduced by this change or that untested
        behavior passes.
      </p>
      {result.results.length === 0 && (
        <p>No individual API check outcomes were recorded.</p>
      )}
      {result.results.length > 0 && (
        <details>
          <summary>Individual checks ({result.results.length})</summary>
          <ul className="run-list">
            {result.results.map((item, index) => (
              <li key={item.caseId + ':' + index}>
                <strong>{item.status}</strong> ·{' '}
                <code>{item.operationKey}</code>
                <p>
                  {item.code.replaceAll('_', ' ')}
                  {item.httpStatus === undefined
                    ? ''
                    : ` · HTTP ${item.httpStatus}`}
                </p>
                <small>Case {item.caseId}</small>
              </li>
            ))}
          </ul>
        </details>
      )}
      {result.coverageGaps.length > 0 && (
        <details open>
          <summary>Coverage gaps ({result.coverageGaps.length})</summary>
          <ul>
            {result.coverageGaps.map((gap, index) => (
              <li key={index}>
                {gap.code.replaceAll('_', ' ')}
                {gap.operationKey && (
                  <>
                    {' '}
                    · <code>{gap.operationKey}</code>
                  </>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
