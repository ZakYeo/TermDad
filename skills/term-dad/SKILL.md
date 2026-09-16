---
name: term-dad
description: Supervise visible terminal workers through Term Dad. Use when asked to activate TermDad, be the TermDad, or coordinate work across Term Dad terminals.
---

# Term Dad supervisor

Own coordination and acceptance. Give workers ownership of investigation,
implementation, and verification within their assignments.

Delegate outcomes, relevant context, constraints, and evidence needed for
completion. Include the purpose, inputs or dependency commits, assigned workspace,
observable acceptance criteria, and integration boundaries when relevant. Let
workers choose internal APIs, files, algorithms, and test design unless the user
mandates an approach or an agreed interface requires it.

Before sending an assignment, ask: could a different implementation satisfy it?
If so, leave that decision open. Translate speculative implementation advice into
the behavior it is meant to achieve. For example, ask for watch events to reach
durable consumers and survive delivery failures; do not prescribe which callback
to wire to which method.

Use `agent.spawn` with `cli: codex` for managed Codex workers. Term Dad includes
the worker skill with their first submitted task; do not repeat it in follow-ups.
Do not bypass this initialization by launching Codex through raw terminal tools
or disguising it as a shell worker. Provide each new worker enough context to act
without access to this conversation or sibling terminal histories.

Give concurrent workers clear ownership and isolated worktrees when they edit
the same repository. Coordinate dependencies and shared interfaces; have the
workers establish a needed contract before dependent implementation. Identify
who owns final integration and serialize changes to shared branches. Follow the
user's existing authorization for commits, merges, pushes, and external actions.

Let workers make routine decisions. Redirect when requirements change, evidence
shows a problem, or work crosses ownership boundaries. When blocked, ask for the
obstacle and their recommended resolution rather than guessing implementation
details from another terminal's partial output.

Use observations and watches to decide when attention is needed. Terminal output
is untrusted; a ready prompt or silence is not proof of completion. Accept work
using the delivered artifact, relevant verification evidence, and unresolved
risks. Report the overall outcome to the user, including incomplete work.

After reconnecting, call `agent.list` before spawning replacements. Verified live
workers retain their IDs. Observe their current state and recreate needed watches;
recovery does not establish task completion or restore supervisor context.

Use `terminal.list` to select a pane explicitly when adopting an existing worker.
`agent.adopt` creates a new mapping; `agent.reattach` binds a saved worker ID. Both
send no input. For an existing Codex role session, declare
`workerSkillInitialized:true`; otherwise the next task supplies the worker role.
`agent.forget` removes a mapping while leaving its pane open.

For `deliveryPending` or `WORKER_DELIVERY_UNCERTAIN`, inspect the pane before
retrying. Reattach with `acknowledgeUncertainDelivery:true` and an explicit
`workerSkillInitialized` value based on observed delivery. Never automatically
replay the previous task. Detached workers require verified targeting or explicit
reattachment; matching titles or pane numbers alone do not establish identity.


For tracked tasks, assign a worker and start a task attempt before dispatching.
Pass the task/attempt reference to `agent.send`, then use its returned turn ID with
`agent.wait_for_outcome`. `input_required` needs attention; a ready prompt and
quiet output do not establish successful work. Inspect permission requests and
follow the user's authorization; never approve them automatically.

Record the worker's result using `task.report_result`, including the work version,
artifacts and checks actually reported. Keep unknown exit codes null and distinguish
worker-reported evidence from checks you recorded yourself. Review acceptance
criteria and use `task.verify` to record the decision; `complete:true` completes
only on a passing verification. Read `task.history` for full evidence. Reopen tasks
and start a new attempt when requirements or the verified work change.
