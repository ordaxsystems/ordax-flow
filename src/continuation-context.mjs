// Pure, deterministic builder: the provider chat is disposable, the OrdaX Task is SSOT.
// Never cut the context in the middle of a memory record or truncate the user's request.
const LABELS = Object.freeze({
  goal: 'OBJETIVO', constraint: 'RESTRICAO', decision: 'DECISAO',
  open_loop: 'PENDENCIA', structure: 'ESTRUTURA', entity: 'ENTIDADE',
  fact: 'FATO', reference: 'REFERENCIA'
});
const PRIORITY = ['goal','constraint','decision','open_loop','structure','entity','fact','reference'];
const clean = value => String(value ?? '').replace(/\s+/g,' ').trim();
const short = (value,limit) => {
  const text=clean(value);
  return text.length <= limit ? text : text.slice(0,limit-24).trimEnd() + ' [trecho abreviado]';
};
const lengthOf = lines => lines.join('\n').length;
const words = value => new Set(
  clean(value).toLocaleLowerCase('pt-BR').split(/[^\p{L}\p{N}]+/u)
    .filter(word => word.length >= 4)
);

export function buildProjectContinuation({title,checkpoint,memoryItems=[],recentMessages=[],request,maxChars=16000}) {
  const pedido = String(request ?? '').trim();
  const suffix = '\nPedido atual:\n' + pedido;
  const cap = Math.max(0, Number(maxChars) || 16000) - suffix.length;
  // A large instruction must never be silently truncated just to fit remembered context.
  if (cap < 350) return pedido;

  const intro = [
    '[CONTEXTO ORDAX - CONTINUIDADE DE UMA TAREFA PERSISTENTE]',
    'Projeto/Task persistente: ' + short(title || 'Sem título',140),
    'Checkpoint confirmado: ' + short(checkpoint || 'Sem checkpoint ainda.',900)
  ];
  const outro = [
    'Instrução de continuidade: use somente o contexto confirmado como memória canônica; preservar decisões, objetivos, restrições, pendências e trabalho realizado. Uma conversa interna nova NÃO significa projeto novo. Se houver lacuna ou contradição, sinalize sem inventar. Itens omitidos continuam disponíveis no OrdaX, mas não foram fornecidos aqui.',
    '[FIM DO CONTEXTO ORDAX]'
  ];
  const overhead = lengthOf(intro) + lengthOf(outro) + 160;
  if (overhead >= cap) return pedido;
  const available = cap - overhead;
  const canonical = memoryItems.filter(item=>item && item.status !== 'archived');
  const queryWords = words(pedido);
  const indexed = canonical.map((item,i)=>{
    const keyWords=words(item.key);
    const matches=[...keyWords].filter(w=>queryWords.has(w)).length;
    const rank=PRIORITY.indexOf(item.category);
    return {item,i,matches,rank:rank < 0 ? PRIORITY.length : rank};
  }).sort((a,b)=>a.rank-b.rank || b.matches-a.matches || a.i-b.i);
  // Give each memory category a chance before a large goal/decision list consumes
  // the entire budget. The remainder follows deterministic priority and relevance.
  const firstPerCategory = PRIORITY.map(category=>indexed.find(entry=>entry.item.category===category)).filter(Boolean);
  const seededIds = new Set(firstPerCategory.map(entry=>entry.i));
  const ordered = [...firstPerCategory,...indexed.filter(entry=>!seededIds.has(entry.i))];
  const memBudget = Math.floor(available * .65);
  const memLines = [];
  let memSize=0,omittedMemory=0;
  for(const {item} of ordered) {
    const label=LABELS[item.category] || clean(item.category).toUpperCase() || 'MEMORIA';
    const line='['+label+'] '+short(item.key,130)+': '+short(item.content,380);
    if(memSize+line.length+1<=memBudget) {
      memLines.push(line); memSize += line.length+1;
    } else omittedMemory++;
  }
  const remainingBudget=available-memSize;
  const recent=[];
  let recentSize=0,omittedMessages=0;
  for(const message of [...recentMessages].slice(-8).reverse()) {
    const role=message.role==='assistant' ? 'ASSISTENTE' : 'USUARIO';
    const text=short(message.content,460);
    const assets=(message.assets||[]).slice(0,3)
      .map(asset=>'ARTEFATO '+short(asset.kind,32)+': '+short(asset.alt||asset.id||'',100));
    const line=[text ? role+': '+text : null,...assets].filter(Boolean).join(' | ');
    if(!line)continue;
    if(recentSize+line.length+1<=remainingBudget) {
      recent.push(line);recentSize+=line.length+1;
    } else omittedMessages++;
  }
  const result=[
    ...intro,
    ...(canonical.length ? ['Memória estruturada canônica do projeto:',...memLines] : []),
    ...(omittedMemory ? ['[MEMORIA PARCIAL] '+omittedMemory+' itens canônicos não incluídos neste pacote; não assuma seu conteúdo.'] : []),
    ...(recent.length ? ['Histórico recente do projeto:',...recent.reverse()] : []),
    ...(omittedMessages ? ['[HISTORICO PARCIAL] '+omittedMessages+' mensagens recentes omitidas por limite de contexto.'] : []),
    ...outro
  ].join('\n');
  // This is an invariant, not a reason to truncate a field.
  if(result.length>cap)throw new Error('continuation_budget_invariant_failed');
  return result+suffix;
}
