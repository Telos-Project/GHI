var apint = require("apint");
var autoCORS = require("telos-autocors");
var bluetoothUtils = require("./bluetoothUtils.js");
var busNet = require("bus-net");
var cronUtils = require("./cronUtils.js");
var deviceUtils = require("./deviceUtils.js");
var dynamicCast = require("./dynamicCast.js");
var fs = require("fs");
var gpioUtils = require("./gpioUtils.js");
var path = require("path");
var serverUtils = require("telos-server/serverUtils.js");
var telosUtils = require("telos-origin/telosUtils.js");

var modules = [];
var state = { utilities: { } };

var persistPath = "~/.local/share/ghi/ghi.json";

var macs = { };

function getByType(package, type, primary) {

	return apint.queryUtilities(
		package,
		null,
		utility => Array.isArray(utility.properties?.tags) ?
			(primary ?
				utility.properties?.tags?.indexOf(type) == 0 :
				utility.properties?.tags?.indexOf(type) != -1
			) :
			utility.properties?.tags?.toLowerCase() == type.toLowerCase()
	);
}

function overlay(target, value, preserve) {

	Object.keys(value).forEach(key => {

		if(target[key] != null && preserve)
			return;

		if(typeof target[key] == "object" && !Array.isArray(target[key]))
			target[key] = overlay(target[key], value[key]);

		else
			target[key] = value[key];
	});

	return target;
}

module.exports = [
	telosUtils.createCommand("ghi-enable", (package) => {

		let args = telosUtils.getArguments(package);

		cronUtils.removeJob({ id: "ghi-enable" });

		cronUtils.createJob({
			id: "ghi-enable",
			command: `sudo env "PATH=$PATH" ${
				require("child_process").execFileSync(
					"which", ["npx"], { encoding: "utf8" }
				).trim()
			} telos-origin telos-server telos-ghi -e ghi -port ${
				args.options.port != null ? args.options.port : 3000
			} -pool '${args.options.pool}'`,
			trigger: { type: "startup" },
		});
	}),
	telosUtils.createCommand("ghi", (package) => {

		try {
			state = JSON.parse(fs.readFileSync(persistPath, "utf-8"));
		}

		catch(error) {

		}

		let args = telosUtils.getArguments(package);

		dynamicCast.cast(
			args.options.port != null ? args.options.port : 3000,
			args.options.pool,
			["ghi"]
		);

		telosUtils.initiateEngine();
	}),
	telosUtils.createTask(60, false, () => {

		deviceUtils.getDevices((data) => {

			state.utilities = state.utilities != null ?
				overlay(state.utilities, data, true) : data;
		});
	}),
	telosUtils.createTask(1 / 60, false, () => {

		getByType(state, "telos-module", true).map(
			item => item.content
		).filter(
			item => item != null ? !modules.includes(item) : false
		).forEach(item => {

			modules.push(item);

			try {

				let value = use(item);

				(Array.isArray(value) ? value : [value]).forEach(busModule => {
					busNet.connect(busNet.anchor, busModule, null, true)
				});
			}

			catch(error) {

			}
		});

		busNet.call(
			JSON.stringify({ content: state, tags: ["ghi", "process"] })
		).forEach(update => {

			try {

				if(update == null)
					return;

				state = overlay(
					state,
					typeof update == "string" ? JSON.parse(update) : update
				);
			}

			catch(error) {

			}
		});
	}),
	telosUtils.createTask(1, false, () => {

		try {

			fs.mkdirSync(path.dirname(persistPath), { recursive: true });

			fs.writeFileSync(
				persistPath,
				JSON.stringify(getByType(state, "ghi-persist").reduce(
					(value, item, index) => {

						value[`${index}`] = item;

						return value;
					},
					{ }
				))
			);
		}

		catch(error) {

		}
	}),
	{
		query: (packet) => {

			if(!serverUtils.isHTTPJSON(packet))
				return null;

			let prohibit = false;

			busNet.call(
				JSON.stringify({
					content: { request: packet, state: state },
					tags: ["ghi", "verify"]
				})
			).forEach(verification => {

				if(typeof verification == "boolean" && !verification)
					prohibit = true;
			});

			if(prohibit)
				return;

			if(packet.request.method == "GET")
				return { body: JSON.stringify(state), priority: 1 };

			if(packet.request.method == "POST") {

				try {
					state = overlay(state, JSON.parse(packet.body));
				}

				catch(error) {

					return new Promise((resolve, reject) => {

						try {

							autoCORS.send(packet.body, (response) => {
								
								resolve(
									Object.assign(response, { priority: 1 })
								);
							});
						}

						catch(error) {
							resolve({ body: `${error.stack}`, priority: 1 });
						}
					});
				}
			}
		}
	},
	{
		query: (packet) => {

			if(!telosUtils.validatePacket(packet, ["ghi", "verify"]))
				return;

			packet = typeof packet == "string" ? JSON.parse(packet) : packet;

			let tokens = getByType(
				packet.content.state, "ghi-token"
			).map(item => `Bearer ${item.content}`);

			return tokens.length == 0 ?
				true :
				tokens.includes(packet.content.request.headers?.Authorization);
		}
	},
	{
		query: (packet) => {

			if(!telosUtils.validatePacket(packet, ["ghi", "process"]))
				return;

			packet = typeof packet == "string" ? JSON.parse(packet) : packet;

			let result = { };

			getByType(
				packet.content, "ghi-script"
			).forEach(item => {

				if(![
					"javascript", "js"
				].includes(item.properties.language.toLowerCase())) {

					try {

						let value = (new Function(item.content))(
							JSON.stringify(state)
						);

						result = overlay(
							result, value != null ? JSON.parse(value) : { }
						);
					}

					catch(error) {

					}
				}
			});

			return result;
		}
	},
	{
		query: (packet) => {

			if(!telosUtils.validatePacket(packet, ["ghi", "process"]))
				return;

			packet = typeof packet == "string" ? JSON.parse(packet) : packet;

			getByType(
				packet.content, "ghi-channel"
			).filter(item => item.properties?.channel?.type == "gpio").forEach(
				item => {

					Object.keys(item.properties?.channel?.input).forEach(
						key => {

							gpioUtils.setPin(
								parseInt(key),
								item.properties?.channel?.input[key]
							);
						}
					);
				}
			);
		}
	},
	{
		query: (packet) => {

			if(!telosUtils.validatePacket(packet, ["ghi", "process"]))
				return;

			packet = typeof packet == "string" ? JSON.parse(packet) : packet;

			getByType(
				packet.content, "ghi-channel"
			).filter(
				item => item.properties?.channel?.type == "bluetooth"
			).forEach(
				item => {

					if(!Array.isArray(item.properties?.channel?.input))
						return;

					if(item.properties?.channel?.input.length == 0)
						return;

					if(macs[item.properties?.channel?.properties?.mac] ==
						JSON.stringify(item.properties?.channel?.input)) {

						return;
					}

					macs[item.properties?.channel?.properties?.mac] =
						JSON.stringify(item.properties?.channel?.input);

					bluetoothUtils.send(
						item.properties?.channel?.properties?.mac,
						item.properties?.channel?.input
					);

					item.properties.channel.input = [];
				}
			);

			return packet.content;
		}
	}
];