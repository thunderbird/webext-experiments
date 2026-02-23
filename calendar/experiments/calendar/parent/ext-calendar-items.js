/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var { ExtensionCommon: { ExtensionAPI, EventManager } } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { ExtensionUtils: { ExtensionError } } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs");

var { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");
var { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");

const EVENT_DIALOG_URL = "chrome://calendar/content/calendar-event-dialog.xhtml";
const MESSENGER_URL = "chrome://messenger/content/messenger.xhtml";

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
        console.error("[calendar.items] onEditorClosed listener failed", e);
      }
    }
  }

  _makeEditorKey(editorRef) {
    const ref = editorRef && typeof editorRef == "object" ? editorRef : {};
    if (typeof ref.dialogOuterId == "number") {
      return `dialog:${ref.dialogOuterId}`;
    }
    if (typeof ref.tabId == "number") {
      return `tab:${ref.tabId}`;
    }
    if (typeof ref.windowId == "number") {
      return `window:${ref.windowId}`;
    }
    return "";
  }

  _isWindowManagerType(windowType) {
    switch (windowType) {
      case "mail:3pane":
      case "msgcompose":
      case "mail:messageWindow":
      case "mail:extensionPopup":
        return true;
      default:
        return false;
    }
  }

  _getManagedWindowId(context, window) {
    try {
      const manager = context?.extension?.windowManager;
      if (!manager || typeof manager.getWrapper != "function") {
        return null;
      }
      const windowType = window?.document?.documentElement?.getAttribute?.("windowtype") || "";
      if (!this._isWindowManagerType(windowType)) {
        return null;
      }
      const wrapper = manager.getWrapper(window);
      const id = wrapper?.id;
      return typeof id == "number" ? id : null;
    } catch (e) {
      console.error("[calendar.items] get managed window id failed", e);
      return null;
    }
  }

  _getManagedTabId(context, window) {
    try {
      if (!window || window.location?.href != MESSENGER_URL) {
        return null;
      }
      const nativeTab = window.tabmail?.currentTabInfo?.nativeTab || null;
      if (!nativeTab) {
        return null;
      }
      const manager = context?.extension?.tabManager;
      if (!manager || typeof manager.getWrapper != "function") {
        return null;
      }
      const wrapper = manager.getWrapper(nativeTab);
      const id = wrapper?.id;
      return typeof id == "number" ? id : null;
    } catch (e) {
      console.error("[calendar.items] get managed tab id failed", e);
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

  _buildEditorRef(context, window) {
    const editorRef = {};

    const tabId = this._getManagedTabId(context, window);
    if (typeof tabId == "number") {
      editorRef.tabId = tabId;
    }

    const windowId = this._getManagedWindowId(context, window);
    if (typeof windowId == "number") {
      editorRef.windowId = windowId;
    }

    const dialogOuterId = this._getDialogOuterId(window);
    if (typeof dialogOuterId == "number") {
      editorRef.dialogOuterId = dialogOuterId;
    }

    return Object.keys(editorRef).length ? editorRef : null;
  }

  _resolveEditorWindow(context, editorRef) {
    const ref = editorRef && typeof editorRef == "object" ? editorRef : {};

    if (typeof ref.dialogOuterId == "number") {
      if (!Services?.wm?.getOuterWindowWithId) {
        // continue with other ids
      } else {
        try {
          const win = Services.wm.getOuterWindowWithId(ref.dialogOuterId);
          if (win && !win.closed) {
            return win;
          }
        } catch (e) {
          console.error("[calendar.items] resolve dialog window failed", e);
        }
      }
    }

    if (typeof ref.tabId == "number") {
      const tabManager = context?.extension?.tabManager;
      if (tabManager && typeof tabManager.get == "function") {
        try {
          const tabWrapper = tabManager.get(ref.tabId);
          const nativeTab = tabWrapper?.nativeTab || null;
          const win = nativeTab?.ownerGlobal || null;
          if (win && !win.closed) {
            return win;
          }
        } catch (e) {
          console.error("[calendar.items] resolve tab id failed", e);
        }
      }
    }

    if (typeof ref.windowId == "number") {
      const manager = context?.extension?.windowManager;
      if (manager && typeof manager.get == "function") {
        try {
          const winObj = manager.get(ref.windowId);
          const win = winObj?.window || null;
          if (win && !win.closed) {
            return win;
          }
        } catch (e) {
          console.error("[calendar.items] resolve window id failed", e);
        }
      }
    }

    return null;
  }

  _resolveSnapshotWindow(context, editorRef) {
    const resolved = this._resolveEditorWindow(context, editorRef);
    if (resolved) {
      return resolved;
    }

    try {
      const browsingContextWindow = context?.browsingContext?.embedderElement?.ownerGlobal || null;
      if (browsingContextWindow && !browsingContextWindow.closed) {
        return browsingContextWindow;
      }
    } catch (e) {
      console.error("[calendar.items] resolve browsing context window failed", e);
    }
    return null;
  }

  _getEditedItemForWindow(window) {
    if (!window || !window.location) {
      return null;
    }

    if (window.location.href.startsWith(EVENT_DIALOG_URL)) {
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

      const panelIframe = window.document?.getElementById?.("calendar-item-panel-iframe") || null;
      const panelWin = panelIframe?.contentWindow || panelIframe?.contentDocument?.defaultView || null;
      return fromWindow(panelWin);
    }

    if (window.location.href.startsWith(MESSENGER_URL)) {
      const tabInfo = window.tabmail?.currentTabInfo || null;
      if (tabInfo?.mode?.name != "calendarEvent") {
        return null;
      }
      return tabInfo.iframe?.contentWindow?.calendarItem || null;
    }

    return null;
  }

  _getLifecycleTargetWindow(window) {
    if (!window || !window.location) {
      return null;
    }
    if (window.location.href.startsWith(EVENT_DIALOG_URL)) {
      return window;
    }
    if (window.location.href.startsWith(MESSENGER_URL)) {
      const tabInfo = window.tabmail?.currentTabInfo || null;
      if (tabInfo?.mode?.name != "calendarEvent") {
        return null;
      }
      return tabInfo.iframe?.contentWindow || tabInfo.iframe?.contentDocument?.defaultView || null;
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
      if (tabInfo?.mode?.name != "calendarEvent") {
        continue;
      }
      const target = tabInfo.iframe?.contentWindow || tabInfo.iframe?.contentDocument?.defaultView || null;
      this._cleanupLifecycleState(target);
    }
  }

  _ensureLifecycleWatch(context, window) {
    const target = this._getLifecycleTargetWindow(window);
    if (!target) {
      return;
    }

    const stateMap = this._ensureLifecycleStateMap();
    const nextEditorRef = this._buildEditorRef(context, window);
    const nextEditorKey = this._makeEditorKey(nextEditorRef);
    const previous = stateMap.get(target);
    if (previous) {
      if (previous.editorKey == nextEditorKey) {
        return;
      }
      this._emitEditorClosed({
        editorRef: previous.editorRef || {},
        action: "superseded",
        reason: "re-bound"
      });
      this._cleanupLifecycleState(target);
    }

    const state = {
      editorRef: nextEditorRef || {},
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
      this._emitEditorClosed({
        editorRef: state.editorRef || {},
        action,
        reason: reason || ""
      });
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

  _collectEventDocs(window) {
    const docs = [];
    const pushDoc = doc => {
      if (!doc || docs.includes(doc)) {
        return;
      }
      docs.push(doc);
    };

    pushDoc(window?.document || null);

    if (window?.location?.href?.startsWith(EVENT_DIALOG_URL)) {
      const iframe = window.document?.getElementById?.("calendar-item-panel-iframe") || null;
      pushDoc(iframe?.contentDocument || null);
    }

    if (window?.location?.href?.startsWith(MESSENGER_URL)) {
      const tabInfo = window.tabmail?.currentTabInfo || null;
      if (tabInfo?.mode?.name == "calendarEvent") {
        pushDoc(tabInfo.iframe?.contentDocument || null);
      }
    }

    return docs;
  }

  _findField(docs, selectors) {
    for (const doc of docs) {
      if (!doc || typeof doc.querySelector != "function") {
        continue;
      }
      for (const selector of selectors) {
        const element = doc.querySelector(selector);
        if (element) {
          return element;
        }
      }
    }
    return null;
  }

  _findDescriptionFieldInDocs(docs) {
    for (const doc of docs) {
      const host = doc?.querySelector?.("editor#item-description") || null;
      if (host) {
        const target = host.inputField || host.contentDocument?.body || host;
        if (target) {
          return target;
        }
      }
      const fallback = doc?.querySelector?.("textarea#item-description") || null;
      if (fallback) {
        return fallback;
      }
    }
    return null;
  }

  _dispatchInputEvent(field) {
    if (!field) {
      return;
    }
    const doc = field.ownerDocument || field.document;
    const win = doc?.defaultView;
    if (win) {
      field.dispatchEvent(new win.Event("input", { bubbles: true }));
    }
  }

  _setFieldValue(field, value, opts = {}) {
    if (!field) {
      return;
    }

    const doc = field.ownerDocument || field.document || field.contentDocument || null;
    const preferExec = opts.preferExec === true;
    const tryExecCommand = () => {
      if (!doc || typeof doc.execCommand != "function") {
        return false;
      }
      field.focus?.();
      doc.execCommand("selectAll", false, null);
      doc.execCommand("insertText", false, value);
      return true;
    };

    if (preferExec && tryExecCommand()) {
      this._dispatchInputEvent(field);
      return;
    }

    if ("value" in field) {
      field.focus?.();
      field.value = value;
      this._dispatchInputEvent(field);
      return;
    }

    if ((field.isContentEditable || field.tagName?.toLowerCase?.() == "body") && tryExecCommand()) {
      this._dispatchInputEvent(field);
      return;
    }

    if (field.textContent !== undefined) {
      field.textContent = value;
      this._dispatchInputEvent(field);
    }
  }

  _applyFieldUpdates(window, fields) {
    const docs = this._collectEventDocs(window);
    const titleField = this._findField(docs, ["#item-title"]);
    const locationField = this._findField(docs, ["#item-location"]);
    const descField = this._findDescriptionFieldInDocs(docs);

    const applied = {
      title: false,
      location: false,
      description: false
    };

    if (typeof fields.title == "string" && titleField) {
      this._setFieldValue(titleField, fields.title);
      applied.title = true;
    }
    if (typeof fields.location == "string" && locationField) {
      this._setFieldValue(locationField, fields.location);
      applied.location = true;
    }
    if (typeof fields.description == "string" && descField) {
      this._setFieldValue(descField, fields.description, { preferExec: true });
      applied.description = true;
    }

    return applied;
  }

  _applyPropertyUpdates(item, properties) {
    for (const [name, value] of Object.entries(properties || {})) {
      if (!name) {
        continue;
      }
      if (value == null || value == "") {
        if (typeof item.deleteProperty == "function") {
          item.deleteProperty(name);
        } else {
          item.setProperty(name, "");
        }
      } else {
        item.setProperty(name, String(value));
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
              // TODO merge or replace?
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
              // TODO doing this first, the item may not be in the db and it will fail. Doing this
              // after addItem, the metadata will not be available for the onCreated listener
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
            let win = api._resolveSnapshotWindow(context, options?.editorRef);
            if (!win) {
              return null;
            }
            let item = api._getEditedItemForWindow(win);
            if (!item) {
              return null;
            }
            api._ensureLifecycleWatch(context, win);
            const converted = convertItem(item, options, context.extension);
            if (converted) {
              const editorRef = api._buildEditorRef(context, win);
              if (editorRef) {
                converted.editorRef = editorRef;
              }
            }
            return converted;
          },

          async updateCurrent(updateOptions) {
            let win = api._resolveSnapshotWindow(context, updateOptions?.editorRef);
            if (!win) {
              throw new ExtensionError("Could not resolve target editor window");
            }
            let item = api._getEditedItemForWindow(win);
            if (!item) {
              throw new ExtensionError("Could not find current editor item");
            }
            api._ensureLifecycleWatch(context, win);

            const fields = updateOptions?.fields && typeof updateOptions.fields == "object" ? updateOptions.fields : {};
            const properties = updateOptions?.properties && typeof updateOptions.properties == "object" ? updateOptions.properties : {};
            api._applyFieldUpdates(win, fields);
            api._applyPropertyUpdates(item, properties);
            const converted = convertItem(item, updateOptions, context.extension);
            if (converted) {
              const editorRef = api._buildEditorRef(context, win);
              if (editorRef) {
                converted.editorRef = editorRef;
              }
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
                  // TODO calculate changeInfo
                  const changeInfo = {};
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

          onEditorClosed: new EventManager({
            context,
            name: "calendar.items.onEditorClosed",
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
