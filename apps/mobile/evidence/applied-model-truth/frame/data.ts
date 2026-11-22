// Server views for the same agents row (selected gpt-6.2-astra, stale catalog
// current value gpt-6.2-astra, session running gpt-6-sol). "before" is what
// main returns; "after" is what running-model.integration.test.ts asserts.
const EMBERUS = 'e'.repeat(64), OWNER = 'a'.repeat(64);
const catalog = [{ id: 'model', category: 'model', currentValue: 'gpt-6.2-astra',
  options: [{ id: 'gpt-6.2-astra', name: '6.2 Astra' }, { id: 'gpt-6-sol', name: '6 Sol' }] }];
export function fixture(after: boolean) {
  const model = after ? '6 Sol' : '6.2 Astra';
  const agent = { identity: { pubkey: EMBERUS, kind: 'agent', name: 'Emberus', handle: 'emberus', face: 'fox' }, role: 'member', model };
  const owner = { pubkey: OWNER, kind: 'human', name: 'lunchboxfortwo', handle: 'lunchboxfortwo' };
  const detail = {
    workspaceId: 'w', agent, owner, catalog, harness: 'codex', watchFilters: [], rooms: [{ id: 'room', name: 'beeline' }],
    selected: { model: 'gpt-6.2-astra' },
    runtimeSelection: { model: after ? 'gpt-6-sol' : 'gpt-6.2-astra' },
    access: { policy: 'everyone', canChange: true }, yolo: { enabled: false, canChange: true },
    ...(after ? { modelUnavailable: 'model', modelMismatch: { selected: 'gpt-6.2-astra', running: 'gpt-6-sol',
      reason: "This agent's harness does not offer gpt-6.2-astra." } } : {}),
  };
  return {
    room: { room: { id: 'room', workspaceId: 'w', name: 'beeline', visibility: 'public' },
      members: [{ identity: { pubkey: OWNER, kind: 'human', name: 'lunchboxfortwo', handle: 'lunchboxfortwo' }, role: 'owner' }, agent],
      viewer: { permissions: { manage: false, send: true } } },
    roster: { surface: { workspace: { name: 'Beeline' }, viewer: { permissions: { manage: false } } }, scope: 'scope', agents: [agent] },
    record: { ...agent, owner },
    profile: {
      detail, workspaceId: 'w', loading: false, error: null, busy: false, working: null,
      canEdit: true, canRemove: false, ownerByline: 'by @lunchboxfortwo', soul: 'Emberus reviews plans adversarially.',
      editing: false, handleDraft: 'emberus', handleError: null, soulDraft: '', setHandleDraft() {}, setSoulDraft() {},
      beginEdit() {}, cancelEdit() {}, saveEdit() {}, close() {}, message() {},
      modelAxes: { model: catalog[0], effort: undefined, fast: undefined }, openModelAxis: null, closeModelAxis() {},
      modelSearchQuery: '', setModelSearchQuery() {}, modelAppliesNote: null, modelAxisError: null,
      toggleModelAxis() {}, setModelOption() {}, setFastMode() {}, toggleAnswersEveryone() {},
      toggleYolo() {}, removeAgent() {}, accessError: null, yoloError: null, refreshUsage() {}, saveWake() {}, voiceApi: undefined,
    },
  };
}
