import { execFile } from 'node:child_process';

export interface DockerResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface DockerOptions {
  /** Extra environment for the docker CLI process. Pass secrets here and reference them as `-e NAME` (no value) so they never appear in argv. */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Do not throw on a non-zero exit code. */
  allowFail?: boolean;
  /** Strings to mask in any error message. */
  secrets?: string[];
}

export function redact(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join('***');
  // Connection strings: postgres://user:password@host
  return out.replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+@/gi, '$1***@');
}

/** Runs the docker CLI without a shell. */
export function docker(args: string[], opts: DockerOptions = {}): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      args,
      {
        env: { ...process.env, ...opts.env },
        timeout: opts.timeoutMs ?? 600_000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        if (error && !opts.allowFail) {
          const e = new Error(
            redact(
              `docker ${args.slice(0, 3).join(' ')} failed (code ${String(error.code)}): ${stderr || error.message}`,
              opts.secrets,
            ),
          );
          reject(e);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr), code });
      },
    );
  });
}

export interface HostInfo {
  cpus: number;
  memoryMiB: number;
  serverVersion: string;
}

/** CPUs and memory of the Docker host (on Docker Desktop: the Linux VM). */
export async function dockerHostInfo(): Promise<HostInfo> {
  const r = await docker(['info', '--format', '{{.NCPU}} {{.MemTotal}} {{.ServerVersion}}']);
  const [cpus, mem, version] = r.stdout.trim().split(' ');
  return {
    cpus: Number(cpus),
    memoryMiB: Math.floor(Number(mem) / 1024 / 1024),
    serverVersion: version ?? 'unknown',
  };
}
