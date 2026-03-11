import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../../api";
import Skeleton from "../Skeleton";
import { renderMarkdown } from "../../renderMarkdown";
import { PanelHead } from "../ui";
import { useDashboardGuildScope } from "../../guildScope";

interface Props {
  markdown: string | null | undefined;
  onRefresh: () => void | Promise<void>;
}

type StatusState = {
  text: string;
  tone: "error" | "info";
} | null;

type PurgeGuildMemoryResponse = {
  ok: boolean;
  guildId: string;
  guildName: string;
  deleted: {
    durableFacts: number;
    durableFactVectors: number;
    conversationMessages: number;
    conversationVectors: number;
    reflectionEvents: number;
    journalEntries: number;
    journalFilesTouched: number;
  };
  summaryRefreshed: boolean;
};

function formatApiError(error: unknown) {
  if (error instanceof ApiError && typeof error.body === "object" && error.body !== null) {
    const body = error.body as {
      error?: unknown;
      expectedGuildName?: unknown;
    };
    const normalizedError = String(body.error || "").trim();
    if (normalizedError === "guild_name_confirmation_mismatch") {
      const expectedGuildName = String(body.expectedGuildName || "").trim();
      return expectedGuildName
        ? `Type the exact guild name: ${expectedGuildName}`
        : "Guild name confirmation did not match.";
    }
    if (normalizedError) {
      return normalizedError.replace(/_/g, " ");
    }
  }

  return error instanceof Error ? error.message : String(error);
}

export default function MemorySnapshot({ markdown, onRefresh }: Props) {
  const { selectedGuild } = useDashboardGuildScope();
  const [status, setStatus] = useState<StatusState>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmGuildName, setConfirmGuildName] = useState("");
  const [modalError, setModalError] = useState("");
  const [purging, setPurging] = useState(false);
  const rendered = useMemo(
    () => (markdown ? renderMarkdown(markdown) : ""),
    [markdown]
  );
  const selectedGuildName = String(selectedGuild?.name || "").trim();
  const confirmationMatches = selectedGuildName.length > 0 && confirmGuildName.trim() === selectedGuildName;

  useEffect(() => {
    setShowConfirmModal(false);
    setConfirmGuildName("");
    setModalError("");
    setStatus(null);
    setPurging(false);
  }, [selectedGuild?.id]);

  useEffect(() => {
    if (!showConfirmModal) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !purging) {
        setShowConfirmModal(false);
        setConfirmGuildName("");
        setModalError("");
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [purging, showConfirmModal]);

  const closeConfirmModal = () => {
    if (purging) return;
    setShowConfirmModal(false);
    setConfirmGuildName("");
    setModalError("");
  };

  const handlePurgeGuildMemory = async () => {
    if (!selectedGuild) return;
    if (!confirmationMatches) {
      setModalError(`Type the exact guild name: ${selectedGuild.name}`);
      return;
    }

    setPurging(true);
    setModalError("");
    setStatus(null);
    try {
      const result = await api<PurgeGuildMemoryResponse>("/api/memory/guild", {
        method: "DELETE",
        body: {
          guildId: selectedGuild.id,
          confirmGuildName: confirmGuildName.trim()
        }
      });

      await onRefresh();
      setStatus({
        tone: "info",
        text:
          `Purged ${result.guildName} memory: ` +
          `${result.deleted.durableFacts} durable facts, ` +
          `${result.deleted.conversationMessages} conversation messages, ` +
          `${result.deleted.journalEntries} journal entries, ` +
          `${result.deleted.reflectionEvents} reflection events.`
      });
      setShowConfirmModal(false);
      setConfirmGuildName("");
    } catch (error: unknown) {
      setModalError(formatApiError(error));
    } finally {
      setPurging(false);
    }
  };

  return (
    <div>
      <PanelHead title={selectedGuild?.name ? `${selectedGuild.name} Summary` : "Operator Summary"}>
        <button type="button" className="sm" onClick={onRefresh}>
          Refresh summary
        </button>
      </PanelHead>
      {markdown === undefined || markdown === null ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Skeleton height="0.9em" width="80%" />
          <Skeleton height="0.9em" width="60%" />
          <Skeleton height="0.9em" width="90%" />
          <Skeleton height="0.9em" width="45%" />
        </div>
      ) : rendered ? (
        <div
          className="memory-box md-rendered"
          dangerouslySetInnerHTML={{ __html: rendered }}
        />
      ) : (
        <pre className="memory-box">No memory data</pre>
      )}

      <div className="memory-danger-zone">
        <div className="memory-danger-zone-copy">
          <h4>Danger Zone</h4>
          <p>
            Permanently clears the selected guild&apos;s durable facts, conversation history, reflection runs, and
            journal entries. New conversations can create fresh memory again after this reset.
          </p>
        </div>
        {status ? (
          <p className={`memory-reflection-inline-status${status.tone === "error" ? " error" : ""}`} role="status">
            {status.text}
          </p>
        ) : null}
        <button
          type="button"
          className="sm memory-reflection-delete-btn"
          onClick={() => {
            setStatus(null);
            setConfirmGuildName("");
            setModalError("");
            setShowConfirmModal(true);
          }}
          disabled={!selectedGuild}
        >
          Nuke guild memory
        </button>
      </div>

      {showConfirmModal && selectedGuild ? (
        <div className="memory-danger-modal-backdrop" role="presentation" onClick={closeConfirmModal}>
          <div
            className="memory-danger-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="memory-danger-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h4 id="memory-danger-modal-title">Nuke {selectedGuild.name} memory?</h4>
            <p>
              This deletes every saved memory artifact scoped to <strong>{selectedGuild.name}</strong>.
            </p>
            <ul className="memory-danger-modal-list">
              <li>Durable facts and fact embeddings</li>
              <li>Conversation history and message embeddings</li>
              <li>Daily journal entries for this guild</li>
              <li>Stored reflection run history</li>
            </ul>
            <label className="memory-danger-modal-label">
              Type the guild name exactly to confirm
              <input
                type="text"
                value={confirmGuildName}
                onChange={(event) => setConfirmGuildName(event.target.value)}
                placeholder={`Type ${selectedGuild.name} here`}
                autoFocus
                disabled={purging}
              />
            </label>
            {modalError ? (
              <p className="memory-reflection-inline-status error" role="status">
                {modalError}
              </p>
            ) : null}
            <div className="memory-danger-modal-actions">
              <button type="button" onClick={closeConfirmModal} disabled={purging}>
                Cancel
              </button>
              <button
                type="button"
                className="memory-reflection-delete-btn"
                onClick={() => void handlePurgeGuildMemory()}
                disabled={!confirmationMatches || purging}
              >
                {purging ? "Purging..." : "Permanently nuke memory"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
