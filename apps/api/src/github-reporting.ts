/** Callable GitHub App publication. No route/worker automatically invokes this module. */
import { Octokit } from 'octokit';
import { createAppAuth } from '@octokit/auth-app';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { deliveryScopeSchema, withReportJournal } from './report-journal.js';
const requestSchema = z
  .strictObject({
    scope: deliveryScopeSchema,
    publicationApproved: z.literal(true),
    revision: z.number().int().min(1).max(1000000),
    phase: z.enum(['queued', 'in_progress', 'completed']),
    markdown: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, 'utf8') <= 60000),
    conclusion: z
      .enum(['success', 'failure', 'neutral', 'cancelled'])
      .optional(),
    blocking: z.boolean().default(false),
    coverageComplete: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if ((value.phase === 'completed') !== (value.conclusion !== undefined))
      ctx.addIssue({
        code: 'custom',
        message: 'Final conclusion required only on completion',
      });
    if (value.conclusion === 'success' && !value.coverageComplete)
      ctx.addIssue({
        code: 'custom',
        message: 'Success needs explicit complete coverage',
      });
    if (value.conclusion === 'failure' && !value.blocking)
      ctx.addIssue({
        code: 'custom',
        message: 'Failure requires explicit blocking policy',
      });
  });
const retirementSchema = z.strictObject({
  scope: deliveryScopeSchema,
  publicationApproved: z.literal(true),
  reason: z.enum(['head_changed', 'superseded', 'cancelled']),
});
const id = z.number().int().positive().safe();
export function createGitHubReporter(
  appId: number,
  privateKey: string,
  requestFetch: typeof fetch = fetch,
) {
  return createReportAdapter(appId, privateKey, requestFetch, false);
}
/** Callback authorizes retirement of this exact scope, independently of execution eligibility. */
export function createGitHubReportRetirer(
  appId: number,
  privateKey: string,
  requestFetch: typeof fetch = fetch,
) {
  return createReportAdapter(appId, privateKey, requestFetch, true);
}
function createReportAdapter(
  appId: number,
  privateKey: string,
  requestFetch: typeof fetch,
  retiring: boolean,
) {
  id.parse(appId);
  const app = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId, privateKey },
    request: { timeout: 2000, fetch: requestFetch },
    retry: { enabled: false },
    throttle: { enabled: false },
  });
  return async (
    root: string,
    input: unknown,
    isCurrent: () => Promise<boolean>,
  ) => {
    const retirement = retiring ? retirementSchema.parse(input) : undefined;
    const request = requestSchema.parse(
        retirement
          ? {
              scope: retirement.scope,
              publicationApproved: true,
              revision: 1,
              phase: 'completed',
              conclusion: 'cancelled',
              markdown: `DogWatch report withdrawn (${retirement.reason}).\n\nThis run for commit ${retirement.scope.headSha} is no longer authoritative. It is not a verdict on the current pull request. Request a new run for current results.`,
            }
          : input,
      ),
      scope = request.scope;
    const key = createHash('sha256')
      .update(JSON.stringify({ appId, ...scope }))
      .digest('hex');
    const marker = `<!-- dogwatch-report:${key} -->`;
    const body = marker + '\n' + request.markdown;
    const digest = createHash('sha256')
      .update(JSON.stringify(request))
      .digest('hex');
    return withReportJournal(root, scope, async (state, save) => {
      if (state.retired && !retirement) throw Error('report_retired');
      if (retirement && state.retired && state.retired !== retirement.reason)
        throw Error('retirement_conflict');
      if (!retirement && request.revision < state.revision)
        throw Error('report_revision_stale');
      if (
        !retirement &&
        request.revision === state.revision &&
        state.digest !== digest
      )
        throw Error('report_revision_conflict');
      const ranks = { queued: 0, in_progress: 1, completed: 2 };
      if (
        !retirement &&
        state.phase &&
        ranks[request.phase] < ranks[state.phase]
      )
        throw Error('report_phase_regression');
      const guard = async () => {
        const allowed = await new Promise<boolean>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error('authority_timeout')),
            2000,
          );
          Promise.resolve()
            .then(isCurrent)
            .then(resolve, reject)
            .finally(() => clearTimeout(timer));
        });
        if (!allowed) throw Error('report_stale');
      };
      await guard();
      const installation = (
        await app.request('GET /app/installations/{installation_id}', {
          installation_id: scope.installationId,
        })
      ).data;
      if (
        Number(installation.id) !== scope.installationId ||
        Number(installation.app_id) !== appId
      )
        throw Error('installation_scope');
      if (installation.suspended_at) throw Error('installation_suspended');
      const grant = (
        await app.request(
          'POST /app/installations/{installation_id}/access_tokens',
          {
            installation_id: scope.installationId,
            repository_ids: [scope.repositoryId],
            permissions: {
              metadata: 'read',
              pull_requests: 'write',
              checks: 'write',
            },
          },
        )
      ).data;
      const client = new Octokit({
        auth: grant.token,
        request: { timeout: 2000, fetch: requestFetch },
        retry: { enabled: false },
        throttle: { enabled: false },
      });
      const repository = (
        await client.request('GET /repositories/{repository_id}', {
          repository_id: scope.repositoryId,
        })
      ).data;
      if (Number(repository.id) !== scope.repositoryId)
        throw Error('repository_scope');
      const target = { owner: repository.owner.login, repo: repository.name };
      const current = async () => {
        await guard();
        const pr = (
          await client.request(
            'GET /repos/{owner}/{repo}/pulls/{pull_number}',
            { ...target, pull_number: scope.pullRequestNumber },
          )
        ).data;
        if (
          (!retirement && pr.state !== 'open') ||
          pr.number !== scope.pullRequestNumber ||
          (!retirement && pr.head.sha !== scope.headSha) ||
          Number(pr.base.repo.id) !== scope.repositoryId ||
          Number(pr.head.repo?.id) !== scope.repositoryId
        )
          throw Error('report_stale');
        if (
          retirement?.reason === 'head_changed' &&
          !state.retired &&
          pr.head.sha === scope.headSha
        )
          throw Error('report_not_stale');
        await guard();
      };
      await current();
      if (retirement && !state.retired) {
        // Persist terminal intent before reconciliation or any remote mutation.
        state.retired = retirement.reason;
        state.delivered = false;
        await save();
      }
      const comments = [];
      const checks = [];
      // Bounded exhaustive reconciliation. A full final page cannot prove absence.
      for (let page = 1; page <= 5; page++) {
        const response = await client.request(
          'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
          {
            ...target,
            issue_number: scope.pullRequestNumber,
            per_page: 100,
            page,
          },
        );
        comments.push(...response.data);
        if (response.data.length < 100) break;
        if (page === 5) throw Error('comment_scan_limit');
      }
      for (let page = 1; page <= 5; page++) {
        const response = await client.request(
          'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
          {
            ...target,
            ref: scope.headSha,
            app_id: appId,
            filter: 'all',
            per_page: 100,
            page,
          },
        );
        checks.push(...response.data.check_runs);
        if (response.data.check_runs.length < 100) break;
        if (page === 5) throw Error('check_scan_limit');
      }
      const ownComments = comments.filter(
        (comment) =>
          comment.body?.startsWith(marker + '\n') &&
          comment.performed_via_github_app?.id === appId,
      );
      const ownChecks = checks.filter(
        (check) =>
          check.external_id === key &&
          check.app?.id === appId &&
          check.head_sha === scope.headSha,
      );
      if (ownComments.length > 1 || ownChecks.length > 1)
        throw Error('report_ambiguous');
      if (state.commentId && ownComments[0]?.id !== state.commentId)
        throw Error('comment_identity');
      if (state.checkId && ownChecks[0]?.id !== state.checkId)
        throw Error('check_identity');
      if (!state.commentId && ownComments[0]) {
        state.commentId = id.parse(ownComments[0].id);
        if (state.pending === 'comment') delete state.pending;
        await save();
      }
      if (!state.checkId && ownChecks[0]) {
        state.checkId = id.parse(ownChecks[0].id);
        if (state.pending === 'check') delete state.pending;
        await save();
      }
      if (state.pending) throw Error('report_delivery_uncertain');
      if (retirement) {
        const checkMatches =
          !state.checkId ||
          (ownChecks[0]?.status === 'completed' &&
            ownChecks[0]?.conclusion === 'cancelled' &&
            ownChecks[0]?.output.title === 'DogWatch report withdrawn' &&
            ownChecks[0]?.output.text === '' &&
            ownChecks[0]?.output.summary === request.markdown);
        const commentMatches =
          !state.commentId || ownComments[0]?.body === body;
        if (checkMatches && commentMatches && state.delivered)
          return {
            status: 'unchanged' as const,
            commentId: state.commentId,
            checkId: state.checkId,
          };
        state.delivered = false;
        await save();
        if (state.checkId && !checkMatches) {
          await current();
          await client.request(
            'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}',
            {
              ...target,
              check_run_id: state.checkId,
              status: 'completed',
              conclusion: 'cancelled',
              completed_at: new Date().toISOString(),
              output: {
                title: 'DogWatch report withdrawn',
                summary: request.markdown,
                text: '',
              },
            },
          );
        }
        if (state.commentId && !commentMatches) {
          await current();
          await client.request(
            'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
            {
              ...target,
              comment_id: state.commentId,
              body,
            },
          );
        }
        await current();
        state.delivered = true;
        await save();
        return {
          status: 'retired' as const,
          commentId: state.commentId,
          checkId: state.checkId,
        };
      }
      if (
        request.revision === state.revision &&
        state.digest === digest &&
        state.delivered === true &&
        ownComments[0]?.body === body &&
        ownChecks[0]?.status === request.phase &&
        ownChecks[0]?.output.summary === request.markdown &&
        (!request.conclusion || ownChecks[0]?.conclusion === request.conclusion)
      )
        return {
          status: 'unchanged' as const,
          commentId: state.commentId,
          checkId: state.checkId,
        };
      await current();
      state.revision = request.revision;
      state.digest = digest;
      state.phase = request.phase;
      state.delivered = false;
      await save();
      const checkBody = {
        name: 'DogWatch QA',
        status: request.phase,
        ...(request.conclusion
          ? {
              conclusion: request.conclusion,
              completed_at: new Date().toISOString(),
            }
          : {}),
        output: { title: 'DogWatch QA', summary: request.markdown },
      };
      if (!state.checkId) {
        state.pending = 'check';
        await save();
        await current();
        const created = await client.request(
          'POST /repos/{owner}/{repo}/check-runs',
          {
            ...target,
            ...checkBody,
            head_sha: scope.headSha,
            external_id: key,
          },
        );
        state.checkId = id.parse(created.data.id);
        delete state.pending;
        await save();
      } else {
        await current();
        await client.request(
          'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}',
          { ...target, ...checkBody, check_run_id: state.checkId },
        );
      }
      await current();
      if (!state.commentId) {
        state.pending = 'comment';
        await save();
        await current();
        const created = await client.request(
          'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
          { ...target, issue_number: scope.pullRequestNumber, body },
        );
        state.commentId = id.parse(created.data.id);
        delete state.pending;
        await save();
      } else
        await client.request(
          'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
          { ...target, comment_id: state.commentId, body },
        );
      await current();
      state.revision = request.revision;
      state.digest = digest;
      state.phase = request.phase;
      state.delivered = true;
      await save();
      return {
        status: 'published' as const,
        commentId: state.commentId,
        checkId: state.checkId,
      };
    });
  };
}
