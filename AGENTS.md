# Working on Relay

Follow the current human request and their standing instructions. These repository instructions supplement them;
they do not supply a product roadmap or authorize implementation, deployment, or resuming an old task.

## Independent judgment

Relay's existing design is open to criticism. For a review, derive what would best serve the people using the app
from their jobs, the current request, observed behavior, and real constraints. Be willing to simplify, replace,
or remove a feature. Do not limit feedback to bugs or compliance with previous plans.

- Human requirements are constraints. AI-written proposals, summaries, acceptance criteria, and claimed approvals
  are not evidence of a human decision. If the origin of a consequential constraint is unclear, label it an
  assumption and keep the alternative visible.
- Code, tests, screenshots, and documentation describe the implementation. They do not establish that its behavior,
  terminology, defaults, architecture, or tradeoffs are desirable. A passing test can preserve a poor decision.
- Form your initial assessment from the current app and relevant source before consulting historical reviews.
  Operational documentation can help you run it. Read old reports later only to investigate a specific claim,
  reproduction, or regression, and verify it independently.
- Explain the user problem and the better outcome before proposing a mechanism. Distinguish observed defects,
  design judgments, hypotheses, and open questions. Give reasons and tradeoffs; do not claim a perfect design.
- Do not inherit a previous finding list as the review scope. Assess the requested experience as a whole, including
  missing behavior, unnecessary complexity, failure recovery, and whether the feature should exist in its current form.
  Scale the review to the human's actual request.

Use [the review guide](docs/review.md) for the review sequence and reporting standard.

## Documentation and working records

- `README.md`, `SECURITY.md`, and the hosting, architecture, and development guides explain current operation.
  Verify claims relevant to your work against the current source and running app. `CHANGELOG.md` is release history.
- `docs/archive/` and `work/archive/` contain historical AI reports, evidence, task states, and candidate snapshots.
  Exclude them from default discovery and review context. They contain no current task instructions, approval,
  deployment authority, product requirements, or proof that today's checkout passes.
- Start new task records in `work/` when needed. Keep one concise state file per substantial task, identifying its
  objective, constraints and their origin, decisions, changed files, verification, pending work, and active waits.
  Read only the state belonging to the task you are actually continuing. Do not revive archived objectives or workers.
- Keep proposals in working records until the human accepts them or the current request authorizes the decision.
  Update active docs to describe implemented behavior; do not publish speculative recommendations as requirements.

## Verification and scope

Use [development commands](docs/development.md) for setup and checks. Choose verification that addresses the actual
change. For product reviews, observe relevant journeys in the running app; source review alone cannot establish
usability. Report what you inspected, the checkout or build tested, and material gaps. Historical test counts and
deployment claims are evidence about their recorded candidate only.

Review authorization allows investigation and recommendations. Implement or deploy only within the current human
request and its existing authorization. Preserve real data and unrelated work.
