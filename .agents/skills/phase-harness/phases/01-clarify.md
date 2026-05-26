# 01 Clarify

Purpose: turn the user's phase request into a precise implementation scope.

Read:

- The user request.
- The target phase file under `docs/superpowers/plans/phases/`.
- The previous and next phase summaries when they affect prerequisites.

Produce `.harness/artifacts/01-clarify.md` with:

```markdown
# 01 Clarify

## Requested Scope

- Phase:
- Tasks:
- Explicit user constraints:

## Assumptions

- ...

## Questions

- Required before implementation:
- Can proceed with assumption:

## User Decisions

- ...
```

Ask the user only for decisions that materially change implementation, risk, measurements, or documentation. If a reasonable assumption is safe, state it and continue.
