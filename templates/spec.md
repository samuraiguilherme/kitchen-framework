---
id: <issue#>-<slug>
intent: ./intent.md
status: draft            # draft | in-review | approved | superseded
owner: <name>
reviewers: [<name>]
artifact: <artifact path>@<sha>   # or N/A
last_grounded_against: <base commit sha>
---

# <Title>

## Summary
<!-- 3–5 sentences: what we're building and how it delivers the intent's outcome. -->

## User stories
- As a <role>, I want <capability> so that <benefit>.

## Requirements and acceptance criteria
<!-- Numbered, so tests and plan steps can cite them. -->
| ID | Requirement | Acceptance criteria (Given / When / Then) |
|---|---|---|
| AC-1 | | |

## UX and flows
<!-- Link the prototype. Cover every state. -->
- **Happy path:**
- **States:** empty · loading · error · no permission · plan limit reached
- **Notifications:** <!-- email / SMS / in-app: who gets it, when, and the copy -->

## Business rules and edge cases
<!-- Users in multiple workspaces, deleted or archived records, retries/duplicates, time zones, bulk actions, concurrency. -->
-

## Roles and permissions
| Role | Can | Cannot |
|---|---|---|
| <project role> | | |

## Data and integrations
- **Schema changes:** <!-- tables, columns, migrations, backfill of existing rows -->
- **Security and data access scope:**
- **APIs and services:**
- **Third parties:** <!-- applicable integrations and their failure modes -->

## Billing and entitlements
<!-- Which plans get it, credit usage, limits, what happens on downgrade or pause. N/A if none. -->

## Analytics
| Event | Properties | Answers which question / KPI |
|---|---|---|

## Non-functional
- **Performance:** <!-- data volume, latency budget -->
- **Privacy and compliance:** <!-- PII, consent, retention -->
- **Accessibility and mobile:**

## Rollout
- **Feature flag / who gets it first:**
- **Existing customers and data:**
- **Support and sales enablement:** <!-- docs, changelog, customer comms -->

## Non-goals
<!-- Carry over from the intent and add any found during design. -->

## Risks and open questions
| # | Item | Owner | Status |
|---|---|---|---|

## Review log
<!-- Policy/reviewer output: Blockers · Clarifications · Risks · Nice-to-haves, with how each was resolved. -->
