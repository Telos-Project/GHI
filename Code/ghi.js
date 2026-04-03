var apint = require("apint");
var busNet = require("bus-net");
var deviceUtils = require("./deviceUtils.js");
var dynamicCast = require("./dynamicCast.js");
var fs = require("fs");
var path = require("path");
var serverUtils = require("telos-server/serverUtils.js");
var telosUtils = require("telos-origin/telosUtils.js");

var modules = [];
var state = { };

var persistPath = "~/.local/share/ghi/ghi.json";

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

function overlay(target, value) {
	
	Object.keys(value).forEach(key => {

		if(typeof target[key] == "object" && !Array.isArray(target[key]))
			target[key] = overlay(target[key], value[key]);

		else
			target[key] = value[key];
	});

	return target;
}

module.exports = [
	telosUtils.create((package) => {

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
	}),
	telosUtils.createTask(60, true, () => {

		deviceUtils.getDevices((data) => {
			state = data;
		});
	}),
	{
		query: (packet) => {
			
			if(!serverUtils.isHTTPJSON(packet))
				return null;

			let prohibit = false;

			busNet.call(
				{ request: JSON.stringify(state), tags: ["ghi", "verify"] }
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

				}
			}
		}
	},
	telosUtils.createTask(1 / 60, true, () => {

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
			{ state: JSON.stringify(state), tags: ["ghi", "process"] }
		).forEach(update => {

			try {

				state = overlay(
					state,
					typeof update == "string" ? JSON.parse(update) : update
				);
			}

			catch(error) {

			}
		});
	}),
	telosUtils.createTask(1, true, () => {

		fs.mkdirSync(path.dirname(persistPath), { recursive: true });

		fs.writeFileSync(
			persistPath,
			JSON.stringify(getByType(state, "ghi-persist").reduce(
				(value, item, index) => {

					value[`${index}`] = item;
					
					return item;
				},
				{ }
			))
		);
	})
];