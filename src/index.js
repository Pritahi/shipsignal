import ResolverPkg from '@forge/resolver';
const Resolver = ResolverPkg.default || ResolverPkg;
import { kvs } from '@forge/kvs';
import { listProjects, listVersions, getVersionIssues, addComment, createIssue, createVersion } from './lib/jira.js';
import { computeReadiness, readinessSummaryText } from './lib/readiness.js';
import { echoTest } from './lib/twg.js';

const resolver = new Resolver();

function cloudIdFrom(req) {
  return req?.context?.cloudId || req?.payload?.cloudId || req?.cloudId || null;
}

resolver.define('getProjects', async () => listProjects());

resolver.define('getVersions', async (req) => {
  const { projectKey } = req.payload;
  return listVersions(projectKey);
});

resolver.define('getReadiness', async (req) => {
  const { projectKey, versionName } = req.payload;
  return computeReadiness(projectKey, versionName, cloudIdFrom(req));
});

resolver.define('twgEcho', async () => echoTest());

// Demo data: gives judges and first-time users a realistic release to explore.
resolver.define('generateDemoData', async (req) => {
  const { projectKey } = req.payload;
  const versionName = 'v2.4.0 Phoenix';
  const existing = await getVersionIssues(projectKey, versionName).catch(() => []);
  if (existing.length) {
    return { created: 0, versionName, note: 'Demo release already exists' };
  }
  const in14 = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  await createVersion(projectKey, versionName, in14).catch(() => {});
  const items = [
    ['Phoenix: checkout latency regression on mobile web', 'Bug', 'Highest', 'In Progress', 5],
    ['Phoenix: payment retry loop double-charges on 3DS failure', 'Bug', 'Highest', 'To Do', 8],
    ['Phoenix: finalize pricing experiment rollout plan', 'Task', 'High', 'In Progress', 3],
    ['Phoenix: migrate session store to Redis cluster', 'Story', 'High', 'In Review', 8],
    ['Phoenix: add SLO dashboards for checkout service', 'Task', 'Medium', 'Done', 3],
    ['Phoenix: update fraud rules for EU cards', 'Story', 'High', 'Done', 5],
    ['Phoenix: accessibility pass on payment form', 'Task', 'Medium', 'Done', 2],
    ['Phoenix: load test checkout at 5k rps', 'Task', 'High', 'In Progress', 5],
    ['Phoenix: document rollback procedure', 'Task', 'Medium', 'To Do', 1],
    ['Phoenix: bump Node runtime to 22 LTS', 'Task', 'Low', 'Done', 2],
    ['Phoenix: copy review for error states', 'Task', 'Low', 'Done', 1],
    ['Phoenix: canary analysis automation', 'Story', 'Medium', 'In Progress', null],
  ];
  let created = 0;
  for (const [summary, type, priority, status, points] of items) {
    try {
      const issue = await createIssue({
        projectKey,
        summary,
        description: `Demo issue for the ${versionName} release train. Priority ${priority}. Part of the ShipSignal sample data set so release readiness can be evaluated end to end.`,
        versionName,
        issueType: type,
        labels: ['shipsignal-demo'],
      });
      created += 1;
      if (status !== 'To Do') {
        const { transitionIssue } = await import('./lib/jira.js');
        await transitionIssue(issue.key, status).catch(() => {});
      }
      if (points) {
        const { setStoryPoints } = await import('./lib/jira.js');
        await setStoryPoints(issue.key, points).catch(() => {});
      }
    } catch (e) {
      // keep going; partial demo data still works
    }
  }
  return { created, versionName };
});

export const resolverHandler = resolver.getDefinitions();

// --- Rovo actions ---

export async function getReleaseReadinessAction(payload) {
  const { projectKey, versionName } = payload;
  const r = await computeReadiness(projectKey, versionName, cloudIdFrom(payload));
  return {
    score: r.score,
    verdict: r.verdict,
    counts: r.counts,
    factors: r.factors,
    topBlockers: r.topBlockers,
    contextNote: r.context.available
      ? `${r.context.pullRequests.length} pull requests, ${r.context.deployments.length} deployments, ${r.context.goals.length} goals, ${r.context.recentComments} comments in 14d`
      : 'Teamwork Graph context unavailable (missing cloud id)',
    guidance:
      r.verdict === 'SHIP'
        ? 'Release looks healthy. Confirm go/no-go with the team and post the summary.'
        : r.verdict === 'RISKY'
          ? 'There are open risks. Review the blockers and decide what descopes before the release date.'
          : 'Do not ship yet. Escalate the blockers and re-plan the release scope.',
  };
}

export async function getReleaseBlockersAction(payload) {
  const { projectKey, versionName } = payload;
  const issues = await getVersionIssues(projectKey, versionName);
  const open = issues.filter((i) => (i.fields.status?.statusCategory?.key || '') !== 'done');
  const blockers = open
    .filter((i) => ['highest', 'blocker'].includes((i.fields.priority?.name || '').toLowerCase()))
    .map((i) => ({
      key: i.key,
      summary: i.fields.summary,
      priority: i.fields.priority?.name,
      status: i.fields.status?.name,
      assignee: i.fields.assignee?.displayName || 'Unassigned',
      lastUpdated: i.fields.updated,
    }));
  const stale = open
    .filter((i) => (Date.now() - new Date(i.fields.updated).getTime()) / 86400000 > 14)
    .map((i) => ({ key: i.key, summary: i.fields.summary, lastUpdated: i.fields.updated }));
  return { blockers, stale, openCount: open.length };
}

export async function getReleaseContextAction(payload) {
  const { projectKey, versionName } = payload;
  const r = await computeReadiness(projectKey, versionName, cloudIdFrom(payload));
  return {
    goals: r.context.goals,
    pullRequests: r.context.pullRequests,
    deployments: r.context.deployments,
    recentCommentCount: r.context.recentComments,
    available: r.context.available,
    errors: r.context.errors.slice(0, 3),
  };
}

export async function postReadinessCommentAction(payload) {
  const { issueKey, comment } = payload;
  await addComment(issueKey, comment);
  return { posted: true, issueKey };
}

export async function createRiskIssueAction(payload) {
  const { projectKey, summary, description, versionName } = payload;
  const issue = await createIssue({
    projectKey,
    summary,
    description,
    versionName: versionName || undefined,
    issueType: 'Task',
    labels: ['release-risk'],
  });
  return { created: true, key: issue.key, id: issue.id };
}

// --- Scheduled daily watch ---

export async function dailyWatchHandler(event) {
  const cloudId = event?.context?.cloudId || event?.cloudId || null;
  const projects = await listProjects().catch(() => []);
  const results = [];
  for (const p of projects.slice(0, 5)) {
    const versions = await listVersions(p.key).catch(() => []);
    for (const v of versions) {
      if (!v.releaseDate) continue;
      const daysOut = (new Date(v.releaseDate).getTime() - Date.now()) / 86400000;
      if (daysOut < -1 || daysOut > 14) continue;
      const r = await computeReadiness(p.key, v.name, cloudId).catch(() => null);
      if (!r) continue;
      const storeKey = `watch:${p.key}:${v.name}`;
      const prev = await kvs.get(storeKey);
      await kvs.set(storeKey, { score: r.score, verdict: r.verdict, at: r.generatedAt });
      const dropped = prev && prev.score - r.score >= 15;
      if ((r.verdict === 'HOLD' && r.counts.blockers > 0) || dropped) {
        const issues = await getVersionIssues(p.key, v.name).catch(() => []);
        const target = issues.find((i) => (i.fields.labels || []).includes('release-tracking')) || issues.find((i) => (i.fields.status?.statusCategory?.key || '') !== 'done');
        if (target) {
          const note = dropped
            ? `ShipSignal daily watch: readiness for "${v.name}" dropped from ${prev.score} to ${r.score}.\n${readinessSummaryText(r)}`
            : `ShipSignal daily watch: release "${v.name}" is ${r.verdict} (${r.score}/100) with ${r.counts.blockers} blockers and ${Math.max(0, Math.round(daysOut))} days to go.\n${readinessSummaryText(r)}`;
          await addComment(target.key, note).catch(() => {});
          results.push({ project: p.key, version: v.name, commented: target.key, score: r.score });
        }
      }
    }
  }
  return { checked: true, results };
}
