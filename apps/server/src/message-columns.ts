/** Explicit current message-row projection, shared by stored-row readers. */
const columns = [
  'id','room_id','author_id','text','presentation',
  'attachments','reactions','reply_to_message_id','root_message_id','request_id',
  'turn_id','activity','durable_fact','card_type','card',
  'legacy_event','agent_hop_count','system_event','system_transcript','deleted_at','deleted_by',
  'created_at','version','search_document','search_stem_document','event_cause_id',
  'event_root_cause_id','event_depth','agent_model','source_client','chat_seq',
] as const;

export function messageColumns(alias: string): string {
  return columns.map(column => `${alias}.${column}`).join(',');
}

/** Resolve the pinned gate for old expiry rows when projecting them to the phone. */
export function phoneMessageColumns(alias: string): string {
  return `${messageColumns(alias)},
    CASE WHEN ${alias}.card_type='workflow-handoff' AND ${alias}.card->>'outcome'='expired'
      THEN COALESCE(${alias}.card->>'expiredStepKind', (
        SELECT version.markdown::jsonb->'handoffs'->(${alias}.card->>'fromState')->>'kind'
        FROM rooms place JOIN workspace_skills skill ON skill.workspace_id=place.workspace_id
          AND skill.kind='workflow' AND skill.slug=${alias}.card->>'workflowSlug'
        JOIN workspace_skill_versions version ON version.skill_id=skill.id
          AND version.version::text=${alias}.card->>'workflowVersion'
        WHERE place.id=${alias}.room_id
      ))
    END AS expired_workflow_step_kind`;
}
