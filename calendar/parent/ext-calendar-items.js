/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var { ExtensionCommon } = ChromeUtils.import("resource://gre/modules/ExtensionCommon.jsm");
var { ExtensionUtils } = ChromeUtils.import("resource://gre/modules/ExtensionUtils.jsm");
var { cal } = ChromeUtils.import("resource:///modules/calendar/calUtils.jsm");

var { ExtensionAPI, EventManager } = ExtensionCommon;
var { ExtensionError } = ExtensionUtils;

/* global getResolvedCalendarById */

function propsToItem(props, baseItem) {
  let item;
  if (baseItem) {
    item = baseItem;
  } else if (props.type == "event") {
    item = cal.createEvent();
    cal.dtz.setDefaultStartEndHour(item);
  } else if (props.type == "task") {
    item = cal.createTodo();
    cal.dtz.setDefaultStartEndHour(item);
  } else {
    throw new ExtensionError("Invalid item type: " + props.type);
  }

  if (props.raw?.use == "ical") {
    item.icalString = props.raw.ical;
  } else {
    if (props.id) {
      item.id = props.id;
    }
    if (props.title) {
      item.title = props.title;
    }
    if (props.description) {
      item.setProperty("description", props.description);
    }
    if (props.location) {
      item.setProperty("location", props.location);
    }
    if (props.categories) {
      item.setCategories(props.categories);
    }

    if (props.type == "event") {
      // TODO need to do something about timezone
      if (props.startDate) {
        item.startDate = cal.createDateTime(props.startDate);
      }
      if (props.endDate) {
        item.endDate = cal.createDateTime(props.endDate);
      }
    } else if (props.type == "task") {
      // entryDate, dueDate, completedDate, isCompleted, duration
    }
  }
  return item;
}

function convertItem(item) {
  let props = { raw: { use: null } };

  if (item instanceof Ci.calIEvent) {
    props.type = "event";
  } else if (item instanceof Ci.calITodo) {
    props.type = "task";
  }

  props.id = item.id;
  props.calendarId = item.calendar.superCalendar.id;
  props.raw.ical = item.icalString;
  props.title = item.title || "";
  props.description = item.getProperty("description") || "";
  props.location = item.getProperty("location") || "";
  props.categories = item.getCategories();

  if (props.type == "event") {
    props.startDate = item.startDate.icalString;
    props.endDate = item.endDate.icalString;
  } else if (props.type == "task") {
    // TODO extra properties
  }

  // TODO metadata

  return props;
}

function convertAlarm(item, alarm) {
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

this.calendar_items = class extends ExtensionAPI {
  getAPI(context) {
    let calmgr = cal.getCalendarManager();

    return {
      calendar: {
        items: {
          get: async function(calendarId, id) {
            let calendar = getResolvedCalendarById(context.extension, calendarId);
            let pcal = cal.async.promisifyCalendar(calendar);
            let item = await pcal.getItem(id);
            return convertItem(item);
          },
          create: async function(calendarId, createProperties) {
            let calendar = getResolvedCalendarById(context.extension, calendarId);
            let pcal = cal.async.promisifyCalendar(calendar);
            let item = propsToItem(createProperties);

            item = await pcal.adoptItem(item);
            return convertItem(item);
          },
          update: async function(calendarId, id, updateProperties) {
            let calendar = getResolvedCalendarById(context.extension, calendarId);
            let pcal = cal.async.promisifyCalendar(calendar);

            let [oldItem] = await pcal.getItem(id);
            if (!oldItem) {
              throw new ExtensionError("Could not find item " + id);
            }
            let newItem = propsToItem(updateProperties, oldItem.clone());
            newItem = await pcal.modifyItem(newItem, oldItem);

            return convertItem(newItem);
          },
          move: async function(fromCalendarId, id, toCalendarId) {
            if (fromCalendarId == toCalendarId) {
              return;
            }

            let fromCalendar = cal.async.promisifyCalendar(calmgr.getCalendarById(fromCalendarId));
            let toCalendar = cal.async.promisifyCalendar(calmgr.getCalendarById(toCalendarId));
            let [item] = await fromCalendar.getItem(id);

            if (!item) {
              throw new ExtensionError("Could not find item " + id);
            }

            await toCalendar.addItem(item);
            await fromCalendar.deleteItem(item);
          },
          remove: async function(calendarId, id) {
            let calendar = getResolvedCalendarById(context.extension, calendarId);
            let pcal = cal.async.promisifyCalendar(calendar);

            let [item] = await pcal.getItem(id);
            if (!item) {
              throw new ExtensionError("Could not find item " + id);
            }
            await pcal.deleteItem(item);
          },

          onCreated: new EventManager({
            context,
            name: "calendar.items.onCreated",
            register: fire => {
              let observer = cal.createAdapter(Ci.calIObserver, {
                onAddItem: item => {
                  fire.sync(convertItem(item));
                },
              });

              cal.getCalendarManager().addCalendarObserver(observer);
              return () => {
                cal.getCalendarManager().removeCalendarObserver(observer);
              };
            },
          }).api(),

          onUpdated: new EventManager({
            context,
            name: "calendar.items.onUpdated",
            register: fire => {
              let observer = cal.createAdapter(Ci.calIObserver, {
                onModifyItem: (newItem, oldItem) => {
                  // TODO calculate changeInfo
                  let changeInfo = {};
                  fire.sync(convertItem(newItem), changeInfo);
                },
              });

              cal.getCalendarManager().addCalendarObserver(observer);
              return () => {
                cal.getCalendarManager().removeCalendarObserver(observer);
              };
            },
          }).api(),

          onRemoved: new EventManager({
            context,
            name: "calendar.items.onRemoved",
            register: fire => {
              let observer = cal.createAdapter(Ci.calIObserver, {
                onDeleteItem: item => {
                  fire.sync(item.calendar.id, item.id);
                },
              });

              cal.getCalendarManager().addCalendarObserver(observer);
              return () => {
                cal.getCalendarManager().removeCalendarObserver(observer);
              };
            },
          }).api(),

          onAlarm: new EventManager({
            context,
            name: "calendar.items.onAlarm",
            register: fire => {
              let observer = {
                QueryInterface: ChromeUtils.generateQI(["calIAlarmServiceObserver"]),
                onAlarm(item, alarm) {
                  fire.sync(convertItem(item), convertAlarm(item, alarm));
                },
                onRemoveAlarmsByItem(item) {},
                onRemoveAlarmsByCalendar(calendar) {},
                onAlarmsLoaded(calendar) {},
              };

              let alarmsvc = Cc["@mozilla.org/calendar/alarm-service;1"].getService(
                Ci.calIAlarmService
              );

              alarmsvc.addObserver(observer);
              return () => {
                alarmsvc.removeObserver(observer);
              };
            },
          }).api(),
        },
      },
    };
  }
};
