/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var { ExtensionCommon: { ExtensionAPI, EventManager } } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { ExtensionUtils: { ExtensionError } } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs");

var { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");
var { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");

const EVENT_DIALOG_URL = "chrome://calendar/content/calendar-event-dialog.xhtml";
const EVENT_TAB_IFRAME_URL = "chrome://calendar/content/calendar-item-iframe.xhtml";
const MESSENGER_URL = "chrome://messenger/content/messenger.xhtml";
const EVENT_PANEL_IFRAME_ID = "calendar-item-panel-iframe";
const EVENT_TITLE_FIELD_ID = "item-title";
const EVENT_LOCATION_FIELD_ID = "item-location";
const EVENT_DESCRIPTION_FIELD_ID = "item-description";
const EVENT_EDITOR_TAB_MODES = new Set(["calendarEvent", "calendarTask"]);
function getEditorContextBridgeForExtension(extension) {
  const root = `experiments-calendar-${extension.uuid}`;
  const query = extension.manifest.version;
  const module = ChromeUtils.importESModule(
    `resource://${root}/experiments/calendar/parent/ext-calendar-editor-context.sys.mjs?${query}`
  );
  return module.getEditorContextBridge(extension);
}

this.calendar_items = class extends ExtensionAPI {
  _ensureEditorClosedListenerSet() {
    if (!this._editorClosedListeners) {
      this._editorClosedListeners = new Set();
    }
    return this._editorClosedListeners;
  }

  _ensureLifecycleStateMap() {
    if (!this._editorLifecycleByTarget) {
      this._editorLifecycleByTarget = new WeakMap();
    }
    return this._editorLifecycleByTarget;
  }

  _addEditorClosedListener(listener) {
    this._ensureEditorClosedListenerSet().add(listener);
  }

  _removeEditorClosedListener(listener) {
    this._ensureEditorClosedListenerSet().delete(listener);
  }

  _emitEditorClosed(info) {
    const listeners = this._ensureEditorClosedListenerSet();
    for (const listener of listeners) {
      try {
        listener(info);
      } catch (e) {
        console.error("[calendar.items] onTrackedEditorClosed listener failed", e);
      }
    }
  }

  _getEditorBridge(extension) {
    if (!extension) {
      throw new ExtensionError("Missing extension context");
    }
    if (!this._editorBridgeByExtension) {
      this._editorBridgeByExtension = new WeakMap();
    }
    let bridge = this._editorBridgeByExtension.get(extension);
    if (!bridge) {
      bridge = getEditorContextBridgeForExtension(extension);
      this._editorBridgeByExtension.set(extension, bridge);
    }
    return bridge;
  }

  _clearEditorBridge(extension) {
    if (!extension || !this._editorBridgeByExtension) {
      return;
    }
    const bridge = this._editorBridgeByExtension.get(extension);
    if (!bridge) {
      return;
    }
    bridge.clear();
    this._editorBridgeByExtension.delete(extension);
  }

  _isCalendarEditorTabInfo(tabInfo) {
    const modeName = tabInfo?.mode?.name || "";
    if (EVENT_EDITOR_TAB_MODES.has(modeName)) {
      return true;
    }
    const editorWindow = tabInfo?.iframe?.contentWindow || tabInfo?.iframe?.contentDocument?.defaultView || null;
    const href = editorWindow?.location?.href || "";
    return href.startsWith(EVENT_DIALOG_URL) || href.startsWith(EVENT_TAB_IFRAME_URL);
  }

  _isCalendarEditorWindow(window) {
    const href = window?.location?.href || "";
    return href.startsWith(EVENT_DIALOG_URL) || href.startsWith(EVENT_TAB_IFRAME_URL);
  }

  _getCalendarTabInfoForEditorWindow(window) {
    if (!window || !this._isCalendarEditorWindow(window)) {
      return null;
    }

    const ownerWindow = window.ownerGlobal || null;
    if (!ownerWindow || ownerWindow.location?.href != MESSENGER_URL) {
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

  _getManagedTabId(context, window) {
    const manager = context?.extension?.tabManager;
    if (!manager || typeof manager.getWrapper != "function" || !window) {
      console.error("[calendar.items] managed tab id resolution failed: tabManager unavailable");
      return null;
    }

    const tabInfo = this._getCalendarTabInfoForEditorWindow(window);
    if (!tabInfo) {
      console.error("[calendar.items] managed tab id resolution failed: could not map editor window to tabInfo", {
        windowHref: window?.location?.href || "",
      });
      return null;
    }

    try {
      const wrapper = manager.getWrapper(tabInfo);
      const id = wrapper?.id;
      if (typeof id == "number") {
        return id;
      }
      console.error("[calendar.items] managed tab id resolution failed: tabManager.getWrapper(tabInfo) returned no numeric id", {
        mode: tabInfo?.mode?.name || "",
        hasNativeTab: !!tabInfo?.nativeTab,
      });
      return null;
    } catch (e) {
      console.error("[calendar.items] managed tab id resolution failed: tabManager.getWrapper(tabInfo) threw", {
        mode: tabInfo?.mode?.name || "",
        hasNativeTab: !!tabInfo?.nativeTab,
        error: String(e),
      });
      return null;
    }
  }

  _getDialogOuterId(window) {
    try {
      const windowType = window?.document?.documentElement?.getAttribute?.("windowtype") || "";
      if (windowType != "Calendar:EventDialog" && windowType != "Calendar:EventSummaryDialog") {
        return null;
      }
      const outerId = window?.docShell?.outerWindowID ?? window?.windowUtils?.outerWindowID;
      return typeof outerId == "number" ? outerId : null;
    } catch (e) {
      console.error("[calendar.items] get dialog outer id failed", e);
      return null;
    }
  }

  _getEditorOuterId(window) {
    const outerId = window?.docShell?.outerWindowID ?? window?.windowUtils?.outerWindowID;
    return typeof outerId == "number" ? outerId : null;
  }

  _getEditorIdForWindow(context, window) {
    const bridge = this._getEditorBridge(context.extension);
    const tabId = this._getManagedTabId(context, window);
    if (typeof tabId == "number") {
      const editorOuterId = this._getEditorOuterId(window);
      if (typeof editorOuterId != "number") {
        console.error("[calendar.items] editor id resolution failed: missing tab editor outer window id", { tabId });
        return "";
      }
      return bridge.registerTabTarget(tabId, editorOuterId);
    }

    const dialogOuterId = this._getDialogOuterId(window);
    if (typeof dialogOuterId == "number") {
      return bridge.registerDialogTarget(dialogOuterId);
    }

    return "";
  }

  _resolveTabEditorWindow(context, tabId, editorOuterId = 0) {
    const tabManager = context?.extension?.tabManager;
    if (!tabManager || typeof tabManager.get != "function") {
      console.error("[calendar.items] tab editor resolution failed: tabManager unavailable", { tabId });
      return null;
    }

    let tabWrapper = null;
    try {
      tabWrapper = tabManager.get(tabId);
    } catch (_e) {
      console.error("[calendar.items] tab editor resolution failed: tab id not found", { tabId });
      return null;
    }

    const tabInfo = tabWrapper?.nativeTab || null;
    if (!this._isCalendarEditorTabInfo(tabInfo)) {
      console.error("[calendar.items] tab editor resolution failed: tab wrapper nativeTab is not a calendar editor tab", { tabId });
      return null;
    }

    const win = tabInfo.iframe?.contentWindow || tabInfo.iframe?.contentDocument?.defaultView || null;
    if (!win || win.closed || !this._isCalendarEditorWindow(win)) {
      console.error("[calendar.items] tab editor resolution failed: iframe window unavailable or unexpected URL", {
        tabId,
        href: win?.location?.href || "",
      });
      return null;
    }

    if (Number.isInteger(editorOuterId) && editorOuterId > 0) {
      const currentOuterId = this._getEditorOuterId(win);
      if (currentOuterId != editorOuterId) {
        console.error("[calendar.items] tab editor resolution failed: stale tab editor instance", {
          tabId,
          expectedOuterId: editorOuterId,
          currentOuterId: currentOuterId ?? null,
        });
        return null;
      }
    }

    return win;
  }

  _resolveEditorWindow(context, editorId) {
    const bridge = this._getEditorBridge(context.extension);
    const normalizedEditorId = bridge.normalizeEditorId(editorId);
    if (!normalizedEditorId) {
      console.error("[calendar.items] editor resolution failed: invalid editorId format");
      return null;
    }
    const target = bridge.resolveTarget(normalizedEditorId);
    if (!target) {
      console.error("[calendar.items] editor resolution failed: unknown editorId", { editorId: normalizedEditorId });
      return null;
    }

    if (target.kind == "dialog") {
      if (!Services?.wm?.getOuterWindowWithId) {
        console.error("[calendar.items] dialog editor resolution failed: Services.wm.getOuterWindowWithId unavailable", { editorId: normalizedEditorId });
        bridge.releaseEditorId(normalizedEditorId);
        return null;
      }
      try {
        const win = Services.wm.getOuterWindowWithId(target.id);
        if (win && !win.closed && win.location?.href?.startsWith(EVENT_DIALOG_URL)) {
          return win;
        }
      } catch (_e) {
        console.error("[calendar.items] dialog editor resolution failed: getOuterWindowWithId threw", {
          editorId: normalizedEditorId,
          dialogOuterId: target.id,
        });
        bridge.releaseEditorId(normalizedEditorId);
        return null;
      }
      console.error("[calendar.items] dialog editor resolution failed: window unavailable or unexpected URL", {
        editorId: normalizedEditorId,
        dialogOuterId: target.id,
      });
      bridge.releaseEditorId(normalizedEditorId);
      return null;
    }

    if (target.kind == "tab") {
      const win = this._resolveTabEditorWindow(context, target.id, target.instanceId);
      if (win) {
        return win;
      }
      console.error("[calendar.items] tab editor resolution failed", {
        editorId: normalizedEditorId,
        tabId: target.id,
        editorOuterId: target.instanceId ?? null,
      });
      bridge.releaseEditorId(normalizedEditorId);
      return null;
    }

    console.error("[calendar.items] editor resolution failed: unsupported target kind", {
      editorId: normalizedEditorId,
      kind: target.kind,
    });
    bridge.releaseEditorId(normalizedEditorId);
    return null;
  }

  _getEditedItemForWindow(window) {
    if (!window || !window.location) {
      return null;
    }

    if (this._isCalendarEditorWindow(window)) {
      const fromWindow = win => {
        if (!win) {
          return null;
        }
        if (win.calendarItem) {
          return win.calendarItem;
        }
        if (win.gEvent?.event) {
          return win.gEvent.event;
        }
        const arg0 = Array.isArray(win.arguments) ? win.arguments[0] : null;
        if (arg0?.calendarItem) {
          return arg0.calendarItem;
        }
        if (arg0?.calendarEvent) {
          return arg0.calendarEvent;
        }
        return null;
      };

      const direct = fromWindow(window);
      if (direct) {
        return direct;
      }

      const panelIframe = window.document?.getElementById?.(EVENT_PANEL_IFRAME_ID) || null;
      const panelWin = panelIframe?.contentWindow || panelIframe?.contentDocument?.defaultView || null;
      return fromWindow(panelWin);
    }

    return null;
  }

  _cleanupLifecycleState(target) {
    if (!target) {
      return;
    }

    const stateMap = this._ensureLifecycleStateMap();
    const state = stateMap.get(target);
    if (!state) {
      return;
    }
    stateMap.delete(target);
    if (state.editorId && state.extension) {
      this._getEditorBridge(state.extension).releaseEditorId(state.editorId);
    }

    const cleanup = Array.isArray(state.cleanup) ? state.cleanup : [];
    while (cleanup.length) {
      const fn = cleanup.pop();
      try {
        fn();
      } catch (e) {
        console.error("[calendar.items] cleanup lifecycle state failed", e);
      }
    }
  }

  _cleanupLifecycleInWindow(window) {
    if (!window || !window.location) {
      return;
    }

    if (window.location.href.startsWith(EVENT_DIALOG_URL)) {
      this._cleanupLifecycleState(window);
      return;
    }

    if (!window.location.href.startsWith(MESSENGER_URL)) {
      return;
    }

    const tabmail = window.tabmail;
    const tabInfoList = tabmail && Array.isArray(tabmail.tabInfo) ? tabmail.tabInfo : [];
    for (const tabInfo of tabInfoList) {
      if (!this._isCalendarEditorTabInfo(tabInfo)) {
        continue;
      }
      const target = tabInfo.iframe?.contentWindow || tabInfo.iframe?.contentDocument?.defaultView || null;
      this._cleanupLifecycleState(target);
    }
  }

  _ensureLifecycleWatch(context, window, editorId = "") {
    const target = window && this._isCalendarEditorWindow(window) ? window : null;
    if (!target) {
      return;
    }

    const stateMap = this._ensureLifecycleStateMap();
    const bridge = this._getEditorBridge(context.extension);
    const normalizedEditorId = bridge.normalizeEditorId(editorId);
    const nextEditorId = normalizedEditorId || this._getEditorIdForWindow(context, target);
    if (!nextEditorId) {
      return;
    }
    const nextEditorKey = nextEditorId;
    if (!nextEditorKey) {
      return;
    }
    const previous = stateMap.get(target);
    if (previous) {
      if (previous.editorKey == nextEditorKey) {
        return;
      }
      this._emitEditorClosed({
        editorId: previous.editorId || "",
        action: "superseded",
        reason: "re-bound"
      });
      this._cleanupLifecycleState(target);
    }

    const state = {
      extension: context.extension,
      editorId: nextEditorId,
      editorKey: nextEditorKey,
      cleanup: [],
      closed: false
    };
    stateMap.set(target, state);

    const emitOnce = (action, reason) => {
      if (state.closed) {
        return;
      }
      state.closed = true;
      const info = {
        editorId: state.editorId || "",
        action,
      };
      if (reason) {
        info.reason = reason;
      }
      this._emitEditorClosed(info);
      this._cleanupLifecycleState(target);
    };

    const addListener = (type, handler, options) => {
      target.addEventListener(type, handler, options);
      state.cleanup.push(() => {
        target.removeEventListener(type, handler, options);
      });
    };

    const isDialog = !!(target.location?.href || "").startsWith(EVENT_DIALOG_URL);
    if (isDialog) {
      addListener("dialogaccept", () => emitOnce("persisted", "dialogaccept"), true);
      addListener("dialogextra1", () => emitOnce("persisted", "dialogextra1"), true);
      addListener("dialogcancel", () => emitOnce("discarded", "dialogcancel"), true);
      addListener("dialogextra2", () => emitOnce("discarded", "dialogextra2"), true);
    }

    addListener("unload", () => emitOnce("discarded", "unload"), true);
  }

  _assertEditorWindowOpen(window, operation) {
    if (!window || window.closed) {
      console.error("[calendar.items] editor window closed", { operation: operation || "" });
      throw new ExtensionError(`Editor window closed during ${operation}`);
    }
  }

  _getMainEditorDocument(window) {
    const doc = window?.document || null;
    if (!doc) {
      throw new ExtensionError("Could not resolve editor document");
    }
    return doc;
  }

  _getPanelEditorDocument(window) {
    const mainDoc = this._getMainEditorDocument(window);
    const panelIframe = mainDoc.getElementById(EVENT_PANEL_IFRAME_ID);
    return panelIframe?.contentDocument || null;
  }

  _getEditorDocuments(window) {
    const docs = [];
    const mainDoc = this._getMainEditorDocument(window);
    docs.push(mainDoc);
    const panelDoc = this._getPanelEditorDocument(window);
    if (panelDoc) {
      docs.push(panelDoc);
    }
    return docs;
  }

  _resolveValueFieldById(window, elementId, label) {
    const docs = this._getEditorDocuments(window);
    for (const doc of docs) {
      const field = doc.getElementById(elementId);
      if (field && ("value" in field)) {
        return {
          kind: "value",
          element: field,
        };
      }
    }
    console.error("[calendar.items] field resolution failed", { field: label, elementId });
    throw new ExtensionError(`Could not resolve writable ${label} field`);
  }

  _resolveTitleField(window) {
    return this._resolveValueFieldById(window, EVENT_TITLE_FIELD_ID, "title");
  }

  _resolveLocationField(window) {
    return this._resolveValueFieldById(window, EVENT_LOCATION_FIELD_ID, "location");
  }

  _resolveDescriptionField(window) {
    const docs = this._getEditorDocuments(window);
    for (const doc of docs) {
      const host = doc.getElementById(EVENT_DESCRIPTION_FIELD_ID);
      const inputField = host?.inputField || null;
      if (inputField && ("value" in inputField)) {
        return {
          kind: "value",
          element: inputField,
        };
      }

      if (host && ("value" in host)) {
        return {
          kind: "value",
          element: host,
        };
      }

      const htmlBody = host?.contentDocument?.body || null;
      if (htmlBody) {
        return {
          kind: "html-body",
          element: htmlBody,
        };
      }
    }
    console.error("[calendar.items] field resolution failed", { field: "description", elementId: EVENT_DESCRIPTION_FIELD_ID });
    throw new ExtensionError("Could not resolve writable description field");
  }

  _dispatchInputEvent(element) {
    if (!element) {
      return;
    }
    const doc = element.ownerDocument || element.document;
    const win = doc?.defaultView;
    if (win) {
      element.dispatchEvent(new win.Event("input", { bubbles: true }));
    }
  }

  _setFieldValue(target, value) {
    const element = target?.element || null;
    if (!element) {
      console.error("[calendar.items] field update failed: missing resolved field target");
      throw new ExtensionError("Resolved editor field is not writable");
    }

    if (target.kind == "value") {
      if (!("value" in element)) {
        console.error("[calendar.items] field update failed: resolved value target has no value property");
        throw new ExtensionError("Resolved editor field is not writable");
      }

      element.focus?.();
      element.value = value;
      this._dispatchInputEvent(element);
      return;
    }

    if (target.kind == "html-body") {
      const doc = element.ownerDocument || null;
      if (!doc || typeof doc.execCommand != "function") {
        console.error("[calendar.items] description update failed: execCommand unavailable on html-body editor");
        throw new ExtensionError("Could not write description field");
      }
      element.focus?.();
      doc.execCommand("selectAll", false, null);
      const insertOk = doc.execCommand("insertText", false, value);
      const normalizedValue = String(value ?? "");
      const currentValue = String(element.textContent ?? "");
      if (!insertOk && currentValue != normalizedValue) {
        console.error("[calendar.items] description update failed: execCommand returned false");
        throw new ExtensionError("Could not write description field");
      }
      this._dispatchInputEvent(element);
      return;
    }

    console.error("[calendar.items] field update failed: unknown resolved field target kind", {
      kind: target.kind,
    });
    throw new ExtensionError("Resolved editor field is not writable");
  }

  _snapshotResolvedFieldValues(targets) {
    const readValue = target => {
      if (!target || !target.element) {
        return null;
      }
      if (target.kind == "value") {
        return String(target.element.value ?? "");
      }
      if (target.kind == "html-body") {
        return String(target.element.textContent ?? "");
      }
      console.error("[calendar.items] field snapshot failed: unknown resolved field target kind", {
        kind: target.kind,
      });
      throw new ExtensionError("Resolved editor field is not readable");
    };

    return {
      title: readValue(targets.title),
      location: readValue(targets.location),
      description: readValue(targets.description),
    };
  }

  _rollbackFieldUpdates(window, targets, beforeValues, applied) {
    if (!window || window.closed) {
      console.error("[calendar.items] rollback skipped because editor window closed");
      return;
    }

    const rollbackOrder = ["description", "location", "title"];
    for (const key of rollbackOrder) {
      if (!applied[key] || !targets[key]) {
        continue;
      }
      this._setFieldValue(targets[key], beforeValues[key] ?? "");
    }
  }

  _resolveRequestedFieldTargets(window, fields) {
    this._assertEditorWindowOpen(window, "field target resolution");
    const targets = {};

    if (typeof fields.title == "string") {
      targets.title = this._resolveTitleField(window);
    }

    if (typeof fields.location == "string") {
      targets.location = this._resolveLocationField(window);
    }

    if (typeof fields.description == "string") {
      targets.description = this._resolveDescriptionField(window);
    }

    return targets;
  }

  _applyFieldUpdates(window, fields, state = null) {
    this._assertEditorWindowOpen(window, "field updates");
    const targets = state?.targets || this._resolveRequestedFieldTargets(window, fields);
    const beforeValues = state?.beforeValues || this._snapshotResolvedFieldValues(targets);

    const applied = {
      title: false,
      location: false,
      description: false
    };

    try {
      if (typeof fields.title == "string") {
        this._assertEditorWindowOpen(window, "title update");
        this._setFieldValue(targets.title, fields.title);
        applied.title = true;
      }
      if (typeof fields.location == "string") {
        this._assertEditorWindowOpen(window, "location update");
        this._setFieldValue(targets.location, fields.location);
        applied.location = true;
      }
      if (typeof fields.description == "string") {
        this._assertEditorWindowOpen(window, "description update");
        this._setFieldValue(targets.description, fields.description);
        applied.description = true;
      }
    } catch (e) {
      try {
        this._rollbackFieldUpdates(window, targets, beforeValues, applied);
      } catch (rollbackError) {
        console.error("[calendar.items] rollback failed", rollbackError);
      }
      throw e;
    }

    return applied;
  }

  _validatePropertyUpdates(properties) {
    for (const name of Object.keys(properties || {})) {
      if (!name || typeof name != "string") {
        throw new ExtensionError("Property names must be non-empty strings");
      }
    }
  }

  _snapshotPropertyValues(item, properties) {
    this._validatePropertyUpdates(properties);
    const snapshot = {};
    for (const name of Object.keys(properties || {})) {
      try {
        const current = item.getProperty(name);
        snapshot[name] = current == null ? null : String(current);
      } catch (e) {
        console.error("[calendar.items] property snapshot failed", { property: name, error: String(e) });
        throw new ExtensionError(`Could not snapshot property ${name}`);
      }
    }
    return snapshot;
  }

  _applyPropertyUpdates(item, properties) {
    this._validatePropertyUpdates(properties);
    const appliedNames = [];
    for (const [name, value] of Object.entries(properties || {})) {
      try {
        if (value == null) {
          if (typeof item.deleteProperty == "function") {
            item.deleteProperty(name);
          } else {
            item.setProperty(name, "");
          }
        } else {
          item.setProperty(name, String(value));
        }
        appliedNames.push(name);
      } catch (e) {
        console.error("[calendar.items] property update failed", { property: name, error: String(e) });
        throw new ExtensionError(`Could not update property ${name}`);
      }
    }
    return appliedNames;
  }

  _rollbackPropertyUpdates(item, snapshot, appliedNames) {
    const names = Array.isArray(appliedNames) ? appliedNames : [];
    for (let i = names.length - 1; i >= 0; i--) {
      const name = names[i];
      const previous = Object.prototype.hasOwnProperty.call(snapshot, name) ? snapshot[name] : null;
      try {
        if (previous == null) {
          if (typeof item.deleteProperty == "function") {
            item.deleteProperty(name);
          } else {
            item.setProperty(name, "");
          }
        } else {
          item.setProperty(name, String(previous));
        }
      } catch (e) {
        console.error("[calendar.items] property rollback failed", { property: name, error: String(e) });
        throw new ExtensionError(`Could not rollback property ${name}`);
      }
    }
  }

  onShutdown() {
    for (const window of ExtensionSupport.openWindows) {
      try {
        this._cleanupLifecycleInWindow(window);
      } catch (e) {
        console.error("[calendar.items] shutdown cleanup failed", e);
      }
    }

    if (this._editorClosedListeners) {
      this._editorClosedListeners.clear();
    }

    this._clearEditorBridge(this.extension);
  }

  getAPI(context) {
    const api = this;
    const uuid = context.extension.uuid;
    const root = `experiments-calendar-${uuid}`;
    const query = context.extension.manifest.version;
    const {
      getResolvedCalendarById,
      getCachedCalendar,
      isCachedCalendar,
      isOwnCalendar,
      propsToItem,
      convertItem,
      convertAlarm,
    } = ChromeUtils.importESModule(
      `resource://${root}/experiments/calendar/ext-calendar-utils.sys.mjs?${query}`
    );

    return {
      calendar: {
        items: {
          async query(queryProps) {
            let calendars = [];
            if (typeof queryProps.calendarId == "string") {
              calendars = [getResolvedCalendarById(context.extension, queryProps.calendarId)];
            } else if (Array.isArray(queryProps.calendarId)) {
              calendars = queryProps.calendarId.map(calendarId => getResolvedCalendarById(context.extension, calendarId));
            } else {
              calendars = cal.manager.getCalendars().filter(calendar => !calendar.getProperty("disabled"));
            }


            let calendarItems;
            if (queryProps.id) {
              calendarItems = await Promise.all(calendars.map(calendar => calendar.getItem(queryProps.id)));
            } else {
              calendarItems = await Promise.all(calendars.map(async calendar => {
                let filter = Ci.calICalendar.ITEM_FILTER_COMPLETED_ALL;
                if (queryProps.type == "event") {
                  filter |= Ci.calICalendar.ITEM_FILTER_TYPE_EVENT;
                } else if (queryProps.type == "task") {
                  filter |= Ci.calICalendar.ITEM_FILTER_TYPE_TODO;
                } else {
                  filter |= Ci.calICalendar.ITEM_FILTER_TYPE_ALL;
                }

                if (queryProps.expand) {
                  filter |= Ci.calICalendar.ITEM_FILTER_CLASS_OCCURRENCES;
                }

                const rangeStart = queryProps.rangeStart ? cal.createDateTime(queryProps.rangeStart) : null;
                const rangeEnd = queryProps.rangeEnd ? cal.createDateTime(queryProps.rangeEnd) : null;

                return calendar.getItemsAsArray(filter, queryProps.limit ?? 0, rangeStart, rangeEnd);
              }));
            }

            return calendarItems.flat().map(item => convertItem(item, queryProps, context.extension));
          },
          async get(calendarId, id, options) {
            const calendar = getResolvedCalendarById(context.extension, calendarId);
            const item = await calendar.getItem(id);
            return convertItem(item, options, context.extension);
          },
          async create(calendarId, createProperties) {
            const calendar = getResolvedCalendarById(context.extension, calendarId);
            const item = propsToItem(createProperties);
            item.calendar = calendar.superCalendar;

            if (createProperties.metadata && isOwnCalendar(calendar, context.extension)) {
              const cache = getCachedCalendar(calendar);
              cache.setMetaData(item.id, JSON.stringify(createProperties.metadata));
            }

            let createdItem;
            if (isCachedCalendar(calendarId)) {
              createdItem = await calendar.modifyItem(item, null);
            } else {
              createdItem = await calendar.adoptItem(item);
            }

            return convertItem(createdItem, createProperties, context.extension);
          },
          async update(calendarId, id, updateProperties) {
            const calendar = getResolvedCalendarById(context.extension, calendarId);

            const oldItem = await calendar.getItem(id);
            if (!oldItem) {
              throw new ExtensionError("Could not find item " + id);
            }
            if (oldItem.isEvent()) {
              updateProperties.type = "event";
            } else if (oldItem.isTodo()) {
              updateProperties.type = "task";
            } else {
              throw new ExtensionError(`Encountered unknown item type for ${calendarId}/${id}`);
            }

            const newItem = propsToItem(updateProperties);
            newItem.calendar = calendar.superCalendar;

            if (updateProperties.metadata && isOwnCalendar(calendar, context.extension)) {
              // Metadata updates replace the cached payload for deterministic behavior.
              const cache = getCachedCalendar(calendar);
              cache.setMetaData(newItem.id, JSON.stringify(updateProperties.metadata));
            }

            const modifiedItem = await calendar.modifyItem(newItem, oldItem);
            return convertItem(modifiedItem, updateProperties, context.extension);
          },
          async move(fromCalendarId, id, toCalendarId) {
            if (fromCalendarId == toCalendarId) {
              return;
            }

            const fromCalendar = cal.manager.getCalendarById(fromCalendarId);
            const toCalendar = cal.manager.getCalendarById(toCalendarId);
            const item = await fromCalendar.getItem(id);

            if (!item) {
              throw new ExtensionError("Could not find item " + id);
            }

            if (isOwnCalendar(toCalendar, context.extension) && isOwnCalendar(fromCalendar, context.extension)) {
              // Copy metadata before addItem so onCreated listeners can read it immediately.
              const fromCache = getCachedCalendar(fromCalendar);
              const toCache = getCachedCalendar(toCalendar);
              toCache.setMetaData(item.id, fromCache.getMetaData(item.id));
            }
            await toCalendar.addItem(item);
            await fromCalendar.deleteItem(item);
          },
          async remove(calendarId, id) {
            const calendar = getResolvedCalendarById(context.extension, calendarId);

            const item = await calendar.getItem(id);
            if (!item) {
              throw new ExtensionError("Could not find item " + id);
            }
            await calendar.deleteItem(item);
          },

          async getCurrent(options) {
            const editorId = api._getEditorBridge(context.extension).normalizeEditorId(options?.editorId);
            if (!editorId) {
              console.error("[calendar.items] getCurrent failed: invalid editorId");
              throw new ExtensionError("editorId must be a non-empty opaque editor identifier");
            }

            let win = api._resolveEditorWindow(context, editorId);
            if (!win) {
              console.error("[calendar.items] getCurrent: editor window could not be resolved", { editorId });
              return null;
            }
            let item = api._getEditedItemForWindow(win);
            if (!item) {
              console.error("[calendar.items] getCurrent: no editable item found in resolved editor window", { editorId });
              return null;
            }
            api._ensureLifecycleWatch(context, win, editorId);
            const converted = convertItem(item, options, context.extension);
            if (converted) {
              converted.editorId = editorId;
            }
            return converted;
          },

          async updateCurrent(updateOptions) {
            const editorId = api._getEditorBridge(context.extension).normalizeEditorId(updateOptions?.editorId);
            if (!editorId) {
              console.error("[calendar.items] updateCurrent failed: invalid editorId");
              throw new ExtensionError("editorId must be a non-empty opaque editor identifier");
            }

            let win = api._resolveEditorWindow(context, editorId);
            if (!win) {
              console.error("[calendar.items] updateCurrent failed: editor window could not be resolved", { editorId });
              throw new ExtensionError("Could not resolve target editor window");
            }
            let item = api._getEditedItemForWindow(win);
            if (!item) {
              console.error("[calendar.items] updateCurrent failed: no editable item found in resolved editor window", { editorId });
              throw new ExtensionError("Could not find current editor item");
            }
            api._ensureLifecycleWatch(context, win, editorId);

            const fields = updateOptions?.fields && typeof updateOptions.fields == "object" ? updateOptions.fields : {};
            const properties = updateOptions?.properties && typeof updateOptions.properties == "object" ? updateOptions.properties : {};
            if (!Object.keys(fields).length && !Object.keys(properties).length) {
              console.error("[calendar.items] updateCurrent failed: neither fields nor properties provided", { editorId });
              throw new ExtensionError("updateCurrent requires at least one field or property update");
            }

            const fieldTargets = api._resolveRequestedFieldTargets(win, fields);
            const fieldBeforeValues = api._snapshotResolvedFieldValues(fieldTargets);
            let fieldApplied = {
              title: false,
              location: false,
              description: false
            };
            api._assertEditorWindowOpen(win, "field updates");
            fieldApplied = api._applyFieldUpdates(win, fields, {
              targets: fieldTargets,
              beforeValues: fieldBeforeValues,
            });

            api._assertEditorWindowOpen(win, "property updates");
            const propertySnapshot = api._snapshotPropertyValues(item, properties);
            let appliedProperties = [];
            try {
              appliedProperties = api._applyPropertyUpdates(item, properties);
            } catch (propertyError) {
              try {
                api._rollbackPropertyUpdates(item, propertySnapshot, appliedProperties);
              } catch (propertyRollbackError) {
                console.error("[calendar.items] property rollback failed", propertyRollbackError);
              }
              try {
                api._rollbackFieldUpdates(win, fieldTargets, fieldBeforeValues, fieldApplied);
              } catch (fieldRollbackError) {
                console.error("[calendar.items] field rollback after property failure failed", fieldRollbackError);
              }
              throw propertyError;
            }

            const converted = convertItem(item, updateOptions, context.extension);
            if (converted) {
              converted.editorId = editorId;
            }
            return converted;
          },

          onCreated: new EventManager({
            context,
            name: "calendar.items.onCreated",
            register: (fire, options) => {
              const observer = cal.createAdapter(Ci.calIObserver, {
                onAddItem: item => {
                  fire.sync(convertItem(item, options, context.extension));
                },
              });

              cal.manager.addCalendarObserver(observer);
              return () => {
                cal.manager.removeCalendarObserver(observer);
              };
            },
          }).api(),

          onUpdated: new EventManager({
            context,
            name: "calendar.items.onUpdated",
            register: (fire, options) => {
              const observer = cal.createAdapter(Ci.calIObserver, {
                onModifyItem: (newItem, _oldItem) => {
                  // changeInfo currently signals a full item replacement.
                  const changeInfo = { changeType: "full" };
                  fire.sync(convertItem(newItem, options, context.extension), changeInfo);
                },
              });

              cal.manager.addCalendarObserver(observer);
              return () => {
                cal.manager.removeCalendarObserver(observer);
              };
            },
          }).api(),

          onRemoved: new EventManager({
            context,
            name: "calendar.items.onRemoved",
            register: fire => {
              const observer = cal.createAdapter(Ci.calIObserver, {
                onDeleteItem: item => {
                  fire.sync(item.calendar.id, item.id);
                },
              });

              cal.manager.addCalendarObserver(observer);
              return () => {
                cal.manager.removeCalendarObserver(observer);
              };
            },
          }).api(),

          onAlarm: new EventManager({
            context,
            name: "calendar.items.onAlarm",
            register: (fire, options) => {
              const observer = {
                QueryInterface: ChromeUtils.generateQI(["calIAlarmServiceObserver"]),
                onAlarm(item, alarm) {
                  fire.sync(convertItem(item, options, context.extension), convertAlarm(item, alarm));
                },
                onRemoveAlarmsByItem(_item) {},
                onRemoveAlarmsByCalendar(_calendar) {},
                onAlarmsLoaded(_calendar) {},
              };

              const alarmsvc = Cc["@mozilla.org/calendar/alarm-service;1"].getService(
                Ci.calIAlarmService
              );

              alarmsvc.addObserver(observer);
              return () => {
                alarmsvc.removeObserver(observer);
              };
            },
          }).api(),

          onTrackedEditorClosed: new EventManager({
            context,
            name: "calendar.items.onTrackedEditorClosed",
            register: fire => {
              const listener = info => {
                fire.sync(info);
              };
              api._addEditorClosedListener(listener);
              return () => {
                api._removeEditorClosedListener(listener);
              };
            },
          }).api(),
        },
      },
    };
  }
};
