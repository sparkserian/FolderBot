// Checks that the userData JSON files survive the interruptions that actually happen:
// a force-kill mid-write, a truncated document, and outright garbage.
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { readJsonArrayFile, writeJsonFileAtomic, readJsonObjectFile } = await import(
  path.join(here, "..", "dist-electron", "main", "json-file.js")
);

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fb-"));
let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  ok  ", name); }
  else { fail++; console.log("  FAIL", name, extra); }
};

const entries = [
  { id: "a", createdAt: "2026-08-19T00:00:00.000Z", itemCount: 1, items: [{ id: "i1", sourcePath: "C:\\in\\Show S01E01.mkv", targetPath: "C:\\out\\Show - S01E01.mkv" }] },
  { id: "b", createdAt: "2026-08-18T00:00:00.000Z", itemCount: 2, items: [{ id: "i2", sourcePath: "/a/b.mkv", targetPath: "/a/c.mkv" }] },
  { id: "c", createdAt: "2026-08-17T00:00:00.000Z", itemCount: 1, items: [{ id: "i3", sourcePath: "/x, with \"quotes\" and [brackets]/d.mkv", targetPath: "/y/e.mkv" }] }
];

console.log("1. round trip");
const f1 = path.join(dir, "h1.json");
await writeJsonFileAtomic(f1, entries);
check("reads back all entries", (await readJsonArrayFile(f1, "t")).length === 3);
check("no temp file left behind", !(await fs.readdir(dir)).some(n => n.endsWith(".tmp")));

console.log("2. missing file");
check("returns empty", (await readJsonArrayFile(path.join(dir, "nope.json"), "t")).length === 0);

console.log("3. truncated mid-entry (the force-kill case)");
const full = JSON.stringify(entries, null, 2);
const f3 = path.join(dir, "h3.json");
await fs.writeFile(f3, full.slice(0, Math.floor(full.length * 0.75)), "utf8");
const salvaged = await readJsonArrayFile(f3, "The manual rename history file");
check("recovers the leading complete entries", salvaged.length >= 2, `got ${salvaged.length}`);
check("newest entry survives", salvaged[0]?.id === "a");
check("nested items intact", Array.isArray(salvaged[0]?.items) && salvaged[0].items[0].targetPath === "C:\\out\\Show - S01E01.mkv");
check("damaged copy kept", (await fs.readdir(dir)).some(n => n.startsWith("h3.json.damaged-")));
const reread = await readJsonArrayFile(f3, "t");
check("self-heals: second read parses cleanly", reread.length === salvaged.length);
check("repair happened once only", (await fs.readdir(dir)).filter(n => n.startsWith("h3.json.damaged-")).length === 1);

console.log("4. tricky payloads");
const f4 = path.join(dir, "h4.json");
await fs.writeFile(f4, '[{"a":"]}, \\" tricky"},{"b":"x"},{"c":', "utf8");
const s4 = await readJsonArrayFile(f4, "t");
check("brackets/quotes inside strings do not confuse the scan", s4.length === 2, JSON.stringify(s4));
check("first value correct", s4[0]?.a === '] }, " tricky'.replace('] }',']}'), JSON.stringify(s4[0]));

console.log("5. total garbage / wrong shape");
const f5 = path.join(dir, "h5.json");
await fs.writeFile(f5, "this is not json at all", "utf8");
check("garbage yields empty, not a throw", (await readJsonArrayFile(f5, "t")).length === 0);
const f6 = path.join(dir, "h6.json");
await fs.writeFile(f6, '{"not":"an array"}', "utf8");
check("object where array expected yields empty", (await readJsonArrayFile(f6, "t")).length === 0);

console.log("6. settings object");
const f7 = path.join(dir, "settings.json");
await writeJsonFileAtomic(f7, { tmdbBearerToken: "secret", automationSettleSeconds: 45 });
check("settings round trip", (await readJsonObjectFile(f7, "t"))?.tmdbBearerToken === "secret");
await fs.writeFile(f7, '{"tmdbBearerToken":"secr', "utf8");
check("damaged settings return null", (await readJsonObjectFile(f7, "t")) === null);
check("damaged settings preserved for recovery", (await fs.readdir(dir)).some(n => n.startsWith("settings.json.damaged-")));

console.log("7. overwrite is atomic in effect");
const f8 = path.join(dir, "h8.json");
await writeJsonFileAtomic(f8, entries);
await writeJsonFileAtomic(f8, [entries[0]]);
check("overwrites existing file", (await readJsonArrayFile(f8, "t")).length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
await fs.rm(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
