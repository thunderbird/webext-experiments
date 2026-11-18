/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var { ExtensionCommon: { ExtensionAPI } } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");

var { default: ICAL } = ChromeUtils.importESModule("resource:///modules/calendar/Ical.sys.mjs");

var { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");

// COMPAT (TB <= 153 only, not needed on release): This runs in the child
// process, where the timezone service is a fresh instance that Thunderbird's
// own startup never touched. Without startup() the zone list is empty and
// there is no default timezone. Thunderbird 154 (Bug 2022873) moved that work
// into the service's constructor and removed startup(), hence the probe: it
// is a no-op there.
cal.timezoneService.startup?.(null);

this.calendar_timezones = class extends ExtensionAPI {
  getAPI(_context) {
    return {
      calendar: {
        timezones: {
          get timezoneIds() {
            return cal.timezoneService.timezoneIds;
          },
          get currentZone() {
            // COMPAT (TB <= 153 only, not needed on release): There used to be
            // a call to wrappedJSObject._updateDefaultTimezone() here. It
            // throws on TB 154+ (Bug 2022873 made it a #private method), and
            // it is not needed: once the service is running (see startup()
            // above for TB <= 153), it keeps defaultTimezone up to date itself.
            return cal.timezoneService.defaultTimezone?.tzid;
          },
          getDefinition(tzid, returnFormat) {
            const timezoneDatabase = Cc["@mozilla.org/calendar/timezone-database;1"].getService(
              Ci.calITimezoneDatabase
            );
            let zoneInfo = timezoneDatabase.getTimezoneDefinition(tzid);

            if (returnFormat == "jcal") {
              zoneInfo = ICAL.parse(zoneInfo);
            }

            return zoneInfo;
          },
        }
      }
    };
  }
};
