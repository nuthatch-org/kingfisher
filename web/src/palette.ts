import type { ToolKind } from './types';

export const KIND_COLOR: Record<ToolKind, string> = {
  read: '#6ec8ff',
  search: '#9a8cff',
  edit: '#ffb347',
  write: '#ffd76e',
  shell: '#ff5fa2',
  web: '#5fffd0',
  agent: '#c6ff6e',
  mcp: '#ff8a5f',
  other: '#c8c8d0',
};

export const KIND_GLYPH: Record<ToolKind, string> = {
  read: '◉',
  search: '◎',
  edit: '✎',
  write: '✚',
  shell: '❯',
  web: '◍',
  agent: '☾',
  mcp: '⬡',
  other: '·',
};

export const TEST_COMMAND = /\b(cargo\s+(nextest|test)|pytest|go\s+test|(npm|pnpm|yarn|bun)\s+(run\s+)?test|vitest|jest|yatr\s+(test|ci))\b/;
