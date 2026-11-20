const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only placement lives here. Terminals and all device access remain backend-owned.
class WorkspaceTabs {
  constructor(directory) {
    this.file = path.join(directory, "window-tabs.json");
    this.groups = new Map([["main", []]]);
    this.home = "main";
    this.bounds = {};
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const groups = new Map();
      const seen = new Set();
      for (const [key, tabs] of saved.groups) {
        if (
          (key !== "main" && !uuid.test(key)) ||
          groups.has(key) ||
          !Array.isArray(tabs)
        )
          return;
        for (const id of tabs) {
          if (!uuid.test(id) || seen.has(id)) return;
          seen.add(id);
        }
        groups.set(key, tabs);
      }
      if (groups.has(saved.home)) {
        this.groups = groups;
        this.home = saved.home;
        for (const key of groups.keys()) {
          const b = saved.bounds?.[key];
          if (
            b &&
            [b.x, b.y, b.width, b.height].every(Number.isSafeInteger) &&
            b.width > 0 &&
            b.height > 0
          )
            this.bounds[key] = {
              x: b.x,
              y: b.y,
              width: b.width,
              height: b.height,
            };
        }
      }
    } catch {
      /* First launch or incomplete configuration. */
    }
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      fs.writeFileSync(
        tmp,
        JSON.stringify({
          home: this.home,
          groups: [...this.groups],
          bounds: this.bounds,
        }),
        { mode: 0o600 },
      );
      fs.renameSync(tmp, this.file);
    } catch {
      console.warn("Could not save Harbor window layout");
    }
  }
  add() {
    const key = randomUUID();
    this.groups.set(key, []);
    this.save();
    return key;
  }
  owner(id) {
    for (const [key, tabs] of this.groups) if (tabs.includes(id)) return key;
    return this.home;
  }
  snapshot(key) {
    return {
      key,
      home: this.home,
      own: this.groups.get(key) || [],
      other: [...this.groups]
        .filter(([id]) => id !== key)
        .flatMap(([, tabs]) => tabs),
    };
  }
  created(id, key) {
    if (
      !uuid.test(id) ||
      !this.groups.has(key) ||
      [...this.groups.values()].some((tabs) => tabs.includes(id))
    )
      return false;
    this.groups.get(key).push(id);
    this.save();
    return true;
  }
  move(id, target, before, inventory) {
    if (!this.groups.has(target) || !inventory.includes(id)) return false;
    if (before && this.owner(before) !== target) return false;
    // Another move may already have assigned a terminal created after
    // this request's inventory was read. Never delete another assignment here.
    const known = new Set([...this.groups.values()].flat());
    this.groups.get(this.home).push(...inventory.filter((t) => !known.has(t)));
    if (id !== before) {
      const source = this.groups.get(this.owner(id));
      source.splice(source.indexOf(id), 1);
      const dest = this.groups.get(target);
      const index = dest.indexOf(before);
      dest.splice(index < 0 ? dest.length : index, 0, id);
    }
    this.save();
    return true;
  }
  prune(inventory) {
    const valid = new Set(inventory);
    for (const [key, tabs] of this.groups)
      this.groups.set(
        key,
        tabs.filter((id) => valid.has(id)),
      );
    this.save();
  }
  close(key) {
    if (this.groups.size < 2 || !this.groups.has(key)) return;
    const tabs = this.groups.get(key);
    this.groups.delete(key);
    delete this.bounds[key];
    if (key === this.home) this.home = this.groups.keys().next().value;
    this.groups.get(this.home).push(...tabs);
    this.save();
  }
}
module.exports = { WorkspaceTabs };
