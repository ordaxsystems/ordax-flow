// Deterministic, local, deliberately conservative v1 detector.
// Suggestions are untrusted until a user reviews and explicitly accepts them.
export const SUGGESTION_EXTRACTOR_VERSION = 'explicit-pt-v1';

const PREFIXES = [
  ['personagem','entity'], ['entidade','entity'], ['estrutura','structure'],
  ['decisão','decision'], ['decisao','decision'], ['regra','constraint'],
  ['restrição','constraint'], ['restricao','constraint'], ['objetivo','goal'],
  ['fato','fact'], ['pendência','open_loop'], ['pendencia','open_loop'],
  ['referência','reference'], ['referencia','reference']
];

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function suggestFromExplicitText(text) {
  const result = [];
  const seen = new Set();
  const lines = String(text || '').split(/\r?\n/).slice(0, 60);

  function add(category, key, content, evidence) {
    key = normalize(key).slice(0, 160);
    content = normalize(content).slice(0, 8000);
    const signature = category + '|' + key.toLocaleLowerCase('pt-BR') + '|' + content;
    if (!key || !content || content.length < 5 || seen.has(signature) || result.length >= 5) return;
    seen.add(signature);
    result.push({ category, key, content, evidence: normalize(evidence).slice(0, 600) });
  }

  for (const original of lines) {
    const line = original.trim();
    if (!line || line.length > 600 || /^[>\`]|^\s*[-*]\s/.test(line)) continue;
    const chapter = line.match(/^cap[ií]tulo\s+(\d+(?:\s*[-–]\s*[\p{L}\d ]{1,45})?)\s*:\s*(.{5,})$/iu);
    if (chapter) {
      add('structure', 'Capítulo ' + normalize(chapter[1]), chapter[2], line);
      continue;
    }
    const named = line.match(/^(personagem|entidade)\s+([\p{L}\p{M}\d '.-]{2,75})\s*:\s*(.{5,})$/iu);
    if (named) {
      add('entity', named[2], named[3], line);
      continue;
    }
    const protagonist = line.match(/^(?:o |a )?protagonista se chama\s+([\p{L}\p{M}][\p{L}\p{M} '.-]{1,70})(?:[.!]|$)/iu);
    if (protagonist) {
      add('entity', protagonist[1], 'Protagonista: ' + normalize(protagonist[1]), line);
      continue;
    }
    const declaration = line.match(/^([^:]{3,30}):\s*(.{5,})$/u);
    if (declaration) {
      const prefix = normalize(declaration[1]).toLocaleLowerCase('pt-BR');
      const category = PREFIXES.find(([name]) => name === prefix)?.[1];
      if (category) add(category, normalize(declaration[2]).slice(0, 75), declaration[2], line);
      continue;
    }
    const decided = line.match(/^(?:decidimos|definimos)\s+que\s+(.{8,})$/iu);
    if (decided) add('decision', normalize(decided[1]).slice(0, 75), decided[1], line);
  }
  return result;
}
