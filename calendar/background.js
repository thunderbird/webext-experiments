/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Tempted to just use `var { calendar } = messenger;`?
// You will find yourself naming function arguments `calendar` way too often.
var { calendar: lightning } = messenger;

lightning.calendars.onCreated.addListener((calendar) => {
  console.log("Created calendar", calendar);
});
lightning.calendars.onUpdated.addListener((calendar, changeInfo) => {
  console.log("Updated calendar", calendar, changeInfo);
});
lightning.calendars.onRemoved.addListener((id) => {
  console.log("Removed calendar", id);
});

lightning.items.onCreated.addListener((item) => {
  console.log("Created item", item);
}, { returnFormat: "ical" });
lightning.items.onUpdated.addListener((item, changeInfo) => {
  console.log("Updated item", item, changeInfo);
}, { returnFormat: "ical" });
lightning.items.onRemoved.addListener((calendarId, id) => {
  console.log("Deleted item", id);
});
lightning.items.onAlarm.addListener((item, alarm) => {
  console.log("Alarm item", item, alarm);
}, { returnFormat: "ical" });

function icalDate(date) {
  return date.toISOString().replace(/\.\d+Z$/, "").replace(/[:-]/g, "");
}

lightning.provider.onItemCreated.addListener(async (calendar, item) => {
  console.log("Provider add to calendar", item);
  item.metadata = { created: true };
  return item;
}, { returnFormat: "ical" });
lightning.provider.onItemUpdated.addListener(async (calendar, item, oldItem) => {
  console.log("Provider modify in calendar", item, oldItem);
  item.metadata = { updated: true };
  return item;
}, { returnFormat: "ical" });
lightning.provider.onItemRemoved.addListener(async (calendar, item) => {
  console.log("Provider remove from calendar", item);
});

let ticks = {};
lightning.provider.onInit.addListener(async (calendar) => {
  console.log("Initializing", calendar);
});
lightning.provider.onSync.addListener(async (calendar) => {
  console.log("Synchronizing", calendar, "tick", ticks[calendar.id]);

  if (!ticks[calendar.id]) {
    ticks[calendar.id] = 0;

    await lightning.items.create(calendar.cacheId, {
      id: "findme",
      type: "event",
      title: "New Event",
      startDate: icalDate(new Date()),
      endDate: icalDate(new Date()),
      metadata: { etag: 123 }
    });
  } else if (ticks[calendar.id] == 1) {
    await lightning.items.update(calendar.cacheId, "findme", {
      title: "Updated",
      startDate: icalDate(new Date()),
      endDate: icalDate(new Date()),
      metadata: { etag: 234 }
    });
  } else if (ticks[calendar.id] == 2) {
    await lightning.calendars.clear(calendar.cacheId);
  } else {
    ticks[calendar.id] = -1;
  }

  ticks[calendar.id]++;
});
lightning.provider.onResetSync.addListener(async (calendar) => {
  console.log("Reset sync for", calendar);
  delete ticks[calendar.id];
});

// TODO - see comment in ext-calendar-provider.js. Provider should be registered after first tick so
// onInit handler has a chance to execute, but before the async function is executed.
setTimeout(async () => {
  let calendars = await lightning.calendars.query({ type: "ext-" + messenger.runtime.id });
  await Promise.all(calendars.map((calendar) => lightning.calendars.remove(calendar.id)));

  let calendar = await lightning.calendars.create({
    type: "ext-" + messenger.runtime.id,
    url: "custom://test",
    name: "calendar ext"
  });
  console.log("create immediate", calendar);

  await lightning.calendars.update(calendar.id, { color: "#FF0000", readOnly: true });

  let calendar2 = await lightning.calendars.get(calendar.id);

  console.log("got calendar", calendar2);

  await lightning.calendars.synchronize();
  await new Promise(resolve => setTimeout(resolve, 500));

  let gotitem = await lightning.items.get(calendar2.id, "findme");
  console.log("Retrieved item", gotitem);

  let gotitems = await lightning.items.query({ calendarId: calendar2.id });
  console.log("Queried all items in calendar", gotitems);

  gotitems = await lightning.items.query({ id: "findme" });
  console.log("Queried all items with id findme", gotitems);

  gotitems = await lightning.items.query({ type: "task" });
  console.log("Queried all tasks (expect empty)", gotitems);

  gotitems = await lightning.items.query({ type: "event" });
  console.log("Queried all events (expect item)", gotitems);

  let rangeStartJs = new Date();
  let rangeEndJs = new Date();

  rangeEndJs.setFullYear(rangeEndJs.getFullYear() - 1);

  gotitems = await lightning.items.query({ rangeEnd: icalDate(rangeEndJs) });
  console.log("Queried past items (expect empty)", gotitems);

  rangeStartJs = new Date();
  rangeEndJs = new Date();
  rangeStartJs.setFullYear(rangeStartJs.getFullYear() - 1);
  rangeEndJs.setFullYear(rangeEndJs.getFullYear() + 1);

  gotitems = await lightning.items.query({ rangeStart: icalDate(rangeStartJs), rangeEnd: icalDate(rangeEndJs) });
  console.log("Queried within year range (expect item)", gotitems);

  let [home, ...rest] = await lightning.calendars.query({ type: "storage" });
  console.log("queried calendars", home, rest);

  if (!home) {
    home = await lightning.calendars.create({
      type: "storage",
      url: "moz-storage-calendar://",
      name: "Home"
    });
  }

  home.enabled = !home.enabled;
  await lightning.calendars.update(home.id, { enabled: home.enabled });

  if (home.enabled) {
    let item = await lightning.items.create(home.id, { type: "event", title: "hello", location: "here", categories: ["Birthdays"], returnFormat: "ical" });
    console.log("Created item", item, home);

    let updated = await lightning.items.update(home.id, item.id, { title: "world" });
    console.log("Updated item", updated);


    await new Promise(resolve => setTimeout(resolve, 500));
    // Moving & Removing
    let home2 = await lightning.calendars.create({
      type: "storage",
      url: "moz-storage-calendar://",
      name: "temp move",
      color: "#00FF00"
    });


    await lightning.items.move(home.id, item.id, home2.id);
    await new Promise(resolve => setTimeout(resolve, 1000));
    await lightning.items.remove(home2.id, item.id);

    await lightning.calendars.remove(home2.id);
  }

  await new Promise(resolve => setTimeout(resolve, 2000));
}, 2000);
