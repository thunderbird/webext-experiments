/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
var { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");
var { ToolbarButtonAPI } = ChromeUtils.importESModule("resource:///modules/ExtensionToolbarButtons.sys.mjs");

const calendarItemActionMap = new WeakMap();

this.calendarItemAction = class extends ToolbarButtonAPI {
  static for(extension) {
    return calendarItemActionMap.get(extension);
  }

  onStartup() {
    // TODO this is only necessary in the experiment, can drop this when moving to core.
    const calendarItemAction = this.extension.manifest?.calendar_item_action;
    if (calendarItemAction) {
      const localize = this.extension.localize.bind(this.extension);

      if (calendarItemAction.default_popup) {
        calendarItemAction.default_popup = this.extension.getURL(localize(calendarItemAction.default_popup));
      }
      if (calendarItemAction.default_label) {
        calendarItemAction.default_label = localize(calendarItemAction.default_label);
      }
      if (calendarItemAction.default_title) {
        calendarItemAction.default_title = localize(calendarItemAction.default_title);
      }

      this.onManifestEntry("calendar_item_action");
    }

    // TODO this is only necessary in the experiment, can refactor this when moving to core.
    ExtensionSupport.registerWindowListener("ext-calendar-itemAction-" + this.extension.id, {
      chromeURLs: ["chrome://calendar/content/calendar-event-dialog.xhtml"],
      onLoadWindow(win) {
        const { document } = win;

        if (!document.getElementById("mainPopupSet")) {
          const mainPopupSet = document.createElementNS("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul", "popupset");
          mainPopupSet.id = "mainPopupSet";
          const dialog = document.querySelector("dialog");
          dialog.insertBefore(mainPopupSet, dialog.firstElementChild);
        }
      }
    });
  }

  async onManifestEntry(entryName) {
    await super.onManifestEntry(entryName);
    calendarItemActionMap.set(this.extension, this);

    // Core code only works for one toolbox/toolbarId. Calendar uses different ones. When porting
    // you can leave all of this out by either using the same ids, or adapting parent class code to
    // deal with ids per window url.
    if (
      this.extension.startupReason == "ADDON_INSTALL" ||
      // NOTE: ADDON_UPGRADE is a temporary legacy-migration path for existing add-on
      // profiles. Remove this behavior is in Thunderbird core
      this.extension.startupReason == "ADDON_UPGRADE"
    ) {
      // Ensure both editor variants have the button in persisted toolbar sets
      // on fresh install and profile migrations during add-on upgrade.
      this.addToCurrentSet("chrome://messenger/content/messenger.xhtml", "event-tab-toolbar");
      this.addToCurrentSet("chrome://calendar/content/calendar-event-dialog.xhtml", "event-toolbar");
    }
  }

  addToCurrentSet(windowURL, toolbarId) {
    let currentSet = Services.xulStore.getValue(
      windowURL,
      toolbarId,
      "currentset"
    );
    if (!currentSet) {
      return;
    }
    currentSet = currentSet.split(",");
    if (currentSet.includes(this.id)) {
      return;
    }
    currentSet.push(this.id);
    Services.xulStore.setValue(
      windowURL,
      toolbarId,
      "currentset",
      currentSet.join(",")
    );
  }

  close() {
    super.close();
    calendarItemActionMap.delete(this.extension);
  }

  constructor(extension) {
    super(extension, ExtensionParent.apiManager.global);
    this.manifest_name = "calendar_item_action";
    this.manifestName = "calendarItemAction";
    this.moduleName = this.manifestName;
    this.windowURLs = [
      "chrome://messenger/content/messenger.xhtml",
      "chrome://calendar/content/calendar-event-dialog.xhtml"
    ];

    this.toolboxId = "event-toolbox";
    this.toolbarId = "event-toolbar";
  }

  // This is only necessary as part of the experiment, refactor when moving to core.
  paint(window) {
    if (window.location.href == "chrome://calendar/content/calendar-event-dialog.xhtml") {
      this.toolbarId = "event-toolbar";
    } else {
      this.toolbarId = "event-tab-toolbar";
    }
    return super.paint(window);
  }

  handleEvent(event) {
    super.handleEvent(event);
    const window = event.target.ownerGlobal;

    switch (event.type) {
      case "popupshowing": {
        const menu = event.target;
        const trigger = menu.triggerNode;
        const node = window.document.getElementById(this.id);
        const contexts = [
          "event-dialog-toolbar-context-menu",
        ];

        if (contexts.includes(menu.id) && node && node.contains(trigger)) {
          global.actionContextMenu({
            tab: window,
            pageUrl: window.browser.currentURI.spec,
            extension: this.extension,
            onComposeAction: true,
            menu,
          });
        }
        break;
      }
    }
  }

  onShutdown(isAppShutdown) {
    if (isAppShutdown) {
      return;
    }

    // TODO browserAction uses static onUninstall, this doesn't work in an experiment.
    // Do not mutate xulStore during shutdown to preserve user toolbar customizations on upgrades.
    const extensionId = this.extension.id;
    ExtensionSupport.unregisterWindowListener("ext-calendar-itemAction-" + extensionId);
  }
};

global.calendarItemActionFor = this.calendarItemAction.for;
