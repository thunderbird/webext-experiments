/**
 * API to allow MailExtensions to implement a calendar provider.
 * A MailExtension uses this API to implement a calendar server sync protocol.
 *
 * MIT license
 * (c) 2020 Ben Bucksch
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

var {XPCOMUtils} = ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");
var {Services} = ChromeUtils.import("resource://gre/modules/Services.jsm");
var {MailServices} = ChromeUtils.import("resource:///modules/MailServices.jsm");
try {
  var {cal} = ChromeUtils.import("resource:///modules/calendar/calUtils.jsm");
  var {splitRecurrenceRules, checkRecurrenceRule, countOccurrences} = ChromeUtils.import("resource:///modules/calendar/calRecurrenceUtils.jsm");
} catch (ex) {
  try { // COMPAT for TB 68 (bug 1608610)
    cal = ChromeUtils.import("resource://calendar/modules/calUtils.jsm").cal; // COMPAT for TB 68 (bug 1608610)
    ({splitRecurrenceRules, checkRecurrenceRule, countOccurrences} = ChromeUtils.import("resource://calendar/modules/calRecurrenceUtils.jsm")); // COMPAT for TB 68 (bug 1608610)
  } catch (ex) { // COMPAT for TB 68 (bug 1608610)
    // Calendar isn't installed. Eat the exception to allow the extension to load.
    cal = null;
  } // COMPAT for TB 68 (bug 1608610)
}
const nsMsgViewIndex_None = 0xFFFFFFFF;
function logError(msg) {
  console.error(msg);
}

/// {Map time zone {String} -> {calITimezone}}
var gTimeZoneCache = new Map();
/**
 * Gets a time zone object for a given time zone string.
 *
 * @param aDisplayName {String} The display name for the custom time zone.
 * @returns {calITimezone}
 *
 * If the time zone is not recognised a dummy time zone object is created.
 */
function getTimezone(aDisplayName) {
  let timezone = gTimeZoneCache.get(aDisplayName);
  if (!timezone) {
    // Sometimes the zone id we get from EWS includes the GMT offset.
    timezone = cal.getTimezoneService().getTimezone(aDisplayName.replace(/^\(GMT[+-]\d\d:\d\d\) /, ""));
    if (!timezone) {
      // Create a fake event and parse a time zone from it.
      let comp = cal.getIcsService().parseICS("BEGIN:VCALENDAR\nBEGIN:VTIMEZONE\nTZID:" + aDisplayName.replace(/[^ -~]/g, "") + "\nEND:VTIMEZONE\nEND:VCALENDAR", null);
      timezone = {
        provider: null,
        icalComponent: comp.getFirstSubcomponent("VTIMEZONE"),
        tzid: aDisplayName,
        isUTC: false,
        isFloating: false,
        latitude: null,
        longitude: null,
        displayName: aDisplayName,
        toString() { return this.displayName; },
      };
    }
    gTimeZoneCache.set(aDisplayName, timezone);
  }
  return timezone;
}

/**
 * (Re)loads our calendar(s)
 *
 * @param aBaseURI {nsIURI}               The URI of the master calendar
 * @param aServer  {nsIMsgIncomingServer} The server of the master calendar
 *
 * If Lightning starts before Owl then it will not be able to create our
 * calendars on startup, so it creates placeholders. The existing calendars
 * are searched for ones matching our URI and if one is found then it is
 * manually unsubscribed so that our live calendar object can replace it.
 * This also works in the case when Owl is updated.
 *
 * If our master calendar is not found, it is created and set as default.
 *
 * Notes: Due to limitations of Lightning, the default calendar may change.
 *        Placeholder calendars will use nsISimpleURI objects, not nsIURL.
 */
function reloadCalendars(aBaseURI, aServer) {
  let manager = cal.getCalendarManager().wrappedJSObject;
  manager.assureCache();
  let selectedCalendar = getDefaultCalendar();
  let masterCalendar = null;
  for (let id in manager.mCache) {
    let oldCalendar = manager.mCache[id];
    if (oldCalendar.uri.spec.startsWith(aBaseURI.spec)) {
      let uri = Services.io.newURI(oldCalendar.uri.spec);
      if (uri.filePath == "/") {
        if (oldCalendar.mUncachedCalendar instanceof Ci.calIFreeBusyProvider) {
          cal.getFreeBusyService().removeProvider(oldCalendar.mUncachedCalendar);
        }
      }
      // Can't call unregisterCalendar as that deletes all the prefs...
      manager.notifyObservers("onCalendarUnregistering", [oldCalendar]);
      oldCalendar.removeObserver(manager.mCalObservers[id]);
      delete manager.mCache[id];
      if (oldCalendar.readOnly) {
        manager.mReadonlyCalendarCount--;
      }
      if (oldCalendar.getProperty("requiresNetwork") !== false) {
        manager.mNetworkCalendarCount--;
      }
      manager.mCalendarCount--;
      let calendar = new Calendar();
      calendar.id = id;
      calendar.uri = uri;
      if (calendar.getProperty("auto-enabled")) {
        calendar.deleteProperty("disabled");
        calendar.deleteProperty("auto-enabled");
      }
      manager.registerCalendar(calendar);
      if (uri.filePath == "/") {
        masterCalendar = calendar;
      }
    }
  }
  if (!masterCalendar && !aServer.getBoolValue("addedCalendar")) {
    masterCalendar = new Calendar();
    masterCalendar.uri = aBaseURI;
    masterCalendar.name = aServer.realUsername;
    manager.registerCalendar(masterCalendar);
    aServer.setBoolValue("addedCalendar", true);
    selectCalendar(masterCalendar);
  } else if (selectedCalendar) {
    // The calendar widget plays fast and loose with the selected calendar,
    // because it assumes that its only consumer is its own UI.
    // Reset the selection to what it was before we started.
    selectCalendar(selectedCalendar);
  }
  if (masterCalendar) {
    cal.getFreeBusyService().addProvider(masterCalendar);
  }
}

/**
 * Returns the selected calendar, if one can be found.
 * @returns {calICalendar}
 */
function getDefaultCalendar() {
  try {
    // Assume exactly one 3pane window.
    let mainWindow = Services.wm.getMostRecentWindow("mail:3pane");
    return cal.view.getCompositeCalendar(mainWindow).defaultCalendar;
  } catch (ex) {
    return null;
  }
}

/**
 * Selects a calendar in the 3pane window
 *
 * @param aCalendar {calICalendar} The calendar to select
 *
 * We just select the calendar in the most recent 3pane window.
 * This suffices to set it as the saved default calendar.
 */
function selectCalendar(aCalendar) {
  try {
    // Assume exactly one 3pane window.
    let mainWindow = Services.wm.getMostRecentWindow("mail:3pane");
    let compositeCalendar = cal.view.getCompositeCalendar(mainWindow);
    // Make sure that we use the cached calendar, rather than our raw calendar.
    compositeCalendar.defaultCalendar = compositeCalendar.getCalendarById(aCalendar.id);
    let widget = mainWindow.document.getElementById("calendar-list-tree-widget"); // COMPAT for TB 68
    if (widget && widget.tree) { // COMPAT for TB 68
      widget.selectCalendarById(aCalendar.id); // COMPAT for TB 68
    } // COMPAT for TB 68
  } catch (ex) {
    logError(ex);
  }
}

/**
 * Test whether an array of days represents every weekday.
 * @param aDays {Array[1..7]}
 * @returns     {Boolean}
 */
function isEveryWeekday(aDays) {
  const everyWeekday = 124;
  return aDays.reduce((mask, day) => mask | 1 << day, 0) == everyWeekday;
}

/**
 * Convert a calIDateTime to an ISO date string
 *
 * @param aDate {calIDateTime} The date to convert
 * @returns     {String}       The date in ISO format
 *
 * Note: aDate may not be null.
 */
function DatePart(aDate) {
  return aDate.icalString.replace(/(....)(..)(..).*/, "$1-$2-$3");
}

/**
 * Convert a calIDateTime to an ISO datetime string
 *
 * @param aDate {calIDateTime?} The timestamp to convert
 * @returns     {String?}       The timestamp in ISO format
 *
 * Note: The return value is null if the timestamp is null or invalid.
 */
function Date2JSON(aDate) {
  return aDate && aDate.nativeTime ? new Date(aDate.nativeTime / 1000).toISOString() : null;
}

/**
 * Convert a calIDateTime to an ISO datetime string and a timezone
 *
 * @param aDate {calIDateTime?}  The timestamp to convert
 * @returns     {Array[String?]}
 *   [0]                         The timestamp in ISO format
 *   [1]                         The timezone of the timestamp
 *
 * Note: An empty array is returned if the timestamp is null or invalid.
 */
function DateTimeZone2JSON(aDate) {
  if (!aDate || !aDate.nativeTime) {
    return [];
  }
  if (aDate.timezone.isFloating) {
    aDate = aDate.getInTimezone(cal.dtz.defaultTimezone);
  }
  return [Date2JSON(aDate), aDate.timezone.tzid];
}

/**
 * Convert an ISO datetime string to a calIDateTime
 *
 * @param aDateString {String}  The datetime in ISO format
 * @param aTimeZone   {String}  The time zone of the datetime
 * @param aIsAllDay   {Boolean} Whether this is a date rather than a datetime
 * @returns           {calIDateTime}
 *
 * Note: The datetime is converted to the given time zone before marking it
 *       as a date in case the time zone has a positive offset.
 */
function JSON2Date(aDateString, aTimeZone, aIsAllDay) {
  if (!aDateString) {
    return null;
  }
  let date = cal.createDateTime();
  date.nativeTime = Date.parse(aDateString) * 1000;
  if (aTimeZone) {
    try {
      date = date.getInTimezone(getTimezone(aTimeZone));
    } catch (ex) {
      ex.parameters = {
        timezone: aTimeZone,
      };
      logError(ex);
    }
  }
  if (aIsAllDay) {
    date.isDate = true;
  }
  return date;
}

/**
 * Update a calIItemBase object from JSON data
 *
 * @param aJSON {Object}       The JSON data
 * @param aItem {calIItemBase} The item to update
 */
function JSON2Item(aJSON, aItem) {
  aItem.id = aJSON.uid;
  aItem.title = aJSON.title;
  aItem.setProperty("location", aJSON.location);
  if (aItem.setCategories.length == 2) { // COMPAT for TB 68 (bug 1557504)
    aItem.setCategories(aJSON.categories.length, aJSON.categories); // COMPAT for TB 68 (bug 1557504)
  } else { // COMPAT for TB 68 (bug 1557504)
    aItem.setCategories(aJSON.categories);
  } // COMPAT for TB 68 (bug 1557504)
  aItem.setProperty("description", aJSON.description);
  aItem.priority = aJSON.priority;
  aItem.privacy = aJSON.privacy;
  aItem.status = aJSON.isCancelled ? "CANCELLED" : null;
  aItem.setProperty("TRANSP", aJSON.status);
  // For the complex properties it's easier to recalculate the entire value
  // rather than trying to edit any existing value in-place.
  // Organiser.
  let organizer = null;
  if (aJSON.organizer) {
    organizer = cal.createAttendee();
    organizer.id = "mailto:" + aJSON.organizer.email;
    organizer.commonName = aJSON.organizer.name;
    organizer.role = "CHAIR";
    organizer.participationStatus = "ACCEPTED";
    organizer.isOrganizer = true;
  }
  aItem.organizer = organizer;
  // Attendeees.
  aItem.removeAllAttendees();
  for (let required of aJSON.requiredAttendees) {
    if (aJSON.organizer && required.email == aJSON.organizer.email) {
      // Lightning doesn't like it if the organiser is an attendee.
      continue;
    }
    let attendee = cal.createAttendee();
    attendee.id = "mailto:" + required.email;
    attendee.commonName = required.name;
    attendee.role = "REQ-PARTICIPANT";
    attendee.userType = "INDIVIDUAL";
    attendee.participationStatus = required.participation;
    aItem.addAttendee(attendee);
  }
  for (let optional of aJSON.optionalAttendees) {
    let attendee = cal.createAttendee();
    attendee.id = "mailto:" + optional.email;
    attendee.commonName = optional.name;
    attendee.role = "OPT-PARTICIPANT";
    attendee.userType = "INDIVIDUAL";
    attendee.participationStatus = optional.participation;
    aItem.addAttendee(attendee);
  }
  // Recurrence.
  let recurrenceInfo = null;
  if (aJSON.recurrence) {
    // Translate these into Calendar's "weekly" and "bi-weekly" ui.
    if (aJSON.recurrence.type == "DAILY" &&
        (aJSON.recurrence.interval == 7 || aJSON.recurrence.interval == 14)) {
      aJSON.recurrence.type = "WEEKLY";
      aJSON.recurrence.interval /= 7;
    }
    // Calendar's "every weekday" ui expects a daily rule for some reason.
    if (aJSON.recurrence.type == "WEEKLY" && aJSON.recurrence.daysOfWeek &&
        isEveryWeekday(aJSON.recurrence.daysOfWeek)) {
      aJSON.recurrence.type = "DAILY";
    }
    recurrenceInfo = cal.createRecurrenceInfo();
    recurrenceInfo.item = aItem;
    let rule = cal.createRecurrenceRule();
    rule.type = aJSON.recurrence.type;
    let days = aJSON.recurrence.daysOfWeek;
    if (days) {
      if (aJSON.recurrence.weekOfMonth == 5) {
        days = days.map(day => -8 - day);
      } else {
        days = days.map(day => day += aJSON.recurrence.weekOfMonth * 8);
      }
      if (rule.setComponent.length == 3) { // COMPAT for TB 68 (bug 1602425)
        rule.setComponent("BYDAY", days.length, days); // COMPAT for TB 68 (bug 1602425)
      } else { // COMPAT for TB 68 (bug 1602425)
        rule.setComponent("BYDAY", days);
      } // COMPAT for TB 68 (bug 1602425)
    }
    if (aJSON.recurrence.dayOfMonth) {
      if (rule.setComponent.length == 3) { // COMPAT for TB 68 (bug 1602425)
        rule.setComponent("BYMONTHDAY", 1, [aJSON.recurrence.dayOfMonth]); // COMPAT for TB 68 (bug 1602425)
      } else { // COMPAT for TB 68 (bug 1602425)
        rule.setComponent("BYMONTHDAY", [aJSON.recurrence.dayOfMonth]);
      } // COMPAT for TB 68 (bug 1602425)
    }
    if (aJSON.recurrence.monthOfYear) {
      if (rule.setComponent.length == 3) { // COMPAT for TB 68 (bug 1602425)
        rule.setComponent("BYMONTH", 1, [aJSON.recurrence.monthOfYear]); // COMPAT for TB 68 (bug 1602425)
      } else { // COMPAT for TB 68 (bug 1602425)
        rule.setComponent("BYMONTH", [aJSON.recurrence.monthOfYear]);
      } // COMPAT for TB 68 (bug 1602425)
    }
    rule.interval = aJSON.recurrence.interval;
    if (aJSON.recurrence.until) {
      let date = JSON2Date(aJSON.recurrence.until);
      if (!aJSON.isAllDayEvent) {
        // For an all-day event, Lightning just wants the floating date.
        // But for a regular event, the until date needs to include the time.
        let time = aItem.recurrenceStartDate.clone();
        time.year = date.year;
        time.month = date.month;
        time.day = date.day;
        date = time;
      }
      rule.untilDate = date;
    } else {
      rule.count = aJSON.recurrence.count;
    }
    recurrenceInfo.insertRecurrenceItemAt(rule, 0);
    for (let deletion of aJSON.deletions) {
      recurrenceInfo.removeOccurrenceAt(JSON2Date(deletion, aJSON.startTimeZone, aJSON.isAllDayEvent));
    }
    for (let modification of aJSON.modifications) {
      let occurrence = recurrenceInfo.getOccurrenceFor(JSON2Date(modification.recurrenceId, aJSON.startTimeZone, aJSON.isAllDayEvent));
      JSON2Occurrence(modification, occurrence);
      recurrenceInfo.modifyException(occurrence, true);
    }
  }
  aItem.recurrenceInfo = recurrenceInfo;
  // Alarm.
  aItem.clearAlarms();
  if (aJSON.reminder != null) {
    let alarm = cal.createAlarm();
    alarm.related = Ci.calIAlarm.ALARM_RELATED_START;
    alarm.offset = cal.createDuration();
    alarm.offset.inSeconds = aJSON.reminder;
    alarm.action = "DISPLAY";
    aItem.addAlarm(alarm);
  }
  aItem.setProperty("CREATED", JSON2Date(aJSON.creationDate));
  aItem.setProperty("DTSTAMP", JSON2Date(aJSON.stampTime));
  aItem.setProperty("LAST-MODIFIED", JSON2Date(aJSON.lastModified));
}

/**
 * Update a calIEvent object from JSON data
 *
 * @param aJSON {Object}    The JSON data
 * @param aItem {calIEvent} The item to update
 */
function JSON2Occurrence(aJSON, aOccurrence) {
  aOccurrence.startDate = JSON2Date(aJSON.startDate, aJSON.startTimeZone, aJSON.isAllDayEvent);
  aOccurrence.endDate = JSON2Date(aJSON.endDate, aJSON.endTimeZone, aJSON.isAllDayEvent);
  JSON2Item(aJSON, aOccurrence);
}

/**
 * Create an updated calIEvent object from JSON data
 *
 * @param aJSON {Object?}    The JSON data
 * @param aItem {calIEvent?} The previous version of the event, if any
 * @returns     {calIEvent}  A new, updated event
 *
 * Note: The original event is not modified.
 */
function JSON2Event(aJSON, aEvent) {
  let event = aEvent ? aEvent.clone() : cal.createEvent();
  if (aJSON) {
    JSON2Occurrence(aJSON, event);
  }
  return event;
}

/**
 * Create an updated calITodo object from JSON data
 *
 * @param aJSON {Object?}   The JSON data
 * @param aItem {calITodo?} The previous version of the task, if any
 * @returns     {calITodo}  A new, updated task
 *
 * Note: The original task is not modified.
 */
function JSON2Task(aJSON, aTask) {
  let task = aTask ? aTask.clone() : cal.createTodo();
  if (aJSON) {
    task.entryDate = JSON2Date(aJSON.startDate);
    task.dueDate = JSON2Date(aJSON.dueDate);
    task.completedDate = JSON2Date(aJSON.completedDate);
    task.percentComplete = aJSON.percentComplete;
    JSON2Item(aJSON, task);
  }
  return task;
}

/**
 * Update JSON data from a calIItemBase object
 *
 * @param aItem {calIItemBase} The item to update from
 * @param aJSON {Object}       The data to update
 */
function Item2JSON(aItem, aJSON) {
  aJSON.title = aItem.title;
  aJSON.location = aItem.getProperty("location") || "";
  aJSON.description = aItem.getProperty("description");
  aJSON.priority = aItem.priority;
  aJSON.privacy = aItem.privacy;
  aJSON.status = aItem.getProperty("TRANSP");
  let alarms = aItem.getAlarms(/* COMPAT for TB 68 (bug 1557504) */{});
  if (alarms.length == 1 && alarms[0].related == Ci.calIAlarm.ALARM_RELATED_START) {
    aJSON.reminder = alarms[0].offset.inSeconds;
  }
  aJSON.categories = aItem.getCategories(/* COMPAT for TB 68 (bug 1557504) */{});
  aJSON.description = aItem.getProperty("description");
  aJSON.requiredAttendees = [];
  aJSON.optionalAttendees = [];
  for (let attendee of aItem.getAttendees(/* COMPAT for TB 68 (bug 1557504) */{})) {
    switch (attendee.role) {
    case "REQ-PARTICIPANT":
      aJSON.requiredAttendees.push({
        name: attendee.commonName,
        email: attendee.id.replace(/^mailto:/, ""),
      });
      break;
    case "OPT-PARTICIPANT":
      aJSON.optionalAttendees.push({
        name: attendee.commonName,
        email: attendee.id.replace(/^mailto:/, ""),
      });
      break;
    }
  }
  if (aItem.recurrenceInfo) {
    let [rules, deletions] = splitRecurrenceRules(aItem.recurrenceInfo);
    if (rules.length == 1) {
      let rule = rules[0].QueryInterface(Ci.calIRecurrenceRule);
      aJSON.recurrence = {};
      aJSON.recurrence.type = rule.type;
      aJSON.recurrence.interval = rule.interval;
      if (checkRecurrenceRule(rule, ["BYDAY"])) {
        let days = rule.getComponent("BYDAY", /* COMPAT for TB 68 (bug 1602425) */{});
        if (days[0] < 0) {
          aJSON.recurrence.weekOfMonth = 5;
          aJSON.recurrence.days = days.map(day => -8 - day);
        } else {
          aJSON.recurrence.weekOfMonth = days[0] >> 3;
          aJSON.recurrence.days = days.map(day => day & 7);
        }
        // Calendar's "every weekday" option generates a daily rule,
        // but it's actually a weekly rule with recurrence days.
        if (aJSON.recurrence.type == "DAILY") {
          aJSON.recurrence.type = "WEEKLY";
        }
      }
      if (aJSON.recurrence.type == "WEEKLY") {
        if (aJSON.recurrence.days) {
          aJSON.recurrence.firstDayOfWeek = Services.prefs.getIntPref("calendar.week.start", 0) + 1;
        } else {
          // Translate Calendar's "weekly" and "bi-weekly"
          // into something Exchange can handle.
          aJSON.recurrence.type = "DAILY";
          aJSON.recurrence.interval *= 7;
        }
      }
      if (checkRecurrenceRule(rule, ["BYMONTHDAY"])) {
        aJSON.recurrence.dayOfMonth = rule.getComponent("BYMONTHDAY", /* COMPAT for TB 68 (bug 1602425) */{})[0];
      }
      if ((aJSON.recurrence.type == "MONTHLY" || aJSON.recurrence.type == "YEARLY") &&
          !(aJSON.recurrence.days || aJSON.recurrence.dayOfMonth)) {
        // Translate Calendar's "monthly" into something Exchange can handle.
        aJSON.recurrence.dayOfMonth = aItem.recurrenceStartDate.day;
      }
      if (aJSON.recurrence.type == "YEARLY") {
        if (checkRecurrenceRule(rule, ["BYMONTH"])) {
          aJSON.recurrence.monthOfYear = rule.getComponent("BYMONTH", /* COMPAT for TB 68 (bug 1602425) */{})[0];
        } else {
          // Translate Calendar's "yearly" into something Exchange can handle.
          aJSON.recurrence.monthOfYear = aItem.recurrenceStartDate.month + 1;
        }
      }
      // This needs to be a date with no time component.
      aJSON.recurrence.from = DatePart(aItem.startDate);
      if (rule.isByCount) {
        aJSON.recurrence.count = rule.count;
      } else if (rule.untilDate) {
        // The untilDate is provided in UTC, but we want the local date part.
        aJSON.recurrence.until = DatePart(rule.untilDate.getInTimezone(aItem.startDate.timezone));
      }
      let exceptions = aItem.recurrenceInfo.getExceptionIds(/* COMPAT for TB 68  (bug 1602423) */{});
      if (exceptions.length || deletions.length) {
        let maxDate = aItem.recurrenceStartDate;
        for (let deletion of deletions) {
          let date = deletion.QueryInterface(Ci.calIRecurrenceDate).date;
          if (maxDate.compare(date) < 0) {
            maxDate = deletion.date;
          }
        }
        let occurrences = rule.getOccurrences(aItem.recurrenceStartDate, aItem.recurrenceStartDate, maxDate, 0, /* COMPAT for TB 68 (bug 1602424) */{});
        occurrences.push(maxDate);
        aJSON.deletions = deletions.map(deletion => occurrences.findIndex(date => !date.compare(deletion.date)) + 1);
      }
    }
  }
}

/**
 * Update JSON data from a calIEvent object
 *
 * @param aItem {calIEvent} The event to update from
 * @param aJSON {Object}    The data to update
 */
function Event2JSON(aEvent, aJSON) {
  aJSON.uid = aEvent.id;
  [aJSON.startDate, aJSON.startTimeZone] = DateTimeZone2JSON(aEvent.startDate);
  [aJSON.endDate, aJSON.endTimeZone] = DateTimeZone2JSON(aEvent.endDate);
  aJSON.isAllDayEvent = aEvent.startDate.isDate;
  Item2JSON(aEvent, aJSON);
}

/**
 * Update JSON data from a calITodo object
 *
 * @param aTask {calITodo} The task to update from
 * @param aJSON {Object}   The data to update
 */
function Task2JSON(aTask, aJSON) {
  aJSON.startDate = Date2JSON(aTask.entryDate);
  aJSON.dueDate = Date2JSON(aTask.dueDate);
  aJSON.completedDate = Date2JSON(aTask.completedDate);
  aJSON.percentComplete = aTask.percentComplete;
  Item2JSON(aTask, aJSON);
}

/**
 * Determine whether meeting invitations should be sent.
 *
 * @param aItem {calIItemBase} The meeting
 * @returns     {Boolean}
 */
function getNotificationStatus(aItem) {
  switch (aItem.getProperty("X-MOZ-SEND-INVITATIONS")) {
  case "TRUE":
    return true;
  case "FALSE":
    return false;
  default:
    return Services.prefs.getBoolPref("calendar.itip.notify", true);
  }
}

/// Registration information for the calendar XPCOM object
var gCalendarProperties = {
  contractID: "@mozilla.org/calendar/calendar;1?type=owl",
  classDescription: "Calendar Provider",
  classID: Components.ID("{9523acc8-725c-481a-bf19-25a11b77e740}"),
};

class Calendar extends (cal && cal.provider.BaseClass) {
  constructor() {
    super();
    this.initProviderBase();
    this.offlineStorage = null;
    this.senderAddress = null;
    this.QueryInterface = ChromeUtils.generateQI([Ci.calICalendar, Ci.calIChangeLog, Ci.calISchedulingSupport, Ci.calIItipTransport, Ci.calIFreeBusyProvider]);
  }
  /**
   * Invoke the extension's dispatch listener.
   *
   * @param aOperation {String} The requested operation
   * @param aData      {Object} Operation-specific parameters
   * @returns          {Any?}   Operation-dependent return value
   */
  async callExtension(aOperation, aData) {
    let server = Calendar.gRegisteredURIs.get(this.uri.prePath);
    let error = new Error(); // must capture stack before async call
    try {
      // Calls the function passed to browser.calendarProvider.dispatcher.addListener() in ews.js
      return await Calendar.gListeners.get(server.type).async(server.key, aOperation, aData);
    } catch (ex) {
      if (ex instanceof Error || ex instanceof Ci.nsIException) {
        // This is a real exception.
        throw ex;
      }
      // Turn the serialised exception back into an error object.
      try {
        if (ex.message[0] == "{") {
          let exJSON = JSON.parse(ex.message);
          Object.assign(ex, exJSON);
        }
      } catch (exWhileParsingError) {
        console.error(exWhileParsingError);
      }
      // Add our stack to the extension stack
      ex.stack += error.stack;
      Object.assign(error, ex);
      throw error;
    }
  }
  // calIFreeBusyProvider
  async getFreeBusyIntervals(aAttendee, aStart, aEnd, aTypes, aListener) {
    if (!/^mailto:.+@.+\../.test(aAttendee)) {
      // This address has only been partially typed. Ignore it.
      aListener.onResult({ status: Cr.NS_ERROR_FAILURE }, null);
      return;
    }
    try {
      let result = await this.callExtension("GetFreeBusy", { attendee: aAttendee.replace(/^mailto:/, ""), start: Date2JSON(aStart), end: Date2JSON(aEnd) });
      result = result.map(interval => new cal.provider.FreeBusyInterval(aAttendee, interval.type, JSON2Date(interval.start), JSON2Date(interval.end)));
      aListener.onResult({ status: Cr.NS_OK }, result);
    } catch (ex) {
      switch (ex.type) {
      // Our address check might not be stringent enough.
      case "ErrorInvalidSmtpAddress":
      // Or the recipient might not be known to the server.
      case "ErrorMailRecipientNotFound":
        break;
      // Report the error in all cases other than the two specific cases above.
      default:
        logError(ex);
        break;
      }
      aListener.onResult({ status: ex.result || Cr.NS_ERROR_FAILURE }, null);
    }
  }
  // calIItipTransport
  get scheme() {
    return "mailto";
  }
  async sendItems(aRecipients, aItipItem, aItipItemTB68) {
    if (aItipItemTB68) { // COMPAT for TB 68 (bug 1557504)
      aItipItem = aItipItemTB68; // COMPAT for TB 68 (bug 1557504)
    } // COMPAT for TB 68 (bug 1557504)
    if (aItipItem.responseMethod == "REPLY") {
      try {
        // We disabled the response when the item was modified,
        // but the user wanted to respond. Send the response now.
        let invitation = aItipItem.getItemList(/* COMPAT for TB 68 (bug 1557504) */{})[0];
        let folder = this.getItemFolder(invitation);
        let id = this.offlineStorage.getMetaData(invitation.id);
        let participation = cal.itip.getInvitedAttendee(invitation, aItipItem.targetCalendar).participationStatus;
        let isRecurrence = invitation.recurrenceId != null;
        await this.callExtension("NotifyParticipation", { folder, id, participation, isRecurrence });
      } catch (ex) {
        logError(ex);
      }
    }
    // We get called for REQUEST and CANCEL as well,
    // but those get processed at creation/modification time.
  }
  // calISchedulingSupport
  isInvitation(aItem) {
    return this.uri.filePath == "/" && super.isInvitation(aItem);
  }
  // getInvitedAttendee handled by base class
  // canNotify handled by base class
  // calIChangeLog
  resetLog() {
    this.offlineStorage.QueryInterface(Ci.calICalendarProvider).deleteCalendar(this.offlineStorage, {
      onDeleteCalendar: (aCalendar, aStatus, aDetail) => {
        if (Components.isSuccessCode(aStatus)) {
          this.setProperty("calendarSyncState", "");
          this.setProperty("tasksSyncState", "");
          this.mObservers.notify("onLoad", [this]);
        } else {
          console.error(aDetail);
        }
      }
    });
  }
  async replayChangesOn(aListener, aRetried) {
    let success;
    try {
      this.offlineStorage.startBatch();
      let calendar = this.syncEvents("calendar", JSON2Event);
      let tasks = this.uri.filePath != "/" || await this.syncEvents("tasks", JSON2Task);
      success = await calendar && tasks;
      this.offlineStorage.endBatch();
    } catch (ex) {
      logError(ex);
      this.offlineStorage.endBatch();
      aListener.onResult({ status: ex.result || Cr.NS_ERROR_FAILURE }, ex.message);
      return;
    }
    if (success) {
      aListener.onResult(null, null);
    } else if (aRetried) {
      aListener.onResult({ status: Cr.NS_ERROR_FAILURE }, "invalid sync state");
    } else {
      // Try resyncing from scratch
      this.offlineStorage.QueryInterface(Ci.calICalendarProvider).deleteCalendar(this.offlineStorage, {
        onDeleteCalendar: (aCalendar, aStatus, aDetail) => {
          if (Components.isSuccessCode(aStatus)) {
            this.setProperty("calendarSyncState", "");
            this.setProperty("tasksSyncState", "");
            this.replayChangesOn(aListener, true);
          } else {
            console.error("[owlCalendar] Error resetting calendar: " + aDetail);
            aListener.onResult({ status: aStatus }, aDetail);
          }
        }
      });
    }
  }
  /**
   * Generic synchronisation function for a specific well-known folder
   *
   * @param folder {String} The well-known folder (either calendar or tasks)
   * @param creationFn {Function} A function to create an updated item
   *   @param aJSON The JSON data to use to create or update the item
   *   @param aEvent An optional existing event to update
   * @returns {Boolean} Whether the sync state was valid
   */
  async syncEvents(folder, creationFn) {
    let oneYearAgo = cal.dtz.jsDateToDateTime(new Date());
    oneYearAgo.year--;
    let promiseStorage = cal.async.promisifyCalendar(this.offlineStorage);
    let result;
    do {
      let delegate = this.uri.filePath.slice(1);
      let syncState = this.getProperty(folder + "SyncState");
      result = await this.callExtension("SyncEvents", { delegate, folder, syncState });
      if (!result) {
        return false;
      }
      let uids, itemids;
      if (!result.deletions || result.deletions.length) {
        if (this.offlineStorage.getAllMetaData) { // COMPAT for TB 68 (bug 1557504)
          let outuids = {}, outitemids = {}; // COMPAT for TB 68 (bug 1557504)
          this.offlineStorage.getAllMetaData({}, outuids, outitemids); // COMPAT for TB 68 (bug 1557504)
          uids = outuids.value; // COMPAT for TB 68 (bug 1557504)
          itemids = outitemids.value; // COMPAT for TB 68 (bug 1557504)
        } else { // COMPAT for TB 68 (bug 1557504)
          uids = this.offlineStorage.getAllMetaDataIds();
          itemids = this.offlineStorage.getAllMetaDataValues();
        } // COMPAT for TB 68 (bug 1557504)
      }
      if (!result.deletions && itemids.length) {
        result.deletions = await this.callExtension("FindDeleted", { itemids });
      }
      if (result.deletions && result.deletions.length) {
        for (let deletion of result.deletions) {
          let index = itemids.indexOf(deletion);
          if (index >= 0) {
            let oldItem = await promiseStorage.getItem(uids[index]);
            if (oldItem.length) {
              await promiseStorage.deleteItem(oldItem[0]);
            }
          }
        }
      }
      // Process items serially so that we can yield to keep the UI responsive.
      for (let event of result.events) {
        // This is actually an array of 0 or 1 old items.
        let oldEvent = await promiseStorage.getItem(event.uid);
        let newEvent = creationFn(event, oldEvent[0]);
        newEvent.calendar = this.superCalendar;
        if (oldEvent[0]) {
          await promiseStorage.modifyItem(newEvent, oldEvent[0]);
        } else {
          // We won't bother adding this event if it's over a year old.
          if (newEvent.recurrenceInfo) {
            // getOccurrencesBetween is expensive for recurring events.
            if (newEvent.recurrenceInfo.getNextOccurrence(oneYearAgo)) {
              await promiseStorage.adoptItem(newEvent);
            }
          } else {
            if (newEvent.getOccurrencesBetween(oneYearAgo, null, /* COMPAT for TB 68 (bug 1557504) */{}).length) {
              await promiseStorage.adoptItem(newEvent);
            }
          }
        }
        this.offlineStorage.setMetaData(event.uid, event.itemid);
        await new Promise(resolve => Services.tm.mainThread.dispatch(resolve, Ci.nsIThread.DISPATCH_NORMAL));
      }
      this.setProperty(folder + "SyncState", result.syncState);
    } while (!result.done);
    return true;
  }
  // calICalendar
  // id handled by base class
  // name handled by base class
  get type() {
    return "owl";
  }
  get providerId() {
    return "owl@beonex.com";
  }
  // aclManager handled by base class
  // aclEntry handled by base class
  // superCalendar handled by base class
  // uri handled by base class
  get readOnly() {
    return this.uri.filePath != "/" || super.readOnly;
  }
  set readOnly(aValue) {
    return super.readOnly = aValue;
  }
  // canRefresh handled by base class
  // transientProperties handled by base class
  getProperty(aName) {
    switch (aName) {
    case "cache.enabled":
    case "cache.always":
      return true;
    case "capabilities.attachments.supported":
      return false;
    case "capabilities.tasks.supported":
      return this.uri.filePath == "/";
    case "itip.transport":
      return this.uri.filePath == "/" ? this : super.getProperty(aName);
    case "imip.identity.key":
      let server = MailServices.accounts.findServerByURI(this.uri, false);
      let identity = MailServices.accounts.getFirstIdentityForServer(server);
      return identity.key;
    case "disabled":
      if (!Calendar.gRegisteredURIs.has(this.uri.prePath)) {
        return true;
      }
      // fall through
    default:
      return super.getProperty(aName);
    }
  }
  // setProperty handled by base class
  // deleteProperty handled by base class
  // addObserver handled by base class
  // removeObserver handled by base class
  async addItem(aEvent, aListener) {
    try {
      if (aEvent.getProperty("STATUS") == "CANCELLED") {
        throw new Error("Cannot create a cancelled event!");
      }
      let event = {};
      let folder = this.getItemFolder(aEvent, event);
      // Check whether we accepted or declined an invitation.
      let newAttendee = this.getInvitedAttendee(aEvent);
      if (newAttendee) {
        event.participation = newAttendee.participationStatus;
      }
      let notify = getNotificationStatus(aEvent);
      let { uid, itemid } = await this.callExtension("CreateEvent", { folder, event, notify } );
      if (aEvent.id != uid) {
        if (aEvent.id) {
          let promiseStorage = cal.async.promisifyCalendar(this.offlineStorage);
          await promiseStorage.deleteItem(aEvent);
        }
        if (!aEvent.isMutable) {
          aEvent = aEvent.clone();
        }
        aEvent.id = uid;
      }
      this.offlineStorage.setMetaData(uid, itemid);
      this.observers.notify("onAddItem", [aEvent]);
      this.notifyOperationComplete(aListener, Cr.NS_OK, Ci.calIOperationListener.ADD, aEvent.id, aEvent);
    } catch (ex) {
      logError(ex);
      this.notifyPureOperationComplete(aListener, ex.result || Cr.NS_ERROR_FAILURE, Ci.calIOperationListener.ADD, aEvent.id, ex.message);
    }
  }
  adoptItem(aEvent, aListener) {
    this.addItem(aEvent, aListener);
  }
  async modifyItem(aNewEvent, aOldEvent, aListener) {
    try {
      let newEvent = {}, oldEvent = {};
      let folder = this.getItemFolder(aNewEvent, newEvent);
      if (folder != this.getItemFolder(aOldEvent, oldEvent)) {
        throw new Error("Modified item must be of the same type");
      }
      oldEvent.itemid = newEvent.itemid = this.offlineStorage.getMetaData(aNewEvent.parentItem.id);
      // If the new item is an instance of a recurring event,
      // then Exchange needs its parent id and recurrence index,
      // which is 1 more than the number of recurring items so far.
      if (aNewEvent.recurrenceId) {
        let [[rule]] = splitRecurrenceRules(aNewEvent.parentItem.recurrenceInfo);
        newEvent.index = rule.QueryInterface(Ci.calIRecurrenceRule).getOccurrences(aNewEvent.parentItem.recurrenceStartDate, aNewEvent.parentItem.recurrenceStartDate, aNewEvent.recurrenceId, 0, /* COMPAT for TB 68 (bug 1602424) */{}).length + 1;
      }
      // Check whether we accepted or declined an invitation.
      for (let newAttendee of aNewEvent.getAttendees(/* COMPAT for TB 68 (bug 1557504) */{})) {
        let oldAttendee = aOldEvent.getAttendeeById(newAttendee.id);
        if (oldAttendee && oldAttendee.participationStatus != newAttendee.participationStatus) {
          newEvent.participation = newAttendee.participationStatus;
        }
      }
      // Check whether anything changed that we support.
      if (JSON.stringify(newEvent) != JSON.stringify(oldEvent)) {
        let notify = getNotificationStatus(aNewEvent);
        await this.callExtension("UpdateEvent", { folder, newEvent, oldEvent, notify } );
      }
      this.observers.notify("onModifyItem", [aNewEvent, aOldEvent]);
      this.notifyOperationComplete(aListener, Cr.NS_OK, Ci.calIOperationListener.MODIFY, aNewEvent.id, aNewEvent);
      if (newEvent.participation == "DECLINED") {
        // Exchange deletes declined invitations on the server.
        // Synchronising is the easiest way to reflect this.
        this.superCalendar.refresh();
      }
      if (aNewEvent.getProperty("STATUS") == "CANCELLED") {
        // Exchange doesn't allow cancelled meetings, so just delete it.
        // Try to delete the item if it's the last occurrence.
        if (aNewEvent == aNewEvent.parentItem) {
          // A non-recurring item.
          this.superCalendar.deleteItem(aNewEvent, null);
        } else if (countOccurrences(aNewEvent.parentItem) == 1) {
          // This is the last recurrence, so might as well delete the parent.
          this.superCalendar.deleteItem(aNewEvent.parentItem, null);
        } else {
          // Create an exception for the recurrence.
          let parentEvent = aNewEvent.parentItem.clone();
          parentEvent.recurrenceInfo.removeOccurrenceAt(aNewEvent.recurrenceId);
          this.superCalendar.modifyItem(parentEvent, aNewEvent.parentItem, null);
        }
      }
    } catch (ex) {
      logError(ex);
      this.notifyPureOperationComplete(aListener, ex.result || Cr.NS_ERROR_FAILURE, Ci.calIOperationListener.MODIFY, aNewEvent.id, ex.message);
    }
  }
  async deleteItem(aEvent, aListener) {
    try {
      let folder = this.getItemFolder(aEvent);
      let id = this.offlineStorage.getMetaData(aEvent.id);
      let notify = getNotificationStatus(aEvent);
      await this.callExtension("DeleteEvent", { folder, id, notify } );
      this.observers.notify("onDeleteItem", [aEvent]);
      this.notifyOperationComplete(aListener, Cr.NS_OK, Ci.calIOperationListener.DELETE, aEvent.id, aEvent);
    } catch (ex) {
      logError(ex);
      this.notifyPureOperationComplete(aListener, ex.result || Cr.NS_ERROR_FAILURE, Ci.calIOperationListener.DELETE, aEvent.id, ex.message);
    }
  }
  getItem(aId, aListener) {
    return this.offlineStorage.getItem(aId, aListener);
  }
  getItems(aFilter, aCount, aRangeStart, aRangeEnd, aListener) {
    return this.offlineStorage.getItems(aFilter, aCount, aRangeStart, aRangeEnd, aListener);
  }
  // refresh handled by base class
  // startBatch handled by base class
  // endBatch handled by base class
  /**
   * Helper function to return the well-known folder for an item.
   *
   * @param aItem {calIItemBase} The item
   * @param aJSON {Object?}      Optional JSON data to be updated
   * @returns     {String}       The well-known folder
   */
  getItemFolder(aItem, aJSON) {
    if (aItem instanceof Ci.calIEvent) {
      if (aJSON) {
        Event2JSON(aItem, aJSON);
      }
      return "calendar";
    }
    aItem.QueryInterface(Ci.calITodo);
    if (aJSON) {
      Task2JSON(aItem, aJSON);
    }
    return "tasks";
  }
}

/// A map of webextensions to the listeners registered with the dispatcher.
Calendar.gListeners = new Map();
/// {Map {origin} -> {nsIMsgIncomingServer}}
Calendar.gRegisteredURIs = new Map();

var gComponentRegistrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
// First try to unregister the factory in case this is a reinstallation.
try {
  let oldFactory = gComponentRegistrar.getClassObject(gCalendarProperties.classID, Ci.nsIFactory);
  gComponentRegistrar.unregisterFactory(gCalendarProperties.classID, oldFactory);
} catch (ex) {
  if (ex.result != Cr.NS_ERROR_FACTORY_NOT_REGISTERED) {
    throw ex;
  }
}
gCalendarProperties.factory = XPCOMUtils._getFactory(Calendar);
gComponentRegistrar.registerFactory(gCalendarProperties.classID, gCalendarProperties.classDescription, gCalendarProperties.contractID, gCalendarProperties.factory);

this.calendar = class extends ExtensionAPI {
  getAPI(context) {
    return {
      calendarProvider: {
        getCurrentInvitation: function() {
          let mainWindow = Services.wm.getMostRecentWindow("mail:3pane");
          return !mainWindow || !mainWindow.gDBView ||
                 mainWindow.gDBView.currentlyDisplayedMessage == nsMsgViewIndex_None ? "" :
                 mainWindow.gDBView.hdrForFirstSelectedMessage.getStringProperty("X-GM-MSGID");
        },
        registerCalendar: function(key) {
          if (cal) {
            try {
              let server = MailServices.accounts.getIncomingServer(key);
              let uri = Services.io.newURI(server.serverURI);
              Calendar.gRegisteredURIs.set(uri.prePath, server);
              reloadCalendars(uri, server);
            } catch (ex) {
              logError(ex);
              throw new ExtensionUtils.ExtensionError(ex.message);
            }
          }
        },
        dispatcher: new ExtensionCommon.EventManager({ context, name: "calendarProvider.dispatcher", register: (listener, scheme) => {
          Calendar.gListeners.set(scheme, listener);
          return () => {
            Calendar.gListeners.delete(scheme);
            for (let [uri, server] of Calendar.gRegisteredURIs) {
              if (server.type == scheme) {
                Calendar.gRegisteredURIs.delete(uri);
              }
            }
          };
        }}).api(),
      }
    };
  }
};
