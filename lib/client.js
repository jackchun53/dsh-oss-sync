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
var import_jsx_runtime = require("react/jsx-runtime");
var NS = "oss-sync";
var FIELDS = [
  { field: "bucket", label: "\u5B58\u50A8\u6876", hint: "\u4E24\u4EFD\u6587\u6863\u90FD\u5B58\u653E\u4E8E\u6B64\u3002" },
  { field: "endpoint", label: "\u7AEF\u70B9", hint: "S3 \u517C\u5BB9\u5730\u5740\uFF1B\u7559\u7A7A\u8868\u793A\u4F7F\u7528 AWS\u3002" },
  { field: "prefix", label: "\u952E\u524D\u7F00", hint: "\u4FEE\u6539\u540E\u4F1A\u79FB\u52A8\u4E24\u4EFD\u6587\u6863\u3002" },
  { field: "region", label: "\u533A\u57DF", hint: "\u7B7E\u540D\u4F7F\u7528\u7684\u533A\u57DF\u3002" },
  { field: "pollMs", label: "\u8F6E\u8BE2\u95F4\u9694\uFF08\u6BEB\u79D2\uFF09", hint: "\u53E6\u4E00\u53F0\u673A\u5668\u7684\u5199\u5165\u591A\u4E45\u5230\u8FBE\u672C\u673A\u3002" },
  {
    field: "accessKeyId",
    label: "\u8BBF\u95EE\u5BC6\u94A5 ID",
    hint: "\u53EA\u4FDD\u5B58\u5728\u672C\u673A\uFF0C\u4E0D\u4F1A\u5199\u5165\u5B58\u50A8\u6876\u3002",
    clearWithEmpty: true
  },
  {
    field: "secretAccessKey",
    label: "\u8BBF\u95EE\u5BC6\u94A5 Secret",
    hint: "\u53EA\u4FDD\u5B58\u5728\u672C\u673A\uFF0C\u4E0D\u4F1A\u5199\u5165\u5B58\u50A8\u6876\uFF1B\u6E05\u7A7A\u5373\u5220\u9664\u672C\u673A\u4FDD\u5B58\u7684\u5BC6\u94A5\u3002",
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
    this.snapshot.set({ ...state, saving: true, failure: void 0 });
    try {
      for (const entry of pending) {
        const text = state.drafts[entry.field] ?? "";
        if (text.length === 0 && entry.clearWithEmpty !== true) await this.scope.unset(entry.field);
        else await this.scope.set(entry.field, entry.field === "pollMs" ? Number(text) : text);
      }
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
var LABEL = { display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "2px" };
var HINT = { color: "var(--dsh-text-secondary, #666)", fontSize: "11px" };
var INPUT = { width: "100%", padding: "4px 6px", font: "inherit" };
var ROW = { display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "8px" };
function OssSyncCard(props) {
  const state = props.useOssSyncCard((snapshot) => snapshot);
  const unconfigured = Object.values(state.status).some((entry) => entry.configured === false);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { border: "1px solid var(--dsh-border, #ddd)", borderRadius: "6px", padding: "12px" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "OSS \u540C\u6B65" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: HINT, children: state.ready ? state.writable ? "\u53EF\u5199" : "\u53EA\u8BFB" : "\u7B49\u5F85\u5BBF\u4E3B" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...HINT, margin: "4px 0 10px" }, children: "\u8BBE\u7F6E\u4E0E\u5BC6\u94A5\u90FD\u5B58\u653E\u5728 S3 \u517C\u5BB9\u7684\u5B58\u50A8\u6876\u91CC\uFF0C\u56E0\u6B64\u6BCF\u53F0\u673A\u5668\u8BFB\u53D6\u540C\u4E00\u4EFD\u6587\u6863\u3002\u6539\u52A8\u4F1A\u5728\u4E0B\u4E00\u6B21\u8BF7\u6C42\u65F6\u751F\u6548\uFF1B \u5B58\u50A8\u6876\u4E0E\u7AEF\u70B9\u7ACB\u5373\u751F\u6548\u3002" }),
    unconfigured ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...HINT, margin: "0 0 10px" }, children: "\u5C1A\u672A\u914D\u7F6E\u5B58\u50A8\u6876\uFF1A\u5728\u4FDD\u5B58\u4E00\u4E2A\u4E4B\u524D\uFF0C\u8BBE\u7F6E\u4E0E\u5BC6\u94A5\u53EA\u7559\u5728\u672C\u673A\u3002\u4FDD\u5B58\u65F6\u4F1A\u4EE5\u672C\u673A\u6587\u6863\u4F5C\u4E3A\u521D\u59CB\u5185\u5BB9\u5199\u5165\u3002" }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { display: "grid", gap: "8px" }, children: FIELDS.map((entry) => {
      const draft = state.drafts[entry.field];
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { htmlFor: `oss-sync-${entry.field}`, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: LABEL, children: [
          entry.label,
          state.overridden[entry.field] === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { style: HINT, children: " \uFF08\u5DF2\u8986\u76D6\uFF09" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            id: `oss-sync-${entry.field}`,
            style: INPUT,
            type: entry.secret === true ? "password" : "text",
            autoComplete: entry.secret === true ? "new-password" : "off",
            disabled: !state.writable || state.saving,
            value: draft ?? renderValue(state.values[entry.field]),
            onChange: (event) => {
              props.edit(entry.field, event.target.value);
            }
          }
        ),
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
    state.failure === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...HINT, color: "var(--dsh-danger, #b00)" }, children: state.failure }),
    ["settings", "credentials"].map((label) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: "10px" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: LABEL, children: label === "settings" ? "\u8BBE\u7F6E" : "\u5BC6\u94A5" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: HINT, children: describeStatus(state.status[label]) })
    ] }, label))
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
