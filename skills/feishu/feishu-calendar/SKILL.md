---
name: feishu-calendar
description: Personal calendar — create, list/search, modify, and delete events.
---

# feishu_calendar

Uses broker-managed user OAuth. If authorization is missing, the tool returns a verification URL; authorize and retry.

## Pre-execution checklist

- Time format: `"YYYY-MM-DD HH:MM"` or ISO 8601; all-day events: `"YYYY-MM-DD"` only
- `list` defaults to **this week Mon → next week Sun** (~14 days); max range is **40 days**
- `patch` and `delete` require a full `event_id` — use the ID returned by `create` or `list`
- `event_id` ending `_0` = whole recurring series; `_<timestamp>` = one specific occurrence

---

## Quick Reference

| Action | Required | Optional |
|--------|----------|----------|
| `create` | `summary`, `start_time`, `end_time` | `description`, `location`, `latitude`, `longitude`, `reminder`, `recurrence` |
| `list` | — | `start_time`, `end_time`, `query`, `page_size` |
| `patch` | `event_id` | `summary`, `start_time`, `end_time`, `description`, `location`, `latitude`, `longitude`, `recurrence` |
| `delete` | `event_id` | `notify` (default false — sends cancellation to attendees if true) |

`list` groups recurring occurrences for a compact display. Grouped dates may show abbreviated IDs; those display strings are not usable for `patch` or `delete`. Use a narrow range to obtain a full occurrence ID. `count` counts fetched instances, which can differ from the number of display groups. Lists return one page, controlled by `page_size`.

---

## Scenarios

### Create a one-off event
```json
{
  "summary": "Team standup",
  "start_time": "2026-03-20 09:30",
  "end_time": "2026-03-20 10:00",
  "location": "Conference Room A",
  "reminder": 10
}
```

### Create a recurring event
```json
{
  "summary": "Weekly standup",
  "start_time": "2026-03-20 09:30",
  "end_time": "2026-03-20 10:00",
  "recurrence": "FREQ=WEEKLY;BYDAY=MO;COUNT=8"
}
```

### View / search schedule
```json
{ "query": "standup", "start_time": "2026-03-17", "end_time": "2026-03-23" }
```

Keyword search cross-references against a time range. Omitting times applies the default two-week window.

### Modify one occurrence vs the whole series
```json
{ "event_id": "abc123_1742169600", "start_time": "2026-03-20 10:00", "end_time": "2026-03-20 10:30" }
```
```json
{ "event_id": "abc123_0", "summary": "Weekly sync", "recurrence": "FREQ=WEEKLY;BYDAY=TU;COUNT=8" }
```
