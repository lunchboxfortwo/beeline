# Workspace handle proof

Reproduction handle-1: creating a workspace after another workspace exists gave its starter agents globally numbered handles.

Build the server (`npm run corner:prepare`, then `npm run build --workspace=@beeline/server`) and run:

```
node --import tsx scripts/prove-workspace-handles.mjs --before
node --import tsx scripts/prove-workspace-handles.mjs
```

The before mode compiles the starter allocator from baseline `074b6c186` against the isolated current schema. Its second workspace gets `beebee_2` and `luna_2`. The passing mode uses the built service, creates two workspaces, checks both member-list responses for plain handles, sends `@luna hello`, and checks the committed command recipient and phone transcript mention identity. No Fly Machine is provisioned.

Storage uses isolated PGlite, since a production workspace would exercise the deployed server rather than this branch. This is a built service proof, not a production deployment claim.

[Before](before.png) and [after](after.png) show the actual `MemberRosterRow`, `IndexRow` and identity marks rendered on web in Bone from those server member-list responses. The small capture harness supplies theme tokens through a Unistyles shim and stubs inactive motion; it is not a capture of the full signed-in Members route. The entry heading is harness chrome. No mobile UI source changed.

Regression coverage: `free-agents.test.ts` (`handle-1`), `workspace-handles.test.ts` (local clashes, cross-workspace joins and DM arrivals, migration replay, old numbered tags, rename/departure stability and global person claim refusal), plus `identity-live.e2e.test.ts` (agent identity invalidation must preserve workspace handles).

Review repair, Reproduction handle-1 retry: a parent Room member reserves `beta`, while an outsider has global fallback `beta`. Creating a corner with local `beta` succeeds, but the identical retry previously threw an implementer assignment conflict. `corner-open-implementer.test.ts` reproduces that failure before the fix and passes after it. The retry lookup now validates only the recorded original assignee against its stable Room-workspace address. New corner assignments still require current parent Room membership.

A temporary harness compiled that regression against the built PhoneService and DaemonService with isolated PGlite and the registered-helper fixture. The repeated `createCorner` returned the original corner, created no extra records and dispatched only the local agent. Production cannot prove this unmerged branch; this direct built-service path is the stand-in. The original built handle-1 workspace/member-list/tag proof also passes. Focused corner-opening and workspace-handle suites pass (15 tests); server build and whitespace checks pass. Full repository tests remain deferred to CI.

CI follow-up, Reproduction F1-11: an identical createCorner retry after its implementer leaves the parent Room must return the original corner. The current-membership-only retry failed this existing regression with an assignment conflict. Retry validation now restricts identity lookup to the original assignee and checks its stable workspace address, preserving replay after departure while preventing outsider selection. New assignments retain their membership check. The full corner-lifecycle and corner-open-implementer files pass (58 tests). The temporary built-service collision harness additionally removes the implementer, retries successfully and restores membership; the original handle-1 proof passes again. No tests added or disabled for this follow-up.
