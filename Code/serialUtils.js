var { execSync } = require('child_process');
var { SerialPort } = require('serialport');

var ports = { };

function getPath(deviceNum, busNum = 1) {

    const ttys = execSync(
        "ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null || true", { shell: true }
    ).toString().trim().split("\n").filter(Boolean);

    for(const tty of ttys) {

        const syspath = execSync(
            `udevadm info -q path ${tty} 2>/dev/null`, { shell: true }
        ).toString().trim();

        const usbDevPath = syspath.replace(/\/[^/]+:[^/]+\/[^/]+\/[^/]+$/, "");

        const info = execSync(
            `udevadm info /sys${usbDevPath} 2>/dev/null`, { shell: true }
        ).toString();

        const devnum = info.match(/E: DEVNUM=(\d+)/)?.[1];
        const busnum = info.match(/E: BUSNUM=(\d+)/)?.[1];

        if(Number(devnum) === Number(deviceNum) &&
			Number(busnum) === Number(busNum)) {

            return tty;
		}
    }

    return null;
}

function getPort(id, options) {

	if(ports[JSON.stringify(id)]) {

		return new Promise((resolve, reject) => {
			resolve(ports[id]);
		});
	}

	return new Promise((resolve, reject) => {

		ports[JSON.stringify(id)] = new SerialPort({
			path: getPath(id.deviceAddress, id.bus),
			baudRate: options?.baud != null ? options?.baud : 9600
		});

		ports[JSON.stringify(id)].on('error', () => { ports[id].close(); });
		ports[JSON.stringify(id)].on('close', () => { delete ports[id]; });

		ports[JSON.stringify(id)].on('open', () => { resolve(ports[id]); });
	});
}

function listen(id, callback, options) {

	getPort(id, options).then(port => {
		port.on('data', callback);
	});
}

function send(id, data, options) {

	getPort(id, options).then(port => {

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
	getPath,
	listen,
	send
};