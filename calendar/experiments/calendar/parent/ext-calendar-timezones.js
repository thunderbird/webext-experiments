/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var { ExtensionCommon: { ExtensionAPI, EventManager } } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");

var { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");

this.calendar_timezones = class extends ExtensionAPI {
  getAPI(context) {
    return {
      calendar: {
        timezones: {
          onUpdated: new EventManager({
            context,
            name: "calendar.timezones.onUpdated",
            register: fire => {
              // COMPAT (TB <= 153 only, not needed on release): On TB <= 153
              // the service is an XPCOM service and wrappedJSObject reaches
              // _updateDefaultTimezone(). TB 154 (Bug 2022873) made it a plain
              // ESM singleton and the method #private, so both are gone there
              // and this probe short-circuits. Nothing is lost on 154+, the
              // service observes the same prefs and system timezone topic.
              cal.timezoneService.wrappedJSObject?._updateDefaultTimezone?.();
              let lastValue = cal.timezoneService.defaultTimezone?.tzid;

              const observer = {
                QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
                observe(_subject, _topic, _data) {
                  // COMPAT (TB <= 153 only, not needed on release): Make sure
                  // the default timezone is updated before firing. No-op on
                  // TB 154+, see the note in register() above.
                  cal.timezoneService.wrappedJSObject?._updateDefaultTimezone?.();
                  const currentValue = cal.timezoneService.defaultTimezone?.tzid;
                  if (currentValue != lastValue) {
                    lastValue = currentValue;
                    fire.sync(currentValue);
                  }
                }
              };

              Services.prefs.addObserver("calendar.timezone.useSystemTimezone", observer);
              Services.prefs.addObserver("calendar.timezone.local", observer);
              Services.obs.addObserver(observer, "default-timezone-changed");
              return () => {
                Services.obs.removeObserver(observer, "default-timezone-changed");
                Services.prefs.removeObserver("calendar.timezone.local", observer);
                Services.prefs.removeObserver("calendar.timezone.useSystemTimezone", observer);
              };
            },
          }).api(),
        }
      }
    };
  }
};
