Cloudfile WebExtension Experiment
=================================

This experiment allows defining a Cloudfile Provider as a WebExtension and is being implemented in
[bug 1481052](https://bugzilla.mozilla.org/show_bug.cgi?id=1481052). It also shows how to bundle an
add-on together with its experiment, as this is at the same time a copy of the WeTransfer Cloudfile
add-on that makes use of the API.

Please note that the WeTransfer add-on copied here may be out of date, as it is developed in another
respository. You should concentrate on the WebExtension Experiment API when looking at this example.

| Item          | Value
| ------------- | --------
| Description   | Experiment with add-on exposing the Cloudfile feature
| Status        | Accepted
| Compatibility | Thunderbird 63
| Tracking      | [bug 1481052](https://bugzilla.mozilla.org/show_bug.cgi?id=1481052)

Provided API
------------

The complete API definition can be inspected in the [schema.json](cloudfile-api/schema.json). This
experiment defines a manifest entry, a few events, and a few methods.

### Manifest Entry

The following manifest.json entry loads the cloud file provider. The `settings_url` and
`management_url` are loaded from the add-on itself, the others are links used in Thunderbird. The
fields `name`, `settings_url` and `management_url` can also be localized. The fields `service_url`,
`new_account_url` are optional.

```json
{
  "cloudfile": {
    "name": "WeTransfer",
    "service_url": "https://wetransfer.com",
    "new_account_url": "https://wetransfer.com/signup",
    "settings_url": "/content/moments.html",
    "management_url": "/content/moments.html"
  }
}
```

### Events

Here is an example on how to use the events of the cloudfile API. You can also see a more practical
example in the code in this directory.

```javascript
browser.cloudfile.onUploadFile.addListener(async (details, abortSignal) => {
  // Called when a file is uploaded, and can asynchronously complete when the file is uploaded.
  // The details object contains:
  //
  // id {Number}          The unique id for this cloud file
  // name {String}        The file name
  // data {ArrayBuffer}   A buffer with the file data
  //
  // The abortSignal parameter is an AbortSignal that will be called if the upload is canceled, it
  // can be passed on to the fetch() API for example.

  return { url: "http://example.com/" + details.id };
});

browser.cloudfile.onDeleteFile.addListener((fileId) => {
  // Called when the file with the given id should be deleted. You are on your own to track which
  // file ids belong to which uploaded files, the ids are not unique over restarts.
});

```

### Methods

The methods for this API are quota related. Here is how to use them:

```javascript
// Sets the quotas for the provider, as well as used and remaining space.
// Use -1 in case a member is unlimited or unsupported.
browser.cloudfile.setQuota({
  uploadSizeLimit: TWO_GB,
  spaceRemaining: -1,
  spaceUsed: 40000
});

// An example on how to use the getQuota() method. It returns a promise resolving with an object
// using the same keys as above.
(async function() {
  let quota = await browser.cloudfile.getQuota();
  quota.spaceRemaining--;
  quota.spaceUsed++;
  await browser.cloudfile.setQuota(quota);
})();
```
