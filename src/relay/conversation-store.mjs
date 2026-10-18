/** Flow-only conversation journal on the canonical OrdaX PostgreSQL.
 * Identity remains in OrdaX Platform; this is a single, private application
 * projection for Flow chats (not a clone of Platform projects or Spaces).
 */
import { randomUUID } from 'node:crypto';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQ=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CURSOR=/^[1-9][0-9]{0,18}$/;
const requiredUser=principal=>{
  if(!UUID.test(principal?.userId||''))throw TypeError('flow_verified_owner_required');
  return principal.userId.toLowerCase();
};
const requiredTask=taskId=>{
  if(!UUID.test(taskId||''))throw TypeError('flow_task_id_invalid');
  return taskId.toLowerCase();
};
function safeRows(result){
  if(!result||!Array.isArray(result.rows))throw TypeError('flow_canonical_database_response_invalid');
  return result.rows;
}
const safeTitle=value=>typeof value==='string'&&value.trim().length>=1&&
  value.trim().length<=160;

export function createFlowConversationStore({query,newId=randomUUID}) {
  if(typeof query!=='function'||typeof newId!=='function')
    throw TypeError('flow_canonical_conversation_query_required');
  const scopedQuery=(owner,sql,params)=>query(sql,params,{ownerUserId:owner});

  return {
    async createConversation({principal,title}) {
      const owner=requiredUser(principal);
      if(!safeTitle(title))throw TypeError('flow_conversation_title_invalid');
      const taskId=requiredTask(newId());
      const rows=safeRows(await scopedQuery(owner,
        `INSERT INTO flow_private.conversations (task_id,owner_user_id,title)
         VALUES ($1::uuid,$2::uuid,$3) RETURNING task_id::text AS id,title`,
        [taskId,owner,title.trim()]
      ));
      if(rows.length!==1||rows[0].id!==taskId||rows[0].title!==title.trim())
        throw TypeError('flow_conversation_create_unconfirmed');
      return {id:taskId,title:title.trim()};
    },

    async listProjects({principal,limit=100}) {
      const owner=requiredUser(principal);
      const bounded=Math.min(100,Math.max(1,limit));
      const rows=safeRows(await scopedQuery(owner,
        `SELECT task_id::text AS id,title FROM flow_private.conversations
         WHERE owner_user_id=$1::uuid AND archived_at IS NULL
         ORDER BY updated_at DESC,task_id DESC LIMIT $2`,
        [owner,bounded]
      ));
      return rows.map(row=>{
        if(!UUID.test(row.id||'')||!safeTitle(row.title))
          throw TypeError('flow_conversation_list_corrupt');
        return {id:row.id,title:row.title};
      });
    },

    async authorizeTask({principal,taskId}) {
      const owner=requiredUser(principal), task=requiredTask(taskId);
      const rows=safeRows(await scopedQuery(owner,
        `SELECT 1 AS allowed FROM flow_private.conversations
         WHERE owner_user_id=$1::uuid AND task_id=$2::uuid
           AND archived_at IS NULL LIMIT 1`,
        [owner,task]
      ));
      return rows.length===1&&rows[0].allowed===1;
    },

    async getHistory({principal,taskId,before=null,limit=50}) {
      const owner=requiredUser(principal),task=requiredTask(taskId);
      if(before!==null && (typeof before!=='string'||!CURSOR.test(before)))
        throw TypeError('flow_history_cursor_invalid');
      if(!Number.isSafeInteger(limit)||limit<1||limit>100)
        throw TypeError('flow_history_limit_invalid');
      const rows=safeRows(await scopedQuery(owner,
        `SELECT m.seq::text AS id,m.role,m.content
         FROM flow_private.messages AS m
         JOIN flow_private.conversations AS t ON t.task_id=m.task_id
         WHERE t.owner_user_id=$1::uuid AND t.task_id=$2::uuid
           AND t.archived_at IS NULL AND ($3::bigint IS NULL OR m.seq<$3::bigint)
         ORDER BY m.seq DESC LIMIT $4`,
        [owner,task,before,limit+1]
      ));
      const hasOlder=rows.length>limit;
      const page=rows.slice(0,limit).map(row=>{
        if(typeof row.id!=='string'||!CURSOR.test(row.id)||
           !['user','assistant'].includes(row.role)||
           typeof row.content!=='string'||!row.content.length||
           row.content.length>96000)throw TypeError('flow_history_corrupt');
        return {id:row.id,role:row.role,content:row.content};
      });
      page.reverse();
      return {messages:page,nextBefore:hasOlder?page[0]?.id||null:null};
    },

    async recordTurn({principal,taskId,requestId,userText,assistantText}) {
      const owner=requiredUser(principal),task=requiredTask(taskId);
      if(typeof requestId!=='string'||!REQ.test(requestId)||
         typeof userText!=='string'||!userText.trim()||userText.length>24000||
         typeof assistantText!=='string'||!assistantText.trim()||
         assistantText.length>96000)throw TypeError('flow_turn_invalid');

      const args=[owner,task,requestId,userText,assistantText];
      // One statement inserts both roles atomically after verifying ownership.
      // The outer idempotency receipt is responsible for serializing a request.
      const inserted=safeRows(await scopedQuery(owner,
        `WITH owned AS (
           SELECT task_id FROM flow_private.conversations
           WHERE owner_user_id=$1::uuid AND task_id=$2::uuid AND archived_at IS NULL
         )
         INSERT INTO flow_private.messages (task_id,request_id,role,content)
         SELECT owned.task_id,$3,v.role,v.content
         FROM owned CROSS JOIN (VALUES ('user',$4::text),('assistant',$5::text))
         AS v(role,content)
         ON CONFLICT (task_id,request_id,role) DO NOTHING
         RETURNING role`,
        args
      ));
      if(inserted.length===2){
        if(inserted.some(x=>!['user','assistant'].includes(x.role)))
          throw TypeError('flow_turn_insert_corrupt');
        return;
      }
      if(inserted.length!==0)throw TypeError('flow_turn_partial_conflict');
      const existing=safeRows(await scopedQuery(owner,
        `SELECT m.role,m.content FROM flow_private.messages m
         JOIN flow_private.conversations t ON t.task_id=m.task_id
         WHERE t.owner_user_id=$1::uuid AND t.task_id=$2::uuid
           AND t.archived_at IS NULL AND m.request_id=$3`,
        args.slice(0,3)
      ));
      if(existing.length!==2||
         !existing.some(x=>x.role==='user'&&x.content===userText)||
         !existing.some(x=>x.role==='assistant'&&x.content===assistantText))
        throw TypeError('flow_turn_mismatch_or_forbidden');
    }
  };
}
