import type { SqlDatabase } from './database.js';

export async function readPersonDiagnostics(db: SqlDatabase, person: string) {
  const identity = (await db.query<{ id: string; handle: string | null }>(
    `SELECT id,handle FROM identities WHERE kind='human' AND (id=$1 OR handle=$1)`,[person])).rows[0];
  if (!identity) return null;
  // Only the private dashboard authority calls this owner; no phone/Room permission grants access.
  await db.query(`INSERT INTO diagnostic_reads(user_id,authority) VALUES($1,'private_operator_dashboard')`,[identity.id]);
  const sessions = (await db.query<{ id: string; device_id: string; view_id: string; descriptor: Record<string,unknown>; first_seen: Date; last_seen: Date }>(
    `SELECT id,device_id,view_id,descriptor,first_seen,last_seen FROM diagnostic_sessions WHERE user_id=$1 ORDER BY last_seen DESC,id`,[identity.id])).rows;
  const actions = (await db.query<{ event_id: string; session_id: string | null; source: string; received_at: Date; occurred_at: Date; sequence: number | null; action_id: string | null; command_id: string | null; detail: Record<string,unknown> }>(
    `SELECT a.event_id,a.session_id,a.source,a.received_at,a.occurred_at,a.sequence,a.action_id,a.command_id,a.detail
     FROM diagnostic_actions a LEFT JOIN diagnostic_sessions s ON s.id=a.session_id
     WHERE a.user_id=$1 OR s.user_id=$1 ORDER BY a.received_at,a.sequence NULLS LAST,a.event_id`,[identity.id])).rows;
  const authSteps=(await db.query<{attempt_id:string;stage:string;provider:string;error_code:string|null;occurred_at:Date;session_id:string}>(
    `SELECT e.attempt_id,e.stage,e.provider,e.error_code,e.occurred_at,s.id session_id
     FROM signin_attempt_events e JOIN diagnostic_sessions s ON s.device_id=e.install_id AND s.user_id=$1
     WHERE EXISTS(SELECT 1 FROM diagnostic_actions a WHERE a.session_id=s.id AND a.detail->>'attemptId'=e.funnel_attempt_id::text)
     ORDER BY e.occurred_at`,[identity.id])).rows;
  for(const e of authSteps) actions.push({event_id:`${e.attempt_id}:${e.stage}:${e.occurred_at.toISOString()}`,session_id:e.session_id,
    source:'server',received_at:e.occurred_at,occurred_at:e.occurred_at,sequence:null,action_id:null,command_id:null,
    detail:{name:'auth_server_step',phase:e.stage,provider:e.provider,code:e.error_code,ceremonyId:e.attempt_id}});
  actions.sort((a,b)=>new Date(a.received_at).getTime()-new Date(b.received_at).getTime() || Number(a.sequence)-Number(b.sequence));
  const bySession=new Map<string,typeof actions>();
  for(const action of actions) if(action.session_id) { const list=bySession.get(action.session_id) ?? [];list.push(action);bySession.set(action.session_id,list); }
  const devices = [...new Set(sessions.map(s=>s.device_id))].map(deviceId=>({ deviceId,
    sessions: sessions.filter(s=>s.device_id===deviceId).map(s=>{
      const steps=bySession.get(s.id) ?? [];
      const client=steps.filter(a=>a.source==='client').sort((a,b)=>Number(a.sequence)-Number(b.sequence));
      const gaps: { after: number; before: number }[]=[];
      let previous=client[0]?.detail.name==='session_started' ? Number(client[0].sequence)-1 : 0;
      for (const e of client) { const seq=Number(e.sequence); if(seq>previous+1)gaps.push({after:previous,before:seq}); previous=Math.max(previous,seq); }
      return { sessionId:s.id,viewId:s.view_id,descriptor:s.descriptor,firstSeen:s.first_seen,lastSeen:s.last_seen,gaps,
        coverage: client.some(a=>a.detail.name==='session_started') ? 'observed' : 'start_unobserved',actions:steps };
    }),
  }));
  const deliveries = (await db.query(`SELECT d.event_id,d.command_id,d.attempted_at,d.completed_at,d.http_status,
    d.failure_category,d.duration_ms,d.delivery_state,d.execution_state,
    CASE WHEN t.completion_kind='no-reply' THEN 'no_reply' WHEN t.status='failed' THEN 'failed'
      WHEN c.result_message_id IS NOT NULL THEN 'reply_recorded' ELSE 'unknown' END host_result
    FROM (
      SELECT e.event_id,e.command_id,e.attempted_at,e.completed_at,e.http_status,e.failure_category,e.duration_ms,e.delivery_state,
        e.execution_state,s.owner_id FROM rooms_mcp_event_deliveries e JOIN rooms_mcp_event_subscriptions s ON s.id=e.subscription_id
      UNION ALL
      SELECT o.call_id::text,o.message_id,o.attempted_at,o.completed_at,o.http_status,o.failure_category,o.duration_ms,o.delivery_state,
        'unknown',m.owner_id FROM rooms_mcp_webhook_outbox o JOIN rooms_mcp_members m ON m.member_id=o.member_id
    ) d
    LEFT JOIN agent_commands c ON c.id=d.command_id
    LEFT JOIN agent_turns t ON t.room_id=c.room_id AND t.request_id=c.turn_request_id AND t.agent_id=c.agent_id
    WHERE d.owner_id=$1 ORDER BY d.attempted_at NULLS LAST,d.event_id`,[identity.id])).rows;
  const deviceAliases=(await db.query(`SELECT device_id,receipt->>'previousDeviceId' previous_device_id
    FROM device_update_receipts WHERE identity_id=$1 AND receipt->>'previousDeviceId' IS NOT NULL`,[identity.id])).rows;
  return { person:identity,devices,deviceAliases,unattributedActions:actions.filter(a=>!a.session_id),deliveries,
    coverage: devices.length ? 'observed_steps_only' : 'no_device_observations' };
}

export type PersonDiagnostics = NonNullable<Awaited<ReturnType<typeof readPersonDiagnostics>>>;
const escape = (v: unknown) => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
/** Server-rendered console fragment: no browser credential, script, timer or network sender. */
export function renderPersonDiagnostics(data: PersonDiagnostics): string {
  const steps = (actions: PersonDiagnostics['unattributedActions']) => `<ol>${actions.map(a=>`<li><time>${escape(a.received_at)}</time> <b>${escape(a.detail.name)}</b> · ${escape(a.detail.outcome ?? 'observed')} · ${escape(a.detail.phase ?? a.detail.operation ?? a.detail.route ?? '')} ${escape(a.detail.code ?? '')} ${escape(a.detail.creationSource ?? a.detail.deliveryState ?? a.detail.hostResult ?? '')}<small>${escape(a.source)} · sequence ${escape(a.sequence ?? 'server')} · client time ${escape(a.occurred_at)} · action ${escape(a.action_id)}${a.detail.workspaceId ? ` · Workspace ${escape(a.detail.workspaceId)}` : ''}</small></li>`).join('')}</ol>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Beeline · device diagnostics</title>
  <style>body{margin:0;background:#14091a;color:#f0f0f3;font:16px/1.5 system-ui}main{max-width:1100px;margin:auto;padding:32px}h1,h2{font-weight:500}small{display:block;color:#90909b;overflow-wrap:anywhere}details{border-top:1px solid #291e33;padding:16px 0}summary{cursor:pointer;color:#e5a645}li{padding:8px 0}table{width:100%;text-align:left;border-collapse:collapse}td,th{padding:8px;border-bottom:1px solid #291e33}time{color:#90909b}</style>
  <main><h1>${escape(data.person.handle ?? data.person.id)}</h1><p>Devices → sessions → actions. Client observations and server facts are labeled. Missing evidence remains unknown.</p>
  <p>${escape(data.coverage)}</p>${data.deviceAliases.map(a=>`<small>Installation ${escape(a.device_id)} previously reported updates as ${escape(a.previous_device_id)} · client-reported alias</small>`).join('')}${data.devices.map(d=>`<details open><summary>Device ${escape(d.deviceId)}</summary>${d.sessions.map(s=>`<details open><summary>${escape(s.descriptor.platform)} · ${escape(s.descriptor.client)} ${escape(s.descriptor.version)} · Session ${escape(s.sessionId)}</summary><small>View ${escape(s.viewId)} · ${escape(s.firstSeen)} → ${escape(s.lastSeen)} · ${escape(s.coverage)}</small>${s.gaps.length?`<p>Sequence gaps: ${s.gaps.map(g=>`${g.after} → ${g.before}`).join(', ')}</p>`:''}${steps(s.actions)}</details>`).join('')}</details>`).join('')}
  <details><summary>Device unknown · server and agent steps</summary>${steps(data.unattributedActions)}</details>
  <h2>Assistant delivery</h2><table><thead><tr><th>Event</th><th>Transport</th><th>HTTP</th><th>Host result</th></tr></thead><tbody>${data.deliveries.map(d=>`<tr><td>${escape(d.event_id)}</td><td>${escape(d.delivery_state)} ${escape(d.failure_category)}</td><td>${escape(d.http_status)}</td><td>${escape(d.host_result)}</td></tr>`).join('')}</tbody></table></main></html>`;
}
