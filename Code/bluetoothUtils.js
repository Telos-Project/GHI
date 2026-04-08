var child_process = require("child_process");
var { SerialPort } = require('serialport');

var ports = { };

function getNext() {

	let addresses = new Set(Object.values(ports).map(port => port.address));
	let next = 0;
	
	for(; addresses.has(next); next++);

	return next;
}

function getPort(mac, options) {

	if(typeof ports[mac] == "object") {

		return new Promise((resolve, reject) => {
			resolve(ports[mac].port);
		});
	}

	return new Promise((resolve, reject) => {

		pair(mac, () => {

			ports[mac] = { port: null, address: getNext() };

			try {

				child_process.execSync(
					`sudo rfcomm release /dev/rfcomm${ports[mac].address}`
				);
			}

			catch(error) {
				
			}

			child_process.execSync(
				`sudo rfcomm bind /dev/rfcomm${ports[mac].address} ${mac} 1`
			);

			ports[mac].port = new SerialPort({
				path: `/dev/rfcomm${ports[mac].address}`,
				baudRate: options?.baud != null ? options?.baud : 115200
			});

			ports[mac].port.on('error', () => { ports[mac].port.close(); });
			ports[mac].port.on('close', () => { delete ports[mac]; });

			ports[mac].port.on('open', () => {
				resolve(ports[mac].port);
			});
		});
	});
}

function listen(mac, callback, options) {

	getPort(mac, options).then(port => {
		port.on('data', callback);
	});
}

function pair(mac, callback) {

    let bt = child_process.spawn("bluetoothctl");

    let output = "";
    let done = false;

    bt.stdout.on("data", (data) => {

        output += data.toString();

        if(!done &&
			/Paired: yes/.test(output) &&
			/Trusted: yes/.test(output)) {

            done = true;

            bt.stdin.end();
            bt.kill();

            callback(true);
        }
    });

    bt.stderr.on("data", (data) => {
        console.error("bluetoothctl stderr:", data.toString());
    });

    bt.on("close", (code) => {

        if(!done) {

            done = true;

            callback(false);
        }
    });

    bt.stdin.write(`info ${mac}\n`);

    setTimeout(() => {

        if(!done) {
            bt.stdin.write(`pair ${mac}\n`);
            bt.stdin.write(`trust ${mac}\n`);
            bt.stdin.write(`quit\n`);
        }
    }, 500);
}

function send(mac, data, options) {

	getPort(mac, options).then(port => {

		port.write(
			Array.isArray(data) ?
				Buffer.from(
					data.map(item => typeof item == "number" ?
						item :
						(`${item}`.trim().toLowerCase().startsWith("0x") ?
							parseInt(`${item}`) :
							Number(`${item}`)
						)
					)
				) :
				`${data}`
		);
	});
}

module.exports = {
	getNext,
	getPort,
	listen,
	pair,
	send
};