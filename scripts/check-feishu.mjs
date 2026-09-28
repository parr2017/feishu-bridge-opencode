#!/usr/bin/env node
/**
 * 飞书凭据自检。装插件前先跑这个，能把「凭据错」和「插件错」分开。
 *
 *   node scripts/check-feishu.mjs            # 只验 token
 *   node scripts/check-feishu.mjs <chat_id>  # 顺便发一条测试消息
 *
 * 凭据从环境变量读：FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_API_BASE
 */

const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;
const apiBase = (process.env.FEISHU_API_BASE || 'https://open.feishu.cn').replace(/\/+$/, '');
const chatId = process.argv[2];

if (!appId || !appSecret) {
  console.error('✗ 缺少 FEISHU_APP_ID / FEISHU_APP_SECRET');
  process.exit(1);
}

console.log(`→ ${apiBase}  应用 ${appId.slice(0, 10)}…`);

const tokenRes = await fetch(`${apiBase}/open-apis/auth/v3/tenant_access_token/internal`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  signal: AbortSignal.timeout(15_000),
}).catch((e) => {
  console.error(`✗ 连不上开放平台：${e.message}`);
  console.error('  检查网络 / 代理 / FEISHU_API_BASE（Lark 国际版是 https://open.larksuite.com）');
  process.exit(1);
});

const tokenBody = await tokenRes.json();
if (tokenBody.code !== 0 || !tokenBody.tenant_access_token) {
  console.error(`✗ 取 token 失败 code=${tokenBody.code} msg=${tokenBody.msg}`);
  console.error('  常见原因：app_id/app_secret 抄错、应用被停用');
  process.exit(1);
}
console.log(`✓ tenant_access_token 获取成功（有效期 ${tokenBody.expire}s）`);

if (!chatId) {
  console.log('\n没给 chat_id，跳过发消息。要测推送：');
  console.log('  node scripts/check-feishu.mjs oc_xxxxxxxx');
  console.log('\n取 chat_id：把机器人拉进群，群里 @机器人 发一句话，');
  console.log('看插件日志里的 chatId，或到开放平台「事件订阅」的调试面板看原始事件。');
  process.exit(0);
}

const sendRes = await fetch(`${apiBase}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenBody.tenant_access_token}` },
  body: JSON.stringify({
    receive_id: chatId,
    msg_type: 'text',
    content: JSON.stringify({ text: 'opencode-feishu 自检：消息通道正常 ✅' }),
  }),
  signal: AbortSignal.timeout(15_000),
});

const sendBody = await sendRes.json();
if (sendBody.code !== 0) {
  console.error(`✗ 发消息失败 code=${sendBody.code} msg=${sendBody.msg}`);
  console.error('  常见原因：机器人不在该群 / chat_id 不对 / 缺少 im:message 权限');
  process.exit(1);
}
console.log(`✓ 测试消息已发送 message_id=${sendBody.data?.message_id}`);
console.log('\n凭据与消息通道都正常，可以装插件了。');
