#!/usr/bin/env node
/**
 * backend-watchdog.mjs — Growing-Kids 后端看门狗（由 Windows 计划任务每分钟调用一次）
 *
 * 行为：
 *   1. 3001 无监听 → 带 OCR 三件套环境变量拉起 `node dist/main -p 3001`
 *      （detached + unref，生命周期独立于本进程，也独立于任何会话）
 *   2. 3001 在监听，但监听进程启动时间早于 dist/main.js 最后修改时间、且距本次构建已过宽限期
 *      → 判定在跑旧构建 → 杀掉同轮重拉（宽限期默认 60s：构建后先留时间给手动重启，
 *      超过宽限期还没换新代码才自动动手）
 *   3. 端口在监听且代码新鲜 → 静默退出（健康时不写日志，避免刷屏）
 *
 * 防误伤：
 *   - 拉起前先查是否存在 dist/main 进程（正在启动/已挂起）→ 有则不重复拉起
 *   - 两次拉起间隔至少 45s（崩溃循环时不会每分钟狂拉）
 *   - 杀旧进程前确认全局只有一个 dist/main 进程，多个则只告警不动手
 *   - logs/.watchdog-disabled 存在 → 整体停用（维护窗口用，删掉即恢复）
 *   - logs/.watchdog-keep-stale 存在 → 只保活，不自动重启旧代码
 *
 * 日志：
 *   - logs/watchdog.log            看门狗决策（只记动作，不记心跳）
 *   - logs/.watchdog-heartbeat     每次成功运行 touch 一下（只看 mtime，判断看门狗是否活着）
 *   - logs/backend-YYYY-MM-DD.log  被拉起的后端 stdout/stderr（进程崩溃终于有据可查）
 *
 * 手动运行：node scripts/backend-watchdog.mjs
 * 测试用环境变量：WATCHDOG_STALE_GRACE_MS=1000（把宽限期压到 1s，立即验证旧构建重启路径）
 */
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_MAIN = path.join(SERVER_DIR, 'dist', 'main.js');
const LOGS_DIR = path.join(SERVER_DIR, 'logs');
const WATCHDOG_LOG = path.join(LOGS_DIR, 'watchdog.log');
const HEARTBEAT = path.join(LOGS_DIR, '.watchdog-heartbeat');
const DISABLE_FLAG = path.join(LOGS_DIR, '.watchdog-disabled');
const KEEP_STALE_FLAG = path.join(LOGS_DIR, '.watchdog-keep-stale');
const SPAWN_MARKER = path.join(LOGS_DIR, '.watchdog-last-spawn');

const PORT = Number(process.env.WATCHDOG_PORT || 3001);
const SPAWN_COOLDOWN_MS = 45_000;
const STALE_GRACE_MS = Number(process.env.WATCHDOG_STALE_GRACE_MS || 60_000);
const PORT_PROBE_TIMEOUT_MS = 1_500;
const BOOT_WAIT_MS = 30_000;
const KILL_WAIT_MS = 15_000;

// OCR 三件套：venv 与模型缓存必须在仓库外（否则开发者工具文件监听耗尽句柄 → EMFILE）
const OCR_ENV = {
  OCR_VENV_DIR: 'D:/AI/gk-ocr-env/.venv-py',
  PADDLE_PDX_CACHE_HOME: 'D:/AI/gk-ocr-env/.cache-paddlex',
  XDG_CACHE_HOME: 'D:/AI/gk-ocr-env/.cache-xdg',
};

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(msg) {
  const line = `[${ts()}] ${msg}\n`;
  try {
    fs.appendFileSync(WATCHDOG_LOG, line);
  } catch { /* 日志写不出去也不能中断看门狗 */ }
  process.stdout.write(line);
}

/** 执行一段 PowerShell，返回 stdout；失败抛错由调用方兜底 */
function ps(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
}

function isPortListening() {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: PORT });
    const done = (r) => {
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(PORT_PROBE_TIMEOUT_MS);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
  });
}

/** 监听 3001 的进程 PID（无监听返回 null） */
function getPortPid() {
  try {
    const out = ps(`(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`);
    const pid = Number(String(out).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** 进程启动时间（拿不到返回 null） */
function getProcStart(pid) {
  try {
    const out = ps(`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToString('yyyy-MM-ddTHH:mm:ss') }`);
    const s = String(out).trim();
    return s ? new Date(s) : null;
  } catch {
    return null;
  }
}

/** 所有命令行含 dist/main 的 node 进程 PID（启动中/挂起的后端） */
function findBackendProcs() {
  try {
    const out = ps(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*dist/main*' } | ForEach-Object { "$($_.ProcessId)" }`);
    return String(out)
      .split(/\r?\n/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

async function waitFor(cond, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function lastSpawnAtMs() {
  try {
    return fs.statSync(SPAWN_MARKER).mtimeMs;
  } catch {
    return 0;
  }
}

function backendLogPath() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return path.join(LOGS_DIR, `backend-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`);
}

/** 拉起后端；返回子进程对象（失败返回 null） */
function spawnBackend() {
  if (!fs.existsSync(DIST_MAIN)) {
    log(`ERROR: ${DIST_MAIN} 不存在，请先执行 cd server && npx nest build`);
    return null;
  }
  const logPath = backendLogPath();
  let fd;
  try {
    fd = fs.openSync(logPath, 'a');
    const child = spawn(process.execPath, ['dist/main', '-p', String(PORT)], {
      cwd: SERVER_DIR, // 必须是 server 目录：dotenv 从 cwd 加载 .env / .env.secrets
      env: { ...process.env, ...OCR_ENV },
      detached: true, // 脱离看门狗进程树，看门狗退出后后端继续活着
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
    child.on('error', (e) => log(`ERROR: 拉起后端进程失败: ${e.message}`));
    child.on('exit', (code) => log(`后端进程退出 code=${code}（堆栈见 ${path.basename(logPath)}）`));
    child.unref();
    fs.closeSync(fd); // 子进程已持有 dup 后的句柄，父进程可以关
    fs.writeFileSync(SPAWN_MARKER, String(Date.now()));
    log(`SPAWN: pid=${child.pid} node=${process.execPath} cwd=${SERVER_DIR} log=${path.basename(logPath)}`);
    return child;
  } catch (e) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    log(`ERROR: 拉起后端异常: ${e && e.message}`);
    return null;
  }
}

async function main() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  if (fs.existsSync(DISABLE_FLAG)) {
    return; // 停用期间完全静默
  }
  // 心跳：不写内容，只刷新 mtime，用于判断计划任务是否还在跑
  try {
    fs.closeSync(fs.openSync(HEARTBEAT, 'w'));
  } catch { /* ignore */ }

  const listening = await isPortListening();

  if (!listening) {
    const procs = findBackendProcs();
    if (procs.length > 0) {
      log(`SKIP: ${PORT} 未监听，但存在 dist/main 进程 [${procs.join(', ')}]（启动中或已挂起），本轮不重复拉起`);
      return;
    }
    const since = Date.now() - lastSpawnAtMs();
    if (since < SPAWN_COOLDOWN_MS) {
      log(`SKIP: 距上次拉起仅 ${Math.round(since / 1000)}s（冷却 ${SPAWN_COOLDOWN_MS / 1000}s），本轮不拉`);
      return;
    }
    const child = spawnBackend();
    if (!child) return;
    const ok = await waitFor(isPortListening, BOOT_WAIT_MS);
    if (ok) {
      log(`READY: 后端已在 ${BOOT_WAIT_MS / 1000}s 内监听 ${PORT}`);
    } else {
      log(`WARN: 拉起 ${BOOT_WAIT_MS / 1000}s 后 ${PORT} 仍未监听，请查看 logs/backend-*.log`);
    }
    return;
  }

  // 端口在监听：检查是否在跑旧构建
  if (fs.existsSync(KEEP_STALE_FLAG)) return;
  const pid = getPortPid();
  if (!pid) return;
  const start = getProcStart(pid);
  let distMtime = null;
  try {
    distMtime = fs.statSync(DIST_MAIN).mtime;
  } catch {
    return; // dist 都读不到，不管
  }
  if (!start) return;
  const now = Date.now();
  if (start.getTime() >= distMtime.getTime()) return; // 进程启动晚于最后构建，代码新鲜
  if (now - distMtime.getTime() <= STALE_GRACE_MS) return; // 构建后宽限期内，留时间给手动重启

  const procs = findBackendProcs();
  if (procs.length > 1) {
    log(`WARN: 同时存在多个 dist/main 进程 [${procs.join(', ')}]，不自动清理，请人工确认`);
    return;
  }
  log(`STALE: 后端 pid=${pid} 启动于 ${start.toLocaleString('zh-CN')}，早于最后构建 ${distMtime.toLocaleString('zh-CN')}，且距构建已超过宽限期 ${STALE_GRACE_MS / 1000}s，判定在跑旧构建，重启`);
  try {
    process.kill(pid);
  } catch (e) {
    log(`WARN: kill pid=${pid} 失败: ${e && e.message}`);
    return;
  }
  const freed = await waitFor(async () => !(await isPortListening()), KILL_WAIT_MS);
  if (!freed) {
    log(`WARN: kill 后 ${KILL_WAIT_MS / 1000}s 端口仍被占用，放弃本轮重启`);
    return;
  }
  const child = spawnBackend();
  if (!child) return;
  const ok = await waitFor(isPortListening, BOOT_WAIT_MS);
  if (ok) {
    log('READY: 新构建后端已就绪');
  } else {
    log('WARN: 重拉后仍未监听，请查看 logs/backend-*.log');
  }
}

main().catch((e) => {
  log(`ERROR: 看门狗自身异常: ${(e && e.stack) || e}`);
  process.exitCode = 1;
});
