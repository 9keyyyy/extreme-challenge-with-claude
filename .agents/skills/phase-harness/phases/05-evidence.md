# 05 Evidence

Purpose: collect proof that the phase achieved its goal.

Read:

- `.harness/artifacts/03-plan.md`
- `.harness/artifacts/04-implementation.md`
- Test, benchmark, audit, smoke, or manual check output produced during implementation.

Evidence can be performance data, correctness checks, consistency checks, operational proof, or deployment smoke results. Use the evidence type that matches the phase.

Examples:

- Performance phase: EXPLAIN ANALYZE, p95/p99, throughput, before/after latency.
- Consistency phase: duplicate prevention, retry behavior, drift audit, consumer replay.
- Infra phase: health checks, failover behavior, routing, dashboard/trace visibility.
- Feature phase: API tests, state transition tests, validation errors, manual smoke.

Produce `.harness/artifacts/05-evidence.md` with:

````markdown
# 05 Evidence

## Evidence Summary

| Claim | Evidence | Result | Notes |
|-------|----------|--------|-------|
| ... | ... | ... | ... |

## Performance Data

Include only when the phase has performance goals.

| Metric | Before | After | Interpretation |
|--------|--------|-------|----------------|
| ... | ... | ... | ... |

## Raw Commands

```bash
...
```

## Validity Notes

- Dataset:
- Environment:
- Limitations:
````

For performance claims, use comparable before/after values. For non-performance claims, use claim/evidence/result rows instead of forcing fake metrics.
