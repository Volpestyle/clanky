use std::collections::HashMap;
use std::num::NonZeroU16;

use anyhow::{Context, Result};
use davey::{DaveSession, MediaType, ProposalsOperationType};
use tracing::{debug, info, warn};

/// Maximum consecutive DAVE decrypt failures before triggering session recovery.
/// Matches discord.js DEFAULT_DECRYPTION_FAILURE_TOLERANCE.
pub const FAILURE_TOLERANCE: u32 = 36;

/// Passthrough expiry (seconds) for pending downgrades (protocol_version → 0).
const PASSTHROUGH_DOWNGRADE_EXPIRY: u32 = 24;

/// Passthrough expiry (seconds) for upgrades (protocol_version 0 → N).
const PASSTHROUGH_TRANSITION_EXPIRY: u32 = 10;

pub struct DaveManager {
    session: DaveSession,
    ready: bool,
    user_id: u64,
    channel_id: u64,
    protocol_version: u16,
    /// Pending transitions: transition_id → protocol_version.
    /// Populated by OP22 (prepare transition) and OP29/OP30 (commit/welcome).
    /// Consumed by OP23 (execute transition).
    pending_transitions: HashMap<u16, u16>,
    last_transition_id: u16,
    consecutive_failures: u32,
    reinitializing: bool,
}

/// Serialized commit+welcome ready to send as OP28 binary.
pub struct CommitResponse {
    pub data: Vec<u8>,
}

/// Recovery action: reinit produced a new key package that must be sent to Discord.
pub struct RecoveryAction {
    pub transition_id: u16,
    pub key_package: Vec<u8>,
}

impl DaveManager {
    pub fn new(protocol_version: u16, user_id: u64, channel_id: u64) -> Result<(Self, Vec<u8>)> {
        let pv =
            NonZeroU16::new(protocol_version).context("DAVE protocol version must be non-zero")?;

        let mut session = DaveSession::new(pv, user_id, channel_id, None)
            .map_err(|e| anyhow::anyhow!("DaveSession::new failed: {:?}", e))?;

        info!(
            "DAVE session created: protocol_version={} user_id={} channel_id={}",
            protocol_version, user_id, channel_id
        );

        let pkg = session
            .create_key_package()
            .map_err(|e| anyhow::anyhow!("create_key_package: {:?}", e))?;

        Ok((
            Self {
                session,
                ready: false,
                user_id,
                channel_id,
                protocol_version,
                pending_transitions: HashMap::new(),
                last_transition_id: 0,
                consecutive_failures: 0,
                reinitializing: false,
            },
            pkg,
        ))
    }

    pub fn set_external_sender(&mut self, data: &[u8]) -> Result<()> {
        self.session
            .set_external_sender(data)
            .map_err(|e| anyhow::anyhow!("set_external_sender: {:?}", e))?;
        debug!("DAVE: external sender set ({} bytes)", data.len());
        Ok(())
    }

    pub fn create_key_package(&mut self) -> Result<Vec<u8>> {
        let pkg = self
            .session
            .create_key_package()
            .map_err(|e| anyhow::anyhow!("create_key_package: {:?}", e))?;
        debug!("DAVE: key package created ({} bytes)", pkg.len());
        Ok(pkg)
    }

    pub fn process_proposals(
        &mut self,
        op_type: ProposalsOperationType,
        proposals: &[u8],
        user_ids: Option<&[u64]>,
    ) -> Result<Option<CommitResponse>> {
        let result = self
            .session
            .process_proposals(op_type, proposals, user_ids)
            .map_err(|e| anyhow::anyhow!("process_proposals: {:?}", e))?;

        debug!(
            "DAVE: proposals processed ({} bytes), has_commit={}",
            proposals.len(),
            result.is_some()
        );

        Ok(result.map(|cw| {
            let mut data = cw.commit;
            if let Some(welcome) = cw.welcome {
                data.extend_from_slice(&welcome);
            }
            CommitResponse { data }
        }))
    }

    pub fn process_welcome(&mut self, data: &[u8]) -> Result<()> {
        self.session
            .process_welcome(data)
            .map_err(|e| anyhow::anyhow!("process_welcome: {:?}", e))?;
        self.ready = self.session.is_ready();
        if self.ready {
            info!("DAVE: session ready after welcome");
        }
        Ok(())
    }

    pub fn process_commit(&mut self, data: &[u8]) -> Result<()> {
        self.session
            .process_commit(data)
            .map_err(|e| anyhow::anyhow!("process_commit: {:?}", e))?;
        self.ready = self.session.is_ready();
        if self.ready {
            info!("DAVE: session ready after commit");
        }
        Ok(())
    }

    pub fn encrypt_opus(&mut self, frame: &[u8]) -> Result<Vec<u8>> {
        if !self.ready || self.protocol_version == 0 {
            return Ok(frame.to_vec());
        }
        self.session
            .encrypt_opus(frame)
            .map(|cow| cow.into_owned())
            .map_err(|e| anyhow::anyhow!("encrypt_opus: {:?}", e))
    }

    pub fn decrypt(&mut self, sender_user_id: u64, frame: &[u8]) -> Result<Vec<u8>> {
        if !self.ready {
            return Ok(frame.to_vec());
        }
        if self.protocol_version == 0 {
            // DAVE disabled (downgrade executed). Frames should be plain Opus, but
            // peers still transitioning may send a few encrypted frames. Try decrypt
            // first; fall back to passthrough on failure.
            return match self
                .session
                .decrypt(sender_user_id, MediaType::AUDIO, frame)
            {
                Ok(decrypted) => {
                    self.consecutive_failures = 0;
                    Ok(decrypted)
                }
                Err(_) => Ok(frame.to_vec()),
            };
        }
        match self
            .session
            .decrypt(sender_user_id, MediaType::AUDIO, frame)
        {
            Ok(decrypted) => {
                self.consecutive_failures = 0;
                Ok(decrypted)
            }
            Err(e) => Err(anyhow::anyhow!("decrypt: {:?}", e)),
        }
    }

    pub fn is_ready(&self) -> bool {
        self.ready
    }

    // --- Transition management (matches discord.js DAVESession) ---

    /// Handle OP22 (prepare transition). Returns `true` if the caller should send OP32.
    pub fn prepare_transition(&mut self, transition_id: u16, protocol_version: u16) -> bool {
        info!(
            "DAVE: prepare transition id={} pv={}",
            transition_id, protocol_version
        );
        self.pending_transitions
            .insert(transition_id, protocol_version);

        if transition_id == 0 {
            // Transition 0 is (re)initialization — execute immediately
            self.execute_transition(transition_id);
            false
        } else {
            if protocol_version == 0 {
                // Downgrade pending — set passthrough mode so mixed encrypted/plain
                // frames are tolerated during the transition window.
                // Do NOT auto-execute: wait for OP23 (execute transition) from the server
                // so all participants switch simultaneously. Matches discord.js behavior.
                self.session
                    .set_passthrough_mode(true, Some(PASSTHROUGH_DOWNGRADE_EXPIRY));
            }
            true // caller should send OP32 DaveTransitionReady
        }
    }

    /// Handle OP23 (execute transition). Returns `true` if transition was executed.
    pub fn execute_transition(&mut self, transition_id: u16) -> bool {
        if let Some(new_pv) = self.pending_transitions.remove(&transition_id) {
            let old_pv = self.protocol_version;
            self.protocol_version = new_pv;

            if old_pv != new_pv && new_pv == 0 {
                info!("DAVE: session downgraded (v{} -> v0)", old_pv);
            } else if transition_id > 0 && old_pv == 0 && new_pv > 0 {
                self.session
                    .set_passthrough_mode(true, Some(PASSTHROUGH_TRANSITION_EXPIRY));
                info!("DAVE: session upgraded (v0 -> v{})", new_pv);
            }

            self.reinitializing = false;
            self.last_transition_id = transition_id;
            info!(
                "DAVE: transition executed (v{} -> v{}, id={})",
                old_pv, new_pv, transition_id
            );
            true
        } else {
            warn!(
                "DAVE: execute transition but no pending transition for id={}",
                transition_id
            );
            false
        }
    }

    /// Store a pending transition after successful commit/welcome processing.
    pub fn store_pending_transition(&mut self, transition_id: u16) {
        // Transition 0 is immediate initialization; it is not tracked in pending transitions.
        // Keeping id=0 pending blocks failure recovery and diverges from discord.js behavior.
        if transition_id == 0 {
            self.reinitializing = false;
            self.last_transition_id = 0;
            return;
        }

        self.pending_transitions
            .insert(transition_id, self.protocol_version);
    }

    /// Track a decryption failure. Returns `true` if recovery should be triggered.
    /// Failures during reinitialization or pending transitions are NOT counted
    /// (matches discord.js behavior).
    pub fn track_decrypt_failure(&mut self) -> bool {
        if self.reinitializing || !self.pending_transitions.is_empty() {
            return false;
        }
        self.consecutive_failures += 1;
        if self.consecutive_failures > FAILURE_TOLERANCE {
            warn!(
                "DAVE: {} consecutive decrypt failures exceeded tolerance ({}), recovery needed",
                self.consecutive_failures, FAILURE_TOLERANCE
            );
            true
        } else {
            false
        }
    }

    /// Reinitialize the DAVE session from scratch. Returns a `RecoveryAction`
    /// containing the transition_id to invalidate (OP31) and a new key package (OP26).
    pub fn reinit(&mut self) -> Result<RecoveryAction> {
        let transition_id = self.last_transition_id;
        info!(
            "DAVE: reinitializing session (invalidating transition {})",
            transition_id
        );

        let pv = NonZeroU16::new(self.protocol_version)
            .context("DAVE protocol version must be non-zero for reinit")?;

        let new_session = DaveSession::new(pv, self.user_id, self.channel_id, None)
            .map_err(|e| anyhow::anyhow!("DaveSession reinit: {:?}", e))?;

        self.session = new_session;
        let pkg = self
            .session
            .create_key_package()
            .map_err(|e| anyhow::anyhow!("reinit create_key_package: {:?}", e))?;

        self.ready = false;
        self.reinitializing = true;
        self.consecutive_failures = 0;
        self.pending_transitions.clear();

        info!(
            "DAVE: session reinitialized, new key package ({} bytes)",
            pkg.len()
        );

        Ok(RecoveryAction {
            transition_id,
            key_package: pkg,
        })
    }

    pub fn has_pending_transitions(&self) -> bool {
        !self.pending_transitions.is_empty()
    }

    pub fn is_reinitializing(&self) -> bool {
        self.reinitializing
    }

    pub fn can_passthrough(&self, user_id: u64) -> bool {
        self.session.can_passthrough(user_id)
    }

    pub fn set_passthrough(&mut self, enabled: bool, duration_secs: Option<u32>) {
        self.session.set_passthrough_mode(enabled, duration_secs);
        warn!("DAVE: passthrough mode set to {}", enabled);
    }

    pub fn user_id(&self) -> u64 {
        self.user_id
    }

    pub fn channel_id(&self) -> u64 {
        self.channel_id
    }

    pub fn protocol_version(&self) -> u16 {
        self.protocol_version
    }
}
