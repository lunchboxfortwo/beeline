# Server health evidence, 7 November 2026

Status: **factory hypothesis dropped; retained-special-case census classified and reconciled**.
No server behavior, authorization, transaction setup, or regression test changed.

## Service boundary comparison

Measured from the repository's squash-merge commits, comparing each commit to its
first parent. An edit means a contiguous `git diff --unified=0` hunk, including
imports, documentation and tests. It does not mean one semantic requirement.
The per-file hunk ledger is in `cochange-counts.json`.

| PR | Merge commit | Files | Edits | Added/deleted lines | Server files/edits |
| --- | --- | ---: | ---: | ---: | ---: |
| 3991 | f82f7635f5fa7c5d07dc2d61ca07e6abf26e4b0a | 204 | 956 | 4872/4407 | 185/911 |
| 4037 | 8a264fe5d51e04136080b5511bb0ae12dc6ff741 | 3 | 10 | 38/39 | 3/10 |
| 4062 | 09738b4fbdd25a02421dea58671f6903e921155c | 43 | 128 | 371/264 | 24/87 |

Counterfactual design: one typed factory receives existing service dependencies
and installs transaction-local database, command, buffered live hub, embedding
and post-commit queue. It replaces positional dependency construction, including
the unused provider slots. It does not absorb operation arguments, authorization,
SQL ownership, projection behavior or schema migrations. Expanding it to own those
would change the hypothesis and erase the safety boundaries being assessed.

| PR | Same-change counterfactual file/edit estimate | Reason |
| --- | --- | --- |
| 3991 | 204/956 | Native SQL, row ownership, unique indexes, migration version, fixtures and error telemetry still change. `daemon/execute.ts` removes an advisory query and an authorization argument. `phone/command-context.ts` changes stop authorization. Neither is dependency forwarding. `database.ts` and `database-migrate.ts` retain different runtime and migration ownership. |
| 4037 | 3/10 | The receipt query and return projection still change in `phone/mention-notices.ts`; callers still pass the routing flag and remove the separate read in `phone/messages.ts`; the facade still drops the removed helper/import. A scope factory does not combine the query or remove the public helper. |
| 4062 | 43/128 | Report recipient selection, hash inputs and commander return rules still change. The daemon facade and dispatcher remove the operation-specific `to` argument; it is not a service dependency. Tests, schema shape, prompts and MCP tools still need the same edits. |

These are **static counterfactual estimates**, not measurements from an implemented
alternative. The observed positional construction in `daemon/execute.ts` forwards
existing dependencies, but none of these three diffs changes that construction.
Demonstrated savings: **zero of three**, below the required two. Do not ship the
factory on this evidence. This rejects this proposal for these samples; it does
not establish that no future dependency addition could benefit from a factory.

A replay against a real alternate implementation has not been performed. No
claim is made that the hunk estimates prove a lower bound for every conceivable
redesign. The generation/cancellation, Room access, commit-before-provider,
post-commit task and phone reply regressions remain untouched.

## Complete retained-special-case census

The server-area score is **3701 retained special-case sites**, after excluding
**18122 ordinary control-flow sites** from **21823 discovered sites**. All sites
have a category, disposition and reason in `semantic-sites.csv`; no site remains
marked for future classification. `semantic-score.json` reconciles the totals
and lists every source file with its content hash and counts.

This is a **rule-adjudicated retained-behavior baseline**, not a defect count,
proof that every retained site is irreducible, or a promise that a different
system design could never remove one. The current brief allows no behavior
change; absent a demonstrated redesign, required domain/recovery behavior stays.
The confirmed avoidable compatibility cases are two unused provider slots and
three update-mode parameters that only forward a flag to an implementation which
never reads it. They remain untouched; this audit does not authorize a new cleanup.

| Disposition | Sites | Meaning |
| --- | ---: | --- |
| Retained value/protocol/provider policy | 2551 | A concrete operation, status, identity kind, provider, accepted vocabulary or other domain choice selects behavior. |
| Retained SQL policy | 488 | SQL CASE, procedural IF/ELSIF and SQL exception conditions select persisted/projection behavior. |
| Retained caller policy | 205 | A parameter explicitly couples a general boundary to command ownership, provider protocol, discovery, zero-check confirmation or post-commit timing. |
| Retained input policy | 60 | A specific malformed/foreign input path refuses, omits or skips a candidate rather than accepting partial data. |
| Retained recovery behavior | 325 | A secondary failure is isolated, logged, parked, cancelled or given an explicit fallback; it must not replay or replace the primary effect. |
| Avoidable compatibility parameters | 5 | Two unused provider slots and three forwarded-but-unused connection update flags. |
| Retained proof waits | 18 | Offline browser/cutover proof synchronization and bounded observation. |
| Retained presentation waits | 2 | Intentional opponent-move pacing in the offline game asset. |
| Retained test environment gates | 47 | Real PostgreSQL/browser/live-wallet proofs require their actual target or explicit opt-in. These are conditional tests, not unconditional disabled tests. |
| Total retained | 3701 | Includes server scripts, test gates and served assets as well as serving TypeScript. |
| Ordinary control flow, excluded | 18122 | Type/presence/bounds/identity checks, normal parameters, rethrowing/error-reporting boundaries, idempotent DDL/upserts, deduplication and authorized due-time scheduling. |

The syntactic categories reconcile to the same retained total:
value-specific branches (2523), explicit sets (28), exception handlers (385),
caller parameters (210, including five avoidable compatibility parameters), SQL policy sites
(488), proof/presentation waits (20), and conditional test gates (47).

### Reproduction and classification rules

Run from the repository root:

```sh
node data/server-health-2026-11-07/inventory.mjs
node data/server-health-2026-11-07/adjudicate.mjs
python3 data/server-health-2026-11-07/verify.py
```

The input is pinned to `00b345c83b2ad74cb0eacd496c02a3e2d66a4984`, so rerunning
on a later PR head does not silently change the denominator. The inventory reads
Git objects in one batch, not whichever checkout happens to be present. It
accounts for all 927 files: 834 parsed JS/TS/HTML files and 93 explicitly listed
non-code files. The latter are static assets, declarative data, documentation,
metadata, the build recipe and proof/test SQL fixtures; the fixture bodies are
not serving behavior. Test/fixture JS/TS bodies contribute test-disable gates,
not the artificial business scenarios they simulate.

The census rubric is drawn from value-specific branches, caller-specific
parameters, swallowed exceptions, retries/sleeps and disabled tests:
https://github.com/caldoai/skills/blob/main/skills/untangle-codebase/SKILL.md
Only its taxonomy is used; its broad refactor instructions are outside this brief.

`adjudicate.mjs` contains the authored semantic rules. It separates primitive
validation and normal collection/argument handling from explicit domain choices;
the exact per-site `parameter-adjudications.json` records the workflow requirement
or ordinary-data reason for every mode/control parameter. A parameter is not
special merely because it is boolean. Unknown modes now stop generation instead
of being silently classified by name. Named rejection observers whose original promise still has a failure consumer are
excluded. `adjudication-overrides.json` records concrete reasons for the original
cache/release/rollback boundaries, post-commit tasks and the mixed attachment
access-denial path. The rule-based process is explicit: this is not a claim that
an independent person manually read every row. Review can dispute a particular
classification using its source location and reason.

The resulting unit is a source site, not a requirement or a line of code. A
compound predicate is one site. Each switch arm, explicit finite set, special
parameter declaration, exception handler, SQL condition opener, wait invocation,
and conditional-test gate is a site. Repeated declarations in a facade and its
implementation are separate sites. A timer implementing a counted sleep helper
is excluded to avoid counting the helper and invocation as two waits.

### Coverage of the first scan's gaps

- Every `if`, conditional expression and switch arm is discovered before ordinary
  guards are excluded. Constants and enums are considered as well as literals.
- Every parameter is discovered, including non-boolean `authorizedCommand`,
  enrichment pool and deferred callbacks. The explicit parameter catalog
  distinguishes protocol/transaction coupling from ordinary domain inputs; each entry is matched by file, line, column, owner
  and parameter text. See `parameter-audit.md` for the closed audit set.
- Every catch and Promise catch is discovered. Conditional throws and nested
  callback throws do not hide swallowed paths. Only a final unconditional throw
  without an early return/break/continue proves propagation. The mixed
  `AccessDeniedError` continue/throw at `daemon/message-reads.ts:203` stays counted.
  Raw predicate newlines are preserved, so `//` comments cannot erase later guards.
- Curried `skipIf`/`runIf` calls count their gate once. The previous (95) syntactic
  call matches reduce to (47) real conditional gates. The source search found no
  unconditional skip/todo, commented-out test definition, or xit/xdescribe site.
- Timer/import/retry searches distinguish Machine suspension, the owner clock,
  offline proof waits, user-triggered retries and disabled SDK retries
  (`object-storage.ts` sets retries to zero). The first two are not sleeps.
  Aliased real timers occur in test bodies, outside runtime retry scoring.
- Embedded `<script>` bodies, named script constants and HTML assets are parsed,
  not treated as opaque strings. Interpolation is masked with source-position
  mapping; parse failures stop generation. This includes consent scripts and the
  game asset, whose pacing waits are separately labelled.
- Embedded SQL comments, quoted values and TS interpolation are masked before
  discovering CASE, procedural IF/ELSIF and exception policies. Ordinary
  `IF [NOT] EXISTS` DDL and `ON CONFLICT` mechanics are excluded. SQL fragments
  starting with CASE are included even without SELECT in the fragment.

`semantic-markers.txt` is the additional compatibility/fallback/workaround search.
The literal policies it points to are represented in the source ledger; prose,
retained storage/schema names and protocol identifiers are not treated as a
special runtime branch merely because their spelling contains “legacy”.

The old aggregate of twenty sites has no attached individual ledger and used a
three-file scope. Do not invent a one-to-one mapping or a before/after trend.
The new ledger covers every discovered site in those boundary files as part of
the whole-area baseline, including optional-cache setup and both legacy slots.
The earlier v1 score (3561) undercounted mode parameters and is superseded by
`server-retained-special-cases-v2` (3701); this is a classification correction,
not an increase in server complexity. A future comparison must use the same
pinned grammar and semantic rule version, or restate both snapshots under the new rules.

### Verdict

Drop the factory hypothesis for these samples: no demonstrated savings in the
required two of three. Keep existing server behavior. Use the complete retained
census and file ledger above as the new whole-server baseline, without presenting
required behavior as a confirmed defect or the score as a minimum possible size.

## Validation

- Corner preparation passed.
- All source and extracted-script parsers completed without diagnostics.
- `verify.py` independently reads a Git archive, checks the content hashes and
  accounts for every file, row, category, disposition and exclusion.
- Targeted delivered-ledger checks cover the archived-target, parent-order and
  Claude/Codex consent modes, both unused slots, unused update-mode forwarding,
  nested and enum controls, ordinary payload/sort parameters, mixed continue/throw
  handling, raw-comment parsing, primary-error propagation, rollback isolation,
  Machine suspension, the due-time clock, deduplicated environment gates,
  embedded consent/game scripts and procedural SQL conditions.
- Removing a mode decision from a scratch copy of the catalog makes the actual
  generator refuse with the missing site, rather than publishing a lower score.
- A second end-to-end generation is byte-identical at the pinned source SHA.
- Historical first-parent diff counters reproduce the committed file/hunk ledger.
- Server suites, built-service proof and disproof regressions were not run:
  this change only adds audit data and offline analyzers. No refactor or runtime
  behavior change is proposed. Offline pipeline execution is the user path.

This is not a defect report. No production reproduction is claimed.
