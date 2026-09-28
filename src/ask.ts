/**
 * 提问桥（对应 co-team 的 `answerQuestion`）。
 *
 * **为什么这么做**：opencode v2 的 `ctx.session` 没有 `form` 命名空间（实测 runtime keys
 * 里没有），插件拿不到表单回复的入口；但 `ctx.tool.transform` 可以**覆盖 `question` 工具的
 * execute**（实测生效）。于是链路是：
 *
 *   agent 调 question 工具 → 我们的 execute 推飞书卡 → 用户点选/填答
 *   → 返回 { output: { answers: string[][] } } → agent 继续执行
 *
 * 返回信封是实测出来的：`{ output: { answers: [['SQLite']] } }` 才是 `session.tool.success`，
 * 直接返回 `{ answers: [...] }` 会被判「Tool did not return its declared output」。
 * schema 来自工具的 Effect Schema：`answers: Array<Array<string>>`（每题一个字符串数组）。
 *
 * **非破坏性**：拿不到落点（会话没绑飞书 / 没配白名单）时，回落到原 execute，
 * TUI 里的表单照常弹。
 */
import { log } from './log.ts';
import type { FeishuConfig } from './config.ts';
import type { State } from './state.ts';
import { sendCard, type ReceiveIdType } from './feishu/api.ts';
import { btn, buildResultCard, card2, cardResponse, form, inputField, md, note, submitBtn, type CardElement } from './feishu/cards.ts';
import type { CardActionInput } from './feishu/gateway.ts';
import {
  buildFormAnswer,
  emptyFieldValue,
  fieldValueOf,
  formFieldsOf,
  initialFormValues,
  isFieldAnswered,
  missingRequiredKeys,
  visibleFields,
  type FormFieldView,
  type FormValues,
} from './feishu/formView.ts';

const ASK_TIMEOUT_MS = 30 * 60 * 1000;

interface PendingAsk {
  key: string;
  sessionId: string;
  chatId: string;
  title: string;
  fields: FormFieldView[];
  values: FormValues;
  /** 卡片消息 id（原地刷新与收件箱重推用） */
  messageId?: string;
  resolve: (answers: string[][] | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 原始 question 工具签名（回落到 TUI 表单用） */
type ToolExecute = (args: any, ctx: any) => Promise<unknown>;

export interface AskBridgeDeps {
  cfg: FeishuConfig;
  state: State;
  /** 按会话找落点（飞书 chat）；找不到返回 null → 回落到原工具 */
  chatForSession(sessionId: string): Promise<string | null>;
  /** 记住最近活跃会话（execute 拿不到 sessionID 时的兜底） */
  lastActiveSession(): string | null;
}

export class AskBridge {
  private readonly pending = new Map<string, PendingAsk>();
  private seq = 0;
  private original: ToolExecute | null = null;
  private execCtxLogged = false;
  private installed = false;

  constructor(private deps: AskBridgeDeps) {}

  /**
   * 挂载：覆盖 question 工具的 execute。
   *
   * ⚠️ `tool.transform` 会在**工具注册表每次变化时重复执行**（实测接入 MCP 工具后重跑）。
   * 所以必须防重复包装，否则 `original` 会指向我们自己的包装函数，回落时无限递归：
   *  - 同一个 tool 对象：靠标记跳过；
   *  - 注册表重建后的新对象：重新包装，但 `original` 只记第一次（那才是真正的内置实现）。
   */
  async install(api: { toolTransform(cb: (tools: any) => void): Promise<unknown> }): Promise<void> {
    try {
      await api.toolTransform((tools: any) => {
        try {
          tools.update('question', (tool: any) => {
            if (typeof tool?.execute !== 'function') {
              log.warn('question 工具没有 execute，跳过提问桥挂载');
              return;
            }
            if (tool.__feishuWrapped === true) return; // 同一对象，已经包过
            this.original ??= tool.execute.bind(tool); // 只记第一次的原实现
            tool.__feishuWrapped = true;
            tool.execute = async (args: any, execCtx: any) => this.onQuestion(args, execCtx);
            if (!this.installed) {
              this.installed = true;
              log.info('已接管 question 工具（飞书作答，取不到落点时回落 TUI）');
            }
          });
        } catch (e) {
          log.warn('覆盖 question 工具失败', { error: String(e).slice(0, 200) });
        }
      });
    } catch (e) {
      log.warn('tool.transform 不可用——提问将只在 TUI 弹出', { error: String(e).slice(0, 200) });
    }
  }

  async dispose(): Promise<void> {
    for (const a of this.pending.values()) {
      clearTimeout(a.timer);
      a.resolve(null);
    }
    this.pending.clear();
  }

  // ------------------------------------------------------------ 工具入口

  private async onQuestion(args: any, execCtx: any): Promise<unknown> {
    if (!this.execCtxLogged) {
      this.execCtxLogged = true;
      // 观测点：execute 的第二个参数里到底有没有 sessionID（决定路由是否精确）
      log.info('question execute 上下文（首次）', {
        keys: execCtx && typeof execCtx === 'object' ? Object.keys(execCtx) : typeof execCtx,
        sessionID: execCtx?.sessionID ?? execCtx?.session?.id ?? null,
      });
    }

    const questions: any[] = Array.isArray(args?.questions) ? args.questions : [];
    if (!questions.length) return this.original ? this.original(args, execCtx) : { output: { answers: [] } };

    const sessionId = String(execCtx?.sessionID ?? execCtx?.session?.id ?? this.deps.lastActiveSession() ?? '');
    const chatId = sessionId ? await this.deps.chatForSession(sessionId).catch(() => null) : null;
    if (!chatId || !this.deps.cfg.approvers.length) {
      // 没落点 / 没白名单 → 交回原实现，TUI 表单照常
      return this.original ? this.original(args, execCtx) : { output: { answers: questions.map(() => []) } };
    }

    const fields = questions.map((q, i) => {
      const options = (Array.isArray(q?.options) ? q.options : []).map((o: any) => ({
        value: String(o?.value ?? o?.label ?? ''),
        label: String(o?.label ?? o?.value ?? ''),
        ...(o?.description ? { description: String(o.description) } : {}),
      }));
      return {
        key: `q${i}`,
        type: options.length ? ('select' as const) : ('input' as const),
        question: String(q?.question ?? q?.header ?? `问题 ${i + 1}`),
        ...(q?.header ? { header: String(q.header) } : {}),
        ...(q?.multiSelect || q?.multiple ? { multiple: true } : {}),
        // opencode 的 question 工具会自动追加「自己输入」选项，这里照抄它的语义
        custom: true,
        ...(options.length ? { options } : {}),
      } satisfies FormFieldView;
    });

    const answers = await this.ask(sessionId, chatId, fields);
    return { output: { answers: answers ?? fields.map(() => []) } };
  }

  /** 推卡并等待作答；返回每题一个字符串数组。null = 放弃（超时/发送失败）。 */
  private ask(sessionId: string, chatId: string, fields: FormFieldView[]): Promise<string[][] | null> {
    const key = `ask_${Date.now().toString(36)}_${++this.seq}`;
    return new Promise<string[][] | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        log.warn('提问卡等待超时，交回 opencode', { key });
        resolve(null);
      }, ASK_TIMEOUT_MS);

      const ask: PendingAsk = {
        key,
        sessionId,
        chatId,
        title: 'opencode 提问',
        fields,
        values: initialFormValues(fields),
        resolve,
        timer,
      };
      this.pending.set(key, ask);
      void this.render(ask, chatId, null).then((messageId) => {
        if (!messageId) {
          // 卡片送不出去 = 没人能答，立刻交回，别干等
          clearTimeout(timer);
          this.pending.delete(key);
          resolve(null);
        }
      });
    });
  }

  /** 收件箱用：当前待作答的提问。 */
  pendingList(): { key: string; title: string; sessionId: string }[] {
    return [...this.pending.values()].map((a) => ({ key: a.key, title: a.title, sessionId: a.sessionId }));
  }

  /** 收件箱「处理」：把某条提问的卡重推一份到指定会话。 */
  async repush(key: string, chatId: string): Promise<boolean> {
    const ask = this.pending.get(key);
    if (!ask) return false;
    return (await this.render(ask, chatId, null)) !== null;
  }

  // ------------------------------------------------------------ 渲染

  private async render(ask: PendingAsk, chatId: string, replaceMessageId: string | null): Promise<string | null> {
    const card = this.buildCard(ask);
    if (replaceMessageId) {
      const { updateCard } = await import('./feishu/api.ts');
      const ok = await updateCard(this.deps.cfg, replaceMessageId, card);
      if (ok) return replaceMessageId;
    }
    const messageId = await sendCard(this.deps.cfg, chatId, card);
    if (messageId) {
      ask.messageId = messageId;
      await this.deps.state.putAsk(messageId, { ask_key: ask.key });
    }
    return messageId;
  }

  private buildCard(ask: PendingAsk): Record<string, unknown> {
    const elements: CardElement[] = [];
    const missing = missingRequiredKeys(ask.fields, ask.values);
    const inputEls: CardElement[] = [];

    for (const f of visibleFields(ask.fields, ask.values)) {
      const v = fieldValueOf(ask.values, f.key);
      const answered = isFieldAnswered(f, v);
      elements.push(md(`${answered ? '✅' : '❔'} **${f.header ? `【${f.header}】` : ''}${f.question}**`));
      if (f.description) elements.push(md(f.description));

      const opts = (f.options ?? []).slice(0, 8);
      if (f.type === 'boolean') {
        for (const [label, val] of [
          ['是', true],
          ['否', false],
        ] as const) {
          elements.push(
            btn(`${v.bool === val ? '✅ ' : ''}${label}`, v.bool === val ? 'primary' : 'default', {
              act: 'ask_pick',
              ask_key: ask.key,
              field_key: f.key,
              value: val,
            }),
          );
        }
      } else if (opts.length) {
        for (const o of opts) {
          const selected = v.selected.includes(o.value);
          elements.push(
            btn(`${selected ? '✅ ' : ''}${o.label.slice(0, 24)}`, selected ? 'primary' : 'default', {
              act: 'ask_pick',
              ask_key: ask.key,
              field_key: f.key,
              value: o.value,
              label: o.label,
            }),
          );
        }
        // 自由输入：opencode 的 question 工具本来就会追加「自己输入」项
        inputEls.push(inputField(`in_${f.key}`, `其他（自己输入）`));
      } else {
        inputEls.push(inputField(`in_${f.key}`, f.placeholder || `回答：${f.question.slice(0, 24)}`));
      }
    }

    if (inputEls.length) {
      elements.push(form(`ask_${ask.key}`, inputEls.concat([submitBtn('✅ 提交回答', 'go')])));
    } else {
      elements.push(
        btn('✅ 提交回答', 'primary', { act: 'ask_submit', ask_key: ask.key }),
      );
    }
    if (missing.length) elements.push(note(`⚠ 必填未作答：${missing.join('、').slice(0, 120)}`));
    elements.push(note(`opencode-feishu · 提问 · 会话 ${ask.sessionId.slice(0, 12)} · ${new Date().toLocaleString()}`));

    return card2('orange', `❓ ${ask.title}`, elements);
  }

  // ------------------------------------------------------------ 回调

  async handleAction(input: CardActionInput): Promise<Record<string, unknown> | void> {
    const params = input.value && Object.keys(input.value).length ? input.value : input.messageId ? await this.deps.state.getAsk(input.messageId) : null;
    if (!params) return;
    const act = String(params.act ?? '');
    const key = String(params.ask_key ?? '');
    const ask = this.pending.get(key);
    if (!ask) return cardResponse(buildResultCard('提问已过期', ['这次提问已经结束，agent 会按默认值继续。']));

    const who = input.operatorOpenId || 'unknown';
    if (!this.deps.cfg.approvers.length || !this.deps.cfg.approvers.includes(who)) {
      return cardResponse(buildResultCard('⛔ 无权操作', [`操作人 \`${who}\` 不在白名单内。`]));
    }

    try {
      if (act === 'ask_pick') {
        const fieldKey = String(params.field_key ?? '');
        const field = ask.fields.find((f) => f.key === fieldKey);
        if (!field) return;
        const slot = (ask.values[fieldKey] ??= emptyFieldValue());
        if (field.type === 'boolean') {
          slot.bool = params.value === true || params.value === 'true';
        } else if (field.type === 'multiselect' || field.multiple) {
          const val = String(params.value ?? '');
          slot.selected = slot.selected.includes(val) ? slot.selected.filter((x) => x !== val) : [...slot.selected, val];
        } else {
          slot.selected = [String(params.value ?? '')];
        }
        // 全部作答则自动提交（对齐 co-team 的「全答自动提交」）
        if (!missingRequiredKeys(ask.fields, ask.values).length) return this.finish(ask);
        const card = this.buildCard(ask);
        return input.messageId ? cardResponse(card) : undefined;
      }

      if (act === 'ask_submit' || act === 'ask_form') {
        for (const f of ask.fields) {
          const raw = input.formValue?.[`in_${f.key}`];
          const text = String(raw ?? '').trim();
          if (!text) continue;
          const slot = (ask.values[f.key] ??= emptyFieldValue());
          if (f.type === 'number') slot.num = Number(text);
          else if (f.type === 'multiselect' || f.multiple) {
            if (!slot.selected.includes(text)) slot.selected = [...slot.selected, text];
            slot.text = text;
            slot.custom = true;
          } else {
            slot.text = text;
            slot.custom = true;
          }
        }
        const missing = missingRequiredKeys(ask.fields, ask.values);
        if (missing.length) {
          const card = this.buildCard(ask);
          return input.messageId ? cardResponse(card) : undefined;
        }
        return this.finish(ask);
      }
      return;
    } catch (e) {
      log.warn('处理提问卡失败', { act, error: String(e).slice(0, 200) });
      return cardResponse(buildResultCard('⚠ 处理失败', [String((e as Error)?.message ?? e).slice(0, 200)]));
    }
  }

  /** 收口答案 → 转成 question 工具要的 string[][]。 */
  private finish(ask: PendingAsk): Record<string, unknown> {
    clearTimeout(ask.timer);
    this.pending.delete(ask.key);
    const answer = buildFormAnswer(ask.fields, ask.values);
    const rows: string[][] = ask.fields.map((f) => {
      const v = answer[f.key];
      if (Array.isArray(v)) return v.map(String);
      if (v === undefined || v === null || v === '') return [];
      if (typeof v === 'boolean') return [v ? '是' : '否'];
      return [String(v)];
    });
    ask.resolve(rows);
    if (ask.messageId) void this.deps.state.dropAsk(ask.messageId);
    const preview = ask.fields.map((f, i) => `${f.question} → ${(rows[i] ?? []).join(' / ') || '（空）'}`).join('\n');
    return cardResponse(buildResultCard('✅ 已回答', [preview]));
  }
}
