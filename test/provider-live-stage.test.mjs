import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLiveStage, RUN_STAGE_TEXT } from '../desktop/ui-stage.mjs';

function fixture() {
  const content={textContent:'Preparando…'};
  const status={textContent:'',shown:false,classList:{remove(x){if(x==='hidden')status.shown=true}}};
  const node={dataset:{},querySelector:selector=>selector==='.live-content'?content:null};
  return {content,status,node,options:{getNode:id=>id==='live-test'?node:null,statusElement:status}};
}
test('six distinct phases appear, including waiting for ChatGPT', () => {
  const { content,status,options }=fixture();
  const stages=['health','prepare','baseline','submit','await-response','assets'];
  for(const stage of stages) {
    assert.equal(renderLiveStage({runId:'test',stage,at:3000,runStartedAt:1000},options),true);
    assert.equal(content.textContent,RUN_STAGE_TEXT[stage]);
  }
  assert.equal(status.shown,true);
  assert.match(status.textContent,/2s desde o início/);
});
test('late preparation never replaces a streaming answer',()=>{
  const {content,node,options}=fixture();
  node.dataset.streamStarted='true';
  content.textContent='Resposta progressiva';
  assert.equal(renderLiveStage({runId:'test',stage:'prepare',at:3000,runStartedAt:1000},options),false);
  assert.equal(content.textContent,'Resposta progressiva');
});
test('unknown run and stage do not mutate the UI',()=>{
  const {content,status,options}=fixture();
  assert.equal(renderLiveStage({runId:'unknown',stage:'prepare',at:2000},options),false);
  assert.equal(renderLiveStage({runId:'test',stage:'unknown',at:2000},options),false);
  assert.equal(content.textContent,'Preparando…');
  assert.equal(status.shown,false);
});
