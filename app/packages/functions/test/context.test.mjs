import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanInterviewTurns, interviewBusinessContext } from '../dist/lib/ops.js';

test('interview turns are trimmed, capped and need a question', () => {
  const long = 'x'.repeat(5000);
  const turns = cleanInterviewTurns([
    { question: '  What is this model for?  ', answer: '  Sales  ' },
    { question: 'Anything else?', answer: '   ' },
    { question: 'Long', answer: long },
  ]);
  assert.deepEqual(turns[0], { question: 'What is this model for?', answer: 'Sales' });
  assert.equal(turns[1].answer, '(no answer)');
  assert.ok(turns[2].answer.length <= 1500);
});

test('interview turns refuse a missing question and a non-list', () => {
  assert.throws(() => cleanInterviewTurns([{ question: '  ', answer: 'a' }]), /question/);
  assert.throws(() => cleanInterviewTurns('nope'), /list/);
});

test('interview turns never exceed the question limit, so the prompt stays bounded', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ question: `Q${i}`, answer: 'a' }));
  assert.equal(cleanInterviewTurns(many).length, 8);
});

test('the interview refuses to wrap up when there is nothing to summarise', async () => {
  const ws = 'aaaaaaaa-1111-4222-8333-444444444444';
  const model = 'bbbbbbbb-1111-4222-8333-444444444444';
  await assert.rejects(() => interviewBusinessContext({}, ws, model, [], '   ', true), /nothing to summarise/);
});

test('the interview rejects ids that are not GUIDs before doing any work', async () => {
  await assert.rejects(() => interviewBusinessContext({}, 'not-a-guid', 'also-not', [], '', false));
});
