# Account Order MailExtension Experiment

| Item | Value |
| --- | --- |
| Description | Read and persist the order of existing mail accounts |
| Status | Draft proposal; not yet published by this repository |
| Compatibility | Designed for Thunderbird 160; see validation below |
| Tracking | [issue #73](https://github.com/thunderbird/webext-experiments/issues/73) |

## Scope

The built-in `accounts.list(false)` API exposes the folder-pane account order,
but currently has no method to change it. This experiment provides just two
methods, using the same mail account IDs and account types:

* `accountOrder.getOrder()` resolves to an array of mail account IDs in order.
* `accountOrder.setOrder(accountIds)` persists a complete permutation of those
  IDs and resolves with no value. It does not change the default account.

The implementation delegates to Thunderbird's native account manager. It does
not patch windows, replace the folder pane, read messages or credentials,
reorder folders, create accounts, or provide account groups. Visible accounts
outside the mail accounts API retain their slots. Hidden accounts are preserved
by the native reorder operation, which may place them after visible accounts.

Both methods require `accountsRead`. As with other experiments, this does **not**
provide a permission sandbox: installing an experiment still requires full,
unrestricted access. A future core API's write-permission design is for
Thunderbird maintainers to decide.

## Contract and errors

Read the order immediately before editing it and submit every current mail
account ID exactly once. Missing, duplicate, unknown, hidden, and non-mail IDs
are rejected before mutation. A changed membership requires reloading the list.
There is no compare-and-swap check for another actor's reorder of the same IDs;
the last successful call wins. There are no timers or startup reapplication.

An unchanged order is a no-op. Otherwise the new native order is read back and
preferences are flushed. On a write, readback, or persistence failure, the API
attempts to restore, verify, and persist the previous order. A failure of that
restoration is reported distinctly. Reload the actual order after any error;
this is a best-effort recovery, not a disk transaction or crash guarantee.
Error messages do not return native errors containing local profile paths.
Disabling the experiment leaves the chosen order in Thunderbird, just as a
manual account reorder would. Applications can offer an explicit undo action
using a previously read order if membership is still unchanged.

## Use

Copy `experiments/accountOrder` into your add-on and copy the matching
`experiment_apis` entry from this directory's `manifest.json`. Include
`accountsRead` in the add-on's permissions. Loading the example only logs the
number of mail accounts; it never changes their order automatically.

For example, after the user has explicitly selected a new order:

```js
const original = await messenger.accountOrder.getOrder();
const desired = [...original].reverse();
await messenger.accountOrder.setOrder(desired);
// An explicit undo while the same accounts still exist:
await messenger.accountOrder.setOrder(original);
```

This is a proposed experiment, not an accepted core API or an ATN approval.
Applications seeking the published-draft route must wait for repository
acceptance/publication and use that published implementation unmodified.

## Validation

From the repository root:

```sh
npm ci --ignore-scripts
npm run lint
node --test accountOrder/tests/account-order.test.cjs
```

The dependency-free Node tests exercise the actual implementation with mocked
native services. They cover invalid and stale membership, permission denial,
excluded and hidden accounts, the default account, no-ops, persistence errors,
readback errors, and recovery failures. These tests do not prove native UI
behavior or replace testing in Thunderbird.

Native validation is still pending: an isolated headless Thunderbird 160 test
profile did not produce a completed result. No successful native runtime,
restart-persistence, or folder-pane UI test is claimed by this draft.

For native testing, use a disposable profile with synthetic accounts. Compare
`getOrder()` with the IDs from `accounts.list(false)`, reverse the order, check
the default and hidden accounts, restart Thunderbird, verify persistence, and
restore the original order. Also test with the folder pane open before widening
compatibility. Native validation results for this submission are recorded in
the pull request; compatibility with other Thunderbird versions and operating
systems is not claimed.

## References and license

* [accounts API](https://webextension-api.thunderbird.net/en/latest/accounts.html)
* [Experiment design](https://developer.thunderbird.net/add-ons/mailextensions/experiments)
* [Native account manager](https://searchfox.org/comm-central/source/mailnews/base/src/nsMsgAccountManager.cpp)
* [Built-in account conversion](https://searchfox.org/comm-central/source/mail/components/extensions/ExtensionAccounts.sys.mjs)

This experiment and example are available under the Mozilla Public License 2.0.
