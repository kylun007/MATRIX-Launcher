import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWelcomeProgress, shouldAutoWelcome, welcomeDefaults } from '../shared/welcome.ts';

test('welcome progress is versioned, resumable and tolerant of corrupt browser state', () => {
  assert.deepEqual(parseWelcomeProgress(null), welcomeDefaults);
  const saved = { ...welcomeDefaults, status: 'inProgress' as const, step: 4, tipsSeen: ['modcenter'] };
  assert.deepEqual(parseWelcomeProgress(JSON.stringify(saved)), saved);
  assert.deepEqual(parseWelcomeProgress('{broken'), welcomeDefaults);
  assert.deepEqual(parseWelcomeProgress(JSON.stringify({ ...saved, step: 99 })), welcomeDefaults);
});

test('first-run welcome is shown only for a new setup or a resumable welcome', () => {
  assert.equal(shouldAutoWelcome(welcomeDefaults, false), true);
  assert.equal(shouldAutoWelcome({ ...welcomeDefaults, status: 'inProgress', step: 3 }, false), true);
  assert.equal(shouldAutoWelcome(welcomeDefaults, true), false);
  assert.equal(shouldAutoWelcome({ ...welcomeDefaults, status: 'skipped' }, false), false);
  assert.equal(shouldAutoWelcome({ ...welcomeDefaults, status: 'completed' }, false), false);
});
