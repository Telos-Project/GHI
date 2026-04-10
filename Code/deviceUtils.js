var child_process = require("child_process");
var fs = require('fs');

var deviceUtils = {
	getDevices: (callback) => {

		Promise.all([
			deviceUtils.getDevicesBluetooth(),
			deviceUtils.getDevicesSerial(),
			deviceUtils.getDevicesWiFi()
		]).then(values => {

			callback(values.concat([
				deviceUtils.getDevicesGPIO(),
				deviceUtils.getDevicesSystem()
			]).reduce(
				(value, item) => {

					Object.assign(value, item);

					return value;
				},
				{ }
			));
		});
	},
	getDevicesBluetooth: () => {

		return new Promise((resolve) => {

			child_process.exec('hcitool scan', (error, stdout) => {

				resolve(error == null ?
					stdout.split('\n').slice(1).map(line => ({
						mac: line.trim().split('\t')[0],
						name: line.trim().split('\t')[1]
					})).filter(item => item.mac).reduce((value, item) => {

						value[`BLUETOOTH-${item.mac}`] = {
							"properties": {
								"tags": ["ghi", "ghi-channel"],
								"links": [{ "target": ["SYSTEM"] }],
								"channel": {
									"type": "bluetooth",
									"input": [],
									"output": [],
									"properties": item
								}
							}
						};

						return value;
					}, { }) :
					{ }
				);
			});
		});
	},
	getDevicesGPIO: () => {

		return (
			fs.existsSync('/sys/class/gpio') ||
				fs.readdirSync('/dev').some(f => f.startsWith('gpiochip'))
		) ? {
			"GPIO": {
				"properties": {
					"tags": ["ghi", "ghi-channel"],
					"links": [{ "target": ["SYSTEM"] }],
					"channel": {
						"type": "gpio",
						"input": { },
						"output": { }
					}
				}
			}
		} : { };
	},
	getDevicesSerial: () => {

		return new Promise((resolve) => {

			child_process.exec(
				"lsusb -v",
				{ maxBuffer: 1024 * 1024 * 10 },
				(error, stdout, stderr) => {

					resolve(error == null ?
						deviceUtils.parseLsusb(stdout) : { }
					);
				}
			);
		});
	},
	getDevicesSystem: () => {

		let model = null;

		try {

			model = fs.readFileSync(
				'/proc/cpuinfo', 'utf8'
			).split("\n").filter(
				line => line.trim().length > 0
			).map(line => line.split(":")).reduce(
				((value, item) => {

					value[item[0].trim()] = item[1].trim();

					return value;
				})
			)["Model"];
		}

		catch(error) {

		}

		return {
			"SYSTEM": {
				"properties": {
					"tags": ["ghi", "ghi-channel"],
					"channel": {
						"type": "system",
						"input": [],
						"output": [],
						"properties": {
							"id": fs.readFileSync(
								'/etc/machine-id', 'utf8'
							).trim(),
							"model": model
						}
					}
				}
			}
		};
	},
	getDevicesWiFi: () => {

		return new Promise((resolve) => {

			child_process.exec(
				'nmcli dev wifi rescan',
				{ encoding: 'utf8' },
				() => {

					child_process.exec(
						'nmcli --escape no -t -f SSID dev wifi list',
						(error, stdout) => {

							resolve(error == null ?
								[...new Set(
									stdout.split("\n").filter(
										line => line.trim().length > 0
									)
								)].sort().reduce((value, item) => {

									value[`WIFI-${item}`] = {
										"properties": {
											"tags": ["ghi", "ghi-channel"],
											"links": [
												{ "target": ["SYSTEM"] }
											],
											"channel": {
												"type": "wifi",
												"input": [],
												"output": [],
												"properties": {
													"SSID": item
												}
											}
										}
									};

									return value;
								}, { }) :
								{ }
							);
						}
					);
				}
			);
		});
	},
	parseLsusb: (output) => {

		let items = { };

		output.split(/\n(?=Bus \d{3} Device \d{3}:)/).forEach(block => {

			let device = {
				properties: {
					tags: ["ghi", "ghi-channel"],
					links: [{ target: ["SYSTEM"] }],
					channel: {
						type: "usb",
						input: [],
						output: [],
						properties: { }
					}
				}
			};

			let props = device.properties.channel.properties;

			let headerMatch = block.match(
				/Bus (\d{3}) Device (\d{3}): ID ([0-9a-f]{4}):([0-9a-f]{4})/i
			);

			if(headerMatch) {
				props.bus = parseInt(headerMatch[1], 10);
				props.deviceAddress = parseInt(headerMatch[2], 10);
				props.vendorId = headerMatch[3];
				props.productId = headerMatch[4];
			}

			props.vendor = deviceUtils.parseLsusbField(
				block, 'idVendor', true
			);

			props.product = deviceUtils.parseLsusbField(
				block, 'idProduct', true
			);

			props.serial = deviceUtils.parseLsusbField(block, 'iSerial');

			props.serial = props.serial?.includes(" ") ? null : props.serial;

			if(props.vendorId && props.productId) {

				items[`USB-${
					props.serial != null ? props.serial : props.deviceAddress
				}`] = device;
			}
		});

		return items;
	},
	parseLsusbField: (block, field, hex) => {
		
		let match = block.match(
			new RegExp(`^\\s*${field}\\s+(\\d+)\\s*(.*)$`, 'm')
		);

		if(!match)
			return null;

		return hex ?
			match[2].trim().split(" ").slice(1).join(" ") : match[2].trim();
	}
};

if(typeof module == "object")
	module.exports = deviceUtils;