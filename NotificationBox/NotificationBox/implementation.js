/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
 
/* global ExtensionCommon, Services */

// Tested in Thunderbird 128. Does not work for older versions of Thunderbird.

"use strict";

// Using a closure to not leak anything but the API to the outside world.
(function(exports) {
  var { EventEmitter, EventManager, ExtensionAPI } = ExtensionCommon;

  class ExtensionNotification {
    constructor(notificationId, properties, parent) {
      this.closedByUser = true;
      this.properties = properties;
      this.parent = parent;
      this.notificationId = notificationId;
    }

    async append() {
      const { buttons, icon, label, priority, style, windowId } = this.properties;

      const iconURL =
        icon && !icon.includes(":")
          ? this.parent.extension.baseURI.resolve(icon)
          : null;

      const buttonSet = buttons.map(({ id, label: _label, accesskey }) => ({
        id,
        label: _label,
        accesskey,
        callback: () => {
          // Fire the event and keep the notification open, decided to close it
          // based on the return values later.
          this.parent.emitter
            .emit("buttonclicked", windowId, this.notificationId, id)
            .then((rv) => {
              let keepOpen = rv.some((value) => value?.close === false);
              if (!keepOpen) {
                this.remove(/* closedByUser */ true);
              }
            });

          // Keep the notification box open until we hear from the event
          // handlers.
          return true;
        },
      }));

      const getContainerElement = (element) => {
        // Supernova introduced a container element in TB112.
        return element.shadowRoot.querySelector(".container");
      };

      const notificationBarCallback = (event) => {
        // Every dismissed notification will also generate a removed notification
        if (event === "dismissed") {
          this.parent.emitter.emit("dismissed", windowId, this.notificationId);
        }

        if (event === "removed") {
          this.parent.emitter.emit(
            "closed",
            windowId,
            this.notificationId,
            this.closedByUser
          );

          this.cleanup();
        }
      };

      let element = await this.getNotificationBox().appendNotification(
        `extension-notification-${this.notificationId}`,
        {
          label,
          priority,
          eventCallback: notificationBarCallback,
        },
        buttonSet,
      );

      if (!element) { return; }

      const allowedCssPropNames = [
        "background",
        "color",
        "margin",
        "padding",
        "font",
      ];

      let containerElement = getContainerElement(element);
      if (style) {
        const sanitizedStyles = Object.keys(style).filter((cssPropertyName) => {
          const parts = cssPropertyName.split("-");
          return (
            // check if first part is in whitelist
            !!parts.length &&
            allowedCssPropNames.includes(parts[0]) &&
            // validate second part (if any) being a simple word
            (parts.length == 1 ||
              (parts.length == 2 && /^[a-zA-Z0-9]+$/.test(parts[1])))
          );
        });

        for (let cssPropertyName of sanitizedStyles) {
          element.style[cssPropertyName] = style[cssPropertyName];
          if (containerElement) {
            containerElement.style[cssPropertyName] = style[cssPropertyName];
          }
        }
      }

      if (iconURL) {
        let iconContainer = containerElement.querySelector(".icon-container");
        let iconElement = iconContainer.querySelector("img");
        iconElement.remove();

        const win = this.parent.extension.windowManager.get(
          this.properties.windowId,
          this.parent.context
        ).window;
        const img = win.document.createElement("img");
        img.style.padding = "4px"; // alternatively set icon class and remove content
        img.setAttribute("src", iconURL);
        img.setAttribute("draggable", "false");
        img.setAttribute("width", "16");
        img.setAttribute("height", "16");
        img.setAttribute("alt", label);
        iconContainer.appendChild(img);
      }
    }

    getNotificationBox() {
      const win = this.parent.extension.windowManager.get(
        this.properties.windowId,
        this.parent.context
      ).window;
      switch (this.properties.placement) {
        case "top":
          if (!win.gExtensionNotificationTopBox) {
            const messengerBody = win.document.getElementById("messengerBody");
            const toolbox = win.document.querySelector("toolbox");
            if (messengerBody) {
              win.gExtensionNotificationTopBox = new win.MozElements.NotificationBox(
                (element) => {
                  element.id = "extension-notification-top-box";
                  element.setAttribute("notificationside", "top");
                  messengerBody.insertBefore(
                    element,
                    messengerBody.firstChild
                  );
                }
              );
            } else if (toolbox) {
              win.gExtensionNotificationTopBox = new win.MozElements.NotificationBox(
                (element) => {
                  element.id = "extension-notification-top-box";
                  element.setAttribute("notificationside", "top");
                  element.style.marginInlineStart = "var(--spaces-total-width)";
                  toolbox.insertAdjacentElement(
                    "afterend", element
                  );
                }
              );
            } else {
              win.gExtensionNotificationTopBox = new win.MozElements.NotificationBox(
                (element) => {
                  element.id = "extension-notification-top-box";
                  element.setAttribute("notificationside", "top");
                  win.document.documentElement.insertBefore(
                    element,
                    win.document.documentElement.firstChild
                  );
                }
              );
            }
          }
          return win.gExtensionNotificationTopBox;

        case "message": {
          if (!this.properties.tabId) {
            throw new Error("appendNotification - missing tab id");
          }
          const aTab = this.parent.context.extension.tabManager.get(this.properties.tabId);
          let messageBrowser = null;
          switch (aTab.nativeTab.mode?.name) {
            case "mailMessageTab":
              // message tab;
              messageBrowser = aTab.nativeTab.chromeBrowser.contentWindow;
              break;
            case "mail3PaneTab":
              // message in mail3pane tab
              messageBrowser = aTab.nativeTab.chromeBrowser.contentWindow.messageBrowser.contentWindow;
              break;
            default:
              // message window;
              messageBrowser = aTab.nativeTab.messageBrowser.contentWindow;
              break;
          }
          if (messageBrowser) {
            return messageBrowser.gMessageNotificationBar.msgNotificationBar;
          }
          console.error("appendNotification - could not get window for tabId " + this.properties.tabId);
          return null;
        }

        default:
        case "bottom":
          // default bottom notification in the mail3:pane
          if (win.specialTabs) {
            return win.specialTabs.msgNotificationBar;
          }
          // default bottom notification in message composer window and
          // most calendar dialogs (currently windows.onCreated event does not see these)
          if (win.gNotification) {
            return win.gNotification.notificationbox;
          }
          // if there is no default bottom box, use our own
          if (!win.gExtensionNotificationBottomBox) {
            let statusbar = win.document.querySelector('[class~="statusbar"]');
            win.gExtensionNotificationBottomBox = new win.MozElements.NotificationBox(
              (element) => {
                element.id = "extension-notification-bottom-box";
                element.setAttribute("notificationside", "bottom");
                if (statusbar) {
                  statusbar.parentNode.insertBefore(element, statusbar);
                } else {
                  win.document.documentElement.append(element);
                }
              }
            );
          }
          return win.gExtensionNotificationBottomBox;
      }
    }

    remove(closedByUser) {
      // The remove() method is called by button clicks and by notificationBox.clear()
      // but not by dismissal. In that case, the default value defined in the constructor
      // defines the value of closedByUser which is used by the event emitter.
      this.closedByUser = closedByUser;
      const notificationBox = this.getNotificationBox();
      const notification = notificationBox.getNotificationWithValue(
        `extension-notification-${this.notificationId}`
      );
      notificationBox.removeNotification(notification);
    }

    cleanup() {
      this.parent.notificationsMap.delete(this.notificationId);
    }
  }

  var NotificationBox = class extends ExtensionAPI {
    constructor(extension) {
      super(extension);
      this.notificationsMap = new Map();
      this.emitter = new EventEmitter();
      this.nextId = 1;
      Services.obs.addObserver(this, "domwindowclosed");
    }

    onShutdown() {
      Services.obs.removeObserver(this, "domwindowclosed");
      for (let notification of this.notificationsMap.values()) {
        notification.remove(/* closedByUser */ false);
      }
    }

    // Observer for the domwindowclosed notification, to remove
    // obsolete notifications from the notificationsMap.
    observe(aSubject) {
      let win = this.context.extension.windowManager.convert(aSubject);
      this.notificationsMap.forEach((value, key) => {
        if (value.properties.windowId == win.id) {
          this.notificationsMap.delete(key);
        }
      });
    }

    getAPI(context) {
      this.context = context;
      const self = this;

      return {
        NotificationBox: {
          async create(properties) {
            const notificationId = self.nextId++;
            const extensionNotification = new ExtensionNotification(notificationId, properties, self);
            self.notificationsMap.set(
              notificationId,
              extensionNotification,
            );
            await extensionNotification.append();
            return notificationId;
          },

          async clear(notificationId) {
            if (self.notificationsMap.has(notificationId)) {
              self.notificationsMap
                .get(notificationId)
                .remove(/* closedByUser */ false);
              return true;
            }
            return false;
          },

          async getAll() {
            const result = {};
            self.notificationsMap.forEach((value, key) => {
              result[key] = value.properties;
            });
            return result;
          },

          onDismissed: new EventManager({
            context,
            name: "NotificationBox.onDismissed",
            register: (fire) => {
              const listener = (event, windowId, notificationId) =>
                fire.async(windowId, notificationId);

              self.emitter.on("dismissed", listener);
              return () => {
                self.emitter.off("dismissed", listener);
              };
            },
          }).api(),

          onClosed: new EventManager({
            context,
            name: "NotificationBox.onClosed",
            register: (fire) => {
              const listener = (event, windowId, notificationId, closedByUser) =>
                fire.async(windowId, notificationId, closedByUser);

              self.emitter.on("closed", listener);
              return () => {
                self.emitter.off("closed", listener);
              };
            },
          }).api(),

          onButtonClicked: new EventManager({
            context,
            name: "NotificationBox.onButtonClicked",
            register: (fire) => {
              const listener = (event, windowId, notificationId, buttonId) =>
                fire.async(windowId, notificationId, buttonId);

              self.emitter.on("buttonclicked", listener);
              return () => {
                self.emitter.off("buttonclicked", listener);
              };
            },
          }).api(),
        },
      };
    }
  };

  // Export the api by assigning in to the exports parameter of the anonymous
  // closure function, which is the global this.
  exports.NotificationBox = NotificationBox;
})(this);
