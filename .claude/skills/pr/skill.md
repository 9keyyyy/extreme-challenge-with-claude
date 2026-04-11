---
name: pr
description: Commit, push, and open a PR. Use when the user asks to create a PR (e.g. "PR 만들어줘", "PR 생성해줘", "풀리퀘 올려줘").
argument-hint: "[issue-number]"
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git branch:*), Bash(git push:*), Bash(gh pr create:*), Bash(gh pr edit:*)
---

# PR Creation Skill

## Input

`$ARGUMENTS`

Format: `<issue-number>` (optional)
Examples:
- `/pr 42` → PR 생성 후 GitHub Issue #42와 development 연동 (PR merge 시 자동 close)
- `/pr` → issue 연동 없이 PR 생성

## Current Git Context

Current git status: !git status
Current git diff (staged and unstaged changes): !git diff HEAD
Current branch: !git branch --show-current
Recent commits since branching: !git log --oneline origin/main..HEAD

---

## Base Branch Detection

Determine the base branch using this priority:
1. If the project CLAUDE.md specifies a main/base branch, use that
2. Try `git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||'`
3. Default: `main`

---

## Pre-checks

1. Verify current branch is NOT the base branch — if on base branch, warn and abort
2. Check for uncommitted changes — if any, warn the user to run `/commit` first

---

## PR Template

`.github/PULL_REQUEST_TEMPLATE.md` 를 기반으로 아래 항목을 채워 PR body를 작성한다.
issue-number가 제공된 경우, Background 아래에 `Closes #N` 을 추가한다 — GitHub이 이를 인식해 PR merge 시 issue를 자동 close하고 development 패널에 연동한다.

```markdown
## Background

{이 PR의 배경. 어떤 Phase인지, 무엇을 목표로 했는지. 1~3줄.}

Closes #{issue-number}   ← issue-number가 있을 때만 포함

## 구현 내용

{무엇을 구현했는지. 핵심 변경 사항을 번호 목록으로.}

1. ...

## 설계 결정 & 트레이드오프

{왜 이 방식을 선택했는지. 고려한 대안과 포기한 이유.}

| 결정 | 이유 | 포기한 대안 |
|------|------|------------|
| ... | ... | ... |

## 성능 측정

{최적화 전/후 수치. 목표 대비 실제 결과. 해당 없으면 "N/A"}

| 지표 | 목표 | Before | After |
|------|------|--------|-------|
| TPS | ... | ... | ... |
| P99 Latency | ... | ... | ... |

## 참고 자료

- ...

## 코멘트

{리뷰어나 미래의 나에게 전달할 메모. 없으면 생략.}
```

**작성 원칙**: diff를 나열하지 않는다. 변경의 *무엇(What)*, *왜(Why)*, *어떻게(How)* 를 서술해 코드를 읽지 않아도 맥락을 파악할 수 있게 쓴다.

---

## Procedure

### Step 1: Analyze
- 위 git context를 바탕으로 변경 내용 파악
- 필요 시 변경된 파일 직접 읽어 context 보완
- PR 제목(한국어, 명령문, 50자 이내)과 body 초안 작성

### Step 2: Preview & confirm
다음을 사용자에게 보여주고 승인 대기:
- PR 제목
- PR body 미리보기
- `{base_branch}` ← `{current_branch}`

승인 시 Step 3 진행, 수정 요청 시 재작성 후 재확인.

### Step 3: Push & create PR
```bash
git push -u origin {current_branch}
gh pr create --base {base_branch} --title "{title}" --body "{body}"
```

### Step 4: Report
- PR URL
- 제목
- base ← head 브랜치명
