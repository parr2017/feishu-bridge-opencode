#!/usr/bin/env node
/**
 * feishu-bridge-opencode 引导配置。
 *
 *   npm run setup
 *
 * 做四件事：
 *   1. 问你要飞书应用凭据（并当场校验）
 *   2. 问审批白名单 / 测试消息落点
 *   3. 把配置写进 ~/.config/opencode/feishu-bridge-opencode.json
 *   4. 装全局符号链接（这样在任何目录启动 opencode 都能用）
 *
 * 也支持非交互（给脚本/CI 用）：
 *   node scripts/setup.mjs --app-id cli_xxx --app-secret xxx --approvers ou_a,ou_b --yes
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ENTRY = join(PROJECT_ROOT, '.opencode', 'plugin', 'feishu.ts');
const OPENCODE_DIR = join(homedir(), '.config', 'opencode');
const CONFIG_PATH = join(OPENCODE_DIR, 'feishu-bridge-opencode.json');
const PLUGIN_LINK = join(OPENCODE_DIR, 'plugin', 'feishu-bridge-opencode.ts');

// ---------------------------------------------------------------- 终端

// Windows cmd 默认 GBK，中文会乱码；切到 UTF-8（失败就算了，不影响功能）
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
};

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : undefined;
}
const NON_INTERACTIVE = argv.includes('--yes') || argv.includes('-y');

// 非 TTY（管道输入）时预读所有行
let pipedLines = null;
if (!process.stdin.isTTY) {
  try {
    pipedLines = readFileSync(0, 'utf-8').split(/\r?\n/);
  } catch {
    pipedLines = [];
  }
}
let pipedIdx = 0;

/** 读一行。mask=true 时用 * 回显。 */
async function ask(label, { mask = false, def = '' } = {}) {
  const suffix = def ? C.dim(` [${def}]`) : '';
  process.stdout.write(`${label}${suffix} `);

  if (pipedLines) {
    const line = (pipedLines[pipedIdx++] ?? '').trim();
    process.stdout.write(`${mask && line ? '****' : line}\n`);
    return line || def;
  }

  if (!mask) {
    // 普通输入也用 raw 模式，避免和 readline 抢 stdin
    return await readRaw((ch) => process.stdout.write(ch));
  }
  return await readRaw(() => process.stdout.write('*'));
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

function say(...lines) {
  for (const l of lines) process.stdout.write(`${l}\n`);
}

// ---------------------------------------------------------------- 飞书校验

async function verifyCredentials(appId, appSecret, apiBase) {
  const res = await fetch(`${apiBase}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(15_000),
  }).catch((e) => {
    throw new Error(`连不上飞书开放平台：${e.message}\n  检查网络 / 代理，或 API Base（Lark 国际版是 https://open.larksuite.com）`);
  });
  const body = await res.json().catch(() => ({}));
  if (body.code !== 0 || !body.tenant_access_token) {
    throw new Error(`校验失败 code=${body.code} msg=${body.msg}\n  常见原因：App ID / App Secret 抄错、应用被停用`);
  }
  return { token: body.tenant_access_token, expire: body.expire };
}

async function sendTestMessage(token, apiBase, chatId) {
  const res = await fetch(`${apiBase}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text: 'opencode-feishu 配置成功 ✅ 之后直接发消息就能驱动 opencode。' }),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  if (body.code !== 0) throw new Error(`发消息失败 code=${body.code} msg=${body.msg}`);
  return body.data?.message_id;
}

// ---------------------------------------------------------------- 主流程

say('');
say(C.bold('  feishu-bridge-opencode 引导配置'));
say(C.dim('  ─────────────────────────────────────────────'));
say('');
say('  这一步会：');
say('    1. 校验你的飞书应用凭据');
say('    2. 把配置写到 ' + C.bold(CONFIG_PATH));
say('    3. 装一个全局符号链接，让插件在任何目录都能用');
say('');
say(C.dim('  还没有飞书应用？先去 https://open.feishu.cn/app 建一个「企业自建应用」，'));
say(C.dim('  在「凭证与基础信息」里拿 App ID / App Secret。'));
say('');

// --- 1. 凭据 ---
let appId = flag('app-id') || (await ask(`${C.bold('App ID')}`, { def: '' }));
if (!appId) {
  say(C.red('  ✗ App ID 不能为空'));
  process.exit(1);
}
if (!/^cli_/.test(appId)) {
  say(C.yellow('  ! App ID 一般以 cli_ 开头，确认一下没抄错'));
}

let appSecret = flag('app-secret') || (await ask(`${C.bold('App Secret')}`, { mask: true }));
if (!appSecret) {
  say(C.red('  ✗ App Secret 不能为空'));
  process.exit(1);
}

const apiBase = (flag('api-base') || 'https://open.feishu.cn').replace(/\/+$/, '');
say(C.dim(`  → 正在校验（${apiBase}）…`));

let token;
let expire;
try {
  ({ token, expire } = await verifyCredentials(appId, appSecret, apiBase));
  say(C.green(`  ✓ 校验通过（token 有效期 ${expire}s）`));
} catch (e) {
  say(C.red(`  ✗ ${e.message}`));
  process.exit(1);
}

// --- 2. 白名单 ---
say('');
say('  审批白名单：能点飞书审批卡 / 权限卡的账号 open_id（逗号分隔）。');
say(C.dim('  留空也能用，但审批卡按钮点不动。open_id 可以先留空，'));
say(C.dim('  之后在群里 @机器人 发一句话，从插件日志里看到 operator 再回来补。'));
const approversRaw = flag('approvers') || (await ask(`${C.bold('审批白名单')}（可留空）`, { def: '' }));
const approvers = String(approversRaw || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// --- 3. 测试消息（可选）---
say('');
say(C.dim('  测试消息落点：填一个群 chat_id（oc_ 开头），当场发一条测试消息确认通道通。'));
say(C.dim('  不知道怎么拿 chat_id？留空跳过——把机器人拉进群，@它说句话，'));
say(C.dim('  从 opencode 日志里能看到 chatId。'));
const chatId = flag('chat-id') || (await ask(`${C.bold('测试 chat_id')}（可留空）`, { def: '' }));

if (chatId) {
  try {
    const mid = await sendTestMessage(token, apiBase, chatId);
    say(C.green(`  ✓ 测试消息已发送（${mid}）`));
  } catch (e) {
    say(C.yellow(`  ! ${e.message}`));
    say(C.dim('    配置照常写入，之后可在飞书里用 /status 验证。'));
  }
}

// --- 4. 写配置 ---
const config = {
  appId,
  appSecret,
  approvers,
  apiBase,
  wsEnabled: true,
  logLevel: 'info',
  ...(chatId ? { notifyChatId: chatId } : {}),
};

mkdirSync(dirname(CONFIG_PATH), { recursive: true });
const existed = existsSync(CONFIG_PATH);
writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
try {
  chmodSync(CONFIG_PATH, 0o600);
} catch {
  /* Windows 上基本是 no-op */
}

say('');
say(`${C.green('  ✓')} 配置已${existed ? '更新' : '写入'}：${C.bold(CONFIG_PATH)}`);
say(C.dim('    这个文件含 App Secret，别提交到 git。'));

// --- 5. 全局符号链接 ---
// 仅源码检出需要。若是以插件包形式安装（opencode 把它装进
// ~/.config/opencode/node_modules/<pkg>），插件路径已由插件管理器登记，再建链接会重复注册。
const INSTALLED_AS_PACKAGE = PROJECT_ROOT.split(/[\\/]/).includes('node_modules');

say('');
if (INSTALLED_AS_PACKAGE) {
  say(C.dim('  检测到是以插件包形式安装的——opencode 已经知道插件在哪，跳过符号链接步骤。'));
} else {
  const wantLink = NON_INTERACTIVE || flag('no-symlink')
    ? !flag('no-symlink')
    : /^y?$/i.test(await ask('  装全局符号链接？这样在任何目录启动 opencode 都能用 (Y/n)', { def: 'y' }));

  if (wantLink) {
    if (!existsSync(PLUGIN_ENTRY)) {
      say(C.yellow(`  ! 找不到插件入口：${PLUGIN_ENTRY}`));
      say(C.dim('    跳过。请确认你在项目根目录跑这个脚本。'));
    } else {
      try {
        mkdirSync(dirname(PLUGIN_LINK), { recursive: true });
        if (existsSync(PLUGIN_LINK)) unlinkSync(PLUGIN_LINK);
        symlinkSync(PLUGIN_ENTRY, PLUGIN_LINK, 'file');
        say(`${C.green('  ✓')} 已链接：${PLUGIN_LINK}`);
        say(C.dim(`    → ${PLUGIN_ENTRY}`));
        say(C.dim('    删掉这个链接即可取消全局安装。'));
      } catch (e) {
        say(C.yellow(`  ! 建符号链接失败：${e.message}`));
        say(C.dim('    Windows 上需要「开发者模式」或以管理员运行。'));
        say(C.dim(`    也可以直接在这个目录下启动 opencode：${PROJECT_ROOT}`));
      }

      // 符号链接加载时，bare import 是从**链接所在目录**往上找 node_modules 的，
      // 不是从真实路径。所以全局配置目录里也得有这个依赖，否则插件加载会报
      // "Cannot find package '@larksuiteoapi/node-sdk'"。（实测踩过）
      if (existsSync(PLUGIN_LINK) && !existsSync(join(OPENCODE_DIR, 'node_modules', '@larksuiteoapi', 'node-sdk'))) {
        say(C.dim('  → 全局配置目录缺少依赖，正在安装（符号链接必须用这里的 node_modules）…'));
        try {
          execFileSync('npm', ['install', '@larksuiteoapi/node-sdk', '--no-audit', '--no-fund'], {
            cwd: OPENCODE_DIR,
            stdio: 'pipe',
            shell: process.platform === 'win32',
          });
          say(`${C.green('  ✓')} 依赖已装入 ${join(OPENCODE_DIR, 'node_modules')}`);
        } catch (e) {
          say(C.yellow(`  ! 自动安装失败：${String(e.message).slice(0, 160)}`));
          say(C.dim(`    手动执行：cd "${OPENCODE_DIR}" && npm install @larksuiteoapi/node-sdk`));
        }
      }
    }
  }
}

// --- 6. 收尾 ---
say('');
say(C.bold('  完成。接下来：'));
say('');
if (INSTALLED_AS_PACKAGE) {
  say(`    1. 重启 opencode 让它读到新配置：${C.bold('opencode service restart')}`);
  say(`    2. 在飞书里对机器人发 ${C.bold('/status')} 验证`);
} else {
  say(`    1. 确认依赖已装：${C.bold('npm install')}（本项目根目录）`);
  say(`    2. 常驻后台：    ${C.bold('opencode service restart')}`);
  say(`       （插件活在 opencode 进程里，不开它飞书就找不到机器人）`);
  say(`    3. 在飞书里对机器人发 ${C.bold('/status')} 验证`);
  say('');
  say(C.dim('  提示：如果插件已经在跑，改完配置存盘即可自动重连，不必重启 opencode。'));
}
say('');
say(C.dim('  排查：opencode 插件日志在 ~/.local/share/opencode/log/opencode.log'));
say(C.dim('        设 FEISHU_LOG_LEVEL=debug 可看插件自己的详细日志。'));
say('');
