# Web reader and library comparisons

Captured from the running web client using the built-in demo library.

- Before: `bb4b84a712293cecb840fb41b2613d5542ec6890`, the PR merge base.
- After: the implementation in this PR.
- Desktop viewport: 1440 × 900 CSS pixels.
- Mobile viewport: 390 × 844 CSS pixels (responsive web preview, not a device test).
- Both versions use the same demo books and saved progress; playback is paused.
- Captures show settled layouts; motion was disabled where needed to avoid capturing transitions.

| View | Before | After |
| --- | --- | --- |
| Desktop library and book details | [Before](desktop-details-before.png) | [After](desktop-details-after.png) |
| Now Playing → Details → Full book page | [Before](current-book-before.png) | [After](current-book-after.png) |
| Mobile library | [Before](mobile-library-before.png) | [After](mobile-library-after.png) |
| Mobile book details | [Before](mobile-details-before.png) | [After](mobile-details-after.png) |

The desktop comparisons show the compact header, labelled single-row actions,
separate mini-player footer, Continue Reading section, and ebook availability.
The mobile library comparison shows Continue Reading above the regular list.
On narrow book-details pages, action labels stay on one horizontally scrollable row.
