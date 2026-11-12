import api from '@forge/api';

// Teamwork Graph helper. Curated queries only (raw cypher is unavailable to new apps).
// Every function fails soft: returns null/[] and notes the error, so the app degrades
// gracefully on sites where the graph has no data or a scope is not granted.

async function twg(query, variables, asUser = true) {
  const client = asUser ? api.asUser() : api.asApp();
  const res = await client.requestTeamworkGraph(query, variables || undefined);
  const body = await res.json();
  if (body.errors) {
    const msg = body.errors.map((e) => e.message).join('; ');
    const err = new Error(msg);
    err.twgErrors = body.errors;
    throw err;
  }
  if (!body.data) {
    throw new Error('twg unexpected body: ' + JSON.stringify(body).slice(0, 300));
  }
  return body.data;
}

function nodes(connection) {
  if (!connection || !connection.edges) return [];
  return connection.edges.map((e) => e.node).filter(Boolean);
}

export function issueAri(cloudId, issueId) {
  return `ari:cloud:jira:${cloudId}:issue/${issueId}`;
}

export async function getIssueGoals(ari) {
  const q = `query Shipsignal_IssueGoals($id: ID!) {
    jiraWorkItemGoals(id: $id, first: 5) {
      edges { node { ... on AtlassianGoal { id name key url } } }
    }
  }`;
  const data = await twg(q, { id: ari });
  return nodes(data.jiraWorkItemGoals);
}

export async function getIssuePullRequests(ari) {
  const q = `query Shipsignal_IssuePullRequests($id: ID!) {
    jiraWorkItemLinkedExternalPullRequests(id: $id, first: 10) {
      edges { node { ... on ExternalPullRequest { id title status url lastUpdatedAt } } }
    }
  }`;
  const data = await twg(q, { id: ari });
  return nodes(data.jiraWorkItemLinkedExternalPullRequests);
}

export async function getIssueDeployments(ari) {
  const q = `query Shipsignal_IssueDeployments($id: ID!) {
    jiraWorkItemLinkedExternalDeployments(id: $id, first: 10) {
      edges { node { ... on ExternalDeployment { id displayName state url lastUpdatedAt environment { displayName } } } }
    }
  }`;
  const data = await twg(q, { id: ari });
  return nodes(data.jiraWorkItemLinkedExternalDeployments);
}

export async function getIssueRecentComments(ari, since = 'P14D') {
  const q = `query Shipsignal_IssueComments($id: ID!, $since: String!) {
    jiraWorkItemComments(id: $id, since: $since, first: 10) {
      edges { node { ... on JiraWorkItemComment { id content createdAt author { name } } } }
    }
  }`;
  const data = await twg(q, { id: ari, since });
  return nodes(data.jiraWorkItemComments);
}

export async function echoTest() {
  const data = await twg('query Shipsignal_Echo { echo(myString: "shipsignal-ok") }');
  return data.echo;
}
