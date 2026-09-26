import { useState } from "react";
import {
  type FollowAggressiveness,
  readFollowAggressiveness,
  writeFollowAggressiveness
} from "./readalongPreferences";
import { selectionHaptic } from "./native";

export function useReaderPreferences() {
  const [followAggressiveness, setFollowAggressiveness] = useState(readFollowAggressiveness);

  function updateFollowAggressiveness(value: FollowAggressiveness) {
    if (value === followAggressiveness) return;
    writeFollowAggressiveness(value);
    setFollowAggressiveness(value);
    selectionHaptic("change");
  }

  return {
    followAggressiveness,
    // Reader entry points and sync tools are always available when the book
    // and server support them. The in-reader Follow button owns the choice.
    followSyncEnabled: true,
    readalongEnabled: true,
    updateFollowAggressiveness
  };
}
