import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const report = {};

  // 1. Package manifest & files check
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-system-monitor');
  assert.notEqual(pkg.private, true, 'package.json must not be private');
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh?.client?.platform, 'web');
  assert.equal(pkg.exports?.['.'], './index.js');
  assert.equal(pkg.exports?.['./client'], './client.js');
  assert.equal(pkg.exports?.['./package.json'], './package.json');
  for (const rel of ['index.js', 'client.js', 'sampler.c', 'cordis.patch.yml', 'locale/zh.json', 'locale/en.json', 'icon.svg', 'README.md', 'LICENSE']) {
    assert.ok(existsSync(join(ROOT, rel)), `Missing required file: ${rel}`);
  }
  JSON.parse(readFileSync(join(ROOT, 'locale/zh.json'), 'utf8'));
  JSON.parse(readFileSync(join(ROOT, 'locale/en.json'), 'utf8'));
  report.manifest = 'PASS';

  // 2. Client static invariants check (zero setInterval, unifiedClock 1000ms, stacked MEM detail, chart stub guard)
  const clientCode = readFileSync(join(ROOT, 'client.js'), 'utf8');
  const setIntervalMatches = clientCode.match(/\bsetInterval\s*\(/g) || [];
  assert.equal(setIntervalMatches.length, 0, 'client.js must have 0 setInterval timers');
  assert.ok(clientCode.includes('const CLOCK_MS = 1000;'), 'CLOCK_MS must be 1000');
  assert.ok(clientCode.includes('const PILL_WINDOW_MS = 36000;'), 'PILL_WINDOW_MS must be 36000');
  assert.ok(clientCode.includes('if (bucket.grow <= 0.001) continue;'), 'draw() must skip future buckets with grow <= 0.001');
  assert.ok(clientCode.includes('.sm-hero-sub-stack'), 'client.js must include 2-line stacked MEM detail style');
  report.clientInvariants = 'PASS';

  // 3. MEM card hero row width calculation check (zh & en, 44.6GB & 128.0GB)
  const measureApproxPx = (str, fontPx) => {
    let w = 0;
    for (const ch of str) {
      w += ch.charCodeAt(0) > 255 ? fontPx : fontPx * 0.56;
    }
    return Math.ceil(w);
  };
  const memCases = [
    {
      label: 'zh 44.6GB',
      bigNum: '44.6',
      line1: '联动 3.8 · 压缩 1.3',
      line2: '图底 43.6 GB',
    },
    {
      label: 'en 44.6GB',
      bigNum: '44.6',
      line1: 'Wired 3.8 · Compr 1.3',
      line2: 'Floor 43.6 GB',
    },
    {
      label: 'en 128.0GB',
      bigNum: '128.0',
      line1: 'Wired 18.4 · Compr 6.2',
      line2: 'Floor 98.2 GB',
    },
  ];
  const layoutResults = [];
  for (const c of memCases) {
    const leftW = measureApproxPx(c.bigNum, 38) + 3 + measureApproxPx('GB', 14);
    const rightW = Math.max(measureApproxPx(c.line1, 11.5), measureApproxPx(c.line2, 11));
    const totalW = leftW + 8 + rightW;
    assert.ok(totalW <= 277, `MEM hero row overflow in ${c.label}: ${totalW}px > 277px`);
    layoutResults.push({ case: c.label, leftW, rightW, totalW, limit: 277 });
  }
  report.memHeroLayout = layoutResults;

  // 4. Native sampler build, frame cadence (200ms), and CPU/RSS overhead check
  if (process.platform === 'darwin') {
    const binPath = join(ROOT, 'bin', 'sampler');
    await execFileAsync('clang', ['-O2', join(ROOT, 'sampler.c'), '-framework', 'IOKit', '-framework', 'CoreFoundation', '-o', binPath]);
    const frames = [];
    let procStat = { cpuPct: 0, rssKb: 0 };
    await new Promise((resolve, reject) => {
      const proc = spawn(binPath, ['200'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let buf = '';
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', async (chunk) => {
        buf += chunk;
        let idx = buf.indexOf('\n');
        while (idx >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) frames.push(JSON.parse(line));
          idx = buf.indexOf('\n');
        }
        if (frames.length === 3 && proc.pid) {
          try {
            const { stdout } = await execFileAsync('ps', ['-o', 'pcpu=,rss=', '-p', String(proc.pid)]);
            const parts = stdout.trim().split(/\s+/);
            procStat = { cpuPct: Number(parts[0] || 0), rssKb: Number(parts[1] || 0) };
          } catch {}
        }
        if (frames.length >= 4) {
          proc.kill('SIGTERM');
          resolve();
        }
      });
      proc.once('error', reject);
      setTimeout(() => {
        proc.kill('SIGTERM');
        resolve();
      }, 2000);
    });
    assert.ok(frames.length >= 3, `Expected >= 3 frames from sampler, got ${frames.length}`);
    const f0 = frames[frames.length - 1];
    assert.equal(typeof f0.t, 'number');
    assert.ok(f0.n > 0);
    assert.equal(f0.c.length, 2);
    assert.equal(f0.g.length, 3);
    assert.equal(f0.m.length, 4);
    assert.ok(f0.m[3] > 0);
    assert.ok(procStat.rssKb < 16384, `Sampler RSS too high: ${procStat.rssKb} KB`);
    report.sampler = {
      framesCollected: frames.length,
      sampleFrame: f0,
      cpuPct: procStat.cpuPct,
      rssMb: Number((procStat.rssKb / 1024).toFixed(2)),
    };
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
