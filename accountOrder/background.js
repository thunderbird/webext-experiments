/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use strict";

// Loading the example does not reorder accounts. See README for explicit calls.
messenger.accountOrder.getOrder().then(order => {
  console.log("accountOrder example loaded; mail account count:", order.length);
}).catch(console.error);
