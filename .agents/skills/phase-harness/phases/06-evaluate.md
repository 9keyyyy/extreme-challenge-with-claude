# 06 Evaluate

Purpose: verify the final result like a senior reviewer.

Read:

- All `.harness/artifacts/*.md`
- Current git diff.
- Test output.
- `.harness/artifacts/05-evidence.md`

Run or confirm:

- Targeted tests.
- Broader tests when shared contracts changed.
- Lint/type checks when the project uses them.
- Manual API/DB/benchmark/audit commands required by the phase.
- Final senior-style review, using a subagent when authorized and available.

Produce `.harness/artifacts/06-evaluation.md` with:

```markdown
# 06 Evaluation

## Checks Run

| Check | Result | Notes |
|-------|--------|-------|
| ... | ... | ... |

## Evidence Review

- Strong evidence:
- Weak or missing evidence:
- Measurement limitations:

## Review Findings

- Must fix:
- Optional:
- Deferred:

## Residual Risk

- ...
```

Fix material findings before reporting completion. If something cannot be fixed or verified, state the reason plainly.
