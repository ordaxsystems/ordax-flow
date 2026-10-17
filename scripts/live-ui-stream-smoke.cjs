process.env.ORDAX_REQUIRE_STREAM='1';
process.env.ORDAX_E2E_MARKER='ORDAX_STREAM_GATE';
process.env.ORDAX_E2E_PROMPT='Escreva 40 linhas. Em cada linha, escreva exatamente ORDAX_STREAM_GATE. Não use markdown e não acrescente nenhum outro texto.';
require('./live-ui-text-smoke.cjs');
