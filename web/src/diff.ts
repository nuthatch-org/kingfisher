export type Line = { op: ' ' | '-' | '+'; text: string };

const CAP = 600;

/** Line diff by longest common subsequence. Edits are small; past CAP lines it degrades to delete-all/add-all. */
export function diffLines(a: string, b: string): Line[] {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.length > CAP || y.length > CAP) {
    return [...x.map((t) => ({ op: '-' as const, text: t })), ...y.map((t) => ({ op: '+' as const, text: t }))];
  }
  const n = x.length;
  const m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: ' ', text: x[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ op: '-', text: x[i++] });
    } else {
      out.push({ op: '+', text: y[j++] });
    }
  }
  while (i < n) out.push({ op: '-', text: x[i++] });
  while (j < m) out.push({ op: '+', text: y[j++] });
  return out;
}

/** The before/after pairs a file tool carries, if any. */
export function editsOf(tool: string, input: any): { before: string; after: string }[] | null {
  if (!input || typeof input !== 'object') return null;
  if (typeof input.old_string === 'string') return [{ before: input.old_string, after: input.new_string ?? '' }];
  if (Array.isArray(input.edits)) {
    return input.edits
      .filter((e: any) => typeof e?.old_string === 'string')
      .map((e: any) => ({ before: e.old_string, after: e.new_string ?? '' }));
  }
  if (tool === 'Write' && typeof input.content === 'string') return [{ before: '', after: input.content }];
  return null;
}

export function renderDiff(edits: { before: string; after: string }[]): HTMLElement {
  const root = document.createElement('div');
  root.className = 'diff';
  edits.forEach((e, k) => {
    if (k > 0) root.append(Object.assign(document.createElement('div'), { className: 'hunk-gap', textContent: '⋯' }));
    const lines = e.before === '' ? e.after.split('\n').map((text) => ({ op: '+' as const, text })) : diffLines(e.before, e.after);
    for (const l of lines.slice(0, 400)) {
      const row = document.createElement('div');
      row.className = l.op === '+' ? 'add' : l.op === '-' ? 'del' : 'ctx';
      row.textContent = `${l.op} ${l.text}`;
      root.append(row);
    }
    if (lines.length > 400) root.append(Object.assign(document.createElement('div'), { className: 'hunk-gap', textContent: `… ${lines.length - 400} more lines` }));
  });
  return root;
}
