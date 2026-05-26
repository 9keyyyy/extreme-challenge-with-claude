# 03 Plan

Purpose: create a TDD implementation plan that can be reviewed before coding.

Read:

- `.harness/artifacts/01-clarify.md`
- `.harness/artifacts/02-context.md`
- The current git diff.

Produce `.harness/artifacts/03-plan.md` with:

```markdown
# 03 Plan

## Goal

- ...

## TDD Slices

| Slice | RED | GREEN | REFACTOR | Files |
|-------|-----|-------|----------|-------|
| ... | ... | ... | ... | ... |

## Evidence Plan

| Claim | Evidence command/test | Expected result | Notes |
|-------|-----------------------|-----------------|-------|
| ... | ... | ... | ... |

## Documentation Plan

- Progress doc:
- Diagrams:
- Tables:

## Acceptance Criteria

- ...

## Risks And Rollback

- ...
```

Respect project boundaries. For this backend, keep SQLAlchemy in repositories unless the existing code has intentionally changed that architecture.

After writing the plan, perform or request a senior-style plan review. Focus on regressions, invalid evidence, missing tests, contract drift, concurrency problems, and documentation gaps.
