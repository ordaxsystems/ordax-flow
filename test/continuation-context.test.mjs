import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectContinuation } from '../src/continuation-context.mjs';

test('a persistent project continues across internal provider conversations without assuming a domain', () => {
  const text=buildProjectContinuation({
    title:'Sistema de atendimento',
    checkpoint:'Implementado cadastro; autenticação ainda pendente.',
    memoryItems:[
      {category:'goal',key:'MVP',content:'Permitir atendimento offline.',status:'active'},
      {category:'decision',key:'Persistência',content:'Usar SQLite WAL.',status:'active'},
      {category:'constraint',key:'Privacidade',content:'Não enviar dados privados sem autorização.',status:'active'},
      {category:'open_loop',key:'Login',content:'Implementar fluxo de autenticação.',status:'active'}
    ],
    recentMessages:[{role:'user',content:'Já validamos o armazenamento local.'}],
    request:'Continue pelo login.'
  });
  assert.match(text,/Projeto\/Task persistente: Sistema de atendimento/);
  assert.match(text,/\[OBJETIVO\] MVP: Permitir atendimento offline/);
  assert.match(text,/\[DECISAO\] Persistência: Usar SQLite WAL/);
  assert.match(text,/\[RESTRICAO\] Privacidade/);
  assert.match(text,/\[PENDENCIA\] Login/);
  assert.match(text,/Já validamos o armazenamento local/);
  assert.ok(text.endsWith('Pedido atual:\nContinue pelo login.'));
});

test('a large canonical project remains complete in the local SSOT while the provider gets a bounded honest selection', () => {
  const memoryItems=Array.from({length:100},(_,i)=>({
    category:i%3===0?'goal':i%3===1?'decision':'open_loop',
    key:'Item ' + i,
    content:'Descrição detalhada '+i+' '+('x'.repeat(260)),
    status:'active'
  }));
  const lastRequest='Corrija o módulo de sincronização sem alterar os contratos anteriores.';
  const context=buildProjectContinuation({
    title:'Plataforma de módulos',
    checkpoint:'Snapshot versionado v42',
    memoryItems,
    recentMessages:Array.from({length:20},(_,i)=>({role:i%2?'assistant':'user',content:'Histórico '+i+' '+('y'.repeat(220))})),
    request:lastRequest,
    maxChars:3800
  });
  assert.ok(context.length<=3800);
  assert.match(context,/\[MEMORIA PARCIAL\]/);
  assert.match(context,/\[HISTORICO PARCIAL\]/);
  assert.ok(context.endsWith('Pedido atual:\n'+lastRequest));
  assert.doesNotMatch(context,/\[FIM DO CONTEXTO ORDAX\][\s\S]*\[MEMORIA/);
  assert.equal(memoryItems.length,100);
});

test('when user request itself exceeds budget it must be preserved verbatim', () => {
  const request='continuidade '+'a'.repeat(20000);
  const output=buildProjectContinuation({
    title:'Projeto de pesquisa',request,memoryItems:[],maxChars:16000
  });
  assert.equal(output,request);
});

test('archived canonical records never enter the provider continuity capsule', () => {
  const output=buildProjectContinuation({
    title:'Campanha',
    checkpoint:'Fase de execução',
    memoryItems:[
      {category:'decision',key:'Ativa',content:'Executar primeiro piloto.',status:'active'},
      {category:'decision',key:'Antiga',content:'REGRA_OBSOLETA_987',status:'archived'}
    ],
    request:'Prossiga com o plano.'
  });
  assert.match(output,/Executar primeiro piloto/);
  assert.doesNotMatch(output,/REGRA_OBSOLETA_987/);
});
