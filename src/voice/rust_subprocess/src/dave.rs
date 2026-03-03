use std::num::NonZeroU16;

use anyhow::{Context, Result};
use davey::{DaveSession, MediaType, ProposalsOperationType};
use tracing::{debug, info, warn};

pub struct DaveManager {
    session: DaveSession,
    ready: bool,
    user_id: u64,
    channel_id: u64,
}

/// Serialized commit+welcome ready to send as OP28 binary.
pub struct CommitResponse {
    pub data: Vec<u8>,
}

impl DaveManager {
    pub fn new(protocol_version: u16, user_id: u64, channel_id: u64) -> Result<Self> {
        let pv = NonZeroU16::new(protocol_version)
            .context("DAVE protocol version must be non-zero")?;

        let session = DaveSession::new(pv, user_id, channel_id, None)
            .map_err(|e| anyhow::anyhow!("DaveSession::new failed: {:?}", e))?;

        info!(
            "DAVE session created: protocol_version={} user_id={} channel_id={}",
            protocol_version, user_id, channel_id
        );

        Ok(Self {
            session,
            ready: false,
            user_id,
            channel_id,
        })
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
        if !self.ready {
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
        self.session
            .decrypt(sender_user_id, MediaType::AUDIO, frame)
            .map_err(|e| anyhow::anyhow!("decrypt: {:?}", e))
    }

    pub fn is_ready(&self) -> bool {
        self.ready
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
}
