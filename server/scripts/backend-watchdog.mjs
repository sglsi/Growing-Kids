#!/usr/bin/env node
/**
 * backend-watchdog.mjs — Growing-Kids 后端看门狗
 *
 * 两种角色（同一文件）：
 *   - 默认（无参数）= 启动器：由 Windows 计划任务调用，确保守护进程存在；
 *     守护进程已活着就静默退出（计划任务因此只在登录时/兜底时闪一下）。
 *   - --daemon = 守护进程：无窗口常驻（detached + windowsHide），每 60s 自查一轮，
 *     用户登录时经计划任务自动重生。
 *
 * 自查逻辑（每轮）：
 *   1. 3001 无监听 → 带 OCR 三件套环境变量拉起 node dist/main -p 3001（windowsHide 隐藏）
 *   2. 3001 在监听，但进程启动早于 **dist 整树最大 mtime**、且距构建已过宽限期
 *      → 判定在跑旧构建 → 杀掉同轮重拉（宽限期默认 60s：构建后先留时间给手动重启）
 *      ⚠️ 判据必须是整树而非单个 main.js——tsc 增量构建下 main.js mtime 可能不变
 *   3. 端口在监听且代码新鲜 → 静默
 *
 * 为什么要有守护进程：直接让计划任务每分钟跑 node，会每分钟弹一次
 * WindowsTerminal 控制台窗口（本机默认终端应用是 Windows Terminal），严重干扰操作；
 * 常驻守护进程由启动器以 windowsHide 方式拉起，完全无窗口。
 * ⚠️ 沙箱机制：由 Bash/工具命令拉起的进程会被进程树回收，故守护进程必须由
 * 计划任务（而非终端命令）启动才能长期存活——启动器就是给计划任务用的。
 *
 * 防误伤：
 *   - 拉起前先查是否存在 dist/main 进程（正在启动/已挂起）→ 有则不重复拉起
 *   - 两次拉起间隔至少 45s（崩溃循环时不会狂拉）
 *   - 杀旧进程前确认全局只有一个 dist/main 进程，多个则只告警不动手
 *   - logs/.watchdog-disabled 存在 → 整体停用（维护窗口用，删掉即恢复）
 *   - logs/.watchdog-keep-stale 存在 → 只保活，不自动重启旧代码
 *   - 守护进程发现脚本自身被修改 → 退出等待计划任务重建（保证跑的总是最新代码）
 *
 * 日志：
 *   - logs/watchdog.log            决策记录（只记动作，不记心跳）
 *   - logs/.watchdog-heartbeat     每次自查 touch 一下（只看 mtime）
 *   - logs/watchdog-daemon.log     守护进程自身 stdout/stderr（异常时有据可查）
 *   - logs/backend-YYYY-MM-DD.log  被拉起的后端 stdout/stderr
 */
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SERVER_DIR = path.resolve(path.dirname(SCRIPT_PATH), '..');
const DIST_MAIN = path.join(SERVER_DIR, 'dist', 'main.js');
const LOGS_DIR = path.join(SERVER_DIR, 'logs');
const WATCHDOG_LOG = path.join(LOGS_DIR, 'watchdog.log');
const DAEMON_LOG = path.join(LOGS_DIR, 'watchdog-daemon.log');
const DAEMON_PID_FILE = path.join(LOGS_DIR, '.watchdog-daemon.pid');
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
const LOOP_INTERVAL_MS = 60_000;
const IS_DAEMON = process.argv.includes('--daemon');

// OCR 三件套：venv 与模型缓存必须在仓库外（否则开发者工具文件监听耗尽句柄 → EMFILE）
const OCR_ENV = {
  OCR_VENV_DIR: 'D:/AI/gk-ocr-env/.venv-py',
  PADDLE_PDX_CACHE_HOME: 'D:/AI/gk-ocr-env/.cache-paddlex',
  XDG_CACHE_HOME: 'D:/AI/gk-ocr-env/.cache-xdg',
  // 兜底：某些非交互环境下 TEMP 可能落到不可写位置，显式钉到仓库外目录
  TEMP: 'D:/AI/gk-ocr-env/.tmp',
  TMP: 'D:/AI/gk-ocr-env/.tmp',
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

/** 执行一段 PowerShell；windowsHide 保证不弹控制台窗口（守护进程无控制台时尤其重要） */
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

/**
 * dist 目录树的最大 mtime（毫秒）。
 *
 * ⚠️ 不能用单个 dist/main.js 的 mtime 判断「是否在跑旧构建」——tsc 增量构建
 * 只重编译变化文件，改了 controller 后 main.js 的 mtime 不变，进程启动时间
 * 晚于它 ⇒ 被误判为「代码新鲜」，后端永远跑旧代码（2026-10-24 实测：
 * 改 documents.controller 后 20 分钟没重启，根因就在这）。
 * 扫全树几千个文件 <10ms，60s 一轮的成本可忽略。
 */
function distTreeMtimeMs() {
  let latest = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      try {
        if (e.isDirectory()) walk(p);
        else {
          const m = fs.statSync(p).mtimeMs;
          if (m > latest) latest = m;
        }
      } catch { /* 文件在读的过程中被删/换，跳过 */ }
    }
  };
  walk(path.join(SERVER_DIR, 'dist'));
  return latest;
}

/** 所有命令行含指定关键字的 node 进程 PID */
function findNodeProcs(keyword) {
  try {
    const out = ps(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${keyword}*' } | ForEach-Object { "$($_.ProcessId)" }`);
    return String(out)
      .split(/\r?\n/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

const findBackendProcs = () => findNodeProcs('dist/main');

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
      detached: true,
      windowsHide: true, // 不弹控制台窗口（本机默认终端是 Windows Terminal）
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

// ============================ 一轮自查 ============================

async function runOnce() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  try {
    fs.mkdirSync(OCR_ENV.TEMP, { recursive: true });
  } catch { /* 建不了就让后端自己报错，日志里看得见 */ }

  if (fs.existsSync(DISABLE_FLAG)) return; // 停用期间完全静默
  // 心跳：不写内容，只刷新 mtime，用于判断看门狗是否在跑
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
  if (!start) return;
  // dist 整树最大 mtime（增量构建下 main.js 单独看不出来，见 distTreeMtimeMs 注释）
  const distMtimeMs = distTreeMtimeMs();
  if (!distMtimeMs) return; // dist 读不到，不管
  const now = Date.now();
  if (start.getTime() >= distMtimeMs) return; // 进程启动晚于最后构建，代码新鲜
  if (now - distMtimeMs <= STALE_GRACE_MS) return; // 构建后宽限期内，留时间给手动重启

  const procs = findBackendProcs();
  if (procs.length > 1) {
    log(`WARN: 同时存在多个 dist/main 进程 [${procs.join(', ')}]，不自动清理，请人工确认`);
    return;
  }
  log(`STALE: 后端 pid=${pid} 启动于 ${start.toLocaleString('zh-CN')}，早于最后构建 ${new Date(distMtimeMs).toLocaleString('zh-CN')}，且距构建已超过宽限期 ${STALE_GRACE_MS / 1000}s，判定在跑旧构建，重启`);
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

// ============================ 守护进程 ============================

/** 守护进程是否还活着（读 PID 文件 + 校验命令行，防 PID 复用误判） */
function isDaemonAlive() {
  try {
    const pid = Number(fs.readFileSync(DAEMON_PID_FILE, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
    process.kill(pid, 0); // 不存在会抛错
    const out = ps(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`);
    return String(out).includes('backend-watchdog');
  } catch {
    return false;
  }
}

function spawnDaemon() {
  const fd = fs.openSync(DAEMON_LOG, 'a');
  const child = spawn(process.execPath, [SCRIPT_PATH, '--daemon'], {
    cwd: SERVER_DIR,
    env: { ...process.env, ...OCR_ENV },
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  });
  child.on('error', (e) => log(`ERROR: 拉起守护进程失败: ${e.message}`));
  child.unref();
  fs.closeSync(fd);
  fs.writeFileSync(DAEMON_PID_FILE, String(child.pid));
  log(`DAEMON: 守护进程已启动 pid=${child.pid}（无窗口常驻，每 ${LOOP_INTERVAL_MS / 1000}s 自查）`);
  return child;
}

async function daemonLoop() {
  const scriptMtime = fs.statSync(SCRIPT_PATH).mtimeMs;
  // 防重入：若 PID 文件指向另一个活着的守护进程，本进程退出
  try {
    const other = Number(fs.readFileSync(DAEMON_PID_FILE, 'utf8').trim());
    if (Number.isInteger(other) && other > 0 && other !== process.pid) {
      try {
        process.kill(other, 0);
        const out = ps(`(Get-CimInstance Win32_Process -Filter "ProcessId=${other}" -ErrorAction SilentlyContinue).CommandLine`);
        if (String(out).includes('backend-watchdog')) {
          log(`DAEMON: 已存在守护进程 pid=${other}，本进程退出`);
          process.exit(0);
        }
      } catch { /* 对方已死，继续 */ }
    }
  } catch { /* 没有 PID 文件，正常 */ }
  fs.writeFileSync(DAEMON_PID_FILE, String(process.pid));
  log(`DAEMON: 守护进程运行中 pid=${process.pid}，每 ${LOOP_INTERVAL_MS / 1000}s 自查；脚本更新后自动退出等待重建`);

  for (;;) {
    try {
      await runOnce();
    } catch (e) {
      log(`ERROR: 自查轮次异常: ${(e && e.stack) || e}`);
    }
    // 脚本被改过 → 退出，让计划任务（登录时/每 2 小时兜底）用新代码重建
    try {
      if (fs.statSync(SCRIPT_PATH).mtimeMs !== scriptMtime) {
        log('DAEMON: 检测到脚本已更新，退出等待重建');
        process.exit(0);
      }
    } catch { /* 脚本文件异常时继续跑，别自杀 */ }
    await new Promise((r) => setTimeout(r, LOOP_INTERVAL_MS));
  }
}

// ============================ 入口 ============================

async function main() {
  if (IS_DAEMON) {
    await daemonLoop();
    return;
  }
  // 启动器模式（计划任务调用）
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  try {
    fs.mkdirSync(OCR_ENV.TEMP, { recursive: true });
  } catch { /* ignore */ }
  if (fs.existsSync(DISABLE_FLAG)) return; // 停用期间不拉起守护进程
  if (isDaemonAlive()) return; // 静默
  spawnDaemon();
}

main().catch((e) => {
  log(`ERROR: 看门狗自身异常: ${(e && e.stack) || e}`);
  process.exitCode = 1;
});
