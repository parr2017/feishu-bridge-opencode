/**
 * opencode 提问表单的字段视图与纯逻辑。
 *
 * 搬运自 co-team `packages/opencode-sync/src/form.ts`（原文：web/mobile 双端共享契约），
 * 并补上 **v2 `Form.Field` → FormFieldView 的映射**——co-team 那份是从
 * `@opencode/client` 的 question.asked 拿数据，插件侧拿到的是 `form.created` 事件里的
 * `Form.Field`（见 openapi.json 的 Form.StringField / NumberField / IntegerField /
 * BooleanField / MultiselectField / ExternalField），字段名不同，必须转一层。
 *
 * 状态机部分（必填校验 / when 可见性 / 提交值收口）原样保留。
 */
export function emptyFieldValue() {
    return { selected: [], text: '', num: null, bool: false, ack: false, custom: false };
}
export function fieldValueOf(values, key) {
    return values[key] ?? emptyFieldValue();
}
/** 单字段是否已作答（必填校验的判据；boolean 恒为已答——false 是合法值） */
export function isFieldAnswered(field, v) {
    switch (field.type) {
        case 'external':
            return v.ack;
        case 'boolean':
            return true;
        case 'number':
            return v.num !== null;
        case 'input':
            return v.text.trim() !== '';
        case 'multiselect':
            return v.selected.length > 0 || (v.custom === true && v.text.trim() !== '');
        case 'select':
            return v.custom === true ? v.text.trim() !== '' : v.selected.length > 0;
        default:
            return false;
    }
}
/** 字段的提交值（wire 值；也用于 when 求值）。未作答返回 undefined。 */
export function fieldAnswer(field, v) {
    switch (field.type) {
        case 'external':
            return v.ack ? true : undefined;
        case 'boolean':
            return v.bool;
        case 'number':
            return v.num === null ? undefined : v.num;
        case 'input':
            return v.text.trim() !== '' ? v.text : undefined;
        case 'multiselect': {
            const base = v.selected.length ? v.selected : [];
            return v.custom === true && v.text.trim() !== '' ? [...base, v.text.trim()] : base.length ? base : undefined;
        }
        case 'select':
            return v.custom === true
                ? v.text.trim() !== ''
                    ? v.text.trim()
                    : undefined
                : v.selected.length
                    ? v.selected[0]
                    : undefined;
        default:
            return undefined;
    }
}
/** when 子句求值：全部满足才显示 */
function whenSatisfied(field, fields, values) {
    if (!field.when?.length)
        return true;
    return field.when.every((clause) => {
        const refField = fields.find((f) => f.key === clause.key);
        const refVal = refField ? fieldAnswer(refField, fieldValueOf(values, clause.key)) : undefined;
        const eq = Array.isArray(refVal) ? refVal.some((entry) => entry === clause.value) : refVal === clause.value;
        return clause.op === 'neq' ? !eq : eq;
    });
}
/** 当前应显示的字段：排除 hidden、when 不满足的 */
export function visibleFields(fields, values) {
    return fields.filter((f) => !f.hidden && whenSatisfied(f, fields, values));
}
/** 必填未答的字段 key（external 未打开也算） */
export function missingRequiredKeys(fields, values) {
    return visibleFields(fields, values)
        .filter((f) => f.required && !isFieldAnswered(f, fieldValueOf(values, f.key)))
        .map((f) => f.key);
}
export function initialFormValues(fields) {
    const out = {};
    for (const f of visibleFields(fields, {}))
        out[f.key] = emptyFieldValue();
    return out;
}
/** 提交答案：按 key 收口，类型与 opencode form reply 对齐 */
export function buildFormAnswer(fields, values) {
    const out = {};
    for (const f of visibleFields(fields, values)) {
        const v = fieldAnswer(f, fieldValueOf(values, f.key));
        if (v === undefined) {
            if (f.type === 'multiselect')
                out[f.key] = [];
            else if (f.type === 'boolean')
                out[f.key] = false;
            else if (f.type === 'external')
                out[f.key] = false;
            else
                out[f.key] = '';
            continue;
        }
        out[f.key] = v;
    }
    return out;
}
/**
 * v2 字段类型 → 视图类型。
 * v2 没有 `select` / `input` 的区分：`string` 带 options 就是选择，不带就是文本输入。
 */
function viewTypeOf(raw) {
    const t = String(raw.type ?? '').toLowerCase();
    if (t === 'boolean')
        return 'boolean';
    if (t === 'number' || t === 'integer')
        return 'number';
    if (t === 'external')
        return 'external';
    if (t === 'multiselect')
        return 'multiselect';
    if (t === 'string' || t === 'select')
        return (raw.options?.length ?? 0) > 0 ? 'select' : 'input';
    return 'input';
}
/**
 * 把 `form.created` 事件里的 `Form.Field[]` 转成视图字段。
 * （`question` 工具的入参是另一套字段名 `{question, header, options}`，
 *  由 `src/ask.ts` 直接构造视图字段，不走这里。）
 */
export function formFieldsOf(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw.map((f, i) => {
        const type = viewTypeOf(f);
        const options = (f.options ?? []).map((o) => ({
            value: String(o.value ?? o.label ?? ''),
            label: String(o.label ?? o.value ?? ''),
            ...(o.description ? { description: String(o.description) } : {}),
        }));
        return {
            key: String(f.key ?? `q${i}`),
            type,
            question: String(f.title ?? f.key ?? `问题 ${i + 1}`),
            ...(f.description ? { description: String(f.description) } : {}),
            ...(f.placeholder ? { placeholder: String(f.placeholder) } : {}),
            ...(f.required ? { required: true } : {}),
            ...(f.hidden ? { hidden: true } : {}),
            ...(Array.isArray(f.when) && f.when.length ? { when: f.when } : {}),
            ...(typeof f.minimum === 'number' ? { minimum: f.minimum } : {}),
            ...(typeof f.maximum === 'number' ? { maximum: f.maximum } : {}),
            ...(type === 'multiselect' ? { multiple: true } : {}),
            ...(f.custom ? { custom: true } : {}),
            ...(type === 'external' && f.url ? { externalUrl: String(f.url) } : {}),
            ...(options.length ? { options } : {}),
        };
    });
}
