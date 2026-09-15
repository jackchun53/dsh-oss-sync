window.__ModuleLoader__.load({
	id: "dsh-oss-sync",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var import_jsx_runtime = require("react/jsx-runtime");
var NS = "oss-sync";
var FIELDS = [
  { field: "bucket", label: "\u5B58\u50A8\u6876", hint: "\u4E24\u4EFD\u6587\u6863\u90FD\u5B58\u653E\u4E8E\u6B64\uFF0C\u4F8B\u5982 dsh-config\u3002" },
  { field: "endpoint", label: "S3 \u7AEF\u70B9", hint: "\u4F8B\u5982 https://tos-s3-cn-shanghai.volces.com\uFF1B\u7701\u7565\u534F\u8BAE\u65F6\u81EA\u52A8\u8865 https://\u3002" },
  { field: "prefix", label: "\u952E\u524D\u7F00", hint: "\u4FEE\u6539\u540E\u4F1A\u79FB\u52A8\u4E24\u4EFD\u6587\u6863\u3002" },
  { field: "region", label: "\u7B7E\u540D\u533A\u57DF", hint: "\u5FC5\u987B\u4F7F\u7528\u670D\u52A1\u5546\u7684\u533A\u57DF\u503C\uFF1B\u706B\u5C71 TOS \u4E0A\u6D77\u901A\u5E38\u4E3A cn-shanghai\u3002" },
  {
    field: "forcePathStyle",
    label: "\u8DEF\u5F84\u5F0F\u5BFB\u5740",
    hint: "\u706B\u5C71 TOS\u3001\u963F\u91CC\u4E91 OSS \u4E0E AWS \u8BF7\u9009\u62E9\u201C\u5173\u95ED\u201D\uFF1BMinIO \u7B49\u4EC5\u5728\u8981\u6C42 path-style \u65F6\u5F00\u542F\u3002",
    boolean: true
  },
  { field: "pollMs", label: "\u8F6E\u8BE2\u95F4\u9694\uFF08\u6BEB\u79D2\uFF09", hint: "\u53E6\u4E00\u53F0\u673A\u5668\u7684\u5199\u5165\u591A\u4E45\u5230\u8FBE\u672C\u673A\u3002" },
  {
    field: "accessKeyId",
    label: "\u5BF9\u8C61\u5B58\u50A8 AccessKey ID",
    hint: "\u8FD9\u662F OSS/TOS \u7684\u8BBF\u95EE\u5BC6\u94A5\uFF0C\u4E0D\u662F\u6A21\u578B\u63D0\u4F9B\u65B9 API Key\uFF1B\u53EA\u4FDD\u5B58\u5728\u672C\u673A\u3002",
    clearWithEmpty: true
  },
  {
    field: "secretAccessKey",
    label: "\u5BF9\u8C61\u5B58\u50A8 AccessKey Secret",
    hint: "\u8FD9\u662F OSS/TOS \u7684\u8BBF\u95EE\u5BC6\u94A5\uFF0C\u4E0D\u662F\u6A21\u578B\u63D0\u4F9B\u65B9 API Key\uFF1B\u6E05\u7A7A\u4E24\u9879\u5373\u5220\u9664\u672C\u673A\u4FDD\u5B58\u3002",
    secret: true,
    clearWithEmpty: true
  }
];
function observable(initial) {
  let snapshot = initial;
  const listeners = /* @__PURE__ */ new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (next) => {
      if (Object.is(next, snapshot)) return;
      snapshot = next;
      for (const listener of listeners) listener();
    }
  };
}
var CardController = class {
  /** @param scope - the bound settings scope for the `oss-sync` namespace. */
  constructor(scope) {
    this.scope = scope;
    this.project(scope.getSnapshot());
    this.unsubscribe = scope.subscribe(() => {
      this.project(scope.getSnapshot());
    });
  }
  snapshot = observable({
    ready: false,
    writable: false,
    drafts: {},
    dirty: false,
    saving: false,
    failure: void 0,
    values: {},
    overridden: {},
    status: {}
  });
  unsubscribe;
  /** The face the slot registration injects. */
  inject() {
    return {
      hooks: { ossSyncCard: this.snapshot },
      edit: (field, text) => {
        const state = this.snapshot.getSnapshot();
        const drafts = { ...state.drafts, [field]: text };
        this.snapshot.set({
          ...state,
          drafts,
          dirty: FIELDS.some((entry) => drafts[entry.field] !== void 0 && drafts[entry.field] !== renderValue(state.values[entry.field])),
          failure: void 0
        });
      },
      save: () => {
        void this.save();
      },
      discard: () => {
        const state = this.snapshot.getSnapshot();
        this.snapshot.set({ ...state, drafts: {}, dirty: false, failure: void 0 });
      },
      action: (verb) => {
        void this.action(verb);
      }
    };
  }
  /** Release the scope subscription. */
  dispose() {
    this.unsubscribe();
  }
  /** Project a scope snapshot onto the card state, keeping unsaved drafts. */
  project(snapshot) {
    const value = snapshot.value ?? {};
    const current = this.snapshot.getSnapshot();
    const drafts = {};
    for (const entry of FIELDS) {
      const staged = current.drafts[entry.field];
      if (staged !== void 0 && staged !== renderValue(value[entry.field])) drafts[entry.field] = staged;
    }
    this.snapshot.set({
      ready: snapshot.status === "ready",
      writable: snapshot.writable,
      drafts,
      dirty: Object.keys(drafts).length > 0,
      saving: current.saving,
      failure: current.failure,
      values: value,
      overridden: snapshot.user ?? {},
      status: value["status"] ?? {}
    });
  }
  /** Write every staged field, then clear the drafts. */
  async save() {
    const state = this.snapshot.getSnapshot();
    const pending = FIELDS.filter((entry) => state.drafts[entry.field] !== void 0);
    if (pending.length === 0) return;
    const fieldAfter = (field) => state.drafts[field] ?? renderValue(state.values[field]);
    const halfPair = fieldAfter("accessKeyId").length === 0 !== (fieldAfter("secretAccessKey").length === 0);
    if (halfPair) {
      this.snapshot.set({ ...state, failure: "\u8BBF\u95EE\u5BC6\u94A5 ID \u4E0E Secret \u5FC5\u987B\u540C\u65F6\u586B\u5199\u6216\u540C\u65F6\u6E05\u7A7A" });
      return;
    }
    const pollDraft = state.drafts["pollMs"];
    if (pollDraft !== void 0 && (!Number.isFinite(Number(pollDraft)) || Number(pollDraft) < 1e3)) {
      this.snapshot.set({ ...state, failure: "\u8F6E\u8BE2\u95F4\u9694\u5FC5\u987B\u662F\u4E0D\u5C0F\u4E8E 1000 \u7684\u6570\u5B57" });
      return;
    }
    this.snapshot.set({ ...state, saving: true, failure: void 0 });
    try {
      await this.scope.mutate(pending.map((entry) => {
        const text = state.drafts[entry.field] ?? "";
        if (text.length === 0 && entry.clearWithEmpty !== true) {
          return { op: "unset", path: [entry.field] };
        }
        const value = entry.field === "pollMs" ? Number(text) : entry.boolean === true ? text === "true" : text;
        return { op: "set", path: [entry.field], value };
      }));
      const latest = this.snapshot.getSnapshot();
      this.snapshot.set({ ...latest, drafts: {}, dirty: false, saving: false });
    } catch (error) {
      this.snapshot.set({ ...this.snapshot.getSnapshot(), saving: false, failure: String(error) });
    }
  }
  /** Write a request token; the host runs the verb on both providers. */
  async action(verb) {
    const state = this.snapshot.getSnapshot();
    this.snapshot.set({ ...state, failure: void 0 });
    try {
      await this.scope.set("request", `${verb}:${String(Date.now())}`);
    } catch (error) {
      this.snapshot.set({ ...this.snapshot.getSnapshot(), failure: String(error) });
    }
  }
};
function renderValue(value) {
  return value === void 0 || value === null ? "" : String(value);
}
var CARD = {
  listStyle: "none",
  border: "0.5px solid var(--dsw-alias-border-l4)",
  borderRadius: "16px",
  background: "var(--dsw-alias-bg-layer-3)",
  transition: "border-color .16s, background .16s"
};
var CARD_OPEN = {
  background: "var(--dsw-alias-bg-layer-2)",
  borderColor: "var(--dsw-alias-label-dimmed)"
};
var CARD_HOVER = { borderColor: "var(--dsw-alias-label-dimmed)" };
var HEADER = {
  appearance: "none",
  width: "100%",
  border: 0,
  background: "none",
  font: "inherit",
  color: "inherit",
  textAlign: "left",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: "12px",
  padding: "14px 16px",
  borderRadius: "12px"
};
var HEAD_TEXT = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: "4px"
};
var NAME = {
  fontSize: "15px",
  fontWeight: 600,
  lineHeight: 1.4,
  color: "var(--dsw-alias-label-primary)"
};
var DESCRIPTION = {
  fontSize: "13px",
  lineHeight: 1.5,
  color: "var(--dsw-alias-label-tertiary)"
};
var CHEVRON = {
  flex: "none",
  display: "inline-flex",
  color: "var(--dsw-alias-label-tertiary)",
  transition: "transform .16s"
};
var BODY = {
  borderTop: "0.5px solid var(--dsw-alias-border-l2)",
  margin: "0 16px",
  paddingBottom: "8px"
};
var READ_ONLY = {
  margin: "12px 0 0",
  fontSize: "12px",
  lineHeight: 1.5,
  color: "var(--dsw-alias-label-tertiary)"
};
var LABEL = {
  display: "block",
  fontSize: "12px",
  fontWeight: 600,
  marginBottom: "2px",
  color: "var(--dsw-alias-label-secondary)"
};
var HINT = { color: "var(--dsw-alias-label-tertiary)", fontSize: "11px" };
var INPUT = {
  width: "100%",
  padding: "5px 8px",
  font: "inherit",
  fontSize: "13px",
  color: "var(--dsw-alias-label-primary)",
  background: "var(--dsw-alias-bg-layer-1)",
  border: "0.5px solid var(--dsw-alias-border-l4)",
  borderRadius: "10px"
};
var ROW = { display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "8px" };
var SECRET_ROW = { display: "flex", gap: "6px", alignItems: "center" };
var INLINE_CONTROL = {
  flex: "none",
  padding: "5px 8px",
  font: "inherit",
  fontSize: "12px",
  whiteSpace: "nowrap",
  color: "var(--dsw-alias-label-secondary)",
  background: "var(--dsw-alias-bg-layer-1)",
  border: "0.5px solid var(--dsw-alias-border-l4)",
  borderRadius: "8px",
  cursor: "pointer"
};
function OssSyncCard(props) {
  const state = props.useOssSyncCard((snapshot) => snapshot);
  const [open, setOpen] = (0, import_react.useState)(false);
  const [hovered, setHovered] = (0, import_react.useState)(false);
  const [revealed, setRevealed] = (0, import_react.useState)([]);
  const [copied, setCopied] = (0, import_react.useState)(void 0);
  const saveStarted = (0, import_react.useRef)(false);
  const copyTimer = (0, import_react.useRef)(void 0);
  (0, import_react.useEffect)(() => () => {
    clearTimeout(copyTimer.current);
  }, []);
  const toggleReveal = (field) => {
    setRevealed((current) => current.includes(field) ? current.filter((name) => name !== field) : [...current, field]);
  };
  const copyField = (field, text) => {
    void (0, import_dsh_client_ui_primitives.writeClipboard)(text).then((accepted) => {
      setCopied({ field, ok: accepted });
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => {
        setCopied(void 0);
      }, 1600);
    });
  };
  const unconfigured = Object.values(state.status).some((entry) => entry.configured === false);
  (0, import_react.useEffect)(() => {
    if (state.saving) {
      saveStarted.current = true;
      return;
    }
    if (!saveStarted.current) return;
    saveStarted.current = false;
    if (!state.dirty && state.failure === void 0) setOpen(false);
  }, [state.dirty, state.failure, state.saving]);
  const badge = !state.ready ? "\u7B49\u5F85\u5BBF\u4E3B" : unconfigured ? "\u4EC5\u672C\u673A" : state.writable ? void 0 : "\u53EA\u8BFB";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { style: { ...CARD, ...open ? CARD_OPEN : {}, ...hovered && !open ? CARD_HOVER : {} }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "button",
      {
        type: "button",
        style: HEADER,
        "aria-expanded": open,
        "aria-label": `${open ? "\u6536\u8D77" : "\u5C55\u5F00"}\uFF1AOSS \u540C\u6B65`,
        onMouseEnter: () => {
          setHovered(true);
        },
        onMouseLeave: () => {
          setHovered(false);
        },
        onClick: () => {
          setOpen(!open);
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: HEAD_TEXT, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: NAME, children: "OSS \u540C\u6B65" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: DESCRIPTION, children: "\u8BBE\u7F6E\u4E0E\u5BC6\u94A5\u5B58\u653E\u4E8E S3 \u517C\u5BB9\u7684\u5B58\u50A8\u6876\uFF0C\u6BCF\u53F0\u673A\u5668\u8BFB\u53D6\u540C\u4E00\u4EFD\u6587\u6863\u3002" })
          ] }),
          badge === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { tone: unconfigured ? "warning" : "quiet", children: badge }),
          state.dirty ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { tone: "neutral", children: "\u672A\u4FDD\u5B58" }) : null,
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: open ? { ...CHEVRON, transform: "rotate(180deg)" } : CHEVRON, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconChevronDownOutline14, {}) })
        ]
      }
    ),
    open ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: BODY, children: [
      state.writable ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: READ_ONLY, role: "status", children: "\u5F53\u524D\u4E3A\u53EA\u8BFB\uFF1A\u8FD9\u4E2A\u90E8\u7F72\u4E0D\u63A5\u53D7\u8BBE\u7F6E\u5199\u5165\u3002" }),
      unconfigured ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...HINT, margin: "10px 0" }, children: "\u5C1A\u672A\u914D\u7F6E\u5B58\u50A8\u6876\uFF1A\u5728\u4FDD\u5B58\u4E00\u4E2A\u4E4B\u524D\uFF0C\u8BBE\u7F6E\u4E0E\u5BC6\u94A5\u53EA\u7559\u5728\u672C\u673A\u3002\u4FDD\u5B58\u65F6\u4F1A\u4EE5\u672C\u673A\u6587\u6863\u4F5C\u4E3A\u521D\u59CB\u5185\u5BB9\u5199\u5165\u3002" }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { display: "grid", gap: "8px", marginTop: "10px" }, children: FIELDS.map((entry) => {
        const draft = state.drafts[entry.field];
        const text = draft ?? renderValue(state.values[entry.field]);
        const locked = !state.writable || state.saving;
        const control = /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            id: `oss-sync-${entry.field}`,
            style: INPUT,
            type: entry.secret === true && !revealed.includes(entry.field) ? "password" : "text",
            autoComplete: entry.secret === true ? "new-password" : "off",
            disabled: locked,
            value: text,
            onChange: (event) => {
              props.edit(entry.field, event.target.value);
            }
          }
        );
        return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: LABEL, htmlFor: `oss-sync-${entry.field}`, children: [
            entry.label,
            state.overridden[entry.field] === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { style: HINT, children: " \uFF08\u5DF2\u8986\u76D6\uFF09" })
          ] }),
          entry.boolean === true ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            "select",
            {
              id: `oss-sync-${entry.field}`,
              style: INPUT,
              disabled: locked,
              value: text,
              onChange: (event) => {
                props.edit(entry.field, event.target.value);
              },
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "false", children: "\u5173\u95ED\uFF08\u865A\u62DF\u4E3B\u673A\u5F0F\uFF0COSS / TOS / AWS\uFF09" }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "true", children: "\u5F00\u542F\uFF08\u8DEF\u5F84\u5F0F\uFF0C\u90E8\u5206 MinIO\uFF09" })
              ]
            }
          ) : entry.secret === true ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: SECRET_ROW, children: [
            control,
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "button",
              {
                type: "button",
                style: INLINE_CONTROL,
                "aria-label": `${revealed.includes(entry.field) ? "\u9690\u85CF" : "\u663E\u793A"}\uFF1A${entry.label}`,
                "aria-pressed": revealed.includes(entry.field),
                onClick: () => {
                  toggleReveal(entry.field);
                },
                children: revealed.includes(entry.field) ? "\u9690\u85CF" : "\u663E\u793A"
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "button",
              {
                type: "button",
                style: INLINE_CONTROL,
                "aria-label": `\u590D\u5236\uFF1A${entry.label}`,
                disabled: text === "",
                onClick: () => {
                  copyField(entry.field, text);
                },
                children: copied?.field === entry.field ? copied.ok ? "\u5DF2\u590D\u5236" : "\u590D\u5236\u5931\u8D25" : "\u590D\u5236"
              }
            )
          ] }) : control,
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: HINT, children: entry.hint })
        ] }, entry.field);
      }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: ROW, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: !state.dirty || state.saving, onClick: () => {
          props.save();
        }, children: state.saving ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: !state.dirty || state.saving, onClick: () => {
          props.discard();
        }, children: "\u653E\u5F03" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: !state.ready || unconfigured, onClick: () => {
          props.action("pull");
        }, children: "\u7ACB\u5373\u540C\u6B65" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: !state.ready || unconfigured, onClick: () => {
          props.action("push");
        }, children: "\u5F3A\u5236\u63A8\u9001" })
      ] }),
      state.failure === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...HINT, color: "var(--dsw-alias-state-error-primary)" }, children: state.failure }),
      ["settings", "credentials"].map((label) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: "10px" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: LABEL, children: label === "settings" ? "\u8BBE\u7F6E" : "\u5BC6\u94A5" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: HINT, children: describeStatus(state.status[label]) })
      ] }, label))
    ] }) : null
  ] });
}
function describeStatus(status) {
  if (status === void 0) return "\u6682\u65E0\u72B6\u6001";
  if (status.configured === false) {
    return status.lastError === void 0 ? "\u672A\u914D\u7F6E \xB7 \u4E0D\u8BFB\u53D6\u4E5F\u4E0D\u5199\u5165" : `\u672A\u914D\u7F6E \xB7 \u4E0D\u8BFB\u53D6\u4E5F\u4E0D\u5199\u5165 \xB7 \u9519\u8BEF ${status.lastError}`;
  }
  const parts = [
    `\u72B6\u6001 ${status.state === "error" ? "\u9519\u8BEF" : "\u6B63\u5E38"}`,
    `\u7248\u672C ${String(status.revision ?? 0)}`,
    status.objectKey === void 0 ? void 0 : `\u5BF9\u8C61 ${status.objectKey}`,
    status.lastReadAt === void 0 ? void 0 : `\u8BFB\u53D6 ${status.lastReadAt}`,
    status.lastWriteAt === void 0 ? void 0 : `\u5199\u5165 ${status.lastWriteAt}`,
    status.lastError === void 0 ? void 0 : `\u9519\u8BEF ${status.lastError}`
  ];
  return parts.filter((part) => part !== void 0).join(" \xB7 ");
}
var inject = ["slots", "settingsScope"];
function apply(ctx) {
  const controller = new CardController(ctx.settingsScope.bind({ namespace: NS }));
  ctx.effect(() => () => {
    controller.dispose();
  }, "dsh-oss-sync: card controller");
  ctx.slots.inject("settings.plugin.item", function* () {
    yield ctx.slots.register({
      name: "settings.plugin.item",
      key: NS,
      inject: () => controller.inject()
    }, OssSyncCard);
  });
}
		return module.exports;
	}
});
