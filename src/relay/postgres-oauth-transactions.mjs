/**
 * Durable, replica-safe OAuth PKCE state for Flow.
 *
 * Uses the EXISTING OrdaX Platform PostgreSQL query adapter, in a private
 * Flow-specific schema. This is not a new identity provider or database.
 * The query executor must use one canonical database and bound parameters.
 */
const DIGEST = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9_-]{43,128}$/;
const MAX_LIFETIME_SECONDS = 600;

export const FLOW_OAUTH_MIGRATION_PATH = 'sql/flow-oauth-transactions.sql';

export function createFlowPostgresOAuthTransactionStore({ query, now = () => Date.now() }) {
  if(typeof query!=='function'||typeof now!=='function')
    throw new TypeError('flow_oauth_canonical_postgres_required');

  return {
    async put({key,verifier,returnPath,expiresAtUnix}) {
      const current=Math.floor(now()/1000);
      if(typeof key!=='string'||!DIGEST.test(key)||
         typeof verifier!=='string'||!VERIFIER.test(verifier)||
         !['/client','/hub'].includes(returnPath)||
         !Number.isSafeInteger(expiresAtUnix)||
         expiresAtUnix<=current||expiresAtUnix>current+MAX_LIFETIME_SECONDS)
        throw new TypeError('flow_oauth_transaction_invalid');
      await query(
        'INSERT INTO flow_private.oauth_transactions (state_digest,code_verifier,return_path,expires_at) VALUES ($1,$2,$3,to_timestamp($4))',
        [key,verifier,returnPath,expiresAtUnix]
      );
      // Unique key constraint deliberately fails closed on collisions.
    },
    async take({key}) {
      if(typeof key!=='string'||!DIGEST.test(key))
        throw new TypeError('flow_oauth_transaction_key_invalid');
      // Single atomic DELETE ... RETURNING: only one callback, across all
      // replicas, can consume an unexpired authorization state.
      const result=await query(
        'DELETE FROM flow_private.oauth_transactions WHERE state_digest=$1 AND expires_at>CURRENT_TIMESTAMP RETURNING code_verifier,return_path,EXTRACT(EPOCH FROM expires_at)::bigint AS expires_at_unix',
        [key]
      );
      if(!result||!Array.isArray(result.rows))
        throw new TypeError('flow_oauth_database_response_invalid');
      if(result.rows.length===0)return null;
      if(result.rows.length!==1)throw new TypeError('flow_oauth_database_response_invalid');
      const row=result.rows[0];
      const expiresAtUnix=Number(row.expires_at_unix);
      if(!VERIFIER.test(row.code_verifier||'')||
         !['/client','/hub'].includes(row.return_path)||
         !Number.isSafeInteger(expiresAtUnix))
        throw new TypeError('flow_oauth_database_response_invalid');
      return {
        verifier:row.code_verifier,
        returnPath:row.return_path,
        expiresAtUnix
      };
    }
  };
}
