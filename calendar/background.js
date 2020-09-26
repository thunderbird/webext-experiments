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
});
lightning.items.onUpdated.addListener((item, changeInfo) => {
  console.log("Updated item", item, changeInfo);
});
lightning.items.onRemoved.addListener((calendarId, id) => {
  console.log("Deleted item", id);
});
lightning.items.onAlarm.addListener((item, alarm) => {
  console.log("Alarm item", item, alarm);
});

function icalDate(date) {
  return date.toISOString().replace(/\.\d+Z$/, "").replace(/[:-]/g, "");
}

lightning.provider.onItemCreated.addListener(async (calendar, item) => {
  console.log("Provider add to calendar", item);
  return item;
});
lightning.provider.onItemUpdated.addListener(async (calendar, item, oldItem) => {
  console.log("Provider modify in calendar", item, oldItem);
  return item;
});
lightning.provider.onItemRemoved.addListener(async (calendar, item) => {
  console.log("Provider remove from calendar", item);
});

let ticks = {};
lightning.provider.onSync.addListener(async (calendar) => {
  console.log("Synchronizing", calendar, "tick", ticks[calendar.id]);

  if (!ticks[calendar.id]) {
    ticks[calendar.id] = 0;

    await lightning.items.create(calendar.cacheId, {
      id: "findme",
      type: "event",
      title: "New Event",
      startDate: icalDate(new Date()),
      endDate: icalDate(new Date())
    });
  } else if (ticks[calendar.id] == 1) {
    await lightning.items.update(calendar.cacheId, "findme", {
      title: "Updated",
      startDate: icalDate(new Date()),
      endDate: icalDate(new Date())
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


(async function() {
  let calendar = await lightning.calendars.create({
    type: "ext-" + messenger.runtime.id,
    url: "custom://test",
    name: "calendar ext"
  });
  console.log("create immediate", calendar);

  await lightning.calendars.update(calendar.id, { color: "#FF0000", readOnly: true });

  let calendar2 = await lightning.calendars.get(calendar.id);

  console.log("got calendar", calendar2);

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
    let item = await lightning.items.create(home.id, { type: "event", title: "hello", location: "here", categories: ["Birthdays"] });
    console.log(item, home);

    await lightning.items.update(home.id, item.id, { title: "world" });

    await new Promise(resolve => setTimeout(resolve, 500));

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

  await lightning.calendars.remove(calendar2.id);
})();
