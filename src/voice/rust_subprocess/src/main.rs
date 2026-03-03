#![allow(dead_code)]

mod dave;
mod voice_conn;

use std::collections::{HashMap, VecDeque};
use std::io::{self, BufRead, Write};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use audiopus::coder::{Decoder as OpusDecoder, Encoder as OpusEncoder};
use audiopus::packet::Packet as OpusPacket;
use audiopus::{Application, Channels, MutSignals, SampleRate};
use base64::Engine as _;
use crossbeam_channel as crossbeam;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::time;
use tracing::{debug, error, info, warn};

use crate::dave::DaveManager;
use crate::voice_conn::{VoiceConnection, VoiceEvent};

// ---------------------------------------------------------------------------
// Global IPC output channel — all threads send OutMsg through this channel,
// a dedicated writer thread serializes and flushes them to stdout.
// ---------------------------------------------------------------------------

static IPC_TX: std::sync::OnceLock<crossbeam::Sender<OutMsg>> = std::sync::OnceLock::new();

// ---------------------------------------------------------------------------
// IPC message types — must match voiceSubprocessClient.ts exactly
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug)]
#[serde(tag = "type")]
#[serde(rename_all = "snake_case")]
enum InMsg {
    Join {
        #[serde(rename = "guildId")]
        guild_id: String,
        #[serde(rename = "channelId")]
        channel_id: String,
        #[serde(rename = "selfDeaf", default)]
        self_deaf: bool,
        #[serde(rename = "selfMute", default)]
        self_mute: bool,
    },
    VoiceServer {
        data: Value,
    },
    VoiceState {
        data: Value,
    },
    Audio {
        #[serde(rename = "pcmBase64")]
        pcm_base64: String,
        #[serde(rename = "sampleRate", default = "default_sample_rate")]
        sample_rate: u32,
    },
    StopPlayback,
    SubscribeUser {
        #[serde(rename = "userId")]
        user_id: String,
        #[serde(rename = "silenceDurationMs", default = "default_silence_duration")]
        silence_duration_ms: u32,
        #[serde(rename = "sampleRate", default = "default_sample_rate")]
        sample_rate: u32,
    },
    UnsubscribeUser {
        #[serde(rename = "userId")]
        user_id: String,
    },
    MusicPlay {
        url: String,
    },
    MusicStop,
    MusicPause,
    MusicResume,
    Destroy,
}

fn default_sample_rate() -> u32 {
    24000
}
fn default_silence_duration() -> u32 {
    700
}

#[derive(Serialize, Debug, Clone)]
#[serde(tag = "type")]
#[serde(rename_all = "snake_case")]
enum OutMsg {
    Ready,
    AdapterSend {
        payload: Value,
    },
    ConnectionState {
        status: String,
    },
    PlayerState {
        status: String,
    },
    PlaybackArmed {
        reason: String,
    },
    SpeakingStart {
        #[serde(rename = "userId")]
        user_id: String,
    },
    SpeakingEnd {
        #[serde(rename = "userId")]
        user_id: String,
    },
    UserAudio {
        #[serde(rename = "userId")]
        user_id: String,
        #[serde(rename = "pcmBase64")]
        pcm_base64: String,
    },
    UserAudioEnd {
        #[serde(rename = "userId")]
        user_id: String,
    },
    MusicIdle,
    MusicError {
        message: String,
    },
    Error {
        message: String,
    },
}

fn send_msg(msg: &OutMsg) {
    if let Some(tx) = IPC_TX.get() {
        let _ = tx.try_send(msg.clone());
    }
}

fn send_error(message: &str) {
    send_msg(&OutMsg::Error {
        message: message.to_string(),
    });
}

fn spawn_ipc_writer() -> crossbeam::Sender<OutMsg> {
    let (tx, rx) = crossbeam::unbounded::<OutMsg>();
    std::thread::spawn(move || {
        let mut out = io::stdout().lock();
        for msg in rx {
            if let Ok(json) = serde_json::to_string(&msg) {
                let _ = writeln!(out, "{}", json);
                let _ = out.flush();
            }
        }
    });
    tx
}

// ---------------------------------------------------------------------------
// PCM resampling
// ---------------------------------------------------------------------------

fn resample_mono_i16(input: &[i16], in_rate: u32, out_rate: u32) -> Vec<i16> {
    if in_rate == out_rate || input.len() <= 1 {
        return input.to_vec();
    }
    let ratio = in_rate as f64 / out_rate as f64;
    let out_len = ((input.len() as f64) / ratio).floor() as usize;
    if out_len == 0 {
        return vec![];
    }
    let mut output = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = i as f64 * ratio;
        let idx = src_pos.floor() as usize;
        let next = (idx + 1).min(input.len() - 1);
        let frac = src_pos - idx as f64;
        let sample = input[idx] as f64 + frac * (input[next] as f64 - input[idx] as f64);
        output.push(sample.round().clamp(-32768.0, 32767.0) as i16);
    }
    output
}

/// Convert LLM output (mono i16 LE at `in_rate`) to 48kHz mono i16 for Opus encoding.
fn convert_llm_to_48k_mono(pcm: &[u8], in_rate: u32) -> Vec<i16> {
    let sample_count = pcm.len() / 2;
    if sample_count == 0 {
        return vec![];
    }
    let mut mono = Vec::with_capacity(sample_count);
    for i in 0..sample_count {
        mono.push(i16::from_le_bytes([pcm[i * 2], pcm[i * 2 + 1]]));
    }
    resample_mono_i16(&mono, in_rate, 48000)
}

/// Convert decoded stereo i16 48kHz to LLM input (mono i16 LE at `out_rate`).
fn convert_decoded_to_llm(stereo_i16: &[i16], out_rate: u32) -> Vec<u8> {
    let frame_count = stereo_i16.len() / 2;
    if frame_count == 0 {
        return vec![];
    }
    let mut mono = Vec::with_capacity(frame_count);
    for i in 0..frame_count {
        let l = stereo_i16[i * 2] as i32;
        let r = stereo_i16[i * 2 + 1] as i32;
        mono.push(((l + r) / 2).clamp(-32768, 32767) as i16);
    }
    let resampled = resample_mono_i16(&mono, 48000, out_rate);
    let mut buf = Vec::with_capacity(resampled.len() * 2);
    for &s in &resampled {
        buf.extend_from_slice(&s.to_le_bytes());
    }
    buf
}

// ---------------------------------------------------------------------------
// Partial voice connection info (accumulated from voice_server + voice_state)
// ---------------------------------------------------------------------------

#[derive(Default, Clone)]
struct PendingConnection {
    endpoint: Option<String>,
    token: Option<String>,
    session_id: Option<String>,
    user_id: Option<u64>,
}

impl PendingConnection {
    fn is_complete(&self) -> bool {
        self.endpoint.is_some()
            && self.token.is_some()
            && self.session_id.is_some()
            && self.user_id.is_some()
    }
}

// ---------------------------------------------------------------------------
// Audio send state (outbound TTS pipeline)
// ---------------------------------------------------------------------------

struct AudioSendState {
    pcm_buffer: VecDeque<i16>,
    encoder: OpusEncoder,
    speaking: bool,
    trailing_silence_frames: u32,
}

const MAX_TRAILING_SILENCE: u32 = 5; // 100ms of trailing silence

impl AudioSendState {
    fn new() -> Result<Self> {
        let encoder = OpusEncoder::new(SampleRate::Hz48000, Channels::Mono, Application::Voip)
            .map_err(|e| anyhow::anyhow!("Opus encoder init: {:?}", e))?;
        Ok(Self {
            pcm_buffer: VecDeque::new(),
            encoder,
            speaking: false,
            trailing_silence_frames: 0,
        })
    }

    fn push_pcm(&mut self, samples: Vec<i16>) {
        self.pcm_buffer.extend(samples);
        self.trailing_silence_frames = 0;
    }

    fn clear(&mut self) {
        self.pcm_buffer.clear();
        self.trailing_silence_frames = MAX_TRAILING_SILENCE;
    }

    /// Encode the next 20ms frame. Returns None if idle.
    fn next_opus_frame(&mut self) -> Option<Vec<u8>> {
        const FRAME_SIZE: usize = 960; // 20ms @ 48kHz mono

        if self.pcm_buffer.len() >= FRAME_SIZE {
            let pcm: Vec<i16> = self.pcm_buffer.drain(..FRAME_SIZE).collect();
            let mut opus_buf = vec![0u8; 4000];
            match self.encoder.encode(&pcm, &mut opus_buf) {
                Ok(len) => {
                    self.speaking = true;
                    self.trailing_silence_frames = 0;
                    return Some(opus_buf[..len].to_vec());
                }
                Err(e) => {
                    error!("Opus encode error: {:?}", e);
                    return None;
                }
            }
        }

        // Buffer empty — send trailing silence to avoid abrupt cutoff
        if self.trailing_silence_frames < MAX_TRAILING_SILENCE {
            self.trailing_silence_frames += 1;
            // Opus silence frame (RFC 6716 comfort noise)
            return Some(vec![0xF8, 0xFF, 0xFE]);
        }

        if self.speaking {
            self.speaking = false;
        }
        None
    }
}

// ---------------------------------------------------------------------------
// Music player (yt-dlp + ffmpeg → raw PCM)
// ---------------------------------------------------------------------------

struct MusicPlayer {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl MusicPlayer {
    fn start(url: &str, pcm_tx: crossbeam::Sender<Vec<i16>>) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();
        let url = url.to_string();

        let thread = std::thread::spawn(move || {
            let child = std::process::Command::new("sh")
                .args([
                    "-c",
                    &format!(
                        "yt-dlp -q -f bestaudio -o - '{}' | ffmpeg -i pipe:0 -f s16le -ar 48000 -ac 1 pipe:1 2>/dev/null",
                        url.replace('\'', "'\\''")
                    ),
                ])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn();

            let mut child = match child {
                Ok(c) => c,
                Err(e) => {
                    send_msg(&OutMsg::MusicError {
                        message: format!("yt-dlp/ffmpeg spawn failed: {}", e),
                    });
                    return;
                }
            };

            let stdout = match child.stdout.take() {
                Some(s) => s,
                None => return,
            };

            let mut reader = io::BufReader::with_capacity(48000 * 2, stdout); // 0.5s buffer
            let mut chunk = vec![0u8; 960 * 2]; // 20ms of mono i16

            loop {
                if stop_clone.load(Ordering::Relaxed) {
                    break;
                }
                match io::Read::read_exact(&mut reader, &mut chunk) {
                    Ok(()) => {
                        let mut samples = Vec::with_capacity(960);
                        for i in 0..960 {
                            samples.push(i16::from_le_bytes([chunk[i * 2], chunk[i * 2 + 1]]));
                        }
                        if pcm_tx.send(samples).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }

            let _ = child.kill();
            let _ = child.wait();

            if !stop_clone.load(Ordering::Relaxed) {
                send_msg(&OutMsg::MusicIdle);
            }
        });

        MusicPlayer {
            stop,
            thread: Some(thread),
        }
    }

    fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for MusicPlayer {
    fn drop(&mut self) {
        self.stop();
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(io::stderr)
        .init();

    let ipc_tx = spawn_ipc_writer();
    IPC_TX.set(ipc_tx).expect("IPC_TX already initialized");

    // Spawn stdin reader (blocking, off the tokio runtime)
    let (ipc_msg_tx, mut ipc_msg_rx) = mpsc::channel::<InMsg>(256);
    {
        let audio_debug = std::env::var("AUDIO_DEBUG").is_ok();
        std::thread::spawn(move || {
            let stdin = io::stdin();
            let handle = stdin.lock();
            for line in handle.lines() {
                match line {
                    Ok(l) => {
                        let trimmed = l.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<InMsg>(trimmed) {
                            Ok(msg) => {
                                if ipc_msg_tx.blocking_send(msg).is_err() {
                                    break;
                                }
                            }
                            Err(e) => {
                                if audio_debug {
                                    eprintln!(
                                        "[rust-subprocess] JSON parse error: {} for line: {}",
                                        e,
                                        &trimmed[..trimmed.len().min(200)]
                                    );
                                }
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    info!("Voice subprocess started, waiting for IPC messages");

    // ---- State ----
    let mut pending_conn = PendingConnection::default();
    let mut guild_id: Option<u64> = None;
    let mut channel_id: Option<u64> = None;
    let mut _self_mute = false;

    let dave: Arc<Mutex<Option<DaveManager>>> = Arc::new(Mutex::new(None));
    let mut voice_conn: Option<VoiceConnection> = None;
    let (voice_event_tx, mut voice_event_rx) = mpsc::channel::<VoiceEvent>(256);

    // Audio send pipeline: IPC audio → PCM buffer → 20ms Opus encode → DAVE encrypt → RTP
    let audio_send_state = Arc::new(Mutex::new(None::<AudioSendState>));
    let mut send_interval = time::interval(Duration::from_millis(20));
    send_interval.tick().await; // consume first immediate tick

    // Music → PCM channel (feeds into audio_send_state)
    let (music_pcm_tx, music_pcm_rx) = crossbeam::bounded::<Vec<i16>>(500);
    let mut music_player: Option<MusicPlayer> = None;

    // Opus decoder for inbound audio (stereo 48kHz)
    let mut opus_decoder =
        OpusDecoder::new(SampleRate::Hz48000, Channels::Stereo).expect("Opus decoder init");

    // SSRC → user_id mapping (mirrored from voice_conn's Speaking events)
    let mut ssrc_map: HashMap<u32, u64> = HashMap::new();
    let mut self_user_id: Option<u64> = None;
    let mut recv_sample_rate: u32 = 24000;

    loop {
        tokio::select! {
            // ---- IPC message from main process ----
            Some(msg) = ipc_msg_rx.recv() => {
                match msg {
                    InMsg::Join { guild_id: gid, channel_id: cid, self_deaf: _, self_mute: sm } => {
                        let g: u64 = match gid.parse() {
                            Ok(v) => v,
                            Err(_) => { send_error("Invalid guild ID"); continue; }
                        };
                        let c: u64 = match cid.parse() {
                            Ok(v) => v,
                            Err(_) => { send_error("Invalid channel ID"); continue; }
                        };
                        guild_id = Some(g);
                        channel_id = Some(c);
                        _self_mute = sm;

                        // Send OP4 via the gateway adapter proxy
                        send_msg(&OutMsg::AdapterSend {
                            payload: serde_json::json!({
                                "op": 4,
                                "d": {
                                    "guild_id": gid,
                                    "channel_id": cid,
                                    "self_mute": sm,
                                    "self_deaf": false,
                                }
                            }),
                        });
                        info!("Join requested guild={} channel={}, sent OP4", g, c);
                    }

                    InMsg::VoiceServer { data } => {
                        if let Some(ep) = data.get("endpoint").and_then(|v| v.as_str()) {
                            pending_conn.endpoint = Some(ep.to_string());
                        }
                        if let Some(tk) = data.get("token").and_then(|v| v.as_str()) {
                            pending_conn.token = Some(tk.to_string());
                        }
                        debug!("voice_server: endpoint={:?}", pending_conn.endpoint);
                        try_connect(
                            &pending_conn, guild_id, channel_id, self_user_id,
                            &voice_event_tx, &dave, &mut voice_conn, &audio_send_state,
                        ).await;
                    }

                    InMsg::VoiceState { data } => {
                        if let Some(sid) = data.get("session_id").and_then(|v| v.as_str()) {
                            pending_conn.session_id = Some(sid.to_string());
                        }
                        if let Some(uid) = data.get("user_id").and_then(|v| v.as_str()).and_then(|s| s.parse::<u64>().ok()) {
                            pending_conn.user_id = Some(uid);
                            self_user_id = Some(uid);
                        }
                        debug!("voice_state: session_id={:?} user_id={:?}", pending_conn.session_id, self_user_id);
                        try_connect(
                            &pending_conn, guild_id, channel_id, self_user_id,
                            &voice_event_tx, &dave, &mut voice_conn, &audio_send_state,
                        ).await;
                    }

                    InMsg::Audio { pcm_base64, sample_rate } => {
                        let engine = base64::engine::general_purpose::STANDARD;
                        if let Ok(raw) = engine.decode(&pcm_base64) {
                            let samples = convert_llm_to_48k_mono(&raw, sample_rate);
                            if !samples.is_empty() {
                                let mut guard = audio_send_state.lock();
                                if let Some(ref mut state) = *guard {
                                    state.push_pcm(samples);
                                }
                            }
                        }
                    }

                    InMsg::StopPlayback => {
                        if let Some(ref mut mp) = music_player {
                            mp.stop();
                        }
                        music_player = None;

                        let mut guard = audio_send_state.lock();
                        if let Some(ref mut state) = *guard {
                            state.clear();
                        }
                        send_msg(&OutMsg::PlayerState { status: "idle".into() });
                    }

                    InMsg::SubscribeUser { sample_rate, .. } => {
                        recv_sample_rate = sample_rate;
                    }

                    InMsg::UnsubscribeUser { .. } => {
                        // VoiceTick-style capture is always on; filtering is in main process
                    }

                    InMsg::MusicPlay { url } => {
                        // Stop existing music
                        if let Some(ref mut mp) = music_player {
                            mp.stop();
                        }
                        // Clear TTS buffer
                        {
                            let mut guard = audio_send_state.lock();
                            if let Some(ref mut state) = *guard {
                                state.clear();
                            }
                        }
                        music_player = Some(MusicPlayer::start(&url, music_pcm_tx.clone()));
                        send_msg(&OutMsg::PlayerState { status: "playing".into() });
                        info!("music_play url={}", url);
                    }

                    InMsg::MusicStop => {
                        if let Some(ref mut mp) = music_player {
                            mp.stop();
                        }
                        music_player = None;
                        send_msg(&OutMsg::MusicIdle);
                    }

                    InMsg::MusicPause | InMsg::MusicResume => {
                        // yt-dlp piped playback doesn't support pause/resume easily.
                        // For now, pause = stop.
                        if matches!(msg, InMsg::MusicPause) {
                            if let Some(ref mut mp) = music_player {
                                mp.stop();
                            }
                            music_player = None;
                            send_msg(&OutMsg::PlayerState { status: "paused".into() });
                        }
                    }

                    InMsg::Destroy => {
                        if let Some(ref mut mp) = music_player {
                            mp.stop();
                        }
                        if let Some(ref conn) = voice_conn {
                            conn.shutdown();
                        }
                        break;
                    }
                }
            }

            // ---- Voice connection events ----
            Some(event) = voice_event_rx.recv() => {
                match event {
                    VoiceEvent::Ready { ssrc } => {
                        info!("Voice connection ready, ssrc={}", ssrc);
                        send_msg(&OutMsg::ConnectionState { status: "ready".into() });
                        send_msg(&OutMsg::Ready);

                        // Initialize the audio send pipeline
                        match AudioSendState::new() {
                            Ok(state) => {
                                *audio_send_state.lock() = Some(state);
                                send_msg(&OutMsg::PlaybackArmed { reason: "connection_ready".into() });
                            }
                            Err(e) => error!("Failed to init audio send state: {}", e),
                        }
                    }

                    VoiceEvent::SpeakingUpdate { ssrc, user_id, speaking } => {
                        ssrc_map.insert(ssrc, user_id);

                        if self_user_id == Some(user_id) {
                            continue; // skip bot's own speaking events
                        }

                        let uid_str = user_id.to_string();
                        if speaking {
                            send_msg(&OutMsg::SpeakingStart { user_id: uid_str });
                        } else {
                            send_msg(&OutMsg::SpeakingEnd { user_id: uid_str });
                        }
                    }

                    VoiceEvent::OpusReceived { ssrc, opus_frame } => {
                        let uid = match ssrc_map.get(&ssrc) {
                            Some(&uid) => uid,
                            None => continue,
                        };
                        if self_user_id == Some(uid) {
                            continue; // skip bot's own audio
                        }

                        // Opus decode → stereo i16 48kHz
                        let mut pcm_stereo = vec![0i16; 5760]; // max Opus frame
                        let decode_result = {
                            let packet = OpusPacket::try_from(opus_frame.as_slice()).ok();
                            let signals = MutSignals::try_from(pcm_stereo.as_mut_slice())
                                .expect("non-empty signal buffer");
                            opus_decoder.decode(packet, signals, false)
                        };
                        match decode_result {
                            Ok(samples_per_channel) => {
                                let total_samples = samples_per_channel * 2; // stereo
                                let decoded = &pcm_stereo[..total_samples];

                                let llm_pcm = convert_decoded_to_llm(decoded, recv_sample_rate);
                                if !llm_pcm.is_empty() {
                                    let engine = base64::engine::general_purpose::STANDARD;
                                    send_msg(&OutMsg::UserAudio {
                                        user_id: uid.to_string(),
                                        pcm_base64: engine.encode(&llm_pcm),
                                    });
                                }
                            }
                            Err(e) => {
                                debug!("Opus decode error for ssrc={}: {:?}", ssrc, e);
                            }
                        }
                    }

                    VoiceEvent::DaveReady => {
                        info!("DAVE E2EE session is ready");
                    }

                    VoiceEvent::Disconnected { reason } => {
                        warn!("Voice disconnected: {}", reason);
                        send_msg(&OutMsg::ConnectionState { status: "disconnected".into() });
                        voice_conn = None;
                        *audio_send_state.lock() = None;
                    }

                    VoiceEvent::Error { message } => {
                        error!("Voice connection error: {}", message);
                        send_msg(&OutMsg::Error { message });
                    }
                }
            }

            // ---- 20ms audio send tick ----
            _ = send_interval.tick() => {
                // Drain music PCM into the audio send buffer
                while let Ok(chunk) = music_pcm_rx.try_recv() {
                    let mut guard = audio_send_state.lock();
                    if let Some(ref mut state) = *guard {
                        state.push_pcm(chunk);
                    }
                }

                // Encode + encrypt + send one frame
                let opus_frame = {
                    let mut guard = audio_send_state.lock();
                    match *guard {
                        Some(ref mut state) => state.next_opus_frame(),
                        None => None,
                    }
                };

                if let Some(opus) = opus_frame {
                    // DAVE encrypt if session is active
                    let encrypted = {
                        let mut guard = dave.lock();
                        match *guard {
                            Some(ref mut dm) if dm.is_ready() => {
                                dm.encrypt_opus(&opus).unwrap_or_else(|e| {
                                    debug!("DAVE encrypt fallback: {}", e);
                                    opus.clone()
                                })
                            }
                            _ => opus,
                        }
                    };

                    if let Some(ref conn) = voice_conn {
                        if let Err(e) = conn.send_rtp_frame(&encrypted).await {
                            debug!("RTP send error: {}", e);
                        }
                    }
                }
            }
        }
    }

    info!("Shutting down");
}

/// Attempt to establish the voice connection once we have all required info.
#[allow(clippy::too_many_arguments)]
async fn try_connect(
    pending: &PendingConnection,
    guild_id: Option<u64>,
    channel_id: Option<u64>,
    _self_user_id: Option<u64>,
    event_tx: &mpsc::Sender<VoiceEvent>,
    dave: &Arc<Mutex<Option<DaveManager>>>,
    voice_conn: &mut Option<VoiceConnection>,
    _audio_send_state: &Arc<Mutex<Option<AudioSendState>>>,
) {
    if voice_conn.is_some() || !pending.is_complete() {
        return;
    }
    let gid = match guild_id {
        Some(g) => g,
        None => return,
    };
    let cid = match channel_id {
        Some(c) => c,
        None => return,
    };
    let uid = pending.user_id.unwrap();

    info!(
        "Connecting to voice: endpoint={:?} guild={} channel={} user={}",
        pending.endpoint, gid, cid, uid
    );

    match VoiceConnection::connect(
        pending.endpoint.as_ref().unwrap(),
        gid,
        uid,
        pending.session_id.as_ref().unwrap(),
        pending.token.as_ref().unwrap(),
        cid,
        event_tx.clone(),
        dave.clone(),
    )
    .await
    {
        Ok(conn) => {
            *voice_conn = Some(conn);
        }
        Err(e) => {
            error!("Voice connection failed: {}", e);
            send_msg(&OutMsg::Error {
                message: format!("Voice connect failed: {}", e),
            });
        }
    }
}
