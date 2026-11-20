import { fileTools } from '../src/index.js';

// Explicitly serialize application state inside LayerFS, including Python/model
// state needed by the next invocation. Bump version when implementation changes.
export const registry = fileTools().register('counter.add', {
  randomness: 'none',
  version: '1',
  mutates: true,
  execute: async (env, { amount }) => {
    if (!Number.isSafeInteger(amount)) throw new TypeError('amount must be an integer');
    const state = JSON.parse(await env.read('/counter.json'));
    state.count += amount;
    await env.write('/counter.json', JSON.stringify(state));
    return state;
  }
});
