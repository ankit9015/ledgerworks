/**
 * pnpm llm:smoke
 *
 *   LLM_BASE_URL=https://api.groq.com/openai/v1 LLM_API_KEY=... LLM_MODEL=... pnpm llm:smoke
 *
 * Reads the three variables from the environment only. Runs a plain chat, a streaming chat and one
 * tool-call round trip, prints a summary with the key masked, and saves the sanitised raw report
 * under docs/benchmarks/raw/. Exits with code 2 without making any request when a variable is missing.
 */
import path from 'node:path';
import { formatSummary, readSmokeEnv, runSmoke, saveReport } from './smoke.js';

const parsed = readSmokeEnv(process.env);
if (!parsed.ok) {
  console.error(
    `Not run: set ${parsed.missing.join(', ')} in the environment (no request was made).`,
  );
  process.exit(2);
}
const { env } = parsed;
const report = await runSmoke(env);
console.log(formatSummary(report));
const dir = path.resolve(import.meta.dirname, '../../../docs/benchmarks/raw');
console.log(`saved ${await saveReport(report, dir, env.apiKey)}`);
process.exit(report.ok ? 0 : 1);
