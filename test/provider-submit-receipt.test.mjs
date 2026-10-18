import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerSubmissionConfirmed, unresolvedSubmitCode, submitExactlyOnce } from '../src/provider-submit-receipt.mjs';
const baseline={userCount:0,composerText:'',url:'https://chatgpt.com/'};
const prompt='ORDAX_SEND_ONCE_TEST';

test('clearing the provider composer alone never confirms sending',()=>{
  assert.equal(providerSubmissionConfirmed({baseline,current:{...baseline,composerText:''},prompt}),false);
  assert.equal(unresolvedSubmitCode({composerText:''}),'send_confirmation_unknown');
  assert.equal(unresolvedSubmitCode({composerText:prompt}),'send_not_observed');
});
test('accepted user bubble or new canonical provider conversation confirms receipt',()=>{
  assert.equal(providerSubmissionConfirmed({baseline,current:{...baseline,url:'https://chatgpt.com/c/6ad46c78-729c-83e9-a6eb-4006830ada90'},prompt}),true);
  assert.equal(providerSubmissionConfirmed({baseline,current:{...baseline,userCount:1,latestUserText:prompt},prompt}),true);
  assert.equal(providerSubmissionConfirmed({baseline,current:{...baseline,userCount:1,latestUserText:'wrong prompt'},prompt}),false);
  assert.equal(providerSubmissionConfirmed({baseline,current:{...baseline,url:'https://chatgpt.com/auth/login'},prompt}),false);
  assert.equal(providerSubmissionConfirmed({baseline,current:{...baseline,url:'https://chatgpt.com/c/6ad46c78-729c-83e9-a6eb-4006830ada90',composerText:prompt},prompt}),false);
});
test('one event is fired while multiple observations are allowed',async()=>{
  let calls=0, reads=0;
  const result=await submitExactlyOnce({baseline,prompt,fire:async()=>{calls++},wait:async()=>{},readState:async()=>{reads++;return reads===3?{...baseline,userCount:1,latestUserText:prompt}:{...baseline,composerText:prompt}},maxChecks:5});
  assert.equal(calls,1);assert.equal(reads,3);assert.equal(result.userCount,1);
});
test('unknown acceptance fails closed without any automatic retry',async()=>{
  let calls=0;
  await assert.rejects(()=>submitExactlyOnce({baseline,prompt,fire:async()=>{calls++},readState:async()=>({...baseline,composerText:''}),wait:async()=>{},maxChecks:4}),/send_confirmation_unknown/);
  assert.equal(calls,1);
});
test('unchanged typed composer fails closed without automatic resend',async()=>{
  let calls=0;
  await assert.rejects(()=>submitExactlyOnce({baseline,prompt,fire:async()=>{calls++},readState:async()=>({...baseline,composerText:prompt}),wait:async()=>{},maxChecks:2}),/send_not_observed/);
  assert.equal(calls,1);
});

import { waitForSubmitControl } from '../src/provider-submit-receipt.mjs';
test('waits for a React submit button before performing any send',async()=>{
  let reads=0,attempted=0;
  const control=await waitForSubmitControl({read:async()=>{reads++;return reads>3?{button:true,x:32,y:12}:{button:false,form:true};},wait:async()=>{},maxChecks:5});
  attempted++;
  assert.equal(reads,4);assert.equal(attempted,1);assert.equal(control.x,32);
});
test('a missing or disabled button does not trigger Enter or duplicate sending',async()=>{
  let attempts=0;
  await assert.rejects(()=>waitForSubmitControl({read:async()=>({button:false,form:true}),wait:async()=>{},maxChecks:3}),/send_control_unavailable/);
  assert.equal(attempts,0);
});
