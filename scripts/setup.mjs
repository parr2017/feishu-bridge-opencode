#!/usr/bin/env node
/**
 * feishu-bridge-opencode 引导配置——目标：**跑完这一条命令，飞书和 opencode 就完全是通的**。
 *
 *   npm run setup
 *
 * 全流程六个阶段：
 *   1. 环境预检（opencode / 依赖 / 旧配置）
 *   2. 飞书凭据（附后台操作清单，当场校验）
 *   3. 写配置 + 装全局符号链接 + 补依赖
 *   4. 重启服务并预热，确认「飞书长连接已建立」
 *   5. 绑定你：等你在群里发一句话，自动抓 open_id 进白名单、记下群 id，
 *      再给那个群发一条确认消息（双向通道当场验证）
 *   6. 收尾总结
 *
 * 非交互（脚本/CI）：
 *   node scripts/setup.mjs --app-id cli_xxx --app-secret xxx --yes
 *   （加 --skip-wait 跳过第 5 阶段的等待）
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OPENCODE_DIR = join(homedir(), '.config', 'opencode');
const CONFIG_PATH = join(OPENCODE_DIR, 'feishu-bridge-opencode.json');
/** 稳定安装位置：把 dist/ 拷到这里，与 opencode 配置同目录，生命周期一致 */
const STABLE_DIR = join(OPENCODE_DIR, 'feishu-bridge-opencode');
/** opencode 的插件入口（这个 .js 只做转发，指到上面的稳定拷贝） */
const PLUGIN_ENTRY_FILE = join(OPENCODE_DIR, 'plugin', 'feishu.js');
const SETUP_LOG = join(OPENCODE_DIR, 'setup-run.log');
const API_BASE_DEFAULT = 'https://open.feishu.cn';

/**
 * 插件入口按运行环境自动选择：
 *   - 源码检出（git clone）：`.opencode/plugin/feishu.ts`（相对导入指向 src/，改源码即时生效）
 *   - npx / npm 装出来的包：包根的 `index.js`（此时没有 .opencode 目录）
 *
 * ⚠️ 两种环境的差别要在提示里说清：npx 的包在**临时缓存**里，缓存清掉后符号链接会失效；
 *    要稳定的全局安装，应该 `npm install -g`（或 git clone 后 npm install）。
 */
const ENTRY_CANDIDATES = [join(PROJECT_ROOT, '.opencode', 'plugin', 'feishu.ts'), join(PROJECT_ROOT, 'index.js')];
const PLUGIN_ENTRY = ENTRY_CANDIDATES.find((p) => existsSync(p)) ?? ENTRY_CANDIDATES[0];
const IS_SOURCE_CHECKOUT = PLUGIN_ENTRY.endsWith('feishu.ts');
// npx 把包缓存在 ~/.npm/_npx 下；缓存清掉后指向它的符号链接就断了
const IS_EPHEMERAL_ROOT = /[\\/]_npx[\\/]|[\\/]_cacache[\\/]/.test(PROJECT_ROOT);

// ---------------------------------------------------------------- 终端

if (process.platform === 'win32') {
  try {
    execFileSync('cmd', ['/c', 'chcp', '65001'], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
}

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : undefined;
}
const NON_INTERACTIVE = argv.includes('--yes') || argv.includes('-y');

function say(...lines) {
  for (const l of lines) process.stdout.write(`${l}\n`);
}
function hr() {
  say(C.dim('  ─────────────────────────────────────────────────────'));
}
function stage(n, title) {
  say('');
  say(C.cyan(`  ◆ 第 ${n} 步 / 共 6 步  ${title}`));
  hr();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pipedLines = null;
let pipedIdx = 0;
if (!process.stdin.isTTY) {
  try {
    pipedLines = readFileSync(0, 'utf-8').split(/\r?\n/);
  } catch {
    pipedLines = [];
  }
}

/** 读一行。mask=true 时用 * 回显。 */
async function ask(label, { mask = false, def = '' } = {}) {
  const suffix = def ? C.dim(` [${def}]`) : '';
  process.stdout.write(`${label}${suffix} `);

  if (pipedLines) {
    const line = (pipedLines[pipedIdx++] ?? '').trim();
    process.stdout.write(`${mask && line ? '****' : line}\n`);
    return line || def;
  }

  return await readRaw((ch) => process.stdout.write(mask ? '*' : ch));
}

function readRaw(echo) {
  return new Promise((resolvePromise) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const finish = (value) => {
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolvePromise(value);
    };
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish(buf.trim());
      if (ch === '\u0003') {
        process.stdout.write('\n');
        process.exit(130);
      }
      if (ch === '\u007f' || ch === '\b') {
        if (buf) {
          buf = buf.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }
      if (ch >= ' ') {
        buf += ch;
        echo(ch);
      }
    };
    stdin.on('data', onData);
  });
}

// ---------------------------------------------------------------- 飞书 API

async function getToken(appId, appSecret, apiBase) {
  const res = await fetch(`${apiBase}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(15_000),
  }).catch((e) => {
    throw new Error(`连不上飞书开放平台：${e.message}\n  检查网络 / 代理；Lark 国际版 API Base 是 https://open.larksuite.com`);
  });
  const body = await res.json().catch(() => ({}));
  if (body.code !== 0 || !body.tenant_access_token) {
    throw new Error(`校验失败 code=${body.code} msg=${body.msg}\n  常见原因：App ID / App Secret 抄错、应用被停用`);
  }
  return { token: body.tenant_access_token, expire: body.expire };
}

async function sendText(token, apiBase, chatId, text) {
  const res = await fetch(`${apiBase}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  if (body.code !== 0) throw new Error(`发消息失败 code=${body.code} msg=${body.msg}`);
  return body.data?.message_id;
}

async function botInfo(token, apiBase) {
  const res = await fetch(`${apiBase}/open-apis/bot/v3/info`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  return (await res.json().catch(() => ({})))?.bot ?? {};
}

// ---------------------------------------------------------------- 工具

function restartService() {
  try {
    const r = spawnSync('opencode', ['service', 'restart'], { shell: process.platform === 'win32', timeout: 120_000, encoding: 'utf-8' });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    const url = out.match(/http:\/\/[^\s]+/)?.[0];
    return { ok: r.status === 0 || Boolean(url), url };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 160) };
  }
}

/** 跑一轮让 opencode 实例化 location、加载插件（模型调用失败也没关系，插件在此之前已加载）。 */
function warmup(cwd) {
  try {
    spawnSync('opencode', ['run', 'warmup'], { cwd, shell: process.platform === 'win32', timeout: 180_000, encoding: 'utf-8' });
    return true;
  } catch {
    return true; // 模型没配/调用失败都无所谓，只要 location 实例化过
  }
}

/** 轮询日志文件，等出现匹配的行。返回行内第一个 JSON 对象，或 null。 */
async function waitForLogLine(file, pattern, timeoutMs, hint) {
  const start = Date.now();
  say(C.dim(`  ${hint}（最长等 ${Math.round(timeoutMs / 1000)} 秒）`));
  process.stdout.write('  ');
  while (Date.now() - start < timeoutMs) {
    try {
      const content = readFileSync(file, 'utf-8');
      for (const line of content.split('\n')) {
        if (pattern.test(line)) {
          process.stdout.write('\n');
          const m = line.match(/\{.*\}/);
          try {
            return JSON.parse(m?.[0] ?? '{}');
          } catch {
            return { _raw: line };
          }
        }
      }
    } catch {
      /* 文件还没出现 */
    }
    process.stdout.write('.');
    await sleep(1500);
  }
  process.stdout.write('\n');
  return null;
}

// ================================================================= 主流程

say('');
say(C.bold('  feishu-bridge-opencode 引导配置'));
hr();
say('  目标：跑完这一条命令，飞书 ↔ opencode 就是完全通的。');
say('');

// ---------------------------------------------------------------- 阶段 1

stage(1, '环境预检');
{
  let problems = 0;

  const oc = spawnSync('opencode', ['--version'], { shell: process.platform === 'win32', timeout: 30_000, encoding: 'utf-8' });
  const ocVer = `${oc.stdout ?? ''}`.trim() || `${oc.stderr ?? ''}`.trim();
  if (ocVer) {
    say(`  ✓ opencode 已安装（${ocVer.split('\n')[0].slice(0, 40)}）`);
  } else {
    say(C.red('  ✗ 没找到 opencode 命令'));
    say(C.dim('    先装 opencode：https://opencode.ai'));
    problems++;
  }

  if (existsSync(join(PROJECT_ROOT, 'node_modules', '@larksuiteoapi', 'node-sdk'))) {
    say('  ✓ 插件依赖已安装（@larksuiteoapi/node-sdk）');
  } else if (existsSync(PLUGIN_ENTRY)) {
    say(C.yellow('  ! 插件依赖没装——正在补…'));
    try {
      execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: PROJECT_ROOT, stdio: 'pipe', shell: process.platform === 'win32' });
      say(C.green('  ✓ 依赖装好了'));
    } catch (e) {
      say(C.red(`  ✗ 依赖安装失败：${String(e.message).slice(0, 120)}`));
      say(C.dim(`    手动执行：cd "${PROJECT_ROOT}" && npm install`));
      problems++;
    }
  }

  if (existsSync(CONFIG_PATH)) {
    say(C.dim(`  · 已存在旧配置 ${CONFIG_PATH}（完成时会覆盖）`));
  }
  if (problems) {
    say('');
    say(C.red('  先解决上面的问题再继续。'));
    process.exit(1);
  }
}

// ---------------------------------------------------------------- 阶段 2

const apiBase = (flag('api-base') || API_BASE_DEFAULT).replace(/\/+$/, '');
let token = '';
let appId = '';
let appSecret = '';

stage(2, '飞书凭据');
{
  say('  先在飞书开放平台把应用建好（照着点，5 分钟）：');
  say('');
  say(`    1. 打开 ${C.bold('https://open.feishu.cn/app')} → 创建「企业自建应用」`);
  say('    2. 「凭证与基础信息」→ 复制 App ID（cli_ 开头）和 App Secret');
  say('    3. 「权限管理」→ 开通这三个权限：');
  say('         im:message                获取与发送单聊、群组消息');
  say('         im:message:send_as_bot    以应用的身份发消息');
  say('         im:message.group_at_msg   接收群聊中 @机器人 的消息');
  say('    4. 「事件与回调」→ 订阅方式选「使用长连接接收事件」（免公网的关键）');
  say('    5. 添加事件：接收消息 im.message.receive_v1');
  say('       「卡片交互回调」里加上：卡片回传交互 card.action.trigger');
  say('    6. 「版本管理与发布」→ 创建版本 → 可用范围选自己 → 发布');
  say('    7. 把机器人拉进一个群（群比单聊好，@ 更明确）');
  say('');
  say(C.dim('  没建完也没关系——可以继续往下走，回头补完再跑一次本向导。'));
  say('');

  appId = flag('app-id') || (await ask(C.bold('  App ID')));
  if (!appId) {
    say(C.red('  ✗ App ID 不能为空'));
    process.exit(1);
  }
  if (!/^cli_/.test(appId)) say(C.yellow('  ! App ID 一般以 cli_ 开头，确认一下没抄错'));

  appSecret = flag('app-secret') || (await ask(C.bold('  App Secret'), { mask: true }));
  if (!appSecret) {
    say(C.red('  ✗ App Secret 不能为空'));
    process.exit(1);
  }

  say(C.dim(`  → 正在校验（${apiBase}）…`));
  try {
    const { expire } = await getToken(appId, appSecret, apiBase);
    say(C.green(`  ✓ 凭据有效（token 有效期 ${expire}s）`));
    const bot = await botInfo(token, apiBase);
    if (bot?.activate_status !== undefined) {
      say(`  ✓ 机器人「${bot.app_name ?? appId}」${bot.activate_status === 2 ? '已发布激活' : C.yellow('尚未发布——事件不会推送，记得去「版本管理与发布」创建版本')}`);
    }
  } catch (e) {
    say(C.red(`  ✗ ${e.message}`));
    process.exit(1);
  }
}

// ---------------------------------------------------------------- 阶段 3

const installedAsPackage = PROJECT_ROOT.split(/[\\/]/).includes('node_modules');

stage(3, '写配置 + 装全局');
{
  // 保留旧配置里已有的绑定关系——重跑向导（比如回头补白名单）不该把它们清掉
  let keep = {}; // { approvers?: string[]; notifyChatId?: string }——重跑向导时保留已有绑定
  try {
    const prev = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    if (Array.isArray(prev.approvers) && prev.approvers.length) keep.approvers = prev.approvers;
    if (typeof prev.notifyChatId === 'string' && prev.notifyChatId) keep.notifyChatId = prev.notifyChatId;
  } catch {
    /* 没有旧配置 */
  }

  // 检测 open_id/chat_id 需要插件把日志写到文件，配置里先临时指向它
  const config = {
    appId,
    appSecret,
    approvers: keep.approvers ?? [],
    apiBase,
    wsEnabled: true,
    logLevel: 'debug',
    logFile: SETUP_LOG,
    ...(keep.notifyChatId ? { notifyChatId: keep.notifyChatId } : {}),
  };
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  try {
    rmSync(SETUP_LOG, { force: true });
  } catch {
    /* ignore */
  }
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* Windows 基本是 no-op */
  }
  say(`${C.green('  ✓')} 配置已写入：${C.bold(CONFIG_PATH)}`);
  say(C.dim('    含 App Secret，别提交到 git。调试日志先开着，结束时会关掉。'));

  // —— 安装插件本体到 opencode ——
  // 为什么不用 `opencode plugin add <git url>`：opencode 2.0.16 的安装器在插件
  // 带运行时依赖时会调它内嵌的 npm（参数不兼容，报 ShowHelp→git dep preparation failed），
  // 带依赖的 git 插件一律装不上（实测，superpowers 无依赖所以没暴露）。
  // 所以这里直接把 dist/ 拷进 opencode 配置目录——拷贝是稳定的，npx 缓存过期也不影响。
  const distSrc = join(PROJECT_ROOT, 'dist');
  if (!existsSync(join(distSrc, 'index.js'))) {
    say(C.red('  ✗ 找不到编译产物 dist/index.js——请先在源码里 npm run build 再发布'));
    process.exit(1);
  }
  rmSync(STABLE_DIR, { recursive: true, force: true });
  mkdirSync(join(STABLE_DIR, 'dist'), { recursive: true });
  mkdirSync(dirname(PLUGIN_ENTRY_FILE), { recursive: true });
  cpSync(distSrc, join(STABLE_DIR, 'dist'), { recursive: true });
  writeFileSync(
    PLUGIN_ENTRY_FILE,
    ['// feishu-bridge-opencode entry generated by setup; impl in ../feishu-bridge-opencode/dist/',
     "export { default } from '../feishu-bridge-opencode/dist/index.js';"].join(String.fromCharCode(10)) +
      String.fromCharCode(10),
    { encoding: "utf-8" },
  );
  say(`${C.green('  ✓')} 插件已安装到 opencode：${C.bold(PLUGIN_ENTRY_FILE)}`);
  say(C.dim(`    （实现拷贝在 ${STABLE_DIR}；升级 = 重跑本向导或 npm run build 后覆盖）`));

  // 依赖：dist 运行时需要 @larksuiteoapi/node-sdk，从 opencode 配置目录向上解析
  if (!existsSync(join(OPENCODE_DIR, 'node_modules', '@larksuiteoapi', 'node-sdk'))) {
    say(C.dim('  → 安装运行时依赖到 opencode 配置目录…'));
    try {
      execFileSync('npm', ['install', '@larksuiteoapi/node-sdk', '--no-audit', '--no-fund'], {
        cwd: OPENCODE_DIR, stdio: 'pipe', shell: process.platform === 'win32',
      });
      say(C.green('  ✓ 依赖已装入 ' + join(OPENCODE_DIR, 'node_modules')));
    } catch (e) {
      say(C.yellow(`  ! 依赖安装失败：${String(e.message).slice(0, 120)}`));
      say(C.dim(`    手动执行：cd "${OPENCODE_DIR}" && npm install @larksuiteoapi/node-sdk`));
    }
  }
}

// ---------------------------------------------------------------- 阶段 4

stage(4, '连接 opencode');
{
  say(C.dim('  → 重启 opencode 后台服务，并预热一次让插件加载…'));
  const r = restartService();
  if (!r.ok) {
    say(C.yellow('  ! 服务重启失败——你可以稍后手动执行 opencode service restart'));
  } else {
    say(`  ✓ 服务已重启（${r.url ?? ''}）`);
  }

  warmup(process.cwd());

  // 插件加载和写日志是异步的，这里轮询等一会儿（只查一次会因时序误报）
  const hit = await waitForLogLine(SETUP_LOG, /飞书长连接已建立/, 30_000, '确认飞书长连接…');
  if (hit || readFileSync(SETUP_LOG, 'utf-8').includes('飞书长连接已建立')) {
    say(C.green('  ✓ 飞书长连接已建立——插件已连上真实飞书'));
  } else if (readFileSync(SETUP_LOG, 'utf-8').includes('未启用')) {
    say(C.red('  ✗ 插件没起来（配置没被读到）——把上面输出发给维护者'));
  } else {
    say(C.yellow('  ? 暂时没看到长连接建立的日志——可能是预热没触发插件加载。'));
    say(C.dim('    手动确认：启动 opencode 后发 /status；或看日志：'));
    say(C.dim(`     ${SETUP_LOG}`));
  }
}

// ---------------------------------------------------------------- 阶段 5

let boundOpenId = '';
let boundChatId = '';

stage(5, '绑定你（自动抓 open_id）');
{
  say('  现在做一件事：');
  say('');
  say(C.bold('    在飞书群里 @机器人 发一句话（内容随意，比如「hi」）'));
  say('');
  say('  我会从日志里抓到你的 open_id 和群 id，自动写进白名单和推送落点——');
  say('  你不用手抄任何 ID。');
  say('');

  const skip = NON_INTERACTIVE || flag('skip-wait');
  if (skip) {
    say(C.dim('  · 非交互模式，跳过等待。open_id 之后再补：发 /status 看到自己的 ID，'));
    say(C.dim('    加进配置的 approvers 数组后 opencode service restart。'));
  } else {
    const hit = await waitForLogLine(SETUP_LOG, /收到飞书消息/, 180_000, '等你在飞书群里发消息…');
    if (!hit) {
      say(C.yellow('  ✗ 等不到消息。最可能的三个原因：'));
      say('    1. 「事件与回调」没切到「使用长连接接收事件」');
      say('    2. 没订阅事件 im.message.receive_v1');
      say('    3. 改完权限/订阅后没有重新创建版本并发布');
      say(C.dim(`    日志在 ${SETUP_LOG}，修好后再跑一次 npm run setup 即可（已完成的步骤会自动跳过）。`));
    } else {
      boundOpenId = String(hit.openId ?? hit.open_id ?? '');
      boundChatId = String(hit.chatId ?? hit.chat_id ?? '');
      say(C.green(`  ✓ 收到你的消息（来自 ${boundChatId}）`));

      if (boundOpenId) {
        const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
        cfg.approvers = [boundOpenId];
        cfg.notifyChatId = boundChatId;
        writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
        say(C.green(`  ✓ 你的 open_id 已加入白名单，群已设为推送落点`));
      }

      say(C.dim('  → 重启服务让白名单生效…'));
      const r2 = restartService();
      if (r2.ok) say('  ✓ 服务已重启');

      try {
        const { token: t2 } = await getToken(appId, appSecret, apiBase);
        await sendText(t2, apiBase, boundChatId, '✅ feishu-bridge-opencode 配置完成，双向通道已打通。现在发 /status 或直接布置任务都可以。');
        say(C.green('  ✓ 已给你的群发了一条确认消息（能收到 = 出站也通了）'));
      } catch (e) {
        say(C.yellow(`  ! 确认消息没发出去：${String(e.message).slice(0, 120)}`));
        say(C.dim('    出站权限（im:message:send_as_bot）没开？开了的话重新发一条即可。'));
      }
    }
  }
}

// ---------------------------------------------------------------- 阶段 6

stage(6, '收尾');
{
  // 结束后把 setup 专用的 debug 日志关掉，恢复干净的配置
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    cfg.logLevel = 'info';
    delete cfg.logFile;
    writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    say(C.dim('  · 配置已恢复 info 日志（去掉向导期间的调试文件）'));
  } catch {
    /* ignore */
  }

  say('');
  say(C.bold('  全部完成。现在可以：'));
  say('');
  say('    · 在群里 @机器人 直接布置任务，跑完推完成卡');
  say('    · 需要授权时会弹审批卡，点按钮即可');
  say('    · 指令：/status /list /new /model /agent /inbox /panel /help');
  say('');
  say(C.dim('  排查：'));
  say(C.dim(`    向导期间日志：${SETUP_LOG}`));
  say(C.dim('    opencode 插件日志：~/.local/share/opencode/log/opencode.log'));
  say(C.dim('    想长期开 debug：配置里加 "logLevel":"debug" 和 "logFile":"路径"'));
  say('');
}
