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
| Mobile book details | [Original layout](mobile-details-before.png) | Original layout retained |

The desktop comparisons show the compact header, labelled single-row actions,
separate mini-player footer, Continue Reading section, and ebook availability.
The mobile library comparison shows Continue Reading above the regular list.
Mobile book details retain the original stacked header, two-column labelled actions,
and floating mini-player. The original mobile-details capture illustrates the retained
layout; a fresh capture was unavailable because the preview screenshot tool failed.
The restored layout was checked in the browser at 390 × 844 CSS pixels.
