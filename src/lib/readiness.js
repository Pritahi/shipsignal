import { getVersionIssues } from './jira.js';
import { issueAri, getIssueGoals, getIssuePullRequests, getIssueDeployments, getIssueRecentComments } from './twg.js';

const DONE_CATEGORIES = new Set(['done']);
const BLOCKER_PRIORITIES = new Set(['highest', 'blocker']);
const STALE_DAYS = 14;

function isDone(issue) {
  return DONE_CATEGORIES.has((issue.fields.status?.statusCategory?.key || '').toLowerCase());
}

function daysSince(dateStr) {
  if (!dateStr) return 999;
  return (Date.now() - new Date(dateStr).getTime()) / 86400000;
}

function analyzeIssues(issues) {
  const total = issues.length;
  const done = issues.filter(isDone);
  const open = issues.filter((i) => !isDone(i));

  const blockers = open.filter((i) =>
    BLOCKER_PRIORITIES.has((i.fields.priority?.name || '').toLowerCase())
  );
  const blockingLinks = [];
  for (const i of open) {
    for (const l of i.fields.issuelinks || []) {
      if (l.type?.name === 'Blocks' && l.outwardIssue) {
        blockingLinks.push({ from: i.key, to: l.outwardIssue.key, summary: l.outwardIssue.fields?.summary });
      }
    }
  }
  const stale = open.filter((i) => daysSince(i.fields.updated) > STALE_DAYS);
  const unestimated = open.filter((i) => {
    const sp = i.fields.customfield_10016;
    const te = i.fields.timeestimate;
    return (sp === null || sp === undefined) && (te === null || te === undefined);
  });

  return {
    total,
    doneCount: done.length,
    openCount: open.length,
    doneRatio: total ? done.length / total : 0,
    blockers: blockers.map(brief),
    stale: stale.map(brief),
    unestimated: unestimated.map(brief),
    blockingLinks,
    open: open.map(brief),
  };
}

function brief(i) {
  return {
    key: i.key,
    id: i.id,
    summary: i.fields.summary,
    status: i.fields.status?.name,
    priority: i.fields.priority?.name,
    assignee: i.fields.assignee?.displayName || 'Unassigned',
    updated: i.fields.updated,
    issueType: i.fields.issuetype?.name,
  };
}

// Core engine: returns the full readiness report for one fix version.
export async function computeReadiness(projectKey, versionName, cloudId) {
  const issues = await getVersionIssues(projectKey, versionName);
  const a = analyzeIssues(issues);

  // Teamwork Graph context (fail-soft per issue)
  const context = {
    available: !!cloudId,
    goals: [],
    pullRequests: [],
    deployments: [],
    recentComments: 0,
    issuesWithPR: 0,
    errors: [],
  };

  if (cloudId && issues.length) {
    const sample = issues.slice(0, 25);
    const settled = await Promise.allSettled(
      sample.map(async (i) => {
        const ari = issueAri(cloudId, i.id);
        const [goals, prs, deps, comments] = await Promise.all([
          getIssueGoals(ari),
          getIssuePullRequests(ari),
          getIssueDeployments(ari),
          getIssueRecentComments(ari, 'P14D'),
        ]);
        return { key: i.key, goals, prs, deps, comments };
      })
    );
    for (const r of settled) {
      if (r.status === 'rejected') {
        context.errors.push(String(r.reason).slice(0, 200));
        continue;
      }
      const { key, goals, prs, deps, comments } = r.value;
      context.goals.push(...goals.map((g) => ({ ...g, issueKey: key })));
      context.pullRequests.push(...prs.map((p) => ({ ...p, issueKey: key })));
      context.deployments.push(...deps.map((d) => ({ ...d, issueKey: key })));
      context.recentComments += comments.length;
      if (prs.length) context.issuesWithPR += 1;
    }
    // de-dupe goals by id
    const seen = new Set();
    context.goals = context.goals.filter((g) => (seen.has(g.id) ? false : seen.add(g.id)));
  }

  // Scoring
  const completion = a.doneRatio; // 0..1
  const blockerPenalty = Math.min(1, a.blockers.length * 0.25 + a.stale.length * 0.08);
  const engCoverage = a.total
    ? context.pullRequests.length || context.deployments.length
      ? context.issuesWithPR / Math.min(a.total, 25)
      : 0.5 // no integrations connected: neutral, not punished
    : 0;
  const goalSignal = context.goals.length ? Math.min(1, context.goals.length / 2) : 0.4;
  const activitySignal = Math.min(1, context.recentComments / 10);

  const score = Math.round(
    100 *
      (0.4 * completion +
        0.25 * (1 - blockerPenalty) +
        0.15 * engCoverage +
        0.1 * goalSignal +
        0.1 * activitySignal)
  );

  const verdict = score >= 80 ? 'SHIP' : score >= 50 ? 'RISKY' : 'HOLD';

  return {
    projectKey,
    versionName,
    score,
    verdict,
    counts: {
      total: a.total,
      done: a.doneCount,
      open: a.openCount,
      blockers: a.blockers.length,
      stale: a.stale.length,
      unestimated: a.unestimated.length,
    },
    factors: [
      { key: 'completion', label: 'Work completed', weight: 40, value: Math.round(completion * 100), detail: `${a.doneCount} of ${a.total} issues done` },
      { key: 'blockers', label: 'Blockers and stale work', weight: 25, value: Math.round((1 - blockerPenalty) * 100), detail: `${a.blockers.length} blockers, ${a.stale.length} stale (> ${STALE_DAYS}d)` },
      { key: 'engineering', label: 'PR and deploy coverage', weight: 15, value: Math.round(engCoverage * 100), detail: context.pullRequests.length || context.deployments.length ? `${context.pullRequests.length} PRs, ${context.deployments.length} deployments linked` : 'No code integrations connected' },
      { key: 'goals', label: 'Goal alignment', weight: 10, value: Math.round(goalSignal * 100), detail: context.goals.length ? `${context.goals.length} linked goals` : 'No goals linked in Teamwork Graph' },
      { key: 'activity', label: 'Decision activity', weight: 10, value: Math.round(activitySignal * 100), detail: `${context.recentComments} comments in the last 14 days` },
    ],
    topBlockers: a.blockers.slice(0, 8),
    staleIssues: a.stale.slice(0, 8),
    blockingLinks: a.blockingLinks.slice(0, 10),
    context,
    generatedAt: new Date().toISOString(),
  };
}

export function readinessSummaryText(r) {
  const emoji = r.verdict === 'SHIP' ? '[GREEN]' : r.verdict === 'RISKY' ? '[YELLOW]' : '[RED]';
  const lines = [
    `ShipSignal readiness: ${emoji} ${r.verdict} - score ${r.score}/100 for ${r.projectKey} "${r.versionName}"`,
    `Work: ${r.counts.done}/${r.counts.total} done, ${r.counts.blockers} blockers, ${r.counts.stale} stale, ${r.counts.unestimated} unestimated.`,
  ];
  if (r.topBlockers.length) {
    lines.push('Top blockers: ' + r.topBlockers.map((b) => `${b.key} (${b.priority}, ${b.assignee})`).join(', '));
  }
  lines.push(`Context: ${r.context.pullRequests.length} PRs, ${r.context.deployments.length} deployments, ${r.context.goals.length} goals, ${r.context.recentComments} recent comments.`);
  return lines.join('\n');
}
