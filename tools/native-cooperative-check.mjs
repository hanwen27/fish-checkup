import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createCooNativeHost, loadCooNativeBindings } from '../src/coo-native-host.mjs';
import { CooperativeCheckup, cooperativeReportText } from '../src/cooperative-checkup.mjs';

if (!process.env.COO_SOURCE_ROOT || !process.env.COO_CHECKUP_OUTPUT) throw Error('Explicit COO_SOURCE_ROOT and COO_CHECKUP_OUTPUT required.');
const output = resolve(process.env.COO_CHECKUP_OUTPUT); mkdirSync(output, { recursive: true });
const Native = await loadCooNativeBindings(process.env.COO_SOURCE_ROOT);
const host = createCooNativeHost({ Native, dataDir: output,
  runtime: () => ({ stageTokens: 256000, softRatio: .85, keepRatio: .25, origin: 'example-policy' }) });
const engine = new CooperativeCheckup({ host, save() {} });
const preflight = await engine.preflight({ mode: 'mechanism', groups: ['handoff', 'memory'] });
if (!preflight.ready) throw Error(preflight.error);
const started = engine.start({ planId: preflight.plan.id, disclosureHash: preflight.plan.disclosureHash, accepted: true });
if (!started.ok) throw Error(started.error);
await engine.task;
writeFileSync(join(output, '深度体检-原生机制实测.json'), JSON.stringify(engine.status(), null, 2));
writeFileSync(join(output, '深度体检-原生机制实测.txt'), cooperativeReportText(engine.run));
console.log(JSON.stringify({ state: engine.run.state, reason: engine.run.reason, source: Native.source.fingerprint,
  results: engine.run.results.map(({ id, outcome, evidence }) => ({ id, outcome, warnings: evidence.warningCount })),
  cleanup: engine.run.cleanup, usage: engine.run.usage }));
if (engine.run.state !== 'completed' || engine.run.results.some((row) => row.outcome !== 'pass')) process.exitCode = 1;
