---
name: feishu-doc
description: Create, read, edit, search, and delete Lark documents and files.
---

# feishu_doc

Uses broker-managed user OAuth. If authorization is missing, the tool returns a verification URL; authorize and retry.

## Quick Reference

| Tool | Required | Optional | Returns |
|------|----------|----------|---------|
| `feishu_doc_create` | — | `title`, `folder_token` | `document_id` |
| `feishu_doc_fetch` | `document_id` | — | `content` (plain text) + `blocks` list with `block_id`, `type`, `text` |
| `feishu_doc_append` | `document_id` and exactly one of `blocks` or `markdown` | `blocks`: array of block options below; `markdown`: Markdown text | `ok`, `document_id`, `blocks_created`, `block_ids` |
| `feishu_doc_patch` | `document_id`, `block_id`, `text` | `bold`, `italic`, `inline_code`, `done` | `ok` |
| `feishu_doc_delete` | `document_id`, `block_id` | — | `ok` |
| `feishu_doc_delete_file` | `file_token` | `type` (`docx`\|`file`\|`sheet`\|`bitable`, default `docx`) | `{ deleted: true }` |
| `feishu_doc_search` | `query` | `page_size` | list of `{ token, title, url }` |

> Each item in `blocks` contains the original single-block options: `text`, `type`, `bold`, `italic`, `inline_code`, `done`, `image_path`, `callout_emoji`, `callout_bg`. `type` values: `paragraph` · `heading1`–`heading6` · `bullet` · `ordered` · `code` · `quote` · `todo` · `callout` · `equation` · `image`. Items are appended in order, up to 50 top-level blocks per Lark request; image uploads and callout contents require additional calls.

> `markdown` converts Markdown to nested document blocks and appends them in one batch (up to 1000 converted blocks). Use it for headings, lists, tables, and mixed formatting. `blocks` and `markdown` cannot both be present. Markdown image links are not uploaded by this mode; use `blocks: [{ type: "image", image_path: "..." }]` for local images.

> `callout_bg` values: 1=LightRed · 2=LightOrange · 3=LightYellow · 4=LightGreen · 5=LightBlue · 6=LightPurple · 7=LightGray

> **Edit/delete workflow**: `feishu_doc_fetch` → get `block_id` from `blocks` list → `feishu_doc_patch` or `feishu_doc_delete`

---

## Sharing a Doc

After creating, send the URL as a plain text message — Feishu auto-expands it into a doc preview card:

```
https://feishu.cn/docx/{document_id}
```

The tenant prefix (`tsinghuasigs.feishu.cn` etc.) is not required — the short URL works.

---

## Scenarios

### Read a doc
Get `document_id` from the URL (last path segment) or `feishu_doc_search`, then call `feishu_doc_fetch`.

### Delete an entire file
Use `feishu_doc_delete_file` with the doc's `document_id` as `file_token` (and `type: "docx"` for docs). This permanently deletes the file from Drive — confirm with the user before proceeding.
