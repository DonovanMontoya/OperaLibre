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

## Follow-up captures

Screenshot capture recovered for these follow-up changes:

- [Mobile web header](mobile-header-fixed.png), 390 × 844: the Library button
  stays in document flow when there is no Now Playing card, clear of the folio divider.
- [iOS book details](ios-details-after.png), 430 × 932: production components
  rendered through `test/duo-shell.html` with the built-in demo library. The cover
  aligns with the title and credits; listening and labeled actions span the page.
  This is a browser preview of the native shell, not an iPhone device capture.
  System safe areas and the native iOS tab bar are not reproduced; the browser
  fallback tab bar is shown. No book is playing in this capture.

## More useful space

The latest revision replaces the earlier mobile arrangements:

- [iOS details](ios-details-compact.png), 430 × 932: larger cover alongside
  compact credits/runtime and a smaller reader invitation. Chapters stay
  collapsed until explicitly opened.
- [Mobile web details](mobile-details-compact.png), 390 × 844: Library and folio
  share a row; the cover sits beside the title and credits. Labeled actions
  remain in two columns, with an odd final action spanning both columns.

The iOS capture has the same browser-fixture limitations described above.
Responsive overflow and action labels were checked down to 320 CSS pixels;
chapter expansion and returning to the preview were checked in the browser.

## Tall iPhone title page

The latest iOS revision uses a larger centered cover and title on phones at least
800 CSS pixels tall when no mini-player is present. With a player dock, or on
shorter phones, it keeps the compact two-column header. Bottom padding reserves
space for the mini-player only when it is present. Chapters remain collapsed.

The iOS screenshots above precede this revision. A fresh screenshot could not
be saved because preview capture failed. Browser geometry at 430 × 932 confirmed
that the collapsed chapter section ends about 30 pixels above the tabs. Build,
lint, and whitespace checks passed; the compact dock layout was also checked.
