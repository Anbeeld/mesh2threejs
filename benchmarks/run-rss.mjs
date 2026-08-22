#!/usr/bin/env node
/**
 * Runs a heavy benchmark as a child process and records its externally observed peak RSS.
 * In-process synchronous RSS sampling can miss transient peaks behind a blocked event loop, so the
 * parent samples the child's resident set from the operating system instead.
 *
 * Usage: node benchmarks/run-rss.mjs [benchmark.ts ...]
 */
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function sampleRss(pid) {
  if (process.platform === "linux") {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+) kB$/mu.exec(status);
    return match ? Number(match[1]) * 1024 : undefined;
  }
  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
    const kilobytes = Number(stdout.trim());
    return Number.isFinite(kilobytes) ? kilobytes * 1024 : undefined;
  }
  const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`]);
  const bytes = Number(stdout.trim());
  return Number.isFinite(bytes) ? bytes : undefined;
}

function runBenchmark(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", script], { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    let peak = 0;
    let samples = 0;
    const interval = setInterval(async () => {
      try {
        const rss = await sampleRss(child.pid);
        if (rss !== undefined) { peak = Math.max(peak, rss); samples += 1; }
      } catch { /* child already exited */ }
    }, process.platform === "win32" ? 500 : 200);
    interval.unref();
    child.on("error", (error) => { clearInterval(interval); reject(error); });
    child.on("exit", (code) => {
      clearInterval(interval);
      const lines = stdout.trim().split(/\r?\n/u).filter((line) => line.startsWith("{"));
      let childReport = null;
      try { childReport = lines.length ? JSON.parse(lines.at(-1)) : null; } catch { /* child reported a non-JSON tail */ }
      resolve({ benchmark: script, exitCode: code ?? -1, externallyObserved: { peakRssBytes: peak, samples }, childReport });
    });
  });
}

const benchmarks = process.argv.slice(2);
const targets = benchmarks.length ? benchmarks : ["benchmarks/glb-ingest.bench.ts", "benchmarks/hard-surface-stress.bench.ts"];
const results = [];
let failed = false;
for (const target of targets) {
  const result = await runBenchmark(target);
  results.push(result);
  if (result.exitCode !== 0) failed = true;
}
process.stdout.write(`${JSON.stringify({ workload: "externally observed heavy benchmarks", results }, null, 2)}\n`);
if (failed) process.exitCode = 1;
