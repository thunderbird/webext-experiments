/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const TWO_GB = 2147483648;
const API_KEY = "get_your_own";
const API_URL = "https://dev.wetransfer.com/";

function getSession() {
  if (!getSession.session) {
    getSession.session = new WeTransferSession(API_KEY, API_URL);
  }
  return getSession.session;
}

browser.cloudfile.onUploadFile.addListener(async ({ id, name, data }, abortSignal) => {
  let session = getSession();
  let transfer = await session.createTransfer(name, "", abortSignal);
  await transfer.add(new WeTransferItem(id, name, data), abortSignal);

  return { url: transfer.url };
});

browser.cloudfile.setQuota({ uploadSizeLimit: TWO_GB });
