/**
 * macOS 系统监控插件的宿主端。
 *
 * 原生采样器（sampler.c）每 200ms（5Hz）输出一行 CPU、GPU、内存 JSON。宿主端把这些行
 * 原样转成 NDJSON 长流，推给所有订阅的客户端。没有订阅者 5 秒后采样器自动退出。
 *
 * 路由：
 *   POST /system-monitor/stream     NDJSON 流，每行一帧
 *   POST /system-monitor/processes  占用最高的进程（CPU 与内存各 5 个）
 * 认证复用 connection.admit。
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { cpus, freemem, tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const inject = ['webServer', 'connection'];

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'sampler.c');
const LOCAL_BIN = join(HERE, 'bin', 'sampler');
const TMP_BIN = join(
  tmpdir(),
  `dsh-system-monitor-${typeof process.getuid === 'function' ? process.getuid() : 0}-${process.arch}`,
  'sampler'
);
const CHANNEL = '/system-monitor';
const SAMPLE_MS = 200;
const IDLE_STOP_MS = 5000;
const FALLBACK_MS = 1000;
const MAX_PROCESSES = 5;
const GIB = 1024 ** 3;

let resolvedBinPath = null;

/**
 * 确保采样器二进制存在且不比源码旧，必要时用 clang 编译。
 * 若插件安装目录只读，自动回退编译到系统临时目录。
 *
 * @returns {Promise<string|null>} 可执行的采样器路径，失败或非 macOS 返回 null。
 */
async function ensureSampler() {
  if (process.platform !== 'darwin' || !existsSync(SRC)) return null;
  const srcMtime = statSync(SRC).mtimeMs;
  if (resolvedBinPath && existsSync(resolvedBinPath) && statSync(resolvedBinPath).mtimeMs >= srcMtime) {
    return resolvedBinPath;
  }
  for (const candidate of [LOCAL_BIN, TMP_BIN]) {
    try {
      if (existsSync(candidate) && statSync(candidate).mtimeMs >= srcMtime) {
        resolvedBinPath = candidate;
        return candidate;
      }
      mkdirSync(dirname(candidate), { recursive: true });
      await execFileAsync(
        'clang',
        ['-O2', SRC, '-framework', 'IOKit', '-framework', 'CoreFoundation', '-o', candidate],
        { timeout: 60000 }
      );
      resolvedBinPath = candidate;
      return candidate;
    } catch {
      // 当前候选路径不可写或 clang 不可用，尝试下一个候选路径。
    }
  }
  return null;
}

/**
 * 读取请求体。
 *
 * @param {object} req - node:http 请求。
 * @returns {Promise<string>} 请求体文本。
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 解析 ps 输出，取前若干个进程。
 *
 * @param {string} stdout - ps 标准输出。
 * @returns {object[]} 进程数组。
 */
function parseProcesses(stdout) {
  const out = [];
  for (const line of stdout.split('\n').slice(1, 1 + MAX_PROCESSES)) {
    const match = /^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/.exec(line);
    if (match === null) continue;
    const command = match[4].trim();
    out.push({
      pid: Number(match[1]),
      cpu: Number.parseFloat(match[2]),
      memory: Number.parseFloat(match[3]),
      name: command.slice(command.lastIndexOf('/') + 1),
    });
  }
  return out;
}

/**
 * 取占用 CPU 与内存最高的进程。
 *
 * @returns {Promise<object>} cpu 与 memory 两个数组。
 */
async function collectProcesses() {
  if (process.platform === 'win32') return { cpu: [], memory: [] };
  const ps = (flag) =>
    execFileAsync('ps', ['-Ao', 'pid,pcpu,pmem,comm', flag], { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }).then((r) => r.stdout);
  if (process.platform === 'darwin') {
    const [byCpu, byMemory] = await Promise.all([ps('-r'), ps('-m')]);
    return { cpu: parseProcesses(byCpu), memory: parseProcesses(byMemory) };
  }
  const [byCpu, byMemory] = await Promise.all([ps('--sort=-pcpu'), ps('--sort=-pmem')]);
  return { cpu: parseProcesses(byCpu), memory: parseProcesses(byMemory) };
}

let prevCpuTimes = null;

function nodeOsFallbackFrame() {
  const list = cpus();
  let u = 0;
  let s = 0;
  let idle = 0;
  for (const core of list) {
    u += core.times.user + core.times.nice;
    s += core.times.sys + core.times.irq;
    idle += core.times.idle;
  }
  const total = u + s + idle;
  let userPct = 0;
  let sysPct = 0;
  if (prevCpuTimes && total > prevCpuTimes.total) {
    const dt = total - prevCpuTimes.total;
    userPct = Number(((100 * (u - prevCpuTimes.u)) / dt).toFixed(1));
    sysPct = Number(((100 * (s - prevCpuTimes.s)) / dt).toFixed(1));
  }
  prevCpuTimes = { u, s, total };
  const totG = totalmem() / GIB;
  const usedG = Math.max(0, totG - freemem() / GIB);
  return {
    t: Date.now(),
    n: list.length,
    low: true,
    c: [userPct, sysPct],
    g: [0, 0, 0],
    m: [Number(usedG.toFixed(3)), 0, 0, Number(totG.toFixed(3))],
  };
}

/**
 * 退回方案：在 macOS 无 clang 时用 top 与 ioreg 拼出一帧，非 macOS 退回 node:os。
 *
 * @returns {Promise<object>} 一帧数据，带 low:true。
 */
async function fallbackFrame() {
  if (process.platform !== 'darwin') {
    return nodeOsFallbackFrame();
  }
  try {
    const [top, ioreg, memsize] = await Promise.all([
      execFileAsync('top', ['-l', '1', '-n', '0', '-s', '0'], { timeout: 8000 }).then((r) => r.stdout),
      execFileAsync('ioreg', ['-r', '-c', 'IOAccelerator', '-d', '1', '-w0'], { timeout: 4000 }).then((r) => r.stdout).catch(() => ''),
      execFileAsync('sysctl', ['-n', 'hw.memsize'], { timeout: 2000 }).then((r) => Number(r.stdout.trim())),
    ]);
    const cpu = /CPU usage:\s*([\d.]+)%\s*user,\s*([\d.]+)%\s*sys/.exec(top);
    const mem = /PhysMem:\s*([\d.]+)([GM])\s*used\s*\(([\d.]+)([GM])\s*wired,\s*([\d.]+)([GM])\s*compressor/.exec(top);
    const toG = (v, u) => (u === 'G' ? Number(v) : Number(v) / 1024);
    const pick = (re) => {
      const m = re.exec(ioreg);
      return m === null ? 0 : Number(m[1]);
    };
    return {
      t: Date.now(),
      n: 0,
      low: true,
      c: [cpu ? Number(cpu[1]) : 0, cpu ? Number(cpu[2]) : 0],
      g: [pick(/"Device Utilization %"=(\d+)/), pick(/"Renderer Utilization %"=(\d+)/), pick(/"Tiler Utilization %"=(\d+)/)],
      m: mem ? [toG(mem[1], mem[2]), toG(mem[3], mem[4]), toG(mem[5], mem[6]), memsize / GIB] : [0, 0, 0, memsize / GIB],
    };
  } catch {
    return nodeOsFallbackFrame();
  }
}

/**
 * 管理采样来源：有订阅者才跑，最后一个订阅者走后 5 秒停。
 *
 * @param {Function} onFrame - 每帧回调，参数是一行 JSON 文本。
 * @returns {object} subscribe 返回取消函数，dispose 立即停止。
 */
function createSource(onFrame) {
  let subscribers = 0;
  let child = null;
  let timer = null;
  let stopTimer = null;
  let starting = false;

  const stop = () => {
    if (child !== null) {
      child.kill('SIGTERM');
      child = null;
    }
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const start = async () => {
    if (child !== null || timer !== null || starting) return;
    starting = true;
    const binPath = await ensureSampler();
    starting = false;
    if (subscribers === 0) return;
    if (binPath !== null) {
      const proc = spawn(binPath, [String(SAMPLE_MS)], { stdio: ['ignore', 'pipe', 'ignore'] });
      child = proc;
      let pending = '';
      let gotFrame = false;
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        gotFrame = true;
        pending += chunk;
        let index = pending.indexOf('\n');
        while (index >= 0) {
          onFrame(pending.slice(0, index));
          pending = pending.slice(index + 1);
          index = pending.indexOf('\n');
        }
      });
      proc.once('error', () => {
        resolvedBinPath = null;
      });
      proc.once('exit', () => {
        if (child === proc) child = null;
        if (!gotFrame) resolvedBinPath = null;
        if (subscribers > 0) setTimeout(() => void start(), 1000);
      });
      return;
    }
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        onFrame(JSON.stringify(await fallbackFrame()));
      } catch {
        // 单次失败保持上一帧。
      } finally {
        busy = false;
      }
    };
    void tick();
    timer = setInterval(() => void tick(), FALLBACK_MS);
  };

  return {
    subscribe() {
      subscribers += 1;
      if (stopTimer !== null) {
        clearTimeout(stopTimer);
        stopTimer = null;
      }
      void start();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        subscribers -= 1;
        if (subscribers === 0) stopTimer = setTimeout(stop, IDLE_STOP_MS);
      };
    },
    dispose() {
      subscribers = 0;
      if (stopTimer !== null) clearTimeout(stopTimer);
      stop();
    },
  };
}

/**
 * 插件入口。
 *
 * @param {object} ctx - 宿主端插件上下文。
 */
export function apply(ctx) {
  const clients = new Set();
  const source = createSource((line) => {
    for (const res of clients) {
      if (res.writableLength > 64 * 1024) continue;
      res.write(line + '\n');
    }
  });
  ctx.effect(() => () => source.dispose(), 'system-monitor: 采样器');

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CHANNEL,
    handler: async (req, res) => {
      const admission = ctx.connection.admit(req);
      if ('rejection' in admission) {
        res.writeHead(admission.rejection);
        res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden');
        return;
      }
      const endpoint = new URL(req.url, 'http://localhost').pathname.slice(CHANNEL.length + 1);
      if (req.method !== 'POST') {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      let message;
      try {
        message = JSON.parse((await readBody(req)) || '{}');
      } catch {
        res.writeHead(400);
        res.end('body is not JSON');
        return;
      }
      if (endpoint === 'stream') {
        res.writeHead(200, {
          'content-type': 'application/x-ndjson',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
        });
        res.socket?.setNoDelay(true);
        res.flushHeaders?.();
        clients.add(res);
        const release = source.subscribe();
        res.once('close', () => {
          clients.delete(res);
          release();
        });
        return;
      }
      if (endpoint === 'processes') {
        try {
          json(res, 200, {
            type: 'server-response',
            rpcId: message.rpcId,
            result: { ok: true, value: await collectProcesses() },
          });
        } catch (error) {
          json(res, 200, {
            type: 'server-response',
            rpcId: message.rpcId,
            result: { ok: false, error: { code: 'system-monitor/ps-failed', message: String(error), details: {} } },
          });
        }
        return;
      }
      res.writeHead(404);
      res.end('not found');
    },
  }), 'system-monitor: 路由');
}
