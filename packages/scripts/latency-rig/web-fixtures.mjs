/** Stable local-only inputs shared by seeding, capture and inventory validation. */
import { createHash } from 'node:crypto';
export const hash = (name) => createHash('sha256').update(`latency-web-v1:${name}`).digest('hex');
export const uuid = (name) => {
  const h = hash(name);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export const viewer = createHash('sha256').update('beeline:play-review-identity').digest('hex');
export const agent = hash('agent');
export const peer = hash('peer');
export const workspace = uuid('workspace');
export const alternateWorkspace = uuid('alternate-workspace');
// Keep this explicit: a new inventory entry must acquire a seeded scenario and
// a driver implementation, rather than inheriting a generic successful tap.
export const scenarios = {
  'open-room': 'conversation',
  'open-corner': 'corner',
  'switch-workspace': 'workspace',
  'create-room': 'conversation',
  'create-dm': 'peer',
  'create-corner': 'corner',
  'send-text': 'message',
  'send-attachment': 'attachment',
  'forward-message': 'message',
  'react-message': 'message',
  'bookmark-message': 'message',
  'report-message': 'message',
  'delete-message': 'message',
  'mark-read': 'unread',
  'mark-unread': 'unread',
  'rename-room': 'conversation',
  'leave-room': 'conversation',
  'close-corner': 'corner',
  'approve-merge': 'merge',
  'answer-approval': 'approval',
  'start-workflow': 'workflow',
  'handoff-workflow': 'workflow',
  'connect-app': 'connector',
  'choose-model': 'model',
  'change-yolo': 'model',
  'stop-turn': 'turn',
};
export function fixture(name) {
  if (!Object.hasOwn(scenarios, name)) throw new Error(`No web fixture: ${name}`);
  // Where the measured action starts.
  const route = ['switch-workspace', 'create-room', 'mark-read', 'mark-unread'].includes(name)
    ? '/beeline/channels'
    : ['choose-model', 'change-yolo', 'create-dm'].includes(name)
      ? '/beeline/agent-profile'
      : name === 'answer-approval'
        ? '/beeline/tray'
        : name === 'leave-room'
          ? '/beeline/chat-info'
          : '/beeline/chat/[channelId]';
  return {
    route,
    name,
    scenario: scenarios[name],
    workspaceId: workspace,
    roomId: uuid(`room:${name}`),
    cornerId: uuid(`corner:${name}`),
    messageId: hash(`message:${name}`),
    text: `Latency fixture ${name}`,
    grantId: uuid(`grant:${name}`),
  };
}
export const contract = {
  version: 1,
  name: 'latency-web',
  description: 'Local deterministic latency workflow',
  summary: 'Exercise local workflow feedback',
  roles: ['worker'],
  start: 'work',
  handoffs: {
    work: {
      role: 'worker',
      does: 'Hold the local fixture step',
      timeoutSeconds: 3600,
      requires: [],
      on: { done: 'done', timeout: 'failed' },
    },
    done: { kind: 'terminal', status: 'done', does: 'Finish the fixture' },
    failed: { kind: 'terminal', status: 'failed', does: 'End the fixture' },
  },
};
export async function seedWebFixtures(db) {
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'agent','Web Rig Agent','web-rig-agent'),($2,'human','Web Rig Peer','web-rig-peer')
    ON CONFLICT(id) DO NOTHING`,
    [agent, peer],
  );
  await db.query(
    `INSERT INTO agents(agent_id,owner_id,selected_model,model_catalog) VALUES($1,$2,'rig-a',$3::jsonb)
    ON CONFLICT(agent_id) DO UPDATE SET model_catalog=EXCLUDED.model_catalog`,
    [
      agent,
      viewer,
      JSON.stringify([
        {
          id: 'model',
          category: 'model',
          currentValue: 'rig-a',
          options: [
            { id: 'rig-a', name: 'Rig A' },
            { id: 'rig-b', name: 'Rig B' },
          ],
        },
      ]),
    ],
  );
  await db.query(`UPDATE agents SET soul=$2::jsonb WHERE agent_id=$1`, [
    agent,
    JSON.stringify({ name: 'Web Rig Agent', instructions: 'Local deterministic latency fixture.' }),
  ]);
  for (const [wid, name] of [
    [workspace, 'Web Latency Rig'],
    [alternateWorkspace, 'Web Latency Alternate'],
  ]) {
    await db.query(
      `INSERT INTO workspaces(id,name,visibility) VALUES($1,$2,'invite-only') ON CONFLICT(id) DO NOTHING`,
      [wid, name],
    );
    for (const who of [viewer, agent, peer])
      await db.query(
        `INSERT INTO memberships(workspace_id,identity_id,role)
      SELECT $1,$2,'owner' WHERE NOT EXISTS(SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2 AND removed_at IS NULL) ON CONFLICT DO NOTHING`,
        [wid, who],
      );
  }
  const artifactRoom = uuid('route-artifact-room');
  await db.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'web-route-artifact') ON CONFLICT(id) DO NOTHING`,
    [artifactRoom, workspace, viewer],
  );
  await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) SELECT $1,$2,$3,'owner' WHERE NOT EXISTS(SELECT 1 FROM memberships WHERE room_id=$2 AND identity_id=$3 AND removed_at IS NULL)`,
    [workspace, artifactRoom, viewer],
  );
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,$4,'2026-01-01T11:59:00Z') ON CONFLICT(id) DO UPDATE SET room_id=EXCLUDED.room_id`,
    [hash('route-code'), artifactRoom, viewer, '```text\nlatency route code\n```'],
  );
  // Metadata-only connector fixtures: no remote service, account or key is used.
  await db.query(
    `INSERT INTO workspace_connectors(id,workspace_id,owner_identity_id,connector_type,helper_agent_id,status,connected_at)
    VALUES($1,$2,$3,'registry-mcp',$4,'connected',now()) ON CONFLICT(id) DO NOTHING`,
    [uuid('route-connector'), workspace, viewer, agent],
  );
  await db.query(
    `INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,domain,transport,route,connector_id,authorised_at)
    VALUES($1,$2,$3,'latency-local','Local latency app','localhost','registry-mcp','registry-mcp',$4,now()) ON CONFLICT(id) DO NOTHING`,
    [uuid('route-app'), workspace, viewer, uuid('route-connector')],
  );
  await db.query(
    `INSERT INTO workspace_connections(id,connector_id,owner_identity_id,reference,service,label,hosts,last_synced_at)
    VALUES($1,$2,$3,'local-latency-metadata-only','latency-local','Local latency key','["localhost"]',now()) ON CONFLICT(id) DO NOTHING`,
    [uuid('route-key'), uuid('route-connector'), viewer],
  );
  for (const name of Object.keys(scenarios)) {
    const f = fixture(name);
    await db.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,$4)
      ON CONFLICT(id) DO NOTHING`,
      [f.roomId, workspace, viewer, `web-${name}`],
    );
    for (const who of [viewer, agent, peer])
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      SELECT $1,$2,$3,'owner' WHERE NOT EXISTS(SELECT 1 FROM memberships WHERE room_id=$2 AND identity_id=$3 AND removed_at IS NULL) ON CONFLICT DO NOTHING`,
        [workspace, f.roomId, who],
      );
    await db.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,$4,'2026-01-01T12:00:00Z')
      ON CONFLICT(id) DO NOTHING`,
      [f.messageId, f.roomId, viewer, f.text],
    );
    if (['corner', 'merge'].includes(f.scenario)) {
      await db.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,
        [f.cornerId, workspace, f.roomId, viewer, `web-${name}-corner`],
      );
      await db.query(`INSERT INTO corner_facts(corner_id) VALUES($1) ON CONFLICT DO NOTHING`, [
        f.cornerId,
      ]);
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,$4,'2026-01-01T12:00:00Z') ON CONFLICT DO NOTHING`,
        [hash(`corner-message:${name}`), f.cornerId, viewer, f.text],
      );
    }
    if (f.scenario === 'approval')
      await db.query(
        `INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status)
      VALUES($1,$2,$3,'host','127.0.0.1:19880','Local latency fixture',$4,$5,'pending') ON CONFLICT(id) DO NOTHING`,
        [f.grantId, agent, workspace, viewer, f.roomId],
      );
    if (f.scenario === 'approval')
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
      VALUES($1,$2,$3,'Local latency host approval','card','grant-request',$4::jsonb) ON CONFLICT(id) DO NOTHING`,
        [
          hash('approval-card'),
          f.roomId,
          agent,
          JSON.stringify({
            agent: { pubkey: agent, name: 'Web Rig Agent', handle: 'web-rig-agent' },
            grants: [
              {
                grantId: f.grantId,
                kind: 'host',
                target: '127.0.0.1:19880',
                reason: 'Local latency fixture',
              },
            ],
          }),
        ],
      );
    if (f.scenario === 'workflow') {
      const skillId = uuid(`workflow:${name}`);
      await db.query(
        `INSERT INTO workspace_skills(id,workspace_id,slug,description,state,current_version,revision,source_room_id,repository,target_commit,path,kind)
        VALUES($1,$2,$3,'Local latency workflow','active',1,1,$4,'','',NULL,'workflow') ON CONFLICT(id) DO NOTHING`,
        [skillId, workspace, `latency-${name}`, f.roomId],
      );
      const markdown = JSON.stringify({ ...contract, name: `latency-${name}` });
      await db.query(
        `INSERT INTO workspace_skill_versions(skill_id,version,markdown,content_hash,source_job_id,source_message_ids,repository,target_commit,path,extractor_version,model)
        VALUES($1,1,$2,$3,NULL,$4,'','',NULL,'latency-web-v1','n/a') ON CONFLICT DO NOTHING`,
        [skillId, markdown, hash(markdown), [f.messageId]],
      );
    }
  }
}

/** Reset only this scenario's disposable rows, before a new measured attempt. */
export async function resetWebFixture(db, f, activateTurn = true) {
  await db.query('BEGIN');
  try {
    await db.query(`DELETE FROM messages WHERE room_id=$1 AND id<>$2`, [
      f.cornerId,
      hash(`corner-message:${f.name}`),
    ]);
    if (f.scenario === 'turn')
      await db.query(`DELETE FROM agent_commands WHERE room_id=$1`, [f.roomId]);
    if (f.name === 'report-message')
      await db.query(
        `DELETE FROM feedback_items WHERE trigger_message_id=$1 AND source_kind='human'`,
        [f.messageId],
      );
    if (f.name === 'create-corner')
      await db.query(`DELETE FROM rooms WHERE parent_id=$1 AND id<>$2`, [f.roomId, f.cornerId]);
    if (f.name === 'forward-message')
      await db.query(`DELETE FROM messages WHERE room_id=$1 AND position($2 in text)>0`, [
        fixture('open-room').roomId,
        f.messageId,
      ]);
    if (f.name === 'create-room')
      await db.query(`DELETE FROM rooms WHERE workspace_id=$1 AND name LIKE 'rig-create-room-%'`, [
        workspace,
      ]);
    await db.query(
      `DELETE FROM messages WHERE room_id=$1 AND id<>$2 AND card_type IS DISTINCT FROM 'grant-request'`,
      [f.roomId, f.messageId],
    );
    // Object bytes live only for this rig run. A prior run's dedupe row cannot
    // stand in for bytes in the new disposable object store.
    if (f.name === 'send-attachment')
      await db.query(`DELETE FROM objects WHERE owner_id=$1 AND sha256=$2`, [
        viewer,
        createHash('sha256').update('Local Beeline latency attachment\n').digest('hex'),
      ]);
    if (f.name === 'create-dm')
      await db.query(
        `DELETE FROM rooms WHERE workspace_id=$1 AND direct_participants @> $2::jsonb`,
        [workspace, JSON.stringify([agent, viewer])],
      );
    await db.query(`UPDATE rooms SET name=$2,archived_at=NULL WHERE id=$1`, [
      f.roomId,
      `web-${f.name}`,
    ]);
    await db.query(`UPDATE rooms SET archived_at=NULL WHERE id=$1`, [f.cornerId]);
    if (f.name === 'close-corner') {
      // Closing is terminal. Recreate this disposable corner instead of
      // pretending that clearing archived_at revives its durable lifecycle.
      await db.query(`DELETE FROM rooms WHERE id=$1`, [f.cornerId]);
      await db.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,$5)`,
        [f.cornerId, workspace, f.roomId, viewer, 'web-close-corner-corner'],
      );
      await db.query(`INSERT INTO corner_facts(corner_id) VALUES($1)`, [f.cornerId]);
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,$4,'2026-01-01T12:00:00Z')`,
        [hash('corner-message:close-corner'), f.cornerId, viewer, f.text],
      );
    }
    await db.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`, [
      f.roomId,
      viewer,
    ]);
    await db.query(
      `UPDATE messages SET text=$2,deleted_at=NULL,deleted_by=NULL,reactions='{}'::jsonb WHERE id=$1`,
      [f.messageId, f.text],
    );
    await db.query(`DELETE FROM message_bookmarks WHERE message_id=$1`, [f.messageId]);
    await db.query(`DELETE FROM room_read_marks WHERE room_id=$1`, [f.roomId]);
    await db.query(`UPDATE agents SET selected_model='rig-a',yolo_mode=true WHERE agent_id=$1`, [
      agent,
    ]);
    if (f.scenario === 'approval') {
      await db.query(`DELETE FROM needs_you_marks WHERE identity_id=$1 AND message_id=$2`, [
        viewer,
        hash('approval-card'),
      ]);
      await db.query(`DELETE FROM agent_grants WHERE id=$1`, [f.grantId]);
      await db.query(
        `INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status)
        VALUES($1,$2,$3,'host','127.0.0.1:19880','Local latency fixture',$4,$5,'pending')`,
        [f.grantId, agent, workspace, viewer, f.roomId],
      );
      await db.query(
        `UPDATE messages SET card=jsonb_set(card,'{grants,0,status}','"pending"'::jsonb) WHERE id=$1`,
        [hash('approval-card')],
      );
    }
    if (f.scenario === 'turn' && activateTurn)
      await db.query(
        `INSERT INTO agent_commands(id,room_id,agent_id,source_message_id,turn_request_id,action,reason,root_command_id,root_source_message_id,agent_depth,state) VALUES($1,$2,$3,$4,$4,'input','human_tag',$1,$4,0,'claimed') ON CONFLICT(id) DO UPDATE SET state='claimed',completed_at=NULL`,
        [hash('stop-command'), f.roomId, agent, f.messageId],
      );
    if (f.scenario === 'turn' && activateTurn)
      await db.query(
        `INSERT INTO agent_turns(room_id,request_id,agent_id,status,started_at,created_at)
      VALUES($1,$2,$3,'working',now(),now()) ON CONFLICT(room_id,request_id,agent_id)
      DO UPDATE SET status='working',started_at=now(),created_at=now()`,
        [f.roomId, f.messageId, agent],
      );
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

/** Validate the committed effect after the visible timer; never time a cancel. */
export async function verifyWebEffect(db, f, token) {
  const checks = {
    'create-room': [`SELECT 1 FROM rooms WHERE workspace_id=$1 AND name=$2`, [workspace, token]],
    'create-dm': [
      `SELECT 1 FROM rooms WHERE workspace_id=$1 AND direct_participants @> $2::jsonb`,
      [workspace, JSON.stringify([agent, viewer])],
    ],
    'create-corner': [`SELECT 1 FROM rooms WHERE parent_id=$1 AND id<>$2`, [f.roomId, f.cornerId]],
    'send-text': [`SELECT 1 FROM messages WHERE room_id=$1 AND text=$2`, [f.roomId, token]],
    'send-attachment': [
      `SELECT 1 FROM messages WHERE room_id=$1 AND attachments @> $2::jsonb`,
      [f.roomId, JSON.stringify([{ name: `${token}.txt` }])],
    ],
    'forward-message': [
      `SELECT 1 FROM messages WHERE room_id=$1 AND position($2 in text)>0`,
      [fixture('open-room').roomId, f.messageId],
    ],
    'react-message': [
      `SELECT 1 FROM messages WHERE id=$1 AND reactions<>'{}'::jsonb`,
      [f.messageId],
    ],
    'bookmark-message': [
      `SELECT 1 FROM message_bookmarks WHERE identity_id=$1 AND message_id=$2`,
      [viewer, f.messageId],
    ],
    'report-message': [
      `SELECT 1 FROM feedback_items WHERE trigger_message_id=$1 AND source_kind='human'`,
      [f.messageId],
    ],
    'delete-message': [
      `SELECT 1 FROM messages WHERE id=$1 AND deleted_at IS NOT NULL`,
      [f.messageId],
    ],
    'rename-room': [`SELECT 1 FROM rooms WHERE id=$1 AND name=$2`, [f.roomId, token]],
    'leave-room': [
      `SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NOT NULL`,
      [f.roomId, viewer],
    ],
    'close-corner': [`SELECT 1 FROM rooms WHERE id=$1 AND archived_at IS NOT NULL`, [f.cornerId]],
    'answer-approval': [`SELECT 1 FROM agent_grants WHERE id=$1 AND status='once'`, [f.grantId]],
    'choose-model': [`SELECT 1 FROM agents WHERE agent_id=$1 AND selected_model='rig-b'`, [agent]],
    'change-yolo': [`SELECT 1 FROM agents WHERE agent_id=$1 AND yolo_mode=false`, [agent]],
    'stop-turn': [
      `SELECT 1 FROM agent_commands WHERE id=$1 AND state IN ('complete','cancelled')`,
      [hash('stop-command')],
    ],
  };
  const check = checks[f.name];
  if (!check) return;
  for (let attempt = 0; attempt < 20; attempt++) {
    if ((await db.query(...check)).rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${f.name}: visible feedback did not produce its committed fixture effect`);
}
