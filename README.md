Thunderbird WebExtension Experiments
====================================
Thunderbird is providing APIs similar to Firefox's WebExtensions. There is overlapping API for commonly
used elements like windows and tabs, but there also have to be Thunderbird-specific APIs, for example
to provide access to E-Mails or Calendar. These APIs are sometimes referred to as *MailExtension APIs*.
There is an ongoing effort to integrate more such APIs into Thunderbird.

Experiment APIs are WebExtension APIs whose implementation is part of the add-on, enabling features
which are not yet provided by Thunderbird's own APIs. This repository provides Experiments which
could be useful to add-on developers. These Experiments also serve as examples for add-on developers
wanting to create their own APIs.

Furthermore, this repository tracks progress of Experiments, which aim to be added to Thunderbird.

API Experiments
---------------
The following WebExtension Experiments are available in this repository.

| Name                                  | Author                                      | Description
| ------------------------------------- | ------------------------------------------- | --------------
| [calendar](./calendar/)               | [@kewisch](https://github.com/kewisch/)     | Draft for calendar-related APIs in Thunderbird
| [NotificationBox](./NotificationBox/) | [@jobisoft](https://github.com/jobisoft/)   | Draft for an API to show notifications inside Thunderbird


Contributions Welcome!
----------------------
We would like to encourage add-on developers to contribute their APIs, so they can be discussed to
become part of core Thunderbird.

When creating a new API, please start with [the documentation on WebExtension
Experiments](https://developer.thunderbird.net/add-ons/mailextensions/experiments). You can also read
the code of already implemented [Thunderbird
WebExtension APIs](https://searchfox.org/comm-central/source/mail/components/extensions/), which will
provide further examples.

If you have an idea for an API that you think would be worthwhile, please file an issue on this
repository. We are open to general ideas, but if you have a suggestion for specific API methods and
events we would also enjoy your input. Please make sure to read the design principles when filing a
new issue.

### Design Principles
WebExtension APIs are meant to provide a stable API for add-on developers to use, while at the same
time hiding the details and allowing the Thunderbird team to clean up and change the underlying
code. The following principles should be kept in mind when devising new APIs:

* The APIs should not expose Thunderbird features that are too specific, or subject to change.
  Providing WebExtension APIs is a long term commitment.

* The APIs should be very high level. We are looking for "access to address books and cards", not
  "access to the xpcom address book service and its technical properties".

* APIs should not rely on technical implementation details of the underlying XPCOM components. There
  should be no magic numbers (use constant ls and enums), and try to anticipate how future additions
  would be least disruptive to the existing API.

* The UI exposed to WebExtensions should be limited to properties we can support long term, and are,
  if possible, easy to separate. A sidebar or toolbar button is perfect, adding arbitrary content to
  the message header not so much.

* To extend the previous point, we'd like to be careful when replacing built-in UI. A button in the
  quick search toolbar is great, but replacing the whole quick search bar with custom UI would need
  a special mechanism (like `chrome_settings_override`) and it should be evaluated if there isn't a
  better way to achieve the same result.

### Submitting a Pull Request
Generally it is a good idea to file an issue to discuss your API first. If you've already done so or
would like to submit your API experiment for inclusion in this repository, please make sure you have
completed the following:

* The API follows the design principles laid out in this README.
* The API code must be made available under the terms of the
  [Mozilla Public License 2.0](https://www.mozilla.org/en-US/MPL/2.0/).
* The API code is contained in a sub directory and passes the [eslint configuration](.eslintrc.js).
* There is a reference to the API in this README file, along with a short description.

Each experiment should also contain this table to summarize common information. Not everything needs
to be filled in from the start, but it will help over the course of the experiment.

| Item          | Value
| ------------- | --------
| Description   | API providing access to the address book
| Status        | Draft
| Compatibility | Thunderbird 63
| Tracking      | [issue #1](https://github.com/thundernest/tb-web-ext-experiments/issues/1) / [bug 1396172](https://bugzilla.mozilla.org/show_bug.cgi?id=1396172)

Valid status values are:
* `Draft`: Initial commit, discussing design in linked github issue. Depending on the nature of the Experiment, it may not get past this state.
* `Accepted`: API Experiment accepted for Thunderbird Core, bug is filed to integrate into comm-central.
* `Nightly`: API Experiment landed in nightly builds, compatibility field should be "Since Thunderbird NN".
* `Release`: API Experiment is available in release builds, compatibility field should be "Since Thunderbird NN".

The compatibility field shows what versions the API Experiment was designed for. If you are working
on it in nightly, please be sure to set/update the respective nightly version. If you are sure it
also works for a range of nightlies, you can also add a range.

### Getting in touch
If you have questions about WebExtension Experiments in Thunderbird, you can reach us through our
official [communication channels](https://developer.thunderbird.net/add-ons/community). We are happy
to tell you more about how they work, and engage in some ad-hoc discussion on how to design WebExtension
APIs.

Migrating from Legacy Add-ons
-----------------------------
If you are migrating your legacy add-on to WebExtensions, you may need to rethink how your UI is
presented, possibly in a way that seems less integrated. It may also mean that certain features will
not be possible in the future. While this is unfortunate, we need to strike a balance between
exposing all of the features the Mozilla Platform has to offer and making the APIs simple to
maintain.

We are not doing this to limit creativity, but to ensure Thunderbird can thrive and add-ons are
resilient to changes in Thunderbird and the Mozilla Platform. The goal is to keep WebExtension compatible
with future versions of Thunderbird despite far-reaching internal changes.
