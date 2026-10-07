/** Immutable comparison retrieval; no checkout, repository scripts, or raw patches stored. */
import { z } from 'zod';
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const path = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.split('/').includes('..'),
  );
const file = z.object({
  filename: path,
  previous_filename: path.optional(),
  status: z.enum([
    'added',
    'removed',
    'modified',
    'renamed',
    'copied',
    'changed',
    'unchanged',
  ]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
const comparison = z.object({
  base_commit: z.object({ sha }),
  merge_base_commit: z.object({ sha }),
  commits: z.array(z.object({ sha })).max(250),
  total_commits: z.number().int().nonnegative(),
  files: z.array(file).max(300),
});
export class DiffSetupError extends Error {}

/**
 * The caller supplies a currently authorized, repository-scoped installation token
 * and independently resolved base/head SHAs. Tokens are request-only credentials.
 * HTTP authority is fixed to GitHub; redirects, branch names and arbitrary URLs
 * cannot redirect the token. Output deliberately excludes patch/source content.
 */
export async function retrieveImmutableDiff(
  input: {
    owner: string;
    repository: string;
    baseSha: string;
    headSha: string;
    token: string;
  },
  options: { signal?: AbortSignal; requestFetch?: typeof fetch } = {},
) {
  const segment = z
    .string()
    .regex(/^[a-zA-Z0-9_.-]{1,100}$/)
    .refine((s) => s !== '.' && s !== '..');
  const owner = segment.parse(input.owner),
    repository = segment.parse(input.repository);
  const baseSha = sha.parse(input.baseSha),
    headSha = sha.parse(input.headSha);
  if (!input.token.trim())
    throw new DiffSetupError('diff_authorization_missing');
  const timeout = AbortSignal.timeout(5000);
  const signal = options.signal
    ? AbortSignal.any([timeout, options.signal])
    : timeout;
  const response = await (options.requestFetch ?? fetch)(
    `https://api.github.com/repos/${owner}/${repository}/compare/${baseSha}...${headSha}?per_page=250&page=1`,
    {
      redirect: 'error',
      signal,
      headers: {
        authorization: `Bearer ${input.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    },
  );
  if (!response.ok || !response.body)
    throw new DiffSetupError('diff_upstream_unavailable');
  // Enforce bytes while streaming, rather than trusting Content-Length or allocating
  // an unlimited response with response.json(). Cancel the stream even on failure.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 2097152) throw new DiffSetupError('diff_response_budget');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  const data = comparison.parse(
    JSON.parse(Buffer.concat(chunks).toString('utf8')),
  );
  if (
    data.base_commit.sha !== baseSha ||
    (baseSha !== headSha &&
      data.total_commits <= 250 &&
      data.commits.at(-1)?.sha !== headSha)
  )
    throw new DiffSetupError('diff_identity_mismatch');
  // GitHub returns at most 300 files. At the boundary completeness is uncertain;
  // do not interpret a truncated list as proof of a small blast radius.
  return {
    baseSha,
    headSha,
    mergeBaseSha: data.merge_base_commit.sha,
    files: data.files,
    complete: data.files.length < 300 && data.total_commits <= 250,
    coverageGaps: [
      ...(data.files.length >= 300 ? ['file_limit'] : []),
      ...(data.total_commits > 250 ? ['commit_limit'] : []),
    ],
  };
}
