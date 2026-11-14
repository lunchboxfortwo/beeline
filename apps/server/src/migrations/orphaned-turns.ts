import type { SqlDatabase } from '../database.js';

// Read-only production inventory, 2026-11-14. Match the original start as well
// as the key: a redelivered execution of the same item must survive this repair.
const jellybean='7eafb2e0cc049a9b3345f4322024b604358af04cb551d1fc71084ca3a99d7877';
export const ORPHANED_TURNS = [
  ['cd760c7d-4b47-4e41-8be1-1fca7000f1e0','cd97f56de647f6cd83e50ea3fa1454405b65b0d3a7a45b7db45d7b877d7fd1e4','6f8ed99367d0d0db22df5abc5c482a1afa2ce3718577a54b258734f9f36cf4c2','2026-10-28T03:19:36.078754Z'],
  ['46cc4734-8d5b-4ede-85b0-5abca10e2be0','08b1a2900f9548ba5208337cba29c8f58d7d367b5e3415fe6dee04b920ab8501',jellybean,'2026-11-14T06:55:26.747415Z'],
  ['04ba3b15-dbfc-4ebd-a256-b56065e1aa50','08b1a2900f9548ba5208337cba29c8f58d7d367b5e3415fe6dee04b920ab8501',jellybean,'2026-11-14T06:55:43.882094Z'],
  ['b725c661-9cc8-485a-b8e7-be4935081bf7','6a923d781693289ef262e322482848cf05ebe41474586dbfa7704cdd184ff214',jellybean,'2026-11-14T07:00:37.458985Z'],
  ['a12df0b7-e6a9-4652-9770-5daf172abd68','0c4319a12781ac5f3c11713dc8e39775e4b301ab5728f78794eed2fe96060248',jellybean,'2026-11-14T07:00:53.546670Z'],
  ['e258bdba-08bc-4d05-bbbe-2c1ef873a1f7','d5a3c70241b75851fc38a958c97cbb5f785031e34b883e7e3ab83dcc5c87447b','c3dfbf8acbb4b6e9f11bd37119a5ce2f4f104257885d098d8e075c0b0c4c066b','2026-11-14T07:03:35.766085Z'],
  ['4783db80-0354-4972-9bbe-f56c16c133a3','50adf91f1cd83800bef0f4ecbac2f9e1a82ccefcb64d44b4124434b7f4806960',jellybean,'2026-11-14T13:45:32.135264Z'],
  ['2e880083-e5c9-4ce8-9fdb-116abb3dbd11','e6048f611f23dade6d6f3bc3dfa181a7b92192c3987d95fe285bceae81e8f49f',jellybean,'2026-11-14T14:58:27.010937Z'],
] as const;

export async function repairOrphanedTurns(database: SqlDatabase): Promise<void> {
  await database.transaction(async db=>{
    for(const [room,request,agent,started] of ORPHANED_TURNS)
      await db.query('SELECT * FROM beeline_interrupt_agent_turn($1,$2,$3,NULL,$4)',[agent,room,request,started]);
  });
}
