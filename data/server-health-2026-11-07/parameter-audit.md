# Parameter mode adjudication, revision 2

The previous name allowlist confused lack of an entry with proof that a parameter
was ordinary. That produced false exclusions for `commandAddress.allowArchived`,
`assertCornerCommandTarget.allowParentOrder`, and
`sessionMessageConsent.fallback`. These are retained caller policies, just like
the already-counted `codex` consent selector.

The correction audits the entire detected mode/control set, not just those three
names. The pinned source contains boolean modes (175), non-null literal selectors
(48), and nested flag/predicate parameter records (62). Their exact sites (285),
plus the other already-identified caller/compatibility parameter sites (15), have
explicit decisions in `parameter-adjudications.json` (300 entries). Ordinary
parameter decisions (90) have concrete data/algorithm reasons; retained caller
policies (205) and avoidable compatibility parameters (5) stay in the score.

Each record binds file, line, column, owner and complete parameter text. The
collector derives mode kind from the AST, not the parameter's name. The generator
requires an entry for every detected mode and rejects stale or unused entries.
A new boolean flag, enum selector or nested boolean control cannot silently fall
through to ordinary control flow. Literal/nullability alone does not make an
ordinary identifier or nullable data value a mode. The closed mode set uses explicit boolean/literal signatures and nested controls;
protocol DTO/type references remain domain inputs unless they have a separately
identified caller-policy record.

The remaining excluded boolean modes were checked against their implementations,
SQL bindings and facade targets. The expanded audit includes:

- Archived-target and parent-order access exceptions, scheduler corner access,
  Room-member cancellation authority, identity recovery and deleted-root lookup.
- Effect-fence registration, draining all pending commands, one-shot grant
  consumption, deferred notification/wake ownership and final activation locks.
- Historical/bulk/external owed projections, family-view ordering, dependent
  connection resumption, bounded backfills and apply-versus-inspect maintenance.
- Provider consent, REST version exceptions, organization installation-verification
  fallback, OAuth-only account routes, team creation and two-phase pairing.
- Voice final/intermediate routing, interruption and terminal metering modes,
  background recovery origin and fenced disconnect/inactivity cleanup.

Some booleans are data rather than exception selectors. `advance.started` is an
observed occurrence outcome used to increment a count; `failed` in the metric
writer is inserted as an observed result; promise resolution `value` and `renewed`
carry observed outcomes. Ordinary sort direction and active/archive list filters
are not authority exceptions. In particular, archive-list selection retains the
same viewer authorization, whereas `commandAddress.allowArchived` deliberately
permits an archived target in the membership lookup. Each distinction has its own
site record; it is not inferred from a shared name.

The audit also traced `forUpdate` from `DaemonAgentSession.close` through
`ConnectionPresence.releaseConnection` into `releaseAgentConnection`. The last
implementation never reads the parameter. The two forwarding declarations and
the terminal declaration are avoidable compatibility surplus (3 sites), in
addition to the two previously identified provider slots. They are recorded,
not removed: the brief rejects an unmeasured refactor and requires no behavior
change.

The score changes from v1 (3561) to v2 (3701): newly counted parameter sites (140),
including retained controls (137) and unused compatibility arguments (3). Every
other category and the source snapshot are unchanged. This is a corrected
classification baseline, not measured code growth or a newly shipped defect.

Delivered-ledger checks assert the reviewer's three examples, the matching Codex
selector, related authority/effect/nested/enum controls, ordinary payload and sort
inputs, and the unused update-mode chain. A negative end-to-end check removes
`allowArchived`'s decision from a scratch catalog and verifies that generation
fails on that exact site. Reconciliation alone is not treated as semantic proof.
