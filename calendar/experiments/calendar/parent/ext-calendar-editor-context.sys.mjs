/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const OPAQUE_EDITOR_ID_PATTERN = /^ed-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BRIDGE_SYMBOL = Symbol("calendar-editor-context-bridge");

function createEditorId() {
  const uuid = Services.uuid.generateUUID().toString().slice(1, -1).toLowerCase();
  return `ed-${uuid}`;
}

export class EditorContextBridge {
  constructor(extension) {
    if (!extension) {
      throw new Error("EditorContextBridge requires an extension");
    }
    this.extension = extension;
    this.targetToEditorId = new Map();
    this.editorIdToTarget = new Map();
  }

  normalizeEditorId(editorId) {
    if (typeof editorId != "string") {
      return "";
    }
    const value = editorId.trim();
    if (!value) {
      return "";
    }
    return OPAQUE_EDITOR_ID_PATTERN.test(value) ? value : "";
  }

  _registerTarget(kind, id, instanceId = 0) {
    if ((kind != "tab" && kind != "dialog") || !Number.isInteger(id) || !Number.isInteger(instanceId)) {
      return "";
    }

    const key = `${kind}:${id}:${instanceId}`;
    const existingId = this.targetToEditorId.get(key);
    if (existingId) {
      return existingId;
    }

    const editorId = createEditorId();
    this.targetToEditorId.set(key, editorId);
    this.editorIdToTarget.set(editorId, { kind, id, instanceId, key });
    return editorId;
  }

  registerTabTarget(tabId, editorOuterId = 0) {
    return this._registerTarget("tab", tabId, editorOuterId);
  }

  registerDialogTarget(dialogOuterId) {
    return this._registerTarget("dialog", dialogOuterId, dialogOuterId);
  }

  resolveTarget(editorId) {
    const normalizedEditorId = this.normalizeEditorId(editorId);
    if (!normalizedEditorId) {
      return null;
    }
    const target = this.editorIdToTarget.get(normalizedEditorId);
    if (!target) {
      return null;
    }
    return { kind: target.kind, id: target.id, instanceId: target.instanceId };
  }

  releaseEditorId(editorId) {
    const normalizedEditorId = this.normalizeEditorId(editorId);
    if (!normalizedEditorId) {
      return;
    }

    const target = this.editorIdToTarget.get(normalizedEditorId);
    if (!target) {
      return;
    }

    this.editorIdToTarget.delete(normalizedEditorId);
    this.targetToEditorId.delete(target.key);
  }

  clear() {
    this.targetToEditorId.clear();
    this.editorIdToTarget.clear();
    if (this.extension[BRIDGE_SYMBOL] == this) {
      delete this.extension[BRIDGE_SYMBOL];
    }
  }
}

export function getEditorContextBridge(extension) {
  if (!extension) {
    throw new Error("Missing extension");
  }
  let bridge = extension[BRIDGE_SYMBOL];
  if (!bridge || !(bridge instanceof EditorContextBridge)) {
    bridge = new EditorContextBridge(extension);
    extension[BRIDGE_SYMBOL] = bridge;
  }
  return bridge;
}
