import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveClankyPaths, SessionRegistry } from "@clanky/core";
import { SwarmLeader } from "@clanky/swarm";

const homeDir = await mkdtemp(join(tmpdir(), "clanky-profile-isolation-"));
const work = new SessionRegistry({ homeDir, profile: "work" });
const personal = new SessionRegistry({ homeDir, profile: "personal" });
const previousClankyHome = process.env.CLANKY_HOME;
const previousClankyProfile = process.env.CLANKY_PROFILE;

try {
	await work.start();
	await personal.start();
	await work.linkLinearIssue({ issueId: "WORK-1", taskId: "task-work" });
	await personal.linkLinearIssue({ issueId: "PERS-1", taskId: "task-personal" });
	await work.recordSkillUsage({ name: "daily-digest", source: "profile-isolation-smoke", sessionId: "work-session" });
	await personal.recordSkillUsage({
		name: "linear-bridge",
		source: "profile-isolation-smoke",
		sessionId: "personal-session",
	});
	const workTask = await work.createTask({
		title: "Work profile task",
		linearIssue: "WORK-1",
		source: "profile-isolation-smoke",
	});
	const personalTask = await personal.createTask({
		title: "Personal profile task",
		linearIssue: "PERS-1",
		source: "profile-isolation-smoke",
	});

	const workLinks = await work.listLinearLinks();
	const personalLinks = await personal.listLinearLinks();
	const workTasks = await work.listTasks({ linearIssue: "WORK-1" });
	const personalTasks = await personal.listTasks({ linearIssue: "PERS-1" });
	const workSkillUsage = await work.listSkillUsage();
	const personalSkillUsage = await personal.listSkillUsage();
	assert(workLinks.length === 1 && workLinks[0]?.issueId === "WORK-1", "work profile leaked or missed links");
	assert(
		personalLinks.length === 1 && personalLinks[0]?.issueId === "PERS-1",
		"personal profile leaked or missed links",
	);
	assert(workTasks.length === 1 && workTasks[0]?.id === workTask.id, "work profile leaked or missed tasks");
	assert(
		personalTasks.length === 1 && personalTasks[0]?.id === personalTask.id,
		"personal profile leaked or missed tasks",
	);
	assert(
		workSkillUsage.length === 1 && workSkillUsage[0]?.name === "daily-digest",
		"work profile leaked or missed skill usage",
	);
	assert(
		personalSkillUsage.length === 1 && personalSkillUsage[0]?.name === "linear-bridge",
		"personal profile leaked or missed skill usage",
	);
	assert((await work.listTasks({ linearIssue: "PERS-1" })).length === 0, "personal task leaked into work profile");
	assert((await personal.listTasks({ linearIssue: "WORK-1" })).length === 0, "work task leaked into personal profile");

	assertDifferent(work.paths.profileDir, personal.paths.profileDir, "profile dirs");
	assertDifferent(work.paths.sessionsDir, personal.paths.sessionsDir, "session dirs");
	assertDifferent(work.paths.cronJobsFile, personal.paths.cronJobsFile, "cron job files");
	assertDifferent(work.paths.cronOutputsDir, personal.paths.cronOutputsDir, "cron output dirs");
	assertDifferent(work.paths.skillUsageFile, personal.paths.skillUsageFile, "skill usage files");
	assertDifferent(work.paths.linearLinksFile, personal.paths.linearLinksFile, "Linear link files");
	assertDifferent(work.paths.indexDbFile, personal.paths.indexDbFile, "index DB files");
	assertDifferent(work.paths.socketFile, personal.paths.socketFile, "socket files");
	assertDifferent(work.paths.daemonLockFile, personal.paths.daemonLockFile, "daemon lock files");
	assertPath(work.paths.profileDir, join(homeDir, "profiles", "work"), "work profile dir");
	assertPath(work.paths.activeProfileFile, join(homeDir, ".profile"), "active profile file");
	assertPath(work.paths.sessionsDir, join(homeDir, "profiles", "work", "sessions"), "work sessions dir");
	assertPath(work.paths.skillsDir, join(homeDir, "skills"), "global skills dir");
	assertPath(work.paths.profileSkillsDir, join(homeDir, "profiles", "work", "skills"), "work profile skills dir");
	assertPath(work.paths.indexDbFile, join(homeDir, "profiles", "work", "index.db"), "work index DB");
	assertPath(work.paths.linearDir, join(homeDir, "profiles", "work", "linear"), "work Linear dir");
	assertPath(
		work.paths.linearLinksFile,
		join(homeDir, "profiles", "work", "linear", "links.json"),
		"work Linear links",
	);
	assertPath(
		work.paths.linearOutboxFile,
		join(homeDir, "profiles", "work", "linear", "outbox.json"),
		"work Linear outbox",
	);
	assertPath(work.paths.cronDir, join(homeDir, "profiles", "work", "cron"), "work cron dir");
	assertPath(work.paths.cronJobsFile, join(homeDir, "profiles", "work", "cron", "jobs.json"), "work cron jobs");
	assertPath(work.paths.cronOutputsDir, join(homeDir, "profiles", "work", "cron", ".outputs"), "work cron outputs");
	assertPath(work.paths.cronTickLockFile, join(homeDir, "profiles", "work", "cron", ".tick.lock"), "work cron lock");
	assertPath(work.paths.skillUsageFile, join(homeDir, "profiles", "work", "skills", ".usage.json"), "work skill usage");
	assertPath(work.paths.httpTokenFile, join(homeDir, ".token"), "HTTP token file");
	assertPath(work.paths.authFile, join(homeDir, "profiles", "work", "auth.json"), "work auth file");
	assertPath(work.paths.modelsFile, join(homeDir, "profiles", "work", "models.json"), "work models file");
	assertPath(work.paths.socketFile, join(homeDir, "profiles", "work", ".sock"), "work socket");
	assertPath(work.paths.daemonLockFile, join(homeDir, "profiles", "work", ".daemon.lock"), "work daemon lock");
	assertPath(personal.paths.profileDir, join(homeDir, "profiles", "personal"), "personal profile dir");
	assertPath(personal.paths.sessionsDir, join(homeDir, "profiles", "personal", "sessions"), "personal sessions dir");
	assertPath(
		personal.paths.profileSkillsDir,
		join(homeDir, "profiles", "personal", "skills"),
		"personal profile skills dir",
	);
	assertPath(personal.paths.indexDbFile, join(homeDir, "profiles", "personal", "index.db"), "personal index DB");
	assertPath(personal.paths.linearDir, join(homeDir, "profiles", "personal", "linear"), "personal Linear dir");
	assertPath(
		personal.paths.linearLinksFile,
		join(homeDir, "profiles", "personal", "linear", "links.json"),
		"personal Linear links",
	);
	assertPath(
		personal.paths.linearOutboxFile,
		join(homeDir, "profiles", "personal", "linear", "outbox.json"),
		"personal Linear outbox",
	);
	assertPath(personal.paths.cronDir, join(homeDir, "profiles", "personal", "cron"), "personal cron dir");
	assertPath(
		personal.paths.cronJobsFile,
		join(homeDir, "profiles", "personal", "cron", "jobs.json"),
		"personal cron jobs",
	);
	assertPath(
		personal.paths.cronOutputsDir,
		join(homeDir, "profiles", "personal", "cron", ".outputs"),
		"personal cron outputs",
	);
	assertPath(
		personal.paths.cronTickLockFile,
		join(homeDir, "profiles", "personal", "cron", ".tick.lock"),
		"personal cron lock",
	);
	assertPath(
		personal.paths.skillUsageFile,
		join(homeDir, "profiles", "personal", "skills", ".usage.json"),
		"personal skill usage",
	);
	assertPath(personal.paths.authFile, join(homeDir, "profiles", "personal", "auth.json"), "personal auth file");
	assertPath(personal.paths.modelsFile, join(homeDir, "profiles", "personal", "models.json"), "personal models file");
	assertPath(personal.paths.socketFile, join(homeDir, "profiles", "personal", ".sock"), "personal socket");
	assertPath(
		personal.paths.daemonLockFile,
		join(homeDir, "profiles", "personal", ".daemon.lock"),
		"personal daemon lock",
	);

	const workSwarm = new SwarmLeader({
		profile: work.paths.profile,
		profileDir: work.paths.profileDir,
		env: {},
	});
	const personalSwarm = new SwarmLeader({
		profile: personal.paths.profile,
		profileDir: personal.paths.profileDir,
		env: {},
	});
	assertDifferent(workSwarm.status().databasePath, personalSwarm.status().databasePath, "swarm database paths");
	assert(workSwarm.status().identity === "work", "work swarm identity did not default to the profile name");
	assert(personalSwarm.status().identity === "personal", "personal swarm identity did not default to the profile name");
	assertPath(workSwarm.status().databasePath, join(work.paths.profileDir, "swarm", "swarm.db"), "work swarm DB");
	assertPath(
		personalSwarm.status().databasePath,
		join(personal.paths.profileDir, "swarm", "swarm.db"),
		"personal swarm DB",
	);

	process.env.CLANKY_HOME = homeDir;
	process.env.CLANKY_PROFILE = "env-profile";
	const envPaths = resolveClankyPaths();
	assert(envPaths.homeDir === homeDir, "CLANKY_HOME did not select the profile home");
	assert(envPaths.profile === "env-profile", "CLANKY_PROFILE did not select the active profile");
	assert(envPaths.profileDir === join(homeDir, "profiles", "env-profile"), "env profile dir was not isolated");
	assertDifferent(envPaths.socketFile, work.paths.socketFile, "env profile socket files");

	console.log(
		JSON.stringify({
			homeDir,
			workProfile: work.paths.profileDir,
			personalProfile: personal.paths.profileDir,
		}),
	);
} finally {
	restoreEnv("CLANKY_HOME", previousClankyHome);
	restoreEnv("CLANKY_PROFILE", previousClankyProfile);
	await work.dispose();
	await personal.dispose();
	await rm(homeDir, { force: true, recursive: true });
}

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

function assertDifferent(left: string, right: string, label: string): void {
	if (left === right) throw new Error(`Expected separate ${label}`);
}

function assertPath(actual: string, expected: string, label: string): void {
	if (actual !== expected) throw new Error(`Unexpected ${label}: ${actual}`);
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}
