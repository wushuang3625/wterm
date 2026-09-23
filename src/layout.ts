export type Layout = { sid: string } | { direction: 'h' | 'v'; ratio: number; first: Layout; second: Layout };
export interface WorkspaceTab { id: string; root: Layout; focused: string }
export function leaves(node: Layout): string[] {
  return 'sid' in node ? [node.sid] : [...leaves(node.first), ...leaves(node.second)];
}
export function splitLeaf(node: Layout, sid: string, added: string, direction: 'h' | 'v'): Layout {
  if ('sid' in node) return node.sid === sid ? { direction, ratio: .5, first: node, second: { sid: added } } : node;
  return { ...node, first: splitLeaf(node.first, sid, added, direction), second: splitLeaf(node.second, sid, added, direction) };
}
export function removeLeaf(node: Layout, sid: string): Layout | null {
  if ('sid' in node) return node.sid === sid ? null : node;
  const first = removeLeaf(node.first, sid), second = removeLeaf(node.second, sid);
  return first && second ? { ...node, first, second } : first || second;
}
export function swapLeaves(node: Layout, a: string, b: string): void {
  if ('sid' in node) node.sid = node.sid === a ? b : node.sid === b ? a : node.sid;
  else { swapLeaves(node.first, a, b); swapLeaves(node.second, a, b); }
}
export function grid(ids: string[], columns: number): Layout {
  const chain = (nodes: Layout[], direction: 'h' | 'v'): Layout => nodes.length === 1 ? nodes[0] : {
    direction, ratio: 1 / nodes.length, first: nodes[0], second: chain(nodes.slice(1), direction),
  };
  const rows: Layout[] = [];
  for (let i = 0; i < ids.length; i += columns) rows.push(chain(ids.slice(i, i + columns).map(sid => ({ sid })), 'h'));
  return chain(rows, 'v');
}
