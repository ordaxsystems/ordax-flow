/**
 * Executes Flow-only SQL as a least-privilege database role, with the
 * authenticated OrdaX subject bound to PostgreSQL RLS for ONE transaction.
 *
 * withTransaction MUST BEGIN/COMMIT/ROLLBACK on one pinned Postgres
 * connection (never issue these statements via independent pool.query).
 */
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createFlowOwnerScopedQuery({withTransaction}) {
  if(typeof withTransaction!=='function')
    throw new TypeError('flow_transaction_connection_required');

  return async function queryWithOwner(sql,params,{ownerUserId}={}) {
    if(typeof ownerUserId!=='string'||!UUID.test(ownerUserId)||
       typeof sql!=='string'||!sql.trim()||!Array.isArray(params))
      throw new TypeError('flow_verified_owner_sql_required');

    return withTransaction(async connection=>{
      if(!connection||typeof connection.query!=='function')
        throw new TypeError('flow_pinned_transaction_connection_required');
      // This only succeeds for an explicitly granted service DB login.
      // It fails closed for the anonymous, user and unrelated app roles.
      await connection.query('SET LOCAL ROLE ordax_flow_gateway');
      await connection.query(
        "SELECT set_config('flow.owner_user_id',$1,true)",
        [ownerUserId.toLowerCase()]
      );
      return connection.query(sql,params);
    });
  };
}
