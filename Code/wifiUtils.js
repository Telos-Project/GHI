const { execSync } = require("child_process");
const os = require("os");

function connect(device, ssid, password = null) {
	const platform = os.platform();
	if (platform === "linux") return connectLinux(device, ssid, password);
	throw new Error(`Unsupported platform: ${platform}`);
}

function connectLinux(device, ssid, password = null) {
	try {
		execSync(`ip link set ${device} up`, { stdio: 'inherit' });

		// Force a fresh scan and wait for results
		execSync(
			`nmcli dev wifi rescan`,
			{ stdio: 'pipe' }
		);

		execSync('sleep 3');

		try {
			execSync(`nmcli connection delete "${ssid}"`, { stdio: 'pipe' });
		} catch (_) {}

		const cmd = password
			? `nmcli device wifi connect "${
				ssid
			}" password "${
				password
			}" ifname ${
				device
			}`
			: `nmcli device wifi connect "${ssid}" ifname ${device}`;

		execSync(cmd, { stdio: 'inherit' });
		console.log(`Successfully connected ${device} to "${ssid}"`);
	} catch (err) {
		console.error(
			`Failed to connect ${device} to "${ssid}": ${err.message}`
		);
		throw err;
	}
}

function getConnections() {
	const platform = os.platform();
	if (platform === "linux") return getConnectionsLinux();
	if (platform === "darwin") return getConnectionsMac();
	if (platform === "win32") return getConnectionsWindows();
	throw new Error(`Unsupported platform: ${platform}`);
}

function getConnectionsLinux() {
	const out = run("nmcli -t -f ACTIVE,SSID,DEVICE dev wifi");
	if (out) {
		const result = {};
		for (const line of out.split("\n").filter(Boolean)) {
			const match = line.match(/^yes:(.+):(\w+)$/);
			if (match) {
				const [, ssid, device] = match;
				result[device] = ssid.replace(/\\:/g, ":");
			}
		}
		if (Object.keys(result).length) return result;
	}

	// iw fallback
	const devOut = run("iw dev");
	if (devOut) {
		const result = {};
		const ifaces = [
			...devOut.matchAll(/Interface\s+(\S+)/g)
		].map(m => m[1]);
		for (const iface of ifaces) {
			const link = run(`iw dev ${iface} link`);
			if (link && !link.includes("Not connected")) {
				const ssid = link.match(/SSID:\s*(.+)/)?.[1]?.trim();
				if (ssid) result[iface] = ssid;
			}
		}
		if (Object.keys(result).length) return result;
	}

	return {};
}

function getConnectionsMac() {
	const hwOut = run("networksetup -listallhardwareports");
	if (!hwOut) return {};

	const result = {};
	const blocks = hwOut.split(/(?=Hardware Port:)/);

	for (const block of blocks) {
		if (!/wi-fi|airport/i.test(block)) continue;
		const iface = block.match(/Device:\s*(\S+)/)?.[1];
		if (!iface) continue;

		const ssid = run(`ipconfig getsummary ${iface} 2>/dev/null`)
				?.match(/SSID\s*:\s*(.+)/)?.[1]?.trim()
			?? run(
				`/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -I 2>/dev/null`
			)
				?.match(/\s+SSID:\s*(.+)/)?.[1]?.trim();

		if (ssid) result[iface] = ssid;
	}
	return result;
}

function getConnectionsWindows() {
	const out = run("netsh wlan show interfaces");
	if (!out) return {};

	const result = {};
	for (const block of out.split(/(?=\s+Name\s+:)/)) {
		const iface = block.match(/Name\s*:\s*(.+)/)?.[1]?.trim();
		const ssid	= block.match(/(?<!B)SSID\s*:\s*(.+)/)?.[1]?.trim();
		if (iface && ssid) result[iface] = ssid;
	}
	return result;
}

function getDevices() {
	const platform = os.platform();
	if (platform === "linux") return getDevicesLinux();
	throw new Error(`Unsupported platform: ${platform}`);
}

function getDevicesLinux() {

	try {
		const output = execSync('iw dev', { encoding: 'utf8' });
		const devices = [];
		for (const line of output.split('\n')) {
			const match = line.match(/^\s+Interface\s+(\S+)/);
			if (match) devices.push(match[1]);
		}
		return devices.sort();
	} catch {
		return [];
	}
}

function run(cmd) {
	try {
		return execSync(
			cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
		);
	} catch {
		return null;
	}
}

module.exports = {
	connect,
	getConnections,
	getDevices
};