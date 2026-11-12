# ShipSignal — release confidence, with context

ShipSignal answers the question every software team asks before a release: **"Can we ship?"** — and proves its answer with evidence from Jira and Atlassian's Teamwork Graph.

Built for **Codegeist 2026** — category **Apps for Software Teams**, bonus tracks **Best Agents (Rovo)** and **Best Teamwork Graph integration**.

## The problem

Release readiness lives in fragments: issue statuses in Jira, pull requests in GitHub, deployments in a CI tool, goals in Atlas, decisions buried in comments. Nobody assembles it before the go/no-go meeting, so teams ship on gut feel — or slip a date everyone saw coming.

## What ShipSignal does

**Readiness dashboard (Jira project page).** Pick any unreleased fix version and get a 0–100 readiness score with a SHIP / RISKY / HOLD verdict. The score is explainable: five weighted factors (work completed, blockers & stale work, PR/deploy coverage, goal alignment, decision activity) with the exact evidence behind each.

**ShipSignal Agent (Rovo).** Ask "Can we ship v2.4?" in Rovo chat. The agent runs the same engine through its actions, returns the verdict with issue-key evidence, and — with your confirmation — posts the readiness summary as a comment for the team or creates risk issues for the blockers.

**Teamwork Graph context.** The engine reads the graph around every work item in the release: linked goals, pull requests, deployments, and the last 14 days of discussion. This is what catches "done in Jira but the PR is still open" and "no goal linked, so nobody knows why this release matters."

**Daily release watch (scheduled trigger).** Once a day ShipSignal re-scores every release due within 14 days. If a release turns HOLD with blockers, or the score drops 15+ points since the last check, it posts a warning comment on the release tracking issue — so confidence is monitored continuously, not just when someone remembers to ask.

## Architecture

- **Forge app** (hosted functions, Custom UI project page, Rovo agent + 5 actions, scheduled trigger). No external servers — everything runs on Atlassian.
- **Jira REST** (`asApp`): versions, JQL search, comments, issue creation, transitions.
- **Teamwork Graph API** (`requestTeamworkGraph`, curated queries): `jiraWorkItemGoals`, `jiraWorkItemLinkedExternalPullRequests`, `jiraWorkItemLinkedExternalDeployments`, `jiraWorkItemComments`. Fails soft per issue, so the app works on sites with no connected tools.
- **Forge KVS**: stores the last readiness snapshot per release for the daily watch's drop detection.

## Modules

| Module | Purpose |
| --- | --- |
| `jira:projectPage` | Release readiness dashboard |
| `rovo:agent` + 5 `action` modules | Conversational readiness checks, evidence, team updates, risk tracking |
| `trigger` (scheduled, daily) | Proactive release watch with drop alerts |

## Try it

1. Install via the distribution link, then open **ShipSignal** in any Jira project's navigation.
2. No unreleased versions? Click **Generate demo release** to create "v2.4.0 Phoenix" — 12 realistic issues with blockers, stale work and mixed statuses.
3. Select a version, read the score, then open Rovo chat and ask the ShipSignal agent "Can we ship?".
