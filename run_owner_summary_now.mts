import 'dotenv/config';
import pino from 'pino';
import { runOwnerSummaries } from './src/services/runOwnerSummaries.js';

const log = pino({
  level: 'info',
  transport: { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } },
});

console.log('Running owner summaries with corrected phone (8825959572)...\n');
await runOwnerSummaries(log);
console.log('\nDone.');
