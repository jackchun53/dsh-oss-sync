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
  { field: "bucket", label: "Bucket", hint: "Holds both documents." },
  { field: "endpoint", label: "Endpoint", hint: "S3-compatible address; empty means AWS." },
  { field: "prefix", label: "Key prefix", hint: "Changing it moves both documents." },
  { field: "region", label: "Region", hint: "Signature region." },
  { field: "pollMs", label: "Poll interval (ms)", hint: "How fast another machine's write arrives." }
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
    this.snapshot.set({ ...state, saving: true, failure: void 0 });
    try {
      for (const entry of pending) {
        const text = state.drafts[entry.field] ?? "";
        if (text.length === 0) await this.scope.unset(entry.field);
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
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { border: "1px solid var(--dsh-border, #ddd)", borderRadius: "6px", padding: "12px" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "OSS Sync" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: HINT, children: state.ready ? state.writable ? "writable" : "read-only" : "waiting for the host" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...HINT, margin: "4px 0 10px" }, children: "Settings and credentials are stored in an S3-compatible bucket, so every machine reads the same documents. Changes take effect on the next request; the bucket and endpoint apply immediately." }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { display: "grid", gap: "8px" }, children: FIELDS.map((entry) => {
      const draft = state.drafts[entry.field];
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { htmlFor: `oss-sync-${entry.field}`, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: LABEL, children: [
          entry.label,
          state.overridden[entry.field] === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { style: HINT, children: " (overridden)" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            id: `oss-sync-${entry.field}`,
            style: INPUT,
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
      }, children: state.saving ? "Saving\u2026" : "Save" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: !state.dirty || state.saving, onClick: () => {
        props.discard();
      }, children: "Discard" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: !state.ready, onClick: () => {
        props.action("pull");
      }, children: "Sync now" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: !state.ready, onClick: () => {
        props.action("push");
      }, children: "Force push" })
    ] }),
    state.failure === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...HINT, color: "var(--dsh-danger, #b00)" }, children: state.failure }),
    ["settings", "credentials"].map((label) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: "10px" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: LABEL, children: label }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: HINT, children: describeStatus(state.status[label]) })
    ] }, label))
  ] });
}
function describeStatus(status) {
  if (status === void 0) return "no status yet";
  const parts = [
    `state ${status.state ?? "unknown"}`,
    `revision ${String(status.revision ?? 0)}`,
    status.objectKey === void 0 ? void 0 : `key ${status.objectKey}`,
    status.lastReadAt === void 0 ? void 0 : `read ${status.lastReadAt}`,
    status.lastWriteAt === void 0 ? void 0 : `wrote ${status.lastWriteAt}`,
    status.lastError === void 0 ? void 0 : `error ${status.lastError}`
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
