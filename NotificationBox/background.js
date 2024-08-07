/* global messenger */

// Defining a onButtonClicked listener
messenger.NotificationBox.onButtonClicked.addListener((windowId, notificationId, buttonId) => {
  console.log(`Listener #1 sees: button ${buttonId} clicked in notification ${notificationId} in window ${windowId}.`);
  if (["btn-keep"].includes(buttonId)) {
    console.log("Box will not close, as long as one listener returns {close:false}.");
    return { close: false };
  } else {
    return { close: true };
  }
});

// Defining another onButtonClicked listener
messenger.NotificationBox.onButtonClicked.addListener((windowId, notificationId, buttonId) => {
  console.log(`Listener #2 sees: button ${buttonId} clicked in notification ${notificationId} in window ${windowId}.`);
  if (["btn-direct"].includes(buttonId)) {
    console.log("Box will close as long no listener returns {close:false}.");
  }
});

// Defining a onDismissed listener
messenger.NotificationBox.onDismissed.addListener((windowId, notificationId) => {
  console.log(`notification ${notificationId} in window ${windowId} was dismissed`);
});

// Defining a onClosed listener
messenger.NotificationBox.onClosed.addListener((windowId, notificationId, closedByUser) => {
  console.log(`notification ${notificationId} in window ${windowId} was closed by user: ${closedByUser}`);
});


messenger.menus.create({
  contexts: ["all"],
  icons: {
    16: "icon.png",
    32: "icon.png",
  },
  id: "message",
  title: "Show Notification (message top)",
  visible: true
}, () => {
  console.log("MENU ADDED");
});

messenger.menus.create({
  contexts: ["all"],
  icons: {
    16: "icon.png",
    32: "icon.png",
  },
  id: "top",
  title: "Show Notification (top)",
  visible: true
}, () => {
  console.log("MENU ADDED");
});

messenger.menus.create({
  contexts: ["all"],
  icons: {
    16: "icon.png",
    32: "icon.png",
  },
  id: "bottom",
  title: "Show Notification (bottom)",
  visible: true
}, () => {
  console.log("MENU ADDED");
});

messenger.menus.onClicked.addListener(async (info, tab) => {
  console.log("MENU CLICKED", tab, info);
  await messenger.NotificationBox.create({
    windowId: tab.windowId,
    tabId: tab.id,
    priority: 9,
    label: "NOTIFICATION from MENU",
    icon: "icon.png",
    placement: info.menuItemId,
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
});

async function addBoxes(window) {
  // adding a top box
  await messenger.NotificationBox.create({
    windowId: window.id,
    label: "Sample notification top 1",
    placement: "top",
    priority: messenger.NotificationBox.PRIORITY_WARNING_HIGH,
    style: {
      "color": "blue",
      "font-weight": "bold",
      "font-style": "italic",
      "background-color": "green",
    },
    buttons: [
      {
        id: "btn-direct",
        label: "Close",
        accesskey: "o",
      },
      {
        id: "btn-keep",
        label: "Stay!"
      }
    ]
  });

  // adding a default box
  await messenger.NotificationBox.create({
    windowId: window.id,
    priority: messenger.NotificationBox.PRIORITY_CRITICAL_HIGH,
    label: "Sample notification default 2",
    buttons: [
      {
        id: "btn",
        label: "Close",
        accesskey: "d",
      }
    ]
  });

  // a bottom box
  await messenger.NotificationBox.create({
    windowId: window.id,
    label: "Sample notification bottom 1",
    icon: "icon.png",
    placement: "bottom",
  });
}


// add boxes to all future windows
messenger.windows.onCreated.addListener(addBoxes);

// add boxes to all existing windows
messenger.windows.getAll()
  .then(windows => {
    for (let window of windows) {
      addBoxes(window);
    }
  });

// open a custom window to see notification bars there as well
messenger.windows.create({
  height: 200,
  width: 510,
  type: "popup"
});
