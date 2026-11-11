// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";

const collections = new Set(["jobs", "deliveries"]);
const keyFor = (kind, id) => JSON.stringify([kind, String(id)]);
const object = value => value && typeof value === "object";
const plain = value => object(value) && (Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const own = (value, key) => Object.hasOwn(value, key);

class StateRecords {
  constructor(data, { replace = false } = {}) {
    this.raw = data;
    this.replace = replace;
    this.proxies = new WeakMap(); this.targets = new WeakMap(); this.owners = new WeakMap();
    this.containers = new WeakMap(); this.dirty = new Set(); this.kinds = new Set(); this.layoutDirty = new Set(); this.layouts = new Map();
    for (const [kind, value] of Object.entries(data)) {
      this.registerKind(kind, value);
      if (collections.has(kind) && !replace) this.layouts.set(kind, this.layout(value));
      if (replace) this.kinds.add(kind);
    }
    this.data = new Proxy(data, {
      get: (target, key) => this.container(target[key], key),
      set: (target, key, value) => {
        value = this.unwrap(value);
        if (own(target, key) && Object.is(target[key], value)) return true;
        target[key] = value; this.registerKind(key, value);
        if (collections.has(key)) this.layoutDirty.add(key); else this.kinds.add(key);
        return true;
      },
      deleteProperty: (target, key) => { delete target[key]; this.kinds.add(key); return true; },
    });
  }

  unwrap(value) { return this.targets.get(value) || value; }
  register(value, owner, seen = new WeakSet()) {
    value = this.unwrap(value);
    if (!plain(value) || seen.has(value)) return;
    seen.add(value);
    let owners = this.owners.get(value);
    if (!owners) this.owners.set(value, owners = new Set());
    owners.add(owner);
    for (const key of Object.keys(value)) {
      const child = this.unwrap(value[key]);
      if (child !== value[key]) value[key] = child;
      this.register(child, owner, seen);
    }
  }
  registerKind(kind, value) {
    if (collections.has(kind)) {
      if (!Array.isArray(value)) throw Error("State collection must be an array");
      for (const item of value) {
        const raw = this.unwrap(item);
        if (!object(raw) || raw.id === undefined) throw Error("State collection entry requires an id");
        this.register(raw, keyFor(kind, raw.id));
      }
      // Arrays produced by filter/slice may contain record proxies.
      for (let i = 0; i < value.length; i++) value[i] = this.unwrap(value[i]);
    } else if (object(value) && !Array.isArray(value)) {
      for (const key of Object.keys(value)) {
        value[key] = this.unwrap(value[key]); this.register(value[key], keyFor(kind, key));
      }
    } else this.register(value, keyFor("$values", kind));
  }
  changed(target, key, value) {
    for (const owner of this.owners.get(target) || []) {
      this.dirty.add(owner);
      if (key === "id" && collections.has(JSON.parse(owner)[0])) this.layoutDirty.add(JSON.parse(owner)[0]);
      this.register(value, owner);
    }
  }
  record(value) {
    value = this.unwrap(value);
    if (!plain(value)) return value;
    if (!this.proxies.has(value)) {
      const proxy = new Proxy(value, {
        get: (target, key, receiver) => {
          const child = this.unwrap(Reflect.get(target, key, receiver));
          // ||= returns a raw container; its later children inherit ownership when read.
          if (plain(child)) for (const owner of this.owners.get(target) || []) {
            if (!this.owners.get(child)?.has(owner)) this.register(child, owner);
          }
          return this.record(child);
        },
        set: (target, key, next) => {
          next = this.unwrap(next);
          if (own(target, key) && Object.is(target[key], next)) return true;
          Reflect.set(target, key, next); this.changed(target, key, next); return true;
        },
        deleteProperty: (target, key) => { const result = Reflect.deleteProperty(target, key); this.changed(target, key); return result; },
        defineProperty: (target, key, descriptor) => {
          if ("value" in descriptor) descriptor.value = this.unwrap(descriptor.value);
          const result = Reflect.defineProperty(target, key, descriptor); this.changed(target, key, descriptor.value); return result;
        },
      });
      this.proxies.set(value, proxy); this.targets.set(proxy, value);
    }
    return this.proxies.get(value);
  }
  container(value, kind) {
    if (!object(value)) return value;
    if (!collections.has(kind) && Array.isArray(value)) return this.record(value);
    let cache = this.containers.get(value);
    if (!cache) this.containers.set(value, cache = new Map());
    if (!cache.has(kind)) {
      const changed = (key, next) => {
        if (collections.has(kind)) {
          this.layoutDirty.add(kind);
          if (object(next) && next.id !== undefined) this.register(next, keyFor(kind, next.id));
        } else { const owner = keyFor(kind, key); this.dirty.add(owner); this.register(next, owner); }
      };
      const proxy = new Proxy(value, {
        get: (target, key, receiver) => {
          const child = this.unwrap(Reflect.get(target, key, receiver));
          if (plain(child) && own(target, key)) {
            const id = collections.has(kind) ? child.id : key;
            if (id !== undefined && !this.owners.get(child)?.has(keyFor(kind, id))) this.register(child, keyFor(kind, id));
          }
          return this.record(child);
        },
        set: (target, key, next) => {
          next = this.unwrap(next);
          if (own(target, key) && Object.is(target[key], next)) return true;
          Reflect.set(target, key, next); changed(key, next); return true;
        },
        deleteProperty: (target, key) => { const result = Reflect.deleteProperty(target, key); changed(key); return result; },
        defineProperty: (target, key, descriptor) => {
          if ("value" in descriptor) descriptor.value = this.unwrap(descriptor.value);
          const result = Reflect.defineProperty(target, key, descriptor); changed(key, descriptor.value); return result;
        },
      });
      cache.set(kind, proxy); this.targets.set(proxy, value);
    }
    return cache.get(kind);
  }
  layout(value) {
    const rows = new Map();
    for (const [index, item] of value.entries()) {
      if (!object(item) || item.id === undefined) throw Error("State collection entry requires an id");
      const id = String(item.id);
      if (rows.has(id)) throw Error("Duplicate state collection identity");
      rows.set(id, { index, value: this.unwrap(item) });
    }
    return rows;
  }
  changes(previous) {
    const dirty = new Set(this.dirty), layouts = new Map(this.layouts);
    if (this.replace) for (const key of previous.keys()) dirty.add(key);
    for (const kind of this.kinds) {
      const value = this.raw[kind];
      const scalar = !collections.has(kind) && (!object(value) || Array.isArray(value));
      if ((scalar || !own(this.raw, kind)) && !previous.has(keyFor("$types", kind))) {
        dirty.add(keyFor("$values", kind)); continue;
      }
      for (const key of previous.keys()) {
        const [group, id] = JSON.parse(key);
        if (group === kind || group.startsWith("$") && id === kind) dirty.add(key);
      }
      if (collections.has(kind)) this.layoutDirty.add(kind);
      if (!own(this.raw, kind)) continue;
      if (collections.has(kind)) this.layoutDirty.add(kind);
      else if (object(value) && !Array.isArray(value)) {
        dirty.add(keyFor("$types", kind));
        for (const key of Object.keys(value)) dirty.add(keyFor(kind, key));
      } else dirty.add(keyFor("$values", kind));
    }
    for (const kind of this.layoutDirty) {
      const next = own(this.raw, kind) ? this.layout(this.raw[kind]) : new Map(), prior = this.layouts.get(kind) || new Map();
      for (const [id, row] of next) {
        if (prior.get(id)?.value !== row.value) this.register(row.value, keyFor(kind, id));
        if (prior.get(id)?.index !== row.index || prior.get(id)?.value !== row.value) dirty.add(keyFor(kind, id));
      }
      for (const id of prior.keys()) if (!next.has(id)) dirty.add(keyFor(kind, id));
      dirty.add(keyFor("$types", kind)); layouts.set(kind, next);
    }
    const changes = [];
    for (const key of dirty) {
      const [kind, id] = JSON.parse(key);
      let value;
      if (kind === "$types") {
        if (own(this.raw, id)) value = collections.has(id) ? "array" : object(this.raw[id]) && !Array.isArray(this.raw[id]) ? "object" : undefined;
      } else if (kind === "$values") {
        if (own(this.raw, id) && !collections.has(id) && (!object(this.raw[id]) || Array.isArray(this.raw[id]))) value = this.raw[id];
      } else if (collections.has(kind) && own(this.raw, kind)) value = layouts.get(kind)?.get(id);
      else if (object(this.raw[kind]) && !Array.isArray(this.raw[kind]) && own(this.raw[kind], id)) value = this.raw[kind][id];
      const payload = value === undefined ? null : JSON.stringify(value);
      if (payload === null ? previous.has(key) : previous.get(key) !== payload) changes.push({ key, payload });
    }
    return { changes, commit: () => { this.layouts = layouts; this.dirty.clear(); this.kinds.clear(); this.layoutDirty.clear(); this.replace = false; } };
  }
}
module.exports = { StateRecords };
