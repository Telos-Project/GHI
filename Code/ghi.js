var deviceUtils = require("./deviceUtils.js");
var dynamicCast = require("./dynamicCast.js");
var serverUtils = require("telos-server/serverUtils.js");
var telosUtils = require("telos-origin/telosUtils.js");

var state = { };

module.exports = [
	telosUtils.create((package) => {

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

			if(packet.request.method == "GET")
				return { body: JSON.stringify(state), priority: 1 };

			// STUB
		}
	}
];