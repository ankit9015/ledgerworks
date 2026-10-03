import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { formatSummary, readSmokeEnv, runSmoke, sanitizeReport, saveReport } from './smoke.js';
import {
  chunk,
  completion,
  json,
  sseData,
  sseStart,
  startMock,
  type MockServer,
} from './testing/mock-server.js';

const KEY = 'gsk_SMOKEKEY0123456789abcdef';
let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** A mock that behaves like a provider, and that ECHOES the key and the Authorization header back in its text. */
async function mock(): Promise<MockServer> {
  server = await startMock((r, res) => {
    const body = JSON.parse(r.body) as {
      stream?: boolean;
      messages: { role: string }[];
      tools?: unknown[];
    };
    const echo = `you sent ${String(r.headers.authorization)} and ${KEY}`;
    if (body.stream) {
      sseStart(res);
      res.end(
        sseData(chunk({ content: `1, 2, 3 ${echo}` })) +
          sseData(chunk({}, 'stop')) +
          'data: [DONE]\n\n',
      );
      return;
    }
    if (body.tools && !body.messages.some((m) => m.role === 'tool')) {
      return json(
        res,
        200,
        completion(
          {
            content: null,
            tool_calls: [
              {
                id: 't1',
                type: 'function',
                function: { name: 'add_numbers', arguments: '{"a":2,"b":3}' },
              },
            ],
          },
          'tool_calls',
          { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
        ),
      );
    }
    return json(
      res,
      200,
      completion({ content: body.tools ? `The sum is 5. ${echo}` : `pong ${echo}` }, 'stop', {
        prompt_tokens: 5,
        completion_tokens: 2,
        total_tokens: 7,
      }),
    );
  });
  return server;
}

describe('smoke script', () => {
  it('reports what is missing from the environment and makes no request', () => {
    expect(readSmokeEnv({})).toEqual({
      ok: false,
      missing: ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'],
    });
    expect(readSmokeEnv({ LLM_BASE_URL: 'x', LLM_API_KEY: 'y' })).toEqual({
      ok: false,
      missing: ['LLM_MODEL'],
    });
    expect(readSmokeEnv({ LLM_BASE_URL: 'x', LLM_API_KEY: 'y', LLM_MODEL: 'z' })).toMatchObject({
      ok: true,
    });
  });

  it('the command exits with code 2 and a clear message when the variables are not set', () => {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'smoke-cli.ts');
    const env = { ...process.env };
    for (const k of ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL']) delete env[k];
    const r = spawnSync(process.execPath, ['--import', 'tsx', file], {
      encoding: 'utf8',
      env,
      cwd: path.resolve(path.dirname(file), '../..'),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Not run: set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL/);
  }, 60_000);

  it('runs the three checks against a mock server; neither the report nor the summary nor the saved file contains the key', async () => {
    const s = await mock();
    const report = await runSmoke({ baseURL: `${s.url}/v1`, apiKey: KEY, model: 'mock' });
    expect(report.ok).toBe(true);
    expect(report.steps.map((x) => [x.name, x.ok])).toEqual([
      ['plain_chat', true],
      ['streaming_chat', true],
      ['tool_round_trip', true],
    ]);
    expect(report.steps[1]!.streamEvents).toMatchObject({ text_delta: 1, done: 1 });
    expect(report.steps[2]!.toolCalls).toEqual([
      { name: 'add_numbers', arguments: { a: 2, b: 3 } },
    ]);
    expect(report.key).toBe('••••cdef');
    // the mock echoed the key into the model text: it must be gone everywhere
    const text = JSON.stringify(report) + formatSummary(report);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('SMOKEKEY');
    expect(text.toLowerCase()).not.toContain('bearer gsk');
    expect(report.steps[0]!.contentPreview).toContain('[REDACTED]');
    // the server did receive the key (so the test is not vacuous)
    expect(s.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);

    const dir = await mkdtemp(path.join(os.tmpdir(), 'smoke-'));
    const file = await saveReport(report, dir, KEY);
    const saved = await readFile(file, 'utf8');
    expect(saved).not.toContain(KEY);
    expect(saved).not.toMatch(/authorization/i.source === 'x' ? /x/ : /Bearer\s+[A-Za-z0-9]/);
    expect(await readdir(dir)).toHaveLength(1);
    await expect(saveReport(report, dir, KEY)).rejects.toThrow(/EEXIST/); // never overwrites
  });

  it('a failing endpoint gives a typed error in the report, with the key scrubbed from it', async () => {
    server = await startMock((_r, res) =>
      json(res, 401, { error: { message: `Invalid API key ${KEY}` } }),
    );
    const report = await runSmoke({ baseURL: `${server.url}/v1`, apiKey: KEY, model: 'mock' });
    expect(report.ok).toBe(false);
    expect(report.steps.every((x) => x.error?.kind === 'auth_failed')).toBe(true);
    expect(JSON.stringify(report)).not.toContain(KEY);
  });

  it('sanitizeReport removes Authorization headers and key-shaped values anywhere in a structure', () => {
    const dirty = {
      headers: { Authorization: `Bearer ${KEY}`, 'x-api-key': KEY },
      nested: [{ note: `token ${KEY} end` }],
      url: 'https://user:pw12345@host.example/v1',
    };
    const clean = JSON.stringify(sanitizeReport(dirty, KEY));
    expect(clean).not.toContain(KEY);
    expect(clean).not.toContain('pw12345');
    expect(clean).not.toMatch(/Bearer\s+[A-Za-z0-9]{8}/);
  });
});
