/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
var { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");
var { ToolbarButtonAPI } = ChromeUtils.importESModule("resource:///modules/ExtensionToolbarButtons.sys.mjs");

const calendarItemActionMap = new WeakMap();
const CALITEM_EVENT_DIALOG_URL = "chrome://calendar/content/calendar-event-dialog.xhtml";
const CALITEM_EVENT_TAB_IFRAME_URL = "chrome://calendar/content/calendar-item-iframe.xhtml";
const CALITEM_MESSENGER_URL = "chrome://messenger/content/messenger.xhtml";
const CALITEM_EDITOR_TAB_MODES = new Set(["calendarEvent", "calendarTask"]);

function getEditorContextBridgeForExtension(extension) {
  const root = `experiments-calendar-${extension.uuid}`;
  const query = extension.manifest.version;
  const module = ChromeUtils.importESModule(
    `resource://${root}/experiments/calendar/parent/ext-calendar-editor-context.sys.mjs?${query}`
  );
  return module.getEditorContextBridge(extension);
}

this.calendarItemAction = class extends ToolbarButtonAPI {
  static for(extension) {
    return calendarItemActionMap.get(extension);
  }

  onStartup() {
    // Experiment compatibility path: localized calendar_item_action manifest wiring.
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

    // Experiment compatibility path: ensure popupset exists in the editor dialog.
    ExtensionSupport.registerWindowListener("ext-calendar-itemAction-" + this.extension.id, {
      chromeURLs: ["chrome://calendar/content/calendar-event-dialog.xhtml"],
      onLoadWindow(win) {
        const { document } = win;

        if (!document.getElementById("mainPopupSet")) {
          const mainPopupSet = document.createElementNS("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul", "popupset");
          mainPopupSet.id = "mainPopupSet";
          const dialog = document.getElementsByTagName("dialog")[0] || null;
          if (!dialog) {
            console.error("[calendarItemAction] could not resolve dialog root for popupset injection");
            return;
          }
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
    if (this._editorBridge) {
      this._editorBridge.clear();
      this._editorBridge = null;
    }
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
    if (window.location.href == CALITEM_EVENT_DIALOG_URL) {
      this.toolbarId = "event-toolbar";
    } else {
      this.toolbarId = "event-tab-toolbar";
    }
    return super.paint(window);
  }

  _getDialogOuterId(window) {
    const outerId = window?.docShell?.outerWindowID ?? window?.windowUtils?.outerWindowID;
    return typeof outerId == "number" ? outerId : null;
  }

  _getEditorOuterId(window) {
    const outerId = window?.docShell?.outerWindowID ?? window?.windowUtils?.outerWindowID;
    return typeof outerId == "number" ? outerId : null;
  }

  _getEditorBridge() {
    if (!this._editorBridge) {
      this._editorBridge = getEditorContextBridgeForExtension(this.extension);
    }
    return this._editorBridge;
  }

  _ensureDialogReleaseListener(window, editorId) {
    if (!window || !editorId) {
      return;
    }

    if (!this._dialogReleaseByWindow) {
      this._dialogReleaseByWindow = new WeakMap();
    }

    const previous = this._dialogReleaseByWindow.get(window);
    if (previous?.editorId == editorId) {
      return;
    }
    if (previous?.onUnload) {
      window.removeEventListener("unload", previous.onUnload, true);
      this._getEditorBridge().releaseEditorId(previous.editorId);
    }

    const onUnload = () => {
      this._getEditorBridge().releaseEditorId(editorId);
      window.removeEventListener("unload", onUnload, true);
      this._dialogReleaseByWindow.delete(window);
    };

    window.addEventListener("unload", onUnload, true);
    this._dialogReleaseByWindow.set(window, { editorId, onUnload });
  }

  _isCalendarEditorTabInfo(tabInfo) {
    const modeName = tabInfo?.mode?.name || "";
    if (CALITEM_EDITOR_TAB_MODES.has(modeName)) {
      return true;
    }
    const editorWindow = tabInfo?.iframe?.contentWindow || tabInfo?.iframe?.contentDocument?.defaultView || null;
    const href = editorWindow?.location?.href || "";
    return href.startsWith(CALITEM_EVENT_DIALOG_URL) || href.startsWith(CALITEM_EVENT_TAB_IFRAME_URL);
  }

  _isCalendarEditorWindow(window) {
    const href = window?.location?.href || "";
    return href.startsWith(CALITEM_EVENT_DIALOG_URL) || href.startsWith(CALITEM_EVENT_TAB_IFRAME_URL);
  }

  _getSelectedTabInfo(window) {
    const tabmail = window?.tabmail || null;
    const tabInfoList = Array.isArray(tabmail?.tabInfo) ? tabmail.tabInfo : null;
    if (!tabInfoList || !tabInfoList.length) {
      return null;
    }

    const selectedIndex = tabmail?.tabContainer?.selectedIndex;
    if (Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < tabInfoList.length) {
      return tabInfoList[selectedIndex];
    }

    return tabmail.currentTabInfo || null;
  }

  _getManagedTabIdFromTabInfo(tabInfo) {
    const tabManager = this.extension?.tabManager;
    if (!tabManager || typeof tabManager.getWrapper != "function") {
      console.error("[calendarItemAction] tabManager unavailable while resolving tab id");
      return null;
    }
    if (!this._isCalendarEditorTabInfo(tabInfo)) {
      return null;
    }
    try {
      const tabWrapper = tabManager.getWrapper(tabInfo);
      const tabId = tabWrapper?.id;
      if (typeof tabId == "number") {
        return tabId;
      }
      console.error("[calendarItemAction] tabManager.getWrapper(tabInfo) returned no numeric id", {
        mode: tabInfo?.mode?.name || "",
        hasNativeTab: !!tabInfo?.nativeTab,
      });
      return null;
    } catch (e) {
      console.error("[calendarItemAction] tabManager.getWrapper(tabInfo) failed", {
        mode: tabInfo?.mode?.name || "",
        hasNativeTab: !!tabInfo?.nativeTab,
        error: String(e),
      });
      return null;
    }
  }

  _getCalendarTabInfoForEditorWindow(window) {
    if (!window || !this._isCalendarEditorWindow(window)) {
      return null;
    }
    const ownerWindow = window.ownerGlobal || null;
    if (!ownerWindow || ownerWindow.location?.href != CALITEM_MESSENGER_URL) {
      return null;
    }
    const tabInfoList = ownerWindow.tabmail && Array.isArray(ownerWindow.tabmail.tabInfo)
      ? ownerWindow.tabmail.tabInfo
      : [];
    for (const tabInfo of tabInfoList) {
      if (!this._isCalendarEditorTabInfo(tabInfo)) {
        continue;
      }
      const tabEditorWindow = tabInfo.iframe?.contentWindow || tabInfo.iframe?.contentDocument?.defaultView || null;
      if (tabEditorWindow == window) {
        return tabInfo;
      }
    }
    return null;
  }

  _getTabEditorIdFromMessengerWindow(window) {
    if (!window || window.location?.href != CALITEM_MESSENGER_URL) {
      return null;
    }
    const tabInfo = this._getSelectedTabInfo(window);
    if (!this._isCalendarEditorTabInfo(tabInfo)) {
      console.error("[calendarItemAction] current tab is not a calendar editor tab", {
        mode: tabInfo?.mode?.name || "",
        iframeHref: tabInfo?.iframe?.contentWindow?.location?.href || "",
      });
      return null;
    }
    const tabId = this._getManagedTabIdFromTabInfo(tabInfo);
    if (typeof tabId != "number") {
      console.error("[calendarItemAction] could not resolve managed tab id for calendar editor tab", {
        mode: tabInfo?.mode?.name || "",
        iframeHref: tabInfo?.iframe?.contentWindow?.location?.href || "",
        iframeId: tabInfo?.iframe?.id || "",
      });
      return null;
    }
    const editorWindow = tabInfo?.iframe?.contentWindow || tabInfo?.iframe?.contentDocument?.defaultView || null;
    const editorOuterId = this._getEditorOuterId(editorWindow);
    if (typeof editorOuterId != "number") {
      console.error("[calendarItemAction] could not resolve tab editor outer window id from messenger window", {
        tabId,
        mode: tabInfo?.mode?.name || "",
      });
      return null;
    }
    return this._getEditorBridge().registerTabTarget(tabId, editorOuterId);
  }

  _getTabEditorIdFromEditorWindow(window) {
    const tabInfo = this._getCalendarTabInfoForEditorWindow(window);
    if (!tabInfo) {
      console.error("[calendarItemAction] could not map editor window to tabInfo", {
        windowHref: window?.location?.href || "",
      });
      return null;
    }
    const tabId = this._getManagedTabIdFromTabInfo(tabInfo);
    if (typeof tabId != "number") {
      console.error("[calendarItemAction] could not resolve managed tab id from editor window", {
        mode: tabInfo?.mode?.name || "",
      });
      return null;
    }
    const editorWindow = tabInfo?.iframe?.contentWindow || tabInfo?.iframe?.contentDocument?.defaultView || null;
    const editorOuterId = this._getEditorOuterId(editorWindow);
    if (typeof editorOuterId != "number") {
      console.error("[calendarItemAction] could not resolve tab editor outer window id from editor window", {
        tabId,
        mode: tabInfo?.mode?.name || "",
      });
      return null;
    }
    return this._getEditorBridge().registerTabTarget(tabId, editorOuterId);
  }

  _getTriggerWindow(window, editorType) {
    if (!window) {
      return null;
    }
    if (editorType == "tab" && window.location?.href == CALITEM_EVENT_DIALOG_URL) {
      const ownerWindow = window.ownerGlobal || null;
      if (ownerWindow?.location?.href == CALITEM_MESSENGER_URL) {
        return ownerWindow;
      }
    }
    return window;
  }

  _getEditorClickContext(window) {
    const href = window?.location?.href || "";
    if (href == CALITEM_MESSENGER_URL) {
      const editorId = this._getTabEditorIdFromMessengerWindow(window);
      if (editorId) {
        return {
          editorType: "tab",
          editorId,
        };
      }
      return null;
    }

    if (href == CALITEM_EVENT_DIALOG_URL) {
      const tabEditorId = this._getTabEditorIdFromEditorWindow(window);
      if (tabEditorId) {
        return {
          editorType: "tab",
          editorId: tabEditorId,
        };
      }

      const dialogOuterId = this._getDialogOuterId(window);
      if (typeof dialogOuterId != "number") {
        return null;
      }
      const dialogEditorId = this._getEditorBridge().registerDialogTarget(dialogOuterId);
      if (!dialogEditorId) {
        return null;
      }
      this._ensureDialogReleaseListener(window, dialogEditorId);
      return {
        editorType: "dialog",
        editorId: dialogEditorId,
      };
    }

    return null;
  }

  handleEvent(event) {
    const window = event.target.ownerGlobal;
    if (event.type == "mousedown" && event.button == 0) {
      if (
        event.target.tagName == "menu" ||
        event.target.tagName == "menuitem" ||
        event.target.getAttribute("type") == "menu"
      ) {
        return;
      }

      const clickContext = this._getEditorClickContext(window);
      if (!clickContext) {
        console.error("[calendarItemAction] click ignored: could not resolve editor context", {
          windowHref: window?.location?.href || "",
          targetTag: event.target?.tagName || "",
        });
        return;
      }
      const triggerWindow = this._getTriggerWindow(window, clickContext.editorType);
      if (!triggerWindow) {
        console.error("[calendarItemAction] click ignored: could not resolve trigger window", {
          editorType: clickContext.editorType,
          windowHref: window?.location?.href || "",
        });
        return;
      }
      this.lastClickInfo = {
        button: 0,
        modifiers: this.global.clickModifiersFromEvent(event),
        editorType: clickContext.editorType,
        editorId: clickContext.editorId,
      };
      this.triggerAction(triggerWindow);
      return;
    }

    super.handleEvent(event);

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

    // Do not mutate xulStore during shutdown to preserve user toolbar customizations on upgrades.
    const extensionId = this.extension.id;
    ExtensionSupport.unregisterWindowListener("ext-calendar-itemAction-" + extensionId);
    if (this._editorBridge) {
      this._editorBridge.clear();
      this._editorBridge = null;
    }
  }
};

global.calendarItemActionFor = this.calendarItemAction.for;
