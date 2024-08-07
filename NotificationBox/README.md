NotificationBox MailExtension Experiment
========================================

The NotificationBox Experiment allows to show notifications inside Thunderbird.

| Item          | Value
| ------------- | --------
| Description   | Experiment to show notifications inside Thunderbird
| Status        | Draft
| Compatibility | Thunderbird 128
| Tracking      | [bug 1674002](https://bugzilla.mozilla.org/show_bug.cgi?id=1674002)

Usage
-----

Add the NotificationBox Experiment to your add-on. Your `manifest.json` needs an entry like this:

```
"experiment_apis": {
    "NotificationBox": {
      "schema": "NotificationBox/schema.json",
      "parent": {
        "scopes": [
          "addon_parent"
        ],
        "paths": [
          [
            "NotificationBox"
          ]
        ],
        "script": "NotificationBox/implementation.js"
      }
    }
  }
```

Simple example
--------------

The `NotificationBox.create()` method supports multiple options, see the [schema definition](./NotificationBox/schema.json) of the `NotificationProperties` type for details:

```
  await messenger.NotificationBox.create({
    windowId: tab.windowId,
    tabId: tab.id,
    priority: 9,
    label: "Custom NOTIFICATION",
    icon: "icon.png",
    placement: "bottom",
    style: {
      "color": "blue",
      "font-weight": "bold",
      "font-style": "italic",
      "background-color": "green",
    },
    buttons: [
      {
        id: "button1",
        label: "Button 1"
      }
    ]
  });
```

