/**
 * Track lookup shared by the audio queue and the renderer stores. Keeping it outside React lets
 * the player store load a track on boot without waiting for a component to subscribe.
 */

import type { Track } from "../../shared/types";

let tracks = new Map<number, Track>();

export function setTrackRegistry(next: Map<number, Track>): void {
  tracks = next;
}

export function getTrackById(id: number): Track | null {
  return tracks.get(id) ?? null;
}
