import { homedir } from 'node:os';
import { posix } from 'node:path';

function baseDirectory(value: string | undefined, fallback: string): string {
  return value && posix.isAbsolute(value) ? value : fallback;
}

export function linuxDataDirectory(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return posix.join(baseDirectory(env.XDG_DATA_HOME, posix.join(home, '.local', 'share')), 'matrix-launcher');
}

export function linuxStateDirectory(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return posix.join(baseDirectory(env.XDG_STATE_HOME, posix.join(home, '.local', 'state')), 'matrix-launcher');
}
