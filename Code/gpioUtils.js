var rpio = require('rpio');

var pins = { };

process.on('SIGINT', () => {

	Object.keys(pins).forEach(pin => {
		rpio.write(pin, rpio.LOW);
		rpio.close(pin);
	});

	process.exit(0);
});

rpio.init({ mapping: 'gpio' });

module.exports = {
	setPin: (pin, value) => {
		
		if(pins[pin] == null)
			rpio.open(pin, rpio.OUTPUT, rpio.LOW);

		if(value == pins[pin])
			return;

		pins[pin] = value;

		rpio.write(
			pin,
			typeof value == "boolean" ? (value ? rpio.HIGH : rpio.LOW) : value
		);
	}
};