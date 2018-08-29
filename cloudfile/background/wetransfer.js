/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* exported WeTransferItem, WeTransferTransfer, WeTransferSession */

class WeTransferItem {
  constructor(id, name, data) {
    this.id = id;
    this.name = name;
    if (typeof data == "string") {
      let enc = new TextEncoder();
      this.buffer = enc.encode(data);
    } else {
      this.buffer = data;
    }
  }
}

class WeTransferTransfer {
  constructor(session, data) {
    this.session = session;
    this.update(data);
  }

  update(data) {
    this.id = data.id;
    this.state = data.state;
    this.url = data.shortened_url;
    this.name = data.name;
    this.description = data.description;
    this.items = data.items;
    // currently not passing on: version_identifier, size, total_items
  }

  async add(items, signal) {
    if (!Array.isArray(items)) {
      items = [items];
    }

    let response = await this.session._request(`/v1/transfers/${this.id}/items`, {
      signal: signal,
      body: JSON.stringify({
        items: items.map(item => ({
          content_identifier: "file",
          local_identifier: item.id.toString(),
          filename: item.name,
          filesize: item.buffer.byteLength
        }))
      })
    });
    
    let itemsById = new Map(items.map(item => [item.id.toString(), item]));
    let promises = [];

    for (let item of response) {
      let srcitem = itemsById.get(item.local_identifier);
      srcitem.upload_url = item.upload_url;
      srcitem.upload_expires_at = new Date(item.upload_expires_at);

      promises.push(
        this.session._request(item.upload_url, {
          signal: signal,
          body: srcitem.buffer,
          method: "PUT"
        }, false)
      );
    }
    await Promise.all(promises);
    this.items.push(...items);
    return items;
  }
}

class WeTransferSession {
  constructor(apikey, base="https://dev.wetransfer.com/", token=null) {
    this.base = base;
    this.apikey = apikey;
    this.token = token;
  }

  async _request(endpoint, fetchinfo, withToken=true) {
    let url = new URL(endpoint, this.base);
    let headers = { "x-api-key": this.apikey };
    if (this.token && withToken) {
      headers.Authorization = "Bearer " + this.token;
    }

    fetchinfo.headers = headers;
    if (!fetchinfo.method) {
      fetchinfo.method = "POST";
    }

    fetchinfo.signal = null; // TODO until we have real signals, null it out

    let response = await fetch(url, fetchinfo);
    
    let responseData;
    if (response.headers.get("content-type") == "application/json") {

      try {
        responseData = await response.json();
      } catch (e) {
        if (!response.ok) {
          throw new Error(response.statusText);
        }
        throw e;
      }

      if (responseData.success === false || responseData.error || responseData.message) {
        throw new Error(responseData.message || responseData.error);
      }
    } else {
      responseData = await response.text();
    }
    return responseData;
  }

  async authorize(signal=null) {
    let data = await this._request("/v1/authorize", { signal }, false);
    this.token = data.token;
  }

  async createTransfer(name, description="", signal=null) {
    if (!this.token) {
      await this.authorize();
    }

    let data = await this._request("/v1/transfers", {
      body: JSON.stringify({ name, description }),
      signal: signal
    });
    return new WeTransferTransfer(this, data);
  }
}
