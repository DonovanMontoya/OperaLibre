import { useEffect, useRef, useState } from "react";
import type { AuthUser, FinishFeed } from "./types";
import type { ServerCapabilities } from "./serverCapabilities";
import { arrivedSince, EMPTY_FINISH_FEED, finishBannerText } from "./finishFeed";
import { isNotifiedOfFinishes } from "./ProgressSharing";
import { getFinishFeed, markFinishFeedSeen } from "./api";
import { ensureFinishBannerPermission, postFinishBanner } from "./finishNotifications";
import { haptic } from "./native";

export function useFinishFeed({
  capabilities,
  currentUser
}: {
  capabilities: ServerCapabilities;
  currentUser: AuthUser;
}) {
  // The shared "who finished what" feed. Polled on the same cadence as the
  // account refresh in MainApp: a finish is news for hours, so a tighter loop would
  // buy nothing and cost a request every few seconds.
  const [finishFeed, setFinishFeed] = useState<FinishFeed>(EMPTY_FINISH_FEED);
  const [finishFeedOpen, setFinishFeedOpen] = useState(false);
  // The previous poll, so a banner fires only for what actually just arrived.
  // Null until the first poll lands, which is what keeps a session opening on
  // a backlog from announcing all of it at once.
  const previousFinishFeedRef = useRef<FinishFeed | null>(null);
  // Ticks once per feed request, whether a poll or a mark-as-seen. Answers are
  // not guaranteed to arrive in the order they were asked for — a focus poll
  // can overlap the interval one, and either can outlast the 30s gap — so only
  // the newest request is allowed to touch the feed or the baseline above.
  // An older answer landing would rewind the baseline, and the next poll would
  // then treat already-announced finishes as new and banner them again.
  const finishRequestRef = useRef(0);
  const finishFeedAvailable =
    capabilities.sharedActivity && isNotifiedOfFinishes(currentUser);

  useEffect(() => {
    if (!finishFeedAvailable) {
      // Turning the setting off empties the bell rather than freezing the last
      // feed behind it, and resets the baseline so re-enabling does not fire a
      // burst of banners for everything that happened meanwhile.
      setFinishFeed(EMPTY_FINISH_FEED);
      setFinishFeedOpen(false);
      previousFinishFeedRef.current = null;
      return;
    }
    let cancelled = false;
    const poll = () => {
      const request = (finishRequestRef.current += 1);
      void getFinishFeed()
        .then(async (next) => {
          if (cancelled || request !== finishRequestRef.current) return;
          const arrivals = arrivedSince(previousFinishFeedRef.current, next);
          previousFinishFeedRef.current = next;
          setFinishFeed(next);
          const banner = finishBannerText(arrivals);
          // Permission is asked for here, the first time there is actually
          // something to show, rather than at launch with no context.
          if (banner && (await ensureFinishBannerPermission())) {
            await postFinishBanner(banner);
          }
        })
        .catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, 30_000);
    window.addEventListener("focus", poll);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", poll);
    };
  }, [finishFeedAvailable]);

  function toggleFinishFeed() {
    const opening = !finishFeedOpen;
    setFinishFeedOpen(opening);
    if (!opening) return;
    haptic("light");
    // Opening the panel is the listener reading it, so the badge clears from
    // the top entry down. A finish that lands while it is open stays unseen
    // until the next open, which is why this marks by id rather than "all".
    const latest = finishFeed.latestId;
    if (!latest || finishFeed.unseenCount === 0) return;
    const request = (finishRequestRef.current += 1);
    void markFinishFeedSeen(latest)
      .then((next) => {
        // Shares the sequence with the poll above: a request already in flight
        // when the panel opened must not land afterwards and un-clear the
        // badge the listener just read.
        if (request !== finishRequestRef.current) return;
        previousFinishFeedRef.current = next;
        setFinishFeed(next);
      })
      .catch(() => undefined);
  }

  return {
    finishFeed,
    finishFeedAvailable,
    finishFeedOpen,
    setFinishFeedOpen,
    toggleFinishFeed
  };
}
