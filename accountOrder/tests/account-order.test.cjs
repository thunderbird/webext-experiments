/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname,
  "../experiments/accountOrder/parent/ext-account-order.js"), "utf8");

function fixture({ permission = true, reorderFailure, saveFailure, keys } = {}) {
  let order = keys || ["a", "chat", "b", "smart", "local", "hidden"];
  const initial = [...order];
  let reorderCalls = 0;
  let saveCalls = 0;
  const accounts = {
    defaultAccount: "b",
    get accounts() {
      return order.filter(key => key !== "hidden").map(key => ({
        key, incomingServer: { type: key === "chat" || key === "smart" ? key : "imap" },
      }));
    },
    reorderAccounts(ids) {
      reorderCalls++;
      if (reorderFailure) {
        const outcome = reorderFailure(reorderCalls);
        if (outcome === "ignore") {
          return;
        }
        if (outcome === "throw") {
          throw new Error("native failure with private profile path");
        }
      }
      assert.deepEqual(new Set(ids), new Set(initial.filter(key => key !== "hidden")));
      order = [...ids, ...initial.filter(key => key === "hidden")];
    },
  };
  const sandbox = {
    ChromeUtils: { importESModule: () => ({ MailServices: { accounts } }) },
    ExtensionCommon: { ExtensionAPI: class {}, ExtensionError: class extends Error {} },
    Services: { prefs: { savePrefFile() {
      saveCalls++;
      if (saveFailure?.(saveCalls)) {
        throw new Error("disk failure with private profile path");
      }
    } } },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const api = new sandbox.accountOrder().getAPI({ extension: {
    hasPermission: () => permission,
    accountManager: { getType: server => !["chat", "smart"].includes(server.type) },
  } }).accountOrder;
  return { api, accounts, order: () => [...order], calls: () => ({ reorderCalls, saveCalls }) };
}

test("reads only mail account IDs and makes no changes", async () => {
  const f = fixture();
  assert.deepEqual(Array.from(await f.api.getOrder()), ["a", "b", "local"]);
  assert.deepEqual(f.calls(), { reorderCalls: 0, saveCalls: 0 });
});

test("reorders mail accounts, preserves other accounts and default account, persists", async () => {
  const f = fixture();
  await f.api.setOrder(["local", "b", "a"]);
  assert.deepEqual(f.order(), ["local", "chat", "b", "smart", "a", "hidden"]);
  assert.equal(f.accounts.defaultAccount, "b");
  assert.deepEqual(f.calls(), { reorderCalls: 1, saveCalls: 1 });
});

test("unchanged order and an empty profile are no-ops", async () => {
  const f = fixture();
  await f.api.setOrder(["a", "b", "local"]);
  assert.deepEqual(f.calls(), { reorderCalls: 0, saveCalls: 0 });
  const empty = fixture({ keys: [] });
  await empty.api.setOrder([]);
  assert.deepEqual(empty.calls(), { reorderCalls: 0, saveCalls: 0 });
});

test("invalid, incomplete, duplicate, stale and non-mail lists reject before mutation", async () => {
  for (const ids of [null, "a,b,local", [], ["a", "b"], ["a", "a", "local"],
    ["a", "unknown", "local"], ["a", "chat", "local"], ["a", "hidden", "local"],
    ["a", "smart", "local"], ["a", 1, "local"], ["a", "b", "local", "extra"]]) {
    const f = fixture();
    await assert.rejects(f.api.setOrder(ids), /every current mail account ID/);
    assert.deepEqual(f.calls(), { reorderCalls: 0, saveCalls: 0 });
  }
});

test("both methods require accountsRead", async () => {
  const f = fixture({ permission: false });
  await assert.rejects(f.api.getOrder(), /accountsRead/);
  await assert.rejects(f.api.setOrder(["local", "b", "a"]), /accountsRead/);
  assert.deepEqual(f.calls(), { reorderCalls: 0, saveCalls: 0 });
});

test("native write or readback failure restores the previous order", async () => {
  for (const outcome of ["throw", "ignore"]) {
    const f = fixture({ reorderFailure: call => call === 1 ? outcome : null });
    const before = f.order();
    await assert.rejects(f.api.setOrder(["local", "b", "a"]), /previous order was restored/);
    assert.deepEqual(f.order(), before);
  }
});

test("persistence failure restores and persists the previous order", async () => {
  const f = fixture({ saveFailure: call => call === 1 });
  const before = f.order();
  await assert.rejects(f.api.setOrder(["local", "b", "a"]), /previous order was restored/);
  assert.deepEqual(f.order(), before);
  assert.deepEqual(f.calls(), { reorderCalls: 2, saveCalls: 2 });
});

test("rollback write, readback and persistence failures are reported without leaking native errors", async () => {
  const cases = [
    { saveFailure: () => true },
    { saveFailure: call => call === 1, reorderFailure: call => call === 2 ? "throw" : null },
    { saveFailure: call => call === 1, reorderFailure: call => call === 2 ? "ignore" : null },
  ];
  for (const options of cases) {
    const f = fixture(options);
    await assert.rejects(f.api.setOrder(["local", "b", "a"]), error => {
      assert.match(error.message, /Could not save or restore/);
      assert.ok(!error.message.includes("private profile path"));
      return true;
    });
  }
});

test("schema and example register only the two scoped methods", () => {
  const root = path.join(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json")));
  const entry = manifest.experiment_apis.accountOrder;
  const schema = JSON.parse(fs.readFileSync(path.join(root, entry.schema)));
  assert.deepEqual(Object.keys(manifest.experiment_apis), ["accountOrder"]);
  assert.deepEqual(schema[0].functions.map(fn => fn.name), ["getOrder", "setOrder"]);
  assert.deepEqual(schema[0].permissions, ["accountsRead"]);
  assert.ok(fs.existsSync(path.join(root, entry.parent.script)));
});
