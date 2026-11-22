# 0003. Keep one WebView across iOS tabs and display changes

Status: Accepted.

## Context

The iOS shell uses UIKit tabs for navigation and renders tabs in one WebView. The WebView owns playback, page state, and keyboard focus. UIKit can rearrange the tab bar or change the available viewport while the app is running.

## Decision

- Place the tab controller over a sibling WebView. Tab hosts supply layout information, and the root updates WebView constraints without moving or reloading it. The page receives actual UIKit clearance for the visible tab bar and can draw its background behind the status bar and other system chrome.
- Configure complete UIKit tab items before first layout. Route selections by tab identifier and coalesce duplicate delegate callbacks within one turn. A later tap on the selected tab still reaches the page. Track touches without claiming them and clear the touch outcome after UIKit's selection callback so keyboard and VoiceOver selections have no stale touch state.
- Use the web page's color for the native container, WebView background, and system chrome. Restore the last color during launch. The next selected page supplies its color once selection settles, so the native controls and page change together. Match the web palette and luma calculation. Older full-width bars use the page tone for their material.
- Hide the tabs while a web sheet covers them and restore the tabs with the page reveal. Freeze a real rendered frame during tab changes that resize the WebView. A timed reveal bounds how long a frame can obscure the page if the WebView never responds.
- Measure fold geometry in a view that shares the WebView's bounds. Report a split only when the fold leaves room on both sides of the current scene. For a side-mounted bar, give the page the free area between the system status region and the tab items. Align controls with the tab items. Keep a 44-point transport target with padding and offer secondary controls only where there is enough space. A side column's reserved inset accounts for clearance the system has already supplied. In landscape, a notch inset alone is insufficient evidence of a side column.
- During rotation, hold a raster image of the old layout while WebKit lays out the new viewport. During travel between displays, show the page's background while layout settles. A live view snapshot would continue to mirror WebKit layers. Wait for the new width and paint before revealing the WebView, with a timeout so the page cannot stay hidden. Refresh viewport information after scene transitions, attachment of a tab host, and return from the background because a DOM resize event can miss the final geometry.
- Disable root WebView bouncing and the top scroll-edge effect. The root is one viewport tall and the page background extends behind the clock. Scrolling panes retain their own scrolling behavior.

## Consequences

UIKit controls navigation and reports layout while one live page handles app state. The web page can update its own insets as the tab presentation changes. The constraints for UIKit view detection and display transition detection are tracked in [#538](https://github.com/DonovanMontoya/OperaLibre/issues/538) and [#539](https://github.com/DonovanMontoya/OperaLibre/issues/539).

See [NativeTabs](../../apps/web/ios/App/App/NativeTabs.swift), [ViewController](../../apps/web/ios/App/App/ViewController.swift), [DeviceFold](../../apps/web/ios/App/App/DeviceFold.swift), and [SceneDelegate](../../apps/web/ios/App/App/SceneDelegate.swift).
