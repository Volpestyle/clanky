use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tokio::time;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::MaybeTlsStream;
use tracing::{debug, error, info, warn};

use crate::dave::DaveManager;

type WsStream = tokio_tungstenite::WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

// ---------------------------------------------------------------------------
// Events emitted by the voice connection back to the main loop
// ---------------------------------------------------------------------------

pub enum VoiceEvent {
    Ready {
        ssrc: u32,
    },
    SpeakingUpdate {
        ssrc: u32,
        user_id: u64,
        speaking: bool,
    },
    OpusReceived {
        ssrc: u32,
        opus_frame: Vec<u8>,
    },
    DaveReady,
    Disconnected {
        reason: String,
    },
    Error {
        message: String,
    },
}

// ---------------------------------------------------------------------------
// Internal commands for the WS write task
// ---------------------------------------------------------------------------

enum WsCommand {
    SendJson(Value),
    SendBinary(Vec<u8>),
}

// ---------------------------------------------------------------------------
// RTP header (minimal, Discord voice)
// ---------------------------------------------------------------------------

const RTP_HEADER_LEN: usize = 12;
const OPUS_PT: u8 = 0x78; // payload type 120

fn build_rtp_header(sequence: u16, timestamp: u32, ssrc: u32) -> [u8; RTP_HEADER_LEN] {
    let mut h = [0u8; RTP_HEADER_LEN];
    h[0] = 0x80; // V=2, P=0, X=0, CC=0
    h[1] = OPUS_PT;
    h[2..4].copy_from_slice(&sequence.to_be_bytes());
    h[4..8].copy_from_slice(&timestamp.to_be_bytes());
    h[8..12].copy_from_slice(&ssrc.to_be_bytes());
    h
}

fn parse_rtp_header(data: &[u8]) -> Option<(u16, u32, u32, usize)> {
    if data.len() < RTP_HEADER_LEN {
        return None;
    }
    let cc = (data[0] & 0x0F) as usize;
    let has_ext = (data[0] >> 4) & 0x01 != 0;
    let seq = u16::from_be_bytes([data[2], data[3]]);
    let ts = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);
    let ssrc = u32::from_be_bytes([data[8], data[9], data[10], data[11]]);

    let mut header_size = RTP_HEADER_LEN + cc * 4;
    if has_ext && data.len() >= header_size + 4 {
        let ext_len = u16::from_be_bytes([data[header_size + 2], data[header_size + 3]]) as usize;
        header_size += 4 + ext_len * 4;
    }
    Some((seq, ts, ssrc, header_size))
}

// ---------------------------------------------------------------------------
// Transport encryption (AES-256-GCM "rtpsize" mode)
// ---------------------------------------------------------------------------

struct TransportCrypto {
    cipher: Aes256Gcm,
    send_nonce: AtomicU32,
}

impl TransportCrypto {
    fn new(secret_key: &[u8]) -> Result<Self> {
        let cipher =
            Aes256Gcm::new_from_slice(secret_key).context("Invalid AES-256-GCM secret key")?;
        Ok(Self {
            cipher,
            send_nonce: AtomicU32::new(0),
        })
    }

    /// Encrypt an Opus payload for sending.
    /// Returns `[ciphertext + 16-byte tag + 4-byte BE nonce]`.
    fn encrypt(&self, rtp_header: &[u8], payload: &[u8]) -> Result<Vec<u8>> {
        let nonce_val = self.send_nonce.fetch_add(1, Ordering::SeqCst);
        let mut nonce_12 = [0u8; 12];
        nonce_12[0..4].copy_from_slice(&nonce_val.to_be_bytes());

        let ct = self
            .cipher
            .encrypt(
                Nonce::from_slice(&nonce_12),
                Payload {
                    msg: payload,
                    aad: rtp_header,
                },
            )
            .map_err(|e| anyhow::anyhow!("AES-GCM encrypt: {}", e))?;

        let mut out = ct; // ciphertext + tag
        out.extend_from_slice(&nonce_val.to_be_bytes());
        Ok(out)
    }

    /// Decrypt a received RTP payload.
    /// `packet` is the full UDP datagram, `header_size` is the RTP header length.
    fn decrypt(&self, packet: &[u8], header_size: usize) -> Result<Vec<u8>> {
        // Layout: [rtp_header | ciphertext + 16-byte tag | 4-byte BE nonce]
        if packet.len() < header_size + 4 + 16 {
            bail!("Packet too small for transport decryption");
        }
        let rtp_header = &packet[..header_size];
        let nonce_start = packet.len() - 4;
        let nonce_raw = &packet[nonce_start..];
        let ct_with_tag = &packet[header_size..nonce_start];

        let mut nonce_12 = [0u8; 12];
        nonce_12[0..4].copy_from_slice(nonce_raw);

        self.cipher
            .decrypt(
                Nonce::from_slice(&nonce_12),
                Payload {
                    msg: ct_with_tag,
                    aad: rtp_header,
                },
            )
            .map_err(|e| anyhow::anyhow!("AES-GCM decrypt: {}", e))
    }
}

// ---------------------------------------------------------------------------
// UDP IP discovery (Discord voice hole-punch)
// ---------------------------------------------------------------------------

async fn ip_discovery(socket: &UdpSocket, ssrc: u32) -> Result<(String, u16)> {
    let mut buf = [0u8; 74];
    // Type=0x0001, Length=70
    buf[0..2].copy_from_slice(&0x0001u16.to_be_bytes());
    buf[2..4].copy_from_slice(&70u16.to_be_bytes());
    buf[4..8].copy_from_slice(&ssrc.to_be_bytes());

    socket.send(&buf).await.context("IP discovery send")?;

    let mut resp = [0u8; 74];
    let timeout = time::timeout(Duration::from_secs(5), socket.recv(&mut resp)).await;
    let n = timeout
        .context("IP discovery timeout")?
        .context("IP discovery recv")?;
    if n < 74 {
        bail!("IP discovery response too short: {} bytes", n);
    }

    // Response: [type(2) | length(2) | ssrc(4) | address(64) | port(2)]
    let ip_bytes = &resp[8..72];
    let ip = std::str::from_utf8(ip_bytes)
        .context("IP discovery: invalid UTF-8")?
        .trim_end_matches('\0')
        .to_string();
    let port = u16::from_be_bytes([resp[72], resp[73]]);

    info!("IP discovery: external {}:{}", ip, port);
    Ok((ip, port))
}

// ---------------------------------------------------------------------------
// VoiceConnection — the public handle
// ---------------------------------------------------------------------------

pub struct VoiceConnection {
    ws_cmd_tx: mpsc::Sender<WsCommand>,
    pub ssrc: u32,
    shutdown: Arc<AtomicBool>,
    udp_socket: Arc<UdpSocket>,
    crypto: Arc<TransportCrypto>,
    sequence: AtomicU32,
    timestamp: AtomicU32,
}

impl VoiceConnection {
    /// Perform the full voice WS + UDP handshake, then spawn background tasks.
    pub async fn connect(
        endpoint: &str,
        guild_id: u64,
        user_id: u64,
        session_id: &str,
        token: &str,
        channel_id: u64,
        event_tx: mpsc::Sender<VoiceEvent>,
        dave: Arc<Mutex<Option<DaveManager>>>,
    ) -> Result<Self> {
        let ep = endpoint
            .trim_start_matches("wss://")
            .trim_end_matches('/');
        let ws_url = format!("wss://{}/?v=8", ep);
        info!("Connecting voice WS: {}", ws_url);

        let (ws, _) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .context("Voice WS connect failed")?;
        let (mut ws_write, mut ws_read) = ws.split();

        // ---- OP8 Hello ----
        let heartbeat_interval = recv_hello(&mut ws_read).await?;

        // ---- OP0 Identify (advertise DAVE v1) ----
        let identify = json!({
            "op": 0,
            "d": {
                "server_id": guild_id.to_string(),
                "user_id": user_id.to_string(),
                "session_id": session_id,
                "token": token,
                "max_dave_protocol_version": 1
            }
        });
        ws_write
            .send(Message::Text(identify.to_string()))
            .await
            .context("Send Identify")?;

        // ---- OP2 Ready ----
        let (ssrc, voice_ip, voice_port, modes) = recv_ready(&mut ws_read).await?;
        info!(
            "Voice Ready: ssrc={} udp={}:{} modes={:?}",
            ssrc, voice_ip, voice_port, modes
        );

        // ---- UDP socket + IP discovery ----
        let udp = UdpSocket::bind("0.0.0.0:0")
            .await
            .context("UDP bind")?;
        let voice_addr: SocketAddr = format!("{}:{}", voice_ip, voice_port)
            .parse()
            .context("Parse voice UDP addr")?;
        udp.connect(voice_addr).await.context("UDP connect")?;

        let (external_ip, external_port) = ip_discovery(&udp, ssrc).await?;

        // ---- Select encryption mode ----
        let mode = if modes.iter().any(|m| m == "aead_aes256_gcm_rtpsize") {
            "aead_aes256_gcm_rtpsize"
        } else {
            bail!(
                "No supported encryption mode (need aead_aes256_gcm_rtpsize), got: {:?}",
                modes
            );
        };

        // ---- OP1 Select Protocol ----
        let select = json!({
            "op": 1,
            "d": {
                "protocol": "udp",
                "data": {
                    "address": external_ip,
                    "port": external_port,
                    "mode": mode
                },
                "codecs": [{
                    "name": "opus",
                    "type": "audio",
                    "priority": 1000,
                    "payload_type": 120
                }]
            }
        });
        ws_write
            .send(Message::Text(select.to_string()))
            .await
            .context("Send Select Protocol")?;

        // ---- OP4 Session Description ----
        let secret_key = recv_session_description(&mut ws_read).await?;
        let crypto = Arc::new(TransportCrypto::new(&secret_key)?);
        info!("Voice session established, transport crypto ready");

        // ---- Spawn background tasks ----
        let shutdown = Arc::new(AtomicBool::new(false));
        let (ws_cmd_tx, ws_cmd_rx) = mpsc::channel::<WsCommand>(128);
        let udp = Arc::new(udp);
        let ssrc_map: Arc<Mutex<HashMap<u32, u64>>> = Arc::new(Mutex::new(HashMap::new()));

        // WS read loop (handles Speaking updates, DAVE opcodes, etc.)
        {
            let shutdown = shutdown.clone();
            let event_tx = event_tx.clone();
            let dave = dave.clone();
            let ws_cmd_tx = ws_cmd_tx.clone();
            let ssrc_map = ssrc_map.clone();
            tokio::spawn(async move {
                ws_read_loop(ws_read, event_tx, ws_cmd_tx, dave, ssrc_map, shutdown, user_id, channel_id).await;
            });
        }

        // WS write loop (heartbeat + outgoing commands)
        {
            let shutdown = shutdown.clone();
            tokio::spawn(async move {
                ws_write_loop(ws_write, ws_cmd_rx, shutdown, heartbeat_interval).await;
            });
        }

        // UDP receive loop
        {
            let shutdown = shutdown.clone();
            let event_tx = event_tx.clone();
            let crypto = crypto.clone();
            let dave = dave.clone();
            let udp = udp.clone();
            let ssrc_map = ssrc_map.clone();
            tokio::spawn(async move {
                udp_recv_loop(udp, crypto, dave, ssrc_map, event_tx, shutdown).await;
            });
        }

        // Set speaking state so Discord knows we may transmit
        let _ = ws_cmd_tx
            .send(WsCommand::SendJson(json!({
                "op": 5,
                "d": { "speaking": 5, "delay": 0, "ssrc": ssrc }
            })))
            .await;

        Ok(VoiceConnection {
            ws_cmd_tx,
            ssrc,
            shutdown,
            udp_socket: udp,
            crypto,
            sequence: AtomicU32::new(0),
            timestamp: AtomicU32::new(0),
        })
    }

    /// Build an RTP packet, transport-encrypt, and send via UDP.
    /// `opus_payload` should already be DAVE-encrypted if DAVE is active.
    pub async fn send_rtp_frame(&self, opus_payload: &[u8]) -> Result<()> {
        let seq = self.sequence.fetch_add(1, Ordering::SeqCst) as u16;
        let ts = self.timestamp.fetch_add(960, Ordering::SeqCst); // 20ms @ 48kHz
        let header = build_rtp_header(seq, ts, self.ssrc);

        let encrypted = self.crypto.encrypt(&header, opus_payload)?;

        let mut packet = Vec::with_capacity(RTP_HEADER_LEN + encrypted.len());
        packet.extend_from_slice(&header);
        packet.extend_from_slice(&encrypted);

        self.udp_socket
            .send(&packet)
            .await
            .context("UDP send")?;
        Ok(())
    }

    pub async fn set_speaking(&self, speaking: bool) {
        let flags: u32 = if speaking { 5 } else { 0 }; // MICROPHONE | PRIORITY
        let _ = self
            .ws_cmd_tx
            .send(WsCommand::SendJson(json!({
                "op": 5,
                "d": { "speaking": flags, "delay": 0, "ssrc": self.ssrc }
            })))
            .await;
    }

    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------------------
// Handshake helpers (synchronous WS reads during connect)
// ---------------------------------------------------------------------------

async fn recv_hello(
    ws: &mut (impl StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin),
) -> Result<f64> {
    let deadline = time::Instant::now() + Duration::from_secs(10);
    loop {
        let msg = time::timeout_at(deadline, ws.next())
            .await
            .context("Timeout waiting for OP8 Hello")?
            .context("WS stream ended")?
            .context("WS error")?;
        if let Message::Text(text) = msg {
            let v: Value = serde_json::from_str(&text)?;
            if v["op"].as_u64() == Some(8) {
                return Ok(v["d"]["heartbeat_interval"].as_f64().unwrap_or(13750.0));
            }
        }
    }
}

async fn recv_ready(
    ws: &mut (impl StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin),
) -> Result<(u32, String, u16, Vec<String>)> {
    let deadline = time::Instant::now() + Duration::from_secs(10);
    loop {
        let msg = time::timeout_at(deadline, ws.next())
            .await
            .context("Timeout waiting for OP2 Ready")?
            .context("WS stream ended")?
            .context("WS error")?;
        if let Message::Text(text) = msg {
            let v: Value = serde_json::from_str(&text)?;
            if v["op"].as_u64() == Some(2) {
                let d = &v["d"];
                let ssrc = d["ssrc"].as_u64().context("missing ssrc")? as u32;
                let ip = d["ip"].as_str().context("missing ip")?.to_string();
                let port = d["port"].as_u64().context("missing port")? as u16;
                let modes: Vec<String> = d["modes"]
                    .as_array()
                    .context("missing modes")?
                    .iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect();
                return Ok((ssrc, ip, port, modes));
            }
        }
    }
}

async fn recv_session_description(
    ws: &mut (impl StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin),
) -> Result<Vec<u8>> {
    let deadline = time::Instant::now() + Duration::from_secs(10);
    loop {
        let msg = time::timeout_at(deadline, ws.next())
            .await
            .context("Timeout waiting for OP4 Session Description")?
            .context("WS stream ended")?
            .context("WS error")?;
        if let Message::Text(text) = msg {
            let v: Value = serde_json::from_str(&text)?;
            if v["op"].as_u64() == Some(4) {
                let key: Vec<u8> = v["d"]["secret_key"]
                    .as_array()
                    .context("missing secret_key")?
                    .iter()
                    .map(|b| b.as_u64().unwrap_or(0) as u8)
                    .collect();
                return Ok(key);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Background tasks
// ---------------------------------------------------------------------------

async fn ws_read_loop(
    mut ws_read: futures_util::stream::SplitStream<WsStream>,
    event_tx: mpsc::Sender<VoiceEvent>,
    ws_cmd_tx: mpsc::Sender<WsCommand>,
    dave: Arc<Mutex<Option<DaveManager>>>,
    ssrc_map: Arc<Mutex<HashMap<u32, u64>>>,
    shutdown: Arc<AtomicBool>,
    bot_user_id: u64,
    channel_id: u64,
) {
    while let Some(msg) = ws_read.next().await {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match msg {
            Ok(Message::Text(text)) => {
                let v: Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let op = v["op"].as_u64().unwrap_or(u64::MAX);
                let d = &v["d"];
                handle_text_opcode(
                    op, d, &event_tx, &ws_cmd_tx, &dave, &ssrc_map, bot_user_id, channel_id,
                )
                .await;
            }
            Ok(Message::Binary(data)) => {
                if data.is_empty() {
                    continue;
                }
                handle_binary_opcode(&data, &event_tx, &ws_cmd_tx, &dave).await;
            }
            Ok(Message::Close(_)) => {
                let _ = event_tx
                    .send(VoiceEvent::Disconnected {
                        reason: "WebSocket closed by server".into(),
                    })
                    .await;
                break;
            }
            Err(e) => {
                let _ = event_tx
                    .send(VoiceEvent::Error {
                        message: format!("WS read error: {}", e),
                    })
                    .await;
                break;
            }
            _ => {}
        }
    }
    info!("Voice WS read loop exited");
}

#[allow(clippy::too_many_arguments)]
async fn handle_text_opcode(
    op: u64,
    d: &Value,
    event_tx: &mpsc::Sender<VoiceEvent>,
    _ws_cmd_tx: &mpsc::Sender<WsCommand>,
    dave: &Arc<Mutex<Option<DaveManager>>>,
    ssrc_map: &Arc<Mutex<HashMap<u32, u64>>>,
    bot_user_id: u64,
    channel_id: u64,
) {
    match op {
        // Heartbeat ACK
        6 => {
            debug!("Voice heartbeat ACK");
        }
        // Speaking state update
        5 => {
            let ssrc = d["ssrc"].as_u64().unwrap_or(0) as u32;
            let uid = d["user_id"]
                .as_str()
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);
            let speaking = d["speaking"].as_u64().unwrap_or(0);

            ssrc_map.lock().insert(ssrc, uid);

            let _ = event_tx
                .send(VoiceEvent::SpeakingUpdate {
                    ssrc,
                    user_id: uid,
                    speaking: speaking != 0,
                })
                .await;
        }
        // Client disconnect
        12 => {
            if let Some(uid) = d["user_id"]
                .as_str()
                .and_then(|s| s.parse::<u64>().ok())
            {
                ssrc_map.lock().retain(|_, v| *v != uid);
            }
        }
        // DAVE: Prepare Epoch
        21 => {
            let pv = d["protocol_version"].as_u64().unwrap_or(0) as u16;
            let epoch = d["epoch"].as_u64().unwrap_or(0);
            info!("DAVE: prepare epoch pv={} epoch={}", pv, epoch);

            if pv > 0 {
                let mut guard = dave.lock();
                if guard.is_none() {
                    match DaveManager::new(pv, bot_user_id, channel_id) {
                        Ok(dm) => *guard = Some(dm),
                        Err(e) => error!("Failed to create DaveManager: {}", e),
                    }
                }
            }
        }
        // DAVE: Prepare Transition
        22 => {
            debug!("DAVE: prepare transition");
        }
        // DAVE: Execute Transition — the new epoch is active
        23 => {
            info!("DAVE: execute transition (epoch active)");
            let ready = {
                let guard = dave.lock();
                guard.as_ref().map_or(false, |dm| dm.is_ready())
            };
            if ready {
                let _ = event_tx.send(VoiceEvent::DaveReady).await;
            }
        }
        _ => {
            debug!("Unknown voice WS opcode: {}", op);
        }
    }
}

async fn handle_binary_opcode(
    data: &[u8],
    event_tx: &mpsc::Sender<VoiceEvent>,
    ws_cmd_tx: &mpsc::Sender<WsCommand>,
    dave: &Arc<Mutex<Option<DaveManager>>>,
) {
    // Binary frames: first byte is the opcode, rest is payload
    let opcode = data[0];
    let payload = &data[1..];

    match opcode {
        // OP25: MLS External Sender Package (server → client)
        25 => {
            debug!("DAVE binary OP25: external sender ({} bytes)", payload.len());
            let response = {
                let mut guard = dave.lock();
                if let Some(ref mut dm) = *guard {
                    if let Err(e) = dm.set_external_sender(payload) {
                        error!("DAVE set_external_sender: {}", e);
                        None
                    } else {
                        match dm.create_key_package() {
                            Ok(pkg) => Some(pkg),
                            Err(e) => {
                                error!("DAVE create_key_package: {}", e);
                                None
                            }
                        }
                    }
                } else {
                    None
                }
            };
            if let Some(pkg) = response {
                let mut frame = Vec::with_capacity(1 + pkg.len());
                frame.push(26); // OP26
                frame.extend_from_slice(&pkg);
                let _ = ws_cmd_tx.send(WsCommand::SendBinary(frame)).await;
                debug!("DAVE: sent key package OP26 ({} bytes)", pkg.len());
            }
        }
        // OP27: MLS Proposals (server → client)
        27 => {
            debug!("DAVE binary OP27: proposals ({} bytes)", payload.len());
            let response = {
                let mut guard = dave.lock();
                if let Some(ref mut dm) = *guard {
                    match dm.process_proposals(
                        davey::ProposalsOperationType::APPEND,
                        payload,
                        None,
                    ) {
                        Ok(Some(cr)) => Some(cr.data),
                        Ok(None) => {
                            debug!("DAVE: no commit needed for proposals");
                            None
                        }
                        Err(e) => {
                            error!("DAVE process_proposals: {}", e);
                            None
                        }
                    }
                } else {
                    None
                }
            };
            if let Some(commit_data) = response {
                let mut frame = Vec::with_capacity(1 + commit_data.len());
                frame.push(28); // OP28
                frame.extend_from_slice(&commit_data);
                let _ = ws_cmd_tx.send(WsCommand::SendBinary(frame)).await;
                debug!("DAVE: sent commit OP28 ({} bytes)", commit_data.len());
            }
        }
        // OP29: MLS Announce Commit Transition (server → client)
        29 => {
            debug!("DAVE binary OP29: announce commit ({} bytes)", payload.len());
            let ready = {
                let mut guard = dave.lock();
                if let Some(ref mut dm) = *guard {
                    if let Err(e) = dm.process_commit(payload) {
                        error!("DAVE process_commit: {}", e);
                    }
                    dm.is_ready()
                } else {
                    false
                }
            };
            if ready {
                let _ = event_tx.send(VoiceEvent::DaveReady).await;
            }
        }
        // OP30: MLS Welcome (server → client)
        30 => {
            debug!("DAVE binary OP30: welcome ({} bytes)", payload.len());
            let ready = {
                let mut guard = dave.lock();
                if let Some(ref mut dm) = *guard {
                    if let Err(e) = dm.process_welcome(payload) {
                        error!("DAVE process_welcome: {}", e);
                    }
                    dm.is_ready()
                } else {
                    false
                }
            };
            if ready {
                let _ = event_tx.send(VoiceEvent::DaveReady).await;
            }
        }
        // OP31: MLS Invalid Commit Welcome
        31 => {
            warn!(
                "DAVE binary OP31: invalid commit welcome ({} bytes)",
                payload.len()
            );
        }
        _ => {
            debug!(
                "Unknown binary voice opcode: {} ({} bytes)",
                opcode,
                payload.len()
            );
        }
    }
}

async fn ws_write_loop(
    mut ws_write: futures_util::stream::SplitSink<WsStream, Message>,
    mut cmd_rx: mpsc::Receiver<WsCommand>,
    shutdown: Arc<AtomicBool>,
    heartbeat_interval_ms: f64,
) {
    let hb_dur = Duration::from_millis(heartbeat_interval_ms as u64);
    let mut hb_interval = time::interval(hb_dur);
    hb_interval.tick().await; // consume immediate first tick

    loop {
        tokio::select! {
            _ = hb_interval.tick() => {
                if shutdown.load(Ordering::Relaxed) { break; }
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                let hb = json!({ "op": 3, "d": ts });
                if ws_write.send(Message::Text(hb.to_string())).await.is_err() {
                    break;
                }
            }
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(WsCommand::SendJson(v)) => {
                        if ws_write.send(Message::Text(v.to_string())).await.is_err() {
                            break;
                        }
                    }
                    Some(WsCommand::SendBinary(data)) => {
                        if ws_write.send(Message::Binary(data)).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
        }
    }
    info!("Voice WS write loop exited");
}

async fn udp_recv_loop(
    socket: Arc<UdpSocket>,
    crypto: Arc<TransportCrypto>,
    dave: Arc<Mutex<Option<DaveManager>>>,
    ssrc_map: Arc<Mutex<HashMap<u32, u64>>>,
    event_tx: mpsc::Sender<VoiceEvent>,
    shutdown: Arc<AtomicBool>,
) {
    let mut buf = [0u8; 2048];
    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        let n = match socket.recv(&mut buf).await {
            Ok(n) => n,
            Err(_) => continue,
        };
        let packet = &buf[..n];

        let (_seq, _ts, ssrc, header_size) = match parse_rtp_header(packet) {
            Some(h) => h,
            None => continue,
        };

        // Transport decrypt
        let opus_or_dave = match crypto.decrypt(packet, header_size) {
            Ok(p) => p,
            Err(_) => continue, // silently drop corrupt packets
        };

        // DAVE decrypt (if session active)
        let user_id = ssrc_map.lock().get(&ssrc).copied();
        let opus_frame = if let Some(uid) = user_id {
            let mut guard = dave.lock();
            if let Some(ref mut dm) = *guard {
                dm.decrypt(uid, &opus_or_dave).unwrap_or(opus_or_dave)
            } else {
                opus_or_dave
            }
        } else {
            opus_or_dave
        };

        let _ = event_tx
            .send(VoiceEvent::OpusReceived { ssrc, opus_frame })
            .await;
    }
    info!("UDP recv loop exited");
}
