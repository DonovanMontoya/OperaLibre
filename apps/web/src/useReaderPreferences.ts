import { useState } from "react";
import {
  type FollowAggressiveness,
  readFollowAggressiveness,
  readFollowSyncEnabled,
  readReadalongEnabled,
  writeFollowAggressiveness,
  writeFollowSyncEnabled
} from "./readalongPreferences";
import { selectionHaptic } from "./native";

export function useReaderPreferences() {
  // The ebook reader ships off by default; the narration-follow highlight is a
  // sub-option beneath it, off by default and behind a warning.
  const [readalongEnabled, setReadalongEnabled] = useState(readReadalongEnabled);
  const [followSyncEnabled, setFollowSyncEnabled] = useState(readFollowSyncEnabled);
  const [followAggressiveness, setFollowAggressiveness] = useState(readFollowAggressiveness);

  function toggleFollowSyncEnabled() {
    const enabled = !followSyncEnabled;
    writeFollowSyncEnabled(enabled);
    setFollowSyncEnabled(enabled);
  }

  function updateFollowAggressiveness(value: FollowAggressiveness) {
    if (value === followAggressiveness) return;
    writeFollowAggressiveness(value);
    setFollowAggressiveness(value);
    selectionHaptic("change");
  }

  return {
    followAggressiveness,
    followSyncEnabled,
    readalongEnabled,
    setReadalongEnabled,
    toggleFollowSyncEnabled,
    updateFollowAggressiveness
  };
}
