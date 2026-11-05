// Run after npm run build, with ABLA_COMPILER_GRAPH and ABLA_SYSROOT configured.
// The project is read-only: the edit is an in-memory comment overlay.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CompilerClient } from '../dist/src/compiler-client.js';
const [rootArgument, entryArgument, mode] = process.argv.slice(2);
if (!rootArgument || !entryArgument) throw new Error('usage: node tools/measure-graph-refresh.mjs PROJECT ENTRY [full|projected]');
const root = path.resolve(rootArgument);
const entry = path.resolve(root, entryArgument);
if (!mode) {
  const runs = [];
  for (let round = 0; round < 3; round += 1) {
    for (const view of round % 2 ? ['projected', 'full'] : ['full', 'projected']) {
      const child = spawnSync(process.execPath, [process.argv[1], root, entry, view], { encoding: 'utf8', env: process.env });
      if (child.status !== 0) throw new Error(child.stderr || child.stdout);
      runs.push({ round: round + 1, ...JSON.parse(child.stdout) });
    }
  }
  console.log(JSON.stringify({ compiler: process.env.ABLA_COMPILER_GRAPH, root, entry, runs }, null, 2));
} else {
  if (!['full', 'projected'].includes(mode)) throw new Error('invalid view');
  const client = new CompilerClient({ executable: process.env.ABLA_COMPILER_GRAPH ?? 'ablac' });
  let wireReply;
  const request = client.request.bind(client);
  client.request = async (...args) => {
    const reply = await request(...args);
    if (args[0] === 'analyze') wireReply = reply;
    return reply;
  };
  try {
    const initialized = await client.start({ workspaceRoots: [root], analysisMode: 'graph-v1', clientName: 'refresh-measurement', clientVersion: '0' });
    if (!initialized.capabilities.includes('analysis-fields-v1')) throw new Error('compiler lacks projections');
    const results = [];
    for (const phase of ['cold', 'noop', 'edit']) {
      if (phase === 'edit') await client.open({ uri: pathToFileURL(entry).href, version: 1, text: (await fs.readFile(entry, 'utf8')) + '\n// editor latency measurement\n' });
      const start = performance.now();
      const snapshot = await client.analyze({ roots: [root], ...(mode === 'projected' ? { fields: ['diagnostics', 'symbols'] } : {}) });
      const seconds = (performance.now() - start) / 1000;
      const wireBytes = Buffer.byteLength(JSON.stringify(wireReply));
      results.push({ phase, seconds, wireBytes, documents: snapshot.documents.length, complete: snapshot.complete, pending: snapshot.pending?.length, diagnostics: snapshot.documents.reduce((n, d) => n + d.diagnostics.length, 0), symbols: snapshot.documents.reduce((n, d) => n + d.symbols.length, 0), occurrences: snapshot.documents.reduce((n, d) => n + d.occurrences.length, 0), unavailableOccurrences: snapshot.documents.filter(d => d.occurrencesAvailable === false).length });
    }
    console.log(JSON.stringify({ mode, results }));
  } finally { await client.stop(); }
}
