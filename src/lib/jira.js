import api, { route } from '@forge/api';

// Forge's requestJira validator rejects runtime-built path strings, so every
// call site builds its URL with the route`` template (which encodes values).

async function jiraGet(r, label, asUser = false) {
  const client = asUser ? api.asUser() : api.asApp();
  const res = await client.requestJira(r, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira GET ${label} -> ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function jiraPost(r, label, body) {
  const res = await api.asApp().requestJira(r, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira POST ${label} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.status === 204 ? {} : res.json();
}

export async function listProjects() {
  const data = await jiraGet(route`/rest/api/3/project/search?maxResults=50&orderBy=name`, 'project search');
  return (data.values || []).map((p) => ({ key: p.key, name: p.name, id: p.id }));
}

export async function listVersions(projectKey) {
  const versions = await jiraGet(route`/rest/api/3/project/${projectKey}/versions`, 'versions');
  return versions
    .filter((v) => !v.released && !v.archived)
    .map((v) => ({ id: v.id, name: v.name, releaseDate: v.releaseDate || null, description: v.description || '' }));
}

export async function searchIssues(jql, fields, maxResults = 100) {
  const fieldList = fields.join(',');
  const data = await jiraGet(
    route`/rest/api/3/search/jql?jql=${jql}&maxResults=${maxResults}&fields=${fieldList}`,
    'issue search'
  );
  return data.issues || [];
}

export async function getVersionIssues(projectKey, versionName) {
  const jql = `project = ${projectKey} AND fixVersion = "${versionName}" ORDER BY priority DESC, status ASC`;
  return searchIssues(jql, [
    'summary', 'status', 'priority', 'issuetype', 'assignee', 'updated', 'duedate',
    'issuelinks', 'labels', 'comment', 'customfield_10016', 'timeestimate',
  ]);
}

export async function addComment(issueKey, text) {
  const adf = {
    version: 1,
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
  return jiraPost(route`/rest/api/3/issue/${issueKey}/comment`, 'add comment', { body: adf });
}

export async function createIssue({ projectKey, summary, description, versionName, issueType = 'Task', labels = [] }) {
  const fields = {
    project: { key: projectKey },
    summary,
    issuetype: { name: issueType },
    labels,
    description: {
      version: 1,
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: description || summary }] }],
    },
  };
  if (versionName) {
    const versions = await jiraGet(route`/rest/api/3/project/${projectKey}/versions`, 'versions');
    const v = versions.find((x) => x.name === versionName);
    if (v) fields.fixVersions = [{ id: v.id }];
  }
  return jiraPost(route`/rest/api/3/issue`, 'create issue', { fields });
}

export async function createVersion(projectKey, name, releaseDate) {
  return jiraPost(route`/rest/api/3/version`, 'create version', { project: projectKey, name, releaseDate, released: false });
}

export async function transitionIssue(issueKey, targetStatusName) {
  const data = await jiraGet(route`/rest/api/3/issue/${issueKey}/transitions`, 'transitions');
  const t = (data.transitions || []).find(
    (x) => x.name.toLowerCase() === targetStatusName.toLowerCase() || x.to?.name?.toLowerCase() === targetStatusName.toLowerCase()
  );
  if (!t) return false;
  await jiraPost(route`/rest/api/3/issue/${issueKey}/transitions`, 'transition', { transition: { id: t.id } });
  return true;
}

export async function setStoryPoints(issueKey, points) {
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { customfield_10016: points } }),
  });
  return res.ok;
}
