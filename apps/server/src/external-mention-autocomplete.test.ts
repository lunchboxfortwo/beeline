import {expect,it} from 'vitest';
import {migratedDatabase} from './test-support.js';
import {PhoneService} from './phone-service.js';
import {filterMentionCandidates} from '../../mobile/sources/buzz/room-participants.js';

it('keeps an external Room member selectable beyond the first six autocomplete matches',async()=>{
  const db=await migratedDatabase();
  const human='a'.repeat(64),external='9'.repeat(64),workspace='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222';
  try{
    await db.query("INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner')",[human]);
    await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Workspace')",[workspace]);
    await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')",[room,workspace]);
    for(const [id,name] of [...Array.from({length:7},(_,i)=>[(i+1).toString().repeat(64),`Agent ${i}`]),[external,'Zulu external']]){
      await db.query("INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent',$2,$3)",[id,name,name!.replaceAll(' ','').toLowerCase()]);
      await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)',[id,human]);
    }
    await db.query("INSERT INTO rooms_mcp_clients(id,name,redirects) VALUES('external-app','External app','[]')");
    await db.query("INSERT INTO rooms_mcp_members(client_id,owner_id,member_id,model_label) VALUES('external-app',$1,$2,'External model')",[human,external]);
    for(const id of [human,...Array.from({length:7},(_,i)=>(i+1).toString().repeat(64)),external])
      await db.query("INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner')",[workspace,room,id]);
    const phone=new PhoneService(db,'http://test');
    const roster=(await phone.readRoom(room,human))!.members;
    const candidates=roster.map(member=>({pubkey:member.identity.pubkey,name:member.identity.name,handle:member.identity.handle!}))
      .sort((a,b)=>a.name.localeCompare(b.name));
    expect(candidates.find(candidate=>candidate.pubkey===external)).toBeDefined();
    expect(filterMentionCandidates(candidates,'').matches.map(candidate=>candidate.pubkey)).toContain(external);
    expect(filterMentionCandidates(candidates,'zulu').matches.map(candidate=>candidate.pubkey)).toEqual([external]);
    await db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2',[room,external]);
    expect((await phone.readRoom(room,human))!.members.some(member=>member.identity.pubkey===external)).toBe(false);
  }finally{await db.close();}
});
