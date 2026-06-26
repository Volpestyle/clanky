---
cron: "0 13 * * *"
---

Daily swarm heartbeat. Check the herdr session: list the active agents and their
reported status using `herdr_status`. If any worker is blocked or appears idle,
use `herdr_read` to inspect transcript-backed output and note what it needs.
Summarize the state of the swarm in one short paragraph. If nothing is running,
say so and stop -- do not spawn work just to have something to report.
