import assert from "node:assert/strict";
import test from "node:test";
import { parseTime } from "../src/tools/calendar.js";
import { parseTimeMs } from "../src/tools/task.js";

test("calendar and task honor explicit ISO offsets while local times use the configured zone", () => {
  const instant = Date.parse("2026-10-22T10:00:00Z");
  assert.equal(parseTime("2026-10-22T10:00:00Z", "Asia/Shanghai").sec, instant / 1000);
  assert.equal(parseTime("2026-10-22T18:00:00+08:00", "Asia/Shanghai").sec, instant / 1000);
  assert.equal(parseTime("2026-10-22 18:00", "Asia/Shanghai").sec, instant / 1000);
  assert.equal(parseTimeMs("2026-10-22T18:00:00+08:00", "Asia/Shanghai").ms, instant);
});
