# Sample report: CSV handoff (fictional)

> **Invented data.** Names, order IDs, timestamps and captions below are fictional.
> They are for onboarding and demos only — not a real customer handoff.
>
> **Design preview, not a shipping screenshot.** The snip image referenced here is a
> concept mock for a future manual-snip attachment (see roadmap). It is **not** a
> screenshot of an implemented Session Tape feature. Current shipping builds support
> text notes and version history; snips, linked corrections and Markdown export are
> still milestones.

## Session

| Field | Value |
| --- | --- |
| Title | CSV import |
| Session ID | `sess_demo_csv_001` |
| Started (UTC) | 2026-03-10T14:02:11Z |
| Finished (UTC) | 2026-03-10T14:41:08Z |
| Export label | design-preview sample |

## Timeline

### 1. Snip — original caption

<a id="event-snip-001"></a>

| Field | Value |
| --- | --- |
| Event ID | `evt_snip_001` |
| Kind | snip (design preview) |
| Recorded (UTC) | 2026-03-10T14:18:44Z |
| Elapsed | +00:16:33 |
| Image | [assets/snip-orders-preview.svg](assets/snip-orders-preview.svg) — **design preview** |

**Caption (original):**

> Spreadsheet `northwind-orders-staging.csv` — rows for ORD-1042 and ORD-1047
> dropped from the import preview. Delivery date cells look blank.

### 2. Note — decision

<a id="event-note-decision"></a>

| Field | Value |
| --- | --- |
| Event ID | `evt_note_decision` |
| Kind | note |
| Recorded (UTC) | 2026-03-10T14:27:05Z |
| Elapsed | +00:24:54 |

**Body:**

> Decision: keep both orders. ORD-1042 and ORD-1047 are valid; only the delivery
> dates were blank in the source file. Do not treat the drop as a data-quality reject.

### 3. Correction — next day (linked)

<a id="event-correction-001"></a>

| Field | Value |
| --- | --- |
| Event ID | `evt_correction_001` |
| Kind | correction |
| Recorded (UTC) | 2026-03-11T09:12:33Z |
| Corrects | [evt_snip_001](#event-snip-001) |
| Reason | Caption named the wrong blank column |

**Correction text:**

> Amendment to [original snip caption](#event-snip-001): the blank cells were
> **ship-by** dates, not delivery dates. The decision to [keep both orders](#event-note-decision)
> still stands.

## Reader check

Using **only this report**, identify:

1. The **decision** (what was kept, and why).
2. The **correction** (what changed the next day, and which earlier event it references).

Do not open the app or other docs to answer those two questions.

## What this example is for

Contributors and pilot participants can share this file the same way a future
Markdown export would be shared: one readable artifact that carries the snip
caption, the keep-both-orders decision, and a separately dated correction with
working in-report links.
