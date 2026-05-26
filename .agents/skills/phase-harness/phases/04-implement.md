# 04 Implement

Purpose: execute the approved plan in small TDD slices.

Read:

- `.harness/artifacts/03-plan.md`
- `.harness/decisions.md` if present.
- Current git diff before each major slice.

Rules:

- Write or update tests first when the task has testable behavior.
- Confirm expected RED failure when practical.
- Implement the smallest GREEN change.
- Refactor only after tests pass.
- Preserve unrelated user changes.
- Update `.harness/tasks.json` when task tracking exists.

For evidence or infra work:

- Create the script, benchmark, migration, or command checklist before relying on it.
- Run the smallest check that proves the tool works.
- Capture raw output needed for the final progress note.

Append to `.harness/artifacts/04-implementation.md`:

```markdown
# 04 Implementation

## Completed Slices

- Slice:
  - Tests:
  - Code:
  - Evidence:

## Deviations From Plan

- ...

## Open Items

- ...
```
