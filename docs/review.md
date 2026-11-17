# Reviewing Relay

A review should help decide what Relay should become. Closing an old AI finding list or matching the current
implementation is insufficient. Use the current human request to set scope, then reason independently about the
experience and the engineering needed to support it.

## Start with people and outcomes

State who is trying to do what, in which situation, and what success would look like. Trace any binding requirement
to the human's instructions. If the user, deployment, or constraint is inferred, say so. Do not manufacture a
product specification from previous AI prose.

Describe the simplest coherent experience you would recommend for that job, with reasons. Consider whether steps,
concepts, settings, and features earn their place. Existing names, screens, storage rules, and protocols are design
choices you may challenge. Account for security, data durability, accessibility, performance, and recovery when
judging the alternatives. No single ideal design can be assumed without understanding the user's priorities.

## Inspect the present experience independently

Use the operating guides to run a disposable instance. Observe the journeys relevant to the request, including
failure and recovery, rather than only the happy path. Inspect the source and tests that explain the behavior.
For interface judgments, capture the relevant rendered states. If running the app is unavailable, disclose that
limitation and keep usability claims provisional.

Write the first assessment before reading earlier review conclusions. Ask both whether the implementation is
correct and whether its intended behavior is a good choice. Tests help establish repeatable behavior; their
expectations can themselves be wrong or undesirable.

Read [historical evidence](archive/README.md) afterward only when a specific past claim matters. Reproduce it against
the current candidate before adopting it. A previous fix, passing suite, deployment, or claimed approval establishes
neither current correctness nor product quality.

## Give candid, actionable feedback

For each material concern, explain:

- The situation and user consequence, with observed evidence where available.
- Whether it is a reproduced defect, a reasoned design criticism, or a hypothesis needing verification.
- The outcome you recommend, why it is better, and meaningful tradeoffs or alternatives.
- The smallest useful way to validate that outcome; do not merely encode the proposed implementation in a test.

Include strengths when the evidence supports them. Prioritize by harm, frequency, and importance to the requested
job. Distinguish necessary corrections from worthwhile improvements and preference-dependent choices. Do not force
findings, invent certainty, or declare the app perfect because the known checks pass.

End with a clear recommendation and material limits: what you reviewed, which checkout or build you used, what you
actually ran, and what remains unobserved. Recommend substantial changes when warranted, while keeping implementation
and deployment within the human's authorized scope.
