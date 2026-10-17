import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestFromExplicitText, SUGGESTION_EXTRACTOR_VERSION } from '../src/memory-suggestions.mjs';

test('explicit project statements produce conservative local suggestions', () => {
  const result = suggestFromExplicitText([
    'Personagem Caio: Protagonista de 35 anos e morador de Salvador.',
    'Capítulo 2: O retorno à cidade acontece ao amanhecer.',
    'Regra: narrar sempre em terceira pessoa limitada.',
    'Decidimos que o final não terá um salto temporal.',
    'Me ajude com uma ideia sobre o livro.',
    '> Regra: esta linha citada não é uma decisão minha.'
  ].join('\n'));
  assert.equal(SUGGESTION_EXTRACTOR_VERSION, 'explicit-project-v2');
  assert.equal(result.length, 4);
  assert.deepEqual(result.map(x => x.category), ['entity','structure','constraint','decision']);
  assert.equal(result[0].key, 'Caio');
  assert.match(result[0].evidence, /Personagem Caio/);
});

test('uncertain conversation text does not become project memory', () => {
  assert.deepEqual(suggestFromExplicitText('Será que o personagem poderia se chamar Caio?'), []);
  assert.deepEqual(suggestFromExplicitText('Qual é o Capítulo 2?'), []);
  assert.deepEqual(suggestFromExplicitText('Responda exatamente: ORDAX_UI_FAST_OK'), []);
});

test('named project declarations work for software, research and planning without a domain template', () => {
  const result=suggestFromExplicitText([
    'Objetivo MVP: atender clientes mesmo sem internet.',
    'Decisão Persistência: utilizar o SQLite local como fonte canônica.',
    'Restrição Dados: não sincronizar documentos privados sem autorização.',
    'Pendência Autenticação: concluir testes de SSO no fluxo principal.',
    'Estrutura Módulos: separar UI, worker e banco de dados.',
    'Componente Gateway: isolar o provider por interface.',
    'Talvez pudéssemos usar outro banco.'
  ].join('\n'));
  assert.deepEqual(result.map(x=>x.category),[
    'goal','decision','constraint','open_loop','structure','entity'
  ].slice(0,5)); // detector intentionally limits candidates to five per message
  assert.equal(result[0].key,'MVP');
  assert.equal(result[1].key,'Persistência');
  assert.equal(result[2].key,'Dados');
  assert.equal(result[3].key,'Autenticação');
  assert.ok(result.every(x=>x.content.length>=5));
});
