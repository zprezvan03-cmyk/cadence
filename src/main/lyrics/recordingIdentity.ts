/**
 * Conservative duplicate-recording detection for Fetch All Lyrics.
 *
 * Two library files are only treated as the same recording when their normalized artist and
 * title are identical *and* their durations agree within two seconds. The normalized title
 * keeps parenthetical/version wording, so "Song (Live)", "Song (Remix)", "Song (Instrumental)",
 * "Song (Karaoke Version)" or a different edit never collapse into "Song" — when confidence is
 * insufficient (missing tags, unknown duration) every file keeps its own identity and is
 * processed independently, exactly as the feature spec requires.
 */

import { normalizeMetadata } from "./matching";

export interface RecordingIdentityInput {
  id: number;
  title: string;
  artist: string;
  duration: number;
}

/** Group key before duration clustering; files without usable tags are unique per track. */
export function recordingGroupKey(track: RecordingIdentityInput): string {
  const title = normalizeMetadata(track.title ?? "");
  const artist = normalizeMetadata(track.artist ?? "");
  if (!title || !artist || !(track.duration > 0)) return `track:${track.id}`;
  return `${artist}|${title}`;
}

/**
 * Clusters tracks into recordings. Returns a stable recording key per track id: tracks share a
 * key only when group key matches and duration is within 2 s of the cluster's first (library
 * order) representative. The representative is the lowest track id's duration, so the result is
 * deterministic regardless of input order within a group… (input is sorted by id first).
 */
export function clusterRecordings(
  tracks: readonly RecordingIdentityInput[]
): Map<number, string> {
  const result = new Map<number, string>();
  const groups = new Map<string, RecordingIdentityInput[]>();
  for (const track of tracks) {
    const group = recordingGroupKey(track);
    if (group.startsWith("track:")) {
      result.set(track.id, group);
      continue;
    }
    groups.set(group, [...(groups.get(group) ?? []), track]);
  }

  for (const [group, members] of groups) {
    const sorted = [...members].sort((a, b) => a.id - b.id);
    const clusters: { representativeDuration: number; members: RecordingIdentityInput[] }[] = [];
    for (const track of sorted) {
      const cluster = clusters.find(
        entry => Math.abs(entry.representativeDuration - track.duration) <= 2
      );
      if (cluster) cluster.members.push(track);
      else clusters.push({ representativeDuration: track.duration, members: [track] });
    }
    for (const cluster of clusters) {
      const key =
        cluster.members.length === 1
          ? `${group}|${Math.round(cluster.representativeDuration)}|${cluster.members[0].id}`
          : `${group}|${Math.round(cluster.representativeDuration)}`;
      // Singletons keep a unique key (with the track id) so a lone track is never accidentally
      // merged with a later, separate scan of a different file; true duplicates share the key.
      for (const member of cluster.members) result.set(member.id, key);
    }
  }
  return result;
}
