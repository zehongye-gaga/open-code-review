# Large PR budget cases

Recorded on 2026-10-26 from production state on `10.2.46.202`. These are
observational benchmark candidates, not confirmed code defects. Statuses below
are snapshots; use the job IDs and commit SHAs to join subsequent audit records.
Never combine different commits as the same review sample.

| Repository / PR | Job ID | Commit | Observed state | Budget history |
| --- | --- | --- | --- | --- |
| [super-webapp #8](https://github.com/lexmount/super-webapp/pull/8) | 1791879625039 | `2ab3501ed0fd44811869840349f08430287af8ab` | Budget guard failure, attempt 4, 2026-10-26 09:45:30 UTC | 500k → 1m → 2m → 4m; still incomplete |
| [lex-voice #270](https://github.com/lexmount/lex-voice/pull/270) | 1791879625040 | `d0830b996ae9fb6fdab83231360ad002554eee5a` | Budget guard failure, attempt 4, 2026-10-26 09:42:55 UTC | 500k → 1m → 2m → 4m; still incomplete |
| [insight-flow #1600](https://github.com/lexmount/insight-flow/pull/1600) | 1791879625053 | `198b832bf409e3dd721baae28d5623ede41e466a` | Running, attempt 1 at observation | Latest commit supersedes historical job 1791879625035; do not resume the old snapshot |

## Policy change

After a finite budget of at least 2m is exhausted, authorized retries use zero
(unlimited aggregate token budget) and resume compatible saved native sessions.
An unlimited budget is not zero usage. Timeouts and attempt limits still apply.
This policy change alone does not requeue historical terminal jobs.

## Follow-up measurements

Join job and native session records to capture actual OCR input/output tokens,
Agent and sub-agent tokens separately, selected/completed work, wall time,
budget retry transitions, resume session IDs, final publication outcome and
subsequent fixes/resolutions. Missing measurements must remain unknown, not zero.
Compare continuation overhead and completed coverage with full reruns; do not
infer correctness merely from a resolved thread or successful execution.
