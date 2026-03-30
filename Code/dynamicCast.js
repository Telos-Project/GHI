#!/usr/bin/env node

let { execSync, spawnSync, spawn } = require("child_process");
let fs = require("fs");
let fusionLISP = require("fusion-lisp/fusionLISP.js");

let CLOUDFLARED_PATH = "/usr/local/bin/cloudflared";

function isExecutable(filePath) {

	try {

		fs.accessSync(filePath, fs.constants.X_OK);

		return true;
	}
	
	catch(error) {
		return false;
	}
}

function commandExists(cmd) {

	let result = spawnSync("command", ["-v", cmd], { shell: true });

	return result.status === 0;
}

function getArch() {

	let arch = spawnSync("uname", ["-m"]).stdout.toString().trim();

	let archMap = {
		x86_64: "amd64",
		aarch64: "arm64",
		armv7l: "arm",
	};

	let pkgArch = archMap[arch];

	if(!pkgArch) {

		console.log(`[!] Unsupported architecture: ${arch}`);

		process.exit(1);
	}

	return pkgArch;
}

function downloadFile(url, dest) {

	return new Promise((resolve, reject) => {

		let follow = (resolvedUrl) => {

			let protocol = resolvedUrl.startsWith("https") ?
				require("https") : require("http");

			protocol.get(resolvedUrl, (res) => {
				
				if(res.statusCode >= 300 &&
					res.statusCode < 400 &&
					res.headers.location) {

					return follow(res.headers.location);
				}

				if(res.statusCode !== 200) {

					return reject(
						new Error(
							`Download failed with status ${res.statusCode}`
						)
					);
				}

				let file = fs.createWriteStream(dest);

				res.pipe(file);

				file.on("finish", () => file.close(resolve));
				file.on("error", reject);
			}).on("error", reject);
		};

		follow(url);
	});
}

async function installCloudflared() {

	console.log("[*] Checking for cloudflared...");

	if(isExecutable(CLOUDFLARED_PATH)) {

		console.log(
			`[✓] cloudflared already installed at ${CLOUDFLARED_PATH}`
		);

		return;
	}

	if(commandExists("cloudflared")) {

		console.log("[✓] cloudflared found in PATH");

		return;
	}

	console.log("[*] Installing cloudflared...");

	let pkgArch = getArch();
	let url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${pkgArch}`;
	let tmpFile = "/tmp/cloudflared";

	await downloadFile(url, tmpFile);

	fs.chmodSync(tmpFile, 0o755);

	execSync(`sudo mv ${tmpFile} ${CLOUDFLARED_PATH}`);

	console.log(`[✓] Installed cloudflared to ${CLOUDFLARED_PATH}`);

	return spawnSync(CLOUDFLARED_PATH, ["--version"], { stdio: "inherit" });
}

async function cast(port, target, tags) {

	try {

		await installCloudflared();

		let tunnel = null;
		let id = require("fs").readFileSync('/etc/machine-id', 'utf8').trim();

		let cf = spawn("/usr/local/bin/cloudflared", [
			"tunnel",
			"--url",
			`http://localhost:${port}`
		]);

		cf.stdout.on("data", data => {

			let url = (
				data.toString().match(/https?:\/\/[^\s/$.?#].[^\s]*/gi) || []
			).filter(url => url.endsWith(".trycloudflare.com"))[0];

			tunnel = url != null ? url : tunnel;
		});

		cf.stderr.on("data", data => {

			let url = (
				data.toString().match(/https?:\/\/[^\s/$.?#].[^\s]*/gi) || []
			).filter(url => url.endsWith(".trycloudflare.com"))[0];

			tunnel = url != null ? url : tunnel;
		});

		setInterval(() => {

			if(tunnel != null) {

				console.log(`CASTING FROM ${id} TO ${tunnel}`);

				fusionLISP.run(`
					(use "fusion-lisp" "telos-oql")
					(query
						(append
							${target}
							(list
								(: "content" "${tunnel}")
								(: "properties"
									(list
										(: "tags"
											(list
												"orca"
												${tags.map(
													item =>
														JSON.stringify(item)
												).join(" ")}
											)
										)
										(: "metadata"
											(list
												(: "author" "${id}")
												(: "time" ${
													(new Date).getTime()
												})
											)
										)
									)
								)
							)
						)
					)
				`);
			}
		}, 60 * 1000);
	}

	catch(error) {
		console.error("Error:", error);
	}
}

module.exports = {
	cast,
	installCloudflared
};

if(require.main === module) {

	cast(
		process.argv[2],
		process.argv[3],
		process.argv.slice(4)
	);
}