# Pagination

Every list endpoint uses **cursor pagination** and returns the same envelope:

```json
{
  "object": "list",
  "data": [ { "id": "inv_...", "object": "invoice", ... }, ... ],
  "has_more": true,
  "next_cursor": "eyJpZCI6Imludl85WHlaMTJBYkMzIiwiY3JlYXRlZF9hdCI6IjIwMjYtMTAtMjFUMTA6MDA6MDBaIn0"
}
```

## Parameters

| Query param | Default | Description |
|-------------|---------|-------------|
| `limit` | 20 | Page size, 1-100 |
| `cursor` | - | Opaque value from the previous page's `next_cursor` |
| `created_gte`, `created_lte` | - | RFC 3339 time bounds, available on most lists |
| resource-specific filters | - | e.g. `status`, `order_id`, `invoice_id`, `chain`, `type` |

Results are ordered newest first by `created_at`, then by `id`, so pages are stable even when
new objects are created while you iterate.

## Iterating

```bash
curl "https://api.coinvello.com/v1/invoices?limit=100&status=paid&created_gte=2026-10-01T00:00:00Z" \
  -H "Authorization: Bearer cv_live_..."
# ... read next_cursor ...
curl "https://api.coinvello.com/v1/invoices?limit=100&status=paid&created_gte=2026-10-01T00:00:00Z&cursor=eyJpZCI6..." \
  -H "Authorization: Bearer cv_live_..."
```

Keep the same filters on every page; a cursor is only valid with the filters it was issued
for (a mismatch returns `400 parameter_invalid` on `cursor`). Cursors expire after 24 hours.

## Auto-pagination in the SDKs

```ts
for await (const inv of client.invoices.list({ status: "paid", limit: 100 })) {
  reconcile(inv);
}
```

```php
foreach ($client->invoices()->list(['status' => 'paid'])->autoPagingIterator() as $inv) { ... }
```

```python
for inv in client.invoices.list(status="paid").auto_paging_iter():
    ...
```

## Reconciling with /events

For "what happened since my last sync", prefer `GET /events?created_gte=...` over scanning
each resource. Events are immutable, ordered, and retained for 90 days.
