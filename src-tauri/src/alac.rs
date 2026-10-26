//! On-demand ALAC decoding for WebViews whose Chromium build lacks an ALAC decoder.
//!
//! The decoded file is lossless integer PCM WAV: ALAC's decoded sample rate, channel count, and
//! sample precision are retained (20-bit samples use a 24-bit PCM container). Cadence then streams
//! that WAV through its existing range protocol and HTMLAudioElement.

use std::collections::hash_map::DefaultHasher;
use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::io::{BufWriter, ErrorKind, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{
    CodecParameters, DecoderOptions, CODEC_TYPE_ALAC,
};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, FormatReader};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

const MAX_RIFF_DATA_BYTES: u64 = u32::MAX as u64 - 36;
static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AlacWavInfo {
    pub sample_rate: u32,
    pub channels: u16,
    pub source_bits_per_sample: u32,
    pub output_bits_per_sample: u16,
    pub frames: u64,
    pub data_bytes: u64,
}

fn open_alac_format(
    source: &Path,
) -> Result<(Box<dyn FormatReader>, u32, CodecParameters), String> {
    let input = File::open(source).map_err(|error| format!("Could not open ALAC source: {error}"))?;
    let stream = MediaSourceStream::new(Box::new(input), Default::default());

    let mut hint = Hint::new();
    if let Some(extension) = source.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|error| format!("Could not read the audio container: {error}"))?;
    let format = probed.format;

    // Copy the fields needed later so the track borrow ends before `format` is moved.
    let Some((track_id, codec_params)) = format
        .tracks()
        .iter()
        .find(|track| track.codec_params.codec == CODEC_TYPE_ALAC)
        .map(|track| (track.id, track.codec_params.clone()))
    else {
        return Err(
            "This file does not contain an ALAC audio stream; AAC/M4A files are not treated as ALAC."
                .to_string(),
        );
    };

    Ok((format, track_id, codec_params))
}

/// Decode a confirmed ALAC track to a seekable lossless PCM WAV file.
pub fn decode_alac_to_wav(source: &Path, output: &Path) -> Result<AlacWavInfo, String> {
    let (format, track_id, codec_params) = open_alac_format(source)?;
    decode_format_to_wav(format, track_id, codec_params, output)
}

/// Decode an allowlisted ALAC source into a versioned cache file.
///
/// The container is still probed before a cache hit is returned. This is intentional: a `.m4a`
/// whose contents are AAC must never become playable as ALAC simply because a stale cache exists.
pub fn decode_alac_to_wav_cached(source: &Path, cache_dir: &Path) -> Result<PathBuf, String> {
    let source = fs::canonicalize(source).map_err(|error| format!("Could not resolve ALAC source: {error}"))?;
    let before = fs::metadata(&source).map_err(|error| format!("Could not stat ALAC source: {error}"))?;
    if !before.is_file() {
        return Err("The ALAC source is not a regular file.".to_string());
    }

    // Probe actual container/codec metadata before consulting the cache, rather than trusting the
    // `.m4a` suffix or the library's potentially stale metadata snapshot.
    let (format, track_id, codec_params) = open_alac_format(&source)?;
    let fingerprint = source_fingerprint(&source, &before);
    fs::create_dir_all(cache_dir).map_err(|error| format!("Could not create the ALAC cache: {error}"))?;
    let cached = cache_dir.join(format!("alac-{fingerprint:016x}.wav"));

    if cached.is_file() {
        return Ok(cached);
    }

    let temp_id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
    let temporary = cache_dir.join(format!(
        ".alac-{fingerprint:016x}-{}-{temp_id}.tmp.wav",
        std::process::id()
    ));

    let decoded = match decode_format_to_wav(format, track_id, codec_params, &temporary) {
        Ok(info) => info,
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
    };

    let after = fs::metadata(&source).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("Could not restat ALAC source: {error}")
    })?;
    if source_fingerprint(&source, &after) != fingerprint {
        let _ = fs::remove_file(&temporary);
        return Err("The ALAC source changed while it was being decoded; try again.".to_string());
    }

    // Another playback/decode-probe request may have produced the same cache entry concurrently.
    if cached.is_file() {
        let _ = fs::remove_file(&temporary);
        return Ok(cached);
    }

    if let Err(error) = fs::rename(&temporary, &cached) {
        // On Windows, rename does not replace an existing destination. Treat a concurrent winner
        // as success; otherwise surface the filesystem error and leave no partial cache file.
        if cached.is_file() {
            let _ = fs::remove_file(&temporary);
            return Ok(cached);
        }
        let _ = fs::remove_file(&temporary);
        return Err(format!("Could not store decoded ALAC audio: {error}"));
    }

    debug_assert!(decoded.frames > 0);
    Ok(cached)
}

fn source_fingerprint(source: &Path, metadata: &fs::Metadata) -> u64 {
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let mut hasher = DefaultHasher::new();
    source.hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    modified_nanos.hash(&mut hasher);
    hasher.finish()
}

fn decode_format_to_wav(
    mut format: Box<dyn FormatReader>,
    track_id: u32,
    codec_params: CodecParameters,
    output: &Path,
) -> Result<AlacWavInfo, String> {
    let source_bits = codec_params.bits_per_sample.unwrap_or(32);
    if source_bits == 0 || source_bits > 32 {
        return Err(format!("Unsupported ALAC sample precision: {source_bits} bits."));
    }
    // ALAC's decoder returns signed 32-bit samples left-aligned at their original precision.
    // Packing to 16/24-bit PCM where possible preserves those exact integer samples and avoids
    // needlessly multiplying the temporary-file size for common CD-quality and 24-bit material.
    let output_bits = if source_bits <= 16 {
        16
    } else if source_bits <= 24 {
        24
    } else {
        32
    };
    let bytes_per_sample = usize::from(output_bits / 8);

    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|error| format!("Could not initialize the ALAC decoder: {error}"))?;
    let file = File::create(output).map_err(|error| format!("Could not create decoded audio: {error}"))?;
    let mut writer = BufWriter::with_capacity(128 * 1024, file);
    let mut output_spec: Option<(u32, u16)> = None;
    let mut total_frames = 0_u64;
    let mut total_data_bytes = 0_u64;

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(error)) if error.kind() == ErrorKind::UnexpectedEof => break,
            Err(SymphoniaError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(error) => return Err(format!("Could not demux ALAC audio: {error}")),
        };
        if packet.track_id() != track_id {
            continue;
        }

        let audio = match decoder.decode(&packet) {
            Ok(audio) => audio,
            Err(SymphoniaError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(error) => return Err(format!("Could not decode ALAC audio: {error}")),
        };

        let spec = *audio.spec();
        let channel_count = spec.channels.count();
        if channel_count == 0 || channel_count > u16::MAX as usize || spec.rate == 0 {
            return Err("The ALAC stream has an invalid sample rate or channel count.".to_string());
        }
        let channels = channel_count as u16;
        match output_spec {
            None => {
                write_pcm_wav_header(&mut writer, spec.rate, channels, output_bits, 0)?;
                output_spec = Some((spec.rate, channels));
            }
            Some((sample_rate, previous_channels))
                if sample_rate != spec.rate || previous_channels != channels =>
            {
                return Err("The ALAC stream changed its sample rate or channel count mid-track.".to_string());
            }
            Some(_) => {}
        }

        let mut samples = SampleBuffer::<i32>::new(audio.capacity() as u64, spec);
        samples.copy_interleaved_ref(audio);
        let samples = samples.samples();
        if samples.len() % channel_count != 0 {
            return Err("The ALAC decoder returned an incomplete audio frame.".to_string());
        }
        if samples.is_empty() {
            continue;
        }

        let frame_count = (samples.len() / channel_count) as u64;
        total_frames = total_frames
            .checked_add(frame_count)
            .ok_or_else(|| "Decoded ALAC duration is too large.".to_string())?;
        let packet_bytes = (samples.len() as u64)
            .checked_mul(bytes_per_sample as u64)
            .ok_or_else(|| "Decoded ALAC data is too large for WAV.".to_string())?;
        total_data_bytes = total_data_bytes
            .checked_add(packet_bytes)
            .ok_or_else(|| "Decoded ALAC data is too large for WAV.".to_string())?;
        if total_data_bytes > MAX_RIFF_DATA_BYTES {
            return Err("Decoded ALAC audio exceeds the 4 GiB RIFF/WAV size limit.".to_string());
        }

        let mut pcm_bytes = Vec::with_capacity(samples.len() * bytes_per_sample);
        for sample in samples {
            match output_bits {
                16 => pcm_bytes.extend_from_slice(&((*sample >> 16) as i16).to_le_bytes()),
                24 => {
                    let packed = (*sample >> 8).to_le_bytes();
                    pcm_bytes.extend_from_slice(&packed[..3]);
                }
                _ => pcm_bytes.extend_from_slice(&sample.to_le_bytes()),
            }
        }
        writer
            .write_all(&pcm_bytes)
            .map_err(|error| format!("Could not write decoded ALAC audio: {error}"))?;
    }

    let Some((sample_rate, channels)) = output_spec else {
        return Err("The ALAC stream did not contain any decodable audio frames.".to_string());
    };
    if total_frames == 0 || total_data_bytes == 0 {
        return Err("The ALAC stream did not contain any decodable audio frames.".to_string());
    }

    write_pcm_wav_header(&mut writer, sample_rate, channels, output_bits, total_data_bytes)?;
    writer
        .flush()
        .map_err(|error| format!("Could not finalize decoded ALAC audio: {error}"))?;

    Ok(AlacWavInfo {
        sample_rate,
        channels,
        source_bits_per_sample: source_bits,
        output_bits_per_sample: output_bits,
        frames: total_frames,
        data_bytes: total_data_bytes,
    })
}

fn write_pcm_wav_header<W: Write + Seek>(
    writer: &mut W,
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
    data_bytes: u64,
) -> Result<(), String> {
    let riff_size = 36_u64
        .checked_add(data_bytes)
        .filter(|size| *size <= u32::MAX as u64)
        .ok_or_else(|| "Decoded ALAC audio exceeds the 4 GiB RIFF/WAV size limit.".to_string())?;
    let block_align = channels
        .checked_mul(bits_per_sample / 8)
        .ok_or_else(|| "Invalid PCM channel count.".to_string())?;
    let byte_rate = sample_rate
        .checked_mul(u32::from(block_align))
        .ok_or_else(|| "Invalid PCM sample rate or channel count.".to_string())?;
    let data_len = u32::try_from(data_bytes)
        .map_err(|_| "Decoded ALAC audio exceeds the 4 GiB RIFF/WAV size limit.".to_string())?;

    writer
        .flush()
        .map_err(|error| format!("Could not finalize decoded ALAC audio: {error}"))?;
    writer
        .seek(SeekFrom::Start(0))
        .map_err(|error| format!("Could not seek decoded ALAC audio: {error}"))?;
    writer
        .write_all(b"RIFF")
        .and_then(|_| writer.write_all(&(riff_size as u32).to_le_bytes()))
        .and_then(|_| writer.write_all(b"WAVEfmt "))
        .and_then(|_| writer.write_all(&16_u32.to_le_bytes()))
        .and_then(|_| writer.write_all(&1_u16.to_le_bytes())) // WAVE_FORMAT_PCM
        .and_then(|_| writer.write_all(&channels.to_le_bytes()))
        .and_then(|_| writer.write_all(&sample_rate.to_le_bytes()))
        .and_then(|_| writer.write_all(&byte_rate.to_le_bytes()))
        .and_then(|_| writer.write_all(&block_align.to_le_bytes()))
        .and_then(|_| writer.write_all(&bits_per_sample.to_le_bytes()))
        .and_then(|_| writer.write_all(b"data"))
        .and_then(|_| writer.write_all(&data_len.to_le_bytes()))
        .map_err(|error| format!("Could not write decoded ALAC WAV header: {error}"))?;
    writer
        .seek(SeekFrom::End(0))
        .map_err(|error| format!("Could not seek decoded ALAC audio: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{decode_alac_to_wav, decode_alac_to_wav_cached, source_fingerprint, AlacWavInfo};
    use std::fs;
    use std::path::{Path, PathBuf};

    fn fixture(relative: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(relative)
    }

    fn temp_wav(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("cadence-{name}-{}.wav", std::process::id()))
    }

    fn assert_wav(path: &Path, info: AlacWavInfo, sample_rate: u32) {
        let bytes = fs::read(path).expect("decoded WAV should be readable");
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        assert_eq!(u32::from_le_bytes(bytes[24..28].try_into().unwrap()), sample_rate);
        assert_eq!(u16::from_le_bytes(bytes[22..24].try_into().unwrap()), 2);
        assert_eq!(
            u16::from_le_bytes(bytes[34..36].try_into().unwrap()),
            info.output_bits_per_sample
        );
        assert_eq!(
            u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as u64,
            info.data_bytes
        );
        assert!(info.frames > 0);
        assert!(bytes[44..].iter().any(|sample_byte| *sample_byte != 0));
        assert_eq!(info.channels, 2);
        assert_eq!(bytes.len() as u64, 44 + info.data_bytes);
    }

    #[test]
    fn decodes_stereo_alac_at_44100_hz_without_changing_pcm_precision() {
        let source = fixture(".artifacts/fixtures/formats/fixture-alac.m4a");
        assert!(
            source.is_file(),
            "Run `npm run test:fixtures` to generate real encoded audio fixtures."
        );
        let output = temp_wav("alac-44100");
        let info = decode_alac_to_wav(&source, &output).expect("stereo ALAC should decode");
        assert_eq!(info.sample_rate, 44_100);
        assert_eq!(info.source_bits_per_sample, 16);
        assert_eq!(info.output_bits_per_sample, 16);
        assert_wav(&output, info, 44_100);
        let _ = fs::remove_file(output);
    }

    #[test]
    fn decodes_stereo_alac_at_a_different_sample_rate() {
        let source = fixture(".artifacts/fixtures/alac/fixture-alac-96k.m4a");
        assert!(
            source.is_file(),
            "Run `npm run test:fixtures` to generate the 96 kHz ALAC fixture."
        );
        let output = temp_wav("alac-96000");
        let info = decode_alac_to_wav(&source, &output).expect("96 kHz ALAC should decode");
        assert_eq!(info.sample_rate, 96_000);
        assert_eq!(info.channels, 2);
        assert_wav(&output, info, 96_000);
        let _ = fs::remove_file(output);
    }

    #[test]
    fn rejects_aac_m4a_from_the_codec_metadata_not_its_extension() {
        let source = fixture(".artifacts/fixtures/formats/fixture-aac.m4a");
        assert!(
            source.is_file(),
            "Run `npm run test:fixtures` to generate the AAC/M4A regression fixture."
        );
        let output = temp_wav("aac-rejection");
        let error = decode_alac_to_wav(&source, &output).expect_err("AAC must not enter the ALAC decoder");
        assert!(error.contains("does not contain an ALAC"), "{error}");
        assert!(!output.exists());
    }

    #[test]
    fn rejects_aac_before_returning_a_matching_stale_cache_file() {
        let source = fixture(".artifacts/fixtures/formats/fixture-aac.m4a");
        assert!(
            source.is_file(),
            "Run `npm run test:fixtures` to generate the AAC/M4A regression fixture."
        );
        let source = fs::canonicalize(source).expect("AAC fixture path should resolve");
        let metadata = fs::metadata(&source).expect("AAC fixture metadata should be readable");
        let fingerprint = source_fingerprint(&source, &metadata);
        let cache_dir = std::env::temp_dir().join(format!("cadence-alac-cache-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&cache_dir);
        fs::create_dir_all(&cache_dir).expect("test cache directory should be creatable");
        let stale_cache = cache_dir.join(format!("alac-{fingerprint:016x}.wav"));
        fs::write(&stale_cache, b"not a decoded ALAC file").expect("test cache should be writable");

        let error = decode_alac_to_wav_cached(&source, &cache_dir)
            .expect_err("AAC must be rejected before consulting a stale ALAC cache");
        assert!(error.contains("does not contain an ALAC"), "{error}");
        assert_eq!(fs::read(&stale_cache).unwrap(), b"not a decoded ALAC file".to_vec());
        let _ = fs::remove_dir_all(cache_dir);
    }
}
