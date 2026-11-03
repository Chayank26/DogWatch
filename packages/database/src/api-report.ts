/** Deterministic, bounded report from recorded metadata. Never a baseline verdict. */
import { executionResultSchema } from './execution.js';
const text = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('@', '&#64;')
    .replace(/[\\`*_{}[\]()#+.!|~-]/g, '\\$&')
    .replace(/[\r\n\t]/g, ' ');
export function renderApiReport(
  scope: {
    id: string;
    repository: string;
    pullRequestNumber: number;
    headSha: string;
  },
  finishedAt: string,
  input: unknown,
): string {
  const result = executionResultSchema.parse(input);
  const counts = { passed: 0, failed: 0, inconclusive: 0, skipped: 0 };
  for (const item of result.results) counts[item.status]++;
  const lines = [
    '# DogWatch API checks',
    '',
    `Repository: ${text(scope.repository)} · PR ${scope.pullRequestNumber}`,
    `Run: ${text(scope.id)}`,
    `Commit: ${text(scope.headSha)}`,
    `Recorded: ${text(finishedAt)}`,
    '',
    result.status === 'completed'
      ? 'Check execution completed.'
      : 'Coverage incomplete.',
    `${counts.passed} passed · ${counts.failed} failed · ${counts.inconclusive} inconclusive · ${counts.skipped} skipped`,
    `Requests: ${result.requests} · Outcome: ${text(result.code)}`,
    '',
    'These are recorded check outcomes, not an overall passing verdict. Baseline comparison is unavailable; failures are not established as regressions introduced by this change.',
    'Response bodies, credentials and evidence attachments are not included.',
    '',
    '## Individual checks',
    '',
  ];
  let size = Buffer.byteLength(lines.join('\n'));
  let omitted = 0;
  const add = (line: string) => {
    const bytes = Buffer.byteLength(line) + 1;
    if (size + bytes > 48000) {
      omitted++;
      return;
    }
    lines.push(line);
    size += bytes;
  };
  for (const item of result.results)
    add(
      `- ${item.status}: ${text(item.operationKey)} — ${text(item.code)}${item.httpStatus === undefined ? '' : ` (HTTP ${item.httpStatus})`} · Case ${text(item.caseId)}`,
    );
  if (!result.results.length)
    lines.push('No individual check outcomes recorded.');
  lines.push('', '## Coverage gaps', '');
  for (const gap of result.coverageGaps)
    add(
      `- ${text(gap.code)}${gap.operationKey ? ': ' + text(gap.operationKey) : ''}`,
    );
  if (!result.coverageGaps.length)
    lines.push(
      'No coverage gaps recorded. This does not establish coverage of untested behavior.',
    );
  if (omitted)
    lines.push(
      '',
      `Report shortened: ${omitted} detail entries omitted. Review the full recorded result in DogWatch. Summary counts include all recorded checks.`,
    );
  return lines.join('\n') + '\n';
}
