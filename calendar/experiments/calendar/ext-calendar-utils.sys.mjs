/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * WARNING: This file usually doesn't live reload, you need to restart Thunderbird after editing
 */

var { ExtensionUtils: { ExtensionError, promiseEvent } } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs");

var { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
var { CalEvent } = ChromeUtils.importESModule("resource:///modules/CalEvent.sys.mjs");
var { CalTodo } = ChromeUtils.importESModule("resource:///modules/CalTodo.sys.mjs");
var { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");

var { default: ICAL } = ChromeUtils.importESModule("resource:///modules/calendar/Ical.sys.mjs");

export function isOwnCalendar(calendar, extension) {
  return calendar.superCalendar.type == "ext-" + extension.id;
}

export function unwrapCalendar(calendar) {
  let unwrapped = calendar.wrappedJSObject;

  if (unwrapped.mUncachedCalendar) {
    unwrapped = unwrapped.mUncachedCalendar.wrappedJSObject;
  }

  return unwrapped;
}

export function getResolvedCalendarById(extension, id) {
  let calendar;
  if (id.endsWith("#cache")) {
    const cached = cal.manager.getCalendarById(id.substring(0, id.length - 6));
    calendar = cached && isOwnCalendar(cached, extension) && cached.wrappedJSObject.mCachedCalendar;
  } else {
    calendar = cal.manager.getCalendarById(id);
  }

  if (!calendar) {
    throw new ExtensionError("Invalid calendar: " + id);
  }
  return calendar;
}

export function getCachedCalendar(calendar) {
  return calendar.wrappedJSObject.mCachedCalendar || calendar;
}

export function isCachedCalendar(id) {
  return id.endsWith("#cache");
}

// The refresh interval in minutes that Thunderbird uses for a calendar that has
// none set. It mirrors the default in CalCalendarManager.setupRefreshTimer, which
// the calendar properties dialog hard-codes a second time.
// TODO When this API moves into core, do not keep another copy here. Either take
// the value from one constant that all of them share, or introduce a changeable
// default pref that the calendar manager, the properties dialog and this API all
// use. In that case report null for a calendar without a value of its own, and
// expose the default itself through the settings API or as a property of the
// calendar API.
const DEFAULT_REFRESH_INTERVAL = 30;

export function convertCalendar(extension, calendar) {
  if (!calendar) {
    return null;
  }

  const props = {
    id: calendar.id,
    type: calendar.type,
    name: calendar.name,
    url: calendar.uri.spec,
    // The property can be unset (null) when the calendar never got a value.
    readOnly: !!calendar.readOnly,
    visible: !!calendar.getProperty("calendar-main-in-composite"),
    showReminders: !calendar.getProperty("suppressAlarms"),
    enabled: !calendar.getProperty("disabled"),
    color: calendar.getProperty("color") || "#A8C2E1",
  };

  // Minutes between automatic refreshes, 0 meaning "do not refresh". This is the
  // interval Thunderbird actually uses: a calendar that was never given one gets
  // the default, like in CalCalendarManager.setupRefreshTimer, and a value that is
  // not a positive number arms no timer there, so it is reported as 0. The
  // property bag can hold the value as a string, so normalise. A calendar that
  // cannot refresh has no interval to report, just like the calendar properties
  // dialog hides the setting for it.
  if (calendar.canRefresh) {
    const storedInterval = calendar.getProperty("refreshInterval");
    const minutes = storedInterval === null ? DEFAULT_REFRESH_INTERVAL : parseInt(storedInterval, 10);
    props.refreshInterval = minutes > 0 ? minutes : 0;
  }

  if (isOwnCalendar(calendar, extension)) {
    props.cacheId = calendar.superCalendar.id + "#cache";
    props.capabilities = unwrapCalendar(calendar.superCalendar).capabilities; // TODO needs deep clone?
  }

  return props;
}

async function parseJcalData(jcalComp, calendar) {
  function generateItem(jcalSubComp) {
    let item;
    if (jcalSubComp.name == "vevent") {
      item = new CalEvent();
    } else if (jcalSubComp.name == "vtodo") {
      item = new CalTodo();
    } else {
      throw new ExtensionError("Invalid item component");
    }

    // TODO use calIcalComponent directly when bringing this to core
    const comp = cal.icsService.createIcalComponent(jcalSubComp.name);
    comp.wrappedJSObject.innerObject = jcalSubComp;

    item.icalComponent = comp;
    return item;
  }

  if (jcalComp.name == "vevent" || jcalComp.name == "vtodo") {
    // Single item only, no exceptions
    return generateItem(jcalComp);
  } else if (jcalComp.name == "vcalendar") {
    // A vcalendar with vevents or vtodos
    const exceptions = [];
    let parent;

    for (const subComp of jcalComp.getAllSubcomponents()) {
      if (subComp.name != "vevent" && subComp.name != "vtodo") {
        continue;
      }

      if (subComp.hasProperty("recurrence-id")) {
        exceptions.push(subComp);
        continue;
      }

      if (parent) {
        throw new ExtensionError("Cannot parse more than one parent item");
      }

      parent = generateItem(subComp);
    }

    if (!parent && exceptions.length && calendar) {
      // Only exceptions were supplied, which is what a single edited occurrence
      // looks like: convertItem serializes just the item it was given, so the
      // occurrence arrives as a lone vevent with a recurrence-id and nothing to
      // attach it to. The series it belongs to is the item sharing its uid.
      //
      // A provider calendar's getItem reads the offline storage directly and
      // does not ask the provider again, so this does not re-enter modifyItem.
      const uid = exceptions[0].getFirstPropertyValue("uid");
      const stored = uid ? await calendar.getItem(uid) : null;
      if (stored) {
        // Merging an exception mutates the recurrence info, and the stored item
        // is not ours to change.
        parent = stored.clone();
      }
    }

    if (!parent) {
      let reason = "No vevent or vtodo component found";
      if (exceptions.length) {
        reason = calendar
          ? "Exceptions were supplied for an item that could not be found"
          : "Exceptions were supplied without their parent item";
      }
      throw new ExtensionError(reason);
    }

    if (exceptions.length && !parent.recurrenceInfo) {
      throw new ExtensionError("Exceptions were supplied to a non-recurring item");
    }

    for (const exception of exceptions) {
      const excItem = generateItem(exception);
      if (excItem.id != parent.id || parent.isEvent() != excItem.isEvent()) {
        throw new ExtensionError("Exception does not relate to parent item");
      }
      parent.recurrenceInfo.modifyException(excItem, true);
    }
    return parent;
  }
  throw new ExtensionError("Don't know how to handle component type " + jcalComp.name);
}

/**
 * Convert the item properties of the API to a calendar item.
 *
 * @param {object} props - The item properties, including format and item.
 * @param {calICalendar} [calendar] - If given, a parent that is missing from
 *   props (only exceptions supplied) is looked up in this calendar. Only the
 *   paths that modify an item pass it: a create carrying just an exception
 *   would otherwise resolve, and quietly modify, an existing series.
 */
export async function propsToItem(props, calendar) {
  let jcalComp;

  // The type of the item tells its format: iCalendar is a string, jCal is an
  // array. Neither can be empty. The format is optional, and if it is given it
  // has to match.
  let detected;
  if (typeof props.item == "string" && props.item) {
    detected = "ical";
  } else if (Array.isArray(props.item) && props.item.length) {
    detected = "jcal";
  } else {
    throw new ExtensionError("Invalid item: expected a non-empty iCalendar string or a jCal array");
  }

  const format = props.format ?? detected;
  if (format != "ical" && format != "jcal") {
    throw new ExtensionError("Invalid item format: " + format);
  }
  if (format != detected) {
    const given = detected == "ical" ? "an iCalendar string" : "a jCal array";
    throw new ExtensionError(`The item format is ${format}, but the item is ${given}`);
  }

  if (format == "ical") {
    try {
      jcalComp = new ICAL.Component(ICAL.parse(props.item));
    } catch (e) {
      throw new ExtensionError("Could not parse iCalendar", { cause: e });
    }
  } else {
    try {
      jcalComp = new ICAL.Component(props.item);
    } catch (e) {
      throw new ExtensionError("Could not parse jCal", { cause: e });
    }
  }
  return parseJcalData(jcalComp, calendar);
}

export function convertItem(item, options, extension) {
  if (!item) {
    return null;
  }

  const props = {};

  if (item.isEvent()) {
    props.type = "event";
  } else if (item.isTodo()) {
    props.type = "task";
  } else {
    throw new ExtensionError(`Encountered unknown item type for ${item.calendar.id}/${item.id}`);
  }

  props.id = item.id;
  props.calendarId = item.calendar.superCalendar.id;

  const recId = item.recurrenceId?.getInTimezone(cal.timezoneService.UTC)?.icalString;
  if (recId) {
    const jcalId = ICAL.design.icalendar.value[recId.length == 8 ? "date" : "date-time"].fromICAL(recId);
    props.instance = jcalId;
  }

  if (isOwnCalendar(item.calendar, extension)) {
    props.metadata = {};
    const cache = getCachedCalendar(item.calendar);
    try {
      // TODO This is a sync operation. Not great. Can we optimize this?
      props.metadata = JSON.parse(cache.getMetaData(item.id)) ?? {};
    } catch {
      // Ignore json parse errors
    }
  }

  // The item is returned in the requested format, as jCal if there is none.
  props.format = options?.returnFormat || "jcal";

  const serializer = Cc["@mozilla.org/calendar/ics-serializer;1"].createInstance(
    Ci.calIIcsSerializer
  );
  serializer.addItems([item]);
  const icalString = serializer.serializeToString();

  switch (props.format) {
    case "ical":
      props.item = icalString;
      break;
    case "jcal":
      // TODO shortcut when using icaljs backend
      props.item = ICAL.parse(icalString);
      break;
    default:
      throw new ExtensionError("Invalid format specified: " + props.format);
  }

  return props;
}

export function convertAlarm(item, alarm) {
  const ALARM_RELATED_MAP = {
    [Ci.calIAlarm.ALARM_RELATED_ABSOLUTE]: "absolute",
    [Ci.calIAlarm.ALARM_RELATED_START]: "start",
    [Ci.calIAlarm.ALARM_RELATED_END]: "end",
  };

  return {
    itemId: item.id,
    action: alarm.action.toLowerCase(),
    date: alarm.alarmDate?.icalString,
    offset: alarm.offset?.icalString,
    related: ALARM_RELATED_MAP[alarm.related],
  };
}

/**
 * Thunderbird >=148 no longer exposes cal.createAdapter(). Build explicit
 * calIObserver objects so the calendar experiment keeps working on newer
 * release channels as well as ESR.
 *
 * @param {object} methods
 * @returns {calIObserver}
 */
export function createCalendarObserver(methods = {}) {
  return Object.assign({
    QueryInterface: ChromeUtils.generateQI(["calIObserver"]),
    onStartBatch() {},
    onEndBatch() {},
    onLoad() {},
    onAddItem() {},
    onModifyItem() {},
    onDeleteItem() {},
    onError() {},
    onPropertyChanged() {},
    onPropertyDeleting() {},
  }, methods);
}

export async function setupE10sBrowser(extension, browser, parent, initOptions={}) {
  browser.setAttribute("type", "content");
  browser.setAttribute("disableglobalhistory", "true");
  browser.setAttribute("messagemanagergroup", "webext-browsers");
  browser.setAttribute("class", "webextension-popup-browser");
  browser.setAttribute("webextension-view-type", "subview");

  browser.setAttribute("initialBrowsingContextGroupId", extension.policy.browsingContextGroupId);
  if (extension.remote) {
    browser.setAttribute("remote", "true");
    browser.setAttribute("remoteType", extension.remoteType);
    browser.setAttribute("maychangeremoteness", "true");
  }

  let readyPromise;
  if (extension.remote) {
    readyPromise = promiseEvent(browser, "XULFrameLoaderCreated");
  } else {
    readyPromise = promiseEvent(browser, "load");
  }

  parent.appendChild(browser);

  if (!extension.remote) {
    // FIXME: bug 1494029 - this code used to rely on the browser binding
    // accessing browser.contentWindow. This is a stopgap to continue doing
    // that, but we should get rid of it in the long term.
    browser.contentwindow; // eslint-disable-line no-unused-expressions
  }

  const sheets = [];
  if (initOptions.browser_style) {
    delete initOptions.browser_style;
    sheets.push("chrome://browser/content/extension.css");
  }
  sheets.push("chrome://browser/content/extension-popup-panel.css");

  const initBrowser = () => {
    ExtensionParent.apiManager.emit("extension-browser-inserted", browser);
    const mm = browser.messageManager;
    mm.loadFrameScript(
      "chrome://extensions/content/ext-browser-content.js",
      false,
      true
    );
    const options = Object.assign({
      allowScriptsToClose: true,
      blockParser: false,
      maxWidth: 800,
      maxHeight: 600,
      stylesheets: sheets
    }, initOptions);
    mm.sendAsyncMessage("Extension:InitBrowser", options);
  };
  browser.addEventListener("DidChangeBrowserRemoteness", initBrowser);

  return readyPromise.then(initBrowser);
}
