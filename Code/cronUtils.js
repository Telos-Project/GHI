/**
 * cron-manager — Linux cron/systemd job management for Node.js
 *
 * Supports two backends:
 *	 - "crontab"	: user/system crontab files + /etc/cron.d/
 *	 - "systemd"	: systemd timer units (for startup / calendar triggers)
 *
 * Trigger types understood:
 *	 { type: "schedule", cron: "*\/5 * * * *" } — standard cron schedule
 *	 { type: "startup" } — @reboot (crontab) or After=network.target (systemd)
 *	 { type: "calendar", spec: "daily" | "hourly" | … }	— systemd OnCalendar=
 *	 { type: "interval", seconds: 300 } — systemd OnBootSec + OnUnitActiveSec
 */

const { execFile, execFileSync } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");
const os = require("os");

const execFileAsync = promisify(execFile);

// ─── platform guard ──────────────────────────────────────────────────────────

if (os.platform() !== "linux") {
	throw new Error("cron-manager only supports Linux.");
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Run a command and return { stdout, stderr }.
 * Throws on non-zero exit.
 */
async function run(cmd, args = [], input = null) {
	const opts = { encoding: "utf8" };
	if (input !== null) opts.input = input; // passed as stdin when spawning via shell
	return execFileAsync(cmd, args, opts);
}

/** Escape a string for safe embedding inside a shell single-quote context. */
function shellEscape(str) {
	return "'" + String(str).replace(/'/g, "'\\''") + "'";
}

/** Validate a job id: alphanumerics, hyphens, underscores, max 64 chars. */
function validateId(id) {
	if (!/^[a-z0-9_-]{1,64}$/i.test(id)) {
		throw new Error(
			`Invalid job id "${id}". Use alphanumerics, hyphens, and underscores (max 64 chars).`
		);
	}
}

// ─── CRONTAB BACKEND ─────────────────────────────────────────────────────────

const CRONTAB_TAG_PREFIX = "# cron-manager:";

/**
 * Read the current crontab for `user` (or current user if omitted).
 * Returns raw text.
 */
async function readCrontab(user) {
	const args = user ? ["-u", user, "-l"] : ["-l"];
	try {
		const { stdout } = await run("crontab", args);
		return stdout;
	} catch (e) {
		// crontab -l exits 1 when there is no crontab
		if (/no crontab for/i.test(e.stderr || e.message)) return "";
		throw e;
	}
}

/**
 * Write `text` as the crontab for `user` (or current user).
 */
async function writeCrontab(text, user) {
	const args = user ? ["-u", user, "-"] : ["-"];
	// execFile doesn't support stdin; use a temp file approach
	const tmp = path.join(os.tmpdir(), `crontab-${process.pid}-${Date.now()}.tmp`);
	fs.writeFileSync(tmp, text, "utf8");
	try {
		await run("crontab", user ? ["-u", user, tmp] : [tmp]);
	} finally {
		fs.unlinkSync(tmp);
	}
}

/** Convert a trigger object to a crontab schedule string. */
function triggerToCrontabSchedule(trigger) {
	switch (trigger.type) {
		case "startup":
			return "@reboot";
		case "schedule":
			if (!trigger.cron) throw new Error('trigger.type="schedule" requires a cron field.');
			return trigger.cron;
		case "interval": {
			// Approximate: run every N minutes (minimum 1 min resolution in crontab)
			const mins = Math.max(1, Math.round((trigger.seconds || 60) / 60));
			return `*/${mins} * * * *`;
		}
		case "calendar":
			// Map common names; full systemd calendar specs need the systemd backend
			switch ((trigger.spec || "").toLowerCase()) {
				case "hourly":	return "0 * * * *";
				case "daily":	 return "0 0 * * *";
				case "weekly":	return "0 0 * * 0";
				case "monthly": return "0 0 1 * *";
				default:				return trigger.spec; // pass-through if it looks like a cron expr
			}
		default:
			throw new Error(`Unknown trigger type "${trigger.type}".`);
	}
}

/** Parse raw crontab text into an array of job objects. */
function parseCrontab(raw) {
	const lines = raw.split("\n");
	const jobs = [];
	let meta = {};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();

		// Collect metadata comment
		if (line.startsWith(CRONTAB_TAG_PREFIX)) {
			try {
				meta = JSON.parse(line.slice(CRONTAB_TAG_PREFIX.length));
			} catch (_) {
				meta = {};
			}
			continue;
		}

		// Skip other comments and blank lines
		if (!line || line.startsWith("#")) {
			meta = {};
			continue;
		}

		// Parse a cron entry
		const job = parseCrontabLine(line, meta);
		if (job) jobs.push(job);
		meta = {};
	}

	return jobs;
}

/** Parse one crontab entry line. */
function parseCrontabLine(line, meta = {}) {
	// Handle @-shortcuts
	const atMatch = line.match(/^(@\w+)\s+(.+)$/);
	if (atMatch) {
		const [, schedule, command] = atMatch;
		return {
			id: meta.id || null,
			schedule,
			command,
			trigger: schedule === "@reboot"
				? { type: "startup" }
				: { type: "schedule", cron: schedule },
			backend: "crontab",
			raw: line,
			meta,
		};
	}

	// Standard 5-field (or 6-field with seconds extension) cron line
	// We support environment variable lines too — skip them
	if (/^\w+=/.test(line)) return null;

	const parts = line.split(/\s+/);
	if (parts.length < 6) return null;

	const schedule = parts.slice(0, 5).join(" ");
	const command	= parts.slice(5).join(" ");

	return {
		id: meta.id || null,
		schedule,
		command,
		trigger: { type: "schedule", cron: schedule },
		backend: "crontab",
		raw: line,
		meta,
	};
}

// ─── SYSTEMD BACKEND ─────────────────────────────────────────────────────────

const SYSTEMD_USER_DIR	 = path.join(os.homedir(), ".config/systemd/user");
const SYSTEMD_SYSTEM_DIR = "/etc/systemd/system";

function systemdDir(systemWide) {
	return systemWide ? SYSTEMD_SYSTEM_DIR : SYSTEMD_USER_DIR;
}

function timerName(id) { return `cron-manager-${id}.timer`; }
function serviceName(id) { return `cron-manager-${id}.service`; }

/** Build an OnCalendar / OnBootSec spec from a trigger. */
function triggerToSystemdTimer(trigger) {
	switch (trigger.type) {
		case "startup":
			return { onBootSec: "10s", onUnitActiveSec: null, onCalendar: null, persistent: false };

		case "interval": {
			const secs = trigger.seconds || 60;
			return {
				onBootSec: `${secs}s`,
				onUnitActiveSec: `${secs}s`,
				onCalendar: null,
				persistent: true,
			};
		}

		case "calendar":
			return { onBootSec: null, onUnitActiveSec: null, onCalendar: trigger.spec || "daily", persistent: true };

		case "schedule":
			// Convert 5-field cron to systemd calendar spec (basic support)
			return { onBootSec: null, onUnitActiveSec: null, onCalendar: cronToSystemdCalendar(trigger.cron), persistent: true };

		default:
			throw new Error(`Unknown trigger type "${trigger.type}".`);
	}
}

/**
 * Very-best-effort conversion of a 5-field cron expression to a
 * systemd OnCalendar= spec.	Covers the most common patterns.
 */
function cronToSystemdCalendar(cron) {
	if (!cron) throw new Error("cron field required for schedule trigger.");
	const p = cron.trim().split(/\s+/);
	if (p.length !== 5) throw new Error(`Expected 5-field cron, got: ${cron}`);
	const [min, hour, dom, mon, dow] = p;

	const dayMap = { "0": "Sun","1": "Mon","2": "Tue","3": "Wed","4": "Thu","5": "Fri","6": "Sat","7": "Sun" };
	const monMap = { "1":"Jan","2":"Feb","3":"Mar","4":"Apr","5":"May","6":"Jun",
									 "7":"Jul","8":"Aug","9":"Sep","10":"Oct","11":"Nov","12":"Dec" };

	const toSystemd = (val, map) => {
		if (val === "*") return "*";
		if (val.startsWith("*/")) return `*/${val.slice(2)}`;
		// ranges and lists: pass-through (systemd understands them)
		return val.split(",").map(v => map[v] ?? v).join(",");
	};

	const dayPart = dow !== "*" ? toSystemd(dow, dayMap) : (dom !== "*" ? `*-*-${dom}` : null);
	const monPart = mon !== "*" ? toSystemd(mon, monMap) : null;
	const datePart = [
		monPart ? `*-${monPart}-${dom === "*" ? "*" : dom}` : null,
		dayPart && !dayPart.includes("-") ? dayPart : null,
	].filter(Boolean).join(" ");

	const timePart = `${hour === "*" ? "*" : hour}:${min === "*" ? "*" : min}:00`;

	return datePart ? `${datePart} ${timePart}` : timePart;
}

/** Generate .service unit content. */
function buildServiceUnit(id, command, description) {
	return [
		"[Unit]",
		`Description=${description || `cron-manager job: ${id}`}`,
		`X-CronManager-Id=${id}`,
		"",
		"[Service]",
		"Type=oneshot",
		`ExecStart=/bin/sh -c ${shellEscape(command)}`,
		"",
		"[Install]",
		"WantedBy=multi-user.target",
	].join("\n") + "\n";
}

/** Generate .timer unit content. */
function buildTimerUnit(id, trigger, description) {
	const t = triggerToSystemdTimer(trigger);
	const lines = [
		"[Unit]",
		`Description=Timer for cron-manager job: ${id}`,
		`X-CronManager-Id=${id}`,
		"",
		"[Timer]",
	];

	if (t.onCalendar)			lines.push(`OnCalendar=${t.onCalendar}`);
	if (t.onBootSec)			 lines.push(`OnBootSec=${t.onBootSec}`);
	if (t.onUnitActiveSec) lines.push(`OnUnitActiveSec=${t.onUnitActiveSec}`);
	if (t.persistent)			lines.push("Persistent=true");
	lines.push(`Unit=${serviceName(id)}`);
	lines.push("", "[Install]", "WantedBy=timers.target");

	return lines.join("\n") + "\n";
}

/** List all cron-manager systemd units. */
async function listSystemdJobs(systemWide = false) {
	const dir = systemdDir(systemWide);
	let files;
	try {
		files = fs.readdirSync(dir);
	} catch (_) {
		return [];
	}

	const timerFiles = files.filter(f => f.startsWith("cron-manager-") && f.endsWith(".timer"));

	return timerFiles.map(tf => {
		const id = tf.slice("cron-manager-".length, -".timer".length);
		const timerPath	 = path.join(dir, tf);
		const servicePath = path.join(dir, serviceName(id));

		const timerContent	 = safeRead(timerPath);
		const serviceContent = safeRead(servicePath);

		const trigger = parseSystemdTimerTrigger(timerContent);
		const command = parseSystemdCommand(serviceContent);

		return { id, trigger, command, backend: "systemd", systemWide, timerPath, servicePath };
	});
}

function safeRead(p) {
	try { return fs.readFileSync(p, "utf8"); } catch (_) { return ""; }
}

function parseSystemdTimerTrigger(content) {
	const cal = extractIni(content, "OnCalendar");
	if (cal) return { type: "calendar", spec: cal };

	const boot = extractIni(content, "OnBootSec");
	const active = extractIni(content, "OnUnitActiveSec");
	if (boot && active) {
		const secs = parseDuration(active);
		return { type: "interval", seconds: secs };
	}
	if (boot) return { type: "startup" };

	return { type: "unknown" };
}

function parseSystemdCommand(content) {
	const exec = extractIni(content, "ExecStart");
	if (!exec) return null;
	// Strip the /bin/sh -c '...' wrapper if present
	const m = exec.match(/^\/bin\/sh\s+-c\s+'(.+)'$/s);
	return m ? m[1].replace(/'\\''/g, "'") : exec;
}

function extractIni(text, key) {
	const m = text.match(new RegExp(`^${key}=(.+)$`, "m"));
	return m ? m[1].trim() : null;
}

function parseDuration(str) {
	const m = str.match(/^(\d+)(s|min|h|d)?$/i);
	if (!m) return NaN;
	const n = parseInt(m[1], 10);
	switch ((m[2] || "s").toLowerCase()) {
		case "min": return n * 60;
		case "h":	 return n * 3600;
		case "d":	 return n * 86400;
		default:		return n;
	}
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * List all cron jobs known to cron-manager, grouped by trigger type.
 *
 * @param {object} [opts]
 * @param {string}	[opts.user]				- crontab user (defaults to current)
 * @param {boolean} [opts.systemWide]	- also read /etc/systemd/system timers
 * @param {"crontab"|"systemd"|"all"} [opts.backend="all"]
 *
 * @returns {Promise<{ byTrigger: object, all: Array }>}
 */
async function listJobs(opts = {}) {
	const { user, systemWide = false, backend = "all" } = opts;
	let jobs = [];

	if (backend === "all" || backend === "crontab") {
		const raw = await readCrontab(user);
		jobs.push(...parseCrontab(raw));
	}

	if (backend === "all" || backend === "systemd") {
		const sJobs = await listSystemdJobs(systemWide);
		jobs.push(...sJobs);
	}

	// Group by trigger type
	const byTrigger = {};
	for (const job of jobs) {
		const key = job.trigger?.type || "unknown";
		(byTrigger[key] = byTrigger[key] || []).push(job);
	}

	return { byTrigger, all: jobs };
}

/**
 * Create a new cron job.
 *
 * @param {object} opts
 * @param {string}	opts.id					- Unique identifier for this job
 * @param {string}	opts.command		 - Shell command to execute
 * @param {object}	opts.trigger		 - Trigger descriptor (see top of file)
 * @param {string}	[opts.user]			- crontab user (crontab backend only)
 * @param {boolean} [opts.systemWide]- Write to /etc/systemd/system (needs root)
 * @param {"crontab"|"systemd"} [opts.backend="crontab"]
 * @param {string}	[opts.description]
 *
 * @returns {Promise<void>}
 */
async function createJob(opts = {}) {
	const {
		id,
		command,
		trigger,
		user,
		systemWide = false,
		backend = "crontab",
		description,
	} = opts;

	if (!id)			throw new Error("opts.id is required.");
	if (!command) throw new Error("opts.command is required.");
	if (!trigger) throw new Error("opts.trigger is required.");

	validateId(id);

	if (backend === "systemd") {
		await createSystemdJob({ id, command, trigger, systemWide, description });
	} else {
		await createCrontabJob({ id, command, trigger, user });
	}
}

async function createCrontabJob({ id, command, trigger, user }) {
	const raw = await readCrontab(user);
	const jobs = parseCrontab(raw);

	// Prevent duplicates
	if (jobs.some(j => j.meta?.id === id)) {
		throw new Error(`A crontab job with id "${id}" already exists.`);
	}

	const schedule = triggerToCrontabSchedule(trigger);
	const tag			= CRONTAB_TAG_PREFIX + JSON.stringify({ id, trigger });
	const newEntry = `${tag}\n${schedule} ${command}`;

	const updated = raw.trimEnd() + (raw.trim() ? "\n\n" : "") + newEntry + "\n";
	await writeCrontab(updated, user);
}

async function createSystemdJob({ id, command, trigger, systemWide, description }) {
	const dir = systemdDir(systemWide);
	fs.mkdirSync(dir, { recursive: true });

	const svcPath	 = path.join(dir, serviceName(id));
	const timerPath = path.join(dir, timerName(id));

	if (fs.existsSync(timerPath)) {
		throw new Error(`A systemd job with id "${id}" already exists.`);
	}

	fs.writeFileSync(svcPath,	 buildServiceUnit(id, command, description), "utf8");
	fs.writeFileSync(timerPath, buildTimerUnit(id, trigger, description),	 "utf8");

	const ctlArgs = systemWide ? ["systemctl"] : ["systemctl", "--user"];
	const base		= systemWide ? ["systemctl"] : ["systemctl", "--user"];

	await run(base[0], [...base.slice(1), "daemon-reload"]);
	await run(base[0], [...base.slice(1), "enable", "--now", timerName(id)]);
}

/**
 * Remove a cron job by id.
 *
 * @param {object} opts
 * @param {string}	opts.id
 * @param {string}	[opts.user]
 * @param {boolean} [opts.systemWide]
 * @param {"crontab"|"systemd"|"all"} [opts.backend="all"]
 *
 * @returns {Promise<{ removed: boolean, backend: string }>}
 */
async function removeJob(opts = {}) {
	const { id, user, systemWide = false, backend = "all" } = opts;
	if (!id) throw new Error("opts.id is required.");
	validateId(id);

	let removed = false;

	if (backend === "all" || backend === "crontab") {
		removed = (await removeCrontabJob({ id, user })) || removed;
	}

	if (backend === "all" || backend === "systemd") {
		removed = (await removeSystemdJob({ id, systemWide })) || removed;
	}

	return { removed, id };
}

async function removeCrontabJob({ id, user }) {
	const raw	= await readCrontab(user);
	const lines = raw.split("\n");
	const out	 = [];
	let skip = false;
	let found = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith(CRONTAB_TAG_PREFIX)) {
			try {
				const meta = JSON.parse(line.slice(CRONTAB_TAG_PREFIX.length));
				if (meta.id === id) {
					skip	= true;
					found = true;
					continue;
				}
			} catch (_) {}
		}
		if (skip) { skip = false; continue; } // skip the entry line after the tag
		out.push(line);
	}

	if (found) {
		await writeCrontab(out.join("\n"), user);
	}
	return found;
}

async function removeSystemdJob({ id, systemWide }) {
	const dir			 = systemdDir(systemWide);
	const svcPath	 = path.join(dir, serviceName(id));
	const timerPath = path.join(dir, timerName(id));

	if (!fs.existsSync(timerPath)) return false;

	const base = systemWide ? ["systemctl"] : ["systemctl", "--user"];
	try {
		await run(base[0], [...base.slice(1), "disable", "--now", timerName(id)]);
	} catch (_) { /* ignore if already inactive */ }

	if (fs.existsSync(timerPath)) fs.unlinkSync(timerPath);
	if (fs.existsSync(svcPath))	 fs.unlinkSync(svcPath);

	await run(base[0], [...base.slice(1), "daemon-reload"]);
	return true;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
	listJobs,
	createJob,
	removeJob,

	// Low-level helpers (useful for testing / introspection)
	readCrontab,
	writeCrontab,
	parseCrontab,
	listSystemdJobs,
	triggerToCrontabSchedule,
	triggerToSystemdTimer,
	cronToSystemdCalendar,
};