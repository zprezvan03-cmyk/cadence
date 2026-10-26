# Local Symphonia patch

This directory contains the `symphonia-format-isomp4` 0.5.5 crate from the Symphonia `v0.5.5`
release (MPL-2.0). It is patched because that release rejects MP4 files whenever any track has
more than one `stsd` sample entry, even when the affected track is only auxiliary chapter artwork
or timed text and the ALAC audio track itself is valid.

The local change in `src/atoms/stsd.rs` keeps reading the first sample entry and allows
`AtomIterator::next()` to skip the remaining bytes in the `stsd` atom. Symphonia represents a track
with one codec, so this does not add per-sample-entry switching; it avoids rejecting the entire
container for auxiliary or extra entries. The change follows the upstream compatibility fix proposed
in [Symphonia PR #534](https://github.com/pdeljanov/Symphonia/pull/534).

The three Symphonia sub-crate dependencies in this vendored `Cargo.toml` use their published 0.5.5
versions rather than relative workspace paths, so Cargo can build this one patched crate without
vendoring the whole Symphonia workspace. The upstream license is included as `LICENSE`. The isolated regression test can be run with
`cargo test --manifest-path vendor/symphonia-format-isomp4/Cargo.toml`.
