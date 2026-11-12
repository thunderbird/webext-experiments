/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* global ExtensionCommon */

"use strict";

// Keep imported modules and helpers private to this experiment.
var accountOrder = (function() {
  const { MailServices } = ChromeUtils.importESModule(
    "resource:///modules/MailServices.sys.mjs"
  );

  function equalOrder(left, right) {
    return left.length === right.length &&
      left.every((id, index) => id === right[index]);
  }

  function nativeOrder() {
    return Array.from(MailServices.accounts.accounts, account => account.key);
  }

  return class extends ExtensionCommon.ExtensionAPI {
    getAPI(context) {
      const requirePermission = () => {
        if (!context.extension.hasPermission("accountsRead")) {
          throw new ExtensionCommon.ExtensionError("accountsRead is required.");
        }
      };
      // Match the account types exposed by the built-in accounts API.
      const getOrder = () => Array.from(MailServices.accounts.accounts)
        .filter(account => context.extension.accountManager.getType(account.incomingServer))
        .map(account => account.key);

      return {
        accountOrder: {
          async getOrder() {
            requirePermission();
            return getOrder();
          },

          async setOrder(accountIds) {
            requirePermission();
            const current = getOrder();
            const eligible = new Set(current);
            if (!Array.isArray(accountIds) || accountIds.length !== current.length ||
                new Set(accountIds).size !== current.length ||
                accountIds.some(id => typeof id !== "string" || !eligible.has(id))) {
              throw new ExtensionCommon.ExtensionError(
                "Provide every current mail account ID exactly once. Reload the account list."
              );
            }
            if (equalOrder(current, accountIds)) {
              return;
            }

            const before = nativeOrder();
            let index = 0;
            // Keep visible accounts outside the mail API in their existing slots.
            // The native reorderAccounts method also preserves hidden accounts.
            const after = before.map(id => eligible.has(id) ? accountIds[index++] : id);
            try {
              MailServices.accounts.reorderAccounts(after);
              if (!equalOrder(nativeOrder(), after)) {
                throw new Error("Account order readback failed.");
              }
              Services.prefs.savePrefFile(null);
            } catch (error) {
              try {
                MailServices.accounts.reorderAccounts(before);
                if (!equalOrder(nativeOrder(), before)) {
                  throw new Error("Account order rollback readback failed.");
                }
                Services.prefs.savePrefFile(null);
              } catch (rollbackError) {
                throw new ExtensionCommon.ExtensionError(
                  "Could not save or restore account order. Reload and check Thunderbird's account order."
                );
              }
              throw new ExtensionCommon.ExtensionError(
                "Could not save account order. The previous order was restored."
              );
            }
          },
        },
      };
    }
  };
})();
