/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* global Cc, Ci, Cu, ExtensionAPI */

ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");
ChromeUtils.import("resource://gre/modules/Preferences.jsm");
ChromeUtils.import("resource://gre/modules/Services.jsm");
ChromeUtils.import("resource://gre/modules/ExtensionParent.jsm");

Cu.importGlobalProperties(["File", "FileReader"]);

// TODO should submit a patch to expose the real AbortController to Cu.importGlobalProperties. This
// is a pretty crude polyfill.
class AbortController {
  constructor() {
    this.signal = this;
    this.onabort = null;
    this.aborted = false;
  }

  abort() {
    if (this.onabort) {
      this.onabort();
    }
    this.aborted = true;
  }
}

XPCOMUtils.defineLazyModuleGetters(this, {
  ExtensionCommon: "resource://gre/modules/ExtensionCommon.jsm",
  ExtensionParent: "resource://gre/modules/ExtensionParent.jsm",
  ExtensionUtils: "resource://gre/modules/ExtensionUtils.jsm",
});

async function promiseFileRead(nsifile) {
  let blob = await File.createFromNsIFile(nsifile);

  return new Promise((resolve, reject) => {
    let reader = new FileReader();
    reader.addEventListener("loadend", () => {
      resolve(reader.result);
    });
    reader.addEventListener("onerror", reject);

    reader.readAsArrayBuffer(blob);
  });
}

class CloudFileProvider extends ExtensionCommon.EventEmitter {
  constructor(extension) {
    super();

    this.extension = extension;
    this.accountKey = false;
    this.lastError = "";
    this.settingsURL = this.extension.manifest.cloudfile.settings_url;
    this.managementURL = this.extension.manifest.cloudfile.management_url;
    this.quota = {
      uploadSizeLimit: -1,
      spaceRemaining: -1,
      spaceUsed: -1
    };

    this._nextId = 1;
    this._abortControllers = new Map();
    this._fileUrls = new Map();
    this._fileIds = new Map();
  }

  get type() {
    return this.extension.id;
  }
  get displayName() {
    return this.extension.manifest.cloudfile.name;
  }
  get serviceURL() {
    return this.extension.manifest.cloudfile.service_url;
  }
  get iconClass() {
    let { icon } = ExtensionParent.IconDetails.getPreferredIcon(this.extension.manifest.icons, this.extension, 32);
    return this.extension.getURL(icon);
  }
  get fileUploadSizeLimit() {
    return this.quota.uploadSizeLimit;
  }
  get remainingFileSpace() {
    return this.quota.spaceRemaining;
  }
  get fileSpaceUsed() {
    return this.quota.spaceUsed;
  }
  get createNewAccountUrl() {
    return this.extension.manifest.cloudfile.new_account_url;
  }

  init(accountKey) {
    this.accountKey = accountKey;
    Preferences.set(`mail.cloud_files.accounts.${accountKey}.displayName`, this.displayName);
  }

  async uploadFile(file, callback) {
    let id = this._nextId++;
    let results;

    try {
      let buffer = await promiseFileRead(file);
      let controller = new AbortController();

      this._abortControllers.set(file.path, controller);

      results = await this.emit("uploadFile", {
        id: id,
        name: file.leafName,
        data: buffer,
        signal: controller.signal
      });
    } catch (e) {
      console.error(e);
      callback.onStopRequest(null, null, Ci.nsIMsgCloudFileProvider.uploadErr);
      return;
    } finally {
      this._abortControllers.delete(file.path);
    }

    if (results && results.length) {
      let url = results[0].url;
      this._fileUrls.set(file.path, url);
      this._fileIds.set(file.path, id);
      callback.onStopRequest(null, null, Cr.NS_OK);
    } else {
      callback.onStopRequest(null, null, Ci.nsIMsgCloudFileProvider.uploadErr);
      throw new ExtensionUtils.ExtensionError("Missing cloudfile.onUploadFile listener for " + this.extension.id);
    }
  }

  urlForFile(file) {
    return this._fileUrls.get(file.path);
  }

  cancelFileUpload(file) {
    let controller = this._abortControllers.get(file.path);
    if (controller) {
      controller.abort();
      this._abortControllers.delete(file.path);
    }
  }

  refreshUserInfo(withUI, callback) {
    if (Services.io.offline) {
      throw Ci.nsIMsgCloudFileProvider.offlineErr;
    }
    callback.onStopRequest(null, null, Cr.NS_OK);
  }

  async deleteFile(file, callback) {
    try {
      let id = this._fileIds.get(file.path);
      await this.emit("deleteFile", { id });
      callback.onStopRequest(null, null, Cr.NS_OK);
    } catch (e) {
      callback.onStopRequest(null, null, Cr.NS_ERROR_FAILURE);
    }
  }

  createNewAccount(...args) {
    throw Cr.NS_ERROR_NOT_IMPLEMENTED;
  }

  createExistingAccount(callback) {
    if (Services.io.offline) {
      throw Ci.nsIMsgCloudFileProvider.offlineErr;
    }
    // We're assuming everything is ok here. Maybe expose this in the future if there is a need
    callback.onStopRequest(null, this, Cr.NS_OK);
  }

  providerUrlForError(error) {
    return "";
  }

  overrideUrls(count, urls) {
  }

  register() {
    let uuidgen = Cc["@mozilla.org/uuid-generator;1"].getService(Ci.nsIUUIDGenerator);
    let registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
    let contractID = "@mozilla.org/mail/cloudfile;1?type=" + this.extension.id.replace(/@/g, "-");
    let self = this;

    // unregisterFactory does not clear the contract id from Components.classes, therefore re-use
    // the class id from the unregistered factory
    if (contractID in Cc) {
      this.classID = Components.ID(Cc[contractID].number);
    } else {
      this.classID = Components.ID(uuidgen.generateUUID().toString());
    }

    let factory = {
      QueryInterface: ChromeUtils.generateQI([Ci.nsIFactory]),

      createInstance: function(outer, iid) {
        if (outer !== null) {
          throw Cr.NS_ERROR_NO_AGGREGATION;
        }

        return self.QueryInterface(iid);
      },

      lockFactory: function(doLock) {
        throw Cr.NS_ERROR_NOT_IMPLEMENTED;
      }
    };
    this.factory = factory.QueryInterface(Ci.nsIFactory);

    registrar.registerFactory(
      this.classID, `Cloud file provider for ${this.extension.id}`, contractID, this.factory
    );

    XPCOMUtils.categoryManager.addCategoryEntry(
      "cloud-files", this.extension.id, contractID, false, true
    );
  }

  unregister() {
    let registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);

    registrar.unregisterFactory(this.classID, this.factory);
    XPCOMUtils.categoryManager.deleteCategoryEntry("cloud-files", this.extension.id, false);
  }
}
CloudFileProvider.prototype.QueryInterface = ChromeUtils.generateQI([Ci.nsIMsgCloudFileProvider]);


this.cloudfile = class extends ExtensionAPI {
  async onManifestEntry(entryName) {
    if (entryName == "cloudfile" && !this.provider) {
      this.provider = new CloudFileProvider(this.extension);
      this.provider.register();
    }
  }

  onShutdown() {
    if (this.provider) {
      this.provider.unregister();
    }
  }

  getAPI(context) {
    const EventManager = ExtensionCommon.EventManager;
    let self = this;

    return {
      cloudfile: {
        onUploadFile: new EventManager({
          context,
          name: "cloudfile.onUploadFile",
          register: fire => {
            let listener = (event, { id, name, data, signal }) => {
              return fire.async({ id, name, data }, signal);
            };

            self.provider.on("uploadFile", listener);
            return () => {
              self.provider.off("uploadFile", listener);
            };
          }
        }).api(),

        onDeleteFile: new EventManager({
          context,
          name: "cloudfile.onDeleteFile",
          register: fire => {
            let listener = (event, { id }) => {
              return fire.async(id);
            };

            self.provider.on("deleteFile", listener);
            return () => {
              self.provider.off("deleteFile", listener);
            };
          }
        }).api(),

        setQuota: function(quotaOptions) {
          self.provider.quota = Object.assign(self.provider.quota, quotaOptions);
        },

        getQuota: function() {
          return Promise.resolve(self.provider.quota);
        }
      }
    };
  }
};
